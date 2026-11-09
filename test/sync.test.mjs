/**
 * test/sync.test.mjs — 同步模块单元测试（node --test）。
 *
 * 原则：不访问真实外网。网络层只用 127.0.0.1 上的临时 http.Server 验证
 * request() 的超时/取消/重定向/错误映射；真实 B站 / 抖音接口探测见 sync/NOTES.md。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import * as httpMod from '../sync/http.js'
import * as bili from '../sync/bili.js'
import * as douyin from '../sync/douyin.js'

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

async function withServer(handler, fn) {
  const server = http.createServer(handler)
  server.on('clientError', () => {})
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  try {
    return await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => {
      try {
        server.closeAllConnections()
      } catch {
        /* 老版本 Node 没有该方法 */
      }
      server.close(() => resolve())
    })
  }
}

function abortedSignal() {
  const controller = new AbortController()
  controller.abort()
  return controller.signal
}

// ---------------------------------------------------------------------------
// 1. 契约导出（CONTRACT.md §7）
// ---------------------------------------------------------------------------

test('契约导出：sync/http.js', () => {
  assert.equal(typeof httpMod.request, 'function')
  assert.equal(typeof httpMod.UA, 'string')
  assert.ok(httpMod.UA.length > 10)
  assert.match(httpMod.UA, /Mozilla/)
  assert.equal(typeof httpMod.RequestError, 'function')
  assert.equal(typeof httpMod.describeRequestError, 'function')
})

test('契约导出：sync/bili.js', () => {
  assert.equal(typeof bili.fetchAccount, 'function')
  assert.equal(typeof bili.fetchWatchLater, 'function')
})

test('契约导出：sync/douyin.js', () => {
  assert.equal(typeof douyin.parseShareText, 'function')
  assert.equal(typeof douyin.resolveShareUrl, 'function')
  assert.equal(typeof douyin.fetchWatchLater, 'function')
})

// ---------------------------------------------------------------------------
// 2. 抖音分享文案解析
// ---------------------------------------------------------------------------

test('parseShareText：典型分享文案 → 短链 + 清理后的标题', () => {
  const text =
    '7.43 复制打开抖音，看看【大肥鱼的作品】今天的晚霞太好看了 https://v.douyin.com/iRNBho6u/ 复制此链接，打开Dou音搜索，直接观看视频！'
  assert.deepEqual(douyin.parseShareText(text), {
    url: 'https://v.douyin.com/iRNBho6u/',
    title: '【大肥鱼的作品】今天的晚霞太好看了',
  })
})

test('parseShareText：带随机短码的分享文案', () => {
  const text =
    '8.97 mQx:/ 复制打开抖音，看看【某某的作品】这是标题 #话题 https://v.douyin.com/iRNBho6u/ 复制此链接，打开Dou音搜索，直接观看视频！'
  assert.deepEqual(douyin.parseShareText(text), {
    url: 'https://v.douyin.com/iRNBho6u/',
    title: '【某某的作品】这是标题 #话题',
  })
})

test('parseShareText：无 scheme 的裸短链也能识别', () => {
  const parsed = douyin.parseShareText('看看 v.douyin.com/abc123/ 这个')
  assert.equal(parsed.url, 'https://v.douyin.com/abc123/')
})

test('parseShareText：只有分享样板文案时 title 为 null', () => {
  const text =
    '复制打开抖音，看看 https://v.douyin.com/xyz/ 复制此链接，打开Dou音搜索，直接观看视频！'
  assert.deepEqual(douyin.parseShareText(text), { url: 'https://v.douyin.com/xyz/', title: null })
})

test('parseShareText：完整 douyin / iesdouyin 视频链接兜底（规范化为标准链接）', () => {
  assert.deepEqual(douyin.parseShareText('https://www.douyin.com/video/7298145681699622182'), {
    url: 'https://www.douyin.com/video/7298145681699622182',
    title: null,
  })
  assert.deepEqual(
    douyin.parseShareText('https://www.iesdouyin.com/share/video/7298145681699622182/'),
    {
      url: 'https://www.douyin.com/video/7298145681699622182',
      title: null,
    },
  )
})

test('parseShareText：没有抖音链接 / 空输入 -> null', () => {
  assert.equal(douyin.parseShareText('这是一段没有链接的文本'), null)
  assert.equal(douyin.parseShareText(''), null)
  assert.equal(douyin.parseShareText('   '), null)
  assert.equal(douyin.parseShareText(null), null)
  assert.equal(douyin.parseShareText(undefined), null)
  assert.equal(douyin.parseShareText(123), null)
})

