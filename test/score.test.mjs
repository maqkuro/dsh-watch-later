/**
 * test/score.test.mjs — score.js + classify.js 单测（node --test）
 *
 * 覆盖 CONTRACT.md §3 全部分支：打分公式/边界、timeSensitivity 阈值表、triage 分桶、
 * deriveItem 视图字段与不可变性、sortForQueue 排序、countItems 口径、classifyUrl 各平台、
 * 日期解析（含缺年份/过去 30 天/非法日期）、extractUrls 去重、heuristicExtract /
 * heuristicImportText 的多链接 / 纯文本 / 空文本。
 *
 * 全部时间通过 nowMs 注入，不依赖网络、不依赖真实时钟。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  KINDS,
  KIND_META,
  TRIAGE_RANK,
  classifyUrl,
  timeSensitivity,
  computeScore,
  deriveItem,
  deriveSnapshotView,
  sortForQueue,
  countItems,
} from '../score.js'

import {
  extractUrls,
  heuristicExtract,
  parseDeadlineFromText,
  heuristicImportText,
} from '../classify.js'

const H = 3600 * 1000
const D = 24 * H
// 2026-11-06T08:00:00Z（本地 Asia/Shanghai 为 16:00）
const NOW = Date.UTC(2026, 10, 6, 8, 0, 0)

const iso = (ms) => new Date(ms).toISOString()

/** 完整 Item 工厂（默认 active / importance 3 / urgency 3 / 30 天前创建 → 低 freshness） */
function makeItem(overrides = {}) {
  return {
    id: 'wl_test',
    kind: 'link',
    title: '测试条目',
    url: null,
    summary: null,
    author: null,
    site: null,
    cover: null,
    raw: null,
    channel: 'manual',
    tags: [],
    status: 'queued',
    importance: 3,
    urgency: 3,
    deadline: null,
    deadlineKind: 'none',
    durationMin: 5,
    progress: null,
    notes: null,
    createdAt: iso(NOW - 30 * D),
    updatedAt: iso(NOW - 30 * D),
    readAt: null,
    archivedAt: null,
    snoozedUntil: null,
    ai: { classified: false, reason: null, confidence: null, at: null },
    sync: null,
    ...overrides,
  }
}

function localParts(isoString) {
  const date = new Date(isoString)
  return {
    y: date.getFullYear(),
    mo: date.getMonth() + 1,
    d: date.getDate(),
    hh: date.getHours(),
    mi: date.getMinutes(),
    s: date.getSeconds(),
  }
}

/* ================================================================== *
 * 常量
 * ================================================================== */

test('KINDS：13 个 kind，顺序与契约 §2 一致', () => {
  assert.deepEqual(KINDS, [
    'image',
    'xhs',
    'wechat',
    'link',
    'video',
    'bilibili',
    'douyin',
    'drama',
    'game',
    'article',
    'product',
    'idea',
    'other',
  ])
  assert.equal(KINDS.length, 13)
})

test('KIND_META：每个 kind 都有中文 label / 0.4~0.9 weight / 英文 icon', () => {
  for (const kind of KINDS) {
    const meta = KIND_META[kind]
    assert.ok(meta, `缺少 ${kind} 的 meta`)
    assert.equal(typeof meta.label, 'string')
    assert.ok(meta.label.length > 0)
    assert.ok(meta.weight >= 0.4 && meta.weight <= 0.9, `${kind} weight 越界`)
    assert.match(meta.icon, /^[a-z]+$/)
  }
  assert.equal(KIND_META.xhs.label, '小红书')
  assert.equal(KIND_META.wechat.label, '微信公众号')
  assert.equal(KIND_META.bilibili.label, 'B站')
  assert.equal(KIND_META.drama.label, '剧集')
  assert.equal(KIND_META.other.label, '其他')
})

test('TRIAGE_RANK：契约 §3 的固定权重', () => {
  assert.deepEqual(TRIAGE_RANK, {
    expired: 0,
    now: 1,
    today: 2,
    week: 3,
    later: 4,
    done: 5,
    archived: 6,
  })
})

/* ================================================================== *
 * classifyUrl
 * ================================================================== */

test('classifyUrl：契约 §3.6 平台映射', () => {
  const cases = [
    ['https://www.xiaohongshu.com/explore/abc', 'xhs', '小红书'],
    ['https://xhslink.com/a/bCdef', 'xhs', '小红书'],
    ['https://mp.weixin.qq.com/s/abcdef', 'wechat', '微信公众号'],
    ['https://www.bilibili.com/video/BV1xx411c7mD', 'bilibili', 'B站'],
    ['https://b23.tv/abc123', 'bilibili', 'B站'],
    ['https://v.douyin.com/iRabcdef/', 'douyin', '抖音'],
    ['https://www.iesdouyin.com/share/video/123', 'douyin', '抖音'],
    ['https://weibo.com/1234/abcd', 'link', '微博'],
    ['https://zhuanlan.zhihu.com/p/123456', 'article', '知乎'],
    ['https://github.com/foo/bar', 'link', 'GitHub'],
    ['https://youtu.be/abcdef', 'video', 'YouTube'],
    ['https://www.youtube.com/watch?v=abcdef', 'video', 'YouTube'],
    ['https://item.taobao.com/item.htm?id=1', 'product', '淘宝'],
    ['https://detail.tmall.com/item.htm?id=1', 'product', '天猫'],
    ['https://item.jd.com/100.html', 'product', '京东'],
    ['https://mobile.pinduoduo.com/goods.html', 'product', '拼多多'],
    ['https://www.douban.com/subject/123/', 'link', '豆瓣'],
  ]
  for (const [url, kind, site] of cases) {
    assert.deepEqual(classifyUrl(url), { kind, site }, url)
  }
})

test('classifyUrl：图片 / 视频扩展名', () => {
  assert.deepEqual(classifyUrl('https://pic.example.com/a/b.jpg'), { kind: 'image', site: null })
  assert.deepEqual(classifyUrl('https://a.example.com/x.WEBP?w=100'), { kind: 'image', site: null })
  assert.deepEqual(classifyUrl('https://a.example.com/x.png#frag'), { kind: 'image', site: null })
  assert.deepEqual(classifyUrl('https://cdn.example.com/v/clip.mp4'), { kind: 'video', site: null })
  assert.deepEqual(classifyUrl('https://cdn.example.com/v/clip.m3u8?token=1'), {
    kind: 'video',
    site: null,
  })
  assert.deepEqual(classifyUrl('https://a.example.com/x.mov'), { kind: 'video', site: null })
  // dataURL（图片入库路径）
  assert.deepEqual(classifyUrl('data:image/png;base64,AAAA'), { kind: 'image', site: null })
})

