/**
 * Optional LLM classification: fills kind / importance / urgency / deadline /
 * tags / summary / durationMin for items that no human or agent has triaged yet.
 *
 * Uses the live `llm` Service, so no API key is handled here. Every failure is
 * returned as data ({ updated, error }) — the collection keeps the heuristic
 * values instead of losing the item.
 */
import { KINDS } from './score.js'
import { updateItem, getItems, getSettings, setItemContent } from './store.js'
import { resolveContent, contentNeedsRetry } from './content.js'
import { TOPICS, topicTagOf, withTopic } from './topics.js'
import {
  ORGANIZE_VERSION,
  diffFields,
  evaluateState,
  prevSnapshot,
  titleIsTrustworthy,
} from './organize-core.js'

const BATCH_SIZE = 8
const MAX_ITEMS_PER_RUN = 12
const TIMEOUT_MS = 70000
const KINDS_SET = new Set(KINDS)
const DEADLINE_KINDS = new Set(['airing', 'event', 'expiry', 'release', 'deadline', 'none'])

const SYSTEM = `你是主人的「稍后再看」整理助手。输入是一批主人转发/收藏下来的内容（图片、小红书、微信公众号文章、普通链接、视频、剧名等），你要判断每条的：类型、重要程度、紧急程度、时效性、摘要、标签、预计耗时。只输出 JSON，不要解释。

kind 只能取：image, xhs, wechat, link, video, bilibili, douyin, drama, game, article, product, idea, other
importance（重要程度 1-5）：5=直接关系主人当前的工作/钱/健康/家人/在做的事；4=明确兴趣或近期计划；3=一般有用；2=随手收藏；1=几乎没价值
urgency（紧急程度 1-5）：5=今天不看就错过/损失；4=3 天内；3=本周内；2=以后都行；1=完全不用看
deadline：只有内容里出现明确时间（开播/上映/截止/活动开始/优惠到期/更新时间）才填 ISO 8601 字符串；相对日期按当前时间换算；没有明确时间就填 null，不要猜
deadlineKind 只能取：airing（剧集更新）, event（活动/演出/直播）, expiry（优惠/报名/截止）, release（开播/上映/上线）, deadline（其它截止）, none
durationMin：预估阅读/观看分钟数，不确定填 null
topic：内容分类，只能取这些之一：${TOPICS.join('、')}
  判定优先级：先看 content/text 正文在讲什么，再看标题；实在没有信息才用 待归档（占位符、缺件、纯文件名）
summary：一句话中文摘要（≤60 字），没有信息就 null
tags：2-4 个中文短标签（不要重复 topic 那个分类名）
title：把原标题洗成能看懂的一句话（6-40 字）。只做清洗和补全：去掉「微信图片_2026…」「·kuro 2026年4月6日 12:24 [图片]」这类文件名/聊天记录残渣、去掉营销号前缀和后缀、把被截断的句子补完整；**不许编造标题里没有的事实**，不许改写作品名/品牌名/人名。原标题已经能看就原样返回，不要为了改而改。
confidence：你对这条判断的整体把握 0-1（有正文、信息充分 → 0.8 以上；只有标题 → 0.5 左右；占位符/缺件 → 0.2）
reason：一句话说明打分理由（≤40 字）

输出格式：{"items":[{"id":"<原 id>","kind":"...","topic":"...","title":"...","importance":3,"urgency":2,"deadline":null,"deadlineKind":"none","summary":"...","tags":["..."],"durationMin":5,"confidence":0.8,"reason":"..."}]}`

/** 低于这个把握就不动分类/类型，只在 ai.suggest 里留建议。 */
const MIN_CONFIDENCE = 0.7

export function aiInfo(ctx) {
  let selection = null
  try {
    selection = ctx.get('agentDefaultModel')?.currentSelection?.() || null
  } catch {
    selection = null
  }
  return {
    available: Boolean(ctx.get('llm')),
    provider: selection?.provider || 'deepseek-official',
    model: selection?.model || 'deepseek-chat',
  }
}

function chunks(list, size) {
  const out = []
  for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size))
  return out
}

function extractJson(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  const body = fenced ? fenced[1] : raw
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    return null
  }
}

