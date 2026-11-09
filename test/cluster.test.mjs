/**
 * Pure-logic tests for the watch-later similarity clustering engine.
 *
 *   node --test test/cluster.test.mjs
 *
 * No network, no filesystem, no timers: only cluster.js and node:assert.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as cluster from '../cluster.js'

const { normalizeTitle, titleSimilarity, itemSimilarity, pickRepresentative, buildClusters } = cluster

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

const CREATED_DEFAULT = '2026-11-01T00:00:00.000Z'

function makeItem(id, title, extra = {}) {
  return {
    id,
    title,
    url: `https://example.com/${id}`,
    kind: 'article',
    status: 'queued',
    site: '微信公众号',
    tags: [],
    importance: 3,
    urgency: 3,
    score: 50,
    createdAt: CREATED_DEFAULT,
    ...extra,
  }
}

function sortedIds(ids) {
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/** Reference union-find over itemSimilarity >= 0.55, used to cross-check buildClusters. */
function expectedClusterSets(items) {
  const parent = items.map((_, index) => index)
  const find = (index) => (parent[index] === index ? index : (parent[index] = find(parent[index])))
  const union = (a, b) => {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) parent[rootB] = rootA
  }
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      if (itemSimilarity(items[i], items[j]) >= 0.55) union(i, j)
    }
  }
  const buckets = new Map()
  items.forEach((item, index) => {
    const root = find(index)
    if (!buckets.has(root)) buckets.set(root, [])
    buckets.get(root).push(item.id)
  })
  return [...buckets.values()]
    .filter((ids) => ids.length >= 2)
    .map(sortedIds)
    .sort((a, b) => (a.join('|') < b.join('|') ? -1 : 1))
}

/* ------------------------------------------------------------------ *
 * exports — CONTRACT §13.2 public surface
 * ------------------------------------------------------------------ */

test('exports exactly the five contract functions', () => {
  assert.deepEqual(Object.keys(cluster).sort(), [
    'buildClusters',
    'itemSimilarity',
    'normalizeTitle',
    'pickRepresentative',
    'titleSimilarity',
  ])
  for (const name of Object.keys(cluster)) assert.equal(typeof cluster[name], 'function', name)
})

/* ------------------------------------------------------------------ *
 * normalizeTitle
 * ------------------------------------------------------------------ */

test('normalizeTitle strips editorial labels, brackets, years, numbers and punctuation', () => {
  assert.equal(
    normalizeTitle('【收藏】深度｜OpenAI 发布 GPT-5，能力大幅提升！'),
    'openai发布gpt能力大幅提升',
  )
  assert.equal(normalizeTitle('2024年 年度总结（建议收藏）'), '年度总结')
  assert.equal(normalizeTitle('[干货] 减脂餐一周不重样'), '减脂餐一周不重样')
  assert.equal(normalizeTitle('[独家] 苹果发布会全程回顾 [完整版]'), '苹果发布会全程回顾')
  assert.equal(normalizeTitle('GPT-5 发布'), 'gpt发布')
  assert.equal(normalizeTitle('收藏！这10个技巧太实用了'), '这个技巧太实用了')
})

test('normalizeTitle keeps real topic words that merely look like labels', () => {
  // 「深度」「推荐」「解析」「分享」here are part of the topic, not labels.
  assert.equal(normalizeTitle('深度学习入门'), '深度学习入门')
  assert.equal(normalizeTitle('推荐系统实践'), '推荐系统实践')
  assert.equal(normalizeTitle('解析几何讲义'), '解析几何讲义')
  assert.equal(normalizeTitle('分享经济报告'), '分享经济报告')
})

test('normalizeTitle is defensive about bad input', () => {
  assert.equal(normalizeTitle(''), '')
  assert.equal(normalizeTitle('   '), '')
  assert.equal(normalizeTitle('!!!???'), '')
  assert.equal(normalizeTitle(undefined), '')
  assert.equal(normalizeTitle(null), '')
  assert.equal(normalizeTitle(123), '')
  assert.equal(normalizeTitle({}), '')
  assert.equal(normalizeTitle([]), '')
})

