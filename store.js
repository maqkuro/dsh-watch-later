/**
 * Data layer for the DSH watch-later center.
 *
 * Everything lives under ~/.dsh/storages/watch-later (override with
 * DSH_WATCH_LATER_DIR, used by tests):
 *   items.json       the collection
 *   media/           local covers and forwarded images
 *   inbox/           drop zone watched by ingest.js
 *   secrets.json     provider cookies (0600, never returned to the client)
 *   sync-state.json  last sync result per provider
 *
 * All writes are atomic (tmp file + rename) and synchronous: the data set is
 * small and Node runs handlers on one thread, so there is no interleaving.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, extname, basename } from 'node:path'
import { randomBytes } from 'node:crypto'
import { deriveItem, TRIAGE_RANK, KINDS, KIND_META, classifyUrl } from './score.js'
import { heuristicExtract, parseDeadlineFromText } from './classify.js'
import { buildClusters } from './cluster.js'
import { agentInfo } from './agent.js'
import { mediaInfo } from './media.js'
import { TOPICS, topicOf, topicTagOf, withTopic } from './topics.js'

export const DATA_DIR =
  process.env.DSH_WATCH_LATER_DIR || join(homedir(), '.dsh', 'storages', 'watch-later')
export const ITEMS_FILE = join(DATA_DIR, 'items.json')
export const MEDIA_DIR = join(DATA_DIR, 'media')
export const INBOX_DIR = join(DATA_DIR, 'inbox')
export const INBOX_DONE_DIR = join(INBOX_DIR, 'done')
export const SECRETS_FILE = join(DATA_DIR, 'secrets.json')
export const SYNC_STATE_FILE = join(DATA_DIR, 'sync-state.json')

const VERSION = 1
/** Per-item original-image cap (gallery items). 一次聊天记录原包常有好几十张。 */
export const MAX_IMAGES = 100
const MAX_ITEMS = 4000
const MAX_MEDIA_BYTES = 8 * 1024 * 1024
const KINDS_SET = new Set(KINDS)
const STATUSES = new Set(['inbox', 'queued', 'doing', 'done', 'archived'])
const DEADLINE_KINDS = new Set(['airing', 'event', 'expiry', 'release', 'deadline', 'none'])
const CHANNELS = new Set(['manual', 'agent', 'inbox', 'paste', 'bilibili', 'douyin', 'zip'])
const DEFAULT_SETTINGS = {
  autoAiOnSync: true,
  // 2026-11-09 主人要求：每次转发文件入库都要大模型过一遍（不只是同步来的条目）。
  autoAiOnIngest: true,
  retentionDays: 30,
  inboxEnabled: true,
  dedupeClusters: true,
}

const MEDIA_TYPES = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

let cache = null

/* ------------------------------------------------------------------ paths */

export function ensureDirs() {
  for (const dir of [DATA_DIR, MEDIA_DIR, INBOX_DIR, INBOX_DONE_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
}

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJsonAtomic(file, payload, mode) {
  ensureDirs()
  const tmp = file + '.tmp-' + process.pid + '-' + randomBytes(3).toString('hex')
  writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: mode || 0o600 })
  renameSync(tmp, file)
}

/* ------------------------------------------------------------------ state */

function defaultState() {
  return { version: VERSION, items: [], settings: { ...DEFAULT_SETTINGS }, updatedAt: new Date().toISOString() }
}

export function loadState() {
  if (cache) return cache
  ensureDirs()
  const raw = readJson(ITEMS_FILE, null)
  const state = raw && typeof raw === 'object' ? raw : defaultState()
  state.version = VERSION
  state.items = Array.isArray(state.items) ? state.items.filter(isUsableItem) : []
  state.settings = { ...DEFAULT_SETTINGS, ...(state.settings && typeof state.settings === 'object' ? state.settings : {}) }
  const migrated = migrateWantTags(state)
  const topicized = migrateTopics(state)
  const aiMigrated = migrateAiStates(state)
  const pruned = pruneState(state)
  if (migrated || topicized || aiMigrated || pruned) saveState(state, true)
  cache = state
  return state
}

/**
 * 一次性迁移（2026-11-09，「想玩」tab 上线）：带「想玩」标签但还没归类的条目 → game / drama。
 * 老条目靠手动打标签表达「想玩」，启动时统一升级成正式 kind；跑过就打标记，不再重复。
 */
function migrateWantTags(state) {
  const flags = state.migrations && typeof state.migrations === 'object' ? state.migrations : {}
  if (flags.wantV1) return false
  const dramaRe = /(剧|番|动画|电影|第[0-9一二三四五六七八九十]+[集话期])/
  let changed = 0
  for (const item of state.items) {
    if (!item || !Array.isArray(item.tags)) continue
    const marked = item.tags.includes('想玩') || item.tags.includes('娱乐')
    if (!marked) continue
    if (item.kind === 'game' || item.kind === 'drama') continue
    let next = item.kind
    try {
      // 复用正式分类器：只接受它判成 game/drama 的结果，判不出来就保持原 kind
      const guess = heuristicExtract({ title: item.title || '', url: item.url || '', text: '' })
      if (guess && (guess.kind === 'game' || guess.kind === 'drama')) next = guess.kind
      else if (dramaRe.test(String(item.title || ''))) next = 'drama'
    } catch {
      next = item.kind
    }
    if (next === item.kind) continue
    item.kind = next
    item.updatedAt = new Date().toISOString()
    changed += 1
  }
  state.migrations = { ...flags, wantV1: new Date().toISOString() }
  return true
}

