/**
 * remove.js — 「移除」统一入口：本地删除 +（能写回的）远端移出。
 *
 * 为什么要有这一层：
 *   1. 以前「归档」和「删除」是两个动作，主人要求合并成一个「移除」：点一次，
 *      本地不再显示，同时尽量把 B站稍后再看里也移掉（B站有删除接口，抖音没有）。
 *   2. 同步是单向只读的（B站/抖音 -> 本地），本地删掉不会影响平台，
 *      如果不做记号，下次同步会把它重新导回来。所以失败或无法写回时要留墓碑。
 *
 * 墓碑文件：DATA_DIR/removed-remote.json
 *   { "bilibili:123456": { "at": "ISO", "reason": "..." } }
 * sync-run.js 合并远端列表时先查这里，命中就跳过，避免「删了又复活」。
 * 读写墓碑失败一律降级为「不加墓碑」，绝不因为磁盘问题让移除本身失败。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { DATA_DIR, deleteItem, getCookie, getItem } from './store.js'
import { removeFromWatchLater, resolveAidByBvid } from './sync/bili.js'

export const REMOVED_REMOTE_FILE = join(DATA_DIR, 'removed-remote.json')

/** 墓碑 key：provider + remoteId，和 sync 里的 (provider, remoteId) 唯一键一致。 */
function tombstoneKey(provider, remoteId) {
  if (!provider || remoteId === null || remoteId === undefined) return ''
  const id = String(remoteId).trim()
  return id ? `${provider}:${id}` : ''
}

