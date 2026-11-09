/**
 * 封面补齐：文章类条目缺图时自动解析并回填 cover/images。
 *   node --test test/cover-backfill.test.mjs
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'wl-cover-test-'))
process.env.DSH_WATCH_LATER_DIR = dataDir

const store = await import('../store.js')
const { backfillCovers } = await import('../cover-backfill.js')

after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

const mediaUrl = (name) => '/api/dsh-watch-later/media?f=' + encodeURIComponent(name)

test('补充封面：有图回填 cover/images，无图跳过，已有封面不重复处理', async () => {
  const a = store.addItem({ kind: 'xhs', title: '有图的小红书' }).item
  const b = store.addItem({ kind: 'xhs', title: '没图的小红书' }).item
  const c = store.addItem({ kind: 'wechat', title: '已有封面的公众号', cover: mediaUrl('old.jpg') }).item

  const calls = []
  const resolveFn = async (item) => {
    calls.push(item.id)
    if (item.id === b.id) return { type: 'page', text: null, images: [], error: '解析不到图片' }
    return { type: 'article', text: '正文', images: [mediaUrl('a-1.jpg'), mediaUrl('a-2.jpg')] }
  }

  const result = await backfillCovers({ resolveFn, delayMs: 0 })
  // 只补没有封面的条目：a 补正文图；b 没图则生成 SVG 封面兜底；c 已有封面不再处理
  assert.equal(result.checked, 2)
  assert.equal(result.covered, 2)
  assert.equal(result.skipped, 0)
  assert.ok(calls.includes(a.id))
  assert.ok(calls.includes(b.id))
  assert.ok(!calls.includes(c.id), '已有封面的条目不处理')
  assert.equal(store.getItem(c.id).cover, mediaUrl('old.jpg'))
  assert.equal(store.getItem(c.id).images.length, 0)
  assert.ok(String(store.getItem(b.id).cover || '').includes('.svg'))

  const covered = store.getItem(a.id)
  assert.equal(covered.cover, mediaUrl('a-1.jpg'))
  assert.deepEqual(covered.images, [mediaUrl('a-1.jpg'), mediaUrl('a-2.jpg')])

  // 第二轮：b 只有生成的 SVG 封面仍会再尝试一次真封面，但不会重复生成
  const second = await backfillCovers({ resolveFn, delayMs: 0 })
  assert.equal(second.checked, 1)
  assert.equal(second.covered, 0)
  assert.equal(second.skipped, 1)
})

test('force 模式会重新解析并覆盖已有封面', async () => {
  const item = store.getItems().find((row) => row.title === '已有封面的公众号')
  const resolveFn = async () => ({ type: 'article', text: '正文', images: [mediaUrl('new-1.jpg')] })
  const result = await backfillCovers({ resolveFn, force: true, delayMs: 0 })
  assert.equal(result.covered, 3)
  const updated = store.getItem(item.id)
  assert.equal(updated.cover, mediaUrl('new-1.jpg'))
})
