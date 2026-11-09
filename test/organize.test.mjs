/**
 * 「AI 整理」纯判定层 + 写回链路的检查。不联网、不调模型。
 *   node --test test/organize.test.mjs
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'dsh-watch-later-organize-'))
process.env.DSH_WATCH_LATER_DIR = dataDir

const core = await import('../organize-core.js')
const store = await import('../store.js')
const organize = await import('../organize.js')
const score = await import('../score.js')

after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

test('真封面 / 占位封面的口径', () => {
  assert.equal(core.isRealCover('/api/dsh-watch-later/media?f=a.jpg'), true)
  assert.equal(core.isRealCover('https://x.com/a.png'), true)
  assert.equal(core.isRealCover('/media/cover.svg'), false)
  assert.equal(core.isRealCover('/media/cover.svg?v=2'), false)
  assert.equal(core.isRealCover(''), false)
  assert.equal(core.isRealCover(null), false)
})

test('标题守门：垃圾标题可改，事实不许换', () => {
  assert.equal(core.looksLikeGarbageTitle('微信图片_202609041513_12'), true)
  assert.equal(core.looksLikeGarbageTitle('https://example.com/a'), true)
  assert.equal(core.looksLikeGarbageTitle('银之匙'), true) // 太短，允许补全
  assert.equal(core.looksLikeGarbageTitle('把之前出去玩的视频剪成塞尔达'), false)

  // 垃圾标题 → 新标题放行
  assert.equal(core.titleIsTrustworthy('微信图片_202609041513_12', '华为 Wear Engine 权限申请被驳回'), true)
  // 同一标题不算改动
  assert.equal(core.titleIsTrustworthy('影之刃零试玩', '影之刃零试玩'), false)
  // 完全换掉事实 → 拒绝
  assert.equal(core.titleIsTrustworthy('影之刃零试玩报告', '原神新角色评测大全'), false)
  // 只是清洗（保留关键词）→ 放行
  assert.equal(core.titleIsTrustworthy('【干货】影之刃零试玩报告（附视频）', '影之刃零试玩报告：手感与判定'), true)
  // 「原包缺失」是主人的缺件标记，不许洗掉
  assert.equal(core.titleIsTrustworthy('该偷懒时还得偷（原包缺失）', '该偷懒时还得偷'), false)
  assert.equal(core.titleIsTrustworthy('该偷懒时还得偷（原包缺失）', '该偷懒时还得偷（原包缺失）改'), true)
})

test('状态判定：四要素齐了才是 done', () => {
  const full = {
    title: '影之刃零试玩报告：手感与判定',
    summary: '作者实测了三小时，讲连段手感和判定窗口，结论是值得等。',
    cover: '/media/a.jpg',
    tags: ['游戏', '试玩'],
    ai: { at: new Date().toISOString(), fields: ['title'] },
  }
  assert.equal(core.evaluateState(full).state, 'done')

  const noCover = { ...full, cover: '/media/gen.svg' }
  const res = core.evaluateState(noCover)
  assert.equal(res.state, 'partial')
  assert.deepEqual(res.missing, ['cover'])

  const untouched = { ...full, cover: null, ai: { at: null, fields: [] } }
  assert.equal(core.evaluateState(untouched).state, 'none')

  const noTopic = { ...full, tags: ['待归档'] }
  assert.equal(core.evaluateState(noTopic).state, 'partial')
})

test('摘要不许复述标题', () => {
  assert.equal(core.summaryIsUsable('影之刃零试玩报告', '影之刃零试玩报告'), false)
  assert.equal(core.summaryIsUsable('影之刃零试玩报告', '影之刃零试玩报告：'), false)
  assert.equal(core.summaryIsUsable('影之刃零试玩报告', '实测三小时，连段手感偏硬，判定窗口比demo宽。'), true)
})

test('字段 diff 与撤销快照', () => {
  const before = { title: '旧标题标题', kind: 'link', tags: ['设计'], importance: 3 }
  const after = { title: '新标题标题', kind: 'xhs', tags: ['产品与商业'], importance: 3 }
  assert.deepEqual(core.diffFields(before, after).sort(), ['kind', 'title', 'topic'].sort())
  assert.deepEqual(core.prevSnapshot(before, after), { title: '旧标题标题', kind: 'link', topic: '设计' })
})

test('store：改写标题会留 titleRaw，ai 状态可写可读', () => {
  const created = store.addItem({ title: '微信图片_202609041513_12', kind: 'image' }, { dedupe: false })
  const id = created.item.id
  assert.equal(created.item.titleRaw, null)

  store.updateItem(id, { title: '华为 Wear Engine 权限申请被驳回' })
  let item = store.getItem(id)
  assert.equal(item.title, '华为 Wear Engine 权限申请被驳回')
  assert.equal(item.titleRaw, '微信图片_202609041513_12')

  // 二次改写不覆盖原始标题
  store.updateItem(id, { title: '华为 Wear Engine 权限申请被驳回（第二版）' })
  item = store.getItem(id)
  assert.equal(item.titleRaw, '微信图片_202609041513_12')

  store.updateItem(id, {
    ai: { state: 'done', version: 2, fields: ['title'], reason: '清洗标题', confidence: 0.9 },
  })
  item = store.getItem(id)
  assert.equal(item.ai.state, 'done')
  assert.equal(item.ai.classified, true)
  assert.deepEqual(item.ai.fields, ['title'])
})

test('撤销：标题/类型/分类还原，状态回到 none', () => {
  const created = store.addItem({ title: '原图标题', kind: 'link', tags: ['设计', '素材'] }, { dedupe: false })
  const id = created.item.id
  store.updateItem(id, {
    title: '清洗后的标题文本',
    kind: 'xhs',
    tags: ['产品与商业', '素材'],
    ai: {
      state: 'partial',
      version: 2,
      fields: ['title', 'kind', 'topic'],
      prev: { title: '原图标题', kind: 'link', topic: '设计' },
    },
  })
  let item = store.getItem(id)
  assert.equal(item.ai.state, 'partial')

  const restored = organize.undoOrganize(id)
  assert.equal(restored.title, '原图标题')
  assert.equal(restored.kind, 'link')
  assert.equal(restored.tags[0], '设计')
  assert.equal(restored.ai.state, 'none')
  assert.equal(restored.titleRaw, null)
})

test('counts.organize 覆盖全部条目（含已归档）', () => {
  const state = store.loadState()
  const list = state.items
  const counts = score.countItems(list, Date.now())
  assert.equal(typeof counts.organize.total, 'number')
  assert.equal(counts.organize.done + counts.organize.partial + counts.organize.failed + counts.organize.none, counts.organize.total)
  assert.equal(counts.organize.pending, counts.organize.total - counts.organize.done)
})

test('流水线：模型返回 → 写回标题/分类/状态（不联网）', async () => {
  const created = store.addItem({ title: '微信图片_202609041513_12', kind: 'image', tags: ['待归档'] }, { dedupe: false })
  const id = created.item.id
  const fakeCtx = {
    get: (name) => {
      if (name !== 'llm') return null
      return {
        async *stream() {
          yield {
            type: 'text-delta',
            text: JSON.stringify({
              items: [
                {
                  id,
                  kind: 'idea',
                  topic: '设计',
                  title: '美团骑手端改版后的信息层级',
                  summary: '作者拆了骑手端首页的三层信息结构，讲了改版前后点击路径的差别。',
                  importance: 3,
                  urgency: 2,
                  deadline: null,
                  deadlineKind: 'none',
                  tags: ['截图', '改版'],
                  durationMin: 4,
                  confidence: 0.92,
                  reason: '截图里有可用信息',
                },
              ],
            }),
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
    logger: { info() {}, warn() {} },
  }
  const summary = await organize.organizeItems(fakeCtx, [store.getItem(id)])
  assert.equal(summary.processed, 1)
  const item = store.getItem(id)
  assert.equal(item.title, '美团骑手端改版后的信息层级')
  assert.equal(item.titleRaw, '微信图片_202609041513_12')
  assert.equal(item.kind, 'idea')
  assert.equal(item.tags[0], '设计')
  assert.equal(item.ai.confidence, 0.92)
  assert.deepEqual(item.ai.prev, { title: '微信图片_202609041513_12', kind: 'image', topic: '待归档' })
  // 没有真封面 → 只能是 partial
  assert.equal(item.ai.state, 'partial')
  assert.ok(item.ai.fields.includes('title'))
})

test('流水线：低置信只留建议，不动分类', async () => {
  const created = store.addItem({ title: '一篇讲排版的中文文章', kind: 'link', tags: ['设计'] }, { dedupe: false })
  const id = created.item.id
  const fakeCtx = {
    get: (name) => {
      if (name !== 'llm') return null
      return {
        async *stream() {
          yield {
            type: 'text-delta',
            text: JSON.stringify({
              items: [
                {
                  id,
                  kind: 'game',
                  topic: '游戏',
                  title: '一篇讲排版的中文文章',
                  confidence: 0.4,
                  summary: '讲排版的文章，但没提到具体做法。',
                  reason: '只有标题',
                },
              ],
            }),
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
    logger: { info() {}, warn() {} },
  }
  await organize.organizeItems(fakeCtx, [store.getItem(id)])
  const item = store.getItem(id)
  assert.equal(item.kind, 'link')
  assert.equal(item.tags[0], '设计')
  assert.deepEqual(item.ai.suggest, { kind: 'game', topic: '游戏' })
})
