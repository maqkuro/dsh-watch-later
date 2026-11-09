/**
 * sync/bili.js — B站「稍后再看」同步。
 *
 * 契约（CONTRACT.md §7）：
 *   export async function fetchAccount({ cookie, signal })     -> { ok, name?, avatar?, error? }
 *   export async function fetchWatchLater({ cookie, signal })
 *     -> { ok, items:[{ remoteId, title, url, cover, author, durationSec, addedAt }], account?, error? }
 *   export async function removeFromWatchLater({ cookie, aids, signal })
 *     -> { ok, okCount, error? }
 *
 * 真实接口（2026-11-06 curl 实测，详见 sync/NOTES.md）：
 *   - GET https://api.bilibili.com/x/web-interface/nav          需要 Cookie（SESSDATA）
 *   - GET https://api.bilibili.com/x/v2/history/toview          需要 Cookie（SESSDATA），data:{count,list[]}
 *   - POST https://api.bilibili.com/x/v2/history/toview/del     需要 Cookie + csrf(=Cookie 里的 bili_jct)
 *
 * 不支持 Cookie 时直接返回结构化错误，不发起网络请求；所有异常都被捕获，不向上抛。
 */

import { request, describeRequestError } from './http.js'

const API_BASE = 'https://api.bilibili.com'
const NAV_URL = `${API_BASE}/x/web-interface/nav`
const TOVIEW_URL = `${API_BASE}/x/v2/history/toview`
/** 公开视频信息（用来 bvid -> aid，写回删除时需要）。 */
const BVID_VIEW_URL = `${API_BASE}/x/web-interface/view`
/** 上报观看进度：B站据此判断「已看」。 */
const REPORT_URL = `${API_BASE}/x/v2/history/report`
/** 从「稍后再看」移除（写回）：POST form，aid 支持逗号分隔多个，csrf 取 Cookie 里的 bili_jct。 */
const TOVIEW_DEL_URL = `${API_BASE}/x/v2/history/toview/del`
const REFERER = 'https://www.bilibili.com/'
const ACCEPT = 'application/json, text/plain, */*'

/** toview 接口单次最多返回 100 条（B站「稍后再看」容量上限），契约要求最多取 100 条。 */
export const MAX_ITEMS = 100

/**
 * 把用户粘贴的 cookie 规整成 Cookie 请求头。
 * 支持两种粘贴方式：
 *   1) 整段 Cookie（推荐，含 `=`）："SESSDATA=xxx; bili_jct=yyy"
 *   2) 只有 SESSDATA 值：自动补成 "SESSDATA=xxx"
 * @returns {string|null} 空 cookie 返回 null
 */
export function buildCookieHeader(cookie) {
  if (typeof cookie !== 'string') return null
  // 去掉控制字符（防 header 注入）与首尾空白；浏览器复制出来的换行折叠成 "; "
  const cleaned = cookie
    .replace(/\r?\n/g, '; ')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s*;\s*/g, '; ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return null
  if (cleaned.includes('=')) {
    // 已有 key=value 结构；确保不以分号开头/结尾
    return cleaned.replace(/^;\s*/, '').replace(/;\s*$/, '')
  }
  return `SESSDATA=${cleaned}`
}

/**
 * 从 Cookie 串里取 bili_jct —— B站写接口（包括移出稍后再看）要求 form 里带 csrf，
 * 值就是浏览器 Cookie 里的 bili_jct。只有 SESSDATA 时返回 null，由调用方给出可读错误。
 * @returns {string|null}
 */
export function parseBiliCsrf(cookie) {
  const cookieHeader = buildCookieHeader(cookie)
  if (!cookieHeader) return null
  for (const pair of cookieHeader.split(';')) {
    const at = pair.indexOf('=')
    if (at <= 0) continue
    if (pair.slice(0, at).trim() !== 'bili_jct') continue
    const value = pair.slice(at + 1).trim()
    return value || null
  }
  return null
}