/** 条目正文：优先抓回来的 content.text，其次原始 raw，都没有返回空串。 */
function contentTextOf(item) {
  const content = item && item.content
  if (content && typeof content === 'object') {
    const parts = [content.text, content.body, content.excerpt]
      .map((part) => (typeof part === 'string' ? part.trim() : ''))
      .filter(Boolean)
    if (parts.length) return parts.join('\n').slice(0, 4000)
  }
  return typeof item?.raw === 'string' ? item.raw : ''
}

function batchPrompt(items, nowIso) {
  const rows = items.map((item) => ({
    id: item.id,
    title: String(item.title || '').slice(0, 200),
    kind: item.kind || null,
    site: item.site || null,
    url: item.url || null,
    summary: String(item.summary || '').slice(0, 200) || null,
    // 正文优先用抓回来的 content.text，其次 raw；标题型内容就只能靠标题判断
    text: String(contentTextOf(item) || '').slice(0, 1600) || null,
    images: Array.isArray(item.images) ? item.images.length : 0,
    notes: String(item.notes || '').slice(0, 200) || null,
    deadline: item.deadline || null,
  }))
  return '当前时间（Asia/Shanghai）：' + nowIso + '\n待整理条目：\n' + JSON.stringify(rows, null, 2)
}

async function collectText(llm, options) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const signals = [controller.signal]
  if (options.externalSignal) signals.push(options.externalSignal)
  const signal = signals.length > 1 ? AbortSignal.any(signals) : controller.signal
  let text = ''
  let failure = null
  try {
    for await (const chunk of llm.stream({ ...options.request, signal })) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta') {
        text += String(chunk.text || '')
        if (text.length > 200000) break
      } else if (chunk.type === 'finish') {
        if (chunk.reason && chunk.reason.kind === 'error') failure = chunk.reason.failure
        break
      }
    }
  } finally {
    clearTimeout(timer)
  }
  if (failure) throw new Error('模型调用失败：' + (failure.message || failure.code || '未知错误'))
  return text
}

