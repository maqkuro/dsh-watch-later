/**
 * login/chrome-login.js — 插件内 Chrome 登录窗口 + CDP 自动读取 Cookie。
 *
 * 契约（CONTRACT.md §12.2，导出名/返回结构不得改动）：
 *   export async function startLoginWindow({ provider, signal } = {}) -> { ok, port, pid, error? }
 *   export async function pollLogin({ provider, signal } = {})
 *     -> { ok, state:'waiting'|'confirmed'|'closed'|'error', cookie?, account?:{name?}, error? }
 *   export async function cancelLogin({ provider } = {}) -> { ok, error? }
 *   export function loginWindows() -> { douyin: {port,pid}|null, bilibili: {port,pid}|null }
 *
 * 工作方式：
 *   1. 用独立 user-data-dir 启动本机 Google Chrome（--remote-debugging-port=9300-9399 随机空闲端口）；
 *   2. 通过 CDP `GET /json/version` 拿 browser 的 webSocketDebuggerUrl；
 *   3. 用 Node 22 全局 WebSocket 连上去，发 `Storage.getCookies` 读 browser 域全部 cookie；
 *   4. 抖音看到 sessionid / sid_tt、B站看到 SESSDATA 即确认登录 -> 拼 cookie header、关闭窗口；
 *   5. 窗口被用户关闭（进程没了且 CDP 连不上）-> state:'closed'；5 分钟没登录 -> 关窗并 closed。
 *
 * 约束：纯 ESM、零第三方依赖、模块顶层不发网络/不启进程、所有失败结构化返回（不 throw）。
 *
 * 测试注入（仅测试用，正常调用不需要传）：
 *   startLoginWindow({ chromePath, userDataDir, port, loginUrl, spawnFn, killFn, headless })
 *   pollLogin({ cdpPort, pid, startedAt, isAlive, wsFactory, accountLookup, enrichAccount, now, timeoutMs })
 */

import { spawn } from 'node:child_process'
import { accessSync, constants, mkdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fetchAccount as fetchBiliAccount } from './bili-qr.js'

/* ---------------------------------------------------------------- 常量 */

const PORT_MIN = 9300
const PORT_MAX = 9399

/** 登录窗口最长等待时间（契约：5 分钟）。 */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
/** 本地 CDP HTTP 探测超时（只连 127.0.0.1，正常是毫秒级）。 */
const CDP_HTTP_TIMEOUT_MS = 3000
/** 单次 Storage.getCookies 请求超时。 */
const CDP_WS_TIMEOUT_MS = 5000
/** 等 Chrome 主进程真正 spawn 出来的超时。 */
const SPAWN_TIMEOUT_MS = 5000
/** Chrome 退出后补刀 SIGKILL 的等待时间。 */
const KILL_GRACE_MS = 1200

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
]

const PROVIDERS = {
  douyin: {
    label: '抖音',
    loginUrl: 'https://www.douyin.com/',
    profileKey: 'douyin',
    cookieSuffixes: ['douyin.com'],
    /** 有任意一个就算已登录 */
    requiredNames: ['sessionid', 'sid_tt'],
    requireAny: true,
  },
  bilibili: {
    label: 'B站',
    loginUrl: 'https://www.bilibili.com/',
    profileKey: 'bilibili',
    cookieSuffixes: ['bilibili.com'],
    requiredNames: ['SESSDATA'],
    requireAny: false,
  },
  xiaohongshu: {
    label: '小红书',
    loginUrl: 'https://www.xiaohongshu.com/',
    profileKey: 'xiaohongshu',
    cookieSuffixes: ['xiaohongshu.com'],
    /** 未登录访客也有 web_session/a1；登录后会出现 id_token / customerClientId（自动兜底仍可手动确认） */
    requiredNames: ['id_token', 'customerClientId'],
    requireAny: true,
  },
}

/** provider -> { port, pid, startedAt, owned, killFn? }，仅内存态（DSH 重启后失效）。 */
const windows = new Map()

/* -------------------------------------------------------------- 小工具 */

function getProvider(provider) {
  return typeof provider === 'string' && Object.prototype.hasOwnProperty.call(PROVIDERS, provider)
    ? PROVIDERS[provider]
    : null
}