test('parseShareText：超长标题截断到 120 字并加省略号', () => {
  const long = '长'.repeat(200)
  const parsed = douyin.parseShareText(`看看${long} https://v.douyin.com/abc/`)
  assert.ok(parsed.title)
  assert.ok(parsed.title.length <= 121)
  assert.ok(parsed.title.endsWith('…'))
})

// ---------------------------------------------------------------------------
// 3. 抖音 URL 解析
// ---------------------------------------------------------------------------

test('parseDouyinUrl：短链 / 视频 / 图文 / 用户 / 其他 / 非抖音', () => {
  assert.deepEqual(douyin.parseDouyinUrl('https://v.douyin.com/iRNBho6u/?x=1'), {
    kind: 'short',
    id: 'iRNBho6u',
    href: 'https://v.douyin.com/iRNBho6u/',
    host: 'v.douyin.com',
  })
  assert.equal(douyin.parseDouyinUrl('v.douyin.com/abc/').kind, 'short')

  const ies = douyin.parseDouyinUrl('https://www.iesdouyin.com/share/video/456/?region=CN')
  assert.equal(ies.kind, 'video')
  assert.equal(ies.id, '456')

  assert.equal(douyin.parseDouyinUrl('https://www.douyin.com/video/123?previous_page=x').kind, 'video')
  assert.equal(douyin.parseDouyinUrl('https://www.douyin.com/note/789').kind, 'note')
  assert.equal(douyin.parseDouyinUrl('https://www.douyin.com/user/MS4wLjAB').kind, 'user')
  assert.equal(douyin.parseDouyinUrl('https://www.douyin.com/').kind, 'other')
  assert.equal(douyin.parseDouyinUrl('https://www.douyin.com/shipin/7373158304409339913').kind, 'other')

  assert.equal(douyin.parseDouyinUrl('https://example.com/video/1'), null)
  assert.equal(douyin.parseDouyinUrl('javascript:alert(1)'), null)
  assert.equal(douyin.parseDouyinUrl('not a url'), null)
  assert.equal(douyin.parseDouyinUrl(''), null)
})

test('resolveTargetFromUrl：只接受视频/图文/用户', () => {
  assert.deepEqual(
    douyin.resolveTargetFromUrl('https://www.douyin.com/video/7298145681699622182?x=1'),
    {
      kind: 'video',
      id: '7298145681699622182',
      href: 'https://www.douyin.com/video/7298145681699622182?x=1',
    },
  )
  assert.equal(douyin.resolveTargetFromUrl('https://v.douyin.com/abc/'), null)
  assert.equal(douyin.resolveTargetFromUrl('not a url'), null)
})

// ---------------------------------------------------------------------------
// 4. 抖音分享落地页元数据解析（当前线上无元数据，解析器为改版兜底）
// ---------------------------------------------------------------------------

test('parseSharePageMeta：当前线上页面（页面上下文 + 通用 title）-> 全 null', () => {
  // 2026-11-06 实测 www.iesdouyin.com/share/video/<id>/ 的真实结构：
  // window._ROUTER_DATA 只有页面上下文；<title> 是“在抖音记录美好生活YYYYMMDD - 抖音”占位标题；
  // meta description 也是通用文案。不能被当成作品标题。
  const html =
    '<html><head>' +
    '<title data-react-helmet="true">在抖音记录美好生活20261106 - 抖音</title>' +
    '<meta data-react-helmet="true" name="description" content="于20261106发布在抖音，已经收获了0个喜欢，来抖音，记录美好生活！"/>' +
    '</head><body><script>window._ROUTER_DATA = ' +
    JSON.stringify({
      loaderData: { 'video_(id)/page': { ua: 'Mozilla', itemId: '7298145681699622182', renderInSSR: 1 } },
      errors: null,
    }) +
    '</script></body></html>'
  assert.deepEqual(douyin.parseSharePageMeta(html), {
    title: null,
    author: null,
    cover: null,
    durationSec: null,
  })
})

