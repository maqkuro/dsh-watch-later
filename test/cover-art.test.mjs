/**
 * 封面兜底：生成 SVG 封面 / favicon 限制。
 *   node --test test/cover-art.test.mjs
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'wl-cover-art-test-'))
process.env.DSH_WATCH_LATER_DIR = dataDir

const store = await import('../store.js')
const { generatedCoverSvg, generateCoverFor, faviconCover } = await import('../cover-art.js')
const { backfillCovers } = await import('../cover-backfill.js')

after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

test('生成封面：SVG 转义标题、带来源/首字，落盘为可访问的 .svg 媒体', () => {
  const svg = generatedCoverSvg({ kind: 'wechat', title: 'A&B <设计> 指南', site: '公众号' })
  assert.match(svg, /^<svg /)
  assert.match(svg, /A&amp;B &lt;设计&gt; 指南/)
  assert.match(svg, /公众号/)
  assert.ok(!svg.includes('<script'))

  const url = generateCoverFor({ kind: 'wechat', title: '测试标题', site: '公众号' })
  assert.ok(url && url.includes('/api/dsh-watch-later/media?f='))
  const filename = decodeURIComponent(url.split('f=')[1])
  const resolved = store.resolveMediaPath(filename)
  assert.ok(resolved)
  assert.equal(resolved.ext, '.svg')
})

test('favicon 只对 http 链接尝试；公众号文章直接跳过', async () => {
  assert.equal(await faviconCover({ kind: 'wechat', url: 'https://mp.weixin.qq.com/s/abc' }), null)
  assert.equal(await faviconCover({ kind: 'link', url: 'not-a-url' }), null)
})

test('没有正文图片时 backfill 会生成封面，不留空', async () => {
  const added = store.addItem({ kind: 'wechat', title: '没有配图的公众号文章', url: 'https://mp.weixin.qq.com/s/abc' })
  const resolveFn = async () => ({ type: 'page', text: '正文', images: [], error: '微信公众号验证页' })
  const result = await backfillCovers({ resolveFn, delayMs: 0, sogou: false })
  assert.ok(result.covered >= 1)
  const updated = store.getItem(added.item.id)
  assert.ok(updated.cover && updated.cover.includes('.svg'))
  assert.equal(updated.images.length, 0)
})
