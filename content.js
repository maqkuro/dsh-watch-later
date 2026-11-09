/**
 * 内容直读：把「稍后再看」里的一条内容抓成可在面板内直接查看的形态。
 *
 * - 图片：直接用本地 media / 封面；
 * - B站：公开 view 接口补标题、封面、简介、时长，并给出官方内嵌播放器地址；
 * - 抖音：无公开内嵌播放器，返回封面 + 原视频链接；
 * - 公众号/普通文章/链接：抓 HTML，提取正文纯文本（只存文本，渲染端不注入 HTML）+ 内容图；
 * - 小红书通常 403：返回可读 error，仍可从原文打开。
 *
 * 结果是纯数据（Content），缓存到 item.content 由调用方负责；这里不做存储。
 * 所有网络失败都降级为 { error }，不抛异常。
 */
import { request, UA, MOBILE_UA } from './sync/http.js'
import { getCookie, saveMediaBytes, MAX_IMAGES as MAX_ITEM_IMAGES } from './store.js'
import { fetchPageViaBrowser } from './login/chrome-login.js'
import { fetchWechatHtmlViaBsk } from './wechat.js'
import { classifyUrl } from './score.js'
import { isXhsCoolingDown, xhsCooldownError, waitXhsTurn, xhsFetchBlocked, xhsFetchSucceeded } from './xhs-guard.js'

export const CONTENT_TTL_MS = 7 * 86400e3
const MAX_TEXT = 20000
const MAX_IMAGES = 6
const FETCH_TIMEOUT_MS = 12000

function nowIso() {
  return new Date().toISOString()
}

function emptyContent(type, error) {
  return { type, text: null, images: [], video: null, fetchedAt: nowIso(), error: error || null }
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d{2,6});/g, (_, code) => {
      const value = Number(code)
      return Number.isFinite(value) && value >= 32 ? String.fromCharCode(value) : ' '
    })
    .replace(/&#x([0-9a-f]{2,6});/gi, (_, code) => {
      const value = Number.parseInt(code, 16)
      return Number.isFinite(value) && value >= 32 ? String.fromCharCode(value) : ' '
    })
}

function absoluteUrl(src, base) {
  try {
    const url = new URL(src, base)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href
  } catch {
    return null
  }
  return null
}

export function extractImages(html, baseUrl) {
  const out = []
  const source = String(html || '')
  const pattern = /<img\b[^>]*?(?:data-src|data-original|src)\s*=\s*["']([^"']+)["'][^>]*>/gi
  let match
  while ((match = pattern.exec(source)) && out.length < MAX_IMAGES * 2) {
    const resolved = absoluteUrl(decodeEntities(match[1] || '').trim(), baseUrl)
    if (!resolved) continue
    if (/\.(svg)(\?|$)/i.test(resolved)) continue
    if (out.includes(resolved)) continue
    out.push(resolved)
    if (out.length >= MAX_IMAGES) break
  }
  return out
}

/**
 * 公众号「全屏长图」类文章（写真 / 漫画 / 图集）不走 <img>，图片地址直接写在
 * CSS 背景或内联 JSON 里。这类页面 <img> 一个都没有，只能直扫微信图床域名。
 */
