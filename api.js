/**
 * HTTP carrier for the watch-later center.
 *
 * Every endpoint is registered as its own exact route on the Web carrier and
 * only answers loopback / private-network peers, matching how the other local
 * panels in this profile expose data. Responses are JSON except /media/*.
 */
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import {
  buildSnapshot,
  addItem,
  updateItem,
  deleteItem,
  getItem,
  getItems,
  markInvalid,
  clearInvalid,
  findByUrl,
  getSettings,
  setSettings,
  saveMediaDataUrl,
  resolveMediaPath,
  setCookie,
  getCookie,
  getSyncState,
  setSyncState,
  exportAll,
  stats,
  setItemContent,
  setClusterSummary,
  setLibraryPush,
  MEDIA_DIR,
  DATA_DIR,
  INBOX_DIR,
  MAX_IMAGES,
} from './store.js'
import { deriveItem } from './score.js'
import { agentInfo } from './agent.js'
import { mediaInfo } from './media.js'
import { readWorks, syncWorks, updateWork, deleteWork, addWork } from './works.js'
import { extractImportCandidates } from './import-text.js'
import { resolvePreview } from './enrich.js'
import { aiInfo, summarizeCluster, extractWorks, enrichAgentItems } from './ai.js'
import { cancelOrganize, organizeItems, organizeStatus, startOrganize, undoOrganize } from './organize.js'
import { resolveContent } from './content.js'
import { pushImageToLibrary } from './library-push.js'
import { ingestArchiveZip } from './zip-ingest.js'
import { backfillCovers, isPlaceholderCover, isGeneratedCover } from './cover-backfill.js'
import { buildClusters } from './cluster.js'
import { runSync } from './sync-run.js'
import { fetchAccount as fetchBiliAccount } from './sync/bili.js'
import { parseShareText, resolveShareUrl } from './sync/douyin.js'

const PREFIX = '/api/dsh-watch-later'
const MEDIA_PATH = PREFIX + '/media'
const MAX_BODY = 16 * 1024 * 1024

const ROUTES = {
  snapshot: PREFIX + '/snapshot',
  health: PREFIX + '/health',
  add: PREFIX + '/add',
  importText: PREFIX + '/import',
  update: PREFIX + '/update',
  action: PREFIX + '/action',
  remove: PREFIX + '/delete',
  invalid: PREFIX + '/invalid',
  review: PREFIX + '/ai/review',
  organize: PREFIX + '/ai/organize',
  organizeStatus: PREFIX + '/ai/status',
  organizeCancel: PREFIX + '/ai/cancel',
  undo: PREFIX + '/ai/undo',
  sync: PREFIX + '/sync',
  settings: PREFIX + '/settings',
  resolve: PREFIX + '/resolve',
  douyinParse: PREFIX + '/douyin/parse',
  export: PREFIX + '/export',
  media: PREFIX + '/media',
  loginBiliStart: PREFIX + '/login/bilibili/start',
  loginBiliQr: PREFIX + '/login/bilibili/qr',
  loginBiliPoll: PREFIX + '/login/bilibili/poll',
  loginChromeStart: PREFIX + '/login/chrome/start',
  loginChromePoll: PREFIX + '/login/chrome/poll',
  loginChromeCancel: PREFIX + '/login/chrome/cancel',
  loginChromeConfirm: PREFIX + '/login/chrome/confirm',
  logout: PREFIX + '/login/logout',
  enrichCovers: PREFIX + '/enrich/covers',
  worksSync: PREFIX + '/works/sync',
  worksUpdate: PREFIX + '/works/update',
  worksDelete: PREFIX + '/works/delete',
  worksExtract: PREFIX + '/works/extract',
  worksAdd: PREFIX + '/works/add',
  worksExtractText: PREFIX + '/works/extract-text',
  agentEnrich: PREFIX + '/agent/enrich',
  content: PREFIX + '/content',
  clusterReview: PREFIX + '/cluster/review',
  libraryPush: PREFIX + '/library/push',
  ingestZip: PREFIX + '/ingest/zip',
}

/* ------------------------------------------------------------- utilities */