function invalidProvider(provider) {
  return `不支持的登录来源（provider=${String(provider)}），只能是 ${Object.keys(PROVIDERS).join(' / ')}`
}

/** pid 进程是否还活着（EPERM 表示存在但无权限，仍算活着）。 */
function isPidAlive(pid) {
  const num = Number(pid)
  if (!Number.isFinite(num) || num <= 0) return false
  try {
    process.kill(num, 0)
    return true
  } catch (err) {
    return Boolean(err && err.code === 'EPERM')
  }
}

function profileRootDir() {
  const base = process.env.DSH_WATCH_LATER_DIR || join(homedir(), '.dsh', 'storages', 'watch-later')
  return join(base, 'login-chrome')
}

function resolveChromePath(explicitPath) {
  const candidates = []
  if (typeof explicitPath === 'string' && explicitPath.trim()) candidates.push(explicitPath.trim())
  if (typeof process.env.CHROME_PATH === 'string' && process.env.CHROME_PATH.trim()) {
    candidates.push(process.env.CHROME_PATH.trim())
  }
  candidates.push(...CHROME_CANDIDATES)
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      /* 尝试下一个候选路径 */
    }
  }
  return null
}

/** 端口是否可绑定（只测 127.0.0.1，和 Chrome remote debugging 的绑定范围一致）。 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const server = createServer()
    server.unref()
    let done = false
    const finish = (free) => {
      if (done) return
      done = true
      try {
        server.close()
      } catch {
        /* 已关闭 */
      }
      resolve(free)
    }
    server.once('error', () => finish(false))
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => finish(true))
  })
}

/** 在 9300-9399 里随机挑一个未占用端口。 */
async function pickFreePort() {
  const ports = []
  for (let port = PORT_MIN; port <= PORT_MAX; port += 1) ports.push(port)
  // Fisher-Yates 洗牌：随机起点、无偏
  for (let i = ports.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = ports[i]
    ports[i] = ports[j]
    ports[j] = tmp
  }
  for (const port of ports) {
    if (await isPortFree(port)) return port
  }
  return null
}

/** 等子进程真正 spawn 成功（spawn 的 ENOENT 等错误是异步抛的）。 */
function waitForSpawn(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!child || typeof child.once !== 'function') {
      resolve()
      return
    }
    let settled = false
    const finish = (fn, arg) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(arg)
    }
    const timer = setTimeout(() => finish(reject, new Error('启动 Chrome 进程超时')), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    child.once('spawn', () => finish(resolve))
    child.once('error', (err) => finish(reject, err))
  })
}

/** 关掉某个 provider 的登录窗口（SIGTERM；1.2s 后仍活着后台补 SIGKILL，不阻塞轮询响应）。 */
async function closeWindow(provider) {
  const record = windows.get(provider)
  if (!record) return
  windows.delete(provider)
  if (!record.owned) return
  const kill = typeof record.killFn === 'function' ? record.killFn : (pid, sig) => process.kill(pid, sig)
  try {
    kill(record.pid, 'SIGTERM')
  } catch {
    /* 进程可能已经退出 */
  }
  if (typeof record.killFn === 'function') return // 测试注入的 kill 不补刀
  const timer = setTimeout(() => {
    if (isPidAlive(record.pid)) {
      try {
        kill(record.pid, 'SIGKILL')
      } catch {
        /* 已退出 */
      }
    }
  }, KILL_GRACE_MS)
  if (typeof timer.unref === 'function') timer.unref()
}

/* ----------------------------------------------------------- CDP 读写 */

/** GET /json/version -> browser webSocketDebuggerUrl。 */
async function fetchCdpWebSocketUrl(port, { signal, timeoutMs = CDP_HTTP_TIMEOUT_MS } = {}) {
  if (typeof fetch !== 'function') throw new Error('当前运行环境缺少 fetch')
  if (signal && signal.aborted) throw new Error('请求已取消')
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
  }, timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()
  if (signal && typeof signal.addEventListener === 'function') {
    signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`CDP HTTP ${response.status}`)
    const payload = await response.json()
    const wsUrl = payload && payload.webSocketDebuggerUrl
    if (typeof wsUrl !== 'string' || !wsUrl) throw new Error('CDP 未返回 webSocketDebuggerUrl')
    return wsUrl
  } catch (err) {
    if (timedOut) throw new Error('CDP 探测超时')
    if (signal && signal.aborted) throw new Error('请求已取消')
    throw err
  } finally {
    clearTimeout(timer)
    if (signal && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', onAbort)
    }
  }
}

