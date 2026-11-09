/**
 * sync/http.js — 「稍后再看」同步模块共用的极简 HTTP 客户端。
 *
 * 契约（CONTRACT.md §7）：
 *   export async function request(url, { method, headers, body, timeoutMs, signal, redirect })
 *     -> { status, url, headers, text(): Promise<string>, json(): Promise<any> }
 *   export const UA
 *
 * 约束：
 * - 只用 Node 22 内置 fetch（undici），不引第三方依赖。
 * - 默认 12s 超时；支持外部 AbortSignal 取消。
 * - 请求失败抛 RequestError（带 code），由上层 sync/bili.js、sync/douyin.js 捕获并转成中文错误。
 * - 模块顶层不发任何网络请求。
 */

export const DEFAULT_TIMEOUT_MS = 12000

/** 桌面 Chrome UA（B站 API、抖音 Web 接口用） */
export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** 移动端 Safari UA（抖音分享页 / 短链落地页必须用移动端 UA，否则会被 302 到需要 JS 挑战的 PC 页） */
export const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'

const DEFAULT_HEADERS = {
  'User-Agent': UA,
  Accept: '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
}

/**
 * 请求失败的统一错误类型。code 取值：
 *   'TIMEOUT' 超时 | 'ABORTED' 被外部 signal 取消 | 'NETWORK' 网络/连接失败 | 'PARSE' 响应不是合法 JSON
 */
export class RequestError extends Error {
  constructor(code, message, cause) {
    super(message)
    this.name = 'RequestError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

/** 把 RequestError 转成给 UI/日志看的、可读的中文错误。 */
export function describeRequestError(err, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (err instanceof RequestError) {
    switch (err.code) {
      case 'TIMEOUT':
        return `网络请求超时（${Math.round(timeoutMs / 1000)} 秒），请检查网络后重试`
      case 'ABORTED':
        return '请求已取消'
      case 'PARSE':
        return '接口返回的内容不是合法 JSON（可能被风控拦截或接口已变更）'
      case 'NETWORK':
      default:
        return `网络请求失败：${humanizeNetworkCause(err)}`
    }
  }
  if (err && err.name === 'AbortError') return '请求已取消'
  return `请求失败：${(err && err.message) || String(err)}`
}

function humanizeNetworkCause(err) {
  const cause = err && err.cause
  const code = (cause && (cause.code || cause.errno)) || (err && err.code) || ''
  const base = (err && err.message) || String(err)
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '域名解析失败，请检查网络/DNS'
  if (code === 'ECONNREFUSED') return '连接被拒绝，请检查网络'
  if (code === 'ECONNRESET') return '连接被重置，请稍后重试'
  if (code === 'UND_ERR_CONNECT_TIMEOUT') return '建立连接超时，请稍后重试'
  if (code === 'CERT_HAS_EXPIRED') return 'HTTPS 证书已过期'
  return base
}

function headersToBag(headers) {
  /** @type {Record<string, string>} */
  const bag = {}
  try {
    for (const [key, value] of headers) bag[String(key).toLowerCase()] = String(value)
  } catch {
    /* 忽略异常 headers */
  }
  // 既支持 bag['content-type']，也支持 bag.get('content-type')（贴近 fetch Headers 习惯）。
  Object.defineProperty(bag, 'get', {
    value(name) {
      const key = String(name).toLowerCase()
      return Object.prototype.hasOwnProperty.call(bag, key) ? bag[key] : null
    },
    enumerable: false,
  })
  return bag
}

/**
 * 发起 HTTP 请求。
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string,string>, body?: any, timeoutMs?: number,
 *           signal?: AbortSignal, redirect?: 'follow'|'manual'|'error' }} [options]
 * @returns {Promise<{ status:number, url:string, ok:boolean, headers:Record<string,string>,
 *                     text:()=>Promise<string>, json:()=>Promise<any> }>}
 */
export async function request(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    redirect = 'follow',
  } = options

  if (typeof url !== 'string' || !url) {
    throw new RequestError('NETWORK', '请求地址为空')
  }

  const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  let timedOut = false
  let externallyAborted = false
  let settled = false

  const onAbort = () => {
    externallyAborted = true
    try {
      controller.abort(signal && signal.reason)
    } catch {
      /* 已 abort */
    }
  }

  if (signal) {
    if (signal.aborted) throw new RequestError('ABORTED', '请求已取消')
    signal.addEventListener('abort', onAbort, { once: true })
  }

  const timer = setTimeout(() => {
    timedOut = true
    try {
      controller.abort(new RequestError('TIMEOUT', `请求超时（${timeout}ms）`))
    } catch {
      /* 已 abort */
    }
  }, timeout)
  if (typeof timer.unref === 'function') timer.unref()

  const cleanup = () => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    try {
      signal && signal.removeEventListener && signal.removeEventListener('abort', onAbort)
    } catch {
      /* 忽略 */
    }
  }

  let response
  try {
    response = await fetch(url, {
      method: String(method || 'GET').toUpperCase(),
      headers: { ...DEFAULT_HEADERS, ...headers },
      body,
      signal: controller.signal,
      redirect,
    })
  } catch (err) {
    cleanup()
    throw toRequestError(err, { timedOut, externallyAborted, timeout })
  }

  const status = response.status
  const finalUrl = response.url || url
  const bag = headersToBag(response.headers)

  let textPromise = null
  const readText = () => {
    if (!textPromise) {
      textPromise = (async () => {
        try {
          return await response.text()
        } catch (err) {
          throw toRequestError(err, { timedOut, externallyAborted, timeout })
        } finally {
          cleanup()
        }
      })()
    }
    return textPromise
  }

  let bytesPromise = null
  const readBytes = () => {
    if (!bytesPromise) {
      bytesPromise = (async () => {
        try {
          return Buffer.from(await response.arrayBuffer())
        } catch (err) {
          throw toRequestError(err, { timedOut, externallyAborted, timeout })
        } finally {
          cleanup()
        }
      })()
    }
    return bytesPromise
  }

  const readJson = async () => {
    const text = await readText()
    try {
      return JSON.parse(text)
    } catch (err) {
      throw new RequestError('PARSE', '响应不是合法 JSON', err)
    }
  }

  return {
    status,
    url: finalUrl,
    ok: status >= 200 && status < 300,
    headers: bag,
    text: readText,
    json: readJson,
    bytes: readBytes,
  }
}

function toRequestError(err, { timedOut, externallyAborted, timeout }) {
  if (err instanceof RequestError) return err
  if (timedOut) return new RequestError('TIMEOUT', `请求超时（${timeout}ms）`, err)
  if (externallyAborted || (err && err.name === 'AbortError')) {
    return new RequestError('ABORTED', '请求已取消', err)
  }
  return new RequestError('NETWORK', `网络请求失败：${(err && err.message) || String(err)}`, err)
}

export default { request, UA, MOBILE_UA, RequestError, describeRequestError, DEFAULT_TIMEOUT_MS }
