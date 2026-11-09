/**
 * score.js — 「稍后再看」分类 / 时效 / 打分 / 视图派生
 *
 * 契约：CONTRACT.md §2（Item 模型）、§3（打分公式 / timeSensitivity / triage / 排序 /
 * deriveItem / 启发式规则）、§6（counts 口径）—— 唯一事实来源，导出名与字段名不得改动。
 *
 * 纯 ESM、纯函数、零 I/O、零第三方依赖；所有时间都通过 nowMs 参数注入（缺省兜底
 * Date.now()，方便非测试调用方）。所有入参都做防御性降级，不抛错。
 */

const HOUR_MS = 3600 * 1000
const DAY_MS = 24 * HOUR_MS

/** CONTRACT §2：13 个 kind，顺序即 UI 类型筛选顺序 */
export const KINDS = [
  'image',
  'xhs',
  'wechat',
  'link',
  'video',
  'bilibili',
  'douyin',
  'drama',
  'game',
  'article',
  'product',
  'idea',
  'other',
]

/** CONTRACT §3：kind 元信息（label 中文名 / weight 0.4~0.9 / icon 英文短名） */
export const KIND_META = {
  image: { label: '图片', weight: 0.5, icon: 'image' },
  xhs: { label: '小红书', weight: 0.7, icon: 'xhs' },
  wechat: { label: '微信公众号', weight: 0.8, icon: 'wechat' },
  link: { label: '链接', weight: 0.5, icon: 'link' },
  video: { label: '视频', weight: 0.6, icon: 'video' },
  bilibili: { label: 'B站', weight: 0.65, icon: 'bili' },
  douyin: { label: '抖音', weight: 0.6, icon: 'douyin' },
  drama: { label: '剧集', weight: 0.85, icon: 'drama' },
  game: { label: '游戏', weight: 0.7, icon: 'game' },
  article: { label: '文章', weight: 0.75, icon: 'article' },
  product: { label: '商品', weight: 0.6, icon: 'product' },
  idea: { label: '灵感', weight: 0.6, icon: 'sparkle' },
  other: { label: '其他', weight: 0.4, icon: 'other' },
}

/** CONTRACT §3：triage 排序权重（越小越靠前） */
export const TRIAGE_RANK = {
  expired: 0,
  now: 1,
  today: 2,
  week: 3,
  later: 4,
  done: 5,
  archived: 6,
}

/* ------------------------------------------------------------------ *
 * 内部工具
 * ------------------------------------------------------------------ */

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 归一化 nowMs：缺省/非法时兜底 Date.now()，保证调用方漏传/传错也能工作 */
function normalizeNow(nowMs) {
  if (nowMs === null || nowMs === undefined || nowMs === '') return Date.now()
  const n = typeof nowMs === 'number' ? nowMs : Number(nowMs)
  if (Number.isFinite(n)) return n
  if (typeof nowMs === 'string') {
    const parsed = Date.parse(nowMs)
    if (Number.isFinite(parsed)) return parsed
  }
  return Date.now()
}

/** 把各种时间表示解析为毫秒；解析不出返回 null（不抛错、不瞎猜） */
function toMs(value) {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) {
    const t = value.getTime()
    return Number.isFinite(t) ? t : null
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  const t = Date.parse(text)
  return Number.isFinite(t) ? t : null
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value))
}

/** 打分用：契约 `clamp(item.importance ?? 3, 1, 5)`，NaN/缺失/NULL 都降级为默认值 */
function clampRating(value, fallback = 3) {
  if (value === null || value === undefined || value === '') return fallback
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return clamp(n, 1, 5)
}

/** ItemView 用：模型里 importance / urgency 是 1|2|3|4|5 整数 */
function intRating(value, fallback = 3) {
  return Math.round(clampRating(value, fallback))
}

/** ItemView 用：tags 必须是字符串数组 */
function normalizeTags(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((tag) => typeof tag === 'string')
    .map((tag) => tag.trim())
    .filter(Boolean)
}

const VALID_STATUSES = new Set(['inbox', 'queued', 'doing', 'done', 'archived'])
const VALID_DEADLINE_KINDS = new Set(['airing', 'event', 'expiry', 'release', 'deadline', 'none'])

const DEFAULT_AI = {
  state: 'none',
  classified: false,
  version: null,
  fields: [],
  reason: null,
  confidence: null,
  at: null,
  lastError: null,
  suggest: null,
  prev: null,
}

function ageHoursOf(item, nowMs) {
  const created = toMs(item && item.createdAt)
  if (created === null) return 0
  return Math.max(0, (nowMs - created) / HOUR_MS)
}

