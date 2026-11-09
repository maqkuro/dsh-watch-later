/**
 * classify.js — 「稍后再看」启发式分类 / 链接提取 / 截止时间解析 / 文本导入
 *
 * 契约：CONTRACT.md §3.6（唯一事实来源）。纯 ESM、纯函数、零 I/O、零第三方依赖。
 * 时间统一由 nowMs 注入：heuristicExtract / heuristicImportText / parseDeadlineFromText
 * 都支持显式 nowMs 参数（也可通过 input.nowMs 传入），缺省兜底 Date.now()。
 *
 * 设计原则：解析不出就返回 null / 'none'，绝不猜日期；所有入参安全降级，不抛错。
 */

import { classifyUrl, timeSensitivity } from './score.js'

const DAY_MS = 24 * 3600 * 1000

/* ------------------------------------------------------------------ *
 * 通用工具
 * ------------------------------------------------------------------ */

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 依次取第一个合法的 now 候选（毫秒数 / 可转数字 / ISO 字符串），全部非法则兜底 Date.now() */
function resolveNow(...candidates) {
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined || candidate === '') continue
    const n = typeof candidate === 'number' ? candidate : Number(candidate)
    if (Number.isFinite(n)) return n
    if (typeof candidate === 'string') {
      const parsed = Date.parse(candidate)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return Date.now()
}

function collapse(text) {
  return String(text).replace(/\s+/g, ' ').trim()
}

/** 按 Unicode 码点截断（中文/emoji 不会被截成半个代理对） */
function clip(text, max = 120) {
  const chars = Array.from(String(text))
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('')
}

/**
 * URL 匹配：http(s):// 或 www. 开头；中文标点/全角括号/引号不吞进 URL。
 * 尾部的半角标点（中文文案里 URL 常见的收尾）后面再裁掉。
 */
function urlRe() {
  // eslint-disable-next-line no-useless-escape
  return /(?<![A-Za-z0-9._@-])(?:https?:\/\/|www\.)[^\s<>"'`，。；、！？：（）【】「」『』《》]+/gi
}

function cleanUrlCandidate(raw) {
  return raw.replace(/[.,;:!?、。，；：！？…'"“”‘’)\]}>]+$/u, '')
}

/** CONTRACT §3.6：提取文本中的 URL，去重、保持出现顺序 */
export function extractUrls(text) {
  if (typeof text !== 'string' || !text) return []
  const urls = []
  const seen = new Set()
  const re = urlRe()
  let match
  while ((match = re.exec(text)) !== null) {
    const cleaned = cleanUrlCandidate(match[0])
    if (!cleaned || seen.has(cleaned)) continue
    seen.add(cleaned)
    urls.push(cleaned)
  }
  return urls
}

/** 去掉文本中的 URL（避免 URL 路径里的日期被误判成 deadline） */
function removeUrls(text) {
  if (typeof text !== 'string' || !text) return ''
  return text.replace(urlRe(), ' ')
}

/** 第一条有内容的行（先去掉行内 URL 再折叠空白） */
function firstMeaningfulLine(text) {
  if (typeof text !== 'string' || !text) return ''
  for (const line of text.split(/\r?\n/)) {
    const value = collapse(removeUrls(line))
    if (value) return value
  }
  return ''
}

/** 解析 URL 的 host（宽松：支持无协议 / www. / // 前缀），失败返回空串 */
function hostOf(url) {
  if (typeof url !== 'string' || !url.trim()) return ''
  const raw = url.trim()
  const candidates = []
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) candidates.push(raw)
  else if (raw.startsWith('//')) candidates.push('https:' + raw)
  else candidates.push('https://' + raw)
  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
      const host = parsed.hostname.toLowerCase()
      if (!host) continue
      return host
    } catch {
      // ignore
    }
  }
  return ''
}

/** CONTRACT §3.6：没有标题时用 URL 域名 */
function domainOf(url) {
  const host = hostOf(url)
  if (!host) return ''
  return host.startsWith('www.') ? host.slice(4) : host
}

/* ------------------------------------------------------------------ *
 * parseDeadlineFromText — CONTRACT §3.6
 * ------------------------------------------------------------------ */

