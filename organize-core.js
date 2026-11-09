/**
 * organize-core.js — 「AI 整理」的纯判定层（零 I/O、零网络、零 LLM）
 *
 * 主人 2026-11-09 定的口径：
 *   - done    标题洗干净了、摘要有内容、封面是真图（不是 SVG 占位）、分类落在 12 个 TOPICS 里
 *   - partial 上面四项缺一项以上，但确实整理过一轮（还能再补）
 *   - none    没整理过（老数据的 classified 布尔不算数）
 *   - failed  这一轮抓取/模型整个挂了，原因写在 lastError
 *
 * 为什么单独一层：ai.js（批量打分/整理）、organize.js（后台任务）、api.js（撤销/状态）
 * 都要用同一套判定，避免三处各写一份口径。
 */
import { TOPICS } from './topics.js'

export const ORGANIZE_VERSION = 2
export const MIN_CONFIDENCE = 0.7
export const TITLE_MIN = 6
export const TITLE_MAX = 40
export const SUMMARY_MIN = 12
export const SUMMARY_MAX = 140

const TOPIC_SET = new Set(TOPICS)

/** 占位封面（cover-art.js 生成的 SVG）不算真封面。 */
export function isRealCover(cover) {
  if (typeof cover !== 'string' || !cover.trim()) return false
  const value = cover.trim()
  if (/\.svg(\?|$)/i.test(value)) return false
  return true
}

/** 这些标题一看就是机器/文件名凑出来的，允许整句重写。 */
export function looksLikeGarbageTitle(title) {
  const text = String(title || '').trim()
  if (!text) return true
  if (text.length < TITLE_MIN) return true
  if (/^https?:\/\//i.test(text)) return true
  if (/^(微信图片|微信截图|IMG_\d|Screenshot|屏幕截图|未命名内容)/i.test(text)) return true
  if (/^[\d\s._-]+$/.test(text)) return true
  if (/\[图片\]|【图片】|原包缺失/.test(text)) return true
  return false
}

function charSet(text) {
  const set = new Set()
  for (const ch of String(text || '').replace(/[\s\p{P}\p{S}]/gu, '')) set.add(ch)
  return set
}

/**
 * 标题改写守门：只允许「清洗/补全」，不允许把事实换掉。
 * 旧标题一看就是垃圾时放行；否则要求新旧标题有足够的字面重叠。
 */
export function titleIsTrustworthy(oldTitle, newTitle) {
  const next = String(newTitle || '').trim()
  if (!next) return false
  if (next.length < TITLE_MIN || next.length > TITLE_MAX) return false
  if (/https?:\/\//i.test(next)) return false
  if (/^[\s\p{P}\p{S}]+$/u.test(next)) return false
  const prev = String(oldTitle || '').trim()
  if (!prev) return true
  // 「（原包缺失）」是主人定的缺件标记，AI 不许顺手洗掉
  if (/(原包缺失|原包缺件|漏存)/.test(prev) && !/(原包缺失|原包缺件|漏存)/.test(next)) return false
  if (prev === next) return false
  if (looksLikeGarbageTitle(prev)) return true
  const a = charSet(prev)
  const b = charSet(next)
  if (a.size === 0) return true
  let hit = 0
  for (const ch of a) if (b.has(ch)) hit += 1
  return hit / a.size >= 0.34
}

export function summaryIsUsable(title, summary) {
  const text = String(summary || '').trim()
  if (text.length < SUMMARY_MIN) return false
  if (text.length > SUMMARY_MAX + 40) return false
  const name = String(title || '').trim()
  if (!name) return true
  if (text === name) return false
  // 摘要只是标题的复述 → 不算数
  if (text.startsWith(name) && text.length - name.length < 8) return false
  return true
}

export function topicOfTags(tags) {
  const list = Array.isArray(tags) ? tags : []
  for (const tag of list) {
    const name = String(tag || '').trim()
    if (TOPIC_SET.has(name)) return name
  }
  return null
}

/**
 * 判定一条整理后的状态。
 * @param {{title?:string, summary?:string, cover?:string, tags?:string[], content?:object}} item
 * @returns {{state:'none'|'partial'|'done', checks:{title:boolean, summary:boolean, cover:boolean, topic:boolean}, missing:string[]}}
 */
export function evaluateState(item) {
  const source = item && typeof item === 'object' ? item : {}
  const title = String(source.title || '').trim()
  const titleOk = title.length >= TITLE_MIN && !looksLikeGarbageTitle(title)
  const summaryOk = summaryIsUsable(title, source.summary)
  const coverOk = isRealCover(source.cover)
  const topic = topicOfTags(source.tags)
  const topicOk = Boolean(topic) && topic !== '待归档'
  const checks = { title: titleOk, summary: summaryOk, cover: coverOk, topic: topicOk }
  const missing = Object.keys(checks).filter((key) => !checks[key])
  if (missing.length === 0) return { state: 'done', checks, missing }
  const touched = Boolean(source.ai && (source.ai.at || (Array.isArray(source.ai.fields) && source.ai.fields.length)))
  return { state: touched ? 'partial' : 'none', checks, missing }
}

/** 整理前后对比出「这次真正改了哪些字段」，给 ai.fields 和面板展示用。 */
export function diffFields(before, after) {
  const prev = before && typeof before === 'object' ? before : {}
  const next = after && typeof after === 'object' ? after : {}
  const fields = []
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
  if (!same(prev.title, next.title)) fields.push('title')
  if (!same(prev.summary, next.summary)) fields.push('summary')
  if (!same(prev.cover, next.cover)) fields.push('cover')
  if (!same(prev.kind, next.kind)) fields.push('kind')
  const prevTopic = topicOfTags(prev.tags)
  const nextTopic = topicOfTags(next.tags)
  if (!same(prevTopic, nextTopic)) fields.push('topic')
  // 分类标签本身的变化已经算作 topic，这里只比较细标签，避免重复计数
  const restTags = (tags) => (Array.isArray(tags) ? tags : []).filter((tag) => tag !== topicOfTags(tags))
  if (!same(restTags(prev.tags), restTags(next.tags))) fields.push('tags')
  if (!same(prev.importance, next.importance)) fields.push('importance')
  if (!same(prev.urgency, next.urgency)) fields.push('urgency')
  if (!same(prev.durationMin, next.durationMin)) fields.push('durationMin')
  return fields
}

/** 撤销用：把整理前的标题/类型/分类存成快照。 */
export function prevSnapshot(before, after) {
  const prev = before && typeof before === 'object' ? before : {}
  const next = after && typeof after === 'object' ? after : {}
  const snap = {}
  if (prev.title && prev.title !== next.title) snap.title = prev.title
  if (prev.kind && prev.kind !== next.kind) snap.kind = prev.kind
  const prevTopic = topicOfTags(prev.tags)
  const nextTopic = topicOfTags(next.tags)
  if (prevTopic && prevTopic !== nextTopic) snap.topic = prevTopic
  return Object.keys(snap).length ? snap : null
}