export function extractWechatCdnImages(html) {
  const out = []
  const pattern = /https?:\/\/(?:mmbiz\.qpic\.cn|mmbiz\.qlogo\.cn)\/[^\s"'()\\<>]+/gi
  let match
  while ((match = pattern.exec(String(html || ''))) && out.length < MAX_IMAGES) {
    const url = match[0].replace(/&amp;/g, '&')
    if (!out.includes(url)) out.push(url)
  }
  return out
}

/** 文章分享图（og:image）通常就是编辑选的封面图，优先级高于正文第一张配图。 */
export function extractOgImage(html, baseUrl) {
  const source = String(html || '')
  const patterns = [
    /<meta[^>]+(?:property|name)\s*=\s*["']og:image["'][^>]*content\s*=\s*["']([^"']+)["']/i,
    /<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]*(?:property|name)\s*=\s*["']og:image["']/i,
    /<meta[^>]+(?:property|name)\s*=\s*["']twitter:image["'][^>]*content\s*=\s*["']([^"']+)["']/i,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(source)
    if (!match) continue
    const resolved = absoluteUrl(decodeEntities(match[1] || '').trim(), baseUrl)
    if (resolved) return resolved
  }
  return null
}

function cleanHtml(html) {
  return String(html || '')
    .replace(/<(script|style|noscript|svg|iframe|form|button|nav|header|footer|aside)[\s\S]*?<\/\1>/gi, ' ')
    .replace(
      /<div[^>]*(?:class|id)\s*=\s*["'][^"']*(?:footer|nav|comment|related|recommend|sidebar|advert|banner|toolbar|qrcode|qr_code|reward|rich_media_area_extra|rich_media_tool|original_area|share|follow)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
      ' ',
    )
}

function stripTags(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
}

function tidyText(text, limit = MAX_TEXT) {
  const cleaned = String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return cleaned.length > limit ? cleaned.slice(0, limit) : cleaned
}

export function extractArticleText(html, kind) {
  const source = cleanHtml(html)
  const candidates = []
  if (kind === 'wechat') {
    const start = source.search(/<(?:div|section)[^>]*(?:id=["']js_content["']|class=["'][^"']*rich_media_content)[^>]*>/i)
    if (start >= 0) candidates.push(source.slice(start))
  }
  const article = /<article[^>]*>([\s\S]*?)<\/article>/i.exec(source)
  if (article) candidates.push(article[1])
  const main = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(source)
  if (main) candidates.push(main[1])
  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(source)
  if (body) candidates.push(body[1])
  candidates.push(source)
  let best = ''
  for (const candidate of candidates) {
    const text = tidyText(stripTags(candidate))
    if (text.length > best.length) best = text
    if (kind === 'wechat' && text.length > 2000) break
  }
  return best.slice(0, MAX_TEXT)
}

async function fetchPage(url, cookie, ua) {
  const headers = {
    'user-agent': ua || UA,
    accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    referer: new URL(url).origin + '/',
  }
  if (cookie) headers.cookie = cookie
  const response = await request(url, { headers, timeoutMs: FETCH_TIMEOUT_MS })
  if (response.status < 200 || response.status >= 400) {
    throw new Error('页面返回 HTTP ' + response.status)
  }
  const contentType = String(
    (response.headers && (response.headers.get ? response.headers.get('content-type') : response.headers['content-type'])) || '',
  )
  return { html: await response.text(), contentType, finalUrl: response.url || url }
}

function looksLikeWechatVerify(html) {
  return /secitptpage\/verify|未知错误|环境异常|请在微信客户端打开/i.test(String(html || ''))
}

function textFromJson(text) {
  try {
    const data = JSON.parse(text)
    const parts = []
    const walk = (value, depth) => {
      if (depth > 4 || parts.length > 40) return
      if (typeof value === 'string') {
        const clean = value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        if (clean.length >= 8 && clean.length <= 4000) parts.push(clean)
        return
      }
      if (Array.isArray(value)) {
        for (const entry of value.slice(0, 20)) walk(entry, depth + 1)
        return
      }
      if (value && typeof value === 'object') {
        for (const key of Object.keys(value).slice(0, 30)) {
          if (/^(title|desc|description|content|text|summary|share_title|share_desc)$/i.test(key)) walk(value[key], depth + 1)
        }
      }
    }
    walk(data, 0)
    return parts.join('\n').slice(0, MAX_TEXT)
  } catch {
    return ''
  }
}

function bvidOf(url) {
  const match = /(BV[0-9A-Za-z]{10})/.exec(String(url || ''))
  return match ? match[1] : null
}

async function bilibiliContent(item) {
  const bvid = bvidOf(item.url)
  if (!bvid) {
    return { ...emptyContent('video'), error: '没有识别出 B 站视频号（BV 号）' }
  }
  const response = await request('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
    timeoutMs: FETCH_TIMEOUT_MS,
  })
  const data = await response.json()
  if (!data || data.code !== 0 || !data.data) {
    return { ...emptyContent('video'), error: 'B站接口未返回视频信息（可能受限）' }
  }
  const view = data.data
  const cover = typeof view.pic === 'string' ? view.pic.replace(/^http:\/\//i, 'https://') : item.cover || null
  const duration = Number(view.duration)
  const durationText = Number.isFinite(duration)
    ? Math.floor(duration / 60) + '分' + String(Math.round(duration % 60)).padStart(2, '0') + '秒'
    : null
  const textParts = []
  if (view.desc && String(view.desc).trim()) textParts.push(String(view.desc).trim())
  const owner = view.owner && view.owner.name ? 'UP主：' + view.owner.name : null
  if (owner) textParts.push(owner)
  if (durationText) textParts.push('时长：' + durationText)
  return {
    type: 'video',
    text: tidyText(textParts.join('\n'), 4000) || null,
    images: cover ? [cover] : [],
    video: {
      embedUrl: 'https://player.bilibili.com/player.html?bvid=' + bvid + '&autoplay=0',
      url: item.url,
      cover,
      durationSec: Number.isFinite(duration) ? duration : null,
    },
    fetchedAt: nowIso(),
    error: null,
  }
}

async function douyinContent(item) {
  return {
    type: 'video',
    text: item.summary || (item.raw ? String(item.raw).slice(0, 800) : null),
    images: item.cover ? [item.cover] : [],
    video: { embedUrl: null, url: item.url, cover: item.cover || null, durationSec: null },
    fetchedAt: nowIso(),
    error: '抖音没有公开的内嵌播放器，点「打开原视频」在抖音里看',
  }
}

/** 小红书的 sec 风控会 302 到 /404/sec_*；这种页面不是「笔记不存在」，退避后可以重试。 */
export function isXhsBlockedPage(html, finalUrl) {
  const url = String(finalUrl || '')
  if (/\/404\/sec_|\/website-login\/|\/captcha/i.test(url)) return true
  const source = String(html || '')
  if (/noteData\.data\.noteData|noteDetailMap/.test(source)) return false
  return /xhs_sec_server|notFoundPage/.test(source)
}

function xhsNoteId(url) {
  const match = /(?:explore|discovery\/item|note)\/([0-9a-zA-Z]+)/.exec(String(url || ''))
  return match ? match[1] : null
}

/** 从 text[start] 起按括号配对切出第一段完整 JSON（跳过字符串里的括号），比非贪婪正则可靠。 */
function sliceBalancedObject(text, start) {
  let i = start
  while (i < text.length && text[i] !== '{') {
    if (!/\s/.test(text[i])) return null
    i += 1
  }
  if (i >= text.length) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let j = i; j < text.length; j += 1) {
    const ch = text[j]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(i, j + 1)
    }
  }
  return null
}

export function parseXiaohongshuState(html) {
  const source = String(html || '')
  const marker = /window\.__INITIAL_STATE__\s*=\s*/i.exec(source)
  if (!marker) return null
  const raw = sliceBalancedObject(source, marker.index + marker[0].length)
  if (!raw) return null
  try {
    return JSON.parse(raw.replace(/\bundefined\b/g, 'null'))
  } catch {
    return null
  }
}

/**
 * 从小红书两种页面形态里取笔记本体：
 *   1. PC 版（需要登录态）：state.note.noteDetailMap[<noteId>].note
 *   2. 手机分享页（免登录）：state.noteData.data.noteData —— 标题 / desc / imageList / user 都在这里
 * 原因：同一个分享链接给 PC UA 只返回首页（没有笔记数据），给手机 UA 才会带 noteData。
 */
export function xhsNoteFromState(state, noteId) {
  if (!state || typeof state !== 'object') return null
  const map = state.note && state.note.noteDetailMap
  if (map && typeof map === 'object') {
    if (noteId && map[noteId] && map[noteId].note) return map[noteId].note
    for (const key of Object.keys(map)) {
      if (map[key] && map[key].note) return map[key].note
    }
  }
  const mobile = state.noteData && state.noteData.data && state.noteData.data.noteData
  if (mobile && typeof mobile === 'object') {
    const id = String(mobile.noteId || '')
    const usable = Boolean(mobile.imageList || mobile.desc || mobile.title)
    if (usable && (!noteId || !id || id === noteId)) return mobile
  }
  const preload = state.noteData && state.noteData.normalNotePreloadData
  if (preload && typeof preload === 'object' && (preload.imagesList || preload.desc || preload.title)) {
    return { title: preload.title, desc: preload.desc, imageList: preload.imagesList, user: preload.user }
  }
  return null
}

function xhsImages(note) {
  const urls = []
  const push = (value) => {
    if (typeof value !== 'string') return
    let url = value.startsWith('//') ? 'https:' + value : value
    if (!/^https?:\/\//i.test(url)) return
    if (!urls.includes(url)) urls.push(url)
  }
  const list = Array.isArray(note && note.imageList) ? note.imageList : []
  for (const image of list) {
    if (typeof image === 'string') {
      push(image)
      continue
    }
    if (!image || typeof image !== 'object') continue
    push(image.urlDefault)
    push(image.urlPre)
    push(image.url)
    for (const info of Array.isArray(image.infoList) ? image.infoList : []) push(info && info.url)
    if (urls.length >= MAX_IMAGES) break
  }
  // 极少数笔记只有 cover（图集为空 / 视频笔记），也拿它当封面
  const cover = note && note.cover
  if (urls.length === 0 && cover && typeof cover === 'object') {
    push(cover.urlDefault)
    push(cover.urlPre)
    push(cover.url)
  }
  return urls.slice(0, MAX_IMAGES)
}

const MAX_XHS_IMAGES = 9

/**
 * 按真实字节判断图片格式。小红书图床的 URL 一律写 `!h5_1080jpg`，但回包常常是 WebP
 * （accept 里带 image/webp 就给 webp），按扩展名存会得到「.jpg 里装 WebP」——
 * 浏览器渲染/后续转码都容易踩坑，所以这里嗅探文件头。
 */
function sniffImageExtension(bytes) {
  if (!bytes || bytes.length < 12) return '.jpg'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return '.png'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return '.gif'
  if (bytes.slice(0, 4).toString('latin1') === 'RIFF' && bytes.slice(8, 12).toString('latin1') === 'WEBP') return '.webp'
  return '.jpg'
}

/** 把小红书图床图片落到本地媒体库（外链在面板里常被防盗链）。 */
async function mirrorRemoteImages(urls) {
  const local = []
  for (const url of urls.slice(0, MAX_XHS_IMAGES)) {
    try {
      const response = await request(url, {
        headers: {
          'user-agent': MOBILE_UA,
          referer: 'https://www.xiaohongshu.com/',
          accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        },
        timeoutMs: 12000,
      })
      if (!response.ok) continue
      const bytes = await response.bytes()
      if (!bytes || bytes.length < 512) continue
      const media = saveMediaBytes(bytes, sniffImageExtension(bytes))
      if (media && media.url) local.push(media.url)
    } catch {
      // 单张失败就跳过
    }
  }
  return local
}

async function xiaohongshuContent(item) {
  const cookie = getCookie('xiaohongshu')
  const noteId = xhsNoteId(item.url)
  let note = null
  let lastError = null
  let blocked = false
  let ogImage = null

  // 风控冷却期内直接返回可重试错误：不打网络、不占额度、不写失效。
  if (isXhsCoolingDown()) {
    const hasImages = Array.isArray(item.images) && item.images.length > 0
    return {
      ...emptyContent('page', xhsCooldownError()),
      text: (item.content && item.content.text) || item.summary || null,
      images: hasImages ? item.images : item.cover ? [item.cover] : [],
    }
  }

  // 0) 手机 UA 直取分享页：同一链接 PC UA 只会拿到首页（没有笔记数据），手机 UA 会带上
  //    noteData.data.noteData（标题 / 正文 / imageList 图集），免登录，1 秒内返回。
  try {
    await waitXhsTurn()
    const mobilePage = await fetchPage(item.url, cookie || undefined, MOBILE_UA)
    note = xhsNoteFromState(parseXiaohongshuState(mobilePage.html), noteId)
    if (!note) {
      if (isXhsBlockedPage(mobilePage.html, mobilePage.finalUrl)) {
        blocked = true
        xhsFetchBlocked()
        lastError = '小红书风控拦截（sec_404），已进入冷却，稍后自动重试'
      } else {
        lastError = '手机分享页没有笔记数据'
        ogImage = extractOgImage(mobilePage.html, item.url)
      }
    }
  } catch (error) {
    lastError = String(error?.message || error)
  }

  // 已经吃风控了就别换通道继续撞：同一个 IP，换 UA 只会把冷却拉长。
  if (blocked && !note) {
    return {
      ...emptyContent('page', '小红书风控拦截（sec_404），已进入冷却，稍后自动重试'),
      text: (item.content && item.content.text) || item.summary || null,
      images: Array.isArray(item.images) && item.images.length > 0 ? item.images : item.cover ? [item.cover] : [],
    }
  }

  // 1) 主人已登录的 Chrome（BrowserSkill）：小红书对 Node fetch / 无头浏览器按登录态+指纹拦截，
  //    只有真人会话能拿到页面里的 __INITIAL_STATE__（真图 + 正文）。实测 1-2 秒/条。
  if (!note) {
    try {
      const viaBsk = await fetchWechatHtmlViaBsk(item.url, { timeoutMs: 30000 })
      if (viaBsk.ok && viaBsk.html) {
        note = xhsNoteFromState(parseXiaohongshuState(viaBsk.html), noteId)
        if (!note) lastError = '小红书页面没有笔记数据（可能未登录或笔记已下架）'
      } else if (viaBsk.error) {
        lastError = lastError || viaBsk.error
      }
    } catch (error) {
      lastError = lastError || String(error?.message || error)
    }
  }

  // 2) 无头 Chrome 兜底
  if (!note) {
    try {
      const rendered = await fetchPageViaBrowser({ url: item.url, provider: 'xiaohongshu' })
      if (rendered.ok && rendered.html) {
        note = xhsNoteFromState(parseXiaohongshuState(rendered.html), xhsNoteId(item.url))
      } else if (rendered.error) {
        lastError = lastError || rendered.error
      }
    } catch (error) {
      lastError = lastError || String(error?.message || error)
    }
  }

  if (!note) {
    try {
      const page = await fetchPage(item.url, cookie || undefined)
      note = xhsNoteFromState(parseXiaohongshuState(page.html), xhsNoteId(item.url))
    } catch (error) {
      lastError = lastError || String(error?.message || error)
    }
  }

  if (!note) {
    const fallbackImages = ogImage ? await mirrorRemoteImages([ogImage]) : []
    return {
      ...emptyContent('page'),
      text: item.summary || null,
      images: fallbackImages.length > 0 ? fallbackImages : ogImage ? [ogImage] : [],
      error:
        (lastError ? '小红书正文抓取失败：' + lastError + '；' : '') +
        (blocked
          ? '小红书风控拦截，稍后自动重试'
          : '可以点「打开原文」查看，或在右上角「登录授权」登录后重试'),
    }
  }

  const parts = []
  if (note.title) parts.push(String(note.title).trim())
  if (note.desc) parts.push(String(note.desc).trim())
  const nickname = note.user ? String(note.user.nickname || note.user.nickName || '').trim() || null : null
  if (nickname) parts.push('作者：' + nickname)
  if (Array.isArray(note.tagList)) {
    const tags = note.tagList.map((tag) => (tag && tag.name) || '').filter(Boolean).slice(0, 6)
    if (tags.length) parts.push('标签：' + tags.join(' / '))
  }
  const text = tidyText(parts.join('\n'), MAX_TEXT)
  xhsFetchSucceeded()
  const remoteImages = xhsImages(note)
  const localImages = remoteImages.length > 0 ? await mirrorRemoteImages(remoteImages) : []
  return {
    type: text.length > 400 ? 'article' : 'page',
    text: text || null,
    images: localImages.length > 0 ? localImages : remoteImages,
    video: null,
    fetchedAt: nowIso(),
    error: text ? null : '小红书笔记没有正文内容（可能只有图片），点「打开原文」查看',
  }
}

async function pageContent(item) {
  const kind = item.kind || classifyUrl(item.url).kind
  const fallbackText = [item.summary, item.raw, item.notes].filter(Boolean).join('\n').slice(0, 4000) || null
  let page = null
  let fetchError = null
  try {
    page = await fetchPage(item.url)
  } catch (error) {
    fetchError = String(error?.message || error)
  }

  // 公众号文章：微信会按文章做风控，直连经常 302 到验证页。统一补一条真浏览器通道
  // （BrowserSkill：借主人已登录的 Chrome 会话进场），拿到 HTML 后走同一套解析。
  let via = null
  let wechatBrowserError = null
  if (kind === 'wechat') {
    const blocked = !page || looksLikeWechatVerify(page.html)
    const thin = !blocked && extractArticleText(page.html, 'wechat').length < 120
    if (blocked || thin) {
      const viaBsk = await fetchWechatHtmlViaBsk(item.url)
      if (viaBsk.ok) {
        page = { html: viaBsk.html, contentType: 'text/html', finalUrl: item.url }
        via = 'bsk'
      } else {
        wechatBrowserError = viaBsk.error || null
      }
    }
  }

  if (!page) {
    return {
      ...emptyContent(kind === 'xhs' ? 'page' : 'article'),
      text: fallbackText,
      error:
        kind === 'xhs'
          ? '小红书不支持直接抓正文，请点开原文'
          : [fetchError, wechatBrowserError, '点「打开原文」查看'].filter(Boolean).join('；'),
    }
  }
  if (/^\s*[[{]/.test(page.html) || /json/.test(page.contentType)) {
    const jsonText = textFromJson(page.html)
    return {
      type: 'page',
      text: jsonText || fallbackText,
      images: [],
      video: null,
      fetchedAt: nowIso(),
      error: jsonText ? null : '这个链接返回的是数据接口，没有可读正文；点「打开原文」查看',
    }
  }
  if (kind === 'wechat' && looksLikeWechatVerify(page.html)) {
    return {
      ...emptyContent('article'),
      text: fallbackText,
      error:
        '微信文章被官网验证页拦截' +
        (wechatBrowserError ? '，浏览器通道也没过：' + wechatBrowserError : '') +
        '；已显示标题/摘要，点「打开原文」查看全文',
    }
  }
  const type = kind === 'wechat' || kind === 'article' ? 'article' : 'page'
  let text = extractArticleText(page.html, kind === 'wechat' ? 'wechat' : 'normal')
  const pageImages = extractImages(page.html, page.finalUrl || item.url)
  const ogImage = extractOgImage(page.html, page.finalUrl || item.url)
  let images = ogImage ? [ogImage, ...pageImages.filter((url) => url !== ogImage)] : pageImages
  if (kind === 'wechat' && images.length === 0) {
    images = extractWechatCdnImages(page.html)
  }
  if (text.length < 120) {
    if (kind === 'xhs') {
      return {
        type: 'page',
        text: fallbackText,
        images,
        video: null,
        fetchedAt: nowIso(),
        error: '小红书不支持直接抓正文（返回的是登录/首页页），请点开原文',
      }
    }
    // 纯图片类公众号文章（写真 / 漫画 / 图集）本来就没有正文，浏览器通道确认页面正常时
    // 抓到图就算成功，不该判成「没有提取到正文」。
    if (kind === 'wechat' && via === 'bsk' && images.length > 0) {
      return { type: 'image', text: text || null, images, video: null, fetchedAt: nowIso(), error: null, via }
    }
    text = text || ''
  }
  const result = {
    type,
    text: text || fallbackText,
    images,
    video: null,
    fetchedAt: nowIso(),
    error: text.length >= 120 ? null : '没有提取到正文（可能是动态页面或需要登录），点「打开原文」查看',
  }
  if (via) result.via = via
  return result
}

export function isContentFresh(content) {
  if (!content || !content.fetchedAt) return false
  const at = Date.parse(content.fetchedAt)
  return Number.isFinite(at) && Date.now() - at < CONTENT_TTL_MS
}

/**
 * 缓存里存的是「被微信验证页拦住」这类错误时，不能算作已抓取——
 * 否则接了浏览器通道之后，老条目会一直命中缓存、永远不重试。
 */
export function contentNeedsRetry(content) {
  if (!content || typeof content !== 'object') return true
  const error = String(content.error || '')
  if (!error) return false
  // 笔记/文章已经被作者删了：再怎么重试都是 404，别每次都开一次浏览器去撞
  if (/已删除|页面不见了|笔记不存在/i.test(error)) return false
  return /验证页|环境异常|wappoc|微信文章.*拦截|secitptpage|sec_404|风控/i.test(error)
}

/**
 * Resolve the viewable content for one item.
 * Returns Content; failures are represented by `error` instead of throwing.
 */
export async function resolveContent(item, options = {}) {
  if (!item || typeof item !== 'object') return emptyContent('none', '条目不存在')
  if (!options.force && isContentFresh(item.content) && !contentNeedsRetry(item.content)) return item.content
  const kind = item.kind || (item.url ? classifyUrl(item.url).kind : 'other')
  try {
    if (kind === 'image') {
      const list = Array.isArray(item.images) && item.images.length > 0 ? item.images : [item.cover]
      const images = list.filter(Boolean).slice(0, MAX_ITEM_IMAGES)
      return {
        type: 'image',
        text: item.summary || null,
        images,
        video: null,
        fetchedAt: nowIso(),
        error: images.length ? null : '这张图片没有本地副本',
      }
    }
    if (!item.url) {
      return {
        type: 'none',
        text: item.summary || item.raw || item.notes || null,
        images: [],
        video: null,
        fetchedAt: nowIso(),
        error: null,
      }
    }
    if (kind === 'bilibili') return await bilibiliContent(item)
    if (kind === 'douyin') return await douyinContent(item)
    if (kind === 'xhs') return await xiaohongshuContent(item)
    return await pageContent(item)
  } catch (error) {
    return emptyContent('none', String(error?.message || error))
  }
}