const RELEASE_RE = /(开播|上映|上线)/
const AIRING_RE = /(更新|第\s*(?:\d{1,3}|[一二三四五六七八九十百零两]+)\s*集|每周|每(?:周|天)[一二三四五六日天])/
const EXPIRY_RE = /(截止|有效期|限时|优惠|报名|预售)/
const EVENT_RE = /(活动|演出|直播)/

function detectDeadlineKind(text) {
  if (RELEASE_RE.test(text)) return 'release'
  if (AIRING_RE.test(text)) return 'airing'
  if (EXPIRY_RE.test(text)) return 'expiry'
  if (EVENT_RE.test(text)) return 'event'
  return 'deadline'
}

// 2026-05-16 / 2026/05/16 / 2026年5月16日，可带 HH:mm（也接受 T20:00）
const FULL_DATE_RE =
  /(?<y>\d{4})\s*[-/年]\s*(?<mo>\d{1,2})\s*[-/月]\s*(?<d>\d{1,2})\s*日?(?:\s*[Tt ]?\s*(?<hh>\d{1,2})[:：](?<mi>\d{2}))?/
// 5月16日 / 5月16号? —— 契约只要求「日」，带时间 20:00
const CN_MONTH_DAY_RE =
  /(?<mo>\d{1,2})\s*月\s*(?<d>\d{1,2})\s*日?(?:\s*[Tt ]?\s*(?<hh>\d{1,2})[:：](?<mi>\d{2}))?/
// 5-16 / 5/16（前面不能紧跟数字，避免吃掉长数字串）
const DASH_MONTH_DAY_RE =
  /(?:^|[^\d])(?<mo>\d{1,2})\s*[-/]\s*(?<d>\d{1,2})(?!\d)(?:\s*[Tt ]?\s*(?<hh>\d{1,2})[:：](?<mi>\d{2}))?/

/**
 * 组装本地时区的 deadline。
 * - 带 HH:mm：用该时刻；只给日期：按当天 23:59:59.999（当日截止）
 * - 缺年份（inferYear）：按当年；若该时刻已过去超过 30 天 → 按明年
 * - 日期本身非法（如 2 月 30 日）返回 null
 */
function makeDeadline({ y, mo, d, hh, mi, hasTime, inferYear, now }) {
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null

  const probe = new Date(y, mo - 1, d, 12, 0, 0, 0)
  if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) return null

  const timeOk =
    hasTime &&
    Number.isFinite(hh) &&
    hh >= 0 &&
    hh <= 23 &&
    Number.isFinite(mi) &&
    mi >= 0 &&
    mi <= 59

  const build = (year) =>
    timeOk
      ? new Date(year, mo - 1, d, hh, mi, 0, 0)
      : new Date(year, mo - 1, d, 23, 59, 59, 999)

  let year = y
  let date = build(year)
  if (inferYear && now - date.getTime() > 30 * DAY_MS) {
    const next = build(year + 1)
    // 2/29 跨到平年会进位，只有校验通过才采用明年
    if (next.getFullYear() === year + 1 && next.getMonth() === mo - 1 && next.getDate() === d) {
      year += 1
      date = next
    }
  }
  return date
}

/**
 * CONTRACT §3.6：从文本解析 deadline 与 deadlineKind。
 * 识别 YYYY-MM-DD / MM月DD日 / MM-DD / YYYY/MM/DD（可带 HH:mm），
 * 缺失年份按当年、已过去超过 30 天按明年。解析不出返回 { deadline:null, deadlineKind:'none' }。
 */
