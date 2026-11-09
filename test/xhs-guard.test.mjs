/**
 * 小红书风控闸门测试：冷却、节流、错误分类，以及「风控错误不许挂失效」。
 *   node --test test/xhs-guard.test.mjs
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'dsh-watch-later-xhs-guard-'))
process.env.DSH_WATCH_LATER_DIR = dataDir

const guard = await import('../xhs-guard.js')
const store = await import('../store.js')

after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    // 清理失败不影响结果
  }
})

test('isXhsBlockedError 只认风控类错误', () => {
  assert.equal(guard.isXhsBlockedError('小红书风控拦截（sec_404），已进入冷却'), true)
  assert.equal(guard.isXhsBlockedError('error_code=300031 当前笔记暂时无法浏览'), true)
  assert.equal(guard.isXhsBlockedError('小红书风控冷却中（约 30 分钟后重试）'), true)
  assert.equal(guard.isXhsBlockedError('小红书笔记已删除或不可见（404）'), false)
  assert.equal(guard.isXhsBlockedError('页面返回 HTTP 500'), false)
  assert.equal(guard.isXhsBlockedError(''), false)
})

test('撞到风控进入冷却，连续命中翻倍，成功后可恢复', () => {
  assert.equal(guard.isXhsCoolingDown(), false)
  guard.xhsFetchBlocked()
  assert.equal(guard.isXhsCoolingDown(), true)
  const first = guard.xhsCooldownRemaining()
  assert.ok(first > 25 * 60_000 && first <= 30 * 60_000, '首次冷却约 30 分钟：' + first)

  guard.xhsFetchBlocked()
  const second = guard.xhsCooldownRemaining()
  assert.ok(second > first, '连续第二次命中应更长')

  assert.match(guard.xhsCooldownError(), /冷却中/)
  guard.xhsFetchSucceeded()
  assert.equal(guard.isXhsCoolingDown(), false)
  assert.equal(guard.xhsGuardStatus().consecutiveBlocks, 0)
})

test('waitXhsTurn 按间隔节流', async () => {
  guard.xhsFetchSucceeded()
  const first = await guard.waitXhsTurn({ intervalMs: 60 })
  assert.equal(first, 0, '第一次不该等')
  const started = Date.now()
  const second = await guard.waitXhsTurn({ intervalMs: 60 })
  assert.ok(Date.now() - started >= 30, '第二次要等到间隔之后')
  assert.ok(second >= 0)
})

test('风控错误不把条目挂进失效区，并洗掉之前的误判', async () => {
  const created = store.addItem({ url: 'https://www.xiaohongshu.com/discovery/item/abc123', kind: 'xhs', title: '测试笔记' })
  const id = (created && created.item ? created.item : created).id

  // 先被误判成「笔记已删除」
  store.setItemContent(id, { type: 'page', text: null, images: [], fetchedAt: new Date().toISOString(), error: '小红书笔记已删除或不可见（404）' })
  assert.ok(store.getItem(id).invalid, '真实 404 仍应标记失效')

  // 风控错误到达：撤销误判
  store.setItemContent(id, { type: 'page', text: null, images: [], fetchedAt: new Date().toISOString(), error: '小红书正文抓取失败：小红书风控拦截（sec_404），已进入冷却' })
  assert.equal(store.getItem(id).invalid, null, '风控错误不该挂失效')

  // 冷却错误同样不挂失效
  store.setItemContent(id, { type: 'page', text: null, images: [], fetchedAt: new Date().toISOString(), error: '小红书风控冷却中（约 30 分钟后重试），本条先保留待补' })
  assert.equal(store.getItem(id).invalid, null)
})