test('classifyUrl：默认 link / 无协议 / 大小写 / 防御', () => {
  assert.deepEqual(classifyUrl('https://example.com/post/1'), { kind: 'link', site: null })
  assert.deepEqual(classifyUrl('www.bilibili.com/video/BV1'), { kind: 'bilibili', site: 'B站' })
  assert.deepEqual(classifyUrl('b23.tv/abc'), { kind: 'bilibili', site: 'B站' })
  assert.deepEqual(classifyUrl('HTTPS://WWW.XIAOHONGSHU.COM/explore/abc'), {
    kind: 'xhs',
    site: '小红书',
  })
  // 裸文件名按图片处理（收件箱投递场景）
  assert.deepEqual(classifyUrl('cat.jpg'), { kind: 'image', site: null })
  // 平台规则优先于扩展名（B站视频页带 .mp4 时仍归 bilibili）
  assert.deepEqual(classifyUrl('https://www.bilibili.com/video/BV1.mp4'), {
    kind: 'bilibili',
    site: 'B站',
  })
  // 非法入参不抛错
  assert.deepEqual(classifyUrl(null), { kind: 'other', site: null })
  assert.deepEqual(classifyUrl(''), { kind: 'other', site: null })
  assert.deepEqual(classifyUrl(123), { kind: 'other', site: null })
})

/* ================================================================== *
 * timeSensitivity
 * ================================================================== */

test('timeSensitivity：无 deadline → none / pressure 0', () => {
  const expected = { level: 'none', hoursLeft: null, pressure: 0 }
  assert.deepEqual(timeSensitivity(null, NOW), expected)
  assert.deepEqual(timeSensitivity(undefined, NOW), expected)
  assert.deepEqual(timeSensitivity('', NOW), expected)
  assert.deepEqual(timeSensitivity('not-a-date', NOW), expected)
  assert.deepEqual(timeSensitivity({}, NOW), expected)
})

test('timeSensitivity：契约 §3.2 阈值表逐档', () => {
  const cases = [
    [NOW + 3 * H, 'critical', 100, 3],
    [NOW + 6 * H, 'critical', 100, 6],
    [NOW + 6 * H + 1, 'critical', 85, null],
    [NOW + 10 * H, 'critical', 85, 10],
    [NOW + 24 * H, 'critical', 85, 24],
    [NOW + 24 * H + 1, 'soon', 65, null],
    [NOW + 48 * H, 'soon', 65, 48],
    [NOW + 72 * H, 'soon', 65, 72],
    [NOW + 72 * H + 1, 'soon', 45, null],
    [NOW + 168 * H, 'soon', 45, 168],
    [NOW + 168 * H + 1, 'ahead', 25, null],
    [NOW + 300 * H, 'ahead', 25, 300],
    [NOW + 336 * H, 'ahead', 25, 336],
    [NOW + 336 * H + 1, 'ahead', 10, null],
    [NOW + 400 * H, 'ahead', 10, 400],
    [NOW, 'critical', 100, 0],
    [NOW - 1, 'expired', 60, null],
    [NOW - 2 * H, 'expired', 60, -2],
    [NOW - 24 * H, 'expired', 60, -24],
    [NOW - 24 * H - 1, 'expired', 0, null],
    [NOW - 48 * H, 'expired', 0, -48],
  ]
  for (const [ms, level, pressure, exactHours] of cases) {
    const result = timeSensitivity(iso(ms), NOW)
    assert.equal(result.level, level, `deadline=${iso(ms)}`)
    assert.equal(result.pressure, pressure, `deadline=${iso(ms)}`)
    if (exactHours !== null) assert.equal(result.hoursLeft, exactHours)
  }
})

test('timeSensitivity：hoursLeft 为距 deadline 的小时数（负数 = 已过期）', () => {
  assert.ok(Math.abs(timeSensitivity(iso(NOW + 5 * H), NOW).hoursLeft - 5) < 1e-9)
  assert.ok(Math.abs(timeSensitivity(iso(NOW - 3 * H), NOW).hoursLeft + 3) < 1e-9)
})

/* ================================================================== *
 * computeScore
 * ================================================================== */

test('computeScore：满分（importance 5 / urgency 5 / 刚创建 / 1h 后到期）', () => {
  const result = computeScore(
    { importance: 5, urgency: 5, createdAt: iso(NOW), deadline: iso(NOW + H) },
    NOW,
  )
  assert.equal(result.score, 100)
  assert.equal(result.triage, 'now')
  assert.deepEqual(result.signals, {
    importance: 5,
    urgency: 5,
    freshness: 100,
    deadlinePressure: 100,
  })
})

test('computeScore：默认值（缺字段 → importance/urgency 3，freshness 100）', () => {
  const result = computeScore({}, NOW)
  // 0.45*3*20 + 0.35*3*20 + 0.20*100 = 27 + 21 + 20 = 68
  assert.equal(result.score, 68)
  assert.equal(result.triage, 'today')
  assert.equal(result.signals.importance, 3)
  assert.equal(result.signals.urgency, 3)
})

test('computeScore：低分（旧内容 + 无时效，地板 16 分）', () => {
  const result = computeScore(
    { importance: 1, urgency: 1, createdAt: iso(NOW - 30 * D) },
    NOW,
  )
  // 0.45*20 + 0.35*20 + 0.2*~0.055 ≈ 16.01 → 16
  assert.equal(result.score, 16)
  assert.equal(result.triage, 'later')
})

test('computeScore：clamp importance/urgency 到 1..5', () => {
  const result = computeScore(
    { importance: 9, urgency: 0, createdAt: iso(NOW), deadline: null },
    NOW,
  )
  assert.equal(result.signals.importance, 5)
  assert.equal(result.signals.urgency, 1)
  // 45 + 7 + 20 = 72
  assert.equal(result.score, 72)
})