/** B站 JSON 返回码 -> 可读中文错误。code=0 时返回 null。 */
export function mapBiliCode(code, message) {
  const num = Number(code)
  if (num === 0) return null
  const suffix = message && String(message).trim() && String(message) !== '0' ? `（接口信息：${message}）` : ''
  switch (num) {
    case -101:
      return `B站 cookie 已失效或未登录（-101），请在同步设置里重新粘贴浏览器 Cookie 中的 SESSDATA${suffix}`
    case -400:
      return `B站 cookie 无效或请求被拒（-400），SESSDATA 可能已过期/格式不对，请重新复制完整 Cookie${suffix}`
    case -111:
      return `B站 CSRF 校验失败（-111），请重新登录 B站 后再试${suffix}`
    case -352:
      return `B站触发风控校验（-352），请稍后重试或更换网络${suffix}`
    case -412:
      return `B站请求被风控拦截（-412），请稍后重试${suffix}`
    case -403:
      return `B站访问权限不足（-403），请确认 cookie 是否拥有对应权限${suffix}`
    case 90001:
      return 'B站稍后再看列表已满（90001），请先在 B站 清理一些视频'
    default:
      return `B站接口返回错误（code=${code}${message ? `，message=${message}` : ''}）`
  }
}

/** B站 HTTP 层错误的可读提示。 */
export function mapBiliHttpStatus(status) {
  if (status === 412) return 'B站请求被风控拦截（HTTP 412），请稍后重试或更换网络'
  if (status === 403) return 'B站拒绝访问（HTTP 403），可能被风控，请稍后重试'
  if (status === 429) return 'B站请求过于频繁（HTTP 429），请稍后再试'
  return `B站接口返回 HTTP ${status}`
}

const BVID_TABLE = 'fZodR9XQDSUm21yCkr6zBqiveYah8bt4xsWpHnJE7jL5VG3guMTKNPAwcF'
const BVID_POS = [11, 10, 3, 8, 4, 6]
const BVID_XOR = 177451812
const BVID_ADD = 8728348608
const BVID_CHARS = (() => {
  const map = new Map()
  for (let i = 0; i < BVID_TABLE.length; i += 1) map.set(BVID_TABLE[i], i)
  return map
})()

/**
 * bvid -> aid（纯算法，不用请求接口）。
 * 同步时 remoteId 存的是 bvid（更稳定、可读），但 toview/del 只认数字 aid，
 * 所以移除前必须换回来；换不出来就报错，绝不拿 bvid 硬塞给 aid 参数。
 * @returns {number|null}
 */
export function bvidToAid(bvid) {
  if (typeof bvid !== 'string') return null
  const value = bvid.trim()
  if (!/^BV1[0-9A-Za-z]{9}$/.test(value)) return null
  let r = 0
  for (let i = 0; i < BVID_POS.length; i += 1) {
    const digit = BVID_CHARS.get(value[BVID_POS[i]])
    if (digit === undefined) return null
    r += digit * 58 ** i
  }
  // 位运算按 32 位截断，B站 aid 都在 int32 范围内，换算结果可直接用。
  const aid = ((r - BVID_ADD) ^ BVID_XOR) >>> 0
  return aid > 0 && aid <= 2147483647 ? aid : null
}

/**
 * 把 remoteId（bvid / av123 / '123'）规整成 aid 列表，去重保序。
 * @returns {number[]}
 */
export function normalizeAids(aids) {
  const input = Array.isArray(aids) ? aids : [aids]
  const out = []
  const seen = new Set()
  for (const raw of input) {
    if (raw === null || raw === undefined) continue
    const text = String(raw).trim()
    if (!text) continue
    let aid = null
    if (/^\d+$/.test(text)) aid = Number(text)
    else if (/^av\d+$/i.test(text)) aid = Number(text.slice(2))
    // bvid 故意不在这里换算：bvidToAid 只对早期 9 位 aid 成立，新视频会算出**别人的 aid**，
    // 拿错 aid 删除等于删用户 B站上的另一条视频。调用方必须先用 resolveAidByBvid 解析。
    if (!Number.isFinite(aid) || aid <= 0 || seen.has(aid)) continue
    seen.add(aid)
    out.push(aid)
  }
  return out
}