function isPrivateAddress(address) {
  if (!address) return false
  if (address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1') return true
  if (address.startsWith('192.168.')) return true
  if (address.startsWith('10.')) return true
  if (address.startsWith('fe80:')) return true
  if (address.startsWith('::ffff:192.168.') || address.startsWith('::ffff:10.')) return true
  return /^172\.(1[6-9]|2\d|3[01])\./.test(address) || /^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(address)
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function errorMessage(error) {
  return String(error?.message || error || '请求失败')
}

function readRequestBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function guarded(handler) {
  return async (req, res) => {
    if (!isPrivateAddress(req.socket?.remoteAddress)) {
      sendJson(res, 403, { ok: false, error: 'forbidden' })
      return
    }
    try {
      await handler(req, res)
    } catch (error) {
      sendJson(res, 400, { ok: false, error: errorMessage(error) })
    }
  }
}

function requireMethod(req, res, methods) {
  if (methods.includes(req.method)) return true
  res.setHeader('allow', methods.join(', '))
  sendJson(res, 405, { ok: false, error: 'method not allowed' })
  return false
}

function viewOf(item) {
  const view = deriveItem(item, Date.now())
  delete view.content
  view.agent = agentInfo(item)
  view.media = mediaInfo(item)
  return view
}

function buildPublicSnapshot(ctx) {
  const info = aiInfo(ctx)
  return buildSnapshot({ aiAvailable: info.available, aiModel: info.model })
}

/* -------------------------------------------------------------- handlers */

async function handleSnapshot(_req, res, ctx) {
  const snapshot = buildPublicSnapshot(ctx)
  sendJson(res, 200, { ...snapshot, works: readWorks() })
}

async function handleHealth(_req, res, ctx) {
  const info = aiInfo(ctx)
  sendJson(res, 200, { ok: true, ...stats(), ai: info, paths: { data: DATA_DIR, media: MEDIA_DIR, inbox: INBOX_DIR } })
}

async function handleAdd(req, res, ctx) {
  if (!requireMethod(req, res, ['POST'])) return
  const body = await readRequestBody(req)
  const input = { ...(body && typeof body === 'object' ? body : {}) }
  if (typeof input.dataUrl === 'string' && input.dataUrl.trim()) {
    const media = saveMediaDataUrl(input.dataUrl, input.imageName)
    input.cover = media.url
    if (!input.kind) input.kind = 'image'
    if (!input.title) input.title = String(input.imageName || '').replace(/\.[a-z0-9]+$/i, '') || '图片'
  }
  delete input.dataUrl
  delete input.imageName
  if (!input.title && !input.url && !input.text) throw new Error('至少给一个标题、链接或文本')
  if (input.url) {
    const existing = findByUrl(input.url)
    if (existing) {
      sendJson(res, 200, { ok: true, item: viewOf(existing), duplicate: true })
      return
    }
  }
  if (input.url && (!input.title || !input.summary || !input.cover)) {
    try {
      const preview = await resolvePreview(input.url)
      input.title = input.title || preview.title
      input.summary = input.summary || preview.summary
      input.author = input.author || preview.author
      input.cover = input.cover || preview.cover
      input.site = input.site || preview.site
      input.durationMin = input.durationMin || preview.durationMin
      if (!input.kind && preview.kind) input.kind = preview.kind
    } catch {
      // preview is optional
    }
  }
  const result = addItem(input, { dedupe: true })
  sendJson(res, 200, { ok: true, item: viewOf(result.item), duplicate: Boolean(result.duplicate) })
}

async function enrichImportCandidates(candidates) {
  const targets = candidates.filter((candidate) => candidate.url && candidate.kind !== 'douyin').slice(0, 6)
  if (targets.length === 0) return
  const previews = await Promise.allSettled(targets.map((candidate) => resolvePreview(candidate.url)))
  previews.forEach((outcome, index) => {
    if (outcome.status !== 'fulfilled') return
    const preview = outcome.value || {}
    const candidate = targets[index]
    if (preview.title) candidate.title = preview.title
    if (preview.cover) candidate.cover = preview.cover
    if (preview.author) candidate.author = preview.author
    if (preview.summary) candidate.summary = preview.summary
    if (preview.site) candidate.site = preview.site
    if (preview.durationMin) candidate.durationMin = preview.durationMin
    if (preview.kind && (!candidate.kind || candidate.kind === 'other')) candidate.kind = preview.kind
  })
}

async function handleImport(req, res) {
  if (!requireMethod(req, res, ['POST'])) return
  const body = await readRequestBody(req)
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text) throw new Error('粘点内容进来')
  const candidates = extractImportCandidates(text)
  await enrichImportCandidates(candidates)
  const items = []
  let skipped = 0
  let resolvedDouyin = 0
  for (const candidate of candidates.slice(0, 50)) {
    try {
      let input = { ...candidate }
      // 纯文本没有 URL 时交给 heuristicExtract 再判一次（剧名/文章会因此落到 drama/article）
      if (!input.url && input.kind === 'other') delete input.kind
      if (input.kind === 'douyin' && input.url && resolvedDouyin < 3) {
        resolvedDouyin += 1
        try {
          const resolved = await resolveShareUrl({ url: input.url })
          if (resolved?.item) {
            const durationSec = Number(resolved.item.durationSec)
            const metaTitle =
              resolved.ok && resolved.item.title && !/^抖音视频 /.test(resolved.item.title)
                ? resolved.item.title
                : input.title
            input = {
              ...input,
              url: resolved.item.url || input.url,
              title: metaTitle || input.title,
              cover: resolved.item.cover || input.cover,
              author: resolved.item.author || input.author,
              durationMin:
                Number.isFinite(durationSec) && durationSec > 0
                  ? Math.max(1, Math.ceil(durationSec / 60))
                  : input.durationMin,
            }
          }
        } catch {
          // keep the share-title only
        }
      }
      const result = addItem({ ...input, channel: 'paste' }, { dedupe: true })
      if (result.duplicate) skipped += 1
      else items.push(viewOf(result.item))
    } catch {
      skipped += 1
    }
  }
  sendJson(res, 200, { ok: true, items, skipped })
}

async function handleUpdate(req, res) {
  if (!requireMethod(req, res, ['POST'])) return
  const body = await readRequestBody(req)
  const id = typeof body.id === 'string' ? body.id : ''
  if (!id) throw new Error('缺少 id')
  if (!body.patch || typeof body.patch !== 'object') throw new Error('缺少 patch')
  const item = updateItem(id, body.patch)
  sendJson(res, 200, { ok: true, item: viewOf(item) })
}

async function handleAction(req, res) {
  if (!requireMethod(req, res, ['POST'])) return
  const body = await readRequestBody(req)
  const id = typeof body.id === 'string' ? body.id : ''
  if (!id) throw new Error('缺少 id')
  const action = String(body.action || '')
  const patch = {}
  if (action === 'done') patch.status = 'done'
  else if (action === 'archive') patch.status = 'archived'
  else if (action === 'restore') patch.status = 'inbox'
  else if (action === 'start') patch.status = 'doing'
  else if (action === 'snooze') {
    const until = typeof body.until === 'string' && Number.isFinite(Date.parse(body.until)) ? new Date(Date.parse(body.until)).toISOString() : new Date(Date.now() + 86400e3).toISOString()
    patch.snoozedUntil = until
  } else throw new Error('未知操作：' + action)
  const item = updateItem(id, patch)
  sendJson(res, 200, { ok: true, item: viewOf(item) })
}

async function handleDelete(req, res) {
  if (!requireMethod(req, res, ['POST'])) return
  const body = await readRequestBody(req)
  // 批量删除：{ ids: [...] }（失效 tab 的「删除选中 / 清空全部」都走这里）
  if (Array.isArray(body.ids) && body.ids.length > 0) {
    const ids = body.ids.map((id) => String(id || '')).filter(Boolean).slice(0, 2000)
    let deleted = 0
    const failed = []
    for (const id of ids) {
      try {
        deleteItem(id)
        deleted += 1
      } catch {
        failed.push(id)
      }
    }
    sendJson(res, 200, { ok: true, deleted, failed: failed.length, ids: ids.slice(0, deleted) })
    return
  }
  const id = typeof body.id === 'string' ? body.id : ''
  if (!id) throw new Error('缺少 id')
  deleteItem(id)
  sendJson(res, 200, { ok: true, deleted: true, id })
}

/** 失效条目：标记 / 取消标记（删除走 /delete 的批量分支）。 */
async function handleInvalid(req, res) {
  if (!requireMethod(req, res, ['POST'])) return
  const body = await readRequestBody(req)
  const action = body.action === 'clear' ? 'clear' : 'mark'
  const ids = Array.isArray(body.ids) && body.ids.length > 0
    ? body.ids.map((id) => String(id || '')).filter(Boolean)
    : typeof body.id === 'string' && body.id ? [body.id] : []
  if (ids.length === 0) throw new Error('缺少 id 或 ids')
  let changed = 0
  for (const id of ids) {
    try {
      if (action === 'clear') clearInvalid(id)
      else markInvalid(id, body.reason || '手动标记失效')
      changed += 1
    } catch {
      // 条目不存在就跳过
    }
  }
  sendJson(res, 200, { ok: true, action, changed })
}

async function handleReview(req, res, ctx) {
  if (!requireMethod(req, res, ['POST'])) return
  const body = await readRequestBody(req)
  const limit = Math.max(1, Math.min(12, Number(body.limit) || 8))
  let candidates
  if (Array.isArray(body.ids) && body.ids.length > 0) {
    candidates = body.ids.map((id) => getItem(String(id))).filter(Boolean)
  } else {
    candidates = getItems()
      .filter((item) => !item.ai || item.ai.state !== 'done')
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit)
  }
  const summary = await organizeItems(ctx, candidates)
  const remaining = getItems().filter((item) => !item.ai || item.ai.state !== 'done').length
  sendJson(res, 200, {
    ok: true,
    updated: summary.processed,
    done: summary.done,
    partial: summary.partial,
    failed: summary.failed,
    remaining,
    error: summary.error || null,
  })
}