/* ------------------------------------------------------------------ *
 * titleSimilarity — bigram-based control group with realistic Chinese titles
 * ------------------------------------------------------------------ */

const SAME_TOPIC_PAIRS = [
  // the pair named in the task: same event, different wording
  ['深度｜OpenAI 发布 GPT-5，能力大幅提升', 'OpenAI GPT-5 正式发布：能力全面提升'],
  ['OpenAI 正式发布 GPT-5：能力全面提升', 'GPT-5 来了！OpenAI 发布，能力大幅提升'],
  ['【4K】黑神话悟空 全流程攻略 P1', '黑神话：悟空全流程攻略（第一期）'],
  ['一文读懂 RAG：原理、实现与优化', '一文读懂RAG（建议收藏）'],
  ['打工人减脂餐｜一周不重样', '打工人减脂餐，一周不重样（附食谱）'],
  ['《沙丘3》定档2027年3月！', '沙丘3 正式定档 2027年3月上映'],
  ['苹果 2025 秋季发布会全记录', '2025苹果秋季发布会：全程回顾'],
  ['小红书爆款标题模板', '小红书爆款标题模板（完整版）'],
  ['影之刃零 支线攻略 断魂崖', '影之刃零支线攻略：断魂崖篇'],
  ['Dota2 7.35 版本更新日志', 'Dota2 7.35 版本更新说明'],
  ['原神4.0版本前瞻直播汇总', '原神 4.0 前瞻直播内容汇总'],
  ['小米 SU7 首批车主提车体验', '小米SU7提车作业：首批车主真实体验'],
  ['GitHub Copilot 免费版上线', 'GitHub Copilot 免费版正式上线啦'],
  ['如何在 macOS 上安装 DeepSeek', 'macOS 安装 DeepSeek 教程（图文）'],
  ['周杰伦新歌《太阳之子》MV', '周杰伦 太阳之子 MV 首发'],
]

const DIFFERENT_TOPIC_PAIRS = [
  // the pair named in the task: completely unrelated
  ['影之刃零会断支线攻略', 'Dota2 英雄胜率'],
  ['OpenAI 发布 GPT-5', 'OpenAI 宣布裁员 3000 人'],
  ['原神 4.0 版本前瞻直播汇总', '原神 4.0 版本攻略：新角色培养'],
  ['Dota2 7.35 版本更新日志', 'Dota2 英雄胜率'],
  ['如何评价 2025 年新能源汽车价格战', '新能源汽车电池保养全攻略'],
  ['小红书爆款标题模板', '小红书运营涨粉技巧'],
  ['黑神话悟空 全boss打法', '黑神话悟空 剧情解析'],
  ['Apple Watch 健身记录技巧', 'Apple Watch 表带选购指南'],
  ['GPT-5 发布会直播', 'GPT-4o 图像能力实测'],
  ['DeepSeek V3 本地部署教程', 'DeepSeek 公司招聘信息'],
]

test('titleSimilarity: same topic phrased differently scores >= 0.55', () => {
  for (const [a, b] of SAME_TOPIC_PAIRS) {
    const score = titleSimilarity(a, b)
    assert.ok(score >= 0.55, `${a} <> ${b} => ${score.toFixed(4)}`)
  }
})

test('titleSimilarity: unrelated topics stay below 0.55', () => {
  for (const [a, b] of DIFFERENT_TOPIC_PAIRS) {
    const score = titleSimilarity(a, b)
    assert.ok(score < 0.55, `${a} <> ${b} => ${score.toFixed(4)}`)
  }
})

test('titleSimilarity: edge cases and symmetry', () => {
  assert.equal(titleSimilarity('', ''), 0)
  assert.equal(titleSimilarity('', '苹果发布会'), 0)
  assert.equal(titleSimilarity(undefined, null), 0)
  assert.equal(titleSimilarity('苹果发布会', '苹果发布会'), 1)
  // Same title, different decoration -> same normalized title.
  assert.equal(titleSimilarity('OpenAI GPT-5 发布', 'openai gpt 发布'), 1)
  for (const [a, b] of SAME_TOPIC_PAIRS) {
    assert.ok(Math.abs(titleSimilarity(a, b) - titleSimilarity(b, a)) < 1e-12)
  }
  // Unrelated pair scores far lower than a true paraphrase.
  assert.ok(titleSimilarity('苹果发布会', '苹果手机') < titleSimilarity('苹果 2025 秋季发布会全记录', '2025苹果秋季发布会：全程回顾'))
})

