/**
 * 「影游」清单：从影游条目里提取作品名，然后去外部元数据源（Bangumi）取作品的
 * 真实封面 + 标准标题，构建成「封面 + 名称」的作品清单。
 * 作品详情里保存来源文章标题/链接（链接只在详情展示，不占据清单条目）。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DATA_DIR, getItems, saveMediaBytes } from './store.js'
import { request, UA } from './sync/http.js'

const WORKS_FILE = join(DATA_DIR, 'works.json')
const BANGUMI_SEARCH = 'https://api.bgm.tv/v0/search/subjects'
const BANGUMI_UA = 'dsh-watch-later/1.0 (local personal assistant)'
const LOOKUP_GAP_MS = 1200

export function normalizeWorkTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[《》「」『』【】()（）\[\]<>·—\-_,，。!！?？:：;；'"“”‘’~～|/\\\s]/g, '')
}

function shortHash(text) {
  return createHash('sha1').update(String(text)).digest('hex').slice(0, 12)
}

function workId(title, kind) {
  return 'wk_' + shortHash(normalizeWorkTitle(title) + '|' + kind)
}

const SKIP_TITLE_RE = /(好番|片单|清单|合集|盘点|排行榜|榜单|推荐|盘点|安利|收藏|测评合集|攻略合集)/

/** 从一条影游条目里提取作品名（可多个）。 */
export function extractWorkNames(item) {
  const title = String(item && item.title ? item.title : '').trim()
  if (!title) return []
  const names = []
  const quoted = title.matchAll(/[《【]([^》】]{2,40})[》】]/g)
  const SKIP_BRACKET = /(攻略|评测|测评|解析|分析|汇总|清单|合集|盘点|推荐|更新|图注|第\s*\d+\s*[集话期季]|教程|指南|数据|排行|榜单)/
  for (const match of quoted) {
    const name = match[1].trim()
    if (name && !SKIP_BRACKET.test(name)) names.push(name)
  }
  if (names.length > 0) return [...new Set(names)]

  // 没有书名号：只处理“像是在讲一部作品”的短标题
  let text = title
    .replace(/【[^】]*】/g, ' ')
    .replace(/\([^)]*\)|（[^）]*）/g, ' ')
    .replace(/^\s*[\[【][^\]]*[\]】]\s*/, ' ')
    .replace(/[！!？?。].*$/g, ' ')
    .trim()
  text = text.replace(/(不同|各种|的|怎么|如何|攻略|评测|测评|解析|分析|汇总|详解|指南|教程|数据|分布图|对线|段位|限时任务|隐藏内容|心得|体验|试玩|实机|任务中心|任务路线|支线|主线|截图|地图|道具|装备|技能|版本|活动|赛季|第\s*\d+\s*[集话期季]|更新修正图注版|完整版|图文版).*$/g, '')
  text = text.replace(/[\s·—\-_:：]+$/g, '').trim()
  if (!text || text.length < 2 || text.length > 24) return []
  if (SKIP_TITLE_RE.test(text)) return []
  if (/^\d{4}\s*年/.test(text)) return []
  if (/(怎么|如何|为什么|吗|呢|推荐|盘点|合集|清单|攻略|教程)/.test(text) && !/^[《]/.test(title)) return []
  return [text]
}

function kindOf(item, name) {
  const text = [item.kind, item.title, name].filter(Boolean).join(' ')
  if (/游戏|game|steam|mod|dlc|主机|手游|端游|电竞|截图|段位/i.test(text)) return 'game'
  return 'drama'
}

function typeFilter(kind) {
  if (kind === 'game') return [4]
  return [2, 6]
}

export function pickBangumiSubject(results, query) {
  let best = null
  let bestScore = 0
  const normalizedQuery = normalizeWorkTitle(query)
  for (const subject of Array.isArray(results) ? results : []) {
    for (const name of [subject.name_cn, subject.name].filter(Boolean)) {
      const normalizedName = normalizeWorkTitle(name)
      let score = 0
      if (normalizedQuery.length <= 4) {
        // 短标题（如「死锁」）很容易误配到「瑞奇与叮当 死锁」之类的长名字，只接受完全相等或前缀。
        if (normalizedName === normalizedQuery) score = 1
        else if (normalizedName.startsWith(normalizedQuery)) score = 0.85
        else score = 0
      } else {
        score = titleSimilarity(query, name)
      }
      if (score > bestScore) {
        best = subject
        bestScore = score
      }
    }
  }
  return bestScore >= 0.5 ? { subject: best, score: bestScore } : null
}

function titleSimilarity(a, b) {
  const left = normalizeWorkTitle(a)
  const right = normalizeWorkTitle(b)
  if (!left || !right) return 0
  if (left === right) return 1
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left]
  if (longer.includes(shorter)) return 0.55 + 0.4 * (shorter.length / longer.length)
  return 0
}

