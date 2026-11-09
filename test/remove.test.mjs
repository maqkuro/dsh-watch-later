/**
 * test/remove.test.mjs — 「移除」链路测试（node --test）。
 *
 * 覆盖：
 *   1. sync/bili.js removeFromWatchLater：csrf 解析、form body、缺 bili_jct 快速失败
 *   2. remove.js removeItems：bilibili 成功/失败、douyin 不支持、无 sync 三类分支 + 墓碑
 *   3. 墓碑生效后 runSync 的合并逻辑跳过被移除过的远端条目（不再复活）
 *
 * 不访问真实外网：globalThis.fetch 用桩替换，只检查请求形状与响应处理。
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'dsh-watch-later-remove-'))
process.env.DSH_WATCH_LATER_DIR = dataDir

const store = await import('../store.js')
const bili = await import('../sync/bili.js')
const remove = await import('../remove.js')
const { runSync } = await import('../sync-run.js')

after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    // ignore cleanup failure
  }
})

/* --------------------------------------------------------------- helpers */

/**
 * 用桩替换 globalThis.fetch，回调里拿到的调用会被记录下来。
 * 返回 { calls, restore() }，restore 放回原生 fetch。
 */
function stubFetch(handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), init }
    calls.push(call)
    const payload = await handler(call)
    return new Response(JSON.stringify(payload.body ?? {}), {
      status: payload.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return {
    calls,
    restore() {
      globalThis.fetch = original
    },
  }
}

/** 每个测试用完一定还原 fetch，避免互相污染。 */
async function withFetch(handler, fn) {
  const stub = stubFetch(handler)
  try {
    return await fn(stub)
  } finally {
    stub.restore()
  }
}

/**
 * 造一条 B站条目。
 *
 * aid 是真实写回的关键：toview/del 只认数字 aid，新版视频的 aid 无法由 bvid 反推，
 * 所以同步时会把它存进 sync.stats.aid。测试默认给一条带 aid 的条目（模拟正常同步结果），
 * 传 aid:null 可以模拟"老条目没存 aid、需要走 view 接口实时解析"的情况。
 */
function biliItem(remoteId, title, aid = 710350011) {
  return store.addItem(
    {
      title: title || 'B站视频 ' + remoteId,
      url: 'https://www.bilibili.com/video/' + remoteId,
      kind: 'bilibili',
      site: 'B站',
      sync: { provider: 'bilibili', remoteId, stats: { aid } },
    },
    { dedupe: true },
  ).item
}

function douyinItem(remoteId, title) {
  return store.addItem(
    {
      title: title || '抖音视频 ' + remoteId,
      url: 'https://www.douyin.com/video/' + remoteId,
      kind: 'douyin',
      site: '抖音',
      sync: { provider: 'douyin', remoteId },
    },
    { dedupe: true },
  ).item
}

const GOOD_COOKIE = 'SESSDATA=sess-value; bili_jct=csrf-token'

/* ------------------------------------------- 1. removeFromWatchLater */

test('parseBiliCsrf：从 Cookie 里取 bili_jct，只有 SESSDATA 时返回 null', () => {
  assert.equal(bili.parseBiliCsrf(GOOD_COOKIE), 'csrf-token')
  assert.equal(bili.parseBiliCsrf('SESSDATA=only-sessdata'), null)
  assert.equal(bili.parseBiliCsrf(''), null)
  assert.equal(bili.parseBiliCsrf(null), null)
})

test('normalizeAids：只接受 av 号和纯数字，bvid 一律跳过（不许猜 aid）', () => {
  // bvidToAid 只对早期 9 位 aid 成立；新视频 aid 是 15 位，算出来是别人的 vlog。
  // 所以 normalizeAids 不再做 bvid 换算，必须由调用方先 resolveAidByBvid。
  assert.deepEqual(bili.normalizeAids(['av170001', 170002, 'BV1xx411c7mD', 'BV1xx411c7mD', 'av170001']), [170001, 170002])
  assert.deepEqual(bili.normalizeAids(['BV1MqxQ6FE4P']), [], 'bvid 不能被换算成 aid')
})

test('removeFromWatchLater：缺 bili_jct 时快速失败，不发请求', async () => {
  await withFetch(
    () => ({ body: { code: 0 } }),
    async (stub) => {
      const result = await bili.removeFromWatchLater({ cookie: 'SESSDATA=x', aids: 'BV1xx411c7mD' })
      assert.equal(result.ok, false)
      assert.equal(result.okCount, 0)
      assert.match(result.error, /bili_jct/)
      assert.equal(stub.calls.length, 0, '不应该发起网络请求')
    },
  )
})

test('removeFromWatchLater：POST form 带 aid/csrf，Cookie 与 Referer 正确', async () => {
  await withFetch(
    () => ({ body: { code: 0, message: '0' } }),
    async (stub) => {
      const result = await bili.removeFromWatchLater({ cookie: GOOD_COOKIE, aids: ['170003', 'av170001'] })
      assert.equal(result.ok, true)
      assert.equal(result.okCount, 2)
      assert.equal(stub.calls.length, 1)

      const call = stub.calls[0]
      assert.equal(call.url, 'https://api.bilibili.com/x/v2/history/toview/del')
      assert.equal(String(call.init.method).toUpperCase(), 'POST')
      assert.equal(call.init.headers.Referer, 'https://www.bilibili.com/')
      assert.match(call.init.headers.Cookie, /SESSDATA=sess-value/)
      assert.match(call.init.headers['Content-Type'], /application\/x-www-form-urlencoded/)

      const form = new URLSearchParams(String(call.init.body))
      assert.equal(form.get('aid'), '170003,170001', '只接受已解析好的数字 aid，逗号拼接')
      assert.equal(form.get('csrf'), 'csrf-token')
    },
  )
})

test('removeFromWatchLater：接口 code != 0 判失败（CSRF / 风控等）', async () => {
  await withFetch(
    () => ({ body: { code: -111, message: 'csrf 校验失败' } }),
    async () => {
      const result = await bili.removeFromWatchLater({ cookie: GOOD_COOKIE, aids: '170001' })
      assert.equal(result.ok, false)
      assert.equal(result.okCount, 0)
      assert.match(result.error, /CSRF|-111/)
    },
  )
})

/* ------------------------------------------------- 2. removeItems 三分支 */

test('removeItems：B站条目写回成功 → remoteRemoved，且不留墓碑', async () => {
  store.setCookie('bilibili', GOOD_COOKIE)
  const item = biliItem('BV1xx411c7mG', 'B站 成功写回')
  await withFetch(
    (call) => {
      assert.match(call.url, /toview\/del$/)
      return { body: { code: 0 } }
    },
    async (stub) => {
      const result = await remove.removeItems([item.id])
      assert.equal(result.removed, 1)
      assert.equal(result.remoteRemoved, 1)
      assert.equal(result.remoteFailed, 0)
      assert.equal(result.unsupported, 0)
      assert.deepEqual(result.errors, [])
      assert.equal(stub.calls.length, 1, '有 aid 时不应该再去 view 接口解析')
      const form = new URLSearchParams(String(stub.calls[0].init.body))
      assert.equal(form.get('aid'), '710350011', '必须用同步时存下的真实 aid，不能用 bvid 反推')
    },
  )
  assert.equal(store.getItem(item.id), null, '本地应该已经删掉')
  assert.equal(remove.isRemoteRemoved('bilibili', 'BV1xx411c7mG'), false, '写回成功不需要墓碑')
})

test('removeItems：B站写回失败 → remoteFailed + 墓碑（防同步复活）', async () => {
  store.setCookie('bilibili', GOOD_COOKIE)
  const item = biliItem('BV1xx411c7y3', 'B站 写回失败')
  await withFetch(
    () => ({ body: { code: -101, message: '账号未登录' } }),
    async () => {
      const result = await remove.removeItems([item.id])
      assert.equal(result.removed, 1, '远端失败也要删本地')
      assert.equal(result.remoteRemoved, 0)
      assert.equal(result.remoteFailed, 1)
      assert.equal(result.errors.length, 1)
      assert.equal(result.errors[0].id, item.id)
      assert.match(result.errors[0].error, /-101|未登录/)
    },
  )
  assert.equal(store.getItem(item.id), null)
  assert.equal(remove.isRemoteRemoved('bilibili', 'BV1xx411c7y3'), true, '失败必须留墓碑')
})

test('removeItems：抖音条目只删本地，记 unsupported，不碰网络', async () => {
  const item = douyinItem('7200000000000000001', '抖音 只能本地移')
  await withFetch(
    () => ({ body: { code: 0 } }),
    async (stub) => {
      const result = await remove.removeItems([item.id])
      assert.equal(result.removed, 1)
      assert.equal(result.remoteRemoved, 0)
      assert.equal(result.remoteFailed, 0)
      assert.equal(result.unsupported, 1)
      assert.equal(stub.calls.length, 0, '抖音没有签名实现，不该发请求')
    },
  )
  assert.equal(store.getItem(item.id), null)
})

test('removeItems：没有 sync 的普通条目 / 不存在的 id 都能安全处理', async () => {
  const plain = store.addItem({ title: '一篇普通文章', url: 'https://example.com/a?remove-test=1' }, { dedupe: true }).item
  const result = await remove.removeItems([plain.id, 'wl_not_exists_0001', ''])
  assert.equal(result.removed, 1)
  assert.equal(result.remoteRemoved, 0)
  assert.equal(result.remoteFailed, 0)
  assert.equal(result.unsupported, 0)
  assert.deepEqual(result.errors, [])
  assert.equal(store.getItem(plain.id), null)
})

/* --------------------------------------------- 3. 墓碑让同步不再复活 */

test('isRemoteRemoved / markRemoteRemoved：读写墓碑文件，坏输入不抛异常', () => {
  assert.equal(remove.isRemoteRemoved('bilibili', 'BV1xx411c7D7'), false)
  assert.equal(remove.markRemoteRemoved('bilibili', 'BV1xx411c7D7', '测试'), true)
  assert.equal(remove.isRemoteRemoved('bilibili', 'BV1xx411c7D7'), true)
  // 不同 provider 不串
  assert.equal(remove.isRemoteRemoved('douyin', 'BV1xx411c7D7'), false)
  // 空输入只返回 false，不写脏数据、不抛异常
  assert.equal(remove.markRemoteRemoved('bilibili', '', 'x'), false)
  assert.equal(remove.isRemoteRemoved('', ''), false)
})

test('mergeRemoteItems：墓碑命中的远端条目跳过，不再导回本地', async () => {
  store.setCookie('bilibili', GOOD_COOKIE)
  const skippedId = 'BV1xx411c7ZP'
  const freshId = 'BV17x411w7KC'
  remove.markRemoteRemoved('bilibili', skippedId, '本地已移除')

  await withFetch(
    (call) => {
      if (call.url.includes('/toview/del')) throw new Error('同步流程不应该调删除接口')
      if (call.url.includes('/x/web-interface/nav')) {
        return { body: { code: 0, data: { isLogin: true, uname: 'tester', mid: 1 } } }
      }
      return {
        body: {
          code: 0,
          data: {
            count: 2,
            list: [
              { bvid: skippedId, aid: 111, title: '应该被跳过', duration: 100, add_at: 1700000000 },
              { bvid: freshId, aid: 222, title: '应该被导入', duration: 200, add_at: 1700000100 },
            ],
          },
        },
      }
    },
    async () => {
      const result = await runSync('bilibili')
      assert.equal(result.ok, true)
      assert.equal(result.imported, 1, '只有没被移除过的那条会入库')
      assert.equal(result.total, 2)
      assert.ok(result.skipped >= 1, '墓碑命中要记 skipped')
    },
  )

  assert.equal(store.findBySync('bilibili', skippedId), null, '被移除过的条目不能复活')
  assert.ok(store.findBySync('bilibili', freshId), '没被移除过的正常导入')
})

/* ------------------------------------- 4. 存量 archived → done 一次性迁移 */

test('archivedV1 迁移：老 archived 变 done，保留 archivedAt，且不会被 retention 立刻清掉', () => {
  // 迁移发生在 loadState() 首次加载，必须用独立进程 + 独立数据目录验证
  const dir = mkdtempSync(join(tmpdir(), 'dsh-watch-later-migrate-'))
  try {
    writeFileSync(
      join(dir, 'items.json'),
      JSON.stringify({
        version: 1,
        settings: { retentionDays: 30 },
        items: [
          {
            id: 'wl_old_archived',
            title: '很久以前归档的',
            kind: 'link',
            status: 'archived',
            archivedAt: '2020-01-02T00:00:00.000Z',
            createdAt: '2019-12-01T00:00:00.000Z',
            updatedAt: '2020-01-02T00:00:00.000Z',
          },
        ],
      }),
    )
    const script = `
      const m = await import(${JSON.stringify(join(process.cwd(), 'store.js'))})
      const items = m.getItems().map((item) => ({ id: item.id, status: item.status, archivedAt: item.archivedAt }))
      console.log(JSON.stringify({ items, migrations: m.loadState().migrations }))
    `
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, DSH_WATCH_LATER_DIR: dir },
      encoding: 'utf8',
    })
    const parsed = JSON.parse(out.trim().split('\n').pop())
    assert.equal(parsed.items.length, 1, '不应被 retention 误删')
    assert.equal(parsed.items[0].status, 'done')
    assert.equal(parsed.items[0].archivedAt, '2020-01-02T00:00:00.000Z', 'archivedAt 要保留')
    assert.ok(parsed.migrations.archivedV1, '迁移要打标记，避免重复执行')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------- 5. HTTP 接口：动作与响应结构 */

test('API：/action remove 与 /delete 的响应结构，archive 动作已下线', async () => {
  const { applyRoutes, ROUTES } = await import('../api.js')
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

  // 和 invalid.test.mjs 一样的极简 req/res 桩，只够跑 JSON 路由
  const call = (method, path, body) => {
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
      const end = res.end.bind(res)
      res.end = (text) => {
        end(text)
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

  const one = store.addItem({ title: 'API 单条移除', kind: 'link', url: 'https://example.com/api-remove-1' }, { dedupe: false }).item
  const single = await call('POST', ROUTES.action, { id: one.id, action: 'remove' })
  assert.equal(single.status, 200)
  assert.equal(single.body.ok, true)
  assert.equal(single.body.removed, 1)
  assert.equal(single.body.remoteRemoved, 0)
  assert.equal(single.body.remoteFailed, 0)
  assert.equal(single.body.unsupported, 0)
  assert.ok(Array.isArray(single.body.errors))
  assert.equal(store.getItem(one.id), null)

  const two = store.addItem({ title: 'API 批量移除', kind: 'link', url: 'https://example.com/api-remove-2' }, { dedupe: false }).item
  const batch = await call('POST', ROUTES.remove, { ids: [two.id] })
  assert.equal(batch.status, 200)
  assert.equal(batch.body.removed, 1)
  assert.equal(batch.body.deleted, 1, '批量时 deleted 是条数')
  assert.equal(store.getItem(two.id), null)

  const legacy = store.addItem({ title: 'API 归档已下线', kind: 'link', url: 'https://example.com/api-archive-gone' }, { dedupe: false }).item
  const archived = await call('POST', ROUTES.action, { id: legacy.id, action: 'archive' })
  assert.equal(archived.status, 400)
  assert.match(archived.body.error, /未知操作/)
  assert.equal(store.getItem(legacy.id).status, 'inbox', 'archive 动作不应该再改状态')
})

/* ------------------------------------ 4. 已读同步 / 老条目 aid / 抖音墓碑 */

/**
 * 起一套极简 API 路由桩（和上面那段一样，抽出来给后加的用例复用）。
 */
async function makeApi() {
  const { applyRoutes, ROUTES } = await import('../api.js')
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
  return { routes, ROUTES }
}

function apiCall(routes, method, path, body) {
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
    const end = res.end.bind(res)
    res.end = (text) => {
      end(text)
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

test('API：/action done 对 B站条目写回移出，但本地保留且不写墓碑', async () => {
  const { routes, ROUTES } = await makeApi()
  store.setCookie('bilibili', GOOD_COOKIE)
  const item = biliItem('BV1xx411c7mE', '已读要写回')

  await withFetch(
    () => ({ body: { code: 0 } }),
    async (stub) => {
      const res = await apiCall(routes, 'POST', ROUTES.action, { id: item.id, action: 'done' })
      assert.equal(res.status, 200)
      assert.equal(res.body.remote && res.body.remote.ok, true, '已读应该触发远端移出')
      const delCalls = stub.calls.filter((c) => c.url.includes('toview/del'))
      assert.equal(delCalls.length, 1)
      const form = new URLSearchParams(String(delCalls[0].init.body))
      assert.equal(form.get('aid'), '710350011')
    },
  )

  const kept = store.getItem(item.id)
  assert.ok(kept, '已读必须保留本地条目，不能删')
  assert.equal(kept.status, 'done')
  assert.equal(remove.isRemoteRemoved('bilibili', 'BV1xx411c7mE'), false, '已读成功不该写墓碑')
})

test('removeItems：老条目没存 aid → 走 view 接口解析出真实 aid 再写回', async () => {
  store.setCookie('bilibili', GOOD_COOKIE)
  const item = biliItem('BV1MqxQ6FE4P', '老条目（没有 stats.aid）', null)

  await withFetch(
    (call) => {
      if (call.url.includes('/x/web-interface/view')) {
        // 真实值：新版视频 aid 是 15 位，纯算法算不出来
        return { body: { code: 0, data: { aid: 117557197539987 } } }
      }
      return { body: { code: 0 } }
    },
    async (stub) => {
      const result = await remove.removeItems([item.id])
      assert.equal(result.remoteRemoved, 1)
      const delCall = stub.calls.find((c) => c.url.includes('toview/del'))
      assert.ok(delCall, '应该发出删除请求')
      const form = new URLSearchParams(String(delCall.init.body))
      assert.equal(form.get('aid'), '117557197539987', '必须用接口解析出的 aid，不是 bvid 反推值')
    },
  )
})

test('removeItems：抖音条目 → unsupported + 写墓碑，不发网络请求', async () => {
  const item = douyinItem('7400000000000000001', '抖音条目')

  await withFetch(
    () => {
      throw new Error('抖音不应该发网络请求')
    },
    async (stub) => {
      const result = await remove.removeItems([item.id])
      assert.equal(result.unsupported, 1)
      assert.equal(result.remoteRemoved, 0)
      assert.equal(stub.calls.length, 0, '抖音写不回，不该打网络')
    },
  )

  assert.equal(store.getItem(item.id), null, '本地仍然要移除')
  assert.equal(remove.isRemoteRemoved('douyin', '7400000000000000001'), true, '抖音必须留墓碑，否则同步会复活')
})

test('removeRemoteOnly：不支持写回的来源返回 unsupported，不抛异常', async () => {
  const outcome = await remove.removeRemoteOnly({ sync: { provider: 'douyin', remoteId: 'x' } })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.unsupported, true)
  assert.match(outcome.error, /抖音/)
})