test('titleSimilarity: different editions of one product are kept apart', () => {
  const cases = [
    ['iPhone 17 评测：值得买吗', 'iPhone 16 评测：值得买吗'],
    ['Dota2 7.35 版本更新日志', 'Dota2 7.34 版本更新日志'],
    ['B站 2025 百大 UP 主名单公布', 'B站 2024 百大 UP 主名单'],
    ['某某综艺 第一季', '某某综艺 第二季'],
    ['黑神话悟空攻略 P1', '黑神话悟空攻略 P2'],
    ['GPT-5 发布会直播', 'GPT-4o 图像能力实测'],
  ]
  for (const [a, b] of cases) {
    const score = titleSimilarity(a, b)
    assert.ok(score < 0.55, `${a} <> ${b} => ${score.toFixed(4)}`)
  }
  // Same edition via different notation is not a conflict.
  assert.ok(titleSimilarity('某某综艺 第一季', '某某综艺 第1季') >= 0.55)
  assert.ok(titleSimilarity('黑神话悟空攻略 第一期', '黑神话悟空攻略 第1集') >= 0.55)
})

/* ------------------------------------------------------------------ *
 * itemSimilarity
 * ------------------------------------------------------------------ */

test('itemSimilarity: title + same-site + tag bonuses, clamped to 1', () => {
  const titleA = '深度｜OpenAI 发布 GPT-5，能力大幅提升'
  const titleB = 'OpenAI GPT-5 正式发布：能力全面提升'
  const base = titleSimilarity(titleA, titleB)

  const differentSites = itemSimilarity(
    { title: titleA, site: '微信公众号', tags: [] },
    { title: titleB, site: 'B站', tags: [] },
  )
  assert.ok(Math.abs(differentSites - base) < 1e-12)

  const sameSite = itemSimilarity(
    { title: titleA, site: '微信公众号', tags: [] },
    { title: titleB, site: '微信公众号 ', tags: [] },
  )
  assert.ok(Math.abs(sameSite - Math.min(1, base + 0.1)) < 1e-12)

  const withTags = itemSimilarity(
    { title: titleA, site: 'B站', tags: ['AI', 'GPT'] },
    { title: titleB, site: 'b站', tags: ['ai', 'gpt', 'openai'] },
  )
  // +0.1 site, +0.1 for two shared tags (tag case/whitespace normalized).
  assert.ok(Math.abs(withTags - Math.min(1, base + 0.1 + 0.1)) < 1e-12)

  const identical = itemSimilarity(
    { title: '同一篇内容', site: 'B站', tags: ['a'] },
    { title: '同一篇内容', site: 'B站', tags: ['a'] },
  )
  assert.equal(identical, 1)
})

test('itemSimilarity: version conflict cap and dirty input', () => {
  const conflict = itemSimilarity(
    { title: 'iPhone 17 评测', site: 'B站', tags: ['数码', '手机'] },
    { title: 'iPhone 16 评测', site: 'B站', tags: ['数码', '手机'] },
  )
  assert.ok(conflict <= 0.5, `version conflict => ${conflict}`)
  assert.equal(itemSimilarity(null, undefined), 0)
  assert.equal(itemSimilarity({}, {}), 0)
  assert.equal(itemSimilarity({ title: 42 }, { title: null }), 0)
  // Duplicate tags must not be counted twice.
  const dupTags = itemSimilarity(
    { title: '甲', site: '', tags: ['x', 'x', 'X'] },
    { title: '甲', site: '', tags: ['x'] },
  )
  assert.equal(dupTags, 1)
})

/* ------------------------------------------------------------------ *
 * pickRepresentative
 * ------------------------------------------------------------------ */

