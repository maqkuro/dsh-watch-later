/**
 * sync/douyin.js — 抖音：分享文案解析 + 分享短链解析 + 「稍后再看」现状调研。
 *
 * 契约（CONTRACT.md §7）：
 *   export function parseShareText(text)        -> { url, title|null } | null
 *   export async function resolveShareUrl({ url, signal }) -> { ok, item?, error? }
 *   export async function fetchWatchLater({ cookie, signal }) -> { ok, supported, items:[], error? }
 *
 * 2026-11-06 curl + Node fetch 实测结论（详见 sync/NOTES.md）：
 *   1) v.douyin.com 短链 302 可拿到 Location（含 /share/video/<aweme_id>），无需登录 —— 能解析出视频 ID 与标准链接。
 *   2) 打开落地页（www.iesdouyin.com/share/video/<id>/、m.douyin.com/share/video/<id>）只有
 *      window._ROUTER_DATA 页面上下文（itemId/UA/abParams），没有标题、作者、封面、og:title。
 *   3) iesdouyin /web/api/v2/aweme/iteminfo/ 需 encrypt_data 签名（11110 encrypt_data_miss）；
 *      www.douyin.com/aweme/v1/web/aweme/detail/ 被 ArgusSecurityPlugin 拦截（403 Uifid Not Found）。
 *   => 无登录拿不到标题/作者/封面：resolveShareUrl 返回 ok:false + 结构化 error（同时给降级 item：只含 remoteId 与标准链接）。
 *   4) 抖音网页端确有「稍后再看」：/aweme/v1/web/watchlater/list/ 未登录返回 status_code=0/items=null；
 *      /aweme/v1/web/user/profile/self/ 返回 user_watchlater_count 字段。因此 fetchWatchLater 按“需要登录 Cookie”
 *      实现（supported:true）；无 cookie 时返回可读错误，绝不伪造数据。
 */

import { request, describeRequestError, UA, MOBILE_UA } from './http.js'

const WATCHLATER_URL = 'https://www.douyin.com/aweme/v1/web/watchlater/list/'
const PROFILE_SELF_URL = 'https://www.douyin.com/aweme/v1/web/user/profile/self/'
const DOUYIN_REFERER = 'https://www.douyin.com/'

const MAX_ITEMS = 100
const PAGE_SIZE = 20
const MAX_PAGES = 5

// ---------------------------------------------------------------------------
// 分享文案解析
// ---------------------------------------------------------------------------

const SHORT_LINK_RE = /https?:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+\/?/i
const BARE_SHORT_LINK_RE = /(?:^|[\s（(【])((?:https?:\/\/)?v\.douyin\.com\/[A-Za-z0-9_-]+\/?)/i
const FULL_LINK_RE =
  /https?:\/\/(?:www\.|m\.|www\.iesdouyin\.|iesdouyin\.)?(?:douyin\.com|iesdouyin\.com)\/(?:share\/)?(?:video|note)\/[A-Za-z0-9_-]+[^\s，,。；;！!）)】]*/i

const SHARE_BOILERPLATE = [
  /复制打开抖音[，,、]?看看/g,
  /复制此链接[，,]?打开Dou音搜索[，,]?直接观看视频[！!]?/g,
  /打开Dou音搜索[，,]?直接观看视频[！!]?/g,
  /复制链接[，,]?打开抖音[，,]?直接观看视频[！!]?/g,
  /长按复制此条消息[，,]?打开抖音搜索[，,]?查看TA的更多作品/g,
  /[0-9]+(?:\.[0-9]+)?\s*复制/g,
]

