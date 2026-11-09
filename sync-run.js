/**
 * Sync orchestration for Bilibili and Douyin watch-later lists.
 *
 * The provider adapters (sync/bili.js, sync/douyin.js) only talk HTTP and
 * normalize remote rows; this module owns the merge policy: dedupe by
 * (provider, remoteId), refresh metadata on existing rows, and never touch the
 * user's own triage fields (status / importance / urgency / deadline / notes).
 */
import { fetchWatchLater as fetchBiliWatchLater } from './sync/bili.js'
import { fetchWatchLater as fetchDouyinWatchLater } from './sync/douyin.js'
import { getCookie, getSyncState, setSyncState, addItem, findBySync, updateItem, getSettings } from './store.js'
import { isRemoteRemoved } from './remove.js'

const PROVIDERS = ['bilibili', 'douyin']

function durationMinFromSec(sec) {
  const n = Number(sec)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.max(1, Math.min(600, Math.ceil(n / 60)))
}

function remoteToItem(provider, remote, syncedAt) {
  const isBili = provider === 'bilibili'
  return {
    title: String(remote.title || (isBili ? 'B站视频' : '抖音视频')).slice(0, 200),
    url: remote.url || null,
    cover: remote.cover || null,
    author: remote.author || null,
    summary: null,
    kind: isBili ? 'bilibili' : 'douyin',
    site: isBili ? 'B站' : '抖音',
    channel: provider,
    status: 'inbox',
    importance: 3,
    urgency: 2,
    durationMin: durationMinFromSec(remote.durationSec),
    sync: {
      provider,
      remoteId: String(remote.remoteId),
      syncedAt,
      owner: remote.author || null,
      stats: {
        durationSec: Number.isFinite(Number(remote.durationSec)) ? Number(remote.durationSec) : null,
        addedAt: remote.addedAt || null,
        // B站：写回删除只认数字 aid，而新版视频的 aid 无法由 bvid 反推，必须存接口给的原值
        aid: Number.isFinite(Number(remote.aid)) && Number(remote.aid) > 0 ? Number(remote.aid) : null,
      },
    },
  }
}

function mergeRemoteItems(provider, remotes) {
  const syncedAt = new Date().toISOString()
  let imported = 0
  let updated = 0
  let skipped = 0
  const importedIds = []
  for (const remote of Array.isArray(remotes) ? remotes : []) {
    try {
      if (!remote || !remote.remoteId) {
        skipped += 1
        continue
      }
      // 本地「移除」过但没能在平台上删掉的（B站失败 / 抖音写不回），
      // 留过墓碑就不再导回来，否则用户会看到「删了又复活」。
      if (isRemoteRemoved(provider, remote.remoteId)) {
        skipped += 1
        continue
      }
      const existing = findBySync(provider, remote.remoteId)
      if (existing) {
        const patch = { sync: { ...(existing.sync || {}), syncedAt } }
        let changed = false
        if (remote.title && remote.title !== existing.title) {
          patch.title = String(remote.title).slice(0, 200)
          changed = true
        }
        if (remote.cover && remote.cover !== existing.cover) {
          patch.cover = remote.cover
          changed = true
        }
        const minutes = durationMinFromSec(remote.durationSec)
        if (minutes && minutes !== existing.durationMin) {
          patch.durationMin = minutes
          changed = true
        }
        updateItem(existing.id, patch)
        if (changed) updated += 1
        else skipped += 1
        continue
      }
      const row = remoteToItem(provider, remote, syncedAt)
      const result = addItem(row, { dedupe: true })
      if (result.duplicate) skipped += 1
      else {
        imported += 1
        importedIds.push(result.item.id)
      }
    } catch {
      skipped += 1
    }
  }
  return { imported, updated, skipped, importedIds }
}

function failedResult(provider, error, extra = {}) {
  return {
    ok: false,
    provider,
    imported: 0,
    updated: 0,
    skipped: 0,
    total: 0,
    error: String(error || '同步失败'),
    ...extra,
  }
}

/**
 * Pull one provider's watch-later list into the collection.
 * Returns { ok, provider, imported, updated, skipped, total, importedIds, account?, error?, supported? }.
 */
export async function runSync(provider, options = {}) {
  if (!PROVIDERS.includes(provider)) return failedResult(provider, '未知的同步来源')
  const cookie = getCookie(provider)
  const startedAt = new Date().toISOString()
  if (provider === 'bilibili') {
    if (!cookie) {
      setSyncState('bilibili', { lastError: '还没配置 B 站 cookie', lastSyncAt: startedAt })
      return failedResult('bilibili', '还没配置 B 站 cookie（至少需要 SESSDATA），先到「同步」页粘贴', { configured: false })
    }
    const result = await fetchBiliWatchLater({ cookie, signal: options.signal })
    if (!result || !result.ok) {
      const error = result?.error || 'B站接口请求失败'
      setSyncState('bilibili', { lastError: error, lastSyncAt: startedAt })
      return failedResult('bilibili', error)
    }
    const account = result.account || null
    if (account) setSyncState('bilibili', { account })
    const merged = mergeRemoteItems('bilibili', result.items)
    const lastResult = { imported: merged.imported, updated: merged.updated, skipped: merged.skipped, total: result.items.length }
    setSyncState('bilibili', { lastError: null, lastSyncAt: startedAt, lastResult, account: account || getSyncState().bilibili.account || null })
    return { ok: true, provider: 'bilibili', ...lastResult, total: result.items.length, importedIds: merged.importedIds, account }
  }

  // douyin
  if (!cookie) {
    setSyncState('douyin', { lastError: '还没配置抖音 cookie（至少含 sessionid）', lastSyncAt: startedAt, supported: true })
    return failedResult('douyin', '还没配置抖音 Cookie（至少含 sessionid）。到「同步」页粘贴 douyin.com 登录后的完整 Cookie 再试；也可以直接把分享链接/文案粘到「添加」里', { supported: true })
  }
  const result = await fetchDouyinWatchLater({ cookie, signal: options.signal })
  const supported = result?.supported !== false
  setSyncState('douyin', { supported: true })
  if (!result || !result.ok) {
    const error = result?.error || '抖音接口请求失败'
    setSyncState('douyin', { lastError: error, lastSyncAt: startedAt })
    return failedResult('douyin', error, { supported })
  }
  const merged = mergeRemoteItems('douyin', result.items)
  const lastResult = { imported: merged.imported, updated: merged.updated, skipped: merged.skipped, total: result.items.length }
  setSyncState('douyin', { lastError: null, lastSyncAt: startedAt, lastResult })
  return { ok: true, provider: 'douyin', ...lastResult, total: result.items.length, importedIds: merged.importedIds, supported }
}

/** Compact live status used by /settings responses. */
export function syncStatuses() {
  const state = getSyncState()
  return { bilibili: state.bilibili, douyin: state.douyin }
}

export { getSettings }
