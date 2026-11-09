/**
 * 内容直读抽取测试：纯函数 + 本地 HTTP 服务，不依赖真实网络。
 *   node --test test/content.test.mjs
 */
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

const { extractArticleText, extractImages, extractOgImage, resolveContent, parseXiaohongshuState } = await import('../content.js')

const WECHAT_HTML = `<!doctype html><html><head><title>t</title><script>var x=1</script></head>
<body>
<h1>标题</h1>
<div class="rich_media_content" id="js_content">
  <p>第一段正文，讲 AI Agent 架构。</p>
  <p>第二段正文，含 <strong>重点</strong> 内容。</p>
  <img data-src="https://mmbiz.qpic.cn/a.jpg" />
  <img src="/relative/b.png" />
</div>
<div class="footer">底部广告</div>
</body></html>`

const GENERIC_HTML = `<!doctype html><html><body>
<nav>导航</nav>
<article><h2>文章标题</h2><p>这是文章的正文第一段，用来验证正文抽取逻辑是否可以把段落文本完整取出来。</p>
<p>这是第二段，包含 <a href="/x">链接</a>。再补一些文字让正文长度超过一百二十个字符，避免触发“没有提取到正文”的兜底提示。</p>
<p>第三段继续补充内容：插件需要把文章正文、内容图片都抓下来，这样在面板里才能直接阅读，而不是只有一个标题。</p></article>
<footer>版权</footer>
</body></html>`

let server
let baseUrl

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/article') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(GENERIC_HTML)
      return
    }
    if (req.url === '/wechat') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(WECHAT_HTML)
      return
    }
    if (req.url === '/broken') {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('boom')
      return
    }
    res.writeHead(404)
    res.end('nope')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = 'http://127.0.0.1:' + server.address().port
})

after(() => {
  server?.close()
})

test('extractArticleText 提取正文并去掉脚本/广告', () => {
  const text = extractArticleText(WECHAT_HTML, 'wechat')
  assert.match(text, /第一段正文/)
  assert.match(text, /第二段正文/)
  assert.doesNotMatch(text, /var x=1/)
  assert.doesNotMatch(text, /底部广告/)
})

test('extractArticleText 支持普通 article 页面', () => {
  const text = extractArticleText(GENERIC_HTML, 'normal')
  assert.match(text, /文章标题/)
  assert.match(text, /正文第一段/)
  assert.doesNotMatch(text, /导航/)
})

test('extractImages 解析相对/绝对图片并去重、过滤 svg', () => {
  const html = `<img src="https://a.com/1.png"><img data-src="//b.com/2.jpg"><img src="/rel/3.webp"><img src="x.svg"><img src="https://a.com/1.png">`
  const images = extractImages(html, 'https://c.com/post')
  assert.deepEqual(images, ['https://a.com/1.png', 'https://b.com/2.jpg', 'https://c.com/rel/3.webp'])
})

test('resolveContent：本地图片直接可用', async () => {
  const content = await resolveContent({
    id: 'wl_1',
    kind: 'image',
    cover: '/api/dsh-watch-later/media?f=a.png',
    title: '图片',
  })
  assert.equal(content.type, 'image')
  assert.deepEqual(content.images, ['/api/dsh-watch-later/media?f=a.png'])
  assert.equal(content.error, null)
})

test('resolveContent：普通链接抓正文（本地服务）', async () => {
  const content = await resolveContent({ id: 'wl_2', kind: 'link', url: baseUrl + '/article', title: '文章' })
  assert.equal(content.type, 'page')
  assert.match(String(content.text), /正文第一段/)
  assert.equal(content.error, null)
  assert.ok(content.fetchedAt)
})

test('resolveContent：HTTP 失败降级为 error 而不抛', async () => {
  const content = await resolveContent({ id: 'wl_3', kind: 'link', url: baseUrl + '/broken' })
  assert.match(String(content.error), /HTTP 500/)
  assert.equal(content.text, null)
})