function cleanTitleText(text) {
  if (typeof text !== 'string') return null
  let out = text
  for (const re of SHARE_BOILERPLATE) out = out.replace(re, ' ')
  const prefixCleaners = [
    // 分享文案开头的随机版本号，如 "7.43 复制打开抖音…"
    /^\s*\d{1,2}\.\d{1,2}\s+/,
    // 分享文案开头的随机短码，如 "mQx:/ 复制打开抖音…"
    /^\s*[A-Za-z0-9]{1,8}:\/\s*/,
  ]
  for (let round = 0; round < 3; round += 1) {
    let changed = false
    for (const re of prefixCleaners) {
      const next = out.replace(re, ' ')
      if (next !== out) {
        out = next
        changed = true
      }
    }
    if (!changed) break
  }
  out = out
    .replace(/\s+/g, ' ')
    .replace(/^[\s，,。.；;!！?？:：、~～]+/, '')
    .replace(/[\s，,。.；;!！?？:：、~～]+$/, '')
    .trim()
  if (!out) return null
  return out.length > 120 ? `${out.slice(0, 120)}…` : out
}

/**
 * 从抖音分享文案里提取短链与文案标题。
 *
 * 例："7.43 复制打开抖音，看看【某某的作品】今天的晚霞 https://v.douyin.com/iRNBho6u/ 复制此链接，打开Dou音搜索，直接观看视频！"
 * -> { url: 'https://v.douyin.com/iRNBho6u/', title: '【某某的作品】今天的晚霞' }
 *
 * @param {string} text
 * @returns {{ url:string, title:string|null } | null} 找不到抖音链接返回 null
 */
export function parseShareText(text) {
  if (typeof text !== 'string' || !text.trim()) return null
  const raw = text

  let url = null
  let matched = null
  const direct = raw.match(SHORT_LINK_RE)
  if (direct) {
    matched = direct[0]
  } else {
    const bare = raw.match(BARE_SHORT_LINK_RE)
    if (bare) matched = bare[1]
  }
  if (matched) {
    const code = matched.match(/v\.douyin\.com\/([A-Za-z0-9_-]+)/i)
    if (code) url = `https://v.douyin.com/${code[1]}/`
  }
  if (!url) {
    const full = raw.match(FULL_LINK_RE)
    if (full) {
      const parsed = parseDouyinUrl(full[0])
      if (parsed && (parsed.kind === 'video' || parsed.kind === 'note')) {
        url = parsed.kind === 'video'
          ? `https://www.douyin.com/video/${parsed.id}`
          : `https://www.douyin.com/note/${parsed.id}`
      } else {
        url = full[0]
      }
    }
  }
  if (!url) return null

  let rest = raw
  if (matched) rest = rest.split(matched).join(' ')
  rest = rest.replace(/https?:\/\/[^\s，,。；;！!）)】]+/gi, ' ')
  const title = cleanTitleText(rest)
  return { url, title }
}

// ---------------------------------------------------------------------------
// URL 解析
// ---------------------------------------------------------------------------

function toUrlObject(input) {
  if (typeof input !== 'string' || !input.trim()) return null
  const value = input.trim()
  try {
    return new URL(value)
  } catch {
    try {
      return new URL(`https://${value}`)
    } catch {
      return null
    }
  }
}

/**
 * 解析抖音链接。
 * @param {string} input
 * @returns {{ kind:'short'|'video'|'note'|'user'|'other', id:string|null, href:string, host:string } | null}
 */
export function parseDouyinUrl(input) {
  const url = toUrlObject(input)
  if (!url) return null
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const host = url.hostname.toLowerCase()

  if (host === 'v.douyin.com' || host.endsWith('.v.douyin.com')) {
    const segment = url.pathname.split('/').filter(Boolean)[0]
    if (!segment) return null
    return { kind: 'short', id: segment, href: `https://v.douyin.com/${segment}/`, host }
  }

  const isDouyin = host === 'douyin.com' || host.endsWith('.douyin.com') ||
    host === 'iesdouyin.com' || host.endsWith('.iesdouyin.com')
  if (!isDouyin) return null

  const parts = url.pathname.split('/').filter(Boolean)
  let kind = null
  let id = null
  if (parts[0] === 'share' && (parts[1] === 'video' || parts[1] === 'note' || parts[1] === 'user')) {
    kind = parts[1]
    id = parts[2] || null
  } else if (parts[0] === 'video' || parts[0] === 'note' || parts[0] === 'user') {
    kind = parts[0]
    id = parts[1] || null
  }
  if (!kind || !id) return { kind: 'other', id: null, href: url.href, host }
  let decodedId = id
  try {
    decodedId = decodeURIComponent(id)
  } catch {
    /* 保留原值 */
  }
  return { kind, id: decodedId, href: url.href, host }
}