test('computeScore：NaN / 非法 importance 降级为 3，不产生 NaN 分', () => {
  const result = computeScore(
    { importance: Number.NaN, urgency: 'not-a-number', createdAt: 'garbage' },
    NOW,
  )
  assert.equal(result.signals.importance, 3)
  assert.equal(result.signals.urgency, 3)
  assert.ok(Number.isFinite(result.score))
  assert.equal(result.score, 68)
})

test('computeScore：freshness 4 天约 37%、10 天约 8%（契约 §3.1）', () => {
  const fourDays = computeScore(
    { importance: 3, urgency: 3, createdAt: iso(NOW - 4 * D) },
    NOW,
  )
  assert.ok(Math.abs(fourDays.signals.freshness - 100 * Math.exp(-1)) < 1e-9)
  assert.ok(Math.abs(fourDays.signals.freshness - 36.7879) < 0.01)
  assert.equal(fourDays.score, 55)

  const tenDays = computeScore(
    { importance: 3, urgency: 3, createdAt: iso(NOW - 10 * D) },
    NOW,
  )
  assert.ok(Math.abs(tenDays.signals.freshness - 100 * Math.exp(-2.5)) < 1e-9)
  assert.ok(Math.abs(tenDays.signals.freshness - 8.2) < 0.1)
})

test('computeScore：createdAt 非法/未来 → ageHours 0、freshness 100', () => {
  const invalid = computeScore({ importance: 5, urgency: 5, createdAt: 'garbage' }, NOW)
  assert.equal(invalid.signals.freshness, 100)
  assert.equal(invalid.score, 100)
  const future = computeScore(
    { importance: 5, urgency: 5, createdAt: iso(NOW + 10 * D) },
    NOW,
  )
  assert.equal(future.signals.freshness, 100)
})

test('computeScore：done / archived 封顶 40 分且 triage 跟随状态', () => {
  const done = computeScore(
    {
      importance: 5,
      urgency: 5,
      createdAt: iso(NOW),
      deadline: iso(NOW + H),
      status: 'done',
    },
    NOW,
  )
  assert.equal(done.score, 40)
  assert.equal(done.triage, 'done')

  const archived = computeScore(
    {
      importance: 5,
      urgency: 5,
      createdAt: iso(NOW),
      deadline: iso(NOW + H),
      status: 'archived',
    },
    NOW,
  )
  assert.equal(archived.score, 40)
  assert.equal(archived.triage, 'archived')
})

test('computeScore：done 低分不被抬到 40', () => {
  const result = computeScore(
    { importance: 1, urgency: 1, createdAt: iso(NOW - 30 * D), status: 'done' },
    NOW,
  )
  assert.equal(result.score, 16)
  assert.equal(result.triage, 'done')
})

test('computeScore：expired 优先于分数（高分也进 expired 桶）', () => {
  const result = computeScore(
    {
      importance: 5,
      urgency: 5,
      createdAt: iso(NOW),
      deadline: iso(NOW - 2 * H),
    },
    NOW,
  )
  assert.equal(result.triage, 'expired')
  assert.equal(result.score, 100)
})

test('computeScore：triage 分数阈值（旧内容无 deadline，score = 9*i + 7*u）', () => {
  const cases = [
    [5, 5, 80, 'now'], // 80 >= 78
    [5, 4, 73, 'today'],
    [4, 4, 64, 'today'],
    [3, 5, 62, 'today'], // 62 恰好 >= 62
    [3, 4, 55, 'week'],
    [3, 3, 48, 'week'],
    [2, 4, 46, 'week'],
    [4, 1, 43, 'later'], // 43 < 45
    [2, 2, 32, 'later'],
  ]
  for (const [importance, urgency, expectedScore, expectedTriage] of cases) {
    const result = computeScore({ importance, urgency, createdAt: iso(NOW - 30 * D) }, NOW)
    assert.equal(result.score, expectedScore, `importance=${importance} urgency=${urgency}`)
    assert.equal(result.triage, expectedTriage, `importance=${importance} urgency=${urgency}`)
  }
})

test('computeScore：triage 时效压力阈值（低分内容靠 pressure 分桶）', () => {
  const cases = [
    [NOW + 3 * H, 'now', 100], // pressure 100 ≥ 85
    [NOW + 10 * H, 'now', 85], // pressure 85 ≥ 85
    [NOW + 48 * H, 'today', 65], // pressure 65 ≥ 65
    [NOW + 100 * H, 'week', 45], // pressure 45 ≥ 45
    [NOW + 200 * H, 'later', 25], // 25 < 45
    [NOW + 400 * H, 'later', 10],
  ]
  for (const [deadlineMs, expectedTriage, pressure] of cases) {
    const result = computeScore(
      {
        importance: 1,
        urgency: 1,
        createdAt: iso(NOW - 30 * D),
        deadline: iso(deadlineMs),
      },
      NOW,
    )
    assert.equal(result.signals.deadlinePressure, pressure)
    assert.equal(result.triage, expectedTriage, `deadline=${iso(deadlineMs)}`)
  }
})

test('computeScore：score 恒为 0..100 整数', () => {
  const statuses = ['inbox', 'queued', 'doing', 'done', 'archived']
  for (const importance of [1, 2, 3, 4, 5]) {
    for (const urgency of [1, 2, 3, 4, 5]) {
      for (const status of statuses) {
        const result = computeScore(
          {
            importance,
            urgency,
            status,
            createdAt: iso(NOW - Math.random() * 40 * D),
            deadline: Math.random() < 0.5 ? iso(NOW + (Math.random() * 30 - 5) * D) : null,
          },
          NOW,
        )
        assert.ok(Number.isInteger(result.score))
        assert.ok(result.score >= 0 && result.score <= 100)
        assert.ok(result.triage in TRIAGE_RANK)
      }
    }
  }
})

test('computeScore：空 / null 入参不抛错', () => {
  for (const bad of [null, undefined, 0, 'x', []]) {
    assert.doesNotThrow(() => computeScore(bad, NOW))
  }
})

/* ================================================================== *
 * deriveItem
 * ================================================================== */