test('pickRepresentative: highest score wins when the gap is >= 3', () => {
  assert.equal(
    pickRepresentative([
      { id: 'low', score: 60 },
      { id: 'high', score: 90 },
    ]),
    'high',
  )
  assert.equal(
    pickRepresentative([
      { id: 'link', score: 90, kind: 'link' },
      { id: 'article', score: 80, kind: 'article' },
    ]),
    'link',
  )
})

test('pickRepresentative: close scores prefer wechat/article, then newest createdAt', () => {
  assert.equal(
    pickRepresentative([
      { id: 'link', score: 90, kind: 'link' },
      { id: 'article', score: 88, kind: 'article' },
    ]),
    'article',
  )
  assert.equal(
    pickRepresentative([
      { id: 'old-wechat', score: 90, kind: 'wechat', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'new-article', score: 88, kind: 'article', createdAt: '2026-02-01T00:00:00.000Z' },
    ]),
    'new-article',
  )
  assert.equal(
    pickRepresentative([
      { id: 'old', score: 90, kind: 'wechat', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'new', score: 89, kind: 'wechat', createdAt: '2026-02-01T00:00:00.000Z' },
    ]),
    'new',
  )
})

test('pickRepresentative: falls back to importance/urgency when score is missing', () => {
  assert.equal(
    pickRepresentative([
      { id: 'low', importance: 1, urgency: 1 },
      { id: 'high', importance: 5, urgency: 5 },
    ]),
    'high',
  )
  // An explicit score always beats the local estimate:
  // 45 > 40 wins even though the "high-estimate" item would score 100 if the
  // estimate were used instead of the real score.
  assert.equal(
    pickRepresentative([
      { id: 'high-estimate', score: 40, importance: 5, urgency: 5 },
      { id: 'low-estimate', score: 45, importance: 1, urgency: 1 },
    ]),
    'low-estimate',
  )
})

test('pickRepresentative: defensive about empty / malformed member lists', () => {
  assert.equal(pickRepresentative([]), '')
  assert.equal(pickRepresentative(null), '')
  assert.equal(pickRepresentative(undefined), '')
  assert.equal(pickRepresentative([null, 42, 'x', {}, { title: 'no id' }]), '')
  // Deterministic tie-break by id.
  assert.equal(
    pickRepresentative([
      { id: 'b', score: 50, kind: 'article' },
      { id: 'a', score: 50, kind: 'article' },
    ]),
    'a',
  )
})

/* ------------------------------------------------------------------ *
 * buildClusters — filters, transitivity, ordering, hiddenIds
 * ------------------------------------------------------------------ */

test('buildClusters: returns the contract shape for empty and invalid input', () => {
  for (const input of [undefined, null, 42, 'items', {}, []]) {
    assert.deepEqual(buildClusters(input), { groups: [], hiddenIds: [] })
  }
})

test('buildClusters: transitive merge (A~B, B~C) forms one group', () => {
  const items = [
    makeItem('a1', '深度｜OpenAI 发布 GPT-5，能力大幅提升', { site: '站A', score: 70 }),
    makeItem('a2', 'OpenAI GPT-5 正式发布：能力全面提升', { site: '站B', score: 90 }),
    makeItem('a3', 'GPT-5 来了！OpenAI 发布，能力大幅提升', { site: '站C', score: 60 }),
    makeItem('u1', '今天天气不错', { site: '站A' }),
    makeItem('u2', '周末去哪儿玩', { site: '站B' }),
  ]
  const { groups, hiddenIds } = buildClusters(items)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].size, 3)
  assert.deepEqual(groups[0].memberIds, ['a1', 'a2', 'a3'])
  // a2 has the top score (90 vs 70/60) so it is the representative.
  assert.equal(groups[0].representativeId, 'a2')
  assert.deepEqual(hiddenIds, ['a1', 'a3'])
  assert.ok(!hiddenIds.includes('a2'))
})