/** 启动「AI 整理」全量后台任务（主人口径：队列整理所有未整理内容，不限今日）。 */
async function handleOrganize(req, res, ctx) {
  if (!requireMethod(req, res, ['POST'])) return
  const body = await readRequestBody(req)
  const mode = body.mode === 'pending' ? 'pending' : 'all'
  const limit = Number(body.limit) > 0 ? Math.floor(Number(body.limit)) : 0
  const states = Array.isArray(body.states)
    ? body.states.map((state) => String(state)).filter((state) => ['none', 'partial', 'failed', 'done'].includes(state))
    : null
  const result = startOrganize(ctx, { mode, limit, states })
  const remaining = getItems().filter((item) => !item.ai || item.ai.state !== 'done').length
  sendJson(res, 200, {
    ok: result.ok,
    job: result.job,
    total: result.job.total,
    remaining,
    error: result.error || null,
  })
}

function handleOrganizeStatus(req, res) {
  if (!requireMethod(req, res, ['GET'])) return
  const remaining = getItems().filter((item) => !item.ai || item.ai.state !== 'done').length
  sendJson(res, 200, { ok: true, job: organizeStatus(), remaining })
}

async function handleOrganizeCancel(req, res) {
  if (!requireMethod(req, res, ['POST'])) return
  const result = cancelOrganize()
  sendJson(res, 200, { ...result, job: organizeStatus() })
}

/** 撤销一条的 AI 整理（标题/类型/分类还原，状态打回未整理）。 */
async function handleUndo(req, res) {
  if (!requireMethod(req, res, ['POST'])) return
  const body = await readRequestBody(req)
  const id = typeof body.id === 'string' ? body.id : ''
  if (!id) throw new Error('缺少 id')
  const item = undoOrganize(id)
  sendJson(res, 200, { ok: true, item: viewOf(item) })
}

async function handleSync(req, res, ctx) {
  if (!requireMethod(req, res, ['POST'])) return
  const body = await readRequestBody(req)
  const provider = body.provider === 'douyin' ? 'douyin' : body.provider === 'bilibili' ? 'bilibili' : null
  if (!provider) throw new Error('provider 只能是 bilibili 或 douyin')
  const result = await runSync(provider)
  sendJson(res, 200, {
    ok: Boolean(result.ok),
    provider,
    imported: result.imported || 0,
    updated: result.updated || 0,
    skipped: result.skipped || 0,
    total: result.total || 0,
    supported: result.supported,
    error: result.error || null,
    aiQueued: 0,
  })
  if (result.ok && Array.isArray(result.importedIds) && result.importedIds.length > 0 && getSettings().autoAiOnSync) {
    const imported = result.importedIds.map((id) => getItem(id)).filter(Boolean)
    // Fire and forget: the panel polls the snapshot, so AI tags appear on the next refresh.
    void organizeItems(ctx, imported.slice(0, 8))
      .then((ai) => {
        if (ai.error) ctx.logger?.warn?.(`[dsh-watch-later] AI review after sync: ${ai.error}`)
      })
      .catch(() => {})
  }
}