test('deriveItem：输出 Item 全字段 + 派生字段', () => {
  const item = makeItem({
    kind: 'drama',
    title: '庆余年 第二季',
    site: '腾讯视频',
    tags: ['剧集', '腾讯视频'],
    status: 'doing',
    importance: 4,
    urgency: 5,
    deadline: iso(NOW + 10 * H),
    deadlineKind: 'release',
    createdAt: iso(NOW - D),
    ai: { classified: true, reason: '剧集', confidence: 0.9, at: iso(NOW) },
  })
  const view = deriveItem(item, NOW)

  // 原字段透传
  assert.equal(view.id, item.id)
  assert.equal(view.kind, 'drama')
  assert.equal(view.title, '庆余年 第二季')
  assert.equal(view.site, '腾讯视频')
  assert.deepEqual(view.tags, ['剧集', '腾讯视频'])
  assert.equal(view.status, 'doing')
  assert.equal(view.ai.classified, true)
  assert.equal(view.channel, 'manual')

  // 派生字段：0.45*4*20 = 36, 0.35*5*20 = 35, freshness(24h)≈77.88, pressure=85
  // → timePull=85 → 36 + 35 + 17 = 88
  assert.ok(Number.isInteger(view.score))
  assert.equal(view.score, 88)
  assert.equal(view.triage, 'now')
  assert.equal(view.kindLabel, '剧集')
  assert.ok(Math.abs(view.ageHours - 24) < 1e-9)
  assert.deepEqual(view.signals, {
    importance: 4,
    urgency: 5,
    freshness: 100 * Math.exp(-24 / 96),
    deadlinePressure: 85,
  })
  assert.deepEqual(view.timeSensitivity, { level: 'critical', hoursLeft: 10 })
  assert.equal(view.hasTimeSensitivity, true)
})

test('deriveItem：不修改入参（含嵌套对象也没被动过）', () => {
  const item = makeItem({
    tags: ['a', 'b'],
    ai: { classified: true, reason: 'x', confidence: 0.5, at: iso(NOW) },
  })
  const before = JSON.stringify(item)
  const view = deriveItem(item, NOW)
  assert.equal(JSON.stringify(item), before)
  assert.notEqual(view, item)
  assert.notEqual(view.tags, item.tags)
  // frozen 入参也可派生
  assert.doesNotThrow(() => deriveItem(Object.freeze(makeItem()), NOW))
})

test('deriveItem：缺失 / 非法字段安全降级', () => {
  const view = deriveItem({}, NOW)
  assert.equal(view.kind, 'other')
  assert.equal(view.kindLabel, '其他')
  assert.equal(view.status, 'inbox')
  assert.equal(view.importance, 3)
  assert.equal(view.urgency, 3)
  assert.deepEqual(view.tags, [])
  assert.equal(view.deadline, null)
  assert.equal(view.deadlineKind, 'none')
  assert.equal(view.score, 68)
  assert.equal(view.triage, 'today')
  assert.equal(view.ageHours, 0)
  assert.equal(view.ai.classified, false)
  assert.equal(view.ai.reason, null)
  assert.equal(view.ai.confidence, null)
  assert.equal(view.ai.at, null)
  assert.deepEqual(view.ai.fields, [])
  assert.deepEqual(view.timeSensitivity, { level: 'none', hoursLeft: null })
  assert.equal(view.hasTimeSensitivity, false)

  const weird = deriveItem(
    {
      kind: 'weird-kind',
      status: 'bogus',
      importance: 7,
      urgency: -2,
      tags: 'not-an-array',
      deadline: 'not-a-date',
      deadlineKind: 'release',
      ai: null,
      title: '',
      url: 'https://example.com/x',
    },
    NOW,
  )
  assert.equal(weird.kind, 'other')
  assert.equal(weird.kindLabel, '其他')
  assert.equal(weird.status, 'inbox')
  assert.equal(weird.importance, 5)
  assert.equal(weird.urgency, 1)
  assert.deepEqual(weird.tags, [])
  assert.equal(weird.deadline, null)
  assert.equal(weird.deadlineKind, 'none')
  assert.equal(weird.title, 'https://example.com/x')
  assert.equal(weird.ai.classified, false)

  for (const bad of [null, undefined, 0, 'x', []]) {
    assert.doesNotThrow(() => deriveItem(bad, NOW))
  }
})

test('deriveItem：过了 deadline 的条目 hasTimeSensitivity 仍为 true（level=expired）', () => {
  const view = deriveItem(makeItem({ deadline: iso(NOW - 2 * H) }), NOW)
  assert.equal(view.hasTimeSensitivity, true)
  assert.equal(view.timeSensitivity.level, 'expired')
  assert.equal(view.triage, 'expired')
})

test('deriveItem：deadline 归一化（number → ISO；非法 → null）', () => {
  const numeric = deriveItem(makeItem({ deadline: NOW + 3 * H, deadlineKind: 'deadline' }), NOW)
  assert.equal(numeric.deadline, iso(NOW + 3 * H))
  const invalid = deriveItem(makeItem({ deadline: 'nope', deadlineKind: 'release' }), NOW)
  assert.equal(invalid.deadline, null)
  assert.equal(invalid.deadlineKind, 'none')
})

test('deriveSnapshotView 是 deriveItem 的别名', () => {
  const item = makeItem()
  assert.deepEqual(deriveSnapshotView(item, NOW), deriveItem(item, NOW))
})

/* ================================================================== *
 * sortForQueue
 * ================================================================== */

test('sortForQueue：按 TRIAGE_RANK 分桶升序（expired → now → today → week → later → done → archived）', () => {
  const items = [
    makeItem({ id: 'later', importance: 2, urgency: 2 }),
    makeItem({ id: 'expired', deadline: iso(NOW - 2 * H) }),
    makeItem({ id: 'done', status: 'done', importance: 5, urgency: 5, createdAt: iso(NOW) }),
    makeItem({ id: 'archived', status: 'archived' }),
    makeItem({ id: 'week', importance: 3, urgency: 3 }),
    makeItem({ id: 'now', importance: 5, urgency: 5, createdAt: iso(NOW) }),
    makeItem({ id: 'today', importance: 4, urgency: 4 }),
  ]
  const sorted = sortForQueue(items, NOW)
  assert.deepEqual(
    sorted.map((item) => item.id),
    ['expired', 'now', 'today', 'week', 'later', 'done', 'archived'],
  )
  // 不修改入参数组顺序
  assert.deepEqual(
    items.map((item) => item.id),
    ['later', 'expired', 'done', 'archived', 'week', 'now', 'today'],
  )
})