export function parseDeadlineFromText(text, nowMs) {
  const rawText = typeof text === 'string' ? text : ''
  if (!rawText.trim()) return { deadline: null, deadlineKind: 'none' }

  const now = resolveNow(nowMs)
  const cleaned = removeUrls(rawText)
  const deadlineKind = detectDeadlineKind(cleaned)
  const currentYear = new Date(now).getFullYear()

  const patterns = [
    { re: FULL_DATE_RE, inferYear: false },
    { re: CN_MONTH_DAY_RE, inferYear: true },
    { re: DASH_MONTH_DAY_RE, inferYear: true },
  ]

  for (const { re, inferYear } of patterns) {
    const match = re.exec(cleaned)
    if (!match || !match.groups) continue
    const groups = match.groups
    const hasTime = groups.hh !== undefined && groups.mi !== undefined
    const date = makeDeadline({
      y: inferYear ? currentYear : Number(groups.y),
      mo: Number(groups.mo),
      d: Number(groups.d),
      hh: hasTime ? Number(groups.hh) : 0,
      mi: hasTime ? Number(groups.mi) : 0,
      hasTime,
      inferYear,
      now,
    })
    if (!date) continue
    return { deadline: date.toISOString(), deadlineKind }
  }

  return { deadline: null, deadlineKind: 'none' }
}

/* ------------------------------------------------------------------ *
 * heuristicExtract — CONTRACT §3.6
 * ------------------------------------------------------------------ */

const DRAMA_WORD_RE = /(剧|集|第[^\s]{0,3}[季集]|开播|上线|定档|预告|新番|番剧|动画|剧场版|电影)/
const DRAMA_TITLE_INTENT_RE = /(剧名\s*[:：]|想看)/
const DRAMA_EPISODE_RE = /第[0-9一二三四五六七八九十]+[集话期]/
// 「平台词」按契约：爱奇艺/腾讯视频/优酷/芒果/Netflix/HBO
const DRAMA_PLATFORM_RES = [
  { re: /爱奇艺/i, name: '爱奇艺' },
  { re: /腾讯视频/i, name: '腾讯视频' },
  { re: /优酷/i, name: '优酷' },
  { re: /芒果TV/i, name: '芒果TV' },
  { re: /芒果/i, name: '芒果TV' },
  { re: /Netflix/i, name: 'Netflix' },
  { re: /HBO/i, name: 'HBO' },
]

/** 游戏侧的识别词：测评/攻略/想玩/平台词，命中后归 kind='game'（「想玩」tab 用） */
const GAME_WORD_RE = /(测评|评测|评分|试玩|通关|攻略|支线|主线任务|限时任务|隐藏内容|开箱|想玩|周目|掉率|赛季|天梯|段位|mod|MOD|DLC|补丁说明|版本更新|首发|预售|主机版)/
const GAME_PLATFORM_RES = [
  { re: /小黑盒|xiaoheihe/i, name: '小黑盒' },
  { re: /steam/i, name: 'Steam' },
  { re: /taptap/i, name: 'TapTap' },
  { re: /\bNGA\b/i, name: 'NGA' },
  { re: /游民星空|机核|篝火|indienova|游戏葡萄|IGN|Metacritic|M站|MC评分/i, name: '游戏媒体' },
  { re: /PlayStation|PS5|PS4|Xbox|Switch|任天堂|Nintendo/i, name: '主机' },
  { re: /B站|bilibili/i, name: 'B站' },
]

const URGENT_WORD_RE = /(今天|今晚|明天|限时|截止|开播)/

function dramaPlatform(text) {
  for (const { re, name } of DRAMA_PLATFORM_RES) {
    if (re.test(text)) return name
  }
  return null
}

function gamePlatform(text) {
  for (const { re, name } of GAME_PLATFORM_RES) {
    if (re.test(text)) return name
  }
  return null
}

function detectGame(text, hasUrl) {
  if (!text) return false
  const hasWord = GAME_WORD_RE.test(text)
  const hasPlatform = GAME_PLATFORM_RES.some(({ re }) => re.test(text))
  if (hasWord && hasPlatform) return true
  // 「《作品名》+ 游戏词」是攻略/测评的常见标题形态（如《影之刃零》限时任务汇总）
  if (hasWord && /《[^》]{2,30}》/.test(text)) return true
  return false
}

function detectDrama(text, hasUrl) {
  if (!text) return false
  const hasWord = DRAMA_WORD_RE.test(text)
  const hasPlatform = DRAMA_PLATFORM_RES.some(({ re }) => re.test(text))
  if (hasWord && hasPlatform) return true
  // 「《剧名》第 N 集/话/期」：有书名号+集数，不强求平台词
  if (DRAMA_EPISODE_RE.test(text) && /《[^》]{2,40}》/.test(text)) return true
  // 纯标题无 URL 且有「剧名」意图（如「剧名：xxx」「想看」）也归 drama
  if (!hasUrl && DRAMA_TITLE_INTENT_RE.test(text)) return true
  return false
}