/** 封面 http:// -> https://（B站返回的 pic 常为 http，前端混合内容会加载失败）。 */
export function normalizeBiliCover(pic) {
  if (typeof pic !== 'string') return null
  const trimmed = pic.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('//')) return `https:${trimmed}`
  if (/^http:\/\//i.test(trimmed)) return trimmed.replace(/^http:\/\//i, 'https://')
  return trimmed
}

function toPositiveNumber(value) {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? num : null
}

/** unix 秒 -> ISO8601 UTC 字符串；非法值返回 null */
function unixSecondsToIso(value) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return null
  const date = new Date(num * 1000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/**
 * toview 列表项 -> 契约 items 项。
 * 字段来源（bilibili-API-collect 文档 + 实测公开接口字段风格）：
 *   bvid/aid/title/pic/duration/owner.name/add_at
 * @returns {{ remoteId:string, title:string, url:string, cover:string|null,
 *             author:string|null, durationSec:number|null, addedAt:string|null } | null}
 */
export function mapToviewItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  const bvid = typeof raw.bvid === 'string' && raw.bvid.trim() ? raw.bvid.trim() : null
  const aid = toPositiveNumber(raw.aid)
  if (!bvid && !aid) return null

  const remoteId = bvid || `av${aid}`
  const url = bvid
    ? `https://www.bilibili.com/video/${bvid}`
    : `https://www.bilibili.com/video/av${aid}`
  const title =
    typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : remoteId
  const cover = normalizeBiliCover(raw.pic)
  const author =
    raw.owner && typeof raw.owner.name === 'string' && raw.owner.name.trim()
      ? raw.owner.name.trim()
      : null
  const durationSec = toPositiveNumber(raw.duration)
  const addedAt = unixSecondsToIso(raw.add_at)

  // aid 必须原样带出来：toview/del 只认数字 aid，而新版视频的 aid 已经到 15 位，
  // 用 bvid 反推（bvidToAid）只对老视频成立，所以同步时就把接口给的 aid 存下来。
  return { remoteId, aid, title, url, cover, author, durationSec, addedAt }
}

/**
 * 纯函数：解析 toview 接口返回体。
 * @returns {{ ok:boolean, items:Array, count?:number, error?:string }}
 */
export function parseToviewResponse(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, items: [], error: 'B站接口返回空响应（可能被风控拦截，请稍后重试）' }
  }
  const code = Number(payload.code)
  if (code !== 0) {
    return { ok: false, items: [], error: mapBiliCode(code, payload.message) }
  }
  const data = payload.data
  if (!data || typeof data !== 'object' || !Array.isArray(data.list)) {
    return {
      ok: false,
      items: [],
      error: 'B站接口返回结构异常（缺少 data.list，接口可能已变更）',
    }
  }

  const items = []
  for (const raw of data.list) {
    const mapped = mapToviewItem(raw)
    if (mapped) items.push(mapped)
  }
  // 稍后再看接口按“添加顺序”升序返回；同步导入时最新添加的排前面更符合使用直觉。
  items.sort((a, b) => {
    const ta = a.addedAt ? Date.parse(a.addedAt) : 0
    const tb = b.addedAt ? Date.parse(b.addedAt) : 0
    return tb - ta
  })
  const sliced = items.slice(0, MAX_ITEMS)
  const count = Number.isFinite(Number(data.count)) ? Number(data.count) : sliced.length
  return { ok: true, items: sliced, count }
}