test('buildClusters: kind filter excludes image/drama/product/other/douyin and keeps content kinds', () => {
  const excludedKinds = ['image', 'drama', 'product', 'other', 'douyin']
  const excluded = excludedKinds.flatMap((kind) => [
    makeItem(`${kind}-1`, `同一张图片内容 ${kind}`, { kind }),
    makeItem(`${kind}-2`, `同一张图片内容 ${kind}`, { kind }),
  ])
  assert.deepEqual(buildClusters(excluded), { groups: [], hiddenIds: [] })

  const includedKinds = [
    ['bilibili', '黑神话悟空 全流程攻略', 'bili-1', 'bili-2'],
    ['xhs', '小红书爆款标题模板', 'xhs-1', 'xhs-2'],
    ['video', 'GitHub Copilot 免费版上线', 'video-1', 'video-2'],
    ['link', 'macOS 安装 DeepSeek 教程', 'link-1', 'link-2'],
  ]
  const included = includedKinds.flatMap(([kind, title, idA, idB]) => [
    makeItem(idA, title, { kind }),
    makeItem(idB, title, { kind }),
  ])
  const { groups } = buildClusters(included)
  assert.equal(groups.length, 4)
  for (const group of groups) assert.equal(group.size, 2)
  const groupedIds = groups.flatMap((group) => group.memberIds)
  assert.equal(groupedIds.length, 8)
  for (const id of groupedIds) assert.ok(!excludedKinds.some((kind) => id.startsWith(kind)))
})

test('buildClusters: skips done/archived items and items without a url', () => {
  const openAiA = '深度｜OpenAI 发布 GPT-5，能力大幅提升'
  const openAiB = 'OpenAI GPT-5 正式发布：能力全面提升'

  assert.deepEqual(
    buildClusters([
      makeItem('s1', openAiA),
      makeItem('s2', openAiB, { status: 'done' }),
    ]),
    { groups: [], hiddenIds: [] },
  )
  assert.deepEqual(
    buildClusters([
      makeItem('ar1', openAiA),
      makeItem('ar2', openAiB, { status: 'archived' }),
    ]),
    { groups: [], hiddenIds: [] },
  )
  assert.deepEqual(
    buildClusters([
      makeItem('up1', openAiA),
      makeItem('up2', openAiB, { status: 'DONE' }),
    ]),
    { groups: [], hiddenIds: [] },
  )
  assert.deepEqual(
    buildClusters([
      makeItem('n1', openAiA, { url: '' }),
      makeItem('n2', openAiB, { url: '   ' }),
      makeItem('n3', openAiA),
    ]),
    { groups: [], hiddenIds: [] },
  )
})

test('buildClusters: single item / unrelated items never produce a group of size < 2', () => {
  assert.deepEqual(buildClusters([makeItem('solo', 'OpenAI 发布 GPT-5')]), {
    groups: [],
    hiddenIds: [],
  })
  const { groups, hiddenIds } = buildClusters([
    makeItem('x', '影之刃零会断支线攻略'),
    makeItem('y', 'Dota2 英雄胜率'),
  ])
  assert.deepEqual(groups, [])
  assert.deepEqual(hiddenIds, [])
})

test('buildClusters: a missing status is treated as active', () => {
  const noStatus = [
    { id: 'ns1', title: '深度｜OpenAI 发布 GPT-5，能力大幅提升', url: 'https://example.com/ns1', kind: 'article' },
    { id: 'ns2', title: 'OpenAI GPT-5 正式发布：能力全面提升', url: 'https://example.com/ns2', kind: 'wechat' },
  ]
  const { groups } = buildClusters(noStatus)
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].memberIds, ['ns1', 'ns2'])
})

