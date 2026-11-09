/**
 * 封面兜底：抓站点图标（favicon）或生成一张 SVG 封面，让列表里不再出现“空白无封面”的图文条目。
 *
 * - faviconCover(item)：只对 http(s) 链接类条目尝试，按域名缓存，只接受常见位图格式；
 * - generatedCover(item)：生成 600×375 的品牌感 SVG 封面（按内容类型配色 + 标题字 + 来源），
 *   存进媒体库后作为 cover，和普通封面一样可显示/可推送。
 */
import { request, UA } from './sync/http.js'
import { saveMediaBytes } from './store.js'
import { fetchPageViaBrowser } from './login/chrome-login.js'

const FAVICON_CACHE = new Map() // host -> url | null
const MAX_ICON_BYTES = 512 * 1024
const ICON_TIMEOUT_MS = 8000

const PALETTES = {
  xhs: ['#F53B57', '#7B1E3B'],
  wechat: ['#07C160', '#0B5E3B'],
  bilibili: ['#00A1D6', '#0B3A5C'],
  douyin: ['#1F2233', '#3F456B'],
  video: ['#7C4DFF', '#2E1B5B'],
  link: ['#2F80ED', '#123B6E'],
  article: ['#2F80ED', '#123B6E'],
  product: ['#F2994A', '#5C2E0F'],
  drama: ['#EB5757', '#4A1B1B'],
  game: ['#9B51E0', '#2C1B3D'],
  image: ['#9CA3AF', '#374151'],
  other: ['#6B7280', '#1F2937'],
}