/**
 * 纯函数：解析 nav 接口返回体。
 * @returns {{ ok:boolean, name?:string|null, avatar?:string|null, mid?:number|null, error?:string }}
 */
export function parseNavResponse(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'B站账号接口返回空响应（可能被风控拦截，请稍后重试）' }
  }
  const code = Number(payload.code)
  if (code !== 0) {
    return { ok: false, error: mapBiliCode(code, payload.message) }
  }
  const data = payload.data || {}
  if (!data.isLogin) {
    return { ok: false, error: 'B站 cookie 已失效或未登录（nav 返回 isLogin=false），请重新粘贴 SESSDATA' }
  }
  const name = typeof data.uname === 'string' && data.uname.trim() ? data.uname.trim() : null
  const avatar = normalizeBiliCover(data.face)
  const mid = Number.isFinite(Number(data.mid)) ? Number(data.mid) : null
  return { ok: true, name, avatar, mid }
}

/**
 * 拉取 B站账号信息（用于同步设置页验证 cookie 是否可用）。
 * @param {{ cookie?:string, signal?:AbortSignal }} [options]
 */
export async function fetchAccount({ cookie, signal } = {}) {
  const cookieHeader = buildCookieHeader(cookie)
  if (!cookieHeader) {
    return { ok: false, error: '未配置 B站 cookie（需要 SESSDATA），请在同步设置里粘贴浏览器 Cookie' }
  }
  if (signal && signal.aborted) return { ok: false, error: '请求已取消' }

  let res
  try {
    res = await request(NAV_URL, {
      headers: { Cookie: cookieHeader, Referer: REFERER, Accept: ACCEPT },
      signal,
    })
  } catch (err) {
    return { ok: false, error: describeRequestError(err) }
  }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, error: mapBiliHttpStatus(res.status) }
  }

  let payload
  try {
    payload = await res.json()
  } catch (err) {
    return { ok: false, error: describeRequestError(err) }
  }
  const parsed = parseNavResponse(payload)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  return { ok: true, name: parsed.name, avatar: parsed.avatar }
}

/**
 * 拉取 B站「稍后再看」列表。
 * nav 与 toview 并发请求：toview 决定成败，nav 只用来补账号名，失败不影响结果。
 * @param {{ cookie?:string, signal?:AbortSignal }} [options]
 */
export async function fetchWatchLater({ cookie, signal } = {}) {
  const cookieHeader = buildCookieHeader(cookie)
  if (!cookieHeader) {
    return {
      ok: false,
      items: [],
      error: '未配置 B站 cookie（需要 SESSDATA）。请在同步设置里粘贴浏览器 Cookie 中的 SESSDATA',
    }
  }
  if (signal && signal.aborted) return { ok: false, items: [], error: '同步已取消' }

  const headers = { Cookie: cookieHeader, Referer: REFERER, Accept: ACCEPT }
  let listOutcome, navOutcome
  try {
    ;[listOutcome, navOutcome] = await Promise.allSettled([
      request(TOVIEW_URL, { headers, signal }),
      request(NAV_URL, { headers, signal }),
    ])
  } catch (err) {
    // Promise.allSettled 本身不会 reject，这里只是兜底
    return { ok: false, items: [], error: describeRequestError(err) }
  }

  if (listOutcome.status === 'rejected') {
    return { ok: false, items: [], error: describeRequestError(listOutcome.reason) }
  }
  const listRes = listOutcome.value
  if (listRes.status < 200 || listRes.status >= 300) {
    return { ok: false, items: [], error: mapBiliHttpStatus(listRes.status) }
  }

  let payload
  try {
    payload = await listRes.json()
  } catch (err) {
    return { ok: false, items: [], error: describeRequestError(err) }
  }

  const parsed = parseToviewResponse(payload)
  if (!parsed.ok) {
    return { ok: false, items: [], error: parsed.error }
  }

  let account = null
  if (navOutcome && navOutcome.status === 'fulfilled') {
    try {
      const navPayload = await navOutcome.value.json()
      const navParsed = parseNavResponse(navPayload)
      if (navParsed.ok) account = navParsed.name
    } catch {
      /* 账号名拿不到不算失败 */
    }
  }

  return { ok: true, items: parsed.items, account }
}

