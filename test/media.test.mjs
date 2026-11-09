/**
 * 「影游」分类：relevant / guide / list。
 *   node --test test/media.test.mjs
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'wl-media-test-'))
process.env.DSH_WATCH_LATER_DIR = dataDir

const { mediaInfo, mediaClassOf, isMediaItem } = await import('../media.js')
const store = await import('../store.js')

after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

test('游戏/影视与影游标签才算影游条目', () => {
  assert.equal(isMediaItem({ kind: 'game', title: 'x' }), true)
  assert.equal(isMediaItem({ kind: 'drama', title: 'x' }), true)
  assert.equal(isMediaItem({ kind: 'xhs', title: 'x', tags: ['影游'] }), true)
  assert.equal(isMediaItem({ kind: 'xhs', title: 'x', tags: ['设计'] }), false)
})

test('攻略 vs 清单启发式', () => {
  assert.equal(mediaClassOf({ kind: 'game', title: '影之刃零 支线攻略', tags: ['攻略'] }), 'guide')
  assert.equal(mediaClassOf({ kind: 'game', title: '多家媒体评分解禁', tags: ['游戏评测'] }), 'guide')
  assert.equal(mediaClassOf({ kind: 'drama', title: '2026年上半年的好番', tags: ['番剧'], url: 'http://mp.weixin.qq.com/s/x' }), 'list')
  assert.equal(mediaClassOf({ kind: 'drama', title: '银之匙', tags: ['剧集'] }), 'list')
  // 手动指定优先
  assert.equal(mediaClassOf({ kind: 'game', title: '影之刃零 支线攻略', mediaClass: 'list' }), 'list')
})

test('mediaClass 可通过 updateItem 持久化，snapshot 带 media 信息', () => {
  const added = store.addItem({ kind: 'game', title: '测试攻略', url: 'https://api.xiaoheihe.cn/x', tags: ['影游', '攻略'] })
  const id = added.item.id
  let view = store.buildSnapshot({ nowMs: Date.now() }).items.find((item) => item.id === id)
  assert.equal(view.media.relevant, true)
  assert.equal(view.media.group, 'guide')

  store.updateItem(id, { mediaClass: 'list' })
  view = store.buildSnapshot({ nowMs: Date.now() }).items.find((item) => item.id === id)
  assert.equal(view.media.group, 'list')
  assert.equal(store.updateItem(id, { mediaClass: 'bogus' }).ok, false)
})
