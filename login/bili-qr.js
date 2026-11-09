/**
 * login/bili-qr.js — B站官方扫码登录（面板「扫码登录」通道）。
 *
 * 契约（CONTRACT.md §12.1，导出名/返回结构不得改动）：
 *   export async function generateQr({ signal } = {})
 *     -> { ok, qrKey, qrUrl, expiresInSec, error? }
 *   export async function pollQr({ qrKey, signal } = {})
 *     -> { ok, state:'waiting'|'scanned'|'confirmed'|'expired'|'error', cookie?, account?, error? }
 *   export async function fetchAccount({ cookie, signal } = {})
 *     -> { ok, name?, avatar?, mid?, error? }
 *
 * 真实接口（2026-11-06 实测）：
 *   GET https://passport.bilibili.com/x/passport-login/web/qrcode/generate
 *     -> { code:0, data:{ url, qrcode_key } }              // url 是二维码内容，qrcode_key 用于轮询
 *   GET https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=...
 *     -> { code:0, data:{ code: 86101|86090|0|86038, url?, ... } }
 *        86101 未扫码 / 86090 已扫码未确认 / 0 已确认 / 86038 二维码过期
 *        确认时响应的 Set-Cookie 里带 SESSDATA、bili_jct、DedeUserID、DedeUserID__ckMd5、sid
 *   GET https://api.bilibili.com/x/web-interface/nav（带 Cookie）
 *     -> { code:0, data:{ isLogin:true, uname, face, mid } }
 *
 * 约束：纯 ESM、只用 Node 内置 fetch、模块顶层不发网络请求、失败一律结构化返回（不 throw）。
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'
const PASSPORT_BASE = 'https://passport.bilibili.com/x/passport-login/web/qrcode'
const GENERATE_URL = `${PASSPORT_BASE}/generate`
const POLL_URL = `${PASSPORT_BASE}/poll`
const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav'

const DEFAULT_TIMEOUT_MS = 12000
const GENERATE_TIMEOUT_MS = 10000
/** B站二维码官方有效期约 180 秒（接口不返回，按官方行为兜底）。 */
const QR_EXPIRES_IN_SEC = 180

/** 确认登录后从 Set-Cookie 里提取的字段（顺序即拼 cookie header 的顺序）。 */
const LOGIN_COOKIE_NAMES = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']

const COMMON_HEADERS = {
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
  Referer: REFERER,
  Origin: 'https://www.bilibili.com',
}

/* --------------------------------------------------------------- HTTP 层 */

function fail(code, error) {
  return { ok: false, code, error }
}

function humanizeNetworkError(err) {
  const cause = err && err.cause
  const code = (cause && (cause.code || cause.errno)) || (err && err.code) || ''
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '域名解析失败，请检查网络/DNS'
  if (code === 'ECONNREFUSED') return '连接被拒绝，请检查网络'
  if (code === 'ECONNRESET') return '连接被重置，请稍后重试'
  if (code === 'UND_ERR_CONNECT_TIMEOUT') return '建立连接超时，请稍后重试'
  if (code === 'CERT_HAS_EXPIRED') return 'HTTPS 证书已过期'
  return (err && err.message) || String(err)
}

/** Set-Cookie 兼容读取：优先 getSetCookie()，退化为按逗号谨慎切分。 */
function readSetCookieList(headers) {
  if (!headers) return []
  try {
    if (typeof headers.getSetCookie === 'function') {
      const list = headers.getSetCookie()
      if (Array.isArray(list) && list.length) return list.map(String)
    }
  } catch {
    /* 某些 fetch 实现没有 getSetCookie，走下面的退化分支 */
  }
  try {
    const raw = typeof headers.get === 'function' ? headers.get('set-cookie') : null
    if (raw) {
      // 只在「逗号 + 下一个 cookie 名=」处切分，避免把 Expires=Wed, 21 Oct ... 切开。
      return String(raw)
        .split(/,(?=\s*[^;,=\s]+=)/)
        .map((part) => part.trim())
        .filter(Boolean)
    }
  } catch {
    /* 忽略异常 headers */
  }
  return []
}

/**
 * 最小 fetch JSON 封装：内置超时 + 外部 AbortSignal，返回结构化结果而不抛异常。
 * @returns {Promise<{ok:true,json:any,setCookies:string[],status:number}|{ok:false,code:string,error:string}>}
 */