/** 从一个落地 URL 中提取视频/图文/用户 ID。 */
export function resolveTargetFromUrl(input) {
  const parsed = parseDouyinUrl(input)
  if (!parsed) return null
  if (parsed.kind === 'video' || parsed.kind === 'note' || parsed.kind === 'user') {
    return { kind: parsed.kind, id: parsed.id, href: parsed.href }
  }
  return null
}

// ---------------------------------------------------------------------------
// 分享页元数据解析（尽力而为；当前线上无元数据，保留解析器以应对页面改版）
// ---------------------------------------------------------------------------

function decodeHtmlEntities(text) {
  if (typeof text !== 'string') return text
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function safeFromCodePoint(code) {
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function pickCover(node) {
  if (!node) return null
  if (typeof node === 'string') return node.trim() || null
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickCover(item)
      if (found) return found
    }
    return null
  }
  if (typeof node === 'object') {
    return pickCover(node.url_list || node.urlList || node.url || node.uri || null)
  }
  return null
}

function toDurationSec(value) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return null
  // 抖音 aweme 的 duration 单位是毫秒；>= 1000 时按毫秒换算
  return num >= 1000 ? Math.round(num / 1000) : num
}

function readAwemeLikeObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const id = firstString(
    obj.aweme_id,
    obj.awemeId,
    obj.item_id,
    obj.itemId,
    obj.group_id,
    obj.groupId,
  )
  const desc = firstString(obj.desc, obj.preview_title, obj.title, obj.caption)
  const authorNode = obj.author || obj.authorInfo || obj.author_info
  const author = firstString(
    authorNode && authorNode.nickname,
    authorNode && authorNode.name,
    obj.nickname,
    obj.author_name,
  )
  const video = obj.video || obj.video_info
  const cover = pickCover(
    (video && (video.cover || video.origin_cover || video.dynamic_cover)) || obj.cover,
  )
  const durationSec = toDurationSec(video && video.duration != null ? video.duration : obj.duration)
  if (!id && !desc) return null
  return { id, title: desc, author, cover, durationSec }
}

function findAwemeMeta(root) {
  const stack = [{ value: root, depth: 0 }]
  let fallback = null
  let guard = 0
  while (stack.length && guard < 5000) {
    guard += 1
    const { value, depth } = stack.pop()
    if (!value || typeof value !== 'object' || depth > 8) continue
    if (Array.isArray(value)) {
      for (const child of value) stack.push({ value: child, depth: depth + 1 })
      continue
    }
    const meta = readAwemeLikeObject(value)
    if (meta) {
      if (meta.title) return meta
      if (!fallback) fallback = meta
    }
    for (const key of Object.keys(value)) {
      const child = value[key]
      if (child && typeof child === 'object') stack.push({ value: child, depth: depth + 1 })
    }
  }
  return fallback
}

function tryParseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function extractEmbeddedJson(html) {
  const out = []
  // 1) window._ROUTER_DATA = { ... }（当前网页版分享页实测使用此形式）
  const routerRe = /window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/i
  const routerMatch = html.match(routerRe)
  if (routerMatch) {
    const parsed = tryParseJson(routerMatch[1])
    if (parsed) out.push(parsed)
  }
  // 2) window.RENDER_DATA = JSON.parse(decodeURIComponent("..."))（历史分享页形式）
  const renderEncodedRe = /window\.RENDER_DATA\s*=\s*JSON\.parse\(\s*decodeURIComponent\(\s*["']([\s\S]*?)["']\s*\)\s*\)/i
  const renderEncoded = html.match(renderEncodedRe)
  if (renderEncoded) {
    try {
      const parsed = tryParseJson(decodeURIComponent(renderEncoded[1]))
      if (parsed) out.push(parsed)
    } catch {
      /* 解码失败则跳过 */
    }
  }
  // 3) window.RENDER_DATA = { ... }
  const renderRe = /window\.RENDER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/i
  const renderMatch = html.match(renderRe)
  if (renderMatch) {
    const parsed = tryParseJson(renderMatch[1])
    if (parsed) out.push(parsed)
  }
  // 4) <script id="RENDER_DATA" type="application/json">...</script>
  const scriptDataRe = /<script[^>]+id=["']RENDER_DATA["'][^>]*>([\s\S]*?)<\/script>/i
  const scriptData = html.match(scriptDataRe)
  if (scriptData) {
    let raw = scriptData[1].trim()
    if (/%7B|%22/i.test(raw)) {
      try {
        raw = decodeURIComponent(raw)
      } catch {
        /* 保留原文 */
      }
    }
    const parsed = tryParseJson(raw)
    if (parsed) out.push(parsed)
  }
  // 5) JSON-LD（VideoObject 常见 name/thumbnailUrl）
  const ldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let ldMatch
  while ((ldMatch = ldRe.exec(html))) {
    const parsed = tryParseJson(ldMatch[1].trim())
    if (parsed) out.push(parsed)
  }
  return out
}

function readJsonLdMeta(node) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = readJsonLdMeta(item)
      if (found) return found
    }
    return null
  }
  const type = node['@type']
  const isVideo = (Array.isArray(type) ? type : [type]).some((t) =>
    typeof t === 'string' && /VideoObject/i.test(t),
  )
  if (!isVideo) {
    for (const key of Object.keys(node)) {
      if (node[key] && typeof node[key] === 'object') {
        const found = readJsonLdMeta(node[key])
        if (found) return found
      }
    }
    return null
  }
  return {
    title: firstString(node.name, node.headline),
    author: firstString(node.author && node.author.name, node.creator && node.creator.name),
    cover: pickCover(node.thumbnailUrl || node.image),
    durationSec: parseIsoDuration(node.duration),
  }
}

function parseIsoDuration(value) {
  if (typeof value !== 'string') return null
  const match = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i)
  if (!match) return null
  const hours = Number(match[1] || 0)
  const minutes = Number(match[2] || 0)
  const seconds = Number(match[3] || 0)
  const total = Math.round(hours * 3600 + minutes * 60 + seconds)
  return total > 0 ? total : null
}

function readMetaTag(html, prop) {
  const escaped = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${escaped}["']`, 'i'),
  ]
  for (const re of patterns) {
    const match = html.match(re)
    if (match) return decodeHtmlEntities(match[1])
  }
  return null
}

// 抖音通用页面标题（不是作品标题），用于过滤 <title> 兜底，避免把占位文案当标题。
const GENERIC_PAGE_TITLE_MARKERS = [/^抖音$/, /记录美好生活/, /^抖音[-—]/, /^抖音网页版/, /^抖音一下/]

function isUsablePageTitle(title) {
  if (typeof title !== 'string') return false
  const trimmed = title.trim()
  if (trimmed.length < 2) return false
  return !GENERIC_PAGE_TITLE_MARKERS.some((re) => re.test(trimmed))
}

/**
 * 纯函数：从分享落地页 HTML 里尽力提取标题/作者/封面/时长。
 * 当前线上（2026-11）实测这些页面只有 _ROUTER_DATA 页面上下文，故通常全部返回 null；
 * 保留 og/RENDER_DATA/JSON-LD 解析是为了页面改版后仍能自动生效。
 * @returns {{ title:string|null, author:string|null, cover:string|null, durationSec:number|null }}
 */
