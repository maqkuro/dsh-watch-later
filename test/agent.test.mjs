/**
 * Agent 分类启发式 + agentStatus 状态。
 *   node --test test/agent.test.mjs
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'wl-agent-test-'))
process.env.DSH_WATCH_LATER_DIR = dataDir

const { agentInfo, isAgentRelevant, agentKindOf, agentStatusOf } = await import('../agent.js')
const store = await import('../store.js')

after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

test('GitHub 仓库算 Agent 相关，普通链接不算', () => {
  assert.equal(isAgentRelevant({ title: 'dsh-plugin-eva-theme', url: 'https://github.com/seaison/dsh-plugin-eva-theme', kind: 'link' }), true)
  assert.equal(isAgentRelevant({ title: '影之刃零 攻略', url: 'https://www.xiaoheihe.cn/bbs/app/link', kind: 'link' }), false)
  assert.equal(isAgentRelevant({ title: '写真｜东方冷艳', url: 'https://mp.weixin.qq.com/s/abc', kind: 'wechat' }), false)
})

test('插件 / skill / 提示词分类与状态默认值', () => {
  assert.equal(agentKindOf({ title: 'DSH 插件：稍后再看' }), 'plugin')
  assert.equal(agentKindOf({ title: '这个 Skill 太好用了' }), 'skill')
  assert.equal(agentKindOf({ title: '写前端必备提示词' }), 'prompt')
  assert.equal(agentKindOf({ title: 'Grok Bot 的多 Agent 交互' }), 'agent')

  const info = agentInfo({ title: 'DSH 插件：稍后再看' })
  assert.equal(info.relevant, true)
  assert.equal(info.kind, 'plugin')
  assert.equal(info.status, 'new')
  assert.equal(agentStatusOf({}), 'new')
  assert.equal(agentStatusOf({ agentStatus: 'tried' }), 'tried')
  assert.equal(agentStatusOf({ agentStatus: 'bogus' }), 'new')
})

test('agentStatus 能通过 updateItem 持久化，snapshot 带上 agent 信息', () => {
  const added = store.addItem({ kind: 'link', title: 'dsh-plugin-eva-theme', url: 'https://github.com/seaison/dsh-plugin-eva-theme' })
  const id = added.item.id
  const snapshot = store.buildSnapshot({ nowMs: Date.now() })
  const view = snapshot.items.find((item) => item.id === id)
  assert.equal(view.agent.relevant, true)
  assert.equal(view.agent.status, 'new')

  const updated = store.updateItem(id, { agentStatus: 'tried' })
  assert.equal(updated.agentStatus, 'tried')
  const after = store.buildSnapshot({ nowMs: Date.now() }).items.find((item) => item.id === id)
  assert.equal(after.agent.status, 'tried')

  assert.equal(store.updateItem(id, { agentStatus: 'bogus' }).ok, false)
})