async function handleSettings(req, res, ctx) {
  if (!requireMethod(req, res, ['POST'])) return
  const body = await readRequestBody(req)
  if (body.patch && typeof body.patch === 'object') setSettings(body.patch)
  if (body.cookie && typeof body.cookie === 'object') {
    const provider = body.cookie.provider === 'douyin' ? 'douyin' : body.cookie.provider === 'bilibili' ? 'bilibili' : null
    if (!provider) throw new Error('未知的同步来源')
    const value = typeof body.cookie.cookie === 'string' ? body.cookie.cookie : ''
    setCookie(provider, value)
    if (!value.trim()) {
      setSyncState(provider, { account: null, lastError: null })
    } else if (provider === 'bilibili') {
      try {
        const account = await fetchBiliAccount({ cookie: getCookie('bilibili') })
        if (account?.ok && account.name) setSyncState('bilibili', { account: account.name, lastError: null })
        else setSyncState('bilibili', { account: null, lastError: account?.error || 'cookie 校验失败' })
      } catch (error) {
        setSyncState('bilibili', { account: null, lastError: errorMessage(error) })
      }
    } else {
      setSyncState('douyin', { lastError: null, supported: true })
    }
  }
  const snapshot = buildPublicSnapshot(ctx)
  sendJson(res, 200, { ok: true, settings: snapshot.settings, sync: snapshot.sync })
}

async function handleResolve(req, res) {
  if (!requireMethod(req, res, ['POST'])) return
  const body = await readRequestBody(req)
  const url = typeof body.url === 'string' ? body.url.trim() : ''
  if (!/^https?:\/\//i.test(url)) throw new Error('不是有效的链接')
  const preview = await resolvePreview(url)
  sendJson(res, 200, { ok: true, preview })
}

async function handleDouyinParse(req, res) {
  if (!requireMethod(req, res, ['POST'])) return
  const body = await readRequestBody(req)
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text) throw new Error('粘贴抖音分享文案或链接')
  const share = parseShareText(text)
  if (!share) throw new Error('没找到抖音分享链接')
  const resolved = await resolveShareUrl({ url: share.url })
  if (!resolved?.item) throw new Error(resolved?.error || '抖音链接解析失败，先只存链接')
  const item = resolved.item
  const metaTitle = resolved.ok && item.title && !/^抖音视频 /.test(item.title) ? item.title : null
  const result = addItem(
    {
      title: metaTitle || share.title || item.title || '抖音视频',
      url: item.url || share.url,
      cover: item.cover || null,
      author: item.author || null,
      site: '抖音',
      kind: 'douyin',
      durationMin: Number.isFinite(Number(item.durationSec)) ? Math.max(1, Math.ceil(Number(item.durationSec) / 60)) : null,
      channel: 'douyin',
      raw: text,
    },
    { dedupe: true },
  )
  sendJson(res, 200, {
    ok: true,
    item: viewOf(result.item),
    duplicate: Boolean(result.duplicate),
    degraded: !resolved.ok,
    warning: resolved.ok ? null : resolved.error || null,
  })
}

async function handleExport(req, res) {
  if (!requireMethod(req, res, ['GET', 'HEAD'])) return
  const body = JSON.stringify(exportAll(), null, 2)
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'content-disposition': 'attachment; filename="watch-later-export.json"',
    'cache-control': 'no-store',
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

function handleMedia(req, res) {
  if (!isPrivateAddress(req.socket?.remoteAddress)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' })
    return
  }
  if (!requireMethod(req, res, ['GET', 'HEAD'])) return
  const url = new URL(req.url || '/', 'http://localhost')
  const filename = decodeURIComponent(url.searchParams.get('f') || '')
  const resolved = resolveMediaPath(filename)
  if (!resolved) {
    sendJson(res, 404, { ok: false, error: 'not found' })
    return
  }
  const etag = '"' + resolved.size + '-' + filename + '"'
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag })
    res.end()
    return
  }
  const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' }
  const bytes = readFileSync(resolved.path)
  // 扩展名可能是「.jpg 里装 WebP」这种历史遗留（图床按 accept 回 webp），按真实字节定 content-type
  const sniffed = sniffImageType(bytes)
  res.writeHead(200, {
    'content-type': sniffed || types[resolved.ext] || 'application/octet-stream',
    'content-length': bytes.length,
    'cache-control': 'private, max-age=86400',
    etag,
  })
  res.end(req.method === 'HEAD' ? undefined : bytes)
}