test('parseSharePageMeta：过滤抖音通用占位标题', () => {
  const empty = { title: null, author: null, cover: null, durationSec: null }
  assert.deepEqual(
    douyin.parseSharePageMeta('<title>在抖音记录美好生活20261106 - 抖音</title>'),
    empty,
  )
  assert.deepEqual(douyin.parseSharePageMeta('<title>抖音-记录美好生活</title>'), empty)
  assert.deepEqual(douyin.parseSharePageMeta('<title>抖音</title>'), empty)
  assert.deepEqual(douyin.parseSharePageMeta('<title>某个真实作品标题 - 抖音</title>'), {
    ...empty,
    title: '某个真实作品标题 - 抖音',
  })
})

test('parseSharePageMeta：历史 RENDER_DATA（decodeURIComponent）能解析', () => {
  const renderData = {
    loaderData: {
      videoInfo: {
        aweme_id: '123',
        desc: '晚霞真好看',
        author: { nickname: '大肥鱼' },
        video: {
          cover: { url_list: ['https://p3.douyinpic.com/x.jpg'] },
          duration: 153000,
        },
      },
    },
  }
  const html = `<html><body><script>window.RENDER_DATA = JSON.parse(decodeURIComponent("${encodeURIComponent(
    JSON.stringify(renderData),
  )}"))</script></body></html>`
  assert.deepEqual(douyin.parseSharePageMeta(html), {
    title: '晚霞真好看',
    author: '大肥鱼',
    cover: 'https://p3.douyinpic.com/x.jpg',
    durationSec: 153,
  })
})

test('parseSharePageMeta：og:title / og:image 兜底 + HTML 实体解码', () => {
  const html =
    '<html><head><meta property="og:title" content="标题 &amp; 测试">' +
    '<meta property="og:image" content="https://x/y.jpg"></head></html>'
  assert.deepEqual(douyin.parseSharePageMeta(html), {
    title: '标题 & 测试',
    author: null,
    cover: 'https://x/y.jpg',
    durationSec: null,
  })
})

test('parseSharePageMeta：JSON-LD VideoObject 兜底', () => {
  const html =
    '<script type="application/ld+json">' +
    JSON.stringify({
      '@type': 'VideoObject',
      name: 'LD标题',
      thumbnailUrl: ['https://a/b.jpg'],
      duration: 'PT1M30S',
      author: { name: 'LD作者' },
    }) +
    '</script>'
  assert.deepEqual(douyin.parseSharePageMeta(html), {
    title: 'LD标题',
    author: 'LD作者',
    cover: 'https://a/b.jpg',
    durationSec: 90,
  })
})

test('parseSharePageMeta：空/非法输入 -> 全 null', () => {
  const empty = { title: null, author: null, cover: null, durationSec: null }
  assert.deepEqual(douyin.parseSharePageMeta(''), empty)
  assert.deepEqual(douyin.parseSharePageMeta(null), empty)
  assert.deepEqual(douyin.parseSharePageMeta('<html></html>'), empty)
})

// ---------------------------------------------------------------------------
// 5. B站 toview / nav 响应映射
// ---------------------------------------------------------------------------

const TOVIEW_SAMPLE = {
  code: 0,
  message: '0',
  ttl: 1,
  data: {
    count: 2,
    list: [
      {
        aid: 200333024,
        bvid: 'BV1Yz411B7n3',
        title: '较早添加的视频',
        pic: 'http://i1.hdslb.com/bfs/archive/a.jpg',
        duration: 218,
        owner: { mid: 14082, name: '山新' },
        add_at: 1587012410,
        progress: 32,
      },
      {
        aid: 710350011,
        bvid: 'BV1LQ4y1T7Xh',
        title: '最新添加的视频',
        pic: '//i0.hdslb.com/bfs/archive/b.jpg',
        duration: '169',
        owner: { name: 'GTX690' },
        add_at: 1587041785,
      },
    ],
  },
}

test('parseToviewResponse：字段映射 + 封面 https 化 + 按添加时间倒序', () => {
  const parsed = bili.parseToviewResponse(TOVIEW_SAMPLE)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.count, 2)
  assert.equal(parsed.items.length, 2)

  const [latest, earlier] = parsed.items
  assert.deepEqual(latest, {
    remoteId: 'BV1LQ4y1T7Xh',
    // aid 必须原样带出来：写回删除只认数字 aid，新版视频无法由 bvid 反推
    aid: 710350011,
    title: '最新添加的视频',
    url: 'https://www.bilibili.com/video/BV1LQ4y1T7Xh',
    cover: 'https://i0.hdslb.com/bfs/archive/b.jpg',
    author: 'GTX690',
    durationSec: 169,
    addedAt: new Date(1587041785 * 1000).toISOString(),
  })
  assert.equal(earlier.aid, 200333024)
  assert.equal(earlier.cover, 'https://i1.hdslb.com/bfs/archive/a.jpg')
  assert.equal(earlier.author, '山新')
  assert.equal(earlier.durationSec, 218)
})