test('sortForQueue：同桶都有 deadline → deadline 升序（更早在前）', () => {
  const later = makeItem({ id: 'a1', importance: 1, urgency: 1, deadline: iso(NOW + 5 * H) })
  const sooner = makeItem({ id: 'a2', importance: 1, urgency: 1, deadline: iso(NOW + 1 * H) })
  const sorted = sortForQueue([later, sooner], NOW)
  assert.deepEqual(
    sorted.map((item) => item.id),
    ['a2', 'a1'],
  )
})

test('sortForQueue：同桶都有时效时，deadline 相同时按 createdAt 降序', () => {
  const older = makeItem({ id: 'b1', createdAt: iso(NOW - 2 * D), deadline: iso(NOW + 3 * H) })
  const newer = makeItem({ id: 'b2', createdAt: iso(NOW - D), deadline: iso(NOW + 3 * H) })
  const sorted = sortForQueue([older, newer], NOW)
  assert.deepEqual(
    sorted.map((item) => item.id),
    ['b2', 'b1'],
  )
})

test('sortForQueue：同桶有 deadline 的排在无 deadline 的前面（即使分数更低）', () => {
  const noDeadline = makeItem({ id: 'high', importance: 5, urgency: 5, createdAt: iso(NOW) })
  const withDeadline = makeItem({
    id: 'with-deadline',
    importance: 1,
    urgency: 1,
    deadline: iso(NOW + 5 * H),
  })
  const sorted = sortForQueue([noDeadline, withDeadline], NOW)
  assert.deepEqual(
    sorted.map((item) => item.id),
    ['with-deadline', 'high'],
  )
})

test('sortForQueue：同桶都没 deadline → score 降序', () => {
  const low = makeItem({ id: 'low', importance: 1, urgency: 1 })
  const high = makeItem({ id: 'high', importance: 2, urgency: 2 })
  const sorted = sortForQueue([low, high], NOW)
  assert.deepEqual(
    sorted.map((item) => item.id),
    ['high', 'low'],
  )
})

test('sortForQueue：同桶没 deadline 且同分 → createdAt 降序', () => {
  const older = makeItem({ id: 'older', importance: 2, urgency: 2, createdAt: iso(NOW - 31 * D) })
  const newer = makeItem({ id: 'newer', importance: 2, urgency: 2, createdAt: iso(NOW - 30 * D) })
  const olderScore = computeScore(older, NOW).score
  const newerScore = computeScore(newer, NOW).score
  assert.equal(olderScore, newerScore) // 前提：同分
  const sorted = sortForQueue([older, newer], NOW)
  assert.deepEqual(
    sorted.map((item) => item.id),
    ['newer', 'older'],
  )
})

test('sortForQueue：空 / 非法入参安全', () => {
  assert.deepEqual(sortForQueue([], NOW), [])
  assert.deepEqual(sortForQueue(null, NOW), [])
  assert.deepEqual(sortForQueue('x', NOW), [])
})

/* ================================================================== *
 * countItems
 * ================================================================== */

test('countItems：空数组 → 全 0，byKind 覆盖 11 个 kind', () => {
  const counts = countItems([], NOW)
  assert.equal(counts.total, 0)
  assert.equal(counts.active, 0)
  assert.equal(counts.inbox, 0)
  assert.equal(counts.now, 0)
  assert.equal(counts.today, 0)
  assert.equal(counts.week, 0)
  assert.equal(counts.later, 0)
  assert.equal(counts.expired, 0)
  assert.equal(counts.done, 0)
  assert.equal(counts.archived, 0)
  assert.equal(counts.timeSensitive, 0)
  assert.deepEqual(Object.keys(counts.byKind).sort(), [...KINDS].sort())
  for (const kind of KINDS) assert.equal(counts.byKind[kind], 0)
})

test('countItems：契约 §6 口径（active / inbox / 分桶 / timeSensitive / byKind 只算 active）', () => {
  const counts = countItems(
    [
      makeItem({ id: 'i1', status: 'inbox', kind: 'xhs', importance: 5, urgency: 5, createdAt: iso(NOW) }),
      makeItem({
        id: 'i2',
        status: 'queued',
        kind: 'link',
        importance: 4,
        urgency: 4,
        deadline: iso(NOW + 100 * H),
      }),
      makeItem({ id: 'i3', status: 'doing', kind: 'drama', importance: 3, urgency: 3 }),
      makeItem({ id: 'i4', status: 'done', kind: 'product' }),
      makeItem({ id: 'i5', status: 'archived', kind: 'other' }),
    ],
    NOW,
  )
  assert.equal(counts.total, 5)
  assert.equal(counts.active, 3)
  assert.equal(counts.inbox, 1)
  assert.equal(counts.now, 1)
  assert.equal(counts.today, 1)
  assert.equal(counts.week, 1)
  assert.equal(counts.later, 0)
  assert.equal(counts.expired, 0)
  assert.equal(counts.done, 1)
  assert.equal(counts.archived, 1)
  assert.equal(counts.timeSensitive, 1)
  assert.equal(counts.byKind.xhs, 1)
  assert.equal(counts.byKind.link, 1)
  assert.equal(counts.byKind.drama, 1)
  // done / archived 不计入 byKind
  assert.equal(counts.byKind.product, 0)
  assert.equal(counts.byKind.other, 0)
})

test('countItems：expired 的 active 计入 expired 与 timeSensitive，不计入 now', () => {
  const counts = countItems(
    [
      makeItem({ id: 'e1', status: 'queued', deadline: iso(NOW - 2 * H) }),
      makeItem({ id: 'e2', status: 'inbox', deadline: iso(NOW - 30 * H) }),
    ],
    NOW,
  )
  assert.equal(counts.active, 2)
  assert.equal(counts.inbox, 1)
  assert.equal(counts.expired, 2)
  assert.equal(counts.now, 0)
  assert.equal(counts.timeSensitive, 2)
})

