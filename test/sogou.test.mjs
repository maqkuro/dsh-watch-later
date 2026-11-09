/**
 * 搜狗微信搜索：解析、标题匹配、缩略图 URL、状态去重。
 *   node --test test/sogou.test.mjs
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'wl-sogou-test-'))
process.env.DSH_WATCH_LATER_DIR = dataDir

const {
  parseSogouResults,
  pickBestResult,
  titleSimilarity,
  extractMmbizThumb,
  shouldTrySogou,
  markSogouTried,
} = await import('../sogou.js')

after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

const FIXTURE = `
<ul class="news-list">
<li id="sogou_vr_11002601_box_0" d="abc">
  <div class="img-box"><a href="/link?url=x"><img src="//img01.sogoucdn.com/v2/thumb?appid=201147&amp;url=https%3A%2F%2Fmmbiz.qpic.cn%2Fabc%2F1%3Fwx_fmt%3Djpeg&amp;sign=x"></a></div>
  <div class="txt-box"><h3><a href="/link?url=y"><em>本周</em>GitHub 热榜被 Agent Skill 霸榜</a></h3>
  <p class="txt-info" id="sogou_vr_11002601_summary_0">别叠着装，本周最火的三个设计类 Skill 解决一个问题。</p>
  <div class="s-p"><span class="all-time-y2">世界人工智能论坛</span><span class="s2"><script>document.write(timeConvert('1793936735'))</script></span></div></div>
</li>
<li id="sogou_vr_11002601_box_1" d="def">
  <div class="txt-box"><h3><a href="/link?url=z">另一篇文章</a></h3>
  <p class="txt-info">摘要 2</p><div class="s-p"><span class="all-time-y2">某号</span></div></div>
</li>
</ul>`

test('解析搜狗搜索结果：标题/摘要/公众号/缩略图/时间', () => {
  const results = parseSogouResults(FIXTURE)
  assert.equal(results.length, 2)
  assert.equal(results[0].title, '本周GitHub 热榜被 Agent Skill 霸榜')
  assert.match(results[0].digest, /三个设计类 Skill/)
  assert.equal(results[0].account, '世界人工智能论坛')
  assert.equal(results[0].thumbUrl, 'https://mmbiz.qpic.cn/abc/1?wx_fmt=jpeg')
  assert.ok(results[0].time)
})

test('标题相似度与最佳匹配', () => {
  const results = parseSogouResults(FIXTURE)
  const best = pickBestResult(results, '本周 GitHub 热榜被 Agent Skill 霸榜')
  assert.ok(best)
  assert.equal(best.account, '世界人工智能论坛')
  assert.equal(pickBestResult(results, '完全不相关的标题'), null)
  assert.ok(titleSimilarity('本周 GitHub 热榜被 Agent Skill 霸榜', '本周GitHub热榜被Agent Skill霸榜') > 0.9)
})

test('缩略图 URL 提取与状态去重', () => {
  assert.equal(extractMmbizThumb('https://img01.sogoucdn.com/v2/thumb?url=https%3A%2F%2Fmmbiz.qpic.cn%2Fa%2F1%3Fwx_fmt%3Djpeg'), 'https://mmbiz.qpic.cn/a/1?wx_fmt=jpeg')
  assert.equal(extractMmbizThumb('https://example.com/x.png'), null)

  const generated = { id: 'wl_test', cover: '/api/dsh-watch-later/media?f=x.svg' }
  const real = { id: 'wl_test2', cover: '/api/dsh-watch-later/media?f=x.jpg' }
  assert.equal(shouldTrySogou(generated), true)
  assert.equal(shouldTrySogou(real), false)
  markSogouTried('wl_test', { ok: true })
  assert.equal(shouldTrySogou(generated), false)
})
