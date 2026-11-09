/**
 * 失效区（被删/打不开的条目）：标记、快照分离、批量删除、恢复。
 *   node --test test/invalid.test.mjs
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

const dataDir = mkdtempSync(join(tmpdir(), 'dsh-watch-later-invalid-'))
process.env.DSH_WATCH_LATER_DIR = dataDir

const store = await import('../store.js')
const { applyRoutes, ROUTES } = await import('../api.js')

after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

const routes = new Map()
const ctx = {
  get: () => null,
  effect: (fn) => {
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  logger: { info() {}, warn() {} },
  webServer: { register: (route) => routes.set(route.path, route.handler) },
}
applyRoutes(ctx)

function call(method, path, body) {
  const handler = routes.get(path)
  assert.ok(handler, 'route not registered: ' + path)
  const req = new EventEmitter()
  req.method = method
  req.socket = { remoteAddress: '127.0.0.1' }
  req.destroy = () => {}
  const res = {
    status: 0,
    payload: '',
    setHeader() {},
    writeHead(status) {
      this.status = status
    },
    end(text) {
      this.payload = text ? String(text) : ''
    },
  }
  const done = new Promise((resolve) => {
    const original = res.end.bind(res)
    res.end = (text) => {
      original(text)
      resolve({ status: res.status, body: res.payload ? JSON.parse(res.payload) : null })
    }
  })
  handler(req, res)
  if (body !== undefined) {
    process.nextTick(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
    })
  }
  return done
}

test('markInvalid / clearInvalid 改字段，快照里单独成区', () => {
  const alive = store.addItem({ title: '一条正常内容', kind: 'link' }, { dedupe: false })
  const dead = store.addItem({ title: '一条已经删掉的笔记', kind: 'xhs' }, { dedupe: false })

  store.updateItem(dead.item.id, { invalid: { reason: '小红书笔记已删除或不可见（404）', at: new Date().toISOString() } })
  assert.equal(store.getItem(dead.item.id).invalid.reason.includes('已删除'), true)

  const snapshot = store.buildSnapshot({ nowMs: Date.now() })
  const visibleIds = snapshot.items.map((item) => item.id)
  assert.ok(visibleIds.includes(alive.item.id))
  assert.equal(visibleIds.includes(dead.item.id), false)
  assert.equal(snapshot.counts.invalid, 1)
  assert.equal(snapshot.invalidItems.length, 1)
  assert.equal(snapshot.invalidItems[0].id, dead.item.id)

  store.clearInvalid(dead.item.id)
  const after = store.buildSnapshot({ nowMs: Date.now() })
  assert.equal(after.counts.invalid, 0)
  assert.ok(after.items.some((item) => item.id === dead.item.id))
})

test('正文抓回「已删除」错误时自动挂失效区', () => {
  const created = store.addItem({ title: '自动失效测试', kind: 'xhs', url: 'https://www.xiaohongshu.com/discovery/item/abc' }, { dedupe: false })
  const id = created.item.id
  store.setItemContent(id, { type: 'page', text: null, images: [], fetchedAt: new Date().toISOString(), error: '小红书笔记已删除或不可见（404）' })
  assert.equal(store.getItem(id).invalid.reason.includes('已删除'), true)

  // 抓到内容后自动摘掉失效标记
  store.setItemContent(id, { type: 'page', text: '正文', images: ['/api/dsh-watch-later/media?f=x.jpg'], fetchedAt: new Date().toISOString(), error: null })
  assert.equal(store.getItem(id).invalid, null)
})

test('批量删除与失效恢复接口', async () => {
  const a = store.addItem({ title: '失效 A', kind: 'xhs' }, { dedupe: false })
  const b = store.addItem({ title: '失效 B', kind: 'xhs' }, { dedupe: false })
  store.markInvalid(a.item.id, '已删除')
  store.markInvalid(b.item.id, '已删除')

  const restored = await call('POST', ROUTES.invalid, { action: 'clear', ids: [a.item.id] })
  assert.equal(restored.status, 200)
  assert.equal(restored.body.changed, 1)
  assert.equal(store.getItem(a.item.id).invalid, null)

  const removed = await call('POST', ROUTES.remove, { ids: [a.item.id, b.item.id] })
  assert.equal(removed.status, 200)
  assert.equal(removed.body.deleted, 2)
  assert.equal(store.getItem(a.item.id), null)
  assert.equal(store.getItem(b.item.id), null)
})

test('单条删除保持兼容', async () => {
  const one = store.addItem({ title: '单条删除', kind: 'link' }, { dedupe: false })
  const result = await call('POST', ROUTES.remove, { id: one.item.id })
  assert.equal(result.body.deleted, true)
  assert.equal(store.getItem(one.item.id), null)
})