test('countItems：非法入参 / 脏数据不抛错', () => {
  assert.doesNotThrow(() => countItems(null, NOW))
  const counts = countItems([null, undefined, 0, 'x', makeItem({ id: 'ok' })], NOW)
  assert.equal(counts.total, 1)
  assert.equal(counts.active, 1)
})

/* ================================================================== *
 * extractUrls
 * ================================================================== */

test('extractUrls：去重、保序、剔除中文收尾标点', () => {
  assert.deepEqual(extractUrls('看这个 https://b23.tv/abc，好看'), ['https://b23.tv/abc'])
  assert.deepEqual(extractUrls('（https://a.example.com/x）和 https://b.example.com/y。'), [
    'https://a.example.com/x',
    'https://b.example.com/y',
  ])
  assert.deepEqual(extractUrls('https://a.example.com/x https://a.example.com/x'), [
    'https://a.example.com/x',
  ])
  assert.deepEqual(extractUrls('https://a.example.com/x. 以及'), ['https://a.example.com/x'])
  assert.deepEqual(extractUrls('[标题](https://a.example.com/x)'), ['https://a.example.com/x'])
})

test('extractUrls：www / 多协议 / 带 query、顺序稳定', () => {
  assert.deepEqual(extractUrls('www.example.com/path'), ['www.example.com/path'])
  const text =
    'https://b23.tv/1 和 www.bilibili.com/video/BV2，再来一次 https://b23.tv/1 '
  assert.deepEqual(extractUrls(text), ['https://b23.tv/1', 'www.bilibili.com/video/BV2'])
  assert.deepEqual(extractUrls('https://item.taobao.com/item.htm?id=1&spm=a.b'), [
    'https://item.taobao.com/item.htm?id=1&spm=a.b',
  ])
})

test('extractUrls：无链接 / 非法入参 → []', () => {
  assert.deepEqual(extractUrls('今天天气不错'), [])
  assert.deepEqual(extractUrls(''), [])
  assert.deepEqual(extractUrls(null), [])
  assert.deepEqual(extractUrls(undefined), [])
  assert.deepEqual(extractUrls(123), [])
  assert.deepEqual(extractUrls({}), [])
})

/* ================================================================== *
 * parseDeadlineFromText
 * ================================================================== */

test('parseDeadlineFromText：YYYY-MM-DD + HH:mm + 开播 → release', () => {
  const result = parseDeadlineFromText('2026-05-16 20:30 开播', NOW)
  assert.equal(result.deadlineKind, 'release')
  assert.deepEqual(localParts(result.deadline), { y: 2026, mo: 5, d: 16, hh: 20, mi: 30, s: 0 })
})

test('parseDeadlineFromText：YYYY年M月D日 + HH:mm → release', () => {
  const result = parseDeadlineFromText('2026年5月16日 20:30 开播', NOW)
  assert.equal(result.deadlineKind, 'release')
  assert.deepEqual(localParts(result.deadline), { y: 2026, mo: 5, d: 16, hh: 20, mi: 30, s: 0 })
})

test('parseDeadlineFromText：只有日期 → 当天 23:59:59 截止', () => {
  const result = parseDeadlineFromText('2026-05-16 开播', NOW)
  assert.equal(result.deadlineKind, 'release')
  assert.deepEqual(localParts(result.deadline), { y: 2026, mo: 5, d: 16, hh: 23, mi: 59, s: 59 })
})

test('parseDeadlineFromText：YYYY/MM/DD + T 时间 + 上映', () => {
  const result = parseDeadlineFromText('2026/05/16T20:00 上映', NOW)
  assert.equal(result.deadlineKind, 'release')
  assert.deepEqual(localParts(result.deadline), { y: 2026, mo: 5, d: 16, hh: 20, mi: 0, s: 0 })
})

test('parseDeadlineFromText：MM月DD日，缺年份按当年', () => {
  const march = Date.parse('2026-03-01T08:00:00Z')
  const result = parseDeadlineFromText('5月16日 20:00 上映', march)
  assert.equal(result.deadlineKind, 'release')
  assert.deepEqual(localParts(result.deadline), { y: 2026, mo: 5, d: 16, hh: 20, mi: 0, s: 0 })
})

test('parseDeadlineFromText：缺年份且已过去超过 30 天 → 按明年', () => {
  const result = parseDeadlineFromText('5月16日 开播', NOW) // NOW = 2026-11-06
  assert.equal(result.deadlineKind, 'release')
  assert.deepEqual(localParts(result.deadline), { y: 2027, mo: 5, d: 16, hh: 23, mi: 59, s: 59 })

  const january = parseDeadlineFromText('1月5日 截止', NOW)
  assert.equal(january.deadlineKind, 'expiry')
  assert.equal(localParts(january.deadline).y, 2027)
})

test('parseDeadlineFromText：缺年份但刚过去（≤30 天）→ 保持当年', () => {
  const june = Date.parse('2026-06-01T08:00:00Z')
  const result = parseDeadlineFromText('5月20日 截止', june)
  assert.equal(result.deadlineKind, 'expiry')
  assert.equal(localParts(result.deadline).y, 2026)
})

test('parseDeadlineFromText：MM-DD，缺年份推断', () => {
  const result = parseDeadlineFromText('6-1 截止', NOW)
  assert.equal(result.deadlineKind, 'expiry')
  assert.deepEqual(localParts(result.deadline), { y: 2027, mo: 6, d: 1, hh: 23, mi: 59, s: 59 })

  const march = Date.parse('2026-03-01T08:00:00Z')
  const future = parseDeadlineFromText('5-16 开播', march)
  assert.equal(localParts(future.deadline).y, 2026)
})

test('parseDeadlineFromText：12 月 31 日在年内不算过期', () => {
  const result = parseDeadlineFromText('12月31日 截止', NOW)
  assert.equal(result.deadlineKind, 'expiry')
  assert.equal(localParts(result.deadline).y, 2026, '应为 2026-12-31（未来），不推到 2027')
})

test('parseDeadlineFromText：显式年份不因过期改年', () => {
  const result = parseDeadlineFromText('2023-01-01 截止', NOW)
  assert.equal(result.deadlineKind, 'expiry')
  assert.equal(localParts(result.deadline).y, 2023)
})