const KIND_TEXT = {
  xhs: '小红书',
  wechat: '公众号',
  bilibili: 'B站',
  douyin: '抖音',
  video: '视频',
  link: '链接',
  article: '文章',
  product: '好物',
  drama: '剧集',
  game: '游戏',
  image: '图片',
  other: '内容',
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function initialsOf(title) {
  const text = String(title || '')
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[「」『』【】《》（）()\[\]<>·—\-_,，。!！?？:：;；'"“”‘’]/g, '')
    .trim()
  if (!text) return '·'
  const cjk = text.match(/[\u4e00-\u9fa5]/g) || []
  if (cjk.length >= 2) return cjk.slice(0, 2).join('')
  if (cjk.length === 1) return cjk[0]
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return text.slice(0, 2).toUpperCase()
}

/** 生成一张可直接落盘的 SVG 封面（不含外部资源、不含脚本）。 */
export function generatedCoverSvg(item) {
  const kind = item && typeof item.kind === 'string' && PALETTES[item.kind] ? item.kind : 'other'
  const palette = PALETTES[kind]
  const title = item && item.title ? String(item.title) : ''
  const site = item && item.site ? String(item.site) : ''
  const initials = escapeXml(initialsOf(title))
  const siteText = escapeXml(site || KIND_TEXT[kind] || '稍后再看')
  const titleText = escapeXml(title.length > 26 ? title.slice(0, 26) + '…' : title)
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="375" viewBox="0 0 600 375" role="img">',
    '<defs>',
    `<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${palette[0]}"/><stop offset="1" stop-color="${palette[1]}"/></linearGradient>`,
    '<radialGradient id="glow" cx="0.78" cy="0.18" r="0.6"><stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>',
    '</defs>',
    '<rect width="600" height="375" fill="url(#g)"/>',
    '<rect width="600" height="375" fill="url(#glow)"/>',
    '<g fill="none" stroke="#ffffff" stroke-opacity="0.10">',
    '<circle cx="520" cy="70" r="120"/><circle cx="520" cy="70" r="160"/><circle cx="70" cy="330" r="110"/><circle cx="70" cy="330" r="150"/>',
    '</g>',
    '<text x="44" y="58" fill="#ffffff" fill-opacity="0.78" font-family="PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif" font-size="18" letter-spacing="2">' + siteText + '</text>',
    '<text x="300" y="215" text-anchor="middle" fill="#ffffff" fill-opacity="0.92" font-family="PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif" font-size="112" font-weight="700">' + initials + '</text>',
    '<text x="44" y="336" fill="#ffffff" fill-opacity="0.8" font-family="PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif" font-size="22">' + titleText + '</text>',
    '<rect x="44" y="352" width="36" height="3" rx="1.5" fill="#ffffff" fill-opacity="0.55"/>',
    '</svg>',
  ].join('')
}

/** 生成并保存封面，返回媒体 URL（失败返回 null）。 */
export function generateCoverFor(item) {
  try {
    const svg = generatedCoverSvg(item)
    const media = saveMediaBytes(Buffer.from(svg, 'utf8'), '.svg')
    return media && media.url ? media.url : null
  } catch {
    return null
  }
}

function candidatesFromHtml(html, origin) {
  const candidates = []
  const push = (raw) => {
    const value = String(raw || '').replace(/&amp;/gi, '&').trim()
    if (!value) return
    try {
      const url = new URL(value, origin).href
      if (!candidates.includes(url)) candidates.push(url)
    } catch {
      // ignore invalid URL
    }
  }
  const ogPatterns = [
    /<meta[^>]+(?:property|name)\s*=\s*["']og:image["'][^>]*content\s*=\s*["']([^"']+)["']/i,
    /<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]*(?:property|name)\s*=\s*["']og:image["']/i,
    /<meta[^>]+(?:property|name)\s*=\s*["']twitter:image["'][^>]*content\s*=\s*["']([^"']+)["']/i,
  ]
  for (const pattern of ogPatterns) {
    const match = pattern.exec(String(html || ''))
    if (match) push(match[1])
  }
  const iconRegex = /<link[^>]+rel\s*=\s*["'][^"']*(?:apple-touch-icon|icon)[^"']*["'][^>]*href\s*=\s*["']([^"']+)["']/gi
  let iconMatch
  while ((iconMatch = iconRegex.exec(String(html || ''))) && candidates.length < 6) push(iconMatch[1])
  return candidates
}

/**
 * 文章页封面：优先 og:image / twitter:image，其次页面声明的 icon / apple-touch-icon。
 * 只认 png/jpeg/webp/gif/svg 图片；公众号交给 sogou.js，这里跳过。
 */
export async function pageCover(item, { signal } = {}) {
  let parsed
  try {
    parsed = new URL(String(item.url || ''))
  } catch {
    return null
  }
  if (!/^https?:$/.test(parsed.protocol)) return null
  if (parsed.host === 'mp.weixin.qq.com') return null
  let html = ''
  try {
    const response = await request(parsed.href, {
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      timeoutMs: 12000,
      signal,
    })
    if (!response.ok) return null
    html = await response.text()
  } catch {
    return null
  }
  if (!html || html.length < 200) return null
  const candidates = candidatesFromHtml(html, parsed.origin)
  if (candidates.length === 0) {
    // JS 渲染页（小黑盒/动态站点）：用无头 Chrome 再试一次，拿渲染后的 og:image
    try {
      const rendered = await fetchPageViaBrowser({ url: item.url, provider: 'xiaohongshu', timeoutMs: 15000 })
      if (rendered.ok && rendered.html) {
        for (const url of candidatesFromHtml(rendered.html, parsed.origin)) {
          if (!candidates.includes(url)) candidates.push(url)
        }
      }
    } catch {
      // ignore fallback failure
    }
  }
  for (const url of candidates.slice(0, 6)) {
    try {
      const response = await request(url, {
        headers: { 'user-agent': UA, accept: 'image/avif,image/webp,image/*,*/*;q=0.8', referer: parsed.origin + '/' },
        timeoutMs: 12000,
        signal,
      })
      if (!response.ok) continue
      const type = String(response.headers['content-type'] || '').toLowerCase()
      const bytes = await response.bytes()
      if (!bytes || bytes.length < 300 || bytes.length > 8 * 1024 * 1024) continue
      let extension = null
      if (type.includes('image/png')) extension = '.png'
      else if (type.includes('image/jpeg')) extension = '.jpg'
      else if (type.includes('image/webp')) extension = '.webp'
      else if (type.includes('image/gif')) extension = '.gif'
      else if (type.includes('image/svg')) extension = '.svg'
      if (!extension) continue
      const media = saveMediaBytes(bytes, extension)
      if (media && media.url) return media.url
    } catch {
      // try next candidate
    }
  }
  return null
}

function iconHost(item) {
  try {
    const parsed = new URL(String(item.url || ''))
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 尝试抓站点 favicon 作为封面。只接受 png/jpeg/webp/gif 位图，避免把任意 SVG/ICO 直接塞进 <img>。
 * @returns {Promise<string|null>} 媒体 URL 或 null
 */
export async function faviconCover(item) {
  const parsed = iconHost(item)
  if (!parsed) return null
  const host = parsed.host.toLowerCase()
  if (FAVICON_CACHE.has(host)) return FAVICON_CACHE.get(host)
  // 公众号文章用统一 favicon 没意义，直接走生成封面。
  if (host === 'mp.weixin.qq.com') {
    FAVICON_CACHE.set(host, null)
    return null
  }
  const candidates = [parsed.origin + '/favicon.ico']
  for (const url of candidates) {
    try {
      const response = await request(url, {
        headers: { 'user-agent': UA, accept: 'image/*,*/*;q=0.8' },
        timeoutMs: ICON_TIMEOUT_MS,
      })
      if (!response.ok) continue
      const type = String(response.headers['content-type'] || '').toLowerCase()
      const bytes = await response.bytes()
      if (!bytes || bytes.length < 200 || bytes.length > MAX_ICON_BYTES) continue
      let extension = null
      if (type.includes('image/png')) extension = '.png'
      else if (type.includes('image/jpeg')) extension = '.jpg'
      else if (type.includes('image/webp')) extension = '.webp'
      else if (type.includes('image/gif')) extension = '.gif'
      else if (type.includes('image/x-icon') || type.includes('image/vnd.microsoft.icon')) extension = null
      if (!extension) continue
      const media = saveMediaBytes(bytes, extension)
      const result = media && media.url ? media.url : null
      FAVICON_CACHE.set(host, result)
      return result
    } catch {
      // try next candidate
    }
  }
  FAVICON_CACHE.set(host, null)
  return null
}
