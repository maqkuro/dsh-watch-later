/**
 * Similar-content clustering engine for the DSH watch-later center.
 *
 * CONTRACT §13.2:
 *   buildClusters(items) -> { groups: [{ id, memberIds, representativeId, size }], hiddenIds }
 *
 * Design notes
 * ------------
 * - Pure module: no I/O, no timers, no third-party dependencies and deliberately
 *   no import of score.js, so it can be exercised by `node --test` on its own.
 *   When an item's pre-computed `score` is absent the representative pick falls
 *   back to a local estimate from importance/urgency.
 * - The public threshold is and stays **0.55**: two items whose `itemSimilarity`
 *   reaches 0.55 are considered the same topic and merged with union-find.
 * - `titleSimilarity` keeps the contract's core metric — character-bigram
 *   Jaccard over the normalized title — but blends in three cheap,
 *   dependency-free signals so that Chinese headlines about the same event
 *   phrased differently ("深度｜OpenAI 发布 GPT-5，能力大幅提升" vs
 *   "OpenAI GPT-5 正式发布：能力全面提升") land above the threshold while
 *   unrelated titles stay far below:
 *     - containment of the smaller bigram set in the larger one (one title is a
 *       shorter / extended variant of the other, common for wechat reposts);
 *     - CJK-unigram containment (paraphrases insert/remove filler characters and
 *       bigrams become brittle quickly on short Chinese titles);
 *     - latin-token agreement (GPT / OpenAI / Dota2 …), which acts as an entity
 *       anchor for tech headlines.
 *   The blend is monotonic with the bigram Jaccard and never exceeds 1.
 * - A tiny version-signature guard keeps near-identical normalized titles about
 *   *different editions* apart (iPhone 17 vs 16, GPT-5 vs GPT-4, 第1季 vs 第2季,
 *   2024 vs 2025 recaps): normalizeTitle removes digits as the contract asks, so
 *   without the guard those titles would normalize to the same string.
 *
 * Performance: titles are prepared (normalized, tokenized) once per item; the
 * pairwise pass then only intersects small Sets. Watch-later holds at most a few
 * thousand items and clustering only sees active content kinds, so the O(n²)
 * pass stays cheap in practice.
 */

/** CONTRACT §13.2: itemSimilarity >= SIMILARITY_THRESHOLD triggers a merge. */
const SIMILARITY_THRESHOLD = 0.55

/** Only these kinds carry link/article content worth de-duplicating. */
const CLUSTERABLE_KINDS = new Set(['article', 'wechat', 'link', 'xhs', 'video', 'bilibili'])

/** Items in a terminal state never participate (they are already handled). */
const INACTIVE_STATUSES = new Set(['done', 'archived'])

/** Representative affinity: wechat/article beat other kinds on near ties. */
const PREFERRED_REP_KINDS = new Set(['wechat', 'article'])

/** Scores closer than this are treated as a tie when picking a representative. */
const REP_SCORE_TIE = 3

/** Defensive cap: titles longer than this are truncated before parsing. */
const MAX_TITLE_CHARS = 400

/** Sanity cap on the number of version markers per title. */
const MAX_VERSION_TOKENS = 12

/* ------------------------------------------------------------------ *
 * normalizeTitle
 * ------------------------------------------------------------------ */

// Leading labels that carry no topical information: 「深度｜…」「干货：…」.
// Ordered longest-first so compound labels win over their prefix.
const LEADING_LABELS = [
  '深度解读',
  '深度解析',
  '深度分析',
  '干货分享',
  '独家首发',
  '深夜更新',
  '深度',
  '干货',
  '收藏',
  '推荐',
  '分享',
  '独家',
  '重磅',
  '首发',
  '必看',
  '原创',
  '资讯',
  '快讯',
  '热点',
  '盘点',
  '评测',
  '测评',
  '教程',
  '复盘',
  '转需',
  '提醒',
  '注意',
  '公告',
  '通知',
  '更新',
  '解析',
  '解读',
  '揭秘',
  '实测',
  '最新',
  '安利',
  '种草',
  '避雷',
]

