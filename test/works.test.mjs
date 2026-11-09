/**
 * 作品提取/添加：标题提取、手动添加去重、作者来源。
 *   node --test test/works.test.mjs
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'wl-works-test-'))
process.env.DSH_WATCH_LATER_DIR = dataDir

const { extractWorkNames, addWork, readWorks, updateWork } = await import('../works.js')
const store = await import('../store.js')

after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

const mediaUrl = (name) => '/api/dsh-watch-later/media?f=' + encodeURIComponent(name)

test('从标题提取作品名', () => {
  assert.deepEqual(extractWorkNames({ title: '《影之刃零》支线全攻略', kind: 'game' }), ['影之刃零'])
  assert.deepEqual(extractWorkNames({ title: '【影之刃零】会断支线全 24 条', kind: 'game' }), ['影之刃零'])
  assert.deepEqual(extractWorkNames({ title: '死锁段位分布图', kind: 'game' }), ['死锁'])
  assert.deepEqual(extractWorkNames({ title: '2026年上半年的好番，前几季就很不错', kind: 'drama' }), [])
  assert.deepEqual(extractWorkNames({ title: '真的没人来用我的mod吗', kind: 'game' }), [])
})

test('手动添加作品：查封面、去重、来源记录', async () => {
  const lookupFn = async (title, kind) => ({ ok: true, title, kind, cover: mediaUrl('cover.jpg'), summary: '简介', subjectId: 123 })
  const item = store.addItem({ kind: 'drama', title: '某文章' }).item
  const first = await addWork({ title: '银之匙', kind: 'drama', sourceItem: item, lookupFn })
  assert.equal(first.ok, true)
  assert.equal(first.created, true)
  assert.equal(first.work.sourceUrl, null)
  assert.equal(first.work.sourceTitle, '某文章')

  const second = await addWork({ title: '银之匙 Silver Spoon', kind: 'drama', lookupFn })
  assert.equal(second.ok, true)
  assert.equal(second.created, false, '同 subjectId 应复用')
  assert.equal(readWorks().length, 1)

  const updated = updateWork(first.work.id, { status: 'playing' })
  assert.equal(updated.work.status, 'playing')
})

test('添加失败会返回真实错误', async () => {
  const lookupFn = async () => ({ ok: false, error: '没找到对应作品' })
  const result = await addWork({ title: '不存在的作品', kind: 'game', lookupFn })
  assert.equal(result.ok, false)
  assert.match(result.error, /没找到/)
})
