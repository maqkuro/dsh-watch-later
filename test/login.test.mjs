/**
 * login 模块单测：node --test test/login.test.mjs
 *
 * 覆盖：
 *   - login/bili-qr.js：generateQr 成功/业务错误/非 JSON/网络错误/取消；
 *     pollQr 86101 waiting / 86090 scanned / 86038 expired / 0 confirmed（Set-Cookie 解析 + nav 账号）；
 *     confirmed 但缺 SESSDATA、顶层错误码、缺 qrKey；fetchAccount 成功/-101/isLogin=false/空 cookie/取消。
 *   - login/chrome-login.js：本机随机端口的假 CDP HTTP + WebSocket 服务（模拟 /json/version 与
 *     Storage.getCookies），验证 waiting -> confirmed、closed（窗口没了）、cookie 拼接/域过滤/过期过滤、
 *     WS 构造注入；startLoginWindow 用注入 spawnFn 验证参数与 profile 路径，绝不启动 GUI Chrome。
 *
 * 默认不拉起真实 Chrome、不访问真实网络登录。真实 headless 探测结论见文件末尾注释。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

import { generateQr, pollQr, fetchAccount } from '../login/bili-qr.js'
import { startLoginWindow, pollLogin, cancelLogin, loginWindows } from '../login/chrome-login.js'

const realFetch = globalThis.fetch
const tempDirs = []
after(() => {
  globalThis.fetch = realFetch
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 忽略清理失败 */
    }
  }
})

function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/* ------------------------------------------------------------------ B站 */

function biliJson(payload, { setCookies = [], status = 200 } = {}) {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' })
  for (const cookie of setCookies) headers.append('set-cookie', cookie)
  return new Response(JSON.stringify(payload), { status, headers })
}

/** 临时替换 globalThis.fetch，记录每次调用，结束后自动还原。 */
async function withMockFetch(mock, fn) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || {} })
    return mock(String(url), init || {}, calls.length - 1)
  }
  try {
    return await fn(calls)
  } finally {
    globalThis.fetch = realFetch
  }
}

