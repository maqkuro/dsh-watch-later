/**
 * Share-job ingestion checks: a macOS share extension job lands in the share
 * inbox, the plugin validates it, ingests items and writes the delivery receipt.
 *   node --test test/share-inbox.test.mjs
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const dataDir = mkdtempSync(join(tmpdir(), 'wl-share-data-'))
const shareRoot = mkdtempSync(join(tmpdir(), 'wl-share-root-'))
process.env.DSH_WATCH_LATER_DIR = dataDir

const store = await import('../store.js')
const { processShareJobs } = await import('../share-inbox.js')

const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

after(() => {
  for (const dir of [dataDir, shareRoot]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore cleanup failures
    }
  }
})

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function writeJob(parts, options = {}) {
  const id = options.id || randomUUID()
  const dir = join(shareRoot, id)
  mkdirSync(dir, { recursive: true })
  const manifestParts = []
  for (const part of parts) {
    writeFileSync(join(dir, part.filename), part.bytes, { mode: 0o600 })
    manifestParts.push({
      role: part.role,
      filename: part.filename,
      byteCount: part.bytes.length,
      sha256: sha(part.bytes),
    })
  }
  manifestParts.sort((a, b) => a.filename.localeCompare(b.filename))
  const combined = Buffer.concat(manifestParts.map((part) => readFileSync(join(dir, part.filename))))
  const manifest = {
    schemaVersion: 2,
    kind: 'share-content',
    id,
    target: 'watchlater',
    state: 'content-checked',
    originalFilename: options.name || '微信分享',
    byteCount: combined.length,
    sha256: options.badSha ? 'f'.repeat(64) : sha(combined),
    parts: manifestParts,
    createdAt: new Date().toISOString(),
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 })
  return { dir, manifest }
}

test('multi-part share job becomes items and gets a draft-ready receipt', () => {
  const { dir, manifest } = writeJob([
    {
      role: 'text',
      filename: 'text-1.txt',
      bytes: Buffer.from('晚上看这个 https://www.bilibili.com/video/BV1GJ411x7h7\n剧名：漫长的季节 回头追\n', 'utf8'),
    },
    { role: 'image', filename: 'image-1.png', bytes: ONE_PX_PNG },
  ])
  const result = processShareJobs(shareRoot)
  assert.equal(result.processed, 1)
  assert.equal(result.added, 3) // 视频 + 剧名文字 + 图片
  const snapshot = store.buildSnapshot({ nowMs: Date.now() })
  assert.equal(snapshot.counts.active, 3)
  assert.ok(snapshot.items.some((item) => item.kind === 'image'))
  assert.ok(snapshot.items.some((item) => item.kind === 'bilibili'))
  assert.ok(snapshot.items.some((item) => item.kind === 'drama'))
  const receipt = JSON.parse(readFileSync(join(dir, 'delivery.json'), 'utf8'))
  assert.equal(receipt.target, 'watchlater')
  assert.equal(receipt.state, 'draft-ready')
  assert.equal(receipt.sha256, manifest.sha256)
  assert.equal(receipt.sessionId, 'watch-later')
  assert.equal(receipt.itemCount, 3)
})

test('already delivered job is skipped on rescan', () => {
  const before = store.buildSnapshot({ nowMs: Date.now() }).counts.total
  const result = processShareJobs(shareRoot)
  assert.equal(result.processed, 0)
  assert.equal(store.buildSnapshot({ nowMs: Date.now() }).counts.total, before)
})

test('bad hash writes an error receipt with the real reason', () => {
  const { dir } = writeJob(
    [{ role: 'text', filename: 'text-1.txt', bytes: Buffer.from('看看这个 https://example.com/a', 'utf8') }],
    { badSha: true },
  )
  const result = processShareJobs(shareRoot)
  assert.equal(result.errors, 1)
  const receipt = JSON.parse(readFileSync(join(dir, 'delivery.json'), 'utf8'))
  assert.equal(receipt.state, 'error')
  assert.match(String(receipt.error), /校验/)
  const snapshot = store.buildSnapshot({ nowMs: Date.now() })
  assert.equal(snapshot.items.filter((item) => item.url === 'https://example.com/a').length, 0)
})