/** 从文件头嗅探图片 MIME；认不出来返回 null，交给扩展名兜底。 */
function sniffImageType(bytes) {
  if (!bytes || bytes.length < 12) return null
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  if (bytes.slice(0, 4).toString('latin1') === 'RIFF' && bytes.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}


/* ------------------------------------------------------------ 插件内登录 */

const loginQrCache = new Map()
const QR_TTL_MS = 5 * 60 * 1000

function qrPngFor(qrUrl) {
  const candidates = [
    process.env.QRENCODE_PATH,
    '/opt/homebrew/bin/qrencode',
    '/usr/local/bin/qrencode',
    'qrencode',
  ].filter(Boolean)
  for (const binary of candidates) {
    try {
      const result = spawnSync(binary, ['-t', 'PNG', '-s', '8', '-m', '1', '-o', '-', String(qrUrl)], {
        timeout: 8000,
        maxBuffer: 4 * 1024 * 1024,
      })
      if (result.status === 0 && result.stdout && result.stdout.length > 0) return result.stdout
    } catch {
      // try next candidate
    }
  }
  return null
}

function cachedQrPng(qrKey, qrUrl) {
  const now = Date.now()
  for (const [key, value] of loginQrCache) {
    if (now - value.at > QR_TTL_MS) loginQrCache.delete(key)
  }
  const entry = loginQrCache.get(qrKey) || { qrUrl, at: now }
  if (!entry.png) entry.png = qrPngFor(entry.qrUrl || qrUrl)
  entry.at = now
  loginQrCache.set(qrKey, entry)
  return entry.png
}

async function handleBiliLoginStart(req, res) {
  if (!requireMethod(req, res, ['POST'])) return
  const mod = await import('./login/bili-qr.js')
  const result = await mod.generateQr({})
  if (!result || !result.ok) throw new Error(result?.error || 'B站二维码生成失败')
  const qrKey = String(result.qrKey || '')
  if (!qrKey) throw new Error('B站二维码缺少 key')
  loginQrCache.set(qrKey, { qrUrl: result.qrUrl, at: Date.now() })
  sendJson(res, 200, {
    ok: true,
    qrKey,
    qrImage: PREFIX + '/login/bilibili/qr?key=' + encodeURIComponent(qrKey),
    expiresIn: Number(result.expiresInSec) || 180,
  })
}

async function handleBiliLoginQr(req, res) {
  if (!requireMethod(req, res, ['GET', 'HEAD'])) return
  const url = new URL(req.url || '/', 'http://localhost')
  const key = String(url.searchParams.get('key') || '')
  const cached = loginQrCache.get(key)
  if (!cached) {
    sendJson(res, 404, { ok: false, error: '二维码不存在或已过期，请刷新' })
    return
  }
  const png = cachedQrPng(key, cached.qrUrl)
  if (!png) {
    sendJson(res, 500, { ok: false, error: '二维码图片生成失败（本机缺少 qrencode）' })
    return
  }
  res.writeHead(200, {
    'content-type': 'image/png',
    'content-length': png.length,
    'cache-control': 'no-store',
  })
  res.end(req.method === 'HEAD' ? undefined : png)
}

async function handleBiliLoginPoll(req, res, ctx) {
  if (!requireMethod(req, res, ['POST'])) return
  const body = await readRequestBody(req)
  const qrKey = typeof body.qrKey === 'string' ? body.qrKey : ''
  if (!qrKey) throw new Error('缺少 qrKey')
  const mod = await import('./login/bili-qr.js')
  const result = await mod.pollQr({ qrKey })
  const state = result && result.ok ? result.state : 'error'
  if (state === 'confirmed' && typeof result.cookie === 'string' && result.cookie) {
    setCookie('bilibili', result.cookie)
    setSyncState('bilibili', {
      account: result.account?.name || null,
      lastError: null,
      lastSyncAt: getSyncState().bilibili.lastSyncAt || null,
    })
    loginQrCache.delete(qrKey)
  }
  if (state === 'expired' || state === 'error') loginQrCache.delete(qrKey)
  const snapshot = buildPublicSnapshot(ctx)
  sendJson(res, 200, {
    ok: state !== 'error' || Boolean(result?.ok),
    state,
    account: result?.account || null,
    error: result?.error || null,
    sync: snapshot.sync,
  })
}

async function handleChromeLoginStart(req, res) {
  if (!requireMethod(req, res, ['POST'])) return
  const body = await readRequestBody(req)
  const provider = body.provider === 'douyin' ? 'douyin' : body.provider === 'bilibili' ? 'bilibili' : body.provider === 'xiaohongshu' ? 'xiaohongshu' : null
  if (!provider) throw new Error('provider 只能是 douyin / bilibili / xiaohongshu')
  const mod = await import('./login/chrome-login.js')
  const result = await mod.startLoginWindow({ provider })
  sendJson(res, 200, { ok: Boolean(result?.ok), state: result?.ok ? 'window-open' : 'error', port: result?.port || null, error: result?.error || null })
}

async function handleChromeLoginPoll(req, res, ctx) {
  if (!requireMethod(req, res, ['POST'])) return
  const body = await readRequestBody(req)
  const provider = body.provider === 'douyin' ? 'douyin' : body.provider === 'bilibili' ? 'bilibili' : body.provider === 'xiaohongshu' ? 'xiaohongshu' : null
  if (!provider) throw new Error('provider 只能是 douyin / bilibili / xiaohongshu')
  const mod = await import('./login/chrome-login.js')
  const result = await mod.pollLogin({ provider })
  let state = result && result.ok ? result.state : 'error'
  // 小红书未登录访客也会被写设备 cookie；只认真正登录后才有的 web_session。
  if (state === 'confirmed' && provider === 'xiaohongshu' && !/(customerClientId|id_token)=/.test(String(result?.cookie || ''))) {
    state = 'waiting'
  }
  if (state === 'confirmed' && typeof result.cookie === 'string' && result.cookie) {
    setCookie(provider, result.cookie)
    setSyncState(provider, {
      lastError: null,
      supported: true,
      ...(result.account?.name ? { account: result.account.name } : {}),
    })
  }
  const snapshot = buildPublicSnapshot(ctx)
  sendJson(res, 200, {
    ok: Boolean(result?.ok),
    state,
    account: result?.account || null,
    error: result?.error || null,
    sync: snapshot.sync,
  })
}

async function handleChromeLoginCancel(req, res) {
  if (!requireMethod(req, res, ['POST'])) return
  const body = await readRequestBody(req)
  const provider = body.provider === 'douyin' ? 'douyin' : body.provider === 'bilibili' ? 'bilibili' : body.provider === 'xiaohongshu' ? 'xiaohongshu' : null
  if (!provider) throw new Error('provider 只能是 douyin / bilibili / xiaohongshu')
  const mod = await import('./login/chrome-login.js')
  const result = await mod.cancelLogin({ provider })
  sendJson(res, 200, { ok: Boolean(result?.ok ?? true), state: 'closed' })
}


/* --------------------------------------------------- 内容直读 / 相似归纳 */

async function handleContent(req, res) {
  if (!requireMethod(req, res, ['GET', 'HEAD'])) return
  const url = new URL(req.url || '/', 'http://localhost')
  const id = String(url.searchParams.get('id') || '')
  if (!id) throw new Error('缺少 id')
  const item = getItem(id)
  if (!item) throw new Error('条目不存在')
  const content = await resolveContent(item, { force: url.searchParams.get('refresh') === '1' })
  let updated = setItemContent(id, content) || item
  const contentImages = Array.isArray(content && content.images) ? content.images.filter(Boolean).slice(0, MAX_IMAGES) : []
  if (contentImages.length > 0) {
    const patch = {}
    // 生成的标题卡 SVG / 平台 logo 都不算封面，拿到真图就换掉
    if (!updated.cover || isGeneratedCover(updated.cover) || isPlaceholderCover(updated.cover)) patch.cover = contentImages[0]
    if (!Array.isArray(updated.images) || updated.images.length === 0) patch.images = contentImages
    if (Object.keys(patch).length > 0) {
      try {
        updated = updateItem(id, patch) || updated
      } catch {
        // 补封面失败不影响内容返回
      }
    }
  }
  const view = viewOf(updated)
  delete view.content
  sendJson(res, 200, { ok: true, item: view, content })
}

async function handleClusterReview(req, res, ctx) {
  if (!requireMethod(req, res, ['POST'])) return
  const body = await readRequestBody(req)
  const id = typeof body.id === 'string' ? body.id : ''
  if (!id) throw new Error('缺少 id')
  const views = getItems().map((item) => viewOf(item))
  const clusters = buildClusters(views)
  const group = (clusters.groups || []).find((entry) => entry.memberIds.includes(id))
  if (!group) throw new Error('这条内容没有相似内容可归纳')
  const members = group.memberIds.map((memberId) => getItem(memberId)).filter(Boolean)
  const ai = await summarizeCluster(ctx, members)
  if (!ai.ok) {
    sendJson(res, 200, { ok: false, error: ai.error || '归纳失败', summary: null, members: members.map((item) => ({ id: item.id, title: item.title, url: item.url || null })) })
    return
  }
  const representativeId = ai.pickId || group.representativeId
  setClusterSummary(representativeId, ai.summary)
  sendJson(res, 200, {
    ok: true,
    summary: ai.summary,
    reason: ai.reason || null,
    pickId: representativeId,
    members: members.map((item) => ({ id: item.id, title: item.title, url: item.url || null })),
  })
}


/* --------------------------------------------------- 图片加入设计素材库 */

async function handleLibraryPush(req, res, ctx) {
  if (!requireMethod(req, res, ['POST'])) return
  const body = await readRequestBody(req)
  const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean).slice(0, 50) : []
  if (ids.length === 0) throw new Error('缺少要加入素材库的图片 id')
  const force = body.force === true
  let origin = null
  try {
    origin = ctx.webServer.getOrigin()
  } catch {
    origin = null
  }
  const results = []
  let pushed = 0
  let failed = 0
  for (const id of ids) {
    const item = getItem(id)
    if (!item) {
      results.push({ id, ok: false, error: '条目不存在' })
      failed += 1
      continue
    }
    if (item.kind !== 'image') {
      results.push({ id, ok: false, error: '只有图片可以加入素材库' })
      failed += 1
      continue
    }
    if (item.libraryPushedAt && !force) {
      results.push({ id, ok: true, skipped: true, libraryItemId: item.libraryItemId || null })
      continue
    }
    const urls = Array.isArray(item.images) && item.images.length > 0 ? item.images : item.cover ? [item.cover] : []
    if (urls.length === 0) {
      results.push({ id, ok: false, error: '这张图片没有本地副本，无法加入素材库' })
      failed += 1
      continue
    }
    const libraryItemIds = []
    const errors = []
    let count = 0
    for (let index = 0; index < urls.length; index += 1) {
      const outcome = await pushImageToLibrary(item, { origin, imageUrl: urls[index], imageIndex: index })
      if (outcome.ok) {
        count += 1
        if (outcome.libraryItemId) libraryItemIds.push(outcome.libraryItemId)
      } else {
        errors.push(outcome.error || '加入素材库失败')
      }
    }
    if (count > 0) {
      setLibraryPush(id, { libraryItemId: libraryItemIds.join(',').slice(0, 120) })
      results.push({ id, ok: errors.length === 0, count, libraryItemIds, error: errors[0] || null })
      pushed += count
    } else {
      results.push({ id, ok: false, error: errors[0] || '加入素材库失败' })
      failed += 1
    }
  }
  sendJson(res, 200, { ok: failed === 0, results, pushed, failed })
}