function readTombstones() {
  try {
    const raw = JSON.parse(readFileSync(REMOVED_REMOTE_FILE, 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    // 文件不存在 / 内容坏了都当作「还没有墓碑」
    return {}
  }
}

/**
 * 加墓碑（原子写：临时文件 + rename，和 store.js 的做法一致）。
 * @returns {boolean} 是否真的写成功；失败只返回 false，不抛异常。
 */
export function markRemoteRemoved(provider, remoteId, reason) {
  const key = tombstoneKey(provider, remoteId)
  if (!key) return false
  try {
    const map = readTombstones()
    map[key] = {
      at: new Date().toISOString(),
      reason: String(reason || '本地已移除').slice(0, 300),
    }
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
    const tmp = REMOVED_REMOTE_FILE + '.tmp-' + process.pid + '-' + randomBytes(3).toString('hex')
    writeFileSync(tmp, JSON.stringify(map, null, 2), { mode: 0o600 })
    renameSync(tmp, REMOVED_REMOTE_FILE)
    return true
  } catch {
    return false
  }
}

/** 这条远端记录是不是被本地移除过（同步时用来跳过复活）。 */
export function isRemoteRemoved(provider, remoteId) {
  const key = tombstoneKey(provider, remoteId)
  if (!key) return false
  return Object.prototype.hasOwnProperty.call(readTombstones(), key)
}

/**
 * 解析一条 B站条目真正该用的 aid。
 *
 * 优先级：同步时存下的 `sync.stats.aid` -> remoteId 本身是数字/av 号 -> 公开 view 接口实时查。
 * **故意不用纯算法 `bvidToAid`**：那套算法只对早期 9 位 aid 成立；2026 年后的新视频 aid
 * 已经涨到 15 位（实测 BV1MqxQ6FE4P -> 117557197539987），算出来是完全错误的值，
 * 拿错 aid 去删只会静默失败——本地没了、B站还在。
 */
async function resolveBiliAid(item, signal) {
  const cached = Number(item && item.sync && item.sync.stats && item.sync.stats.aid)
  if (Number.isFinite(cached) && cached > 0) return { aid: cached, error: null }

  const remoteId = String((item && item.sync && item.sync.remoteId) || '').trim()
  if (!remoteId) return { aid: null, error: '条目缺少 B站视频标识' }
  if (/^\d+$/.test(remoteId)) return { aid: Number(remoteId), error: null }
  if (/^av\d+$/i.test(remoteId)) return { aid: Number(remoteId.slice(2)), error: null }

  return resolveAidByBvid(remoteId, { signal })
}

/**
 * 只做「远端移出」，不碰本地数据。
 *
 * 「移除」和「已读」在平台侧是同一个动作（B站没有"标记已读"接口，移出是唯一表达），
 * 差别在本地怎么处理，所以抽出来给两边共用。
 *
 * @returns {Promise<{ provider:string, ok:boolean, unsupported:boolean, error:string|null }>}
 */
export async function removeRemoteOnly(item, options = {}) {
  const provider = item && item.sync && item.sync.provider ? String(item.sync.provider) : ''
  if (!provider) return { provider: '', ok: true, unsupported: false, error: null }

  if (provider === 'douyin') {
    // 抖音移除接口需要 a_bogus 签名，当前实现没有 -> 只能本地处理
    return { provider, ok: false, unsupported: true, error: '抖音不支持写回（缺接口签名），需手动在 App 移出' }
  }
  if (provider !== 'bilibili') {
    return { provider, ok: false, unsupported: true, error: '该来源不支持写回' }
  }

  const resolved = await resolveBiliAid(item, options.signal)
  if (!resolved.aid) {
    return { provider, ok: false, unsupported: false, error: resolved.error || '解析 B站 aid 失败' }
  }
  const cookie = getCookie('bilibili')
  const outcome = await removeFromWatchLater({ cookie, aids: resolved.aid, signal: options.signal })
  if (outcome && outcome.ok) return { provider, ok: true, unsupported: false, error: null }
  return { provider, ok: false, unsupported: false, error: (outcome && outcome.error) || 'B站移除失败' }
}

/**
 * 移除若干条目：本地删除 + B站写回。
 *
 * 分支：
 *   - bilibili：调 removeRemoteOnly 移出平台；失败写墓碑（否则下次同步会复活）
 *   - douyin：接口缺签名，写不回去 -> unsupported；**同时写墓碑**，否则下次同步又会导回来
 *   - 其它（无 sync）：只删本地
 * 单条失败不影响其它条目；不存在的 id 直接跳过。
 *
 * @param {string|string[]} ids
 * @param {{ signal?:AbortSignal }} [options]
 * @returns {Promise<{ removed:number, remoteRemoved:number, remoteFailed:number,
 *                     unsupported:number, errors:Array<{ id:string, provider?:string, error:string }> }>}
 */
export async function removeItems(ids, options = {}) {
  const list = (Array.isArray(ids) ? ids : [ids])
    .map((id) => (typeof id === 'string' ? id.trim() : ''))
    .filter(Boolean)
  const result = { removed: 0, remoteRemoved: 0, remoteFailed: 0, unsupported: 0, errors: [] }
  const seen = new Set()

  for (const id of list) {
    if (seen.has(id)) continue
    seen.add(id)

    let item = null
    try {
      item = getItem(id)
    } catch {
      item = null
    }
    // 已经不在了：跳过，不算错误（批量移除时并发/重复点击很常见）
    if (!item) continue

    const provider = item.sync && item.sync.provider ? String(item.sync.provider) : ''
    const remoteId = item.sync && item.sync.remoteId ? String(item.sync.remoteId) : ''

    if (provider === 'bilibili') {
      const outcome = await removeRemoteOnly(item, options)
      if (outcome.ok) {
        result.remoteRemoved += 1
      } else {
        result.remoteFailed += 1
        result.errors.push({ id, provider, error: outcome.error })
        // 本地删了但远端还在 -> 必须留墓碑，不然下次同步又回来
        if (remoteId) markRemoteRemoved(provider, remoteId, outcome.error)
      }
    } else if (provider === 'douyin') {
      result.unsupported += 1
      // 写不回平台，但本地既然移除了就不该被同步复活；用户若在抖音重新收藏，这里会挡住
      if (remoteId) markRemoteRemoved(provider, remoteId, '抖音不支持写回，已本地移除')
    }

    try {
      deleteItem(id)
      result.removed += 1
    } catch (err) {
      result.errors.push({ id, error: (err && err.message) || String(err) })
    }
  }

  return result
}

export default { removeItems, removeRemoteOnly, isRemoteRemoved, markRemoteRemoved, REMOVED_REMOTE_FILE }
