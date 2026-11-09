/**
 * organize.js — 「AI 整理」的后台任务编排层
 *
 * 一条整理流水线 = 抓正文 → 补真封面 → 模型判类型/分类/标题/摘要 → 写回并判定 state。
 * 之所以拆成三段：抓取和模型都会各自失败，失败只回退那一段，不能一条慢就把整批拖垮。
 *
 * 对外：
 *   startOrganize(ctx, { mode:'pending'|'all', limit })  启动后台任务（同时只允许一个）
 *   organizeStatus()                                      给面板轮询的进度
 *   cancelOrganize()                                      请求停止（跑完当前批就停）
 *   organizeItems(ctx, items, opts)                       同步整理一批（同步/入库增量用）
 *   undoOrganize(id)                                      撤销上一次 AI 整理
 */
import { getItem, getItems, updateItem, setItemContent } from './store.js'
import { classifyItems } from './ai.js'
import { resolveContent } from './content.js'
import { backfillCovers } from './cover-backfill.js'
import { ORGANIZE_VERSION, evaluateState, isRealCover } from './organize-core.js'
import { withTopic } from './topics.js'

const BATCH_SIZE = 8
const CONTENT_CONCURRENCY = 3
const LINKISH_KINDS = new Set(['xhs', 'wechat', 'link', 'article', 'video', 'bilibili', 'douyin', 'product'])

const EMPTY_JOB = {
  running: false,
  mode: null,
  total: 0,
  processed: 0,
  done: 0,
  partial: 0,
  failed: 0,
  current: null,
  startedAt: null,
  finishedAt: null,
  lastError: null,
  cancelled: false,
}

let job = { ...EMPTY_JOB }
let cancelToken = null

export function organizeStatus() {
  return { ...job }
}

export function cancelOrganize() {
  if (!job.running) return { ok: false, error: '当前没有在跑的整理任务' }
  job.cancelled = true
  if (cancelToken) cancelToken.aborted = true
  return { ok: true }
}

function chunksOf(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

async function runPool(items, concurrency, worker) {
  let cursor = 0
  const runners = new Array(Math.max(1, Math.min(concurrency, items.length))).fill(0).map(async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      try {
        await worker(items[index], index)
      } catch {
        // 单条失败不影响同批其它条目
      }
    }
  })
  await Promise.all(runners)
}

function needsContent(item) {
  if (!item || !LINKISH_KINDS.has(item.kind)) return false
  if (item.kind === 'image') return false
  const content = item.content
  if (!content || typeof content !== 'object') return true
  if (!content.text && !content.error) return true
  const at = Date.parse(content.fetchedAt || '')
  return !Number.isFinite(at) || Date.now() - at > 7 * 86400e3
}

/** 第一段：抓正文（失败只是这一条没有正文，不影响后面的语义整理）。 */
async function prepareContent(item) {
  if (!needsContent(item)) return
  if (!item.url) return
  const content = await resolveContent(item, { force: false })
  if (content && typeof content === 'object') {
    try {
      setItemContent(item.id, content)
    } catch {
      // 条目可能在抓取期间被删掉
    }
  }
}

/** 第二段：只补真封面。占位 SVG 不算数，也不在这里生成新的占位图。 */
async function prepareCovers(ids) {
  if (ids.length === 0) return
  try {
    await backfillCovers({
      ids,
      force: true,
      allowGenerated: false,
      includeAll: true,
      delayMs: 0,
    })
  } catch {
    // 封面补不到就补不到，后面判定成 partial
  }
}

function markFailed(items, error) {
  const at = new Date().toISOString()
  for (const item of items) {
    if (!item) continue
    if (item.ai && item.ai.state === 'done') continue
    try {
      updateItem(item.id, {
        ai: {
          state: 'failed',
          version: ORGANIZE_VERSION,
          fields: [],
          lastError: String(error || '整理失败').slice(0, 300),
          at,
        },
      })
    } catch {
      // 条目消失，忽略
    }
  }
}

/**
 * 同步整理一批条目。返回 { processed, done, partial, failed, error }。
 * @param {object} ctx
 * @param {object[]} items
 * @param {{ signal?: {aborted?:boolean}, onProgress?: Function }} options
 */
