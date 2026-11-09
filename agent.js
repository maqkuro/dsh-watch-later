/**
 * Agent 相关内容的识别与状态（列表「Agent」tab 用）。
 *
 * 用户会转发大量 agent 相关的东西（DSH 插件、skill、提示词、GitHub 仓库、MCP 工具）。
 * 这里用保守的本地启发式打标，不调用 AI、不改条目原始字段：
 *   agent.relevant  是否算 Agent 相关
 *   agent.kind      plugin / skill / prompt / agent / other
 *   agent.status    new / opened / tried / skipped（new 为默认）
 */

const REPO_HOSTS = ['github.com', 'gitee.com', 'gitlab.com', 'npmjs.com', 'www.npmjs.com']
const KIND_RULES = [
  { kind: 'plugin', pattern: /(插件|plugin|dsh-plugin|cordis|extension\b|扩展\b)/i },
  { kind: 'skill', pattern: /(\bskills?\b|技能\b)/i },
  { kind: 'prompt', pattern: /(提示词|prompt|系统指令|system prompt|规则\b)/i },
  { kind: 'agent', pattern: /(\bagents?\b|智能体|mcp\b|workflow|工作流|harness|dsh\b)/i },
  { kind: 'agent', pattern: /(codex|workbuddy|computer\s*use|iphone\s*use|browser\s*use|claude\s*code)/i },
  { kind: 'agent', pattern: /(claude|gpt|codex|kimi|opus)[^\n]{0,12}(玩法|技巧|教程|工作流|实践|用法)/i },
]
const AI_HINTS = /(\bai\b|ai\b|deepseek|dsh\b|harness|claude|gpt|codex|kimi|llm\b|大模型|模型\b|openai|anthropic|智能体|agent\b)/i

export function agentStatusOf(item) {
  const value = item && item.agentStatus
  return ['new', 'opened', 'tried', 'skipped'].includes(value) ? value : 'new'
}

export function agentKindOf(item) {
  const text = [item?.title, item?.summary, item?.site, item?.author, Array.isArray(item?.tags) ? item.tags.join(' ') : '']
    .filter(Boolean)
    .join(' ')
  for (const rule of KIND_RULES) {
    if (rule.pattern.test(text)) return rule.kind
  }
  return 'agent'
}

export function isAgentRelevant(item) {
  if (!item) return false
  let host = ''
  try {
    host = new URL(String(item.url || '')).host.toLowerCase()
  } catch {
    host = ''
  }
  const text = [item.title, item.summary, item.url, item.site, item.author, Array.isArray(item.tags) ? item.tags.join(' ') : '']
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  if (REPO_HOSTS.some((repoHost) => host === repoHost || host.endsWith('.' + repoHost))) return true
  if (KIND_RULES.some((rule) => rule.pattern.test(text))) {
    // 光有“工作流/agent”字样但和 AI 无关的（如 Dota 攻略）需 AI 语境
    return AI_HINTS.test(text) || /(插件|skill|prompt|提示词|mcp|dsh-plugin|github)/i.test(text)
  }
  return false
}

export function agentInfo(item) {
  const relevant = isAgentRelevant(item)
  const kind = item && item.agentCategory ? item.agentCategory : relevant ? agentKindOf(item) : null
  return {
    relevant,
    kind,
    status: agentStatusOf(item),
    name: item && item.agentName ? String(item.agentName) : null,
    purpose: item && item.agentPurpose ? String(item.agentPurpose) : null,
  }
}
