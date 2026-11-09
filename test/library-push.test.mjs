/**
 * 图片 → 设计素材库推送测试：本地 media + 假素材库 HTTP，不依赖真实网络。
 *   node --test test/library-push.test.mjs
 */
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'wl-libpush-'))
process.env.DSH_WATCH_LATER_DIR = dataDir

const store = await import('../store.js')
const { pushImageToLibrary } = await import('../library-push.js')

const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

let server
let baseUrl
let received = []
let failNext = false

before(async () => {
  server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      if (req.url === '/api/dsh-design/item' && req.method === 'POST') {
        if (failNext) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '风格不存在' }))
          return
        }
        let body = null
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          body = null
        }
        received.push(body)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, item: { id: 'lib_' + received.length }, revision: 1 }))
        return
      }
      if (req.url === '/missing') {
        res.writeHead(404)
        res.end('nope')
        return
      }
      res.writeHead(404)
      res.end('nope')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = 'http://127.0.0.1:' + server.address().port
})

after(() => {
  server?.close()
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

function makeLocalImageItem() {
  const media = store.saveMediaBytes(ONE_PX_PNG, '.png')
  const { item } = store.addItem({
    kind: 'image',
    title: 'Dota2 英雄胜率截图',
    cover: media.url,
    summary: '截图参考',
    tags: ['Dota2'],
  })
  return item
}

test('本地 media 图片推送到素材库，带上短标签与标题', async () => {
  const item = makeLocalImageItem()
  received = []
  const result = await pushImageToLibrary(item, { origin: baseUrl })
  assert.equal(result.ok, true)
  assert.match(String(result.libraryItemId), /^lib_/)
  assert.equal(received.length, 1)
  assert.equal(received[0].item.title, 'Dota2 英雄胜率截图')
  assert.ok(received[0].item.tags.includes('稍后再看'))
  assert.ok(received[0].item.tags.includes('截图'))
  assert.match(received[0].imageData, /^data:image\/png;base64,[A-Za-z0-9+/=]+$/)
  assert.equal(received[0].item.sourceName, '稍后再看')
  const pushed = store.setLibraryPush(item.id, { libraryItemId: result.libraryItemId })
  assert.ok(pushed.libraryPushedAt)
  assert.equal(pushed.libraryItemId, result.libraryItemId)
})

test('非图片条目拒绝推送', async () => {
  const result = await pushImageToLibrary({ kind: 'link', title: 'x', url: 'https://a.com' }, { origin: baseUrl })
  assert.equal(result.ok, false)
  assert.match(String(result.error), /只有图片/)
})

test('没有本地副本的图片返回可读错误', async () => {
  const { item } = store.addItem({ kind: 'image', title: '早期聊天截图' })
  const result = await pushImageToLibrary(item, { origin: baseUrl })
  assert.equal(result.ok, false)
  assert.match(String(result.error), /没有本地副本/)
})

test('素材库返回业务错误时透出原因', async () => {
  const item = makeLocalImageItem()
  failNext = true
  const result = await pushImageToLibrary(item, { origin: baseUrl })
  failNext = false
  assert.equal(result.ok, false)
  assert.match(String(result.error), /风格不存在/)
})

test('素材库路由不存在时提示未安装/未运行', async () => {
  const item = makeLocalImageItem()
  const result = await pushImageToLibrary(item, { origin: baseUrl + '/missing-base' })
  assert.equal(result.ok, false)
  assert.match(String(result.error), /未安装|未运行/)
})