/** 连 browser WS，发一次 Storage.getCookies，返回 cookie 数组。 */
function cdpGetCookies(wsUrl, { wsFactory, timeoutMs = CDP_WS_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new Error('请求已取消'))
      return
    }
    const factory = typeof wsFactory === 'function' ? wsFactory : (url) => new WebSocket(url)
    let socket
    let settled = false
    let timer = null

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort)
      }
      if (socket && typeof socket.removeEventListener === 'function') {
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('message', onMessage)
        socket.removeEventListener('error', onError)
        socket.removeEventListener('close', onClose)
      }
      try {
        socket && socket.close()
      } catch {
        /* 忽略关闭异常 */
      }
    }
    const finish = (err, cookies) => {
      if (settled) return
      settled = true
      cleanup()
      if (err) reject(err)
      else resolve(cookies)
    }
    const onOpen = () => {
      try {
        socket.send(JSON.stringify({ id: 1, method: 'Storage.getCookies', params: {} }))
      } catch (err) {
        finish(err instanceof Error ? err : new Error('发送 CDP 命令失败'))
      }
    }
    const onMessage = (event) => {
      let message
      try {
        message = JSON.parse(String(event && event.data))
      } catch {
        return
      }
      if (!message || message.id !== 1) return
      if (message.error) {
        finish(new Error((message.error && message.error.message) || 'CDP Storage.getCookies 返回错误'))
        return
      }
      const cookies = message.result && Array.isArray(message.result.cookies) ? message.result.cookies : []
      finish(null, cookies)
    }
    const onError = () => finish(new Error('CDP WebSocket 连接失败'))
    const onClose = () => finish(new Error('CDP WebSocket 已关闭'))
    const onAbort = () => finish(new Error('请求已取消'))

    timer = setTimeout(() => finish(new Error('CDP 响应超时')), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      socket = factory(wsUrl)
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)))
      return
    }
    if (!socket || typeof socket.addEventListener !== 'function') {
      finish(new Error('CDP WebSocket 构造失败'))
      return
    }
    socket.addEventListener('open', onOpen)
    socket.addEventListener('message', onMessage)
    socket.addEventListener('error', onError)
    socket.addEventListener('close', onClose)
  })
}