function sanitizeUpdate(item, entry) {
  if (!entry || typeof entry !== 'object') return null
  const patch = {}
  const suggest = {}
  const confidenceRaw = Number(entry.confidence)
  const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : MIN_CONFIDENCE
  // 主人的规矩：分类/类型是高置信才改，拿不准就只留建议。
  const strong = confidence >= MIN_CONFIDENCE
  const currentTopic = topicTagOf(item.tags) || null

  // ---- 标题：只做清洗补全，不许换事实（守门在 organize-core）
  if (typeof entry.title === 'string') {
    const next = entry.title.trim().replace(/\s+/g, ' ').slice(0, 80)
    if (next && next !== item.title && titleIsTrustworthy(item.title, next)) patch.title = next
  }

  // ---- 类型 kind：低置信只记建议
  if (KINDS_SET.has(entry.kind) && entry.kind !== item.kind) {
    if (strong) patch.kind = entry.kind
    else suggest.kind = entry.kind
  }

  // ---- 分类 topic：低置信只记建议
  const modelTopic = TOPICS.includes(String(entry.topic || '').trim()) ? String(entry.topic).trim() : null
  let appliedTopic = currentTopic
  if (modelTopic && modelTopic !== currentTopic) {
    if (strong) appliedTopic = modelTopic
    else suggest.topic = modelTopic
  } else if (modelTopic) {
    appliedTopic = modelTopic
  }

  const importance = Number(entry.importance)
  if (Number.isFinite(importance)) patch.importance = Math.max(1, Math.min(5, Math.round(importance)))
  const urgency = Number(entry.urgency)
  if (Number.isFinite(urgency)) patch.urgency = Math.max(1, Math.min(5, Math.round(urgency)))
  if (entry.deadline === null || entry.deadline === '') {
    patch.deadline = null
    patch.deadlineKind = 'none'
  } else if (typeof entry.deadline === 'string' && Number.isFinite(Date.parse(entry.deadline))) {
    patch.deadline = new Date(Date.parse(entry.deadline)).toISOString()
    patch.deadlineKind = DEADLINE_KINDS.has(entry.deadlineKind) && entry.deadlineKind !== 'none' ? entry.deadlineKind : 'deadline'
  }
  if (typeof entry.summary === 'string' && entry.summary.trim()) patch.summary = entry.summary.trim().slice(0, 300)
  const modelTags = Array.isArray(entry.tags)
    ? entry.tags.map((tag) => String(tag || '').trim().replace(/^#/, '').slice(0, 20)).filter(Boolean)
    : []
  if (Array.isArray(entry.tags) || modelTopic) {
    // 分类固定在 tags[0]
    patch.tags = withTopic(modelTags.length ? modelTags : item.tags, appliedTopic)
  }
  const duration = Number(entry.durationMin)
  if (Number.isFinite(duration) && duration > 0) patch.durationMin = Math.max(1, Math.min(600, Math.round(duration)))

  const reason = typeof entry.reason === 'string' ? entry.reason.trim().slice(0, 200) : null
  const merged = { ...item, ...patch }
  const fields = diffFields(item, merged)
  const checks = evaluateState({ ...merged, ai: { at: new Date().toISOString(), fields } })
  patch.ai = {
    state: checks.state,
    version: ORGANIZE_VERSION,
    fields,
    missing: checks.missing,
    reason,
    confidence,
    at: new Date().toISOString(),
    lastError: null,
    suggest: Object.keys(suggest).length ? suggest : null,
    prev: prevSnapshot(item, merged),
  }
  return { id: item.id, patch }
}

/**
 * Classify up to MAX_ITEMS_PER_RUN items. Returns
 * { updated: number, remaining: number, error: string|null, ids: string[] }.
 */
export async function classifyItems(ctx, items, options = {}) {
  const info = aiInfo(ctx)
  if (!info.available) {
    return { updated: 0, remaining: items.length, error: 'AI 服务不可用（当前 profile 没有 llm 服务）', ids: [] }
  }
  const llm = ctx.get('llm')
  const queue = items.slice(0, Math.max(1, Math.min(MAX_ITEMS_PER_RUN, Number(options.limit) || MAX_ITEMS_PER_RUN)))
  if (queue.length === 0) return { updated: 0, remaining: 0, error: null, ids: [] }
  const nowIso = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
  const applied = []
  const errors = []
  for (const batch of chunks(queue, BATCH_SIZE)) {
    try {
      const text = await collectText(llm, {
        externalSignal: options.signal,
        request: {
          provider: info.provider,
          model: info.model,
          system: SYSTEM,
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: batchPrompt(batch, nowIso) }],
            },
          ],
          temperature: 0.2,
          maxTokens: 2400,
        },
      })
      const parsed = extractJson(text)
      const entries = Array.isArray(parsed?.items) ? parsed.items : []
      const byId = new Map(entries.filter((entry) => entry && typeof entry.id === 'string').map((entry) => [entry.id, entry]))
      let batchApplied = 0
      for (const item of batch) {
        const update = sanitizeUpdate(item, byId.get(item.id))
        if (!update) continue
        try {
          updateItem(update.id, update.patch)
          applied.push(update.id)
          batchApplied += 1
        } catch {
          // item disappeared mid-flight; ignore
        }
      }
      if (batchApplied === 0) errors.push('模型没有返回可用结果')
    } catch (error) {
      errors.push(String(error?.message || error))
    }
  }
  return {
    updated: applied.length,
    remaining: Math.max(0, items.length - applied.length),
    error: errors.length ? errors[0] : null,
    ids: applied,
  }
}


/**
 * 主人 2026-11-09 要求：公众号文章在「新增入库」这条流程里也要先拿到正文，再交给模型判断。
 * 之前 autoClassifyRecent 只把标题/摘要喂给模型，被微信拦截的公众号只剩一句标题。
 * 这里在过大模型之前补齐正文；命中新鲜缓存就不重复抓（浏览器通道很贵）。
 */
const CONTENT_PREFETCH_KINDS = new Set(['wechat'])

async function prefetchIngestContent(items) {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (!item || !CONTENT_PREFETCH_KINDS.has(item.kind)) continue
    const cached = item.content
    if (cached && cached.fetchedAt && cached.text && !contentNeedsRetry(cached)) continue
    try {
      const resolved = await resolveContent(item, { force: false })
      if (!resolved || typeof resolved !== 'object') continue
      const updated = setItemContent(item.id, resolved)
      items[index] = updated && typeof updated === 'object' ? updated : { ...item, content: resolved }
    } catch {
      // 抓不到就保持原样，模型仍可凭标题与摘要判断
    }
  }
  return items
}

/**
 * 主人 2026-11-09 的要求：每次转发文件入库，都要让大模型把新条目过一遍。
 * 只处理最近 hours 小时内新入库、且还没被 AI 整理过的条目（老库存量不动，避免一次性烧钱）。
 */
