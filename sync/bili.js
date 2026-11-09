/**
 * sync/bili.js — B站「稍后再看」同步。
 *
 * 契约（CONTRACT.md §7）：
 *   export async function fetchAccount({ cookie, signal })     -> { ok, name?, avatar?, error? }
 *   export async function fetchWatchLater({ cookie, signal })
 *     -> { ok, items:[{ remoteId, title, url, cover, author, durationSec, addedAt }], account?, error? }
 *
 * 真实接口（2026-11-06 curl 实测，详见 sync/NOTES.md）：
 *   - GET https://api.bilibili.com/x/web-interface/nav          需要 Cookie（SESSDATA）
 *   - GET https://api.bilibili.com/x/v2/history/toview          需要 Cookie（SESSDATA），data:{count,list[]}
 *
 * 不支持 Cookie 时直接返回结构化错误，不发起网络请求；所有异常都被捕获，不向上抛。
 */

import { request, describeRequestError } from './http.js'

const API_BASE = 'https://api.bilibili.com'
const NAV_URL = `${API_BASE}/x/web-interface/nav`
const TOVIEW_URL = `${API_BASE}/x/v2/history/toview`
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

  return { remoteId, title, url, cover, author, durationSec, addedAt }
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

export default { fetchAccount, fetchWatchLater }
