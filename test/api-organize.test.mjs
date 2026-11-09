/**
 * AI 整理接口层检查：把 api.js 的路由挂到一个假 webServer 上，用假 llm 跑通
 * organize → status → undo 三件套，不联网、不依赖 DSH 进程。
 *   node --test test/api-organize.test.mjs
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

const dataDir = mkdtempSync(join(tmpdir(), 'dsh-watch-later-api-'))
process.env.DSH_WATCH_LATER_DIR = dataDir

const store = await import('../store.js')
const { applyRoutes, ROUTES } = await import('../api.js')
const { organizeStatus } = await import('../organize.js')

after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

const routes = new Map()

function fakeLlm() {
  return {
    async *stream(options) {
      const prompt = String(options?.messages?.[0]?.content?.[0]?.text || '')
      const ids = [...prompt.matchAll(/"id":\s*"(wl_[^"]+)"/g)].map((match) => match[1])
      const items = ids.map((id) => ({
        id,
        kind: 'image',
        topic: '截图存档',
        title: '公司后台改版后的审批流程截图',
        summary: '一共三张截图，拍的是新审批流的节点和超时提醒设置。',
        importance: 3,
        urgency: 2,
        deadline: null,
        deadlineKind: 'none',
        tags: ['后台', '流程'],
        durationMin: 3,
        confidence: 0.9,
        reason: '截图信息可用',
      }))
      yield { type: 'text-delta', text: JSON.stringify({ items }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

const ctx = {
  get(name) {
    if (name === 'llm') return fakeLlm()
    return null
  },
  effect(fn) {
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  logger: { info() {}, warn() {} },
  webServer: {
    register(route) {
      routes.set(route.path, route.handler)
    },
  },
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
    headers: {},
    payload: '',
    setHeader(name, value) {
      this.headers[name] = value
    },
    writeHead(status) {
      this.status = status
    },
    end(text) {
      this.payload = text ? String(text) : ''
    },
  }
  const done = new Promise((resolve) => {
    const originalEnd = res.end.bind(res)
    res.end = (text) => {
      originalEnd(text)
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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('新路由都注册上了', () => {
  for (const key of ['organize', 'organizeStatus', 'organizeCancel', 'undo', 'review']) {
    assert.ok(routes.has(ROUTES[key]), 'missing route ' + key)
  }
})

test('GET /ai/status 返回空任务', async () => {
  const result = await call('GET', ROUTES.organizeStatus)
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.job.running, false)
})

test('POST /ai/organize 跑完后状态变成 partial（无真封面）', async () => {
  const first = store.addItem({ title: '微信图片_202609041513_12', kind: 'image' }, { dedupe: false })
  const second = store.addItem({ title: 'IMG_20260904_1512', kind: 'image' }, { dedupe: false })
  const started = await call('POST', ROUTES.organize, { mode: 'all' })
  assert.equal(started.status, 200)
  assert.equal(started.body.ok, true)
  assert.ok(started.body.job.total >= 2)

  for (let i = 0; i < 60; i += 1) {
    const status = await call('GET', ROUTES.organizeStatus)
    if (!status.body.job.running) break
    await wait(50)
  }
  const final = await call('GET', ROUTES.organizeStatus)
  assert.equal(final.body.job.running, false)
  assert.ok(final.body.job.processed >= 2)

  const item = store.getItem(first.item.id)
  assert.equal(item.ai.state, 'partial')
  assert.equal(item.tags[0], '截图存档')
  assert.equal(item.title, '公司后台改版后的审批流程截图')
  assert.ok(organizeStatus().finishedAt)
  assert.ok(store.getItem(second.item.id).ai.state)
})

test('POST /ai/undo 还原标题并打回 none', async () => {
  const items = store.getItems().filter((item) => item.ai && item.ai.prev)
  assert.ok(items.length > 0)
  const target = items[0]
  const prevTitle = target.ai && target.ai.prev ? target.ai.prev.title : null
  assert.ok(prevTitle, '整理快照里应该有原标题')
  const result = await call('POST', ROUTES.undo, { id: target.id })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  const restored = store.getItem(target.id)
  assert.equal(restored.ai.state, 'none')
  assert.equal(restored.title, prevTitle)
})