async function fetchJson(url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  if (typeof fetch !== 'function') return fail('NETWORK', '当前运行环境缺少 fetch，无法发起网络请求')
  if (signal && signal.aborted) return fail('ABORTED', '请求已取消')

  const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  let timedOut = false
  const onAbort = () => {
    try {
      controller.abort()
    } catch {
      /* 已 abort */
    }
  }
  const timer = setTimeout(() => {
    timedOut = true
    onAbort()
  }, timeout)
  if (typeof timer.unref === 'function') timer.unref()
  if (signal && typeof signal.addEventListener === 'function') {
    signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { ...COMMON_HEADERS, ...headers },
      signal: controller.signal,
      redirect: 'follow',
    })
    const setCookies = readSetCookieList(response.headers)
    let text = ''
    try {
      text = await response.text()
    } catch (err) {
      if (timedOut) return fail('TIMEOUT', `网络请求超时（${Math.round(timeout / 1000)} 秒），请检查网络后重试`)
      if ((signal && signal.aborted) || (err && err.name === 'AbortError')) return fail('ABORTED', '请求已取消')
      return fail('NETWORK', `读取响应失败：${humanizeNetworkError(err)}`)
    }
    if (!response.ok) {
      return fail('HTTP', mapHttpStatus(response.status))
    }
    let json
    try {
      json = JSON.parse(text)
    } catch {
      return fail('PARSE', '接口返回的内容不是合法 JSON（可能被风控拦截或接口已变更）')
    }
    return { ok: true, status: response.status, json, setCookies }
  } catch (err) {
    if (timedOut) return fail('TIMEOUT', `网络请求超时（${Math.round(timeout / 1000)} 秒），请检查网络后重试`)
    if ((signal && signal.aborted) || (err && err.name === 'AbortError')) return fail('ABORTED', '请求已取消')
    return fail('NETWORK', `网络请求失败：${humanizeNetworkError(err)}`)
  } finally {
    clearTimeout(timer)
    if (signal && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', onAbort)
    }
  }
}

function mapHttpStatus(status) {
  if (status === 412 || status === 403) return `B站拒绝访问（HTTP ${status}），可能被风控，请稍后重试或更换网络`
  if (status === 429) return 'B站请求过于频繁（HTTP 429），请稍后再试'
  return `B站接口返回 HTTP ${status}`
}

/* ------------------------------------------------------------- 数据解析 */

/** 解析 Set-Cookie 列表 -> Map<name,value>（同名取第一个非空值）。 */
function parseSetCookies(setCookieList) {
  const map = new Map()
  for (const line of setCookieList || []) {
    const first = String(line).split(';')[0]
    const eq = first.indexOf('=')
    if (eq <= 0) continue
    const name = first.slice(0, eq).trim()
    let value = first.slice(eq + 1).trim()
    if (!name || map.has(name)) continue
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1)
    }
    map.set(name, value)
  }
  return map
}

/** 从 Set-Cookie 里按契约顺序拼 B站 Cookie 请求头；没有 SESSDATA 时返回 null。 */
function buildCookieHeaderFromSetCookies(setCookieList) {
  const map = parseSetCookies(setCookieList)
  const sessdata = map.get('SESSDATA')
  if (!sessdata) return null
  const parts = []
  for (const name of LOGIN_COOKIE_NAMES) {
    const value = map.get(name)
    if (typeof value === 'string' && value !== '') parts.push(`${name}=${value}`)
  }
  return parts.length ? parts.join('; ') : null
}

/**
 * 用户手动粘贴的 cookie 规整成 Cookie 请求头。
 * 接受整段 Cookie（含 `=`）或裸 SESSDATA 值（自动补前缀）；空值返回 null。
 */
function normalizeCookieInput(cookie) {
  if (typeof cookie !== 'string') return null
  const cleaned = cookie
    .replace(/\r?\n/g, '; ')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s*;\s*/g, '; ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return null
  if (cleaned.includes('=')) return cleaned.replace(/^;\s*/, '').replace(/;\s*$/, '')
  return `SESSDATA=${cleaned}`
}

/** B站返回的封面/头像常是 http:// 或 //，统一成 https://。 */
function normalizeFace(face) {
  if (typeof face !== 'string') return null
  const trimmed = face.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('//')) return `https:${trimmed}`
  if (/^http:\/\//i.test(trimmed)) return trimmed.replace(/^http:\/\//i, 'https://')
  return trimmed
}

function mapBiliCode(code, message) {
  const num = Number(code)
  const suffix = message && String(message).trim() && String(message) !== '0' ? `（接口信息：${message}）` : ''
  switch (num) {
    case -101:
      return `B站 Cookie 已失效或未登录（-101），请重新扫码登录${suffix}`
    case -400:
      return `B站 Cookie 无效或请求被拒（-400），SESSDATA 可能已过期/格式不对${suffix}`
    case -111:
      return `B站 CSRF 校验失败（-111），请重新登录 B站 后再试${suffix}`
    case -352:
      return `B站触发风控校验（-352），请稍后重试或更换网络${suffix}`
    case -412:
      return `B站请求被风控拦截（-412），请稍后重试${suffix}`
    default:
      return `B站接口返回错误（code=${code}${message && String(message) !== '0' ? `，message=${message}` : ''}）`
  }
}

/* ------------------------------------------------------------ 契约导出 */

/**
 * 生成 B站登录二维码。
 * @param {{ signal?:AbortSignal }} [options]
 * @returns {Promise<{ok:boolean, qrKey?:string, qrUrl?:string, expiresInSec?:number, error?:string}>}
 */