/** 从 cookie 列表拼平台 Cookie 请求头，并告知是否已有登录态 cookie。 */
function buildCookieHeader(cookies, config, now = Date.now()) {
  const suffixes = config.cookieSuffixes
  const seen = new Map()

  for (const raw of cookies || []) {
    if (!raw || typeof raw !== 'object') continue
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    const value = typeof raw.value === 'string' ? raw.value : ''
    if (!name) continue
    const domain = String(raw.domain || '').replace(/^\./, '').toLowerCase()
    if (!suffixes.some((suffix) => domain === suffix || domain.endsWith(`.${suffix}`))) continue
    const expires = Number(raw.expires)
    if (Number.isFinite(expires) && expires > 0 && expires * 1000 <= now) continue // 已过期
    if (!seen.has(name)) seen.set(name, value.replace(/[\r\n\u0000]/g, ''))
  }

  const names = [...seen.keys()]
  const required = config.requiredNames.filter((name) => seen.has(name))
  const hasRequired = config.requireAny ? required.length > 0 : required.length === config.requiredNames.length
  const rest = names.filter((name) => !required.includes(name)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const ordered = [...required, ...rest]
  const header = ordered.map((name) => `${name}=${seen.get(name)}`).join('; ')
  return { header, names: ordered, hasRequired }
}

async function readCookiesViaCdp(port, { signal, wsFactory } = {}) {
  const wsUrl = await fetchCdpWebSocketUrl(port, { signal })
  return cdpGetCookies(wsUrl, { wsFactory, signal })
}

/* ------------------------------------------------------------ 契约导出 */

/**
 * 打开独立 Chrome 登录窗口。
 * @param {object} [options]
 * @param {'douyin'|'bilibili'} options.provider
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ok:boolean, port?:number, pid?:number, error?:string}>}
 */
export async function startLoginWindow({
  provider,
  signal,
  chromePath,
  userDataDir,
  port: explicitPort,
  loginUrl,
  spawnFn,
  killFn,
  headless = false,
} = {}) {
  const config = getProvider(provider)
  if (!config) return { ok: false, error: invalidProvider(provider) }
  if (signal && signal.aborted) return { ok: false, error: '请求已取消' }

  // 已有窗口且进程还活着：直接复用，避免重复点按钮开出两个 Chrome。
  const existing = windows.get(provider)
  if (existing) {
    if (isPidAlive(existing.pid)) return { ok: true, port: existing.port, pid: existing.pid }
    windows.delete(provider)
  }

  const executable = resolveChromePath(chromePath)
  if (!executable) {
    return {
      ok: false,
      error: '未找到 Google Chrome，请先安装 Chrome，或用环境变量 CHROME_PATH 指定 Chrome 可执行文件路径',
    }
  }

  let port = Number(explicitPort)
  if (!Number.isFinite(port) || port <= 0) {
    port = await pickFreePort()
    if (!port) return { ok: false, error: `端口 ${PORT_MIN}-${PORT_MAX} 都被占用，无法启动登录窗口，请稍后重试` }
  }

  const profileDir = userDataDir || join(profileRootDir(), config.profileKey)
  try {
    mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  } catch (err) {
    return { ok: false, error: `无法创建 Chrome 登录配置目录（${profileDir}）：${(err && err.message) || err}` }
  }

  const targetUrl = typeof loginUrl === 'string' && loginUrl ? loginUrl : config.loginUrl
  const args = [
    `--remote-debugging-port=${port}`,
    `--remote-allow-origins=*`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ]
  if (headless) args.push('--headless=new', '--disable-gpu')
  args.push(targetUrl)

  const spawnImpl = typeof spawnFn === 'function' ? spawnFn : spawn
  let child
  try {
    child = spawnImpl(executable, args, { detached: true, stdio: 'ignore' })
  } catch (err) {
    return { ok: false, error: `启动 Chrome 登录窗口失败：${(err && err.message) || err}` }
  }
  if (!child || !child.pid) {
    return { ok: false, error: '启动 Chrome 登录窗口失败：未拿到进程 pid' }
  }
  try {
    if (typeof child.unref === 'function') child.unref()
  } catch {
    /* 忽略 */
  }

  try {
    await waitForSpawn(child, SPAWN_TIMEOUT_MS)
  } catch (err) {
    try {
      if (typeof child.kill === 'function') child.kill('SIGKILL')
    } catch {
      /* 未启动成功 */
    }
    return { ok: false, error: `启动 Chrome 登录窗口失败：${(err && err.message) || err}` }
  }
  if (signal && signal.aborted) {
    try {
      if (typeof child.kill === 'function') child.kill('SIGKILL')
    } catch {
      /* 忽略 */
    }
    return { ok: false, error: '请求已取消' }
  }

  windows.set(provider, {
    port,
    pid: child.pid,
    startedAt: Date.now(),
    owned: true,
    ...(typeof killFn === 'function' ? { killFn } : {}),
  })
  return { ok: true, port, pid: child.pid }
}

/**
 * 轮询登录窗口：CDP 读到登录 cookie 就 confirmed（并自动关窗）。
 * @param {object} [options]
 * @param {'douyin'|'bilibili'} options.provider
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ok:boolean, state:'waiting'|'confirmed'|'closed'|'error',
 *                    cookie?:string, account?:{name?:string}, error?:string}>}
 */
export async function pollLogin({
  provider,
  signal,
  cdpPort,
  pid,
  startedAt,
  isAlive,
  wsFactory,
  accountLookup,
  enrichAccount = true,
  now,
  timeoutMs,
} = {}) {
  const config = getProvider(provider)
  if (!config) return { ok: false, state: 'error', error: invalidProvider(provider) }
  if (signal && signal.aborted) return { ok: false, state: 'error', error: '请求已取消' }

  const tracked = windows.get(provider) || null
  const injectedPort = Number(cdpPort)
  const hasInjected = Number.isFinite(injectedPort) && injectedPort > 0
  if (!tracked && !hasInjected) {
    return { ok: false, state: 'error', error: '没有正在进行的登录窗口，请先点击「打开登录窗口」' }
  }

  const record = tracked || {
    port: injectedPort,
    pid: Number.isFinite(Number(pid)) ? Number(pid) : null,
    startedAt: Number.isFinite(Number(startedAt)) ? Number(startedAt) : Date.now(),
    owned: false,
    injected: true,
  }
  const nowMs = typeof now === 'function' ? Number(now()) : Date.now()
  const startMs = Number.isFinite(Number(record.startedAt)) ? Number(record.startedAt) : nowMs
  const maxWaitMs =
    Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : LOGIN_TIMEOUT_MS
  const aliveFn = typeof isAlive === 'function' ? isAlive : isPidAlive
  const port = hasInjected ? injectedPort : Number(record.port)

  // 5 分钟还没登录：关窗，按 closed 返回（UI 提示可重试，不显示成系统错误）。
  if (nowMs - startMs > maxWaitMs) {
    await closeWindow(provider)
    return {
      ok: true,
      state: 'closed',
      error: `登录等待超时（${Math.round(maxWaitMs / 60000)} 分钟），已关闭登录窗口；可重新打开或手动粘贴 Cookie`,
    }
  }

  let cookies
  try {
    cookies = await readCookiesViaCdp(port, { signal, wsFactory })
  } catch (err) {
    if (signal && signal.aborted) return { ok: false, state: 'error', error: '请求已取消' }
    const pidValue = record.pid
    const alive = pidValue ? aliveFn(pidValue) : true
    if (!alive) {
      if (tracked) windows.delete(provider)
      return { ok: true, state: 'closed' }
    }
    // Chrome 还在启动/页面还在加载，或 CDP 暂时没就绪：下一轮再读。
    return { ok: true, state: 'waiting' }
  }

  const picked = buildCookieHeader(cookies, config, nowMs)
  if (!picked.hasRequired) return { ok: true, state: 'waiting' }

  const result = { ok: true, state: 'confirmed', cookie: picked.header }

  // B站可以顺手用同一个 cookie 调 nav 拿昵称（失败不影响登录成功）。
  if (config.profileKey === 'bilibili' && enrichAccount !== false) {
    const lookup = typeof accountLookup === 'function' ? accountLookup : fetchBiliAccount
    try {
      const lookupSignal =
        typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(6000)
          : undefined
      const info = await lookup({ cookie: picked.header, signal: lookupSignal })
      if (info && info.ok && info.name) result.account = { name: info.name }
    } catch {
      /* 账号信息只是锦上添花，忽略 */
    }
  }

  await closeWindow(provider) // 登录成功后自动关掉登录窗口
  return result
}

/**
 * 关闭指定 provider 的登录窗口（幂等；没开着也返回 ok）。
 * @param {{ provider?:string }} [options]
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function cancelLogin({ provider } = {}) {
  const config = getProvider(provider)
  if (!config) return { ok: false, error: invalidProvider(provider) }
  await closeWindow(provider)
  return { ok: true }
}

/**
 * 无条件读取当前登录窗口的 cookies（不判断是否已登录），供「我已完成登录」手动确认。
 * @returns {Promise<{ ok:boolean, cookie?:string, error?:string }>}
 */
export async function captureCookies({ provider } = {}) {
  const config = getProvider(provider)
  if (!config) return { ok: false, error: invalidProvider(provider) }
  const record = windows.get(provider)
  if (!record) return { ok: false, error: '登录窗口未打开' }
  try {
    const cookies = await readCookiesViaCdp(record.port, {})
    const picked = buildCookieHeader(cookies, config, Date.now())
    if (!picked.header) return { ok: false, error: '没有读到 cookie，请确认已在窗口里登录' }
    return { ok: true, cookie: picked.header }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
}

/**
 * 当前内存里打开的登录窗口（provider -> {port,pid}，没开为 null）。
 * @returns {{ douyin: {port:number,pid:number}|null, bilibili: {port:number,pid:number}|null }}
 */
export function loginWindows() {
  const snapshot = {}
  for (const provider of Object.keys(PROVIDERS)) {
    const record = windows.get(provider)
    snapshot[provider] = record ? { port: record.port, pid: record.pid } : null
  }
  return snapshot
}

/* --------------------------------------------------- 无头 Chrome 抓页面 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

/**
 * 用无头 Chrome（CDP）打开页面并取回渲染后的 HTML。
 * 小红书等站点会按 TLS 指纹把 Node fetch 重定向到登录页，只有真实浏览器能拿到 SSR 数据。
 *
 * @param {{ url: string, provider?: 'xiaohongshu'|'douyin'|'bilibili', timeoutMs?: number,
 *           chromePath?: string, spawnFn?: Function, killFn?: Function }} options
 * @returns {Promise<{ ok: boolean, html?: string, finalUrl?: string, error?: string }>}
 */
export async function fetchPageViaBrowser({ url, provider = 'xiaohongshu', timeoutMs = 25000, chromePath, spawnFn, killFn } = {}) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { ok: false, error: '页面地址无效' }
  const executable = resolveChromePath(chromePath)
  if (!executable) return { ok: false, error: '未找到 Google Chrome，无法渲染小红书正文' }
  const spawnImpl = typeof spawnFn === 'function' ? spawnFn : spawn
  const killImpl = typeof killFn === 'function' ? killFn : (pid, signal) => process.kill(pid, signal)
  let lastError = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const profileDir = mkdtempSync(join(tmpdir(), 'wl-browser-'))
    const port = await pickFreePort()
    let child = null
    try {
      child = spawnImpl(
        executable,
        [
          '--headless=new',
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${profileDir}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-blink-features=AutomationControlled',
          '--mute-audio',
          '--window-size=1280,900',
          url,
        ],
        { detached: true, stdio: 'ignore' },
      )
      child.unref?.()
      const pageWs = await waitForPageTarget(port, Math.min(timeoutMs, 20000))
      const html = await readPageHtml(pageWs, Math.min(timeoutMs, 15000))
      if (html && html.includes('noteDetailMap')) return { ok: true, html, finalUrl: url }
      if (html) return { ok: true, html, finalUrl: url }
      lastError = '页面渲染超时（没有拿到正文）'
    } catch (error) {
      lastError = String(error?.message || error)
    } finally {
      const pid = child && child.pid
      if (pid) {
        for (const target of [-pid, pid]) {
          try {
            killImpl(target, 'SIGKILL')
          } catch {
            // 进程可能已退出
          }
        }
      }
      try {
        rmSync(profileDir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  }
  return { ok: false, error: lastError || 'Chrome 渲染失败' }
}

async function waitForPageTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await response.json()
      const page = list.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch {
      // Chrome 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Chrome 调试端口未就绪')
}

function cdpEvalViaSocket(socket, id, expression) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message.id !== id) return
      socket.removeEventListener('message', onMessage)
      clearTimeout(timer)
      if (message.error) reject(new Error(message.error.message || 'CDP 错误'))
      else resolve(message.result)
    }
    const timer = setTimeout(() => {
      socket.removeEventListener('message', onMessage)
      reject(new Error('CDP 超时'))
    }, 8000)
    socket.addEventListener('message', onMessage)
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
  })
}

async function readPageHtml(wsUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const socket = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true })
  })
  try {
    let id = 0
    const evaluate = (expression) => cdpEvalViaSocket(socket, ++id, expression)
    let html = ''
    while (Date.now() < deadline) {
      try {
        const state = await evaluate('document.readyState + "|" + (window.__INITIAL_STATE__ ? "state" : "nostate") + "|" + (document.body ? document.body.innerText.length : 0)')
        const value = typeof state?.result?.value === 'string' ? state.result.value : ''
        const [ready, flag, textLen] = value.split('|')
        void ready
        void textLen
        if (flag === 'state') {
          const out = await evaluate('document.documentElement.outerHTML')
          const candidate = typeof out?.result?.value === 'string' ? out.result.value : ''
          if (candidate) {
            html = candidate
            if (html.includes('noteDetailMap')) break
          }
        }
      } catch {
        // 页面还在跳转
      }
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    return html
  } finally {
    try {
      socket.close()
    } catch {
      // ignore
    }
  }
}