// Trailing labels: 「…（完整版）」「… 建议收藏」.
const TRAILING_LABELS = [
  '完整视频',
  '完整版',
  '高清版',
  '文字版',
  '精华版',
  '建议收藏',
  '值得一看',
  '持续更新',
  '不定期更新',
  '附下载',
  '附链接',
  '附资源',
  '更新中',
  '全文',
  '原文',
  '速看',
  '收藏',
]

// Labels that may appear inside a leading bracket: 「【收藏】…」.
const BRACKET_LABELS = new Set([
  ...LEADING_LABELS,
  ...TRAILING_LABELS,
  '转载',
  '广告',
  '推广',
  '福利',
  '资源',
  '视频',
  '图文',
  '深度',
  '干货',
  '收藏',
  '推荐',
  '分享',
  '首发',
  '独家',
  '重磅',
  '必看',
  '原创',
  '最新',
  '速看',
  '提醒',
  '注意',
  '公告',
  '更新',
  '通知',
  '盘点',
  '实测',
  '测评',
  '解析',
  '解读',
  '搬运',
])

// A leading bracketed label: 【收藏】, [干货], (独家) …
const LEADING_BRACKET_RE = /^[【\[({〔]\s*([^】\]})〕]{1,20}?)\s*[】\]})〕]/u

const PUNCT_OR_SPACE_RE = /[\p{P}\p{S}\p{Z}\s]+/gu
const EDGE_PUNCT_START_RE = /^[\p{P}\p{S}\p{Z}\s]+/u
const EDGE_PUNCT_END_RE = /[\p{P}\p{S}\p{Z}\s]+$/u
const SEPARATOR_RE = /[\p{P}\p{S}\p{Z}\s]/u

// Year tokens are removed whole, including the common 「年」 suffix.
const YEAR_RE = /(?:19|20)\d{2}\s*年?/g
const DIGITS_RE = /[\d０-９]+/g

function isSeparator(ch) {
  return ch === undefined || SEPARATOR_RE.test(ch)
}

function softTrimEdges(value) {
  return value.replace(EDGE_PUNCT_START_RE, '').replace(EDGE_PUNCT_END_RE, '')
}

/**
 * One pass of label / bracket / edge-punctuation stripping.
 * Multi-character labels are unambiguous prefixes, so they are stripped even
 * without a separator; short labels (深度 / 推荐 / 解析 / 分享 …) are only
 * stripped when followed by a separator, which keeps real topics intact
 * ("深度学习", "推荐系统", "解析几何", "分享经济").
 */
function stripAffixesOnce(input) {
  let out = input

  const bracket = out.match(LEADING_BRACKET_RE)
  if (bracket) {
    const innerRaw = bracket[1].trim().toLowerCase()
    const innerCompact = innerRaw.replace(PUNCT_OR_SPACE_RE, '')
    if (BRACKET_LABELS.has(innerRaw) || BRACKET_LABELS.has(innerCompact)) {
      out = out.slice(bracket[0].length)
    }
  }

  for (const label of LEADING_LABELS) {
    if (out.length <= label.length || !out.startsWith(label)) continue
    if (label.length >= 3 || isSeparator(out[label.length])) {
      out = out.slice(label.length)
      break
    }
  }

  for (const label of TRAILING_LABELS) {
    if (out.length <= label.length || !out.endsWith(label)) continue
    if (label.length >= 3 || isSeparator(out[out.length - label.length - 1])) {
      out = out.slice(0, -label.length)
      break
    }
  }

  return softTrimEdges(out)
}

function cleanAffixes(input) {
  let out = input
  for (let i = 0; i < 8; i += 1) {
    const next = stripAffixesOnce(out)
    if (next === out || next.length === 0) break
    out = next
  }
  return out
}