test('parseToviewResponse：缺 bvid 时用 av 号兜底；脏数据被跳过；最多 100 条', () => {
  const dirty = {
    code: 0,
    data: {
      count: 3,
      list: [
        { aid: 123, title: '只有 aid', pic: 'http://x/y.jpg', duration: 10, owner: { name: 'A' }, add_at: 1600000000 },
        { title: '没有 id' },
        null,
      ],
    },
  }
  const parsed = bili.parseToviewResponse(dirty)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.items.length, 1)
  assert.equal(parsed.items[0].remoteId, 'av123')
  assert.equal(parsed.items[0].url, 'https://www.bilibili.com/video/av123')
  assert.equal(parsed.items[0].author, 'A')

  const many = {
    code: 0,
    data: {
      count: 120,
      list: Array.from({ length: 120 }, (_, i) => ({
        aid: 1000 + i,
        bvid: `BV${i}`,
        title: `视频 ${i}`,
        pic: null,
        duration: 60,
        owner: { name: 'UP' },
        add_at: 1600000000 + i,
      })),
    },
  }
  const limited = bili.parseToviewResponse(many)
  assert.equal(limited.items.length, 100)
})

test('parseToviewResponse：错误码 / 空响应 / 结构异常 -> ok:false + 人话错误', () => {
  const notLogin = bili.parseToviewResponse({ code: -101, message: '账号未登录' })
  assert.equal(notLogin.ok, false)
  assert.equal(notLogin.items.length, 0)
  assert.match(notLogin.error, /cookie/i)

  const badCookie = bili.parseToviewResponse({ code: -400, message: '请求错误' })
  assert.equal(badCookie.ok, false)
  assert.match(badCookie.error, /-400/)

  const empty = bili.parseToviewResponse(null)
  assert.equal(empty.ok, false)
  assert.match(empty.error, /空响应/)

  const broken = bili.parseToviewResponse({ code: 0, data: {} })
  assert.equal(broken.ok, false)
  assert.match(broken.error, /结构异常/)

  const unknown = bili.parseToviewResponse({ code: 12345, message: '神秘错误' })
  assert.equal(unknown.ok, false)
  assert.match(unknown.error, /code=12345/)
})

test('parseNavResponse：登录态映射 / 未登录 / 非 0 返回码', () => {
  const ok = bili.parseNavResponse({
    code: 0,
    data: { isLogin: true, uname: '大肥鱼', face: 'http://i0.hdslb.com/bfs/face/x.jpg', mid: 42 },
  })
  assert.deepEqual(ok, {
    ok: true,
    name: '大肥鱼',
    avatar: 'https://i0.hdslb.com/bfs/face/x.jpg',
    mid: 42,
  })

  const noCookie = bili.parseNavResponse({ code: -101, message: '账号未登录' })
  assert.equal(noCookie.ok, false)
  assert.match(noCookie.error, /cookie/i)

  const notLogin = bili.parseNavResponse({ code: 0, data: { isLogin: false } })
  assert.equal(notLogin.ok, false)
  assert.match(notLogin.error, /cookie/i)

  assert.equal(bili.parseNavResponse(undefined).ok, false)
})

// ---------------------------------------------------------------------------
// 6. B站 辅助函数
// ---------------------------------------------------------------------------

test('mapBiliCode：常见错误码映射成人话', () => {
  assert.equal(bili.mapBiliCode(0, '0'), null)
  assert.match(bili.mapBiliCode(-101, '账号未登录'), /cookie/i)
  assert.match(bili.mapBiliCode(-400, '请求错误'), /-400/)
  assert.match(bili.mapBiliCode(-352, ''), /风控/)
  assert.match(bili.mapBiliCode(-412, ''), /风控/)
  assert.match(bili.mapBiliCode(90001, ''), /列表已满/)
  assert.match(bili.mapBiliCode('abc', ''), /code=abc/)
})