async function bangumiSearch(keyword, type) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await request(BANGUMI_SEARCH, {
        method: 'POST',
        headers: {
          'user-agent': BANGUMI_UA,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ keyword, filter: { type: [type] }, limit: 10 }),
        timeoutMs: 15000,
      })
      if (response.status === 429) {
        await new Promise((resolve) => setTimeout(resolve, 1500))
        continue
      }
      if (!response.ok) return []
      const data = await response.json()
      return Array.isArray(data && data.data) ? data.data : []
    } catch {
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 800))
    }
  }
  return []
}

async function downloadImage(url) {
  try {
    const response = await request(url, { headers: { 'user-agent': BANGUMI_UA, accept: 'image/*' }, timeoutMs: 15000 })
    if (!response.ok) return null
    const bytes = await response.bytes()
    if (!bytes || bytes.length < 1024 || bytes.length > 8 * 1024 * 1024) return null
    const extension = bytes[0] === 0x89 && bytes[1] === 0x50 ? '.png' : '.jpg'
    const media = saveMediaBytes(bytes, extension)
    return media && media.url ? media.url : null
  } catch {
    return null
  }
}

/**
 * 查一个作品的封面/标准标题/简介。
 * @returns {Promise<{ok:boolean, title?:string, cover?:string, summary?:string, subjectId?:number, error?:string}>}
 */
export async function lookupWork(title, kind) {
  const types = typeFilter(kind)
  for (const type of types) {
    const results = await bangumiSearch(title, type)
    await new Promise((resolve) => setTimeout(resolve, 400))
    const picked = pickBangumiSubject(results, title)
    if (!picked) continue
    const subject = picked.subject
    const imageUrl = (subject.images && (subject.images.large || subject.images.common || subject.images.medium)) || subject.image || null
    const cover = imageUrl ? await downloadImage(imageUrl) : null
    return {
      ok: Boolean(cover),
      title: subject.name_cn || subject.name || title,
      kind,
      cover,
      summary: subject.summary ? subject.summary.replace(/\s+/g, ' ').trim().slice(0, 200) : '',
      subjectId: subject.id || null,
      error: cover ? null : '没有图片',
    }
  }
  return { ok: false, error: '没找到对应作品' }
}

function readWorksFile() {
  try {
    const data = JSON.parse(readFileSync(WORKS_FILE, 'utf8'))
    return Array.isArray(data.works) ? data : { version: 1, works: [], syncedAt: null }
  } catch {
    return { version: 1, works: [], syncedAt: null }
  }
}

function writeWorksFile(data) {
  try {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  } catch {
    // ignore
  }
  const temporary = WORKS_FILE + '.tmp-' + process.pid + '-' + Date.now().toString(36)
  writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600 })
  renameSync(temporary, WORKS_FILE)
}

export function readWorks() {
  return readWorksFile().works
}

export function updateWork(id, patch) {
  const data = readWorksFile()
  const work = data.works.find((row) => row.id === id)
  if (!work) return { ok: false, error: '作品不存在' }
  if (patch && ['want', 'playing', 'done'].includes(patch.status)) work.status = patch.status
  if (patch && typeof patch.title === 'string' && patch.title.trim()) work.title = patch.title.trim().slice(0, 80)
  if (patch && typeof patch.note === 'string') work.note = patch.note.slice(0, 500)
  work.updatedAt = new Date().toISOString()
  writeWorksFile(data)
  return { ok: true, work }
}

/**
 * 手动/从文章提取添加一个作品：查封面和标准标题后入库；同名/同 subject 去重。
 * @returns {Promise<{ok:boolean, created?:boolean, work?:object, error?:string}>}
 */
export async function addWork({ title, kind = 'drama', sourceItem = null, lookupFn } = {}) {
  const clean = String(title || '').trim().slice(0, 80)
  if (!clean) return { ok: false, error: '作品名为空' }
  const lookup = typeof lookupFn === 'function' ? lookupFn : lookupWork
  const found = await lookup(clean, kind)
  if (!found || !found.ok) return { ok: false, error: (found && found.error) || '没找到对应作品' }
  const data = readWorksFile()
  const key = normalizeWorkTitle(clean)
  const sameTitle = (work) => {
    const workKey = normalizeWorkTitle(work.title)
    return workKey === key || workKey.includes(key) || key.includes(workKey)
  }
  const existing = data.works.find((work) => (found.subjectId && String(work.subjectId) === String(found.subjectId)) || sameTitle(work))
  const base = {
    title: found.title || clean,
    kind,
    cover: found.cover,
    summary: found.summary || (existing && existing.summary) || '',
    subjectId: found.subjectId || (existing && existing.subjectId) || null,
    updatedAt: new Date().toISOString(),
  }
  if (existing) {
    Object.assign(existing, base)
    if (sourceItem) {
      existing.sourceUrl = existing.sourceUrl || sourceItem.url || null
      existing.sourceTitle = existing.sourceTitle || sourceItem.title || null
      existing.sourceItemId = existing.sourceItemId || sourceItem.id || null
    }
    writeWorksFile(data)
    return { ok: true, created: false, work: existing }
  }
  const work = {
    id: workId(base.title, kind),
    ...base,
    sourceUrl: sourceItem ? sourceItem.url || null : null,
    sourceTitle: sourceItem ? sourceItem.title || null : null,
    sourceItemId: sourceItem ? sourceItem.id || null : null,
    status: 'want',
    createdAt: new Date().toISOString(),
  }
  data.works.push(work)
  writeWorksFile(data)
  return { ok: true, created: true, work }
}

