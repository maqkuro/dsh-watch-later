/**
 * Shared "paste a blob of text" candidate extraction for both the HTTP
 * /import endpoint and the inbox drop-zone text files.
 *
 * classify.js works per URL and borrows kind/deadline/summary from the lines
 * around it, which cross-contaminates mixed pastes (one link + one drama title
 * on another line). This module keeps per-URL candidates to their own line and
 * turns leftover standalone lines into text candidates, so nothing is lost and
 * nothing inherits a neighbour's deadline.
 */
import { heuristicImportText, heuristicExtract, extractUrls, parseDeadlineFromText } from './classify.js'
import { classifyUrl } from './score.js'
import { parseShareText } from './sync/douyin.js'

const URL_RE = /https?:\/\/\S+/gi
const COMMENT_TITLE_RE =
  /^(看看|看看这个|看看这两个|看这个|看下这个|晚上看|今天看|明天看|周末看|回头再看|回头看|先存|mark|这个|这两个|那个|还有|还有这个|以及|另外|这里|分享|分享个|链接|网页|文章|视频|图片|一条|两个|几个|戳|点击|复制|打开|找到|发现|收藏|记录一下)[\s\S]{0,6}$/i

export function isWeakTitle(title) {
  if (typeof title !== 'string') return true
  const text = title.trim()
  if (!text || text.length < 4) return true
  return COMMENT_TITLE_RE.test(text)
}

function cleanTitle(title) {
  if (typeof title !== 'string') return title
  let out = title.trim()
  out = out.replace(/^(?:\d{1,2}\.\d{1,2}\s*)?复制打开抖音[，,、]?\s*看看/, '')
  out = out.replace(/^(?:\d{1,2}\.\d{1,2}\s*)?复制打开抖音[，,、]?/, '')
  out = out.replace(/^复制此链接[，,]?打开Dou音搜索[，,]?直接观看视频[！!]?/, '')
  return out.trim()
}

function linesOf(text) {
  return String(text || '').split(/\r?\n/)
}

function lineWithUrl(text, url) {
  return linesOf(text).find((line) => line.includes(url)) || ''
}

function sameLineTitle(text, url) {
  const line = lineWithUrl(text, url)
  const index = line.indexOf(url)
  if (index < 0) return null
  const before = line
    .slice(0, index)
    .replace(URL_RE, ' ')
    .replace(/^[\s\d.,，。:：;；)）\]】]+/, '')
    .replace(/[\s:：,，。.、;；!！?？~～-]+$/, '')
    .trim()
  const cleaned = cleanTitle(before)
  if (cleaned.length >= 4 && !isWeakTitle(cleaned)) return cleaned.slice(0, 120)
  return null
}

function urgencyForDeadline(deadline, nowMs = Date.now()) {
  if (!deadline) return 2
  const hours = (Date.parse(deadline) - nowMs) / 3600e3
  if (!Number.isFinite(hours)) return 2
  if (hours < 0) return 4
  if (hours <= 24) return 5
  if (hours <= 72) return 4
  if (hours <= 168) return 3
  return 2
}

/** Rewrite one per-URL candidate so it only reflects its own line. */
function normalizeUrlCandidate(candidate, raw) {
  const url = candidate.url
  const line = lineWithUrl(raw, url)
  const detected = classifyUrl(url)
  const out = {
    url,
    kind: detected.kind,
    site: detected.site || null,
    importance: 3,
    urgency: 2,
  }
  const inline = sameLineTitle(raw, url)
  if (inline) out.title = inline
  const lineDeadline = parseDeadlineFromText(line)
  if (lineDeadline.deadline) {
    out.deadline = lineDeadline.deadline
    out.deadlineKind = lineDeadline.deadlineKind
    out.urgency = urgencyForDeadline(lineDeadline.deadline)
  }
  const duration = Number(candidate.durationMin)
  if (Number.isFinite(duration) && duration > 0 && duration <= 600) out.durationMin = duration
  if (Array.isArray(candidate.tags) && candidate.tags.length > 0) out.tags = candidate.tags
  return out
}