export function parseSharePageMeta(html) {
  const result = { title: null, author: null, cover: null, durationSec: null }
  if (typeof html !== 'string' || !html) return result

  for (const json of extractEmbeddedJson(html)) {
    const meta = readJsonLdMeta(json) || findAwemeMeta(json)
    if (!meta) continue
    if (!result.title && meta.title) result.title = meta.title
    if (!result.author && meta.author) result.author = meta.author
    if (!result.cover && meta.cover) result.cover = meta.cover
    if (!result.durationSec && meta.durationSec) result.durationSec = meta.durationSec
    if (result.title && result.cover && result.author) break
  }

  if (!result.title) {
    const ogTitle = readMetaTag(html, 'og:title')
    if (ogTitle) result.title = ogTitle
  }
  if (!result.cover) {
    const ogImage = readMetaTag(html, 'og:image')
    if (ogImage) result.cover = ogImage
  }
  if (!result.title) {
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    const titleText = titleMatch ? decodeHtmlEntities(titleMatch[1]).trim() : null
    if (isUsablePageTitle(titleText)) result.title = titleText
  }
  return result
}

// ---------------------------------------------------------------------------
// 短链跳转
// ---------------------------------------------------------------------------

/**
 * 手动跟随 3xx 跳转，记录每一跳（用于解析 v.douyin.com 短链）。
 * 默认最多 5 跳；只读取 Location，不解析 HTML。
 * @param {string} startUrl
 * @param {{ signal?:AbortSignal, maxHops?:number, headers?:Record<string,string> }} [options]
 * @returns {Promise<{ finalUrl:string, hops:Array<{from:string,status:number,to:string}> }>}
 */
export async function followShortLink(startUrl, options = {}) {
  const { signal, maxHops = 5, headers = { 'User-Agent': UA } } = options
  let current = startUrl
  const hops = []
  for (let i = 0; i < maxHops; i += 1) {
    const res = await request(current, { redirect: 'manual', signal, headers })
    // 手动 redirect 的响应体很小，读掉以释放连接；失败也无所谓
    try {
      await res.text()
    } catch {
      /* 忽略 */
    }
    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location) {
      let next
      try {
        next = new URL(location, current).href
      } catch {
        break
      }
      hops.push({ from: current, status: res.status, to: next })
      current = next
      continue
    }
    break
  }
  return { finalUrl: current, hops }
}

// ---------------------------------------------------------------------------
// 分享链接解析
// ---------------------------------------------------------------------------

/**
 * 解析抖音分享链接：短链跟跳 -> 视频 ID -> 标准链接 -> 尝试落地页元数据。
 *
 * 实测限制：无登录时抖音网页端拿不到标题/作者/封面，因此正常情况下返回 ok:false + 结构化 error，
 * 同时附降级 item（只含 remoteId 与标准链接，title 为占位文案），宿主可自行决定是否仍入库。
 *
 * @param {{ url:string, signal?:AbortSignal }} options
 * @returns {Promise<{ ok:boolean, item?:{ remoteId:string, title:string, url:string,
 *   cover:string|null, author:string|null, durationSec:number|null },
 *   resolved?:{ url:string, hops:Array }, error?:string }>}
 */