export async function autoClassifyRecent(ctx, options = {}) {
  try {
    if (getSettings().autoAiOnIngest === false) return { updated: 0, remaining: 0, error: null, ids: [], skipped: 'disabled' }
    const hours = Number(options.hours) > 0 ? Number(options.hours) : 3
    const limit = Math.max(1, Math.min(MAX_ITEMS_PER_RUN, Number(options.limit) || 8))
    const since = Date.now() - hours * 3600 * 1000
    const retryAfter = Date.now() - 6 * 3600 * 1000
    const candidates = getItems()
      .filter((item) => item && item.status !== 'done' && item.status !== 'archived' && !item.ai?.classified)
      .filter((item) => {
        const at = Date.parse(item.createdAt || '')
        return Number.isFinite(at) ? at >= since : false
      })
      // 整理态判定还没跟上时（state 仍为 none），6 小时内不重复烧模型
      .filter((item) => {
        const lastTry = Date.parse(item.ai?.at || '')
        return !Number.isFinite(lastTry) || lastTry < retryAfter
      })
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit)
    if (!candidates.length) return { updated: 0, remaining: 0, error: null, ids: [] }
    // 新增流程：公众号文章先把正文抓回来（走 content.js 的统一链路，含浏览器兜底）
    await prefetchIngestContent(candidates)
    const result = await classifyItems(ctx, candidates, { limit })
    if (result.error) ctx.logger?.warn?.('[dsh-watch-later] 新条目自动 AI 整理失败：' + result.error)
    return result
  } catch (error) {
    return { updated: 0, remaining: 0, error: String(error?.message || error), ids: [] }
  }
}


const CLUSTER_SYSTEM = `你是内容整理助手。输入是一组主题相同/高度相似的文章（标题、来源、已有摘要）。请输出 JSON：
{"summary": "2-3 句中文归纳：这几篇一共在讲什么、核心结论是什么、建议读哪一篇（不要罗列标题）", "pickId": "最值得读的那一篇的 id（必须是输入里出现过的 id）", "reason": "一句话说明为什么选它"}
只输出 JSON，不要解释。`

/**
 * 归纳一组相似内容，返回 { ok, summary, pickId, reason, error }。
 * 调用失败时 ok=false 且带 error，不抛。
 */
export async function summarizeCluster(ctx, members, options = {}) {
  const info = aiInfo(ctx)
  if (!info.available) return { ok: false, error: 'AI 服务不可用（当前 profile 没有 llm 服务）' }
  const llm = ctx.get('llm')
  const rows = (Array.isArray(members) ? members : []).slice(0, 8).map((item) => ({
    id: item.id,
    title: String(item.title || '').slice(0, 160),
    site: item.site || null,
    summary: String(item.summary || '').slice(0, 200) || null,
  }))
  if (rows.length < 2) return { ok: false, error: '没有足够的相似内容可归纳' }
  try {
    const text = await collectText(llm, {
      externalSignal: options.signal,
      request: {
        provider: info.provider,
        model: info.model,
        system: CLUSTER_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] }],
        temperature: 0.3,
        maxTokens: 600,
      },
    })
    const parsed = extractJson(text)
    const summary = parsed && typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 1200) : ''
    if (!summary) {
      const fallback = String(text || '').trim().slice(0, 800)
      if (!fallback) return { ok: false, error: '模型没有返回可用归纳' }
      return { ok: true, summary: fallback, pickId: null, reason: null, error: null }
    }
    const pickId = typeof parsed.pickId === 'string' && rows.some((row) => row.id === parsed.pickId) ? parsed.pickId : null
    return { ok: true, summary, pickId, reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : null, error: null }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
}

const WORKS_SYSTEM = `你是影视/游戏资料整理助手。输入是一篇文章的标题和正文。请提取正文里提到的所有游戏、电视剧、电影、动画/番剧作品（只提作品名，不要提攻略站、UP主、公众号名，不要重复；同一部作品只出现一次），输出 JSON：
{"works":[{"title":"作品标准中文名","type":"game|anime|drama|movie"}]}
没有提到任何作品就输出 {"works":[]}。只输出 JSON，不要解释。`

/**
 * 从文章正文提取影视/游戏作品。
 * @returns {Promise<{ok:boolean, works?:Array<{title:string,type:string}>, error?:string}>}
 */
