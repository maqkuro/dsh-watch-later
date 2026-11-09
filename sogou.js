/**
 * 搜狗微信搜索兜底：WorkBuddy 的 wechat-article-search 技能同款思路（weixin.sogou.com）。
 *
 * 微信文章正文对非微信客户端一律返回「环境异常」验证页，正文抓不到；但搜狗搜索结果页
 * 仍然给出每篇文章的标题、公众号、时间、摘要和**真实缩略图**（mmbiz 图床）。
 * 这里只取这些元信息：
 *   - 用真实缩略图替换「标题首字」生成封面；
 *   - 用搜狗摘要补全 summary，让列表/预览信息更清楚。
 * 不伪装成正文抓取，也不做正文解析。
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { request, UA } from './sync/http.js'
import { DATA_DIR, saveMediaBytes } from './store.js'

const SEARCH_URL = 'https://weixin.sogou.com/weixin'
const STATE_FILE = join(DATA_DIR, 'sogou-covers.json')
const MIN_GAP_MS = 2400
const MAX_GAP_MS = 4200
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000

let lastRequestAt = 0

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function decodeEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizeTitle(title) {
  return decodeEntities(title)
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[「」『』【】《》（）()\[\]<>·—\-_,，。!！?？:：;；'"“”‘’~～|/\\]/g, '')
}

function bigrams(text) {
  const out = new Map()
  for (let i = 0; i < text.length - 1; i += 1) {
    const pair = text.slice(i, i + 2)
    out.set(pair, (out.get(pair) || 0) + 1)
  }
  return out
}

/** 0~1 的标题相似度：完全相等 / 包含关系 / 二元组 Dice 系数。 */
export function titleSimilarity(a, b) {
  const left = normalizeTitle(a)
  const right = normalizeTitle(b)
  if (!left || !right) return 0
  if (left === right) return 1
  const shorter = left.length <= right.length ? left : right
  const longer = left.length <= right.length ? right : left
  if (longer.includes(shorter)) return 0.55 + 0.4 * (shorter.length / longer.length)
  const pa = bigrams(left)
  const pb = bigrams(right)
  let common = 0
  let total = 0
  for (const value of pa.values()) total += value
  for (const value of pb.values()) total += value
  for (const [pair, count] of pa) common += Math.min(count, pb.get(pair) || 0)
  return total > 0 ? (2 * common) / total : 0
}

export function extractMmbizThumb(url) {
  const raw = decodeEntities(url || '')
  if (!raw) return null
  if (raw.includes('mmbiz.qpic.cn')) {
    const match = /url=([^&]+)/.exec(raw)
    if (match) {
      try {
        return decodeURIComponent(match[1])
      } catch {
        return null
      }
    }
  }
  return null
}

/** 解析搜狗微信文章搜索结果页（结构改动时返回空数组，不抛错）。 */
export function parseSogouResults(html) {
  const out = []
  const source = String(html || '')
  const blocks = source.matchAll(/<li id="sogou_vr_11002601_box_\d+"[\s\S]*?<\/li>/g)
  for (const block of blocks) {
    const body = block[0]
    const titleMatch = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(body)
    const title = titleMatch ? decodeEntities(titleMatch[1]) : ''
    if (!title) continue
    const digestMatch = /<p class="txt-info"[^>]*>([\s\S]*?)<\/p>/i.exec(body)
    const accountMatch = /<span class="all-time-y2"[^>]*>([\s\S]*?)<\/span>/i.exec(body)
    const timeMatch = /timeConvert\('(\d+)'\)/.exec(body) || /<span class="s2"[^>]*>(\d{4}-\d{2}-\d{2})/.exec(body)
    const imgMatch = /<img[^>]+src="([^"]+)"/i.exec(body)
    let time = null
    if (timeMatch) {
      if (/^\d+$/.test(timeMatch[1])) time = new Date(Number(timeMatch[1]) * 1000).toISOString()
      else time = String(timeMatch[1])
    }
    out.push({
      title,
      digest: digestMatch ? decodeEntities(digestMatch[1]) : '',
      account: accountMatch ? decodeEntities(accountMatch[1]) : '',
      time,
      thumbUrl: imgMatch ? extractMmbizThumb(imgMatch[1]) : null,
    })
    if (out.length >= 10) break
  }
  return out
}

export function cleanQuery(title) {
  return decodeEntities(title)
    .replace(/[【\[「《][^】\]」》]*[】\]」》]/g, ' ')
    .replace(/[（(][^）)]*[）)]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function pickBestResult(results, title) {
  let best = null
  let bestScore = 0
  for (const result of Array.isArray(results) ? results : []) {
    const score = titleSimilarity(title, result.title)
    if (score > bestScore) {
      best = result
      bestScore = score
    }
  }
  return bestScore >= 0.45 ? { ...best, score: bestScore } : null
}