export async function resolveShareUrl({ url, signal } = {}) {
  if (typeof url !== 'string' || !url.trim()) {
    return { ok: false, error: '缺少抖音链接（支持 v.douyin.com 短链或 douyin.com/video/<id>）' }
  }
  if (signal && signal.aborted) return { ok: false, error: '解析已取消' }

  const parsed = parseDouyinUrl(url)
  if (!parsed) {
    return { ok: false, error: '不是可识别的抖音链接（支持 v.douyin.com 短链、douyin.com/video/<id>、douyin.com/note/<id>）' }
  }
  if (parsed.kind === 'user') {
    return { ok: false, error: '这是抖音用户主页分享，不是单条视频；请分享具体视频作品' }
  }

  let finalUrl = parsed.href
  let hops = []
  let target = null
  if (parsed.kind === 'short') {
    try {
      const followed = await followShortLink(parsed.href, { signal, headers: { 'User-Agent': UA } })
      finalUrl = followed.finalUrl
      hops = followed.hops
      target = resolveTargetFromUrl(finalUrl)
    } catch (err) {
      return { ok: false, error: describeRequestError(err) }
    }
  } else if (parsed.kind === 'video' || parsed.kind === 'note') {
    target = { kind: parsed.kind, id: parsed.id, href: parsed.href }
  }

  if (!target) {
    return {
      ok: false,
      error: '抖音短链已跳转，但没能识别出视频 ID（可能分享的是直播/活动页/已删除作品）',
      resolved: { url: finalUrl, hops },
    }
  }
  if (target.kind === 'user') {
    return { ok: false, error: '这是抖音用户主页分享，不是单条视频', resolved: { url: finalUrl, hops } }
  }

  const remoteId = target.id
  const canonicalUrl =
    target.kind === 'note'
      ? `https://www.douyin.com/note/${remoteId}`
      : `https://www.douyin.com/video/${remoteId}`
  const fallbackItem = {
    remoteId,
    title: `抖音视频 ${remoteId}`,
    url: canonicalUrl,
    cover: null,
    author: null,
    durationSec: null,
  }

  // 尽力尝试落地页元数据（当前实测无元数据；页面改版后可能恢复）
  let meta = { title: null, author: null, cover: null, durationSec: null }
  let metaError = null
  try {
    const sharePath = target.kind === 'note' ? 'note' : 'video'
    const sharePageUrl = `https://www.iesdouyin.com/share/${sharePath}/${remoteId}/`
    const res = await request(sharePageUrl, {
      headers: { 'User-Agent': MOBILE_UA, Referer: DOUYIN_REFERER, Accept: 'text/html,*/*' },
      signal,
    })
    if (res.status >= 200 && res.status < 300) {
      const html = await res.text()
      meta = parseSharePageMeta(html)
    }
  } catch (err) {
    metaError = describeRequestError(err)
  }

  if (meta && meta.title) {
    return {
      ok: true,
      item: {
        remoteId,
        title: meta.title,
        url: canonicalUrl,
        cover: meta.cover,
        author: meta.author,
        durationSec: meta.durationSec,
      },
      resolved: { url: finalUrl, hops },
    }
  }

  const reason = metaError ? `（落地页请求失败：${metaError}）` : ''
  return {
    ok: false,
    error:
      '抖音分享页在未登录状态下不提供标题/作者/封面：实测 _ROUTER_DATA 仅含页面上下文，' +
      'iteminfo 接口要求 encrypt_data 签名（11110），aweme/detail 被 Argus 安全插件拦截（403）' +
      `，只能解析出视频 ID 与标准链接${reason}`,
    item: fallbackItem,
    resolved: { url: finalUrl, hops },
  }
}

// ---------------------------------------------------------------------------
// 抖音「稍后再看」
// ---------------------------------------------------------------------------

/** 抖音 cookie 规整：整段 Cookie 直接用；只给 sessionid 值时自动补全。 */
export function buildDouyinCookieHeader(cookie) {
  if (typeof cookie !== 'string') return null
  const cleaned = cookie
    .replace(/\r?\n/g, '; ')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s*;\s*/g, '; ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return null
  if (cleaned.includes('=')) return cleaned.replace(/^;\s*/, '').replace(/;\s*$/, '')
  return `sessionid=${cleaned}`
}