export function deleteWork(id) {
  const data = readWorksFile()
  const before = data.works.length
  data.works = data.works.filter((row) => row.id !== id)
  writeWorksFile(data)
  return { ok: data.works.length !== before }
}

/**
 * 从影游条目同步作品清单。已有作品不重复；新作品查 Bangumi 封面/标准标题。
 * @param {{items?: Array, lookupFn?: Function, force?: boolean, delayMs?: number}} options
 */
export async function syncWorks(options = {}) {
  const data = readWorksFile()
  const items = Array.isArray(options.items) ? options.items : null
  const lookup = typeof options.lookupFn === 'function' ? options.lookupFn : lookupWork
  const force = options.force === true
  const delayMs = Number.isFinite(Number(options.delayMs)) ? Number(options.delayMs) : LOOKUP_GAP_MS

  const sourceItems = items || getItems().filter((item) => {
    if (item.kind === 'game' || item.kind === 'drama') return true
    const tags = Array.isArray(item.tags) ? item.tags : []
    return tags.includes('影游')
  })

  const existing = new Map(data.works.map((work) => [normalizeWorkTitle(work.title), work]))
  const existingBySubject = new Map(data.works.filter((work) => work.subjectId).map((work) => [String(work.subjectId), work]))
  const candidates = []
  for (const item of sourceItems) {
    if (!item || item.status === 'archived') continue
    for (const name of extractWorkNames(item)) {
      const kind = kindOf(item, name)
      const key = normalizeWorkTitle(name)
      if (!key) continue
      if (existing.has(key) && !force) continue
      candidates.push({ name, kind, item })
    }
  }

  const byKey = new Map()
  for (const candidate of candidates) {
    const key = normalizeWorkTitle(candidate.name)
    const existingCandidate = byKey.get(key)
    // 同一作品优先保留带原文链接的条目作为来源
    if (!existingCandidate || (!existingCandidate.item.url && candidate.item.url)) byKey.set(key, candidate)
  }

  const results = []
  for (const candidate of byKey.values()) {
    const existingWork = existing.get(normalizeWorkTitle(candidate.name))
    const found = await lookup(candidate.name, candidate.kind)
    if (!found || !found.ok) {
      results.push({ title: candidate.name, ok: false, error: (found && found.error) || 'lookup failed' })
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      continue
    }
    const subjectKey = found.subjectId ? String(found.subjectId) : null
    const sameSubject = subjectKey ? existingBySubject.get(subjectKey) : null
    const target = existingWork || sameSubject
    const work = {
      id: target ? target.id : workId(found.title || candidate.name, candidate.kind),
      title: found.title || candidate.name,
      kind: candidate.kind,
      cover: found.cover,
      summary: found.summary || (target && target.summary) || '',
      sourceUrl: candidate.item.url || (target && target.sourceUrl) || null,
      sourceTitle: candidate.item.title || (target && target.sourceTitle) || null,
      sourceItemId: candidate.item.id || (target && target.sourceItemId) || null,
      status: (target && target.status) || 'want',
      subjectId: found.subjectId || (target && target.subjectId) || null,
      createdAt: (target && target.createdAt) || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    if (target) {
      Object.assign(target, work)
    } else {
      data.works.push(work)
    }
    existing.set(normalizeWorkTitle(work.title), target || work)
    if (work.subjectId) existingBySubject.set(String(work.subjectId), target || work)
    results.push({ title: work.title, ok: true, cover: Boolean(work.cover) })
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
  }

  // 兜底：给还没有来源链接的作品，从影游条目里找一条带 url 的来源
  for (const work of data.works) {
    if (work.sourceUrl) continue
    const workKey = normalizeWorkTitle(work.title)
    for (const item of sourceItems) {
      if (!item.url) continue
      const names = extractWorkNames(item)
      if (names.some((name) => {
        const key = normalizeWorkTitle(name)
        return key === workKey || workKey.includes(key) || key.includes(workKey)
      })) {
        work.sourceUrl = item.url
        work.sourceTitle = item.title || null
        work.sourceItemId = item.id || null
        break
      }
    }
  }

  data.syncedAt = new Date().toISOString()
  writeWorksFile(data)
  return { ok: true, checked: byKey.size, created: results.filter((row) => row.ok).length, results, works: data.works }
}
