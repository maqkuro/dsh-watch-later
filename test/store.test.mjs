/**
 * Integration checks for the data layer. Runs against a throw-away data dir.
 *   node --test test/store.test.mjs
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'dsh-watch-later-test-'))
process.env.DSH_WATCH_LATER_DIR = dataDir

const store = await import('../store.js')
const { processInbox } = await import('../ingest.js')

const now = () => Date.now()
const ONE_PX_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    // ignore cleanup failure
  }
})

test('add, dedupe and snapshot shape', () => {
  const first = store.addItem(
    {
      title: '一篇公众号文章',
      url: 'https://mp.weixin.qq.com/s/abcdef',
      importance: 4,
      urgency: 3,
      deadline: new Date(now() + 6 * 3600e3).toISOString(),
      deadlineKind: 'expiry',
      tags: ['阅读', '工作'],
      durationMin: 12,
      channel: 'agent',
    },
    { dedupe: true },
  )
  assert.equal(first.created, true)
  assert.equal(first.item.kind, 'wechat')
  assert.equal(first.item.site, '微信公众号')

  const duplicate = store.addItem({ url: 'https://mp.weixin.qq.com/s/abcdef', title: '重复' }, { dedupe: true })
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.item.id, first.item.id)

  const second = store.addItem({ title: '海报参考', kind: 'image', importance: 2, urgency: 1 }, { dedupe: true })
  assert.equal(second.created, true)

  const snapshot = store.buildSnapshot({ nowMs: now(), aiAvailable: true, aiModel: 'deepseek-flash' })
  assert.equal(typeof snapshot.generatedAt, 'string')
  assert.equal(snapshot.items.length, 2)
  assert.equal(snapshot.counts.active, 2)
  assert.equal(snapshot.counts.inbox, 2)
  assert.ok(snapshot.counts.byKind.wechat >= 1)
  assert.equal(snapshot.settings.aiAvailable, true)
  assert.ok(Array.isArray(snapshot.todayFocus))
  assert.ok(Array.isArray(snapshot.expiring))
  const view = snapshot.items.find((row) => row.id === first.item.id)
  assert.ok(view)
  assert.ok(Number.isInteger(view.score) && view.score >= 0 && view.score <= 100)
  assert.ok(['now', 'today', 'week', 'later', 'expired', 'done', 'archived'].includes(view.triage))
  assert.equal(view.timeSensitivity.level, 'critical')
  assert.equal(view.hasTimeSensitivity, true)
  assert.equal(view.kindLabel, '微信公众号')
  assert.ok(view.signals && typeof view.signals.freshness === 'number')
})

test('update transitions and counts', () => {
  const snapshot = store.buildSnapshot({ nowMs: now() })
  const item = snapshot.items[0]
  const done = store.updateItem(item.id, { status: 'done' })
  assert.equal(done.status, 'done')
  assert.ok(done.readAt)
  const afterDone = store.buildSnapshot({ nowMs: now() })
  assert.equal(afterDone.counts.done, 1)
  assert.equal(afterDone.counts.active, 1)
  const restored = store.updateItem(item.id, { status: 'inbox' })
  assert.equal(restored.status, 'inbox')
  const snoozed = store.updateItem(item.id, { snoozedUntil: new Date(now() + 86400e3).toISOString() })
  assert.ok(snoozed.snoozedUntil)
  assert.throws(() => store.updateItem('wl_missing', { title: 'x' }))
})

test('media data url is stored and resolvable', () => {
  const media = store.saveMediaDataUrl(ONE_PX_PNG, 'poster.png')
  assert.match(media.url, /^\/api\/dsh-watch-later\/media\?f=/)
  const filename = decodeURIComponent(media.url.split('f=')[1])
  const resolved = store.resolveMediaPath(filename)
  assert.ok(resolved && resolved.size > 0)
  assert.equal(store.resolveMediaPath('../items.json'), null)
  assert.equal(store.resolveMediaPath('nope.png'), null)
  const added = store.addItem({ kind: 'image', title: '海报', cover: media.url })
  assert.equal(added.created, true)
})

test('settings, cookies and inbox ingestion', () => {
  const settings = store.setSettings({ autoAiOnSync: false, retentionDays: 7 })
  assert.equal(settings.autoAiOnSync, false)
  assert.equal(settings.retentionDays, 7)
  assert.equal(store.getCookie('bilibili'), null)
  store.setCookie('bilibili', 'SESSDATA=fake; bili_jct=fake')
  assert.ok(store.getCookie('bilibili').includes('SESSDATA'))
  assert.equal(store.cookieStatus().bilibili, true)

  const inboxFile = join(store.INBOX_DIR, 'links.txt')
  writeFileSync(inboxFile, '晚上看这个 https://www.bilibili.com/video/BV1xx411c7mD 还有 https://example.com/a', 'utf8')
  const result = processInbox()
  assert.equal(result.added, 2)
  assert.equal(readdirSync(store.INBOX_DIR).filter((name) => name === 'links.txt').length, 0)
  assert.ok(existsSync(store.INBOX_DONE_DIR))
  const snapshot = store.buildSnapshot({ nowMs: now() })
  assert.ok(snapshot.items.some((row) => row.kind === 'bilibili'))
  assert.ok(snapshot.counts.active >= 4)
})

test('export contains items and settings', () => {
  const exported = store.exportAll()
  assert.ok(exported.items.length >= 4)
  assert.equal(exported.version, 1)
  assert.ok(exported.settings)
})