test('resolveContent：抖音无内嵌播放器但给出原视频', async () => {
  const content = await resolveContent({
    id: 'wl_4',
    kind: 'douyin',
    url: 'https://www.douyin.com/video/123',
    cover: 'https://p3.douyinpic.com/x.jpg',
    summary: '测试视频',
  })
  assert.equal(content.type, 'video')
  assert.equal(content.video.embedUrl, null)
  assert.equal(content.video.url, 'https://www.douyin.com/video/123')
  assert.match(String(content.error), /内嵌播放器/)
})

test('resolveContent：无链接纯文字条目返回 none + 文本', async () => {
  const content = await resolveContent({ id: 'wl_5', kind: 'other', title: '纯文字', summary: '一段文字' })
  assert.equal(content.type, 'none')
  assert.equal(content.text, '一段文字')
})


test('parseXiaohongshuState 解析笔记正文与图片', () => {
  const html = '<html><script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"abc123":{"note":{"title":"AI 味网页怎么识别","desc":"看渐变、看间距、看图标。","user":{"nickname":"设计观察"},"imageList":[{"urlDefault":"http://sns-img.xhscdn.com/a.jpg"},{"urlPre":"https://sns-img.xhscdn.com/b.jpg"}],"tagList":[{"name":"设计"},{"name":"前端"}]}}}}}</script></html>'
  const state = parseXiaohongshuState(html)
  assert.ok(state)
  assert.equal(state.note.noteDetailMap.abc123.note.title, 'AI 味网页怎么识别')
})

test('parseXiaohongshuState 遇到没有 SSR 数据的页面返回 null', () => {
  assert.equal(parseXiaohongshuState('<html><body>login wall</body></html>'), null)
  assert.equal(parseXiaohongshuState(''), null)
})


test('extractOgImage 优先取 og:image / twitter:image', () => {
  const html = '<html><head><meta property="og:image" content="//mmbiz.qpic.cn/a/b.jpg" /><meta name="twitter:image" content="https://example.com/t.png" /></head></html>'
  assert.equal(extractOgImage(html, 'https://mp.weixin.qq.com/s/x'), 'https://mmbiz.qpic.cn/a/b.jpg')
  assert.equal(extractOgImage('<html></html>', 'https://example.com'), null)
})

test('parseXiaohongshuState 认手机分享页形态（noteData.data.noteData）', async () => {
  const { xhsNoteFromState } = await import('../content.js')
  const html =
    '<html><script>window.__INITIAL_STATE__={"noteData":{"data":{"noteData":{"noteId":"6abb13f4000000001801971a","title":"极简主义｜请扔掉这60件东西","desc":"丢掉这60件东西。","user":{"nickName":"Aura在成长"},"imageList":[{"url":"http://sns-webpic-qc.xhscdn.com/a/1.jpg"},{"url":"http://sns-webpic-qc.xhscdn.com/a/2.jpg"}],"tagList":[{"name":"极简生活"}]}}},"normalNotePreloadData":{}}</script></html>'
  const state = parseXiaohongshuState(html)
  assert.ok(state)
  const note = xhsNoteFromState(state, '6abb13f4000000001801971a')
  assert.ok(note)
  assert.equal(note.title, '极简主义｜请扔掉这60件东西')
  assert.equal(note.imageList.length, 2)
})

test('parseXiaohongshuState 能切出带括号字符串的很长 JSON', () => {
  const desc = '正文里有 } 和 { 括号，还有 "引号" 转义 \\ 反斜杠'
  const html = `<html><script>window.__INITIAL_STATE__=${JSON.stringify({ noteData: { data: { noteData: { noteId: 'n1', desc, imageList: [{ url: 'http://x/1.jpg' }] } } } })};window.x=1</script></html>`
  const state = parseXiaohongshuState(html)
  assert.equal(state.noteData.data.noteData.desc, desc)
})