/**
 * 一次性分类迁移（2026-11-09）：给存量条目补上 tags[0] 分类。
 * 词表 + 人工判定表都在 topics.js；跑过一次就打标记，之后靠 normalizeItem 给新条目分类。
 */
function migrateTopics(state) {
  const flags = state.migrations && typeof state.migrations === 'object' ? state.migrations : {}
  if (flags.topicsV1) return false
  for (const item of state.items) {
    if (!item || item.status === 'archived') continue
    const current = Array.isArray(item.tags) ? item.tags : []
    const topic = topicTagOf(current) || topicOf({ ...item, tags: current })
    const next = withTopic(current, topic)
    if (next.join('|') === current.join('|')) continue
    item.tags = next
    item.updatedAt = new Date().toISOString()
  }
  state.migrations = { ...flags, topicsV1: new Date().toISOString() }
  return true
}

/**
 * 一次性迁移（2026-11-09「AI 整理」改版）：给没有 state 的存量条目补 state='none'。
 *
 * 老数据只有 ai.classified 一个布尔，而且启发式规则也会把它写成 true，
 * 所以它不能当「整理过」的证据；这里统一降级成 none，等新一轮整理重新判定。
 * 已归档条目也一起迁（主人要求全量整理）。
 */
function migrateAiStates(state) {
  const flags = state.migrations && typeof state.migrations === 'object' ? state.migrations : {}
  if (flags.aiStateV1) return false
  for (const item of state.items) {
    if (!item || typeof item !== 'object') continue
    item.ai = normalizeAi(item.ai, item.ai)
  }
  state.migrations = { ...flags, aiStateV1: new Date().toISOString() }
  return true
}

function isUsableItem(item) {
  return Boolean(item && typeof item === 'object' && typeof item.id === 'string' && item.id.startsWith('wl_'))
}

function pruneState(state, nowMs = Date.now()) {
  const days = Math.max(1, Math.min(3650, Number(state.settings.retentionDays) || 30))
  const cutoff = nowMs - days * 86400e3
  const before = state.items.length
  state.items = state.items.filter((item) => {
    if (item.status !== 'done') return true
    const at = Date.parse(item.readAt || item.updatedAt || item.createdAt || '')
    return Number.isFinite(at) ? at >= cutoff : true
  })
  if (state.items.length > MAX_ITEMS) {
    state.items.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    state.items = state.items.slice(state.items.length - MAX_ITEMS)
  }
  return state.items.length !== before
}

export function saveState(state, silent = false) {
  const next = state || loadState()
  next.updatedAt = new Date().toISOString()
  writeJsonAtomic(ITEMS_FILE, next)
  cache = next
  if (!silent) return next
  return next
}

export function getSettings() {
  return { ...loadState().settings }
}

/* -------------------------------------------------------------- ids/utils */