/**
 * 把视频从 B站「稍后再看」里移出（写回，不可撤销）。
 *
 * 为什么需要 csrf：toview/del 是写接口，B站用 Cookie 里的 bili_jct 做 CSRF 校验，
/**
 * 用公开 view 接口把 bvid 换成 aid（写回删除时用）。
 *
 * 为什么不用纯算法 `bvidToAid`：那套算法只对早期 9 位 aid 成立。2026 年后的新视频
 * aid 已经涨到 15 位（实测 BV1MqxQ6FE4P -> 117557197539987），纯算法会算出完全错误的值，
 * 拿错 aid 去 toview/del 只会静默失败。所以老条目（同步时没存 aid 的）走这里实时查。
 * 这个接口公开可读，不需要 Cookie。
 *
 * @returns {Promise<{ aid:number|null, error:string|null }>}
 */
export async function resolveAidByBvid(bvid, { signal } = {}) {
  const text = String(bvid || '').trim()
  if (!/^BV[0-9A-Za-z]{10}$/.test(text)) {
    return { aid: null, error: '不是合法的 bvid，无法解析 aid' }
  }
  let res
  try {
    res = await request(BVID_VIEW_URL + '?bvid=' + encodeURIComponent(text), {
      headers: { Referer: REFERER, Accept: ACCEPT },
      signal,
    })
  } catch (err) {
    return { aid: null, error: describeRequestError(err) }
  }
  if (res.status < 200 || res.status >= 300) {
    return { aid: null, error: mapBiliHttpStatus(res.status) }
  }
  let payload
  try {
    payload = await res.json()
  } catch {
    return { aid: null, error: 'B站 view 接口返回的不是 JSON' }
  }
  if (!payload || Number(payload.code) !== 0 || !payload.data) {
    return {
      aid: null,
      error: mapBiliCode(payload && payload.code, payload && payload.message) || 'B站 view 接口没返回视频信息',
    }
  }
  const aid = toPositiveNumber(payload.data.aid)
  if (!aid) return { aid: null, cid: null, duration: null, error: 'B站 view 接口没有 aid 字段' }
  // cid 是「上报观看进度」的必填参数；单 P 视频取 data.cid，多 P 取第一 P
  const pages = Array.isArray(payload.data.pages) ? payload.data.pages : []
  const cid = toPositiveNumber(payload.data.cid) || toPositiveNumber(pages[0] && pages[0].cid)
  const duration = toPositiveNumber(payload.data.duration) || toPositiveNumber(payload.data.duration)
  return { aid, cid, duration, error: null }
}

/**
 * 上报观看进度 —— B站侧「已读」的唯一表达方式。
 *
 * 背景：稍后再看没有"标记已读"的写接口，B站是根据观看进度判断「已看」的
 * （toview 列表里每条都带 progress 字段）。所以把 progress 报成片长，
 * 这条视频在 B站稍后再看里就会显示为已看完，而**不会从列表消失**——
 * 这正是「已读」和「移除」在平台侧的区别：已读=标记，移除=toview/del 删掉。
 *
 * 接口：POST /x/v2/history/report，form: aid/cid/progress/csrf/platform
 * 认证：Cookie(SESSDATA) + csrf(=Cookie 里的 bili_jct)
 *
 * @param {{ cookie?:string, aid:number, cid:number, progress:number, signal?:AbortSignal }} options
 * @returns {Promise<{ ok:boolean, error:string|null }>}
 */