test('mapBiliHttpStatus：HTTP 层错误人话', () => {
  assert.match(bili.mapBiliHttpStatus(412), /风控/)
  assert.match(bili.mapBiliHttpStatus(403), /403/)
  assert.match(bili.mapBiliHttpStatus(500), /HTTP 500/)
})

test('buildCookieHeader：整段 Cookie / 裸 SESSDATA / 换行 / 空值', () => {
  assert.equal(bili.buildCookieHeader('SESSDATA=abc; bili_jct=xyz'), 'SESSDATA=abc; bili_jct=xyz')
  assert.equal(bili.buildCookieHeader('abc123'), 'SESSDATA=abc123')
  assert.equal(
    bili.buildCookieHeader('SESSDATA=abc\nbili_jct=xyz'),
    'SESSDATA=abc; bili_jct=xyz',
  )
  assert.equal(bili.buildCookieHeader(''), null)
  assert.equal(bili.buildCookieHeader('   '), null)
  assert.equal(bili.buildCookieHeader(null), null)
  assert.equal(bili.buildCookieHeader(123), null)
})

test('normalizeBiliCover：http/协议相对/空值', () => {
  assert.equal(bili.normalizeBiliCover('http://i1.hdslb.com/a.jpg'), 'https://i1.hdslb.com/a.jpg')
  assert.equal(bili.normalizeBiliCover('//i1.hdslb.com/a.jpg'), 'https://i1.hdslb.com/a.jpg')
  assert.equal(bili.normalizeBiliCover('https://i1.hdslb.com/a.jpg'), 'https://i1.hdslb.com/a.jpg')
  assert.equal(bili.normalizeBiliCover(''), null)
  assert.equal(bili.normalizeBiliCover(null), null)
})

test('fetchAccount / fetchWatchLater：未配置 cookie 时结构化失败且不发网络请求', async () => {
  await assert.doesNotReject(async () => {
    const account = await bili.fetchAccount()
    assert.equal(account.ok, false)
    assert.match(account.error, /cookie/i)

    const account2 = await bili.fetchAccount({ cookie: '' })
    assert.equal(account2.ok, false)

    const list = await bili.fetchWatchLater()
    assert.deepEqual(list.items, [])
    assert.equal(list.ok, false)
    assert.match(list.error, /cookie/i)
  })
})

test('bili：已取消的 signal 直接返回“取消”，不发网络请求', async () => {
  const account = await bili.fetchAccount({ cookie: 'SESSDATA=x', signal: abortedSignal() })
  assert.equal(account.ok, false)
  assert.match(account.error, /取消/)

  const list = await bili.fetchWatchLater({ cookie: 'SESSDATA=x', signal: abortedSignal() })
  assert.equal(list.ok, false)
  assert.deepEqual(list.items, [])
  assert.match(list.error, /取消/)
})

// ---------------------------------------------------------------------------
// 7. 抖音「稍后再看」响应映射与错误映射
// ---------------------------------------------------------------------------

test('mapDouyinStatusCode：常见状态映射成人话', () => {
  assert.equal(douyin.mapDouyinStatusCode(0, ''), null)
  assert.match(douyin.mapDouyinStatusCode(8, '用户未登录'), /cookie/i)
  assert.match(douyin.mapDouyinStatusCode(11110, 'encrypt_data_miss'), /encrypt_data/)
  assert.match(douyin.mapDouyinStatusCode(2154, ''), /风控/)
  assert.match(douyin.mapDouyinStatusCode(999, '未知'), /status_code=999/)
})

test('mapDouyinAweme：直接 aweme / 包裹结构 / 无效项', () => {
  const direct = douyin.mapDouyinAweme({
    aweme_id: '7298145681699622182',
    desc: '测试标题',
    author: { nickname: '作者A' },
    video: {
      cover: { url_list: ['https://p3.douyinpic.com/c.jpg'] },
      duration: 15000,
    },
    create_time: 1700000000,
  })
  assert.deepEqual(direct, {
    remoteId: '7298145681699622182',
    title: '测试标题',
    url: 'https://www.douyin.com/video/7298145681699622182',
    cover: 'https://p3.douyinpic.com/c.jpg',
    author: '作者A',
    durationSec: 15,
    addedAt: new Date(1700000000 * 1000).toISOString(),
  })

  const wrapped = douyin.mapDouyinAweme({
    aweme: {
      aweme_id: '1',
      desc: 'xx',
      author: { nickname: 'b' },
      video: { cover: { url_list: ['https://c/d.jpg'] }, duration: 61000 },
      create_time: 1700000000,
    },
  })
  assert.equal(wrapped.remoteId, '1')
  assert.equal(wrapped.durationSec, 61)

  assert.equal(douyin.mapDouyinAweme(null), null)
  assert.equal(douyin.mapDouyinAweme({ desc: '没有 id' }), null)
  assert.equal(douyin.mapDouyinAweme('字符串'), null)
})

