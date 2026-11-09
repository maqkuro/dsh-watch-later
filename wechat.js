/**
 * wechat.js — 公众号文章正文的「真浏览器」兜底通道（腾讯 BrowserSkill / bsk CLI）。
 *
 * 背景（2026-11-09 实测）：
 *   微信对部分公众号文章做了文章级风控，curl / Node fetch / 无头 Chromium 一律 302 到
 *   `mp/wappoc_appmsgcaptcha` 验证页（"环境异常"）。同一个 UA、同一个出口 IP 抓别的
 *   公众号文章却完全正常 —— 所以这不是网络问题，是身份问题。
 *   BrowserSkill 不破解验证码，而是把任务放进主人**已登录的 Chrome** 里执行，用真人会话进场。
 *
 * 这个模块只做一件事：给一个公众号 URL，拿回渲染后的 HTML，交给 content.js 复用现有的
 * extractArticleText 解析。所有失败都降级为 { ok:false, error }，绝不抛异常。
 *
 * 约束：
 *   - 浏览器会话很重，全进程串行化（同一时刻只有一个 bsk session），避免 AI 整理批量跑时开一堆窗口；
 *   - 每次必停 session（finally），失败也不留僵尸窗口；
 *   - 扩展没连上时直接快速失败并缓存 60s，避免每条都白等一轮超时。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BSK_CANDIDATES = [
  process.env.BSK_PATH,
  join(homedir(), '.local', 'bin', 'bsk'),
  '/opt/homebrew/bin/bsk',
  '/usr/local/bin/bsk',
]

const NAV_TIMEOUT_MS = 25000
const HTML_TIMEOUT_MS = 20000
const MAX_HTML_BYTES = 3 * 1024 * 1024
const HEALTH_TTL_MS = 60 * 1000

let cachedBinary = null
let healthCache = { at: 0, ok: false, error: null }
let chain = Promise.resolve()

/* ------------------------------------------------------------------ 基础 */

function resolveBsk() {
  if (cachedBinary && existsSync(cachedBinary)) return cachedBinary
  for (const candidate of BSK_CANDIDATES) {
    if (candidate && existsSync(candidate)) {
      cachedBinary = candidate
      return candidate
    }
  }
  cachedBinary = null
  return null
}

function runBsk(args, timeoutMs) {
  const binary = resolveBsk()
  if (!binary) {
    return Promise.resolve({ ok: false, code: -1, stdout: '', stderr: '没有找到 bsk 可执行文件（~/.local/bin/bsk）' })
  }
  return new Promise((resolve) => {
    execFile(binary, args, { timeout: timeoutMs, maxBuffer: MAX_HTML_BYTES * 2, env: process.env }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : error.killed ? 'timeout' : 1) : 0
      resolve({
        ok: !error,
        code,
        stdout: String(stdout || ''),
        stderr: String(stderr || '') || (error && error.message) || '',
      })
    })
  })
}