/** 抖音 status_code -> 可读中文错误。status_code===0 返回 null。 */
export function mapDouyinStatusCode(code, message) {
  const num = Number(code)
  if (num === 0) return null
  const suffix = message && String(message).trim() ? `（接口信息：${message}）` : ''
  switch (num) {
    case 8:
      return `抖音 cookie 已失效或未登录（status_code=8，用户未登录），请重新粘贴 douyin.com 的完整 Cookie${suffix}`
    case 11110:
      return `抖音接口要求加密签名（status_code=11110 encrypt_data_miss），无法直接调用${suffix}`
    case 2154:
      return `抖音请求被风控拦截（status_code=2154），请稍后重试${suffix}`
    default:
      return `抖音接口返回错误（status_code=${code}${message ? `，message=${message}` : ''}）`
  }
}

export function mapDouyinHttpStatus(status) {
  if (status === 403) return '抖音拒绝访问（HTTP 403），可能被风控，请稍后重试'
  if (status === 429) return '抖音请求过于频繁（HTTP 429），请稍后再试'
  return `抖音接口返回 HTTP ${status}`
}

function unixSecondsToIso(value) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return null
  const date = new Date(num * 1000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/**
 * 纯函数：单条抖音 aweme -> 契约 items 项。
 * 兼容 item 直接是 aweme、或包了 aweme/aweme_info/item 字段两种结构。
 */
export function mapDouyinAweme(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const aweme = raw.aweme || raw.aweme_info || raw.item || raw
  const id = firstString(
    aweme.aweme_id,
    aweme.awemeId,
    aweme.item_id,
    aweme.itemId,
    raw.aweme_id,
    raw.item_id,
  )
  if (!id) return null
  const title = firstString(aweme.desc, aweme.preview_title, aweme.title) || `抖音视频 ${id}`
  const authorNode = aweme.author || raw.author
  const author = firstString(
    authorNode && authorNode.nickname,
    authorNode && authorNode.name,
    aweme.nickname,
  )
  const video = aweme.video || {}
  const cover = pickCover(video.cover || video.origin_cover || video.dynamic_cover || aweme.cover)
  const durationSec = toDurationSec(video.duration != null ? video.duration : aweme.duration)
  const addedAt = unixSecondsToIso(
    raw.add_time != null
      ? raw.add_time
      : raw.watch_later_time != null
        ? raw.watch_later_time
        : aweme.create_time != null
          ? aweme.create_time
          : raw.create_time,
  )
  return {
    remoteId: String(id),
    title: title.length > 200 ? `${title.slice(0, 200)}…` : title,
    url: `https://www.douyin.com/video/${id}`,
    cover,
    author,
    durationSec,
    addedAt,
  }
}

/**
 * 纯函数：解析 watchlater/list 返回体。
 * @returns {{ ok:boolean, items:Array, hasMore?:boolean, nextOffset?:number|null, error?:string }}
 */
export function parseDouyinWatchLaterResponse(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, items: [], error: '抖音接口返回空响应（可能被风控拦截，请稍后重试）' }
  }
  const code = Number(payload.status_code)
  if (code !== 0) {
    return { ok: false, items: [], error: mapDouyinStatusCode(code, payload.status_msg) }
  }
  const rawItems = Array.isArray(payload.items)
    ? payload.items
    : Array.isArray(payload.aweme_list)
      ? payload.aweme_list
      : []
  const items = []
  for (const raw of rawItems) {
    const mapped = mapDouyinAweme(raw)
    if (mapped) items.push(mapped)
  }
  const offset = Number(payload.offset)
  return {
    ok: true,
    items,
    hasMore: payload.has_more === true || payload.has_more === 1,
    nextOffset: Number.isFinite(offset) ? offset + rawItems.length : null,
  }
}

/**
 * 拉取抖音「稍后再看」。
 *
 * 实测：网页端存在 /aweme/v1/web/watchlater/list/（未登录返回 status_code=0 + items:null），
 * 且 profile/self 返回 user_watchlater_count —— 说明这是需要登录的能力，不是伪造数据。
 * 无 cookie 时返回 supported:true + 可读错误；cookie 失效时通过 profile/self 明确识别（status_code=8）。
 *
 * @param {{ cookie?:string, signal?:AbortSignal }} [options]
 * @returns {Promise<{ ok:boolean, supported:boolean, items:Array, account?:string|null, error?:string }>}
 */