export async function generateQr({ signal } = {}) {
  const res = await fetchJson(GENERATE_URL, { timeoutMs: GENERATE_TIMEOUT_MS, signal })
  if (!res.ok) return { ok: false, error: res.error }

  const payload = res.json
  const code = Number(payload && payload.code)
  if (code !== 0) {
    return { ok: false, error: `B站登录二维码生成失败：${mapBiliCode(code, payload && payload.message)}` }
  }
  const data = payload && payload.data && typeof payload.data === 'object' ? payload.data : {}
  const qrUrl = typeof data.url === 'string' ? data.url.trim() : ''
  const qrKey = typeof data.qrcode_key === 'string' ? data.qrcode_key.trim() : ''
  if (!qrUrl || !qrKey) {
    return { ok: false, error: 'B站返回的二维码数据不完整（缺少 url 或 qrcode_key），接口可能已变更' }
  }
  const rawExpires = Number(data.expires_in ?? data.expiresIn ?? data.expiresInSec)
  const expiresInSec = Number.isFinite(rawExpires) && rawExpires > 0 ? rawExpires : QR_EXPIRES_IN_SEC
  return { ok: true, qrKey, qrUrl, expiresInSec }
}

/**
 * 轮询扫码结果。只有 confirmed 时返回 cookie / account。
 * @param {{ qrKey?:string, signal?:AbortSignal }} [options]
 * @returns {Promise<{ok:boolean, state:'waiting'|'scanned'|'confirmed'|'expired'|'error',
 *                    cookie?:string, account?:{name:string|null, avatar:string|null, mid:number|null}, error?:string}>}
 */
export async function pollQr({ qrKey, signal } = {}) {
  const key = typeof qrKey === 'string' ? qrKey.trim() : ''
  if (!key) return { ok: false, state: 'error', error: '缺少二维码 key，请刷新二维码后重试' }

  const url = `${POLL_URL}?qrcode_key=${encodeURIComponent(key)}`
  const res = await fetchJson(url, { signal })
  if (!res.ok) return { ok: false, state: 'error', error: res.error }

  const payload = res.json && typeof res.json === 'object' ? res.json : {}
  const topCode = Number(payload.code)
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {}
  const innerCode = data.code === undefined || data.code === null ? NaN : Number(data.code)
  // 官方把登录状态码放在 data.code；同时兼容个别版本直接放顶层 code。
  const stateCode = Number.isFinite(innerCode) ? innerCode : topCode

  if (stateCode === 86101) return { ok: true, state: 'waiting' }
  if (stateCode === 86090) return { ok: true, state: 'scanned' }
  if (stateCode === 86038) return { ok: true, state: 'expired' }
  if (stateCode !== 0) {
    const rawCode = Number.isFinite(innerCode) ? data.code : payload.code
    const message = (Number.isFinite(innerCode) ? data.message : payload.message) || ''
    return { ok: false, state: 'error', error: `B站登录状态查询失败：${mapBiliCode(rawCode, message)}` }
  }

  const cookie = buildCookieHeaderFromSetCookies(res.setCookies)
  if (!cookie) {
    return {
      ok: false,
      state: 'error',
      error: 'B站扫码已确认，但响应里没有拿到登录 Cookie（SESSDATA），请刷新二维码重试或改用手动粘贴 Cookie',
    }
  }

  const result = { ok: true, state: 'confirmed', cookie }
  // nav 只用于展示昵称/头像；失败不影响「登录成功」这个结论（cookie 已到手）。
  const accountRes = await fetchAccount({ cookie, signal })
  if (accountRes.ok) {
    result.account = {
      name: accountRes.name ?? null,
      avatar: accountRes.avatar ?? null,
      mid: accountRes.mid ?? null,
    }
  }
  return result
}

/**
 * 用 Cookie 拉 B站账号信息（验证 cookie 是否有效 + 展示昵称/头像）。
 * @param {{ cookie?:string, signal?:AbortSignal }} [options]
 * @returns {Promise<{ok:boolean, name?:string|null, avatar?:string|null, mid?:number|null, error?:string}>}
 */
export async function fetchAccount({ cookie, signal } = {}) {
  const header = normalizeCookieInput(cookie)
  if (!header) {
    return { ok: false, error: '缺少 B站 Cookie（SESSDATA），请先扫码登录或手动粘贴 Cookie' }
  }

  const res = await fetchJson(NAV_URL, { headers: { Cookie: header }, signal })
  if (!res.ok) return { ok: false, error: res.error }

  const payload = res.json && typeof res.json === 'object' ? res.json : {}
  const code = Number(payload.code)
  if (code !== 0) {
    return { ok: false, error: mapBiliCode(code, payload.message) }
  }
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {}
  if (!data.isLogin) {
    return { ok: false, error: 'B站 Cookie 已失效或未登录（nav 返回 isLogin=false），请重新扫码登录' }
  }
  const name = typeof data.uname === 'string' && data.uname.trim() ? data.uname.trim() : null
  const avatar = normalizeFace(data.face)
  const midNum = Number(data.mid)
  const mid = Number.isFinite(midNum) && midNum > 0 ? midNum : null
  return { ok: true, name, avatar, mid }
}