test('buildClusters: groups sort by size desc then representativeId asc; hiddenIds are stable', () => {
  const items = [
    makeItem('t1', '深度｜OpenAI 发布 GPT-5，能力大幅提升', { site: '站A', score: 99 }),
    makeItem('t2', 'OpenAI GPT-5 正式发布：能力全面提升', { site: '站B', score: 50 }),
    makeItem('t3', 'GPT-5 来了！OpenAI 发布，能力大幅提升', { site: '站C', score: 40 }),
    makeItem('a1', 'Dota2 7.35 版本更新日志', { site: '站A', score: 80 }),
    makeItem('a2', 'Dota2 7.35 版本更新说明', { site: '站B', score: 30 }),
    makeItem('b1', '苹果 2025 秋季发布会全记录', { site: '站A', score: 70 }),
    makeItem('b2', '2025苹果秋季发布会：全程回顾', { site: '站B', score: 20 }),
  ]
  const { groups, hiddenIds } = buildClusters(items)

  assert.equal(groups.length, 3)
  assert.deepEqual(groups.map((group) => group.size), [3, 2, 2])
  assert.deepEqual(groups.map((group) => group.representativeId), ['t1', 'a1', 'b1'])
  assert.deepEqual(groups[0].memberIds, ['t1', 't2', 't3'])
  assert.deepEqual(groups[1].memberIds, ['a1', 'a2'])
  assert.deepEqual(groups[2].memberIds, ['b1', 'b2'])
  assert.deepEqual(hiddenIds, ['t2', 't3', 'a2', 'b2'])

  for (const group of groups) {
    assert.deepEqual(Object.keys(group).sort(), ['id', 'memberIds', 'representativeId', 'size'])
    assert.match(group.id, /^cg_[0-9a-f]{8}$/)
    assert.equal(group.size, group.memberIds.length)
    assert.ok(!hiddenIds.includes(group.representativeId))
  }
  // Group ids are unique and derived from the member set.
  assert.equal(new Set(groups.map((group) => group.id)).size, groups.length)
})

test('buildClusters: deterministic regardless of input order', () => {
  const items = [
    makeItem('a1', '深度｜OpenAI 发布 GPT-5，能力大幅提升', { score: 70 }),
    makeItem('a2', 'OpenAI GPT-5 正式发布：能力全面提升', { score: 90 }),
    makeItem('a3', 'GPT-5 来了！OpenAI 发布，能力大幅提升', { score: 60 }),
    makeItem('b1', '苹果 2025 秋季发布会全记录', { score: 50 }),
    makeItem('b2', '2025苹果秋季发布会：全程回顾', { score: 40 }),
  ]
  const forward = buildClusters(items)
  const backward = buildClusters([...items].reverse())
  assert.equal(forward.groups.length, backward.groups.length)
  assert.deepEqual(
    forward.groups.map((group) => group.id).sort(),
    backward.groups.map((group) => group.id).sort(),
  )
  assert.deepEqual(
    forward.groups.map((group) => sortedIds(group.memberIds)).sort(),
    backward.groups.map((group) => sortedIds(group.memberIds)).sort(),
  )
  assert.deepEqual(sortedIds(forward.hiddenIds), sortedIds(backward.hiddenIds))
})

test('buildClusters: does not mutate the input items', () => {
  const items = [
    makeItem('m1', '深度｜OpenAI 发布 GPT-5，能力大幅提升'),
    makeItem('m2', 'OpenAI GPT-5 正式发布：能力全面提升'),
  ]
  const snapshot = structuredClone(items)
  buildClusters(items)
  assert.deepEqual(items, snapshot)
})

test('buildClusters: threshold 0.55 — just above merges, just below stays separate', () => {
  // titleSimilarity 0.5414 (< 0.55), different sites -> no bonus -> unrelated.
  const watchPair = [
    makeItem('w1', 'Apple Watch 健身记录技巧', { site: '站A' }),
    makeItem('w2', 'Apple Watch 表带选购指南', { site: '站B' }),
  ]
  assert.ok(itemSimilarity(watchPair[0], watchPair[1]) < 0.55)
  assert.deepEqual(buildClusters(watchPair), { groups: [], hiddenIds: [] })

  // Same pair + same site: +0.1 pushes it over the threshold.
  const sameSitePair = [
    makeItem('w1', 'Apple Watch 健身记录技巧', { site: '站A' }),
    makeItem('w2', 'Apple Watch 表带选购指南', { site: '站A' }),
  ]
  assert.ok(itemSimilarity(sameSitePair[0], sameSitePair[1]) >= 0.55)
  assert.equal(buildClusters(sameSitePair).groups.length, 1)

  // titleSimilarity 0.5556 (> 0.55) merges even across different sites.
  const genshinPair = [
    makeItem('g1', '原神4.0版本前瞻直播汇总', { site: '站A' }),
    makeItem('g2', '原神 4.0 前瞻直播内容汇总', { site: '站B' }),
  ]
  assert.ok(itemSimilarity(genshinPair[0], genshinPair[1]) >= 0.55)
  assert.equal(buildClusters(genshinPair).groups.length, 1)

  // Site + tag bonuses cannot merge different editions (guard caps at 0.5).
  const editionPair = [
    makeItem('e1', 'iPhone 17 评测', { site: 'B站', tags: ['数码', '手机'] }),
    makeItem('e2', 'iPhone 16 评测', { site: 'B站', tags: ['数码', '手机'] }),
  ]
  assert.ok(itemSimilarity(editionPair[0], editionPair[1]) <= 0.5)
  assert.deepEqual(buildClusters(editionPair), { groups: [], hiddenIds: [] })
})