function buildTags(kind, site, deadlineKind) {
  const tags = []
  if (kind === 'drama') tags.push('剧集')
  if (kind === 'game') tags.push('游戏')
  if (site) tags.push(site)
  const deadlineTag = { release: '开播', airing: '追更', expiry: '限时', event: '活动' }[deadlineKind]
  if (deadlineTag) tags.push(deadlineTag)
  return [...new Set(tags)].slice(0, 4)
}

/**
 * CONTRACT §3.6：单条启发式解析。
 * @param {{ url?: string, text?: string, title?: string, nowMs?: number }} input
 * @param {number} [nowMs] 当前时间（也可用 input.nowMs；缺省 Date.now()）
 * @returns {{ title:string|null, url:string|null, kind:string, site:string|null,
 *            importance:number, urgency:number, deadline:string|null,
 *            deadlineKind:string, durationMin:number, tags:string[] }}
 */
export function heuristicExtract(input, nowMs) {
  const src = isPlainObject(input) ? input : {}
  const now = resolveNow(nowMs, src.nowMs)

  const text = typeof src.text === 'string' ? src.text : ''
  const explicitUrl = typeof src.url === 'string' && src.url.trim() ? src.url.trim() : null
  const url = explicitUrl || extractUrls(text)[0] || null
  const urlInfo = classifyUrl(url)

  const explicitTitle = typeof src.title === 'string' ? src.title.trim() : ''
  const analysis = removeUrls([explicitTitle, text].filter(Boolean).join('\n'))

  // URL 已被 removeUrls 剥掉，平台线索要靠 classifyUrl 给出的 site 补进来（如「小黑盒」）
  const detectText = urlInfo.site ? analysis + '\n' + urlInfo.site : analysis

  let kind = urlInfo.kind
  let site = urlInfo.site
  if (detectGame(detectText, Boolean(url))) {
    kind = 'game'
    site = gamePlatform(detectText) || site
  } else if (detectDrama(detectText, Boolean(url))) {
    kind = 'drama'
    site = dramaPlatform(analysis) || site
  }

  let title = ''
  if (explicitTitle) {
    title = clip(collapse(explicitTitle))
  } else {
    title = firstMeaningfulLine(text)
    if (!title && url) {
      const domain = domainOf(url)
      title = domain ? clip(collapse(domain)) : clip(collapse(url))
    }
    if (!title && site) title = site
  }

  const deadline = parseDeadlineFromText(analysis, now)

  let urgency = 2
  if (deadline.deadline) {
    const sensitivity = timeSensitivity(deadline.deadline, now)
    if (sensitivity.hoursLeft !== null && sensitivity.hoursLeft <= 72) {
      urgency = Math.max(urgency, 4)
    }
  }
  if (URGENT_WORD_RE.test(analysis)) urgency = Math.max(urgency, 3)

  return {
    title: title || null,
    url,
    kind,
    site,
    importance: 3,
    urgency,
    deadline: deadline.deadline,
    deadlineKind: deadline.deadlineKind,
    durationMin: 5,
    tags: buildTags(kind, site, deadline.deadlineKind),
  }
}

/* ------------------------------------------------------------------ *
 * heuristicImportText — CONTRACT §3.6
 * ------------------------------------------------------------------ */

/** 一行去掉 URL、折叠空白、裁掉首尾中文标点后作为候选标题 */
function cleanImportLine(line) {
  if (typeof line !== 'string' || !line) return ''
  const value = collapse(removeUrls(line))
  return value
    .replace(/^[\s，,。.：:；;、]+/u, '')
    .replace(/[\s，,。.：:；;、]+$/u, '')
}

function nearestLine(lines, from, direction) {
  for (let i = from + direction; i >= 0 && i < lines.length; i += direction) {
    const value = cleanImportLine(lines[i])
    if (value) return value
  }
  return ''
}