test('parseDouyinWatchLaterResponse：空列表 / 正常条目 / 未登录 / aweme_list 兜底', () => {
  const empty = douyin.parseDouyinWatchLaterResponse({
    status_code: 0,
    items: null,
    has_more: false,
    offset: 0,
  })
  assert.equal(empty.ok, true)
  assert.deepEqual(empty.items, [])
  assert.equal(empty.hasMore, false)

  const normal = douyin.parseDouyinWatchLaterResponse({
    status_code: 0,
    has_more: 1,
    offset: 0,
    items: [{ aweme_id: '7298145681699622182', desc: '标题' }],
  })
  assert.equal(normal.ok, true)
  assert.equal(normal.items.length, 1)
  assert.equal(normal.hasMore, true)
  assert.equal(normal.nextOffset, 1)

  const fallback = douyin.parseDouyinWatchLaterResponse({
    status_code: 0,
    aweme_list: [{ aweme_id: '42', desc: '兜底' }],
  })
  assert.equal(fallback.items.length, 1)

  const notLogin = douyin.parseDouyinWatchLaterResponse({
    status_code: 8,
    status_msg: '用户未登录',
  })
  assert.equal(notLogin.ok, false)
  assert.match(notLogin.error, /cookie/i)

  assert.equal(douyin.parseDouyinWatchLaterResponse(null).ok, false)
})

test('buildDouyinCookieHeader：整段 / 裸 sessionid / 空值', () => {
  assert.equal(
    douyin.buildDouyinCookieHeader('sessionid=abc; ttwid=xyz'),
    'sessionid=abc; ttwid=xyz',
  )
  assert.equal(douyin.buildDouyinCookieHeader('abc123'), 'sessionid=abc123')
  assert.equal(douyin.buildDouyinCookieHeader(''), null)
  assert.equal(douyin.buildDouyinCookieHeader(null), null)
})

test('douyin.fetchWatchLater：未配置 cookie -> supported:true + 可读错误，不伪造数据', async () => {
  const result = await douyin.fetchWatchLater()
  assert.equal(result.ok, false)
  assert.equal(result.supported, true)
  assert.deepEqual(result.items, [])
  assert.match(result.error, /cookie/i)
})

test('douyin.fetchWatchLater：已取消 signal 直接返回取消', async () => {
  const result = await douyin.fetchWatchLater({ cookie: 'sessionid=x', signal: abortedSignal() })
  assert.equal(result.ok, false)
  assert.equal(result.supported, true)
  assert.deepEqual(result.items, [])
  assert.match(result.error, /取消/)
})

// ---------------------------------------------------------------------------
// 8. resolveShareUrl：无网络也能覆盖的输入校验分支
// ---------------------------------------------------------------------------

test('resolveShareUrl：缺链接 / 非抖音链接 / 用户主页 -> ok:false', async () => {
  const missing = await douyin.resolveShareUrl({})
  assert.equal(missing.ok, false)
  assert.match(missing.error, /链接/)

  const foreign = await douyin.resolveShareUrl({ url: 'https://example.com/video/1' })
  assert.equal(foreign.ok, false)
  assert.match(foreign.error, /抖音/)

  const userPage = await douyin.resolveShareUrl({ url: 'https://www.douyin.com/user/MS4wLjAB' })
  assert.equal(userPage.ok, false)
  assert.match(userPage.error, /用户主页/)
})

test('resolveShareUrl：已取消 signal -> 结构化取消错误', async () => {
  const result = await douyin.resolveShareUrl({
    url: 'https://v.douyin.com/iRNBho6u/',
    signal: abortedSignal(),
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /取消/)
})

// ---------------------------------------------------------------------------
// 9. request() 网络层（只打 127.0.0.1，不访问真实网络）
// ---------------------------------------------------------------------------

test('request：返回 status/url/headers/text/json，headers 支持下标与 get()', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ hello: '世界' }))
    },
    async (base) => {
      const res = await httpMod.request(`${base}/json`)
      assert.equal(res.status, 200)
      assert.equal(res.ok, true)
      assert.equal(res.url, `${base}/json`)
      assert.match(res.headers['content-type'], /application\/json/)
      assert.match(String(res.headers.get('Content-Type')), /application\/json/)
      assert.deepEqual(await res.json(), { hello: '世界' })
      // 二次读取走缓存，不会抛 "Body is unusable"
      assert.equal(typeof (await res.text()), 'string')
    },
  )
})