export async function fetchWatchLater({ cookie, signal } = {}) {
  const cookieHeader = buildDouyinCookieHeader(cookie)
  if (!cookieHeader) {
    return {
      ok: false,
      supported: true,
      items: [],
      error:
        '未配置抖音 cookie。抖音「稍后再看」是网页登录能力（实测接口存在但需要登录），' +
        '请在同步设置里粘贴 douyin.com 登录后的完整 Cookie（至少含 sessionid）',
    }
  }
  if (signal && signal.aborted) {
    return { ok: false, supported: true, items: [], error: '同步已取消' }
  }

  const headers = {
    'User-Agent': UA,
    Referer: DOUYIN_REFERER,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Cookie: cookieHeader,
  }

  // 1) 先用 profile/self 验证登录，避免把“cookie 失效”误判成“列表为空”
  let account = null
  try {
    const meRes = await request(PROFILE_SELF_URL, { headers, signal })
    if (meRes.status < 200 || meRes.status >= 300) {
      return { ok: false, supported: true, items: [], error: mapDouyinHttpStatus(meRes.status) }
    }
    const mePayload = await meRes.json()
    if (!mePayload || typeof mePayload !== 'object') {
      return { ok: false, supported: true, items: [], error: '抖音账号接口返回结构异常（可能被风控）' }
    }
    const meCode = Number(mePayload.status_code)
    if (meCode !== 0) {
      return {
        ok: false,
        supported: true,
        items: [],
        error: mapDouyinStatusCode(meCode, mePayload.status_msg),
      }
    }
    if (!mePayload.user) {
      return {
        ok: false,
        supported: true,
        items: [],
        error: '抖音 cookie 已失效或未登录（profile/self 未返回用户信息），请重新粘贴 Cookie',
      }
    }
    account =
      firstString(mePayload.user.nickname, mePayload.user.unique_id, mePayload.user.sec_uid) || null
  } catch (err) {
    return { ok: false, supported: true, items: [], error: describeRequestError(err) }
  }

  // 2) 分页拉列表（最多 5 页 / 100 条）
  const collected = []
  const seen = new Set()
  let offset = 0
  for (let page = 0; page < MAX_PAGES && collected.length < MAX_ITEMS; page += 1) {
    const params = new URLSearchParams({
      device_platform: 'webapp',
      aid: '6383',
      channel: 'channel_pc_web',
      version_code: '170400',
      count: String(PAGE_SIZE),
      offset: String(offset),
    })
    let res
    try {
      res = await request(`${WATCHLATER_URL}?${params.toString()}`, { headers, signal })
    } catch (err) {
      return { ok: false, supported: true, items: collected, error: describeRequestError(err) }
    }
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, supported: true, items: collected, error: mapDouyinHttpStatus(res.status) }
    }
    let payload
    try {
      payload = await res.json()
    } catch (err) {
      return { ok: false, supported: true, items: collected, error: describeRequestError(err) }
    }
    const parsed = parseDouyinWatchLaterResponse(payload)
    if (!parsed.ok) {
      return { ok: false, supported: true, items: collected, error: parsed.error }
    }
    let added = 0
    for (const item of parsed.items) {
      if (seen.has(item.remoteId)) continue
      seen.add(item.remoteId)
      collected.push(item)
      added += 1
    }
    if (!parsed.hasMore || parsed.items.length === 0 || added === 0) break
    offset = Number.isFinite(parsed.nextOffset) ? parsed.nextOffset : offset + parsed.items.length
  }

  return { ok: true, supported: true, items: collected.slice(0, MAX_ITEMS), account }
}

export default { parseShareText, resolveShareUrl, fetchWatchLater }