/** 一行内所有 URL 的区间（用来把同一行多个链接的标题拆开） */
function urlIntervals(line) {
  const intervals = []
  const re = urlRe()
  let match
  while ((match = re.exec(line)) !== null) {
    intervals.push({ start: match.index, end: match.index + match[0].length })
  }
  return intervals
}

/**
 * 取当前 URL 所在行内、去掉所有 URL 后的「前段 / 后段」文本。
 * 前段（URL 之前、上一个 URL 之后）优先，避免同一行多个链接共用标题。
 */
function lineSegmentsAround(line, position) {
  if (typeof line !== 'string' || !line) return { before: '', after: '' }
  const intervals = urlIntervals(line)
  const current = intervals.find((interval) => position >= interval.start && position < interval.end)
  if (!current) return { before: cleanImportLine(line), after: '' }

  let beforeStart = 0
  for (const interval of intervals) {
    if (interval.end <= current.start) beforeStart = Math.max(beforeStart, interval.end)
  }
  let afterEnd = line.length
  for (const interval of intervals) {
    if (interval.start >= current.end) afterEnd = Math.min(afterEnd, interval.start)
  }
  return {
    before: cleanImportLine(line.slice(beforeStart, current.start)),
    after: cleanImportLine(line.slice(current.end, afterEnd)),
  }
}

/**
 * CONTRACT §3.6：粘贴文本 → 候选条目数组。
 * - 先 extractUrls（去重）；每个 URL 生成一个候选，title 取 URL 所在行里去掉 URL 后的
 *   前段 / 后段文本，其次取最近的前后文本行，最后用 URL 域名（去空白，截 120 字）
 * - 无 URL 且文本非空 → 单个 kind:'other' 候选（title 取首行，截 120 字）
 * - 空文本 → []
 *
 * @param {string|{ text?: string, nowMs?: number }} input 纯文本（也接受 { text }）
 * @param {number} [nowMs]
 */
export function heuristicImportText(input, nowMs) {
  const text =
    typeof input === 'string'
      ? input
      : isPlainObject(input) && typeof input.text === 'string'
        ? input.text
        : ''
  const now = resolveNow(nowMs, isPlainObject(input) ? input.nowMs : undefined)

  if (!text || !text.trim()) return []

  const urls = extractUrls(text)

  if (urls.length === 0) {
    const title = clip(firstMeaningfulLine(text) || collapse(text), 120)
    const extracted = heuristicExtract({ text, title }, now)
    return [
      {
        title: title || clip(collapse(text), 120),
        url: null,
        kind: 'other',
        site: null,
        importance: extracted.importance,
        urgency: extracted.urgency,
        deadline: extracted.deadline,
        deadlineKind: extracted.deadlineKind,
        durationMin: extracted.durationMin,
        tags: buildTags('other', null, extracted.deadlineKind),
      },
    ]
  }

  const lines = text.split(/\r?\n/)
  const lineStarts = [0]
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lineStarts.push(i + 1)
  }
  const lineIndexAt = (position) => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= position) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  const candidates = []
  let cursor = 0
  for (const url of urls) {
    let index = text.indexOf(url, cursor)
    if (index < 0) index = text.indexOf(url)
    if (index >= 0 && index + url.length > cursor) cursor = index + url.length

    const lineIndex = index >= 0 ? lineIndexAt(index) : 0
    const lineStart = lineStarts[lineIndex] ?? 0
    const line = lines[lineIndex] || ''
    const segments = lineSegmentsAround(line, index >= 0 ? index - lineStart : 0)
    const previous = nearestLine(lines, lineIndex, -1)
    const next = nearestLine(lines, lineIndex, 1)
    const fallbackTitle = domainOf(url) || clip(collapse(url), 120)
    const title = segments.before || segments.after || previous || next || fallbackTitle || ''
    const context = [segments.before, segments.after, previous, next]
      .filter(Boolean)
      .join('\n')

    const extracted = heuristicExtract({ url, title, text: context }, now)
    candidates.push({
      ...extracted,
      title: extracted.title || title || fallbackTitle,
      url,
    })
  }

  return candidates
}
