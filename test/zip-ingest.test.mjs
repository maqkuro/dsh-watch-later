/**
 * 微信聊天记录 ZIP 自动入库测试：本地造一个含图片 + txt 的 ZIP，验证原图入库/去重/文本导入。
 *   node --test test/zip-ingest.test.mjs
 */
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'wl-zip-test-'))
process.env.DSH_WATCH_LATER_DIR = dataDir

const store = await import('../store.js')
const { ingestArchiveZip } = await import('../zip-ingest.js')

const PIXELS = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
// 造两张有内容差异的 PNG（<2KB 的会被过滤，所以补足到 4KB）
function makeImage(seedByte) {
  const body = Buffer.alloc(4096, seedByte)
  return Buffer.concat([PIXELS.subarray(0, 40), body])
}

let workDir
let zipPath

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'wl-zip-src-'))
  const inner = join(workDir, '聊天记录内的图片、视频和文件')
  mkdirSync(inner, { recursive: true })
  writeFileSync(join(workDir, '聊天记录.txt'), '看看这个 https://example.com/post-1\n随机文字一行\n', 'utf8')
  writeFileSync(join(inner, '微信图片_1.png'), makeImage(1))
  writeFileSync(join(inner, '微信图片_2.png'), makeImage(2))
  zipPath = join(workDir, '聊天记录.zip')
  const result = spawnSync('ditto', ['-c', '-k', workDir, zipPath])
  assert.equal(result.status, 0)
  assert.ok(readFileSync(zipPath).length > 1000)
})

after(() => {
  for (const dir of [dataDir, workDir]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

test('ZIP 原图全部入库为一个图集条目，文本链接导入为条目', async () => {
  const before = store.buildSnapshot({ nowMs: Date.now() })
  const result = await ingestArchiveZip(zipPath)
  assert.equal(result.ok, true)
  assert.equal(result.newImages, 2)
  assert.ok(result.galleryItemId)
  const snapshot = store.buildSnapshot({ nowMs: Date.now() })
  const gallery = snapshot.items.find((item) => item.id === result.galleryItemId)
  assert.ok(gallery)
  assert.equal(gallery.kind, 'image')
  assert.equal(gallery.images.length, 2)
  assert.ok(gallery.title.includes('2 张'))
  assert.ok(snapshot.items.some((item) => item.url === 'https://example.com/post-1'))
  assert.ok(snapshot.counts.total >= before.counts.total + 2)
})

test('重复导入同一 ZIP 会跳过', async () => {
  const before = store.buildSnapshot({ nowMs: Date.now() })
  const result = await ingestArchiveZip(zipPath)
  assert.equal(result.ok, true)
  assert.equal(result.skipped, true)
  const after = store.buildSnapshot({ nowMs: Date.now() })
  assert.equal(after.counts.total, before.counts.total)
})

test('与已有封面相同的图片只计入 matched，不重复建图集', async () => {
  // 先建一张已有封面图（与 ZIP 中图片内容一致）
  const media = store.saveMediaBytes(makeImage(3), '.png')
  store.addItem({ kind: 'image', title: '已有截图', cover: media.url })
  const zip2 = join(workDir, '单图.zip')
  const dir2 = join(workDir, 'single')
  mkdirSync(dir2, { recursive: true })
  writeFileSync(join(dir2, 'a.png'), makeImage(3))
  spawnSync('ditto', ['-c', '-k', dir2, zip2])
  const result = await ingestArchiveZip(zip2)
  assert.equal(result.ok, true)
  assert.equal(result.newImages, 0)
  assert.equal(result.matchCount ?? result.matched, 1)
  assert.equal(result.galleryItemId, null)
})