/* --------------------------------------------------- 微信聊天记录 ZIP 入库 */

async function handleIngestZip(req, res) {
  if (!requireMethod(req, res, ['POST'])) return
  const body = await readRequestBody(req)
  const path = typeof body.path === 'string' ? body.path.trim() : ''
  if (!path) throw new Error('缺少 ZIP 路径')
  const result = await ingestArchiveZip(path, { force: body.force === true })
  sendJson(res, 200, { ok: Boolean(result.ok), ...result })
}


async function handleLogout(req, res, ctx) {
  if (!requireMethod(req, res, ['POST'])) return
  const body = await readRequestBody(req)
  const provider = body.provider === 'douyin' ? 'douyin' : body.provider === 'bilibili' ? 'bilibili' : body.provider === 'xiaohongshu' ? 'xiaohongshu' : null
  if (!provider) throw new Error('provider 只能是 douyin / bilibili / xiaohongshu')
  setCookie(provider, '')
  setSyncState(provider, { account: null, lastError: null })
  if (provider === 'bilibili') setSyncState('bilibili', { lastResult: null })
  const snapshot = buildPublicSnapshot(ctx)
  sendJson(res, 200, { ok: true, accounts: snapshot.accounts })
}


async function handleChromeLoginConfirm(req, res, ctx) {
  if (!requireMethod(req, res, ['POST'])) return
  const body = await readRequestBody(req)
  const provider = body.provider === 'douyin' ? 'douyin' : body.provider === 'bilibili' ? 'bilibili' : body.provider === 'xiaohongshu' ? 'xiaohongshu' : null
  if (!provider) throw new Error('provider 只能是 douyin / bilibili / xiaohongshu')
  const mod = await import('./login/chrome-login.js')
  if (typeof mod.captureCookies !== 'function') throw new Error('登录模块不支持手动确认，请重启 DSH')
  const captured = await mod.captureCookies({ provider })
  if (!captured.ok || !captured.cookie) throw new Error(captured.error || '没有读到 cookie')
  // 小红书没有可靠的“是否登录”接口，且公开笔记游客也能读到正文：
  // 手动确认 = 用户说已登录，直接保存 cookie；再顺手探测一次正文仅用于返回 verified 标记，不阻断保存。
  setCookie(provider, captured.cookie)
  let verified
  if (provider === 'xiaohongshu') {
    const probe = getItems().find((item) => item.kind === 'xhs' && typeof item.url === 'string')
    if (probe) {
      try {
        const content = await resolveContent(probe, { force: true })
        verified = Boolean(content && typeof content.text === 'string' && content.text.trim())
      } catch {
        verified = false
      }
    }
  }
  setSyncState(provider, { lastError: null, supported: true, ...(provider === 'bilibili' ? {} : {}) })
  const app = await import('./login/chrome-login.js')
  try {
    await app.cancelLogin({ provider })
  } catch {
    // window close is best-effort
  }
  sendJson(res, 200, { ok: true, verified, accounts: buildPublicSnapshot(ctx).accounts })
}