test('parseDeadlineFromText：deadlineKind 关键词优先级（开播 > 更新 > 截止 > 活动）', () => {
  assert.equal(parseDeadlineFromText('2026-05-16 开播 截止', NOW).deadlineKind, 'release')
  assert.equal(parseDeadlineFromText('2026-05-16 第3集更新', NOW).deadlineKind, 'airing')
  assert.equal(parseDeadlineFromText('2026-05-16 每周三更新', NOW).deadlineKind, 'airing')
  assert.equal(parseDeadlineFromText('2026-05-16 活动 演出', NOW).deadlineKind, 'event')
  assert.equal(parseDeadlineFromText('2026-05-16 直播', NOW).deadlineKind, 'event')
  assert.equal(parseDeadlineFromText('2026-05-16 截止 报名', NOW).deadlineKind, 'expiry')
  assert.equal(parseDeadlineFromText('2026-05-16 提醒我', NOW).deadlineKind, 'deadline')
})

test('parseDeadlineFromText：解析不出日期 → null / none（不瞎猜）', () => {
  const none = { deadline: null, deadlineKind: 'none' }
  assert.deepEqual(parseDeadlineFromText('今天截止', NOW), none)
  assert.deepEqual(parseDeadlineFromText('明天开播', NOW), none)
  assert.deepEqual(parseDeadlineFromText('每周三更新', NOW), none)
  assert.deepEqual(parseDeadlineFromText('限时优惠', NOW), none)
  assert.deepEqual(parseDeadlineFromText('2026-02-30 截止', NOW), none) // 非法日期
  assert.deepEqual(parseDeadlineFromText('', NOW), none)
  assert.deepEqual(parseDeadlineFromText(null, NOW), none)
  assert.deepEqual(parseDeadlineFromText(123, NOW), none)
})

test('parseDeadlineFromText：URL 路径里的日期不会被误判', () => {
  assert.deepEqual(parseDeadlineFromText('https://example.com/2026/05/16/post', NOW), {
    deadline: null,
    deadlineKind: 'none',
  })
})

/* ================================================================== *
 * heuristicExtract
 * ================================================================== */

test('heuristicExtract：纯 URL → 平台 kind/site，title 用域名，默认值符合契约', () => {
  const result = heuristicExtract({ url: 'https://item.taobao.com/item.htm?id=1' }, NOW)
  assert.equal(result.url, 'https://item.taobao.com/item.htm?id=1')
  assert.equal(result.title, 'item.taobao.com')
  assert.equal(result.kind, 'product')
  assert.equal(result.site, '淘宝')
  assert.equal(result.importance, 3)
  assert.equal(result.urgency, 2)
  assert.equal(result.deadline, null)
  assert.equal(result.deadlineKind, 'none')
  assert.equal(result.durationMin, 5)
  assert.deepEqual(result.tags, ['淘宝'])
})

test('heuristicExtract：文本里带 URL 时自动抓取（url 缺省）', () => {
  const result = heuristicExtract(
    { text: '这个视频不错 https://www.bilibili.com/video/BV1xx' },
    NOW,
  )
  assert.equal(result.url, 'https://www.bilibili.com/video/BV1xx')
  assert.equal(result.kind, 'bilibili')
  assert.equal(result.site, 'B站')
  assert.equal(result.title, '这个视频不错')
})

test('heuristicExtract：72h 内的 deadline → urgency ≥ 4', () => {
  const result = heuristicExtract({ text: '2026-11-07 20:00 截止' }, NOW)
  assert.equal(result.urgency, 4)
  assert.equal(result.deadlineKind, 'expiry')
  assert.deepEqual(localParts(result.deadline), { y: 2026, mo: 11, d: 7, hh: 20, mi: 0, s: 0 })
})

test('heuristicExtract：deadline 很远且无关键动词 → urgency 2', () => {
  const result = heuristicExtract({ text: '2026-12-01 20:00' }, NOW)
  assert.equal(result.urgency, 2)
  assert.equal(result.deadlineKind, 'deadline')
})

test('heuristicExtract：今天/今晚/明天/限时/截止/开播 → urgency ≥ 3', () => {
  assert.equal(heuristicExtract({ text: '今晚看看这个' }, NOW).urgency, 3)
  assert.equal(heuristicExtract({ text: '明天限时抢购' }, NOW).urgency, 3)
  assert.equal(heuristicExtract({ text: '随便看看' }, NOW).urgency, 2)
})

test('heuristicExtract：剧集识别（关键词 + 平台词）→ drama', () => {
  const march = Date.parse('2026-03-01T08:00:00Z')
  const result = heuristicExtract({ text: '《庆余年》腾讯视频 5月16日 开播' }, march)
  assert.equal(result.kind, 'drama')
  assert.equal(result.site, '腾讯视频')
  assert.equal(result.deadlineKind, 'release')
  assert.deepEqual(localParts(result.deadline), { y: 2026, mo: 5, d: 16, hh: 23, mi: 59, s: 59 })
  assert.ok(result.tags.includes('剧集'))
})

test('heuristicExtract：无 URL 的「剧名：xxx」/「想看」意图 → drama', () => {
  const named = heuristicExtract({ text: '剧名：庆余年' }, NOW)
  assert.equal(named.kind, 'drama')
  assert.equal(named.title, '剧名：庆余年')
  const want = heuristicExtract({ text: '想看这个' }, NOW)
  assert.equal(want.kind, 'drama')
})

test('heuristicExtract：有 URL 时剧集文本仍判定 drama（site 取平台名）', () => {
  const result = heuristicExtract(
    { url: 'https://www.xiaohongshu.com/explore/abc', text: '腾讯视频 5月16日 开播' },
    Date.parse('2026-03-01T08:00:00Z'),
  )
  assert.equal(result.kind, 'drama')
  assert.equal(result.site, '腾讯视频')
})