const DRAMA_HINT_RE = /剧名|第[一二三四五六七八九十百0-9]{1,3}[集期话]|大结局|开播|定档|上线|首播|更新至|新剧|追剧|新番|番剧/
const GAME_HINT_RE = /游戏|测评|评测|攻略|试玩|通关|支线|想玩|mod|MOD|DLC|赛季|天梯|段位|开荒|首发/

function textCandidate(line) {
  const extracted = heuristicExtract({ text: line, title: line })
  let kind = extracted.kind || 'other'
  if (kind === 'other' && DRAMA_HINT_RE.test(line)) kind = 'drama'
  else if (kind === 'other' && GAME_HINT_RE.test(line)) kind = 'game'
  const candidate = {
    title: line.slice(0, 120),
    url: null,
    kind,
    site: extracted.site || null,
    importance: Number.isFinite(Number(extracted.importance)) ? Number(extracted.importance) : 3,
    urgency: Number.isFinite(Number(extracted.urgency)) ? Number(extracted.urgency) : 2,
  }
  if (extracted.deadline) {
    candidate.deadline = extracted.deadline
    candidate.deadlineKind = extracted.deadlineKind || 'deadline'
  }
  if (Number.isFinite(Number(extracted.durationMin)) && Number(extracted.durationMin) > 0) {
    candidate.durationMin = Number(extracted.durationMin)
  }
  if (Array.isArray(extracted.tags) && extracted.tags.length > 0) candidate.tags = extracted.tags
  return candidate
}

/**
 * Extract import candidates from free-form pasted text:
 *   - one candidate per URL, with a same-line title/deadline only
 *   - one candidate per standalone non-URL line (drama names, memos, …)
 *   - douyin share copy gets a cleaned caption candidate
 *
 * @param {string} text
 * @returns {Array<Record<string, unknown>>}
 */
export function extractImportCandidates(text) {
  const raw = typeof text === 'string' ? text : ''
  if (!raw.trim()) return []

  // Text-only note: one candidate with the heuristic's kind/deadline.
  if (extractUrls(raw).length === 0) {
    return [textCandidate(raw.replace(/\s+/g, ' ').trim())]
  }

  const candidates = heuristicImportText(raw)
    .filter((candidate) => candidate && candidate.url)
    .map((candidate) => normalizeUrlCandidate(candidate, raw))

  // Douyin share copy: parseShareText gives a cleaner caption than a raw line.
  // Only trust that caption when the paste is a single link; mixed pastes would
  // otherwise fold every other line into the title.
  const urlCount = extractUrls(raw).length
  const share = parseShareText(raw)
  if (share && share.url) {
    const existing = candidates.find((candidate) => candidate.url === share.url)
    const shareTitle =
      urlCount === 1 &&
      typeof share.title === 'string' &&
      share.title.trim().length >= 4 &&
      share.title.length <= 80 &&
      !/https?:\/\//i.test(share.title)
        ? cleanTitle(share.title)
        : null
    if (existing) {
      if (shareTitle) existing.title = shareTitle
      existing.kind = 'douyin'
      existing.site = '抖音'
    } else {
      candidates.push({
        title: shareTitle || '抖音视频',
        url: share.url,
        kind: 'douyin',
        site: '抖音',
        importance: 3,
        urgency: 2,
      })
    }
  }

  // Leftover standalone lines: lines WITHOUT any URL (link lines are already represented).
  const leftover = linesOf(raw)
    .filter((line) => !/https?:\/\//i.test(line))
    .map((line) => line.replace(/^[\s\d.,，。:：;；)）\]】]+/, '').replace(/[\s:：,，。.、;；!！?？~～-]+$/, '').trim())
    .filter((line) => line.length >= 5 && /[\u4e00-\u9fa5]/.test(line))
    .filter((line) => {
      const head = line.slice(0, 12)
      return !candidates.some((candidate) => {
        const title = typeof candidate.title === 'string' ? candidate.title.trim() : ''
        return title && (title.includes(head) || head.includes(title.slice(0, 12)))
      })
    })

  for (const line of leftover.slice(0, 5)) candidates.push(textCandidate(cleanTitle(line)))
  return candidates
}

export { extractUrls }