function parseJson(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    // bsk 有时在 JSON 前后打日志行，退化为取第一个 {...} / [...] 片段
    const start = raw.search(/[[{]/)
    const end = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'))
    if (start < 0 || end <= start) return null
    try {
      return JSON.parse(raw.slice(start, end + 1))
    } catch {
      return null
    }
  }
}

/** 串行队列：浏览器会话是独占资源，批量整理时必须排队。 */
function enqueue(task) {
  const next = chain.then(task, task)
  // 队列本身不能因为单条失败而断掉
  chain = next.catch(() => null)
  return next
}

/* ------------------------------------------------------------ 健康检查 */

/**
 * bsk 是否可用：CLI 在 + daemon 在 + 浏览器扩展已连接。
 * `bsk doctor` 是全量诊断（含一次等待扩展的轮询），约 1-3 秒，所以结果缓存 60 秒。
 */
export async function bskHealth(options = {}) {
  const now = Date.now()
  if (!options.force && now - healthCache.at < HEALTH_TTL_MS) return healthCache
  if (!resolveBsk()) {
    healthCache = { at: now, ok: false, error: 'bsk CLI 未安装（~/.local/bin/bsk）' }
    return healthCache
  }
  const result = await runBsk(['doctor'], 12000)
  const text = result.stdout + '\n' + result.stderr
  const connected = /ok\s+extension connected/i.test(text) && !/FAIL\s+extension connected/i.test(text)
  healthCache = {
    at: now,
    ok: connected,
    error: connected ? null : 'BrowserSkill 扩展未连接（在 Chrome 里装好扩展并保持窗口打开）',
  }
  return healthCache
}

export function resetBskHealth() {
  healthCache = { at: 0, ok: false, error: null }
}

/* ------------------------------------------------------------ 抓取主流程 */

function looksBlocked(html) {
  return /wappoc_appmsgcaptcha|secitptpage\/verify|环境异常|当前环境异常/i.test(String(html || ''))
}

async function startSession() {
  const result = await runBsk(['session', 'start', '--json', '--agent-name', 'DSH 稍后再看'], 15000)
  const data = parseJson(result.stdout)
  const id =
    (data && (data.session_id || data.sessionId || (data.session && data.session.id) || data.id)) ||
    (/session[_-]?id["'\s:]+([0-9a-zA-Z_-]+)/i.exec(result.stdout + result.stderr) || [])[1] ||
    null
  if (!id) {
    return { ok: false, error: 'bsk 没能创建浏览器会话：' + (result.stderr || result.stdout || '').trim().slice(0, 200) }
  }
  return { ok: true, id }
}

async function stopSession(id) {
  try {
    await runBsk(['session', 'stop', String(id)], 10000)
  } catch {
    // 收尾失败不影响结果
  }
}

/**
 * 用 bsk 真浏览器打开一个公众号文章，返回渲染后的 HTML。
 * @param {string} url
 * @param {{ timeoutMs?: number }} options
 * @returns {Promise<{ok:boolean, html?:string, error?:string, blocked?:boolean, ms?:number}>}
 */
export async function fetchWechatHtmlViaBsk(url, options = {}) {
  if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, error: '不是合法链接' }

  return enqueue(async () => {
    const startedAt = Date.now()
    const health = await bskHealth()
    if (!health.ok) return { ok: false, error: health.error || 'bsk 不可用', ms: Date.now() - startedAt, unavailable: true }

    const session = await startSession()
    if (!session.ok) return { ok: false, error: session.error, ms: Date.now() - startedAt }

    try {
      const nav = await runBsk(['navigate', url, '--session', session.id, '--json'], options.timeoutMs || NAV_TIMEOUT_MS)
      if (!nav.ok) {
        return { ok: false, error: 'bsk 打开页面失败：' + (nav.stderr || '').trim().slice(0, 200), ms: Date.now() - startedAt }
      }
      // 公众号正文是同步渲染的，导航完成后给一次短暂停顿让风控页/正文定稿
      await delay(900)

      let html = await dumpHtml(session.id)
      if (!html) {
        return { ok: false, error: 'bsk 没有返回页面 HTML', ms: Date.now() - startedAt }
      }

      // 关键一步（2026-11-09 实测）：落到「环境异常 → 去验证」页时，点一下「去验证」，
      // 主人 Chrome 里的信任态会让它自动放行，正文随即出现。不需要人工点滑块。
      let solvedVerify = false
      for (let attempt = 0; attempt < 2 && looksBlocked(html); attempt += 1) {
        const clicked = await runBsk(['click', '#js_verify', '--session', session.id], 12000)
        if (!clicked.ok) break
        await delay(2500)
        const next = await dumpHtml(session.id)
        if (!next) break
        html = next
        solvedVerify = true
      }

      if (looksBlocked(html)) {
        return { ok: false, blocked: true, error: '浏览器会话里仍然被微信验证页拦截', ms: Date.now() - startedAt }
      }
      return { ok: true, html, solvedVerify, ms: Date.now() - startedAt }
    } finally {
      await stopSession(session.id)
    }
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function dumpHtml(sessionId) {
  const dump = await runBsk(
    ['get-html', '--session', sessionId, '--json', '--max-bytes', String(MAX_HTML_BYTES)],
    HTML_TIMEOUT_MS,
  )
  return extractHtml(dump)
}

function extractHtml(dump) {
  if (!dump || !dump.ok) return null
  const data = parseJson(dump.stdout)
  if (data && typeof data === 'object') {
    for (const key of ['html', 'content', 'data', 'dom']) {
      if (typeof data[key] === 'string' && data[key].length > 200) return data[key]
    }
  }
  const text = String(dump.stdout || '')
  if (text.trim().length > 200) return text
  return null
}