test('bili generateQr：成功返回 qrKey/qrUrl/expiresInSec，并带 UA/Referer', async () => {
  await withMockFetch(
    async () => biliJson({ code: 0, message: '0', data: { url: 'https://www.bilibili.com/h5/login?k=abc', qrcode_key: 'KEY-ABC' } }),
    async (calls) => {
      const result = await generateQr()
      assert.equal(result.ok, true)
      assert.equal(result.qrKey, 'KEY-ABC')
      assert.equal(result.qrUrl, 'https://www.bilibili.com/h5/login?k=abc')
      assert.equal(result.expiresInSec, 180)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate')
      assert.match(String(calls[0].init.headers['User-Agent']), /Chrome\//)
      assert.equal(calls[0].init.headers.Referer, 'https://www.bilibili.com/')
    }
  )
})

test('bili generateQr：业务错误码/非 JSON/网络错误/预取消都结构化返回', async () => {
  await withMockFetch(
    async () => biliJson({ code: -412, message: 'risk control' }),
    async () => {
      const result = await generateQr()
      assert.equal(result.ok, false)
      assert.match(result.error, /-412|风控/)
    }
  )

  await withMockFetch(
    async () => new Response('<html>not json</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    async () => {
      const result = await generateQr()
      assert.equal(result.ok, false)
      assert.match(result.error, /合法 JSON/)
    }
  )

  await withMockFetch(
    async () => {
      throw new TypeError('fetch failed')
    },
    async () => {
      const result = await generateQr()
      assert.equal(result.ok, false)
      assert.match(result.error, /网络请求失败/)
    }
  )

  const controller = new AbortController()
  controller.abort()
  await withMockFetch(
    async () => {
      throw new Error('不应该发起请求')
    },
    async (calls) => {
      const result = await generateQr({ signal: controller.signal })
      assert.equal(result.ok, false)
      assert.match(result.error, /取消/)
      assert.equal(calls.length, 0)
    }
  )
})

test('bili pollQr：86101/86090/86038 分别映射 waiting/scanned/expired', async () => {
  const cases = [
    [86101, 'waiting'],
    [86090, 'scanned'],
    [86038, 'expired'],
  ]
  for (const [code, state] of cases) {
    await withMockFetch(
      async () => biliJson({ code: 0, message: '0', data: { code, message: String(code) } }),
      async (calls) => {
        const result = await pollQr({ qrKey: 'KEY-ABC' })
        assert.equal(result.ok, true, state)
        assert.equal(result.state, state)
        assert.equal(result.cookie, undefined)
        assert.equal(result.account, undefined)
        assert.match(calls[0].url, /qrcode_key=KEY-ABC/)
      }
    )
  }
})

test('bili pollQr：confirmed 时解析 Set-Cookie 并拼 cookie header，再用 nav 取账号', async () => {
  const setCookies = [
    'SESSDATA=sess%2Cdata; Path=/; Domain=.bilibili.com; HttpOnly',
    'bili_jct=csrf123; Path=/; Domain=.bilibili.com',
    'DedeUserID=12345; Path=/; Domain=.bilibili.com',
    'DedeUserID__ckMd5=abcdef; Path=/; Domain=.bilibili.com',
    'sid=sidvalue; Path=/; Domain=.bilibili.com',
  ]
  await withMockFetch(
    async (url, init, index) => {
      if (index === 0) {
        assert.match(url, /qrcode\/poll\?qrcode_key=KEY-CONFIRM/)
        return biliJson(
          { code: 0, message: '0', data: { code: 0, message: '', url: 'https://passport.biligame.com/crossDomain?x=1' } },
          { setCookies }
        )
      }
      assert.equal(url, 'https://api.bilibili.com/x/web-interface/nav')
      assert.equal(
        init.headers.Cookie,
        'SESSDATA=sess%2Cdata; bili_jct=csrf123; DedeUserID=12345; DedeUserID__ckMd5=abcdef; sid=sidvalue'
      )
      assert.equal(init.headers.Referer, 'https://www.bilibili.com/')
      return biliJson({
        code: 0,
        data: { isLogin: true, uname: '测试用户', face: 'http://i0.hdslb.com/bfs/face/x.jpg', mid: 12345 },
      })
    },
    async (calls) => {
      const result = await pollQr({ qrKey: 'KEY-CONFIRM' })
      assert.equal(result.ok, true)
      assert.equal(result.state, 'confirmed')
      assert.equal(
        result.cookie,
        'SESSDATA=sess%2Cdata; bili_jct=csrf123; DedeUserID=12345; DedeUserID__ckMd5=abcdef; sid=sidvalue'
      )
      assert.deepEqual(result.account, {
        name: '测试用户',
        avatar: 'https://i0.hdslb.com/bfs/face/x.jpg',
        mid: 12345,
      })
      assert.equal(calls.length, 2)
    }
  )
})

test('bili pollQr：confirmed 但 nav 失败时仍返回 cookie（不把登录成功降级成错误）', async () => {
  await withMockFetch(
    async (url, init, index) => {
      if (index === 0) {
        return biliJson(
          { code: 0, data: { code: 0 } },
          { setCookies: ['SESSDATA=okcookie; Path=/; Domain=.bilibili.com'] }
        )
      }
      throw new TypeError('nav fetch failed')
    },
    async () => {
      const result = await pollQr({ qrKey: 'KEY-NAV-FAIL' })
      assert.equal(result.ok, true)
      assert.equal(result.state, 'confirmed')
      assert.equal(result.cookie, 'SESSDATA=okcookie')
      assert.equal(result.account, undefined)
    }
  )
})

test('bili pollQr：confirmed 但没有 SESSDATA、顶层错误码、缺 qrKey、网络错误', async () => {
  await withMockFetch(
    async () =>
      biliJson({ code: 0, data: { code: 0 } }, { setCookies: ['bili_jct=only-csrf; Path=/; Domain=.bilibili.com'] }),
    async (calls) => {
      const result = await pollQr({ qrKey: 'KEY-NO-SESS' })
      assert.equal(result.ok, false)
      assert.equal(result.state, 'error')
      assert.match(result.error, /SESSDATA/)
      assert.equal(calls.length, 1)
    }
  )

  await withMockFetch(
    async () => biliJson({ code: -400, message: 'bad request', data: null }),
    async () => {
      const result = await pollQr({ qrKey: 'KEY-BAD' })
      assert.equal(result.ok, false)
      assert.equal(result.state, 'error')
      assert.match(result.error, /-400/)
    }
  )

  await withMockFetch(
    async () => {
      throw new Error('不应该发起请求')
    },
    async (calls) => {
      const result = await pollQr({ qrKey: '' })
      assert.equal(result.ok, false)
      assert.equal(result.state, 'error')
      assert.equal(calls.length, 0)
    }
  )

  await withMockFetch(
    async () => {
      throw new TypeError('network down')
    },
    async () => {
      const result = await pollQr({ qrKey: 'KEY-NET' })
      assert.equal(result.ok, false)
      assert.equal(result.state, 'error')
      assert.match(result.error, /网络请求失败/)
    }
  )
})

test('bili fetchAccount：整段 cookie / 裸 SESSDATA / -101 / isLogin=false / 空 cookie', async () => {
  await withMockFetch(
    async (url, init) => {
      assert.equal(url, 'https://api.bilibili.com/x/web-interface/nav')
      assert.equal(init.headers.Cookie, 'SESSDATA=rawvalue')
      return biliJson({
        code: 0,
        data: { isLogin: true, uname: 'UP主', face: '//i1.hdslb.com/bfs/face/y.jpg', mid: 777 },
      })
    },
    async () => {
      const result = await fetchAccount({ cookie: 'rawvalue' })
      assert.equal(result.ok, true)
      assert.equal(result.name, 'UP主')
      assert.equal(result.avatar, 'https://i1.hdslb.com/bfs/face/y.jpg')
      assert.equal(result.mid, 777)
    }
  )

  await withMockFetch(
    async () => biliJson({ code: -101, message: '账号未登录' }),
    async () => {
      const result = await fetchAccount({ cookie: 'SESSDATA=expired; bili_jct=x' })
      assert.equal(result.ok, false)
      assert.match(result.error, /-101/)
    }
  )

  await withMockFetch(
    async () => biliJson({ code: 0, data: { isLogin: false } }),
    async () => {
      const result = await fetchAccount({ cookie: 'SESSDATA=bad' })
      assert.equal(result.ok, false)
      assert.match(result.error, /isLogin/)
    }
  )

  await withMockFetch(
    async () => {
      throw new Error('不应该发起请求')
    },
    async (calls) => {
      const result = await fetchAccount({ cookie: '   ' })
      assert.equal(result.ok, false)
      assert.equal(calls.length, 0)
    }
  )

  const controller = new AbortController()
  controller.abort()
  const aborted = await fetchAccount({ cookie: 'SESSDATA=x', signal: controller.signal })
  assert.equal(aborted.ok, false)
  assert.match(aborted.error, /取消/)
})

/* ---------------------------------------------------- 假 CDP HTTP + WS */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 编码一个服务端 -> 客户端的未掩码 WebSocket 帧。 */
function encodeWsFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  const length = data.length
  let header
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length])
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, data])
}