export async function organizeItems(ctx, items, options = {}) {
  const signal = options.signal || null
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null
  const list = (Array.isArray(items) ? items : []).filter(Boolean)
  const summary = { processed: 0, done: 0, partial: 0, failed: 0, error: null }
  for (const batch of chunksOf(list, BATCH_SIZE)) {
    if ((signal && signal.aborted) || job.cancelled) break
    // 1) 正文
    await runPool(batch, CONTENT_CONCURRENCY, (item) => prepareContent(item))
    // 2) 真封面
    await prepareCovers(batch.map((item) => item.id))
    // 3) 语义整理（读最新快照，封面/正文都已经落盘）
    const fresh = batch.map((item) => getItem(item.id)).filter(Boolean)
    let result
    try {
      result = await classifyItems(ctx, fresh, { limit: fresh.length })
    } catch (error) {
      result = { updated: 0, error: String(error?.message || error), ids: [] }
    }
    const appliedIds = new Set(Array.isArray(result.ids) ? result.ids : [])
    if (result.error) {
      summary.error = result.error
      const missed = fresh.filter((item) => !appliedIds.has(item.id))
      markFailed(missed, result.error)
    }
    // 4) 统计真实状态
    for (const item of fresh) {
      const latest = getItem(item.id)
      if (!latest) continue
      const state = evaluateState({ ...latest, ai: latest.ai }).state
      summary.processed += 1
      if (state === 'done') summary.done += 1
      else if (state === 'partial') summary.partial += 1
      else summary.failed += 1
      if (onProgress) onProgress(summary)
    }
  }
  return summary
}

function selectItems(mode, limit, states) {
  const all = getItems().filter(Boolean)
  const ordered = all.slice().sort((a, b) => {
    const rank = (item) => {
      if (item.status === 'inbox' || item.status === 'queued' || item.status === 'doing') return 0
      if (item.status === 'done') return 1
      return 2
    }
    const diff = rank(a) - rank(b)
    if (diff !== 0) return diff
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
  })
  // states 优先：只补特定状态（比如只补还没整理过的），避免重复花钱
  const wanted = Array.isArray(states) && states.length > 0 ? new Set(states) : null
  let pool
  if (wanted) pool = ordered.filter((item) => wanted.has((item.ai && item.ai.state) || 'none'))
  else if (mode === 'all') pool = ordered
  else pool = ordered.filter((item) => !item.ai || item.ai.state !== 'done')
  return Number(limit) > 0 ? pool.slice(0, Math.floor(Number(limit))) : pool
}

/**
 * 启动后台整理任务。返回 { ok, job }；已经在跑就返回 ok:false + 当前进度。
 */
export function startOrganize(ctx, options = {}) {
  const mode = options.mode === 'all' ? 'all' : 'pending'
  if (job.running) return { ok: false, error: '已经有一个整理任务在跑', job: organizeStatus() }
  const target = selectItems(mode, options.limit, options.states)
  if (target.length === 0) {
    return { ok: false, error: mode === 'all' ? '没有可整理的条目' : '没有待整理的条目了', job: organizeStatus() }
  }
  cancelToken = { aborted: false }
  job = {
    ...EMPTY_JOB,
    running: true,
    mode,
    total: target.length,
    startedAt: new Date().toISOString(),
    current: null,
  }
  // 后台跑，不阻塞 HTTP。
  void (async () => {
    try {
      for (const batch of chunksOf(target, BATCH_SIZE)) {
        if (cancelToken.aborted) break
        const ids = batch.map((item) => item.id)
        job.current = batch.length === 1 ? getItem(ids[0])?.title || null : `${batch.length} 条`
        const summary = await organizeItems(ctx, batch.map((item) => getItem(item.id)).filter(Boolean), {
          signal: cancelToken,
        })
        const applied = summary.processed
        job.processed += applied
        job.done += summary.done
        job.partial += summary.partial
        job.failed += summary.failed
        if (summary.error) job.lastError = summary.error
      }
    } catch (error) {
      job.lastError = String(error?.message || error)
    } finally {
      job.running = false
      job.current = null
      job.finishedAt = new Date().toISOString()
      cancelToken = null
    }
  })()
  return { ok: true, job: organizeStatus() }
}

/** 撤销一条的上一次 AI 整理：把标题/类型/分类还原，状态打回 none。 */
export function undoOrganize(id) {
  const item = getItem(id)
  if (!item) throw new Error('条目不存在')
  const prev = item.ai && item.ai.prev && typeof item.ai.prev === 'object' ? item.ai.prev : null
  if (!prev) throw new Error('这条没有可撤销的整理记录')
  const patch = {
    ai: {
      state: 'none',
      version: null,
      fields: [],
      reason: '已撤销 AI 整理',
      at: new Date().toISOString(),
      prev: null,
      suggest: null,
      lastError: null,
    },
  }
  if (prev.title) {
    patch.title = prev.title
    patch.titleRaw = ''
  }
  if (prev.kind) patch.kind = prev.kind
  if (prev.topic) patch.tags = withTopic(item.tags, prev.topic)
  return updateItem(id, patch)
}

/** 撤掉的封面判断复用一个口径，方便其它模块（面板/工具）判断“有没有真封面”。 */
export { isRealCover }