test('request：redirect manual 读到 Location，follow 跟随后 url 更新', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { Location: '/target' })
        res.end('redirecting')
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('done')
    },
    async (base) => {
      const manual = await httpMod.request(`${base}/start`, { redirect: 'manual' })
      assert.equal(manual.status, 302)
      assert.equal(manual.headers.get('location'), '/target')
      assert.equal((await manual.text()).trim(), 'redirecting')

      const followed = await httpMod.request(`${base}/start`)
      assert.equal(followed.status, 200)
      assert.ok(followed.url.endsWith('/target'))
      assert.equal(await followed.text(), 'done')
    },
  )
})

test('request：超时映射为 TIMEOUT（12s 默认值可覆盖）', async () => {
  await withServer(
    (req, res) => {
      const timer = setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(200)
          res.end('too late')
        }
      }, 300)
      if (typeof timer.unref === 'function') timer.unref()
    },
    async (base) => {
      await assert.rejects(
        httpMod.request(`${base}/slow`, { timeoutMs: 60 }),
        (err) => {
          assert.equal(err.name, 'RequestError')
          assert.equal(err.code, 'TIMEOUT')
          return true
        },
      )
    },
  )
})

test('request：外部 AbortSignal 取消映射为 ABORTED', async () => {
  await withServer(
    () => {
      /* 永不响应 */
    },
    async (base) => {
      const controller = new AbortController()
      const promise = httpMod.request(`${base}/hang`, { signal: controller.signal, timeoutMs: 5000 })
      setTimeout(() => controller.abort(), 30)
      await assert.rejects(promise, (err) => {
        assert.equal(err.code, 'ABORTED')
        return true
      })
      // 已经中止的 signal 直接拒绝，不发请求
      await assert.rejects(
        httpMod.request(`${base}/hang`, { signal: abortedSignal() }),
        (err) => err.code === 'ABORTED',
      )
    },
  )
})

test('request：连接失败映射为 NETWORK', async () => {
  let deadBase = null
  await withServer(
    (req, res) => res.end('x'),
    async (base) => {
      deadBase = base
    },
  )
  await assert.rejects(httpMod.request(deadBase, { timeoutMs: 2000 }), (err) => {
    assert.equal(err.code, 'NETWORK')
    assert.match(httpMod.describeRequestError(err), /网络请求失败/)
    return true
  })
})

test('request：非法 JSON 响应 -> json() 抛 PARSE', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html>not json</html>')
    },
    async (base) => {
      const res = await httpMod.request(base)
      await assert.rejects(res.json(), (err) => {
        assert.equal(err.code, 'PARSE')
        return true
      })
    },
  )
})

test('describeRequestError：中文人话映射', () => {
  assert.match(
    httpMod.describeRequestError(new httpMod.RequestError('TIMEOUT', 'x')),
    /超时/,
  )
  assert.match(httpMod.describeRequestError(new httpMod.RequestError('ABORTED', 'x')), /取消/)
  assert.match(httpMod.describeRequestError(new httpMod.RequestError('PARSE', 'x')), /JSON/)
  assert.match(
    httpMod.describeRequestError(new Error('boom')),
    /请求失败：boom/,
  )
})

// ---------------------------------------------------------------------------
// 10. 短链跳转（本地模拟 302，不访问真实抖音）
// ---------------------------------------------------------------------------

test('followShortLink：手动跟跳并记录 hops', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/short') {
        res.writeHead(302, { Location: '/share/video/7298145681699622182?previous_page=x' })
        res.end('')
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html>fake share page</html>')
    },
    async (base) => {
      const followed = await douyin.followShortLink(`${base}/short`, { headers: {} })
      assert.equal(followed.finalUrl, `${base}/share/video/7298145681699622182?previous_page=x`)
      assert.equal(followed.hops.length, 1)
      assert.equal(followed.hops[0].status, 302)
      assert.equal(followed.hops[0].to, followed.finalUrl)
    },
  )
})