export function newId() {
  return 'wl_' + Date.now().toString(36) + '_' + randomBytes(3).toString('hex')
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

function cleanText(value, max) {
  if (typeof value !== 'string') return null
  const text = value.replace(/\r\n/g, '\n').trim()
  if (!text) return null
  return text.length > max ? text.slice(0, max) : text
}

function cleanIso(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const at = Date.parse(value)
  if (!Number.isFinite(at)) return null
  return new Date(at).toISOString()
}

export function dayKey(iso) {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return null
  // The user lives in Asia/Shanghai (UTC+8, no DST); a fixed offset keeps this pure.
  return new Date(at + 8 * 3600e3).toISOString().slice(0, 10)
}

function normalizeTags(tags) {
  const input = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(/[,，、;；\s]+/) : []
  const out = []
  for (const raw of input) {
    const tag = String(raw || '').trim().replace(/^#/, '').slice(0, 20)
    if (tag && !out.includes(tag)) out.push(tag)
    if (out.length >= 8) break
  }
  return out
}

/* ------------------------------------------------------------- ai 整理态 */

/**
 * 「AI 整理」状态机（2026-11-09 主人定的口径）：
 *   none    没整理过，或者旧版只打了分没补封面/标题
 *   partial 整理过但没达标（缺真封面 / 标题没清洗 / 缺摘要），还能再补一轮
 *   done    标题、摘要、真实封面、分类四项都齐了
 *   failed  这一轮彻底失败（抓取或模型挂了），lastError 里写原因
 *
 * `ai.classified` 是 v1 遗留布尔，只做兼容，不再作为「整理过」的判据。
 */
export const AI_STATES = ['none', 'partial', 'done', 'failed']
const AI_STATE_SET = new Set(AI_STATES)
const TOPIC_SET = new Set(TOPICS)
const AI_FIELD_SET = new Set(['title', 'summary', 'cover', 'kind', 'topic', 'tags', 'importance', 'urgency', 'durationMin'])

function normalizeAi(input, fallback = null) {
  const src = input && typeof input === 'object' ? input : {}
  const prev = fallback && typeof fallback === 'object' ? fallback : {}
  const pick = (key) => (key in src ? src[key] : prev[key])
  const state = AI_STATE_SET.has(pick('state')) ? pick('state') : 'none'
  const rawFields = Array.isArray(pick('fields')) ? pick('fields') : []
  const fields = []
  for (const field of rawFields) {
    const name = String(field || '').trim()
    if (AI_FIELD_SET.has(name) && !fields.includes(name)) fields.push(name)
  }
  const rawSuggest = pick('suggest')
  let suggest = null
  if (rawSuggest && typeof rawSuggest === 'object') {
    const kind = KINDS_SET.has(rawSuggest.kind) ? rawSuggest.kind : null
    const topic = TOPIC_SET.has(rawSuggest.topic) ? rawSuggest.topic : null
    if (kind || topic) suggest = { ...(kind ? { kind } : {}), ...(topic ? { topic } : {}) }
  }
  const rawPrev = pick('prev')
  let prevSnapshot = null
  if (rawPrev && typeof rawPrev === 'object') {
    const title = cleanText(rawPrev.title, 200)
    const kind = KINDS_SET.has(rawPrev.kind) ? rawPrev.kind : null
    const topic = TOPIC_SET.has(rawPrev.topic) ? rawPrev.topic : null
    if (title || kind || topic) {
      prevSnapshot = {
        ...(title ? { title } : {}),
        ...(kind ? { kind } : {}),
        ...(topic ? { topic } : {}),
      }
    }
  }
  const version = Number.isFinite(Number(pick('version'))) ? Math.max(0, Math.round(Number(pick('version')))) : null
  const confidence = Number.isFinite(Number(pick('confidence')))
    ? Math.max(0, Math.min(1, Number(pick('confidence'))))
    : null
  const rawMissing = Array.isArray(pick('missing')) ? pick('missing') : []
  const missing = rawMissing.map((key) => String(key || '')).filter((key) => ['title', 'summary', 'cover', 'topic'].includes(key))
  return {
    state,
    version,
    fields,
    classified: state !== 'none',
    reason: cleanText(pick('reason'), 400) || null,
    confidence,
    at: cleanIso(pick('at')) || null,
    lastError: cleanText(pick('lastError'), 300) || null,
    missing,
    suggest,
    prev: prevSnapshot,
  }
}

/** 给外部（api/工具）用的一份只读判定：这条还算不算「待整理」。 */
export function isUnorganized(ai) {
  const state = ai && ai.state
  return state !== 'done'
}

/* ---------------------------------------------------------- 失效标记 */

/** 失效原因 → 归一化。markInvalid 只认「已删除/不见了/404」这一类判定。 */
const DEAD_PATTERN = /已删除|页面不见了|笔记不存在|链接已失效|404|不存在或已删除|已下线/i
/**
 * 平台风控（小红书 sec_404 / 冷却中）不是「内容没了」——这类错误必须可重试，
 * 绝不能把条目挂进失效区（主人 2026-11-09：风控也要管入库与 AI 整理流程）。
 */
const RISK_CONTROL_PATTERN = /sec_404|sec_server|风控|300031|暂时无法浏览|冷却中/i

function normalizeInvalid(value) {
  if (!value || typeof value !== 'object') return null
  const reason = cleanText(value.reason, 200)
  const at = cleanIso(value.at)
  if (!reason && !at) return null
  return { reason: reason || '内容已失效', at: at || new Date().toISOString() }
}

/** 正文抓取返回「已删除」这类错误时，直接把条目挂到失效区。 */
export function markInvalid(id, reason) {
  return updateItem(id, { invalid: { reason: String(reason || '内容已失效').slice(0, 200), at: new Date().toISOString() } })
}

export function clearInvalid(id) {
  return updateItem(id, { invalid: null })
}

function autoTitle(url, text, kind) {
  if (url) {
    try {
      const parsed = new URL(url)
      const tail = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '')
      const label = KIND_META[kind]?.label || '链接'
      return tail ? label + ' · ' + tail.slice(0, 80) : label + ' · ' + parsed.hostname
    } catch {
      return url.slice(0, 120)
    }
  }
  if (text) {
    const line = text.split('\n').map((l) => l.trim()).find(Boolean)
    if (line) return line.slice(0, 120)
  }
  return '未命名内容'
}

/* -------------------------------------------------------------- normalize */

/**
 * Turn arbitrary input (HTTP body, agent tool item, inbox candidate, sync item)
 * into a complete Item. Never throws on malformed input.
 */
export function normalizeItem(input = {}, options = {}) {
  const source = input && typeof input === 'object' ? input : {}
  const url = typeof source.url === 'string' && /^https?:\/\//i.test(source.url.trim()) ? source.url.trim() : null
  const text = cleanText(source.text || source.raw, 20000) || null
  const detected = url ? classifyUrl(url) : { kind: null, site: null }
  const heuristic = heuristicExtract({ url, text, title: source.title })
  const kind = KINDS_SET.has(source.kind) ? source.kind : detected.kind || heuristic.kind || 'other'
  const deadlineInfo =
    cleanIso(source.deadline) !== null
      ? { deadline: cleanIso(source.deadline), deadlineKind: DEADLINE_KINDS.has(source.deadlineKind) ? source.deadlineKind : 'deadline' }
      : { deadline: heuristic.deadline || null, deadlineKind: DEADLINE_KINDS.has(heuristic.deadlineKind) ? heuristic.deadlineKind : heuristic.deadline ? 'deadline' : 'none' }
  const now = new Date().toISOString()
  const createdAt = cleanIso(source.createdAt) || now
  const aiSource = source.ai && typeof source.ai === 'object' ? source.ai : null
  const syncSource = source.sync && typeof source.sync === 'object' ? source.sync : null
  const explicitTitle = cleanText(source.title, 200)
  const heuristicTitle =
    typeof heuristic.title === 'string' && heuristic.title.trim() ? heuristic.title.trim() : null
  // A bare domain ("bilibili.com") is a useless title; fall back to the kind-aware one.
  const heuristicUsable =
    heuristicTitle && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(heuristicTitle) ? heuristicTitle : null
  // 分类：新条目入库时就定好 tags[0]，跟存量迁移（migrateTopics）走同一套规则。
  const baseTitle = explicitTitle || heuristicUsable || autoTitle(url, text, kind)
  const baseSummary = cleanText(source.summary, 800) || heuristic.summary || null
  const baseTags = normalizeTags(source.tags && source.tags.length ? source.tags : heuristic.tags)
  const topicTags = withTopic(
    baseTags,
    topicTagOf(baseTags) ||
      topicOf({ id: source.id, title: baseTitle, url, summary: baseSummary, tags: baseTags }) ||
      '待归档',
  )
  return {
    id: typeof source.id === 'string' && source.id.startsWith('wl_') ? source.id : newId(),
    kind,
    title: baseTitle,
    titleRaw: cleanText(source.titleRaw, 200) || null,
    url,
    summary: baseSummary,
    author: cleanText(source.author, 80) || null,
    site: cleanText(source.site, 40) || detected.site || heuristic.site || KIND_META[kind]?.label || null,
    cover: cleanText(source.cover, 2000) || null,
    agentStatus: ['new', 'opened', 'tried', 'skipped'].includes(source.agentStatus) ? source.agentStatus : null,
    agentName: cleanText(source.agentName, 80) || null,
    agentPurpose: cleanText(source.agentPurpose, 160) || null,
    agentCategory: ['prompt', 'plugin', 'skill'].includes(source.agentCategory) ? source.agentCategory : null,
    mediaClass: ['guide', 'list'].includes(source.mediaClass) ? source.mediaClass : null,
    images: Array.isArray(source.images)
      ? source.images.map((url) => cleanText(url, 2000)).filter(Boolean).slice(0, MAX_IMAGES)
      : [],
    raw: text,
    channel: CHANNELS.has(source.channel) ? source.channel : 'manual',
    tags: topicTags,
    status: STATUSES.has(source.status) ? source.status : 'inbox',
    importance: clampInt(source.importance, 1, 5, heuristic.importance ?? 3),
    urgency: clampInt(source.urgency, 1, 5, heuristic.urgency ?? 2),
    deadline: deadlineInfo.deadline,
    deadlineKind: deadlineInfo.deadline ? deadlineInfo.deadlineKind : 'none',
    durationMin: clampInt(source.durationMin, 1, 600, heuristic.durationMin ?? null),
    progress: source.progress === null || source.progress === undefined ? null : clampInt(source.progress, 0, 100, null),
    notes: cleanText(source.notes, 8000) || null,
    createdAt,
    updatedAt: now,
    readAt: cleanIso(source.readAt),
    archivedAt: cleanIso(source.archivedAt),
    snoozedUntil: cleanIso(source.snoozedUntil),
    ai: normalizeAi(aiSource),
    invalid: normalizeInvalid(source.invalid),
    content: source.content && typeof source.content === 'object' ? source.content : null,
    libraryPushedAt: cleanIso(source.libraryPushedAt),
    libraryItemId: cleanText(source.libraryItemId, 120) || null,
    sync: syncSource
      ? {
          provider: syncSource.provider === 'douyin' ? 'douyin' : 'bilibili',
          remoteId: String(syncSource.remoteId || ''),
          syncedAt: cleanIso(syncSource.syncedAt) || now,
          owner: cleanText(syncSource.owner, 80) || null,
          stats: syncSource.stats && typeof syncSource.stats === 'object' ? syncSource.stats : null,
        }
      : null,
    ...(options.extra || {}),
  }
}

/* ------------------------------------------------------------------- CRUD */

export function getItems() {
  return loadState().items
}

export function getItem(id) {
  return loadState().items.find((item) => item.id === id) || null
}

export function findByUrl(url) {
  if (!url) return null
  return loadState().items.find((item) => item.url === url) || null
}

export function findBySync(provider, remoteId) {
  if (!provider || !remoteId) return null
  return (
    loadState().items.find(
      (item) => item.sync && item.sync.provider === provider && item.sync.remoteId === String(remoteId),
    ) || null
  )
}

/** Add one item; same url or same sync identity returns the existing row. */
export function addItem(input, options = {}) {
  const state = loadState()
  const item = normalizeItem(input, options)
  if (options.dedupe !== false) {
    const existing = (item.url ? findByUrl(item.url) : null) || (item.sync ? findBySync(item.sync.provider, item.sync.remoteId) : null)
    if (existing) return { item: existing, duplicate: true, created: false }
  }
  state.items.push(item)
  saveState(state)
  return { item, duplicate: false, created: true }
}

export function addItems(inputs, options = {}) {
  const out = []
  for (const input of Array.isArray(inputs) ? inputs : []) {
    try {
      out.push(addItem(input, options))
    } catch {
      // one bad row must not abort the batch
    }
  }
  return out
}

const PATCH_FIELDS = [
  'title',
  'titleRaw',
  'url',
  'summary',
  'author',
  'site',
  'cover',
  'images',
  'agentStatus',
  'agentName',
  'agentPurpose',
  'agentCategory',
  'mediaClass',
  'kind',
  'tags',
  'importance',
  'urgency',
  'deadline',
  'deadlineKind',
  'durationMin',
  'progress',
  'notes',
  'status',
  'invalid',
  'snoozedUntil',
]

export function updateItem(id, patch = {}) {
  const state = loadState()
  const item = state.items.find((row) => row.id === id)
  if (!item) throw new Error('条目不存在')
  const now = new Date().toISOString()
  const source = patch && typeof patch === 'object' ? patch : {}
  for (const field of PATCH_FIELDS) {
    if (!(field in source)) continue
    const value = source[field]
    switch (field) {
      case 'title': {
        const nextTitle = cleanText(value, 200)
        if (nextTitle && nextTitle !== item.title) {
          // 第一次被改写时把原标题留档；之后 AI 再改不覆盖原始标题。
          if (!item.titleRaw) item.titleRaw = item.title || null
          item.title = nextTitle
        }
        break
      }
      case 'titleRaw':
        item.titleRaw = cleanText(value, 200) || null
        break
      case 'url':
        item.url = typeof value === 'string' && /^https?:\/\//i.test(value.trim()) ? value.trim() : null
        break
      case 'summary':
        item.summary = cleanText(value, 800)
        break
      case 'author':
        item.author = cleanText(value, 80)
        break
      case 'site':
        item.site = cleanText(value, 40) || item.site
        break
      case 'cover':
        item.cover = cleanText(value, 2000)
        break
      case 'images':
        item.images = Array.isArray(value)
          ? value.map((url) => cleanText(url, 2000)).filter(Boolean).slice(0, MAX_IMAGES)
          : []
        break
      case 'agentStatus':
        if (!['new', 'opened', 'tried', 'skipped'].includes(value)) {
          return { ok: false, error: 'agentStatus 只能是 new / opened / tried / skipped' }
        }
        item.agentStatus = value
        break
      case 'agentName':
        item.agentName = cleanText(value, 80) || null
        break
      case 'agentPurpose':
        item.agentPurpose = cleanText(value, 160) || null
        break
      case 'agentCategory':
        item.agentCategory = ['prompt', 'plugin', 'skill'].includes(value) ? value : null
        break
      case 'mediaClass':
        if (!['guide', 'list'].includes(value)) {
          return { ok: false, error: 'mediaClass 只能是 guide / list' }
        }
        item.mediaClass = value
        break
      case 'kind':
        if (KINDS_SET.has(value)) item.kind = value
        break
      case 'tags': {
        // 手动改标签时也要保住分类（tags[0]）：给了分类就用给的，没给就沿用原来的。
        const incoming = normalizeTags(value)
        const topic = topicTagOf(incoming) || topicTagOf(item.tags) || topicOf(item)
        item.tags = withTopic(incoming, topic)
        break
      }
      case 'importance':
        item.importance = clampInt(value, 1, 5, item.importance)
        break
      case 'urgency':
        item.urgency = clampInt(value, 1, 5, item.urgency)
        break
      case 'deadline': {
        const iso = cleanIso(value)
        item.deadline = iso
        if (!iso) item.deadlineKind = 'none'
        break
      }
      case 'deadlineKind':
        if (DEADLINE_KINDS.has(value)) item.deadlineKind = value
        break
      case 'durationMin':
        item.durationMin = value === null || value === undefined ? null : clampInt(value, 1, 600, item.durationMin)
        break
      case 'progress':
        item.progress = value === null || value === undefined ? null : clampInt(value, 0, 100, item.progress)
        break
      case 'notes':
        item.notes = cleanText(value, 8000)
        break
      case 'status':
        if (STATUSES.has(value)) {
          item.status = value
          if (value === 'done') item.readAt = now
          if (value === 'archived') item.archivedAt = now
          if (value === 'inbox' || value === 'queued' || value === 'doing') {
            if (item.status !== 'done') item.readAt = null
            item.archivedAt = null
          }
        }
        break
      case 'invalid':
        item.invalid = normalizeInvalid(value)
        break
      case 'snoozedUntil':
        item.snoozedUntil = cleanIso(value)
        break
      default:
        break
    }
  }
  if ('ai' in source && source.ai && typeof source.ai === 'object') {
    item.ai = normalizeAi(source.ai, item.ai)
  }
  if ('sync' in source) item.sync = source.sync ? { ...item.sync, ...source.sync } : item.sync
  item.updatedAt = now
  saveState(state)
  return item
}

export function deleteItem(id) {
  const state = loadState()
  const before = state.items.length
  state.items = state.items.filter((item) => item.id !== id)
  if (state.items.length === before) throw new Error('条目不存在')
  saveState(state)
  return true
}

export function touchSyncItem(id, patch) {
  const state = loadState()
  const item = state.items.find((row) => row.id === id)
  if (!item) return null
  Object.assign(item, patch, { updatedAt: new Date().toISOString() })
  saveState(state)
  return item
}

export function setSettings(patch = {}) {
  const state = loadState()
  const next = { ...state.settings }
  if ('autoAiOnSync' in patch) next.autoAiOnSync = Boolean(patch.autoAiOnSync)
  if ('inboxEnabled' in patch) next.inboxEnabled = Boolean(patch.inboxEnabled)
  if ('dedupeClusters' in patch) next.dedupeClusters = Boolean(patch.dedupeClusters)
  if ('retentionDays' in patch) next.retentionDays = clampInt(patch.retentionDays, 1, 3650, next.retentionDays)
  if ('invalidSweptAt' in patch) next.invalidSweptAt = cleanIso(patch.invalidSweptAt)
  state.settings = next
  saveState(state)
  return { ...next }
}

/** Remember that an image item was pushed into the design library. */
export function setLibraryPush(id, { libraryItemId } = {}) {
  const state = loadState()
  const item = state.items.find((row) => row.id === id)
  if (!item) return null
  item.libraryPushedAt = new Date().toISOString()
  item.libraryItemId = libraryItemId ? String(libraryItemId).slice(0, 120) : item.libraryItemId || null
  item.updatedAt = item.libraryPushedAt
  saveState(state)
  return item
}

/** Attach a list of media URLs (multiple originals) to one item. */
export function setItemImages(id, urls) {
  const state = loadState()
  const item = state.items.find((row) => row.id === id)
  if (!item) return null
  const list = []
  for (const url of Array.isArray(urls) ? urls : []) {
    const text = cleanText(url, 2000)
    if (text && !list.includes(text)) list.push(text)
    if (list.length >= 12) break
  }
  item.images = list
  const first = list[0]
  if (first && !item.cover) item.cover = first
  item.updatedAt = new Date().toISOString()
  saveState(state)
  return item
}

/* --------------------------------------------------- content / cluster cache */

export function setItemContent(id, content) {
  const state = loadState()
  const item = state.items.find((row) => row.id === id)
  if (!item) return null
  item.content = content && typeof content === 'object' ? content : null
  const contentError = content && typeof content === 'object' ? String(content.error || '') : ''
  if (contentError && RISK_CONTROL_PATTERN.test(contentError)) {
    // 被风控挡住：保留条目，并撤销之前可能被风控带偏的失效判定（真删了的下一轮会重新挂上）
    item.invalid = null
  } else if (contentError && DEAD_PATTERN.test(contentError)) {
    item.invalid = { reason: contentError.slice(0, 200), at: new Date().toISOString() }
  } else if (contentError === '' && content && Array.isArray(content.images) && content.images.length > 0 && item.invalid) {
    // 内容又抓到了，说明失效判定是误杀
    item.invalid = null
  }
  item.updatedAt = new Date().toISOString()
  saveState(state)
  return item
}

export function setClusterSummary(id, summary) {
  const state = loadState()
  const item = state.items.find((row) => row.id === id)
  if (!item) return null
  item.ai = { ...(item.ai || {}), clusterSummary: String(summary || '').slice(0, 1200) }
  item.updatedAt = new Date().toISOString()
  saveState(state)
  return item
}

/* --------------------------------------------------------------- secrets */

function readSecretsFile() {
  return readJson(SECRETS_FILE, { version: 1, cookies: {} }) || { version: 1, cookies: {} }
}

export function getCookie(provider) {
  const secrets = readSecretsFile()
  const value = secrets.cookies?.[provider]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function setCookie(provider, cookie) {
  const secrets = readSecretsFile()
  secrets.cookies = secrets.cookies && typeof secrets.cookies === 'object' ? secrets.cookies : {}
  const value = typeof cookie === 'string' ? cookie.trim() : ''
  if (value) secrets.cookies[provider] = value
  else delete secrets.cookies[provider]
  writeJsonAtomic(SECRETS_FILE, secrets, 0o600)
  return Boolean(value)
}

export function cookieStatus() {
  const secrets = readSecretsFile()
  return {
    bilibili: Boolean(secrets.cookies?.bilibili),
    douyin: Boolean(secrets.cookies?.douyin),
    xiaohongshu: Boolean(secrets.cookies?.xiaohongshu),
  }
}

/* ------------------------------------------------------------ sync state */

const DEFAULT_SYNC_STATE = {
  bilibili: { supported: true, account: null, lastSyncAt: null, lastResult: null, lastError: null },
  douyin: {
    supported: true,
    account: null,
    lastSyncAt: null,
    lastResult: null,
    lastError: null,
    note: '抖音网页端「稍后再看」需要登录 Cookie（至少含 sessionid）；把 douyin.com 登录后的完整 Cookie 粘进来即可同步，抓不到标题/封面时只入库链接。',
  },
}

export function getSyncState() {
  const raw = readJson(SYNC_STATE_FILE, null)
  const state = { ...DEFAULT_SYNC_STATE }
  for (const provider of ['bilibili', 'douyin']) {
    state[provider] = { ...DEFAULT_SYNC_STATE[provider], ...((raw && raw[provider]) || {}) }
  }
  return state
}

export function setSyncState(provider, patch = {}) {
  const state = getSyncState()
  if (state[provider]) state[provider] = { ...state[provider], ...patch }
  state.updatedAt = new Date().toISOString()
  writeJsonAtomic(SYNC_STATE_FILE, state, 0o600)
  return state
}

/* ----------------------------------------------------------------- media */

function mediaUrl(file) {
  return '/api/dsh-watch-later/media?f=' + encodeURIComponent(file)
}

function writeMedia(bytes, extension) {
  ensureDirs()
  const file = 'wl_' + Date.now().toString(36) + '_' + randomBytes(4).toString('hex') + extension
  writeFileSync(join(MEDIA_DIR, file), bytes, { mode: 0o600 })
  return { file, url: mediaUrl(file) }
}

export function saveMediaDataUrl(dataUrl, name) {
  if (typeof dataUrl !== 'string') throw new Error('图片数据缺失')
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl.trim())
  if (!match) throw new Error('只支持 png/jpeg/webp/gif 的 base64 图片')
  const bytes = Buffer.from(match[2].replace(/\s+/g, ''), 'base64')
  if (!bytes.length) throw new Error('图片内容为空')
  if (bytes.length > MAX_MEDIA_BYTES) throw new Error('图片超过 8MB')
  const ext = MEDIA_TYPES[match[1]] || '.png'
  return { ...writeMedia(bytes, ext), name: cleanText(name, 120) || null, bytes: bytes.length }
}

/** Save raw image bytes (share jobs, clipboard images) as a local cover. */
export function saveMediaBytes(bytes, extension) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error('图片内容为空')
  if (bytes.length > MAX_MEDIA_BYTES) throw new Error('图片超过 8MB')
  const ext = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(String(extension).toLowerCase())
    ? String(extension).toLowerCase()
    : '.png'
  return { ...writeMedia(bytes, ext), bytes: bytes.length }
}