/**
 * Normalize a title for similarity: lowercase, drop a leading editorial label
 * bracket, years, numbers, punctuation and whitespace, plus a final sweep over
 * trailing decoration ("完整版", "建议收藏" …).
 *
 * Returns '' for non-string / blank input instead of throwing.
 *
 * @param {unknown} title
 * @returns {string}
 */
export function normalizeTitle(title) {
  if (typeof title !== 'string') return ''
  let text = title.slice(0, MAX_TITLE_CHARS)
  try {
    text = text.normalize('NFKC')
  } catch {
    // ignore exotic unicode that NFKC rejects
  }
  text = text.toLowerCase()
  text = cleanAffixes(text)
  text = text.replace(YEAR_RE, ' ')
  text = text.replace(DIGITS_RE, ' ')
  text = text.replace(PUNCT_OR_SPACE_RE, '')
  text = cleanAffixes(text)
  return text
}

/* ------------------------------------------------------------------ *
 * Title signals (prepared once per title)
 * ------------------------------------------------------------------ */

function bigramSet(text) {
  const set = new Set()
  if (!text) return set
  if (text.length === 1) {
    set.add(text)
    return set
  }
  for (let i = 0; i + 1 < text.length; i += 1) set.add(text.slice(i, i + 2))
  return set
}

const CJK_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u

function cjkCharSet(text) {
  const set = new Set()
  for (const ch of text) if (CJK_CHAR_RE.test(ch)) set.add(ch)
  return set
}

const LATIN_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'you', 'your', 'are',
  'was', 'were', 'has', 'have', 'had', 'not', 'but', 'all', 'can', 'will',
  'its', 'our', 'his', 'her', 'their', 'how', 'what', 'why', 'who', 'when',
  'where', 'which', 'vs', 'via', 'amp', 'http', 'https', 'www', 'com', 'org',
  'net', 'html', 'htm', 'pdf', 'jpg', 'png', 'mp4',
])

/**
 * Latin tokens are extracted from the *raw* title (before CJK/space compaction)
 * so that "OpenAI GPT-5" yields ["openai", "gpt"] instead of one merged token.
 */
function latinTokenSet(raw) {
  const set = new Set()
  const matches = raw.match(/[a-z]{2,}/g)
  if (!matches) return set
  for (const token of matches) {
    if (token.length < 2 || LATIN_STOPWORDS.has(token)) continue
    set.add(token)
  }
  return set
}

const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

function parseCnNumber(input) {
  const text = String(input || '').trim()
  if (!text) return null
  if (/^\d+$/.test(text)) return Number(text)
  if (text === '十') return 10
  if (text.length === 1) return Object.prototype.hasOwnProperty.call(CN_DIGITS, text) ? CN_DIGITS[text] : null
  if (text.includes('十')) {
    const [tensPart, onesPart] = text.split('十')
    const tens = tensPart === '' ? 1 : CN_DIGITS[tensPart]
    const ones = onesPart === '' ? 0 : CN_DIGITS[onesPart]
    if (tens === undefined || ones === undefined) return null
    return tens * 10 + ones
  }
  return null
}

function canonicalNumber(input) {
  const text = String(input)
  if (text.includes('.')) {
    const trimmed = text.replace(/0+$/, '').replace(/\.$/, '')
    return trimmed || '0'
  }
  const num = Number(text)
  return Number.isFinite(num) ? String(num) : text
}

const EPISODE_BASES = new Set(['p', 'ep', 'e', 'pt', 'part', 'episode'])
const SEASON_BASES = new Set(['s', 'season'])
const CN_ORDINAL_UNITS = { 季: 's', 期: 'ep', 集: 'ep', 话: 'ep', 章: 'ep', 部: 'ep' }
// CJK-attached model numbers such as 沙丘3 / 原神4.0. Numbers followed by a
// unit (3天 / 2小时 / 第1集 / 2027年) are not edition markers.
const CJK_VERSION_RE =
  /([\u3400-\u9fff]{1,12})[\s]*(\d+(?:\.\d+)?)(?![\s]*[年月日时分秒个条位次岁元%％天周期集话章部季])/g
