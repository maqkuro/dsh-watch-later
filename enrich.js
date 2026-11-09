/**
 * Best-effort metadata resolution for pasted links.
 *
 * Every function here is allowed to fail: the caller stores the item anyway
 * with whatever the heuristic extractor produced, and a missing preview is not
 * an error. Network calls are bounded (9s) and never throw out of resolvePreview.
 */
import { request, UA } from './sync/http.js'
import { resolveShareUrl as resolveDouyinShare } from './sync/douyin.js'
import { classifyUrl } from './score.js'

const TIMEOUT_MS = 9000

function decodeEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

function matchMeta(html, key) {
  const patterns = [
    new RegExp('<meta[^>]+(?:property|name)=["\']' + key + '["\'][^>]*content=["\']([^"\']*)["\']', 'i'),
    new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']' + key + '["\']', 'i'),
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(html)
    if (match && match[1]) return decodeEntities(match[1]).trim()
  }
  return null
}

function parseHtmlPreview(html, url) {
  const preview = {}
  const title = matchMeta(html, 'og:title') || matchMeta(html, 'twitter:title') || (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '').trim()
  if (title) preview.title = decodeEntities(title).slice(0, 200)
  const cover = matchMeta(html, 'og:image') || matchMeta(html, 'twitter:image')
  if (cover && /^https?:\/\//i.test(cover)) preview.cover = cover.replace(/^http:\/\//i, 'https://')
  const description = matchMeta(html, 'og:description') || matchMeta(html, 'description')
  if (description) preview.summary = decodeEntities(description).slice(0, 400)
  const author = matchMeta(html, 'author') || matchMeta(html, 'og:article:author')
  if (author) preview.author = decodeEntities(author).slice(0, 80)
  if (url) {
    const detected = classifyUrl(url)
    if (detected?.site) preview.site = detected.site
  }
  return preview
}

function extractBvid(url) {
  const match = /(BV[0-9A-Za-z]{10})/.exec(url)
  if (match) return match[1]
  const av = /\/av(\d+)/i.exec(url)
  if (av) return { aid: Number(av[1]) }
  return null
}

async function resolveBilibili(url) {
  const bvid = extractBvid(url)
  if (!bvid) return {}
  const query = typeof bvid === 'string' ? 'bvid=' + bvid : 'aid=' + bvid.aid
  const response = await request('https://api.bilibili.com/x/web-interface/view?' + query, {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
    timeoutMs: TIMEOUT_MS,
  })
  const data = await response.json()
  if (!data || data.code !== 0 || !data.data) return {}
  const view = data.data
  return {
    title: String(view.title || '').slice(0, 200) || undefined,
    cover: typeof view.pic === 'string' ? view.pic : undefined,
    author: view.owner?.name || undefined,
    summary: String(view.desc || '').slice(0, 400) || undefined,
    durationMin: Number.isFinite(Number(view.duration)) ? Math.max(1, Math.ceil(Number(view.duration) / 60)) : undefined,
    site: 'B站',
    kind: 'bilibili',
  }
}

async function resolvePage(url) {
  const response = await request(url, {
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    timeoutMs: TIMEOUT_MS,
  })
  if (response.status >= 400) return {}
  const text = await response.text()
  return parseHtmlPreview(text.slice(0, 500000), url)
}

/**
 * Resolve a link into preview fields: { title?, cover?, author?, summary?, durationMin?, site?, kind? }.
 * Returns {} when the site blocks us or the request fails.
 */
export async function resolvePreview(url, options = {}) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) return {}
  const target = url.trim()
  const detected = classifyUrl(target)
  try {
    if (detected.kind === 'bilibili') {
      const preview = await resolveBilibili(target)
      if (preview.title) {
        if (preview.cover) preview.cover = String(preview.cover).replace(/^http:\/\//i, 'https://')
        return preview
      }
    }
    if (detected.kind === 'douyin') {
      const resolved = await resolveDouyinShare({ url: target, signal: options.signal })
      if (resolved?.ok && resolved.item) {
        return {
          title: resolved.item.title || undefined,
          cover: resolved.item.cover || undefined,
          author: resolved.item.author || undefined,
          durationMin: Number.isFinite(Number(resolved.item.durationSec))
            ? Math.max(1, Math.ceil(Number(resolved.item.durationSec) / 60))
            : undefined,
          site: '抖音',
          kind: 'douyin',
        }
      }
    }
    return await resolvePage(target)
  } catch {
    return {}
  }
}

export { parseHtmlPreview }