export function saveMediaFile(sourcePath) {
  ensureDirs()
  if (!existsSync(sourcePath)) throw new Error('文件不存在')
  const stat = statSync(sourcePath)
  if (!stat.isFile()) throw new Error('不是文件')
  if (stat.size > MAX_MEDIA_BYTES) throw new Error('图片超过 8MB')
  const ext = ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extname(sourcePath).toLowerCase())
    ? extname(sourcePath).toLowerCase()
    : '.png'
  const file = 'wl_' + Date.now().toString(36) + '_' + randomBytes(4).toString('hex') + ext
  copyFileSync(sourcePath, join(MEDIA_DIR, file))
  return { file, url: mediaUrl(file), name: basename(sourcePath), bytes: stat.size }
}

export function resolveMediaPath(filename) {
  const name = String(filename || '')
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes('..')) return null
  const path = join(MEDIA_DIR, name)
  if (!existsSync(path)) return null
  const stat = statSync(path)
  if (!stat.isFile()) return null
  return { path, size: stat.size, ext: extname(name).toLowerCase() }
}

export function listInboxFiles() {
  ensureDirs()
  try {
    return readdirSync(INBOX_DIR)
      .filter((name) => !name.startsWith('.'))
      .map((name) => join(INBOX_DIR, name))
      .filter((path) => {
        try {
          return statSync(path).isFile()
        } catch {
          return false
        }
      })
  } catch {
    return []
  }
}