export async function extractWorks(ctx, item, options = {}) {
  const info = aiInfo(ctx)
  if (!info.available) return { ok: false, error: 'AI 服务不可用（当前 profile 没有 llm 服务）' }
  const text = String((item && item.content && item.content.text) || (item && item.summary) || '').trim()
  if (text.length < 120) {
    return { ok: false, error: '正文太少或抓不到正文，无法从正文提取作品（公众号文章需要能解析正文）' }
  }
  const llm = ctx.get('llm')
  try {
    const output = await collectText(llm, {
      externalSignal: options.signal,
      request: {
        provider: info.provider,
        model: info.model,
        system: WORKS_SYSTEM,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: '文章标题：' + String(item.title || '').slice(0, 200) + '\n正文：\n' + text.slice(0, 8000),
              },
            ],
          },
        ],
        temperature: 0.2,
        maxTokens: 1200,
      },
    })
    const parsed = extractJson(output)
    const rows = Array.isArray(parsed && parsed.works) ? parsed.works : []
    const works = []
    const seen = new Set()
    for (const row of rows.slice(0, 30)) {
      if (!row || typeof row.title !== 'string') continue
      const title = row.title.trim().slice(0, 80)
      if (!title) continue
      const key = title.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const type = ['game', 'anime', 'drama', 'movie'].includes(row.type) ? row.type : 'drama'
      works.push({ title, type })
    }
    return { ok: true, works }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
}


const AGENT_DETAIL_SYSTEM = `你是资料整理助手。输入是一批 agent 相关条目（可能是 DSH 插件、Skill、提示词、GitHub 仓库或介绍文章）。请为每条生成：
- name：它具体叫什么（插件/skill/提示词/仓库的正式名称；不要照抄长文章标题；尽量短，≤20 字）
- purpose：它有什么用（一句话，≤40 字，具体到场景/能力）
- category：只能是 prompt（提示词）/ plugin（插件）/ skill（skill）
只输出 JSON：{"items":[{"id":"<原 id>","name":"...","purpose":"...","category":"prompt|plugin|skill"}]}，不要解释。`

/**
 * 给 agent 条目补「名称 + 作用 + 三分类（提示词/插件/skill）」。
 * @returns {Promise<{ok:boolean, updated:number, error?:string}>}
 */
export async function enrichAgentItems(ctx, items, options = {}) {
  const info = aiInfo(ctx)
  if (!info.available) return { ok: false, updated: 0, error: 'AI 服务不可用（当前 profile 没有 llm 服务）' }
  const llm = ctx.get('llm')
  const rows = (Array.isArray(items) ? items : []).slice(0, 8).map((item) => ({
    id: item.id,
    title: String(item.title || '').slice(0, 160),
    summary: String(item.summary || '').slice(0, 200) || null,
    url: item.url || null,
    kind: item.kind || null,
  }))
  if (rows.length === 0) return { ok: true, updated: 0 }
  let text = ''
  try {
    text = await collectText(llm, {
      externalSignal: options.signal,
      request: {
        provider: info.provider,
        model: info.model,
        system: AGENT_DETAIL_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] }],
        temperature: 0.2,
        maxTokens: 1600,
      },
    })
  } catch (error) {
    return { ok: false, updated: 0, error: String(error?.message || error) }
  }
  const parsed = extractJson(text)
  const entries = Array.isArray(parsed && parsed.items) ? parsed.items : []
  const byId = new Map(entries.filter((entry) => entry && typeof entry.id === 'string').map((entry) => [entry.id, entry]))
  let updated = 0
  for (const item of items.slice(0, 8)) {
    const entry = byId.get(item.id)
    if (!entry) continue
    const patch = {}
    if (typeof entry.name === 'string' && entry.name.trim()) patch.agentName = entry.name.trim().slice(0, 80)
    if (typeof entry.purpose === 'string' && entry.purpose.trim()) patch.agentPurpose = entry.purpose.trim().slice(0, 160)
    if (['prompt', 'plugin', 'skill'].includes(entry.category)) patch.agentCategory = entry.category
    if (Object.keys(patch).length === 0) continue
    try {
      updateItem(item.id, patch)
      updated += 1
    } catch {
      // item removed mid-flight
    }
  }
  return { ok: true, updated }
}