async function handleEnrichCovers(req, res) {
  if (!requireMethod(req, res, ['POST'])) return
  const body = await readRequestBody(req)
  const result = await backfillCovers({
    limit: Number.isFinite(Number(body.limit)) ? Number(body.limit) : 20,
    force: body.force === true,
    kinds: Array.isArray(body.kinds) ? body.kinds : undefined,
  })
  sendJson(res, 200, { ok: true, ...result })
}


async function handleWorksSync(req, res) {
  if (!requireMethod(req, res, ['POST'])) return
  const body = await readRequestBody(req)
  const result = await syncWorks({ force: body.force === true })
  sendJson(res, 200, { ok: true, checked: result.checked, created: result.created, works: result.works })
}

async function handleWorksUpdate(req, res) {
  if (!requireMethod(req, res, ['POST'])) return
  const body = await readRequestBody(req)
  const result = updateWork(String(body.id || ''), body.patch && typeof body.patch === 'object' ? body.patch : {})
  if (!result.ok) throw new Error(result.error || '更新失败')
  sendJson(res, 200, { ok: true, work: result.work })
}

async function handleWorksDelete(req, res) {
  if (!requireMethod(req, res, ['POST'])) return
  const body = await readRequestBody(req)
  const result = deleteWork(String(body.id || ''))
  sendJson(res, 200, { ok: Boolean(result.ok) })
}


async function handleWorksExtract(req, res, ctx) {
  if (!requireMethod(req, res, ['POST'])) return
  const body = await readRequestBody(req)
  const item = getItem(String(body.itemId || ''))
  if (!item) throw new Error('条目不存在')
  let working = item
  const cachedText = item.content && typeof item.content.text === 'string' ? item.content.text.trim() : ''
  if (cachedText.length < 120) {
    const content = await resolveContent(item, { force: true })
    if (content && typeof content.text === 'string' && content.text.trim()) {
      working = { ...item, content }
    }
  }
  const extracted = await extractWorks(ctx, working)
  if (!extracted.ok) throw new Error(extracted.error || '文章提取失败')
  const added = []
  const failed = []
  for (const row of extracted.works || []) {
    try {
      const result = await addWork({
        title: row.title,
        kind: row.type === 'game' ? 'game' : 'drama',
        sourceItem: item,
      })
      if (result.ok) added.push(result.work)
      else failed.push({ title: row.title, error: result.error })
    } catch (error) {
      failed.push({ title: row.title, error: String(error?.message || error) })
    }
  }
  sendJson(res, 200, { ok: true, extracted: (extracted.works || []).length, added: added.length, works: added, failed })
}

async function handleWorksAdd(req, res) {
  if (!requireMethod(req, res, ['POST'])) return
  const body = await readRequestBody(req)
  const title = String(body.title || '').trim()
  if (!title) throw new Error('缺少作品名')
  const kind = body.kind === 'game' ? 'game' : 'drama'
  const result = await addWork({ title, kind })
  if (!result.ok) throw new Error(result.error || '添加失败')
  sendJson(res, 200, { ok: true, created: result.created, work: result.work })
}