/** 解析缓冲区里的一个客户端帧；数据不够返回 null。 */
function readWsFrame(buffer) {
  if (buffer.length < 2) return null
  const opcode = buffer[0] & 0x0f
  const masked = (buffer[1] & 0x80) !== 0
  let length = buffer[1] & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return null
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return null
    const big = buffer.readBigUInt64BE(2)
    if (big > BigInt(4 * 1024 * 1024)) throw new Error('测试帧过大')
    length = Number(big)
    offset = 10
  }
  let mask = null
  if (masked) {
    if (buffer.length < offset + 4) return null
    mask = buffer.subarray(offset, offset + 4)
    offset += 4
  }
  if (buffer.length < offset + length) return null
  let payload = buffer.subarray(offset, offset + length)
  if (mask) {
    payload = Buffer.from(payload)
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]
  }
  return { opcode, payload, total: offset + length }
}

function listenOnRandomPort(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

/**
 * 假 CDP 服务：HTTP 只实现 /json/version，WSS 升级后对 Storage.getCookies 回当前 cookies。
 * state.cookies 可在测试中途修改，用来模拟「用户在 Chrome 里登录完成」。
 */
async function startFakeCdp(initialCookies = []) {
  const state = { cookies: initialCookies.slice(), versionCalls: 0, getCookiesCalls: 0, methods: [] }
  const sockets = new Set()
  const server = createServer((req, res) => {
    if (req.url === '/json/version') {
      state.versionCalls += 1
      const port = server.address().port
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ Browser: 'Chrome/Fake', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake` }))
      return
    }
    res.writeHead(404)
    res.end('not found')
  })

  server.on('upgrade', (req, socket) => {
    if (req.url !== '/devtools/browser/fake') {
      socket.destroy()
      return
    }
    const key = req.headers['sec-websocket-key']
    const accept = createHash('sha1')
      .update(String(key) + WS_GUID)
      .digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    )
    sockets.add(socket)
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        const frame = readWsFrame(buffer)
        if (!frame) break
        buffer = buffer.subarray(frame.total)
        if (frame.opcode === 0x8) {
          socket.end(Buffer.from([0x88, 0x00]))
          return
        }
        if (frame.opcode !== 0x1) continue
        let message
        try {
          message = JSON.parse(frame.payload.toString('utf8'))
        } catch {
          continue
        }
        state.methods.push(message.method)
        if (message.method === 'Storage.getCookies') {
          state.getCookiesCalls += 1
          socket.write(encodeWsFrame(JSON.stringify({ id: message.id, result: { cookies: state.cookies } })))
        }
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
  })

  const port = await listenOnRandomPort(server)
  return {
    port,
    state,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) {
          try {
            socket.destroy()
          } catch {
            /* 忽略 */
          }
        }
        server.close(() => resolve())
      }),
  }
}

/* --------------------------------------------------------------- Chrome */

test('chrome：初始 loginWindows 为空，非法 provider 结构化报错', async () => {
  const windows = loginWindows()
  assert.deepEqual(windows, { douyin: null, bilibili: null, xiaohongshu: null })

  const start = await startLoginWindow({ provider: 'weibo' })
  assert.equal(start.ok, false)
  assert.match(start.error, /provider/)

  const poll = await pollLogin({ provider: 'weibo' })
  assert.equal(poll.ok, false)
  assert.equal(poll.state, 'error')

  const cancel = await cancelLogin({})
  assert.equal(cancel.ok, false)
})

test('chrome：startLoginWindow 用注入 spawnFn 验证参数/profile，不启动真实 Chrome', async () => {
  const profileDir = join(makeTempDir('wl-login-profile-'), 'douyin')
  const spawned = []
  const child = new EventEmitter()
  // 用当前进程 pid 模拟「窗口进程还活着」，验证重复 start 会复用；killFn 注入后 cancel 不会真杀进程。
  child.pid = process.pid
  child.unref = () => {}
  child.kill = () => {}

  const result = await startLoginWindow({
    provider: 'douyin',
    chromePath: process.execPath, // 路径存在即可，spawnFn 不会真的执行
    userDataDir: profileDir,
    port: 9311,
    loginUrl: 'https://www.douyin.com/',
    spawnFn: (executable, args, options) => {
      spawned.push({ executable, args, options })
      process.nextTick(() => child.emit('spawn'))
      return child
    },
    killFn: () => {},
  })

  assert.equal(result.ok, true)
  assert.equal(result.port, 9311)
  assert.equal(result.pid, process.pid)
  assert.deepEqual(loginWindows().douyin, { port: 9311, pid: process.pid })
  assert.equal(spawned.length, 1)
  const args = spawned[0].args
  assert.ok(args.includes('--remote-debugging-port=9311'))
  assert.ok(args.includes(`--user-data-dir=${profileDir}`))
  assert.ok(args.includes('--no-first-run'))
  assert.ok(args.includes('--no-default-browser-check'))
  assert.ok(!args.includes('--headless=new'))
  assert.equal(args.at(-1), 'https://www.douyin.com/')
  assert.equal(spawned[0].options.detached, true)

  // 已有活窗口时重复 start 复用同一个窗口（不会开第二个）
  const again = await startLoginWindow({
    provider: 'douyin',
    chromePath: process.execPath,
    spawnFn: () => {
      throw new Error('已有登录窗口时不应该再次 spawn')
    },
    killFn: () => {},
  })
  assert.equal(again.ok, true)
  assert.equal(again.port, 9311)
  assert.equal(spawned.length, 1)

  const cancelled = await cancelLogin({ provider: 'douyin' })
  assert.equal(cancelled.ok, true)
  assert.deepEqual(loginWindows().douyin, null)
})

test('chrome：startLoginWindow 的 spawn 失败 / spawn error 都结构化返回', async () => {
  const baseDir = makeTempDir('wl-login-fail-')
  const thrown = await startLoginWindow({
    provider: 'bilibili',
    chromePath: process.execPath,
    userDataDir: join(baseDir, 'bilibili-thrown'),
    spawnFn: () => {
      throw new Error('boom')
    },
  })
  assert.equal(thrown.ok, false)
  assert.match(thrown.error, /启动 Chrome 登录窗口失败/)

  const child = new EventEmitter()
  child.pid = 424243
  child.unref = () => {}
  child.kill = () => {}
  const errored = await startLoginWindow({
    provider: 'bilibili',
    chromePath: process.execPath,
    userDataDir: join(baseDir, 'bilibili-errored'),
    spawnFn: () => {
      process.nextTick(() => child.emit('error', new Error('ENOENT')))
      return child
    },
  })
  assert.equal(errored.ok, false)
  assert.match(errored.error, /ENOENT|启动 Chrome/)
  assert.deepEqual(loginWindows().bilibili, null)
})

test('chrome poll：假 CDP 下 waiting -> confirmed，cookie 只取 douyin 域且 required 优先', async () => {
  const fake = await startFakeCdp([])
  try {
    const waiting = await pollLogin({
      provider: 'douyin',
      cdpPort: fake.port,
      pid: 999999,
      isAlive: () => true,
    })
    assert.equal(waiting.ok, true)
    assert.equal(waiting.state, 'waiting')
    assert.equal(waiting.cookie, undefined)
    assert.ok(fake.state.methods.includes('Storage.getCookies'))

    // 模拟用户在窗口里登录完成：出现 sessionid（.douyin.com）
    fake.state.cookies = [
      { name: 'sessionid', value: 'sess-abc', domain: '.douyin.com', path: '/', expires: -1 },
      { name: 'passport_csrf_token', value: 'csrf-1', domain: '.douyin.com', path: '/' },
      { name: 'ttwid', value: 'tt-1', domain: '.douyin.com', path: '/' },
      { name: 'sessionid', value: 'other-domain', domain: '.example.com', path: '/' },
      { name: 'SESSDATA', value: 'bili-cookie', domain: '.bilibili.com', path: '/' },
    ]
    const confirmed = await pollLogin({
      provider: 'douyin',
      cdpPort: fake.port,
      pid: 999999,
      isAlive: () => true,
    })
    assert.equal(confirmed.ok, true)
    assert.equal(confirmed.state, 'confirmed')
    assert.equal(confirmed.cookie, 'sessionid=sess-abc; passport_csrf_token=csrf-1; ttwid=tt-1')
    assert.ok(!confirmed.cookie.includes('other-domain'))
    assert.ok(!confirmed.cookie.includes('SESSDATA'))
    assert.equal(confirmed.account, undefined)
    assert.equal(fake.state.getCookiesCalls, 2)
  } finally {
    await fake.close()
  }
})

test('chrome poll：sid_tt 替代 sessionid；过期 cookie 被过滤；WS 构造可注入', async () => {
  const fake = await startFakeCdp([
    { name: 'sessionid', value: 'expired', domain: '.douyin.com', path: '/', expires: Math.floor(Date.now() / 1000) - 3600 },
    { name: 'sid_tt', value: 'sid-ok', domain: 'www.douyin.com', path: '/' },
    { name: 'ttwid', value: 'tt-2', domain: '.douyin.com', path: '/' },
  ])
  const wsUrls = []
  const wsFactory = (url) => {
    wsUrls.push(url)
    return new WebSocket(url)
  }
  try {
    const result = await pollLogin({
      provider: 'douyin',
      cdpPort: fake.port,
      pid: 999999,
      isAlive: () => true,
      wsFactory,
    })
    assert.equal(result.ok, true)
    assert.equal(result.state, 'confirmed')
    assert.equal(result.cookie, 'sid_tt=sid-ok; ttwid=tt-2')
    assert.ok(!result.cookie.includes('expired'))
    assert.equal(wsUrls.length, 1)
    assert.match(wsUrls[0], new RegExp(`^ws://127\\.0\\.0\\.1:${fake.port}/`))
  } finally {
    await fake.close()
  }
})

test('chrome poll：bilibili 用 SESSDATA 判定 confirmed，并透传 accountLookup 昵称', async () => {
  const fake = await startFakeCdp([
    { name: 'bili_jct', value: 'jct-1', domain: '.bilibili.com', path: '/' },
    { name: 'SESSDATA', value: 'bili-sess', domain: '.bilibili.com', path: '/' },
  ])
  try {
    // 只有 bili_jct 时应保持 waiting
    fake.state.cookies = [{ name: 'bili_jct', value: 'jct-1', domain: '.bilibili.com', path: '/' }]
    const waiting = await pollLogin({
      provider: 'bilibili',
      cdpPort: fake.port,
      pid: 999999,
      isAlive: () => true,
      enrichAccount: false,
    })
    assert.equal(waiting.state, 'waiting')

    fake.state.cookies = [
      { name: 'bili_jct', value: 'jct-1', domain: '.bilibili.com', path: '/' },
      { name: 'SESSDATA', value: 'bili-sess', domain: '.bilibili.com', path: '/' },
      { name: 'sessionid', value: 'douyin-only', domain: '.douyin.com', path: '/' },
    ]
    const lookedUp = []
    const confirmed = await pollLogin({
      provider: 'bilibili',
      cdpPort: fake.port,
      pid: 999999,
      isAlive: () => true,
      accountLookup: async ({ cookie, signal }) => {
        lookedUp.push({ cookie, hasSignal: Boolean(signal) })
        return { ok: true, name: '测试UP' }
      },
    })
    assert.equal(confirmed.ok, true)
    assert.equal(confirmed.state, 'confirmed')
    assert.equal(confirmed.cookie, 'SESSDATA=bili-sess; bili_jct=jct-1')
    assert.deepEqual(confirmed.account, { name: '测试UP' })
    assert.equal(lookedUp.length, 1)
    assert.equal(lookedUp[0].cookie, 'SESSDATA=bili-sess; bili_jct=jct-1')
    assert.equal(lookedUp[0].hasSignal, true)
  } finally {
    await fake.close()
  }
})

test('chrome poll：窗口关闭(closed) / 进程还在但 CDP 不可用(waiting) / 超时(closed)', async () => {
  const fake = await startFakeCdp([])
  const port = fake.port
  await fake.close()

  const closed = await pollLogin({
    provider: 'douyin',
    cdpPort: port,
    pid: 999999,
    isAlive: () => false,
  })
  assert.equal(closed.ok, true)
  assert.equal(closed.state, 'closed')

  const waiting = await pollLogin({
    provider: 'douyin',
    cdpPort: port,
    pid: 999999,
    isAlive: () => true,
  })
  assert.equal(waiting.ok, true)
  assert.equal(waiting.state, 'waiting')

  const timedOut = await pollLogin({
    provider: 'bilibili',
    cdpPort: port,
    pid: 999999,
    isAlive: () => true,
    startedAt: Date.now() - 6 * 60 * 1000,
  })
  assert.equal(timedOut.ok, true)
  assert.equal(timedOut.state, 'closed')
  assert.match(timedOut.error, /超时/)

  const noWindow = await pollLogin({ provider: 'douyin' })
  assert.equal(noWindow.ok, false)
  assert.equal(noWindow.state, 'error')

  const controller = new AbortController()
  controller.abort()
  const aborted = await pollLogin({ provider: 'douyin', cdpPort: port, signal: controller.signal })
  assert.equal(aborted.ok, false)
  assert.equal(aborted.state, 'error')
})

/*
 * 真实 headless 探测（2026-11-06 手动跑过一次，不在 node --test 里执行）：
 *   命令：startLoginWindow({ provider:'bilibili', headless:true, loginUrl:'https://www.bilibili.com/', userDataDir:<tmp> })
 *   结果：ok:true，port=9399（落在 9300-9399 区间），pid 有效；GET /json/version 返回 Chrome/156.0.8078.80；
 *   Node 22 全局 WebSocket 连 browser ws 发 Storage.getCookies 正常返回 14 个 cookie
 *   （buvid3 / b_nut / _uuid / buvid4 / bili_ticket 等）；因未登录没有 SESSDATA，pollLogin 正确返回 waiting；
 *   cancelLogin 后进程已退出、无残留 Chrome（ps 复查无 9399 监听进程）。
 *   默认测试仍只用本机假 CDP 服务，不启动任何真实 Chrome、不依赖真实网络登录。
 */