export async function reportWatched({ cookie, aid, cid, progress, signal } = {}) {
  const cookieHeader = buildCookieHeader(cookie)
  const csrf = parseBiliCsrf(cookieHeader)
  if (!cookieHeader) return { ok: false, error: '没有配置 B站 Cookie，无法标记已看' }
  if (!csrf) return { ok: false, error: 'Cookie 里缺少 bili_jct，无法标记已看' }
  const aidNum = toPositiveNumber(aid)
  const cidNum = toPositiveNumber(cid)
  if (!aidNum) return { ok: false, error: '缺少 aid，无法标记已看' }
  if (!cidNum) return { ok: false, error: '缺少 cid，无法标记已看' }
  const seconds = Math.max(1, Math.round(Number(progress) || 0))

  const body = new URLSearchParams({
    aid: String(aidNum),
    cid: String(cidNum),
    progress: String(seconds),
    platform: 'android',
    csrf,
  })

  let res
  try {
    res = await request(REPORT_URL, {
      method: 'POST',
      headers: {
        Cookie: cookieHeader,
        Referer: REFERER,
        Accept: ACCEPT,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: String(body),
      signal,
    })
  } catch (err) {
    return { ok: false, error: describeRequestError(err) }
  }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, error: mapBiliHttpStatus(res.status) }
  }
  let payload
  try {
    payload = await res.json()
  } catch {
    return { ok: false, error: 'B站上报进度接口返回的不是 JSON' }
  }
  const code = Number(payload && payload.code)
  if (code !== 0) {
    return { ok: false, error: mapBiliCode(code, payload && payload.message) || '上报观看进度失败' }
  }
  return { ok: true, error: null }
}

/**
 * 缺了它接口一定失败，所以在发请求前就快速失败，别浪费一次网络往返。
 *
 * @param {{ cookie?:string, aids?:string|number|Array<string|number>, signal?:AbortSignal }} [options]
 * @returns {Promise<{ ok:boolean, okCount:number, error:string|null }>}
 */
export async function removeFromWatchLater({ cookie, aids, signal } = {}) {
  const cookieHeader = buildCookieHeader(cookie)
  if (!cookieHeader) {
    return {
      ok: false,
      okCount: 0,
      error: '未配置 B站 cookie（需要 SESSDATA 和 bili_jct），请在同步设置里重新粘贴浏览器 Cookie',
    }
  }
  const csrf = parseBiliCsrf(cookieHeader)
  if (!csrf) {
    return { ok: false, okCount: 0, error: 'Cookie 里缺少 bili_jct，无法写回' }
  }
  const list = normalizeAids(aids)
  if (!list.length) {
    return { ok: false, okCount: 0, error: '没有可用的 B站 aid，无法写回' }
  }
  if (signal && signal.aborted) return { ok: false, okCount: 0, error: '请求已取消' }

  // B站写接口只收 form，aid 多个用逗号分隔
  const body = new URLSearchParams()
  body.set('aid', list.join(','))
  body.set('csrf', csrf)

  let res
  try {
    res = await request(TOVIEW_DEL_URL, {
      method: 'POST',
      headers: {
        Cookie: cookieHeader,
        Referer: REFERER,
        Accept: ACCEPT,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal,
    })
  } catch (err) {
    return { ok: false, okCount: 0, error: describeRequestError(err) }
  }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, okCount: 0, error: mapBiliHttpStatus(res.status) }
  }

  let payload
  try {
    payload = await res.json()
  } catch (err) {
    return { ok: false, okCount: 0, error: describeRequestError(err) }
  }
  // 只有 code === 0 才算真的删掉了；其余（-111 CSRF、-101 掉登录、风控…）都按失败处理
  if (Number(payload && payload.code) !== 0) {
    return { ok: false, okCount: 0, error: mapBiliCode(payload && payload.code, payload && payload.message) }
  }
  return { ok: true, okCount: list.length, error: null }
}

export default { fetchAccount, fetchWatchLater, removeFromWatchLater }