/* ------------------------------------------------------------------ *
 * classifyUrl — CONTRACT §3.6
 * ------------------------------------------------------------------ */

const IMAGE_EXTS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'avif',
  'bmp',
  'svg',
  'heic',
  'heif',
  'ico',
  'tif',
  'tiff',
])

const VIDEO_EXTS = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'flv', 'm3u8', 'wmv'])

// 平台 host → kind / site。契约 §3.6 的映射表；豆瓣来自 §2 site 示例。
const SITE_RULES = [
  { domains: ['xiaohongshu.com', 'xhslink.com'], kind: 'xhs', site: '小红书' },
  { domains: ['weixin.qq.com'], kind: 'wechat', site: '微信公众号' },
  { domains: ['bilibili.com', 'b23.tv'], kind: 'bilibili', site: 'B站' },
  { domains: ['douyin.com', 'iesdouyin.com'], kind: 'douyin', site: '抖音' },
  { domains: ['weibo.com', 'weibo.cn'], kind: 'link', site: '微博' },
  { domains: ['zhihu.com'], kind: 'article', site: '知乎' },
  { domains: ['github.com'], kind: 'link', site: 'GitHub' },
  { domains: ['youtube.com', 'youtu.be'], kind: 'video', site: 'YouTube' },
  { domains: ['douban.com'], kind: 'link', site: '豆瓣' },
  { domains: ['xiaoheihe.cn'], kind: 'link', site: '小黑盒' },
  { domains: ['store.steampowered.com', 'steampowered.com'], kind: 'game', site: 'Steam' },
  { domains: ['taobao.com'], kind: 'product', site: '淘宝' },
  { domains: ['tmall.com'], kind: 'product', site: '天猫' },
  { domains: ['jd.com'], kind: 'product', site: '京东' },
  { domains: ['pinduoduo.com'], kind: 'product', site: '拼多多' },
]

function hostMatches(host, domain) {
  return host === domain || host.endsWith('.' + domain)
}

function extOfPath(path) {
  if (typeof path !== 'string' || !path) return ''
  const clean = path.split('#')[0].split('?')[0]
  const match = /\.([a-z0-9]{1,8})$/i.exec(clean)
  return match ? match[1].toLowerCase() : ''
}

/** 宽松解析 URL（支持无协议 / www. / // 前缀），失败返回 null */
function parseUrlInfo(raw) {
  const candidates = []
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) candidates.push(raw)
  else if (raw.startsWith('//')) candidates.push('https:' + raw)
  else candidates.push('https://' + raw)
  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
      const host = parsed.hostname.toLowerCase()
      if (!host || !host.includes('.')) continue
      return { host, pathname: parsed.pathname || '' }
    } catch {
      // 忽略，继续尝试下一个候选
    }
  }
  return null
}

/**
 * CONTRACT §3.6：按 URL 判定 kind + 展示用 site 名。
 * 空 / 非法入参 → { kind: 'other', site: null }；认不出的非空 URL → { kind: 'link', site: null }。
 */