test('buildClusters: grouping matches the itemSimilarity >= 0.55 graph', () => {
  const items = [
    makeItem('n1', '深度｜OpenAI 发布 GPT-5，能力大幅提升', { site: '公众号', tags: ['AI'] }),
    makeItem('n2', 'OpenAI GPT-5 正式发布：能力全面提升', { site: 'B站', tags: ['AI'] }),
    makeItem('n3', 'GPT-5 来了！OpenAI 发布，能力大幅提升', { site: '知乎', tags: [] }),
    makeItem('n4', 'Dota2 7.35 版本更新日志', { site: 'B站', tags: ['Dota2'] }),
    makeItem('n5', 'Dota2 7.35 版本更新说明', { site: 'B站', tags: ['Dota2'] }),
    makeItem('n6', '原神4.0版本前瞻直播汇总', { site: '公众号', tags: [] }),
    makeItem('n7', '原神 4.0 前瞻直播内容汇总', { site: '微博', tags: [] }),
    makeItem('n8', 'iPhone 17 评测', { site: 'B站', tags: ['数码'] }),
    makeItem('n9', 'iPhone 16 评测', { site: 'B站', tags: ['数码'] }),
    makeItem('n10', '影之刃零会断支线攻略', { site: 'B站', tags: [] }),
    makeItem('n11', 'Dota2 英雄胜率', { site: 'B站', tags: ['Dota2'] }),
  ]
  const expected = expectedClusterSets(items)
  const actual = buildClusters(items).groups
    .map((group) => sortedIds(group.memberIds))
    .sort((a, b) => (a.join('|') < b.join('|') ? -1 : 1))
  assert.deepEqual(actual, expected)
  assert.ok(expected.length >= 3, 'fixture should contain several clusters')
})

test('buildClusters: dirty data never throws', () => {
  const dirty = [
    null,
    undefined,
    0,
    'not-an-item',
    [],
    {},
    { id: 'd1' },
    { id: 'd2', kind: 'article', title: '有 id 无 url' },
    { id: 'd3', kind: 'wechat', url: 'https://example.com/d3', title: {}, tags: 'not-an-array', site: [1] },
    { id: 'd4', kind: 'wechat', url: 'https://example.com/d4', title: null, tags: [null, {}, 7], site: null },
    { id: 'd5', kind: 'BILIBILI', url: ' https://example.com/d5 ', title: '某个有效标题' },
    { id: 'd6', kind: 'bilibili', url: 'https://example.com/d6', title: '某个有效标题', site: 42 },
    { id: 'd7', kind: 'image', url: 'https://example.com/d7', title: '某个有效标题' },
    { id: '  ', kind: 'article', url: 'https://example.com/d8', title: '空 id 应被忽略' },
  ]
  let result
  assert.doesNotThrow(() => {
    result = buildClusters(dirty)
  })
  assert.equal(result.groups.length, 1)
  assert.deepEqual(result.groups[0].memberIds, ['d5', 'd6'])
  assert.equal(result.groups[0].representativeId, 'd5')
  assert.deepEqual(result.hiddenIds, ['d6'])
})