const LATIN_VERSION_RE = /([a-z]{1,12})[\s\-_.]*(\d+(?:\.\d+)?)/g

// Version markers are stored as "base\0value" so that two markers that name
// the same thing (gpt\0 5 vs gpt\0 5) can be told apart from two markers of the
// same family with different editions (gpt\0 5 vs gpt\0 4).
function versionToken(base, value) {
  return base + '\u0000' + value
}

/**
 * Extract edition/version markers used to keep different editions apart.
 * Examples: GPT-5 -> gpt\0 5; 第2季 -> s\0 2; P1 -> ep\0 1; 2024 -> y\0 2024;
 * 《沙丘3》 -> 沙丘\0 3; "7.35 版本" -> v\0 7.35. Returns a Set of tokens.
 */
function versionTokenSet(raw) {
  const set = new Set()
  if (!raw) return set

  for (const match of raw.matchAll(/(?:19|20)\d{2}/g)) {
    set.add(versionToken('y', match[0]))
    if (set.size >= MAX_VERSION_TOKENS) return set
  }

  for (const match of raw.matchAll(/第\s*([0-9零一二三四五六七八九十两]{1,3})\s*([季期集话章部])/g)) {
    const num = parseCnNumber(match[1])
    const unit = CN_ORDINAL_UNITS[match[2]]
    if (num === null || !unit) continue
    set.add(versionToken(unit, num))
    if (set.size >= MAX_VERSION_TOKENS) return set
  }

  // "7.35 版本" / "4.0 版" — patch notes for different versions are different
  // stories even though normalizeTitle strips the numbers.
  for (const match of raw.matchAll(/(\d+(?:\.\d+)+)\s*(?:版本|版)/g)) {
    set.add(versionToken('v', canonicalNumber(match[1])))
    if (set.size >= MAX_VERSION_TOKENS) return set
  }

  for (const match of raw.matchAll(LATIN_VERSION_RE)) {
    const base = match[1]
    const number = canonicalNumber(match[2])
    if (EPISODE_BASES.has(base)) set.add(versionToken('ep', number))
    else if (SEASON_BASES.has(base)) set.add(versionToken('s', number))
    else set.add(versionToken(base, number))
    if (set.size >= MAX_VERSION_TOKENS) return set
  }

  for (const match of raw.matchAll(CJK_VERSION_RE)) {
    set.add(versionToken(match[1], canonicalNumber(match[2])))
    if (set.size >= MAX_VERSION_TOKENS) return set
  }

  return set
}

function prepareTitle(title) {
  let raw = ''
  if (typeof title === 'string') {
    raw = title.slice(0, MAX_TITLE_CHARS)
  }
  let normalized = ''
  try {
    normalized = normalizeTitle(raw)
  } catch {
    normalized = ''
  }
  // Latin tokens + version markers need original casing/punctuation boundaries.
  let latinRaw = raw
  try {
    latinRaw = raw.normalize('NFKC').toLowerCase()
  } catch {
    latinRaw = raw.toLowerCase()
  }
  return {
    norm: normalized,
    bigrams: bigramSet(normalized),
    cjk: cjkCharSet(normalized),
    latin: latinTokenSet(latinRaw),
    versions: versionTokenSet(latinRaw),
  }
}