export function classifyUrl(url) {
  if (typeof url !== 'string') return { kind: 'other', site: null }
  const raw = url.trim()
  if (!raw) return { kind: 'other', site: null }
  if (/^data:image\//i.test(raw)) return { kind: 'image', site: null }
  if (/^data:video\//i.test(raw)) return { kind: 'video', site: null }

  const info = parseUrlInfo(raw)
  if (info) {
    for (const rule of SITE_RULES) {
      if (rule.domains.some((domain) => hostMatches(info.host, domain))) {
        return { kind: rule.kind, site: rule.site }
      }
    }
    const ext = extOfPath(info.pathname) || extOfPath(raw)
    if (IMAGE_EXTS.has(ext)) return { kind: 'image', site: null }
    if (VIDEO_EXTS.has(ext)) return { kind: 'video', site: null }
    return { kind: 'link', site: null }
  }

  // 无法解析成 URL 时，仍尝试按扩展名判定（例如收件箱里的裸文件名 cat.jpg）
  const ext = extOfPath(raw)
  if (IMAGE_EXTS.has(ext)) return { kind: 'image', site: null }
  if (VIDEO_EXTS.has(ext)) return { kind: 'video', site: null }
  return { kind: 'link', site: null }
}

/* ------------------------------------------------------------------ *
 * timeSensitivity — CONTRACT §3.2
 * ------------------------------------------------------------------ */

/**
 * @param {string|null|undefined} deadlineIso 时效关键时刻
 * @param {number} nowMs 当前时间毫秒
 * @returns {{ level: 'expired'|'critical'|'soon'|'ahead'|'none', hoursLeft: number|null, pressure: number }}
 */
export function timeSensitivity(deadlineIso, nowMs) {
  const now = normalizeNow(nowMs)
  const target = toMs(deadlineIso)
  if (target === null) return { level: 'none', hoursLeft: null, pressure: 0 }

  const hoursLeft = (target - now) / HOUR_MS

  if (hoursLeft < 0) {
    if (hoursLeft < -24) return { level: 'expired', hoursLeft, pressure: 0 }
    return { level: 'expired', hoursLeft, pressure: 60 }
  }
  if (hoursLeft <= 6) return { level: 'critical', hoursLeft, pressure: 100 }
  if (hoursLeft <= 24) return { level: 'critical', hoursLeft, pressure: 85 }
  if (hoursLeft <= 72) return { level: 'soon', hoursLeft, pressure: 65 }
  if (hoursLeft <= 168) return { level: 'soon', hoursLeft, pressure: 45 }
  if (hoursLeft <= 336) return { level: 'ahead', hoursLeft, pressure: 25 }
  return { level: 'ahead', hoursLeft, pressure: 10 }
}

/* ------------------------------------------------------------------ *
 * computeScore — CONTRACT §3.1 + §3.3
 * ------------------------------------------------------------------ */

/**
 * @returns {{ score:number, triage:string, signals:{importance:number,urgency:number,freshness:number,deadlinePressure:number} }}
 */
export function computeScore(item, nowMs) {
  const it = isPlainObject(item) ? item : {}
  const now = normalizeNow(nowMs)

  const importance = clampRating(it.importance)
  const urgency = clampRating(it.urgency)

  const ageHours = ageHoursOf(it, now)
  const freshness = 100 * Math.exp(-ageHours / 96) // 4 天约 37%，10 天约 8%
  const ts = timeSensitivity(it.deadline, now)
  const timePull = Math.max(freshness, ts.pressure)

  let score = Math.round(0.45 * importance * 20 + 0.35 * urgency * 20 + 0.2 * timePull)
  score = Math.min(100, Math.max(0, score))

  const status = VALID_STATUSES.has(it.status) ? it.status : 'inbox'

  let triage
  if (status === 'done') triage = 'done'
  else if (status === 'archived') triage = 'archived'
  else if (ts.level === 'expired') triage = 'expired'
  else if (ts.pressure >= 85 || score >= 78) triage = 'now'
  else if (ts.pressure >= 65 || score >= 62) triage = 'today'
  else if (ts.pressure >= 45 || score >= 45) triage = 'week'
  else triage = 'later'

  if (status === 'done' || status === 'archived') score = Math.min(score, 40)

  return {
    score,
    triage,
    signals: {
      importance,
      urgency,
      freshness,
      deadlinePressure: ts.pressure,
    },
  }
}

/* ------------------------------------------------------------------ *
 * deriveItem — CONTRACT §3.5
 * ------------------------------------------------------------------ */

function normalizeDeadline(value) {
  const ms = toMs(value)
  if (ms === null) return null
  if (typeof value === 'string') return value
  return new Date(ms).toISOString()
}

function titleOf(it, kindLabel) {
  if (typeof it.title === 'string' && it.title.trim()) return it.title.trim()
  if (typeof it.url === 'string' && it.url.trim()) return it.url.trim()
  if (typeof it.site === 'string' && it.site.trim()) return it.site.trim()
  return kindLabel
}

/**
 * 生成 UI 唯一依赖的 ItemView：Item 全字段 + 派生字段。不修改入参。
 * 缺失 / 非法字段做防御性归一化（kind、status、importance、urgency、deadline、tags、ai），
 * 保证 UI 直接渲染不炸。
 */
export function deriveItem(item, nowMs) {
  const it = isPlainObject(item) ? item : {}
  const now = normalizeNow(nowMs)

  const kind = KINDS.includes(it.kind) ? it.kind : 'other'
  const kindLabel = KIND_META[kind].label
  const status = VALID_STATUSES.has(it.status) ? it.status : 'inbox'
  const deadline = normalizeDeadline(it.deadline)
  const deadlineKind = deadline === null ? 'none' : VALID_DEADLINE_KINDS.has(it.deadlineKind) ? it.deadlineKind : 'none'
  const ai = isPlainObject(it.ai) ? { ...DEFAULT_AI, ...it.ai } : { ...DEFAULT_AI }

  const base = {
    ...it,
    kind,
    status,
    title: titleOf(it, kindLabel),
    tags: normalizeTags(it.tags),
    importance: intRating(it.importance),
    urgency: intRating(it.urgency),
    deadline,
    deadlineKind,
    ai,
  }

  const { score, triage, signals } = computeScore(base, now)
  const ts = timeSensitivity(deadline, now)

  return {
    ...base,
    score,
    triage,
    kindLabel,
    ageHours: ageHoursOf(base, now),
    signals,
    timeSensitivity: { level: ts.level, hoursLeft: ts.hoursLeft },
    hasTimeSensitivity: ts.level !== 'none',
  }
}

/** CONTRACT §3：deriveItem 的别名（为宿主半兼容保留） */
export function deriveSnapshotView(item, nowMs) {
  return deriveItem(item, nowMs)
}

/* ------------------------------------------------------------------ *
 * sortForQueue — CONTRACT §3.4
 * ------------------------------------------------------------------ */

function compareViews(a, b) {
  const rankA = TRIAGE_RANK[a.triage] ?? 99
  const rankB = TRIAGE_RANK[b.triage] ?? 99
  if (rankA !== rankB) return rankA - rankB

  const deadlineA = toMs(a.deadline)
  const deadlineB = toMs(b.deadline)

  if (deadlineA !== null && deadlineB !== null) {
    if (deadlineA !== deadlineB) return deadlineA - deadlineB // 更早的 deadline 在前
  } else if (deadlineA !== null) {
    return -1 // 有时效的排在无时效的前面
  } else if (deadlineB !== null) {
    return 1
  } else if (b.score !== a.score) {
    return b.score - a.score // 都没 deadline：score 降序
  }

  const createdA = toMs(a.createdAt)
  const createdB = toMs(b.createdAt)
  if (createdA !== null && createdB !== null && createdA !== createdB) return createdB - createdA
  if (createdA === null && createdB !== null) return 1 // 无 createdAt 的排后面
  if (createdA !== null && createdB === null) return -1
  return 0
}

/**
 * CONTRACT §3.4：先按 triage 桶升序；同桶内有 deadline 的按 deadline 升序，
 * 都没 deadline 的按 score 降序；最后 createdAt 降序。不修改入参数组、不做过滤。
 */
export function sortForQueue(items, nowMs) {
  const now = normalizeNow(nowMs)
  const list = Array.isArray(items) ? items : []
  return list.map((item) => deriveItem(item, now)).sort(compareViews)
}

/* ------------------------------------------------------------------ *
 * countItems — CONTRACT §6 counts 口径
 * ------------------------------------------------------------------ */

/**
 * 统计 Snapshot.counts。口径：
 * - total: 全部条目数
 * - active: status ∈ {inbox, queued, doing}
 * - inbox: status === 'inbox'
 * - now/today/week/later/expired: active 条目按 triage 计数
 * - done / archived: status 计数
 * - timeSensitive: active 中 hasTimeSensitivity
 * - byKind: 只统计 active（含 11 个 kind 的 0 值，方便 UI 直接渲染类型 chips）
 */
export function countItems(items, nowMs) {
  const now = normalizeNow(nowMs)
  const list = Array.isArray(items) ? items : []

  const counts = {
    total: 0,
    active: 0,
    inbox: 0,
    now: 0,
    today: 0,
    week: 0,
    later: 0,
    expired: 0,
    done: 0,
    archived: 0,
    timeSensitive: 0,
    byKind: {},
    organize: { total: 0, done: 0, partial: 0, none: 0, failed: 0, pending: 0 },
  }
  for (const kind of KINDS) counts.byKind[kind] = 0

  for (const raw of list) {
    if (!isPlainObject(raw)) continue
    const view = deriveItem(raw, now)
    counts.total += 1

    // 「AI 整理」口径：覆盖全部条目（含已完成/已归档），pending = 还需要再整理一轮。
    counts.organize.total += 1
    const aiState = view.ai && typeof view.ai.state === 'string' ? view.ai.state : 'none'
    if (aiState === 'done') counts.organize.done += 1
    else if (aiState === 'partial') {
      counts.organize.partial += 1
      counts.organize.pending += 1
    } else if (aiState === 'failed') {
      counts.organize.failed += 1
      counts.organize.pending += 1
    } else {
      counts.organize.none += 1
      counts.organize.pending += 1
    }

    if (view.status === 'done') {
      counts.done += 1
      continue
    }
    if (view.status === 'archived') {
      counts.archived += 1
      continue
    }

    counts.active += 1
    if (view.status === 'inbox') counts.inbox += 1
    if (view.triage === 'now') counts.now += 1
    else if (view.triage === 'today') counts.today += 1
    else if (view.triage === 'week') counts.week += 1
    else if (view.triage === 'later') counts.later += 1
    else if (view.triage === 'expired') counts.expired += 1
    if (view.hasTimeSensitivity) counts.timeSensitive += 1
    counts.byKind[view.kind] = (counts.byKind[view.kind] || 0) + 1
  }

  return counts
}