export function archiveInboxFile(path) {
  try {
    const target = join(INBOX_DONE_DIR, Date.now().toString(36) + '-' + basename(path))
    renameSync(path, target)
    return target
  } catch {
    return null
  }
}

/* -------------------------------------------------------------- snapshot */

function countDerived(views) {
  const counts = {
    total: views.length,
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
  for (const view of views) {
    // AI 整理口径：覆盖全部条目（含已完成/已归档），pending = 还需要再整理一轮
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
    if (view.status === 'done') counts.done += 1
    else if (view.status === 'archived') counts.archived += 1
    const isActive = view.status === 'inbox' || view.status === 'queued' || view.status === 'doing'
    if (!isActive) continue
    counts.active += 1
    if (view.status === 'inbox') counts.inbox += 1
    if (view.triage in counts && typeof counts[view.triage] === 'number') counts[view.triage] += 1
    if (view.hasTimeSensitivity) counts.timeSensitive += 1
    counts.byKind[view.kind] = (counts.byKind[view.kind] || 0) + 1
  }
  return counts
}

function sortViews(views) {
  return views.slice().sort((a, b) => {
    const rank = (TRIAGE_RANK[a.triage] ?? 9) - (TRIAGE_RANK[b.triage] ?? 9)
    if (rank !== 0) return rank
    const aDead = a.deadline ? Date.parse(a.deadline) : null
    const bDead = b.deadline ? Date.parse(b.deadline) : null
    if (aDead !== null && bDead !== null && aDead !== bDead) return aDead - bDead
    if (aDead !== null && bDead === null) return -1
    if (aDead === null && bDead !== null) return 1
    if (b.score !== a.score) return b.score - a.score
    return String(b.createdAt).localeCompare(String(a.createdAt))
  })
}

function computeTotals(views, nowMs) {
  const today = dayKey(new Date(nowMs).toISOString())
  let addedToday = 0
  let doneToday = 0
  let readMinutes = 0
  for (const view of views) {
    if (dayKey(view.createdAt) === today) addedToday += 1
    if (view.status === 'done' && dayKey(view.readAt || view.updatedAt) === today) {
      doneToday += 1
      readMinutes += Number(view.durationMin) || 0
    }
  }
  return { addedToday, doneToday, readMinutes }
}

/**
 * Build the complete read model the Client renders, plus sync status.
 * `extras.ai` / `extras.sync` let the route layer inject live status.
 */
export function buildSnapshot(options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now()
  const state = loadState()

  // ItemView must not carry the whole article body; the reader fetches it on demand.
  const views = state.items.map((item) => {
    const view = deriveItem(item, nowMs)
    const cached = item.content && typeof item.content === 'object' ? item.content : null
    delete view.content
    view.hasContent = Boolean(cached)
    view.contentType = cached?.type || null
    view.agent = agentInfo(item)
    view.media = mediaInfo(item)
    return view
  })

  let clusterByMember = new Map()
  let hiddenIds = new Set()
  if (state.settings.dedupeClusters !== false) {
    try {
      const clusters = buildClusters(views)
      const titleById = new Map(views.map((view) => [view.id, view.title]))
      for (const group of clusters.groups || []) {
        const info = {
          id: group.id,
          size: group.size,
          memberIds: group.memberIds,
          titles: group.memberIds.map((id) => titleById.get(id) || '').filter(Boolean).slice(0, 8),
        }
        for (const id of group.memberIds) clusterByMember.set(id, info)
        for (const id of group.memberIds) {
          if (id !== group.representativeId) hiddenIds.add(id)
        }
      }
    } catch {
      clusterByMember = new Map()
      hiddenIds = new Set()
    }
  }

  // 失效条目（笔记被删 / 链接挂了）单独一区，不混进今日/收件箱/资料库
  const invalidViews = views
    .filter((view) => view.invalid && typeof view.invalid === 'object')
    .sort((a, b) => String(b.invalid.at || '').localeCompare(String(a.invalid.at || '')))
  const visible = views.filter((view) => !hiddenIds.has(view.id) && !(view.invalid && typeof view.invalid === 'object'))
  const active = visible.filter((view) => view.status === 'inbox' || view.status === 'queued' || view.status === 'doing')
  const doneRecent = visible.filter((view) => {
    if (view.status !== 'done') return false
    const at = Date.parse(view.readAt || view.updatedAt)
    return Number.isFinite(at) && nowMs - at < 7 * 86400e3
  })

  const withCluster = (view) => {
    const info = clusterByMember.get(view.id)
    return info ? { ...view, cluster: info } : view.cluster ? { ...view, cluster: null } : view
  }
  const items = sortViews([...active, ...doneRecent].map(withCluster))

  const todayFocus = active
    .filter((view) => view.triage === 'now' || view.triage === 'today')
    .sort((a, b) => {
      const aDead = a.deadline ? Date.parse(a.deadline) : Number.POSITIVE_INFINITY
      const bDead = b.deadline ? Date.parse(b.deadline) : Number.POSITIVE_INFINITY
      if (aDead !== bDead) return aDead - bDead
      return b.score - a.score
    })
    .slice(0, 4)
    .map(withCluster)

  const expiring = active
    .filter((view) => view.timeSensitivity.level === 'critical' || view.timeSensitivity.level === 'soon')
    .sort((a, b) => Date.parse(a.deadline || 0) - Date.parse(b.deadline || 0))
    .slice(0, 8)
    .map(withCluster)

  const settings = { ...state.settings }
  const cookie = options.cookieStatus || cookieStatus()
  const syncState = options.syncState || getSyncState()
  const ai = options.ai || { available: Boolean(options.aiAvailable), model: options.aiModel || null }
  const sync = {
    bilibili: {
      ...syncState.bilibili,
      configured: cookie.bilibili,
      connected: syncState.bilibili.account ? true : null,
      supported: true,
    },
    douyin: {
      ...syncState.douyin,
      configured: cookie.douyin,
      connected: syncState.douyin.account ? true : null,
      supported: Boolean(syncState.douyin.supported),
      note: DEFAULT_SYNC_STATE.douyin.note,
    },
  }
  const counts = countDerived(visible)
  counts.total = views.length
  counts.invalid = invalidViews.length
  counts.duplicates = hiddenIds.size
  const accounts = {
    bilibili: { configured: Boolean(cookie.bilibili), account: syncState.bilibili.account || null },
    douyin: { configured: Boolean(cookie.douyin), account: syncState.douyin.account || null },
    xiaohongshu: { configured: Boolean(cookie.xiaohongshu), account: null },
  }
  return {
    invalidItems: invalidViews,
    accounts,
    generatedAt: new Date(nowMs).toISOString(),
    counts,
    totals: computeTotals(views, nowMs),
    todayFocus,
    expiring,
    items,
    settings: {
      ...settings,
      dataDir: DATA_DIR,
      inboxDir: INBOX_DIR,
      aiAvailable: Boolean(ai.available),
      aiModel: ai.model || null,
    },
    sync,
    inbox: { pendingFiles: listInboxFiles().length },
  }
}

export function exportAll() {
  const state = loadState()
  return { exportedAt: new Date().toISOString(), version: VERSION, settings: state.settings, items: state.items }
}

export function stats() {
  const state = loadState()
  return { items: state.items.length, dataDir: DATA_DIR, updatedAt: state.updatedAt }
}

// 分类迁移（2026-11-09）