function intersectionSize(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let count = 0
  for (const value of small) if (large.has(value)) count += 1
  return count
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * Two titles are about different editions when both carry version markers and
 * (a) a marker family appears on both sides with different values
 *     (gpt 5 vs gpt 4, 第1季 vs 第2季, 2024 vs 2025, v 7.35 vs v 7.34), or
 * (b) they share no marker at all (different franchises: 沙丘3 vs 原神4).
 * One-sided markers are not a conflict: "OpenAI 发布 GPT-5" vs "GPT-5 深度解读"
 * is still the same story. Marker families that agree on value do not conflict
 * even when split into several tokens (dota 2 + v 7.35 on both sides).
 */
function hasVersionConflict(a, b) {
  const first = a.versions
  const second = b.versions
  if (first.size === 0 || second.size === 0) return false

  let sharedExact = false
  const valuesByBase = new Map()
  for (const token of second) {
    const separator = token.indexOf('\u0000')
    const base = token.slice(0, separator)
    const value = token.slice(separator + 1)
    if (!valuesByBase.has(base)) valuesByBase.set(base, new Set())
    valuesByBase.get(base).add(value)
  }

  for (const token of first) {
    if (second.has(token)) sharedExact = true
    const separator = token.indexOf('\u0000')
    const base = token.slice(0, separator)
    const value = token.slice(separator + 1)
    const values = valuesByBase.get(base)
    if (!values) continue
    for (const otherValue of values) if (otherValue !== value) return true
  }

  return !sharedExact
}

const VERSION_CONFLICT_TITLE_CAP = 0.45
const VERSION_CONFLICT_SIMILARITY_CAP = 0.5

function similarityOfPrepared(a, b) {
  if (!a.norm || !b.norm) return 0

  let similarity
  if (a.norm === b.norm) {
    similarity = 1
  } else {
    const bigramInter = intersectionSize(a.bigrams, b.bigrams)
    const bigramUnion = a.bigrams.size + b.bigrams.size - bigramInter
    const bigramJaccard = bigramUnion > 0 ? bigramInter / bigramUnion : 0
    const bigramContainment =
      Math.min(a.bigrams.size, b.bigrams.size) > 0
        ? bigramInter / Math.min(a.bigrams.size, b.bigrams.size)
        : 0

    const cjkInter = intersectionSize(a.cjk, b.cjk)
    const cjkMin = Math.min(a.cjk.size, b.cjk.size)
    // Bigram containment is already a decent signal; unigram containment helps
    // paraphrases but is noisy on very short CJK fragments, hence the size gate.
    const cjkContainment = cjkMin >= 3 ? cjkInter / cjkMin : 0

    if (a.latin.size > 0 && b.latin.size > 0) {
      const latinInter = intersectionSize(a.latin, b.latin)
      const entity = latinInter > 0 ? latinInter / Math.min(a.latin.size, b.latin.size) : 0
      similarity = 0.4 * bigramJaccard + 0.2 * bigramContainment + 0.15 * cjkContainment + 0.25 * entity
    } else {
      similarity = 0.5 * bigramJaccard + 0.15 * bigramContainment + 0.35 * cjkContainment
    }
  }

  if (hasVersionConflict(a, b)) {
    similarity = Math.min(similarity, VERSION_CONFLICT_TITLE_CAP)
  }
  return clamp01(similarity)
}

/**
 * Character-bigram similarity of two titles in [0, 1].
 *
 * The core is the contract's bigram Jaccard over the normalized titles, blended
 * with containment / entity agreement so that Chinese paraphrases of one story
 * score high. Empty titles return 0; different editions of the same product are
 * kept apart by the internal version guard.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number}
 */
export function titleSimilarity(a, b) {
  return similarityOfPrepared(prepareTitle(a), prepareTitle(b))
}

/* ------------------------------------------------------------------ *
 * itemSimilarity
 * ------------------------------------------------------------------ */

function normalizeSite(site) {
  return typeof site === 'string' ? site.trim().toLowerCase() : ''
}

function tagSetOf(tags) {
  const set = new Set()
  if (!Array.isArray(tags)) return set
  for (const tag of tags) {
    if (typeof tag !== 'string') continue
    const value = tag.trim().toLowerCase()
    if (value) set.add(value)
  }
  return set
}

/**
 * Similarity of two items in [0, 1] (CONTRACT §13.2):
 * normalized-title similarity + 0.1 for the same site + 0.05 per shared tag.
 *
 * The version guard caps the result when both titles name different editions
 * (so site/tag bonuses cannot merge iPhone 17 with iPhone 16).
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number}
 */
export function itemSimilarity(a, b) {
  const left = a && typeof a === 'object' ? a : {}
  const right = b && typeof b === 'object' ? b : {}

  const pa = prepareTitle(left.title)
  const pb = prepareTitle(right.title)

  let similarity = similarityOfPrepared(pa, pb)

  const siteA = normalizeSite(left.site)
  const siteB = normalizeSite(right.site)
  if (siteA && siteA === siteB) similarity += 0.1

  const tagsA = tagSetOf(left.tags)
  const tagsB = tagSetOf(right.tags)
  const sharedTags = intersectionSize(tagsA, tagsB)
  if (sharedTags > 0) similarity += 0.05 * sharedTags

  if (hasVersionConflict(pa, pb)) {
    similarity = Math.min(similarity, VERSION_CONFLICT_SIMILARITY_CAP)
  }

  return clamp01(similarity)
}

/* ------------------------------------------------------------------ *
 * pickRepresentative
 * ------------------------------------------------------------------ */

function clampRating(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return 3
  return Math.min(5, Math.max(1, num))
}

/** Score used for representative picking: prefer a real score, else estimate. */
function representativeScore(member) {
  const item = member && typeof member === 'object' ? member : {}
  const explicit = Number(item.score)
  if (Number.isFinite(explicit)) return Math.min(100, Math.max(0, explicit))
  const importance = clampRating(item.importance)
  const urgency = clampRating(item.urgency)
  return Math.round((0.55 * importance + 0.45 * urgency) * 20)
}

function createdAtMs(member) {
  const item = member && typeof member === 'object' ? member : {}
  const raw = item.createdAt
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function kindRepRank(member) {
  const item = member && typeof member === 'object' ? member : {}
  const kind = typeof item.kind === 'string' ? item.kind.trim().toLowerCase() : ''
  return PREFERRED_REP_KINDS.has(kind) ? 0 : 1
}

function compareIds(a, b) {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * Pick the representative member id of a cluster (CONTRACT §13.2):
 * highest composite score; when scores are within 3 points, prefer
 * kind wechat/article, then the newest createdAt, then the higher score,
 * then the smaller id (deterministic).
 *
 * @param {unknown[]} members item-like objects
 * @returns {string} member id, or '' when no member has a usable id
 */
export function pickRepresentative(members) {
  const list = Array.isArray(members) ? members : []
  const candidates = []
  for (const member of list) {
    if (!member || typeof member !== 'object') continue
    const id = typeof member.id === 'string' ? member.id.trim() : ''
    if (!id) continue
    candidates.push({
      id,
      score: representativeScore(member),
      kindRank: kindRepRank(member),
      created: createdAtMs(member),
    })
  }
  if (candidates.length === 0) return ''

  let best = candidates[0].score
  for (const candidate of candidates) if (candidate.score > best) best = candidate.score

  const close = candidates.filter((candidate) => best - candidate.score < REP_SCORE_TIE)
  close.sort((a, b) => {
    if (a.kindRank !== b.kindRank) return a.kindRank - b.kindRank
    if (a.created !== b.created) return b.created - a.created
    if (a.score !== b.score) return b.score - a.score
    return compareIds(a.id, b.id)
  })
  return close[0].id
}

/* ------------------------------------------------------------------ *
 * buildClusters
 * ------------------------------------------------------------------ */

function isClusterable(item) {
  if (!item || typeof item !== 'object') return false
  const id = typeof item.id === 'string' ? item.id.trim() : ''
  if (!id) return false
  const kind = typeof item.kind === 'string' ? item.kind.trim().toLowerCase() : ''
  if (!CLUSTERABLE_KINDS.has(kind)) return false
  if (typeof item.url !== 'string' || !item.url.trim()) return false
  const status = typeof item.status === 'string' ? item.status.trim().toLowerCase() : ''
  return !INACTIVE_STATUSES.has(status)
}

/** Pairwise decision shared by buildClusters (same formula as itemSimilarity). */
function candidateSimilarity(left, right) {
  let similarity = similarityOfPrepared(left.prep, right.prep)
  if (left.site && left.site === right.site) similarity += 0.1
  const sharedTags = intersectionSize(left.tags, right.tags)
  if (sharedTags > 0) similarity += 0.05 * sharedTags
  if (hasVersionConflict(left.prep, right.prep)) {
    similarity = Math.min(similarity, VERSION_CONFLICT_SIMILARITY_CAP)
  }
  return clamp01(similarity)
}

/** Stable group id derived from the member id set (input order independent). */
function clusterIdOf(memberIds) {
  const sorted = [...memberIds].sort(compareIds)
  let hash = 0x811c9dc5
  const payload = sorted.join('\u0001')
  for (let i = 0; i < payload.length; i += 1) {
    hash ^= payload.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return 'cg_' + (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * Cluster similar watch-later items (CONTRACT §13.2).
 *
 * Only active content items with a non-empty url participate:
 * kind in article / wechat / link / xhs / video / bilibili and
 * status not done / archived. Pairs with itemSimilarity >= 0.55 are merged
 * transitively with union-find. Groups smaller than 2 are omitted.
 *
 * Returned groups are sorted by size desc, then representativeId asc.
 * `hiddenIds` lists every non-representative member, in group output order and
 * then member order, i.e. deterministic for a given input.
 *
 * Never throws on malformed input; invalid entries are silently skipped.
 *
 * @param {unknown} items
 * @returns {{ groups: Array<{ id: string, memberIds: string[], representativeId: string, size: number }>, hiddenIds: string[] }}
 */
export function buildClusters(items) {
  const list = Array.isArray(items) ? items : []
  const candidates = []
  const seenIds = new Set()

  for (const item of list) {
    if (!isClusterable(item)) continue
    const id = item.id.trim()
    if (seenIds.has(id)) continue
    seenIds.add(id)
    candidates.push({
      id,
      item,
      prep: prepareTitle(item.title),
      site: normalizeSite(item.site),
      tags: tagSetOf(item.tags),
    })
  }

  const count = candidates.length
  const parent = new Array(count)
  const rank = new Array(count).fill(0)
  for (let i = 0; i < count; i += 1) parent[i] = i

  const find = (index) => {
    let root = index
    while (parent[root] !== root) root = parent[root]
    let cursor = index
    while (parent[cursor] !== cursor) {
      const next = parent[cursor]
      parent[cursor] = root
      cursor = next
    }
    return root
  }

  const union = (a, b) => {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA === rootB) return
    if (rank[rootA] < rank[rootB]) parent[rootA] = rootB
    else if (rank[rootA] > rank[rootB]) parent[rootB] = rootA
    else {
      parent[rootB] = rootA
      rank[rootA] += 1
    }
  }

  for (let i = 0; i < count; i += 1) {
    for (let j = i + 1; j < count; j += 1) {
      if (candidateSimilarity(candidates[i], candidates[j]) >= SIMILARITY_THRESHOLD) {
        union(i, j)
      }
    }
  }

  const membersByRoot = new Map()
  for (let i = 0; i < count; i += 1) {
    const root = find(i)
    const bucket = membersByRoot.get(root)
    if (bucket) bucket.push(candidates[i])
    else membersByRoot.set(root, [candidates[i]])
  }

  const groups = []
  for (const members of membersByRoot.values()) {
    if (members.length < 2) continue
    const memberIds = members.map((member) => member.id)
    const representativeId = pickRepresentative(members.map((member) => member.item)) || memberIds[0]
    groups.push({
      id: clusterIdOf(memberIds),
      memberIds,
      representativeId,
      size: memberIds.length,
    })
  }

  groups.sort((a, b) => {
    if (a.size !== b.size) return b.size - a.size
    return compareIds(a.representativeId, b.representativeId)
  })

  const hiddenIds = []
  const hiddenSet = new Set()
  for (const group of groups) {
    for (const id of group.memberIds) {
      if (id === group.representativeId || hiddenSet.has(id)) continue
      hiddenSet.add(id)
      hiddenIds.push(id)
    }
  }

  return { groups, hiddenIds }
}