async function handleWorksExtractText(req, res, ctx) {
  if (!requireMethod(req, res, ['POST'])) return
  const body = await readRequestBody(req)
  const text = String(body.text || '').trim()
  if (text.length < 80) throw new Error('正文太短，至少粘贴 80 字')
  const title = String(body.title || '').trim().slice(0, 200) || '粘贴的文章'
  const sourceUrl = typeof body.sourceUrl === 'string' && /^https?:\/\//i.test(body.sourceUrl) ? body.sourceUrl : null
  const synthetic = {
    id: 'paste-' + Date.now().toString(36),
    kind: 'article',
    title,
    url: sourceUrl,
    content: { type: 'article', text, images: [], fetchedAt: new Date().toISOString() },
  }
  const extracted = await extractWorks(ctx, synthetic)
  if (!extracted.ok) throw new Error(extracted.error || '提取失败')
  const added = []
  const failed = []
  for (const row of extracted.works || []) {
    const result = await addWork({
      title: row.title,
      kind: row.type === 'game' ? 'game' : 'drama',
      sourceItem: synthetic,
    })
    if (result.ok) added.push(result.work)
    else failed.push({ title: row.title, error: result.error })
  }
  sendJson(res, 200, { ok: true, extracted: (extracted.works || []).length, added: added.length, works: added, failed })
}


async function handleAgentEnrich(req, res, ctx) {
  if (!requireMethod(req, res, ['POST'])) return
  const body = await readRequestBody(req)
  const limit = Number.isFinite(Number(body.limit)) ? Math.max(1, Math.min(60, Number(body.limit))) : 30
  const candidates = getItems()
    .filter((item) => agentInfo(item).relevant)
    .filter((item) => !item.agentName || !item.agentCategory)
    .slice(0, limit)
  let updated = 0
  const errors = []
  for (let index = 0; index < candidates.length; index += 8) {
    const batch = candidates.slice(index, index + 8)
    const result = await enrichAgentItems(ctx, batch)
    if (result.ok) updated += result.updated
    else if (result.error) errors.push(result.error)
  }
  sendJson(res, 200, { ok: true, updated, remaining: Math.max(0, candidates.length - updated), error: errors[0] || null })
}

/* ----------------------------------------------------------- registration */

export function applyRoutes(ctx) {
  const exact = [
    [ROUTES.snapshot, guarded((req, res) => (requireMethod(req, res, ['GET', 'HEAD']) ? handleSnapshot(req, res, ctx) : undefined))],
    [ROUTES.health, guarded((req, res) => (requireMethod(req, res, ['GET', 'HEAD']) ? handleHealth(req, res, ctx) : undefined))],
    [ROUTES.add, guarded((req, res) => handleAdd(req, res, ctx))],
    [ROUTES.importText, guarded((req, res) => handleImport(req, res))],
    [ROUTES.update, guarded((req, res) => handleUpdate(req, res))],
    [ROUTES.action, guarded((req, res) => handleAction(req, res))],
    [ROUTES.remove, guarded((req, res) => handleDelete(req, res))],
    [ROUTES.invalid, guarded((req, res) => handleInvalid(req, res))],
    [ROUTES.review, guarded((req, res) => handleReview(req, res, ctx))],
    [ROUTES.organize, guarded((req, res) => handleOrganize(req, res, ctx))],
    [ROUTES.organizeStatus, guarded((req, res) => handleOrganizeStatus(req, res))],
    [ROUTES.organizeCancel, guarded((req, res) => handleOrganizeCancel(req, res))],
    [ROUTES.undo, guarded((req, res) => handleUndo(req, res))],
    [ROUTES.sync, guarded((req, res) => handleSync(req, res, ctx))],
    [ROUTES.settings, guarded((req, res) => handleSettings(req, res, ctx))],
    [ROUTES.resolve, guarded((req, res) => handleResolve(req, res))],
    [ROUTES.douyinParse, guarded((req, res) => handleDouyinParse(req, res))],
    [ROUTES.export, guarded((req, res) => handleExport(req, res))],
    [ROUTES.media, guarded((req, res) => handleMedia(req, res))],
    [ROUTES.loginBiliStart, guarded((req, res) => handleBiliLoginStart(req, res))],
    [ROUTES.loginBiliQr, guarded((req, res) => handleBiliLoginQr(req, res))],
    [ROUTES.loginBiliPoll, guarded((req, res) => handleBiliLoginPoll(req, res, ctx))],
    [ROUTES.loginChromeStart, guarded((req, res) => handleChromeLoginStart(req, res))],
    [ROUTES.loginChromePoll, guarded((req, res) => handleChromeLoginPoll(req, res, ctx))],
    [ROUTES.loginChromeCancel, guarded((req, res) => handleChromeLoginCancel(req, res))],
    [ROUTES.content, guarded((req, res) => handleContent(req, res))],
    [ROUTES.clusterReview, guarded((req, res) => handleClusterReview(req, res, ctx))],
    [ROUTES.logout, guarded((req, res) => handleLogout(req, res, ctx))],
    [ROUTES.loginChromeConfirm, guarded((req, res) => handleChromeLoginConfirm(req, res, ctx))],
    [ROUTES.libraryPush, guarded((req, res) => handleLibraryPush(req, res, ctx))],
    [ROUTES.ingestZip, guarded((req, res) => handleIngestZip(req, res))],
    [ROUTES.enrichCovers, guarded((req, res) => handleEnrichCovers(req, res))],
    [ROUTES.worksSync, guarded((req, res) => handleWorksSync(req, res))],
    [ROUTES.worksUpdate, guarded((req, res) => handleWorksUpdate(req, res))],
    [ROUTES.worksDelete, guarded((req, res) => handleWorksDelete(req, res))],
    [ROUTES.worksExtract, guarded((req, res) => handleWorksExtract(req, res, ctx))],
    [ROUTES.worksAdd, guarded((req, res) => handleWorksAdd(req, res))],
    [ROUTES.worksExtractText, guarded((req, res) => handleWorksExtractText(req, res, ctx))],
    [ROUTES.agentEnrich, guarded((req, res) => handleAgentEnrich(req, res, ctx))],
  ]
  for (const [path, handler] of exact) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }))
  }
}

export { ROUTES, PREFIX, MEDIA_PATH, getCookie, getSyncState, MEDIA_DIR }