async function pace() {
  const wait = Math.max(0, lastRequestAt + MIN_GAP_MS + Math.random() * (MAX_GAP_MS - MIN_GAP_MS) - Date.now())
  if (wait > 0) await sleep(wait)
  lastRequestAt = Date.now()
}

/** 搜一条标题对应的公众号文章元信息。 */
export async function searchWechat(title, { signal } = {}) {
  const query = cleanQuery(title).slice(0, 48)
  if (!query) return { ok: false, error: '标题为空' }
  await pace()
  let response
  try {
    response = await request(`${SEARCH_URL}?type=2&query=${encodeURIComponent(query)}&ie=utf8`, {
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'zh-CN,zh;q=0.9',
        referer: 'https://weixin.sogou.com/',
      },
      timeoutMs: 15000,
      signal,
    })
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
  const html = await response.text()
  if (/antispider|请输入验证码/i.test(html)) return { ok: false, blocked: true, error: '搜狗要求验证码' }
  const results = parseSogouResults(html)
  const best = pickBestResult(results, title)
  if (!best) return { ok: false, results, error: '没有匹配到文章' }
  return { ok: true, result: best, results }
}

/** 下载 mmbiz 缩略图并存成封面。 */
export async function saveThumbAsCover(thumbUrl, { signal } = {}) {
  if (!thumbUrl) return null
  try {
    const response = await request(thumbUrl, {
      headers: { 'user-agent': UA, accept: 'image/*,*/*;q=0.8', referer: 'https://mp.weixin.qq.com/' },
      timeoutMs: 15000,
      signal,
    })
    if (!response.ok) return null
    const bytes = await response.bytes()
    if (!bytes || bytes.length < 1024 || bytes.length > 8 * 1024 * 1024) return null
    let extension = '.jpg'
    if (bytes[0] === 0x89 && bytes[1] === 0x50) extension = '.png'
    else if (bytes.slice(0, 4).toString('ascii') === 'RIFF') extension = '.webp'
    else if (bytes[0] === 0x47 && bytes[1] === 0x49) extension = '.gif'
    const media = saveMediaBytes(bytes, extension)
    return media && media.url ? media.url : null
  } catch {
    return null
  }
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return { version: 1, items: {} }
  }
}

function writeState(state) {
  const temporary = STATE_FILE + '.tmp-' + process.pid + '-' + Date.now().toString(36)
  writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 })
  renameSync(temporary, STATE_FILE)
}

export function shouldTrySogou(item, { nowMs = Date.now(), ttlMs = STATE_TTL_MS } = {}) {
  if (!item || typeof item.id !== 'string') return false
  if (item.cover && !/\.svg(\?|$)/i.test(item.cover)) return false
  const state = readState()
  const row = state.items[item.id]
  if (!row) return true
  const at = Date.parse(row.at || '')
  return !Number.isFinite(at) || nowMs - at > ttlMs
}

export function markSogouTried(itemId, result) {
  if (!itemId) return
  const state = readState()
  state.items[itemId] = { at: new Date().toISOString(), ok: Boolean(result && result.ok), reason: (result && result.error) || null }
  writeState(state)
}

/**
 * 对一个条目做搜狗元信息补全。
 * @returns {{ok:boolean, cover?:string, summary?:string, account?:string, title?:string, time?:string, error?:string, blocked?:boolean}}
 */
export async function wechatPreviewForItem(item, { signal, force = false } = {}) {
  if (!item || !item.title) return { ok: false, error: '缺少标题' }
  if (!force && !shouldTrySogou(item)) return { ok: false, skipped: true }
  let search = await searchWechat(item.title, { signal })
  if (!search.ok && !search.blocked) {
    // 长标题常匹配不到：去掉后缀后再用前 20 字试一次
    const shorter = cleanQuery(item.title).slice(0, 20)
    if (shorter.length >= 6 && shorter !== cleanQuery(item.title).slice(0, 48)) {
      search = await searchWechat(shorter, { signal })
    }
  }
  if (!search.ok) {
    markSogouTried(item.id, search)
    return search
  }
  const best = search.result
  const cover = best.thumbUrl ? await saveThumbAsCover(best.thumbUrl, { signal }) : null
  const result = {
    ok: Boolean(cover || best.digest),
    cover,
    summary: best.digest || '',
    account: best.account || '',
    title: best.title || '',
    time: best.time || null,
  }
  markSogouTried(item.id, result)
  return result
}

export function sogouStatePath() {
  return STATE_FILE
}