test('heuristicExtract：空 / 非法入参安全降级', () => {
  for (const bad of [null, undefined, 0, 'x', []]) {
    assert.doesNotThrow(() => heuristicExtract(bad, NOW))
  }
  const result = heuristicExtract(null, NOW)
  assert.equal(result.kind, 'other')
  assert.equal(result.title, null)
  assert.equal(result.url, null)
  assert.equal(result.importance, 3)
  assert.equal(result.urgency, 2)
  assert.equal(result.deadline, null)
  assert.equal(result.deadlineKind, 'none')
  assert.equal(result.durationMin, 5)
  assert.deepEqual(result.tags, [])

  const weird = heuristicExtract({ url: 123, text: null, title: {} }, NOW)
  assert.equal(weird.kind, 'other')
  assert.equal(weird.url, null)
})

test('heuristicExtract：标题截断到 120 字', () => {
  const longTitle = '标'.repeat(200)
  const result = heuristicExtract({ title: longTitle, url: 'https://b23.tv/abc' }, NOW)
  assert.equal(Array.from(result.title).length, 120)
})

test('heuristicExtract：also accepts input.nowMs', () => {
  const result = heuristicExtract({
    text: '2026-11-07 20:00 截止',
    nowMs: NOW,
  })
  assert.equal(result.urgency, 4)
})

/* ================================================================== *
 * heuristicImportText
 * ================================================================== */

test('heuristicImportText：多链接 → 每个 URL 一个候选，title 取 URL 前后文本行', () => {
  const text = [
    '机械键盘推荐',
    'https://item.taobao.com/item.htm?id=1',
    '小红书笔记 https://www.xiaohongshu.com/explore/abc',
  ].join('\n')
  const candidates = heuristicImportText(text, NOW)
  assert.equal(candidates.length, 2)

  assert.equal(candidates[0].url, 'https://item.taobao.com/item.htm?id=1')
  assert.equal(candidates[0].title, '机械键盘推荐')
  assert.equal(candidates[0].kind, 'product')
  assert.equal(candidates[0].site, '淘宝')

  assert.equal(candidates[1].url, 'https://www.xiaohongshu.com/explore/abc')
  assert.equal(candidates[1].title, '小红书笔记')
  assert.equal(candidates[1].kind, 'xhs')
  assert.equal(candidates[1].site, '小红书')

  for (const candidate of candidates) {
    for (const key of [
      'title',
      'url',
      'kind',
      'site',
      'importance',
      'urgency',
      'deadline',
      'deadlineKind',
      'tags',
    ]) {
      assert.ok(Object.prototype.hasOwnProperty.call(candidate, key), `候选缺少 ${key}`)
    }
    assert.equal(typeof candidate.title, 'string')
    assert.ok(candidate.title.length > 0)
    assert.ok(KINDS.includes(candidate.kind))
    assert.ok(Array.isArray(candidate.tags))
  }
})

test('heuristicImportText：同一行多个 URL 各自取相邻片段做标题', () => {
  const text = '晚上看这个 https://www.bilibili.com/video/BV1xx 还有 https://example.com/a'
  const candidates = heuristicImportText(text, NOW)
  assert.equal(candidates.length, 2)
  assert.equal(candidates[0].title, '晚上看这个')
  assert.equal(candidates[0].kind, 'bilibili')
  assert.equal(candidates[1].title, '还有')
  assert.equal(candidates[1].kind, 'link')
})

test('heuristicImportText：URL 独占一行时用相邻行做标题', () => {
  const previous = heuristicImportText('某视频标题\nhttps://v.douyin.com/abc/', NOW)
  assert.equal(previous.length, 1)
  assert.equal(previous[0].title, '某视频标题')
  assert.equal(previous[0].kind, 'douyin')
  assert.equal(previous[0].site, '抖音')

  const next = heuristicImportText('https://b23.tv/abc\n【好看的视频】', NOW)
  assert.equal(next.length, 1)
  assert.equal(next[0].title, '【好看的视频】')
})

test('heuristicImportText：URL 前后都没文字 → 用 URL 域名', () => {
  const candidates = heuristicImportText('https://www.bilibili.com/video/BV1xx', NOW)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].title, 'bilibili.com')
})

test('heuristicImportText：重复 URL 去重 → 只生成一个候选', () => {
  const candidates = heuristicImportText('https://b23.tv/abc 再来一次 https://b23.tv/abc', NOW)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].url, 'https://b23.tv/abc')
})

test('heuristicImportText：无 URL 的纯文本 → 单个 kind:other 候选（title 首行）', () => {
  const candidates = heuristicImportText('今天看到一只猫\n特别可爱', NOW)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].url, null)
  assert.equal(candidates[0].kind, 'other')
  assert.equal(candidates[0].site, null)
  assert.equal(candidates[0].title, '今天看到一只猫')
  assert.equal(candidates[0].importance, 3)
})

test('heuristicImportText：纯文本按契约固定 kind:other（即使文本像剧名）', () => {
  const candidates = heuristicImportText('剧名：某部新剧', NOW)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].kind, 'other')
})

test('heuristicImportText：空文本 / 非法入参 → []', () => {
  assert.deepEqual(heuristicImportText('', NOW), [])
  assert.deepEqual(heuristicImportText('   ', NOW), [])
  assert.deepEqual(heuristicImportText('\n\n', NOW), [])
  assert.deepEqual(heuristicImportText(null, NOW), [])
  assert.deepEqual(heuristicImportText(undefined, NOW), [])
  assert.deepEqual(heuristicImportText(123, NOW), [])
  assert.deepEqual(heuristicImportText({}, NOW), [])
})

test('heuristicImportText：纯文本标题截断到 120 字', () => {
  const candidates = heuristicImportText('长'.repeat(200), NOW)
  assert.equal(candidates.length, 1)
  assert.equal(Array.from(candidates[0].title).length, 120)
})

test('heuristicImportText：接受 { text } 对象入参', () => {
  const candidates = heuristicImportText({ text: 'https://b23.tv/abc', nowMs: NOW })
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].kind, 'bilibili')
})

test('heuristicImportText：候选会读取 URL 周围文本的 deadline', () => {
  const text = ['2026-11-20 截止的优惠', 'https://item.taobao.com/item.htm?id=1'].join('\n')
  const candidates = heuristicImportText(text, NOW)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].deadlineKind, 'expiry')
  assert.ok(candidates[0].deadline)
  assert.deepEqual(localParts(candidates[0].deadline), {
    y: 2026,
    mo: 11,
    d: 20,
    hh: 23,
    mi: 59,
    s: 59,
  })
})
