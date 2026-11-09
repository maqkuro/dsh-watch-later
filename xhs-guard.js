/**
 * 小红书风控闸门（2026-11-09）。
 *
 * 起因：小红书按 IP 做风控，连续抓一百多条后整站 302 到 `/404/sec_*`
 * （真浏览器里显示 error_code=300031「当前笔记暂时无法浏览」），
 * 连之前能打开的笔记也一起打不开。原来的入库预抓、AI 整理、封面补齐、详情页
 * 各自独立抓，没人刹车，结果整批条目一起撞墙，还被误判成「笔记已删除」挂进失效区。
 *
 * 现在所有小红书抓取入口都先过这里：
 *   - 节流：两次抓取之间至少隔 MIN_INTERVAL_MS（默认 6 秒）；
 *   - 冷却：命中一次风控后，整个小红书通道暂停 COOLDOWN_MS（默认 30 分钟，连续命中翻倍，上限 2 小时），
 *     冷却期内直接返回「稍后重试」，不打网络、不算失败、不写失效；
 *   - 状态落在 DATA_DIR/xhs-guard.json，进程重启、脚本调用都共享。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './store.js'

const STATE_FILE = join(DATA_DIR, 'xhs-guard.json')
const MIN_INTERVAL_MS = 6_000
const COOLDOWN_MS = 30 * 60_000
const MAX_COOLDOWN_MS = 2 * 60 * 60_000

/** 一行文字是不是「被小红书风控挡了」而不是「内容真的没了」。 */
export function isXhsBlockedError(text) {
  const value = String(text || '')
  if (!value) return false
  return /sec_404|sec_server|风控|300031|暂时无法浏览|环境异常/i.test(value)
}

function now() {
  return Date.now()
}

function readState() {
  try {
    if (!existsSync(STATE_FILE)) return {}
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function writeState(patch) {
  const next = { ...readState(), ...patch, updatedAt: new Date().toISOString() }
  try {
    writeFileSync(STATE_FILE, JSON.stringify(next, null, 2))
  } catch {
    // 状态写不进去也不能影响抓取本身
  }
  return next
}

/** 还要等多少毫秒才能再抓小红书；0 表示现在就能抓。 */
export function xhsCooldownRemaining(nowMs = now()) {
  const blockedUntil = Date.parse(readState().blockedUntil || '')
  if (!Number.isFinite(blockedUntil)) return 0
  return Math.max(0, blockedUntil - nowMs)
}

export function isXhsCoolingDown(nowMs = now()) {
  return xhsCooldownRemaining(nowMs) > 0
}

/** 冷却期里给调用方的统一错误文案（可重试，不要当成失效）。 */
export function xhsCooldownError(nowMs = now()) {
  const minutes = Math.max(1, Math.ceil(xhsCooldownRemaining(nowMs) / 60_000))
  return `小红书风控冷却中（约 ${minutes} 分钟后重试），本条先保留待补`
}

/** 抓取前调用：按节流间隔等一等（进程内 + 跨进程都看 lastFetchAt）。 */
export async function waitXhsTurn(options = {}) {
  const interval = Number.isFinite(Number(options.intervalMs)) ? Math.max(0, Number(options.intervalMs)) : MIN_INTERVAL_MS
  const last = Date.parse(readState().lastFetchAt || '')
  const wait = Number.isFinite(last) ? last + interval - now() : 0
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(wait, interval)))
  writeState({ lastFetchAt: new Date().toISOString() })
  return Math.max(0, wait)
}

/** 抓到正常笔记：清掉连续命中计数与冷却。 */
export function xhsFetchSucceeded() {
  return writeState({ blockedUntil: null, consecutiveBlocks: 0, lastSuccessAt: new Date().toISOString() })
}

/** 撞到风控：从 30 分钟起，连续命中按 2/4 倍翻，封顶 2 小时。 */
export function xhsFetchBlocked(nowMs = now()) {
  const state = readState()
  const consecutive = Math.min(4, Number(state.consecutiveBlocks || 0) + 1)
  const wait = Math.min(MAX_COOLDOWN_MS, COOLDOWN_MS * 2 ** (consecutive - 1))
  return writeState({
    consecutiveBlocks: consecutive,
    lastBlockAt: new Date(nowMs).toISOString(),
    blockedUntil: new Date(nowMs + wait).toISOString(),
  })
}

/** 给日志/工具输出看的摘要。 */
export function xhsGuardStatus(nowMs = now()) {
  const state = readState()
  return {
    cooling: xhsCooldownRemaining(nowMs) > 0,
    cooldownMs: xhsCooldownRemaining(nowMs),
    consecutiveBlocks: Number(state.consecutiveBlocks || 0),
    lastBlockAt: state.lastBlockAt || null,
    lastSuccessAt: state.lastSuccessAt || null,
    blockedUntil: state.blockedUntil || null,
  }
}

export default {
  isXhsBlockedError,
  isXhsCoolingDown,
  xhsCooldownRemaining,
  xhsCooldownError,
  waitXhsTurn,
  xhsFetchSucceeded,
  xhsFetchBlocked,
  xhsGuardStatus,
}
