/**
 * Agent-facing surface: four tools plus one prompt section.
 *
 * The point is that "转发给大肥鱼 → 稍后再看" needs no special syntax: the
 * assistant already sees the forwarded message and just calls watch_later_save
 * with its own classification, so the item is scored the moment it arrives.
 */
import { addItem, updateItem, getItem, buildSnapshot, saveMediaFile, MAX_IMAGES } from './store.js'
import { deriveItem } from './score.js'
import { runSync } from './sync-run.js'
import { ingestArchiveZip } from './zip-ingest.js'
import { backfillCovers } from './cover-backfill.js'
import { classifyItems, aiInfo, autoClassifyRecent } from './ai.js'
import { organizeItems } from './organize.js'

const COMPACT_FIELDS = ['id', 'kind', 'title', 'site', 'status', 'score', 'triage', 'deadline', 'importance', 'urgency', 'durationMin', 'url']

function compact(view) {
  const out = {}
  for (const field of COMPACT_FIELDS) out[field] = view[field]
  out.kindLabel = view.kindLabel
  out.time = view.timeSensitivity
  out.tags = Array.isArray(view.tags) ? view.tags.slice(0, 4) : []
  return out
}

function jsonOutput() {
  return {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  }
}

function viewOf(item) {
  return deriveItem(item, Date.now())
}

const ITEM_PROPERTIES = {
  title: { type: 'string', description: '标题（没有就用能辨认的短句）' },
  url: { type: 'string', description: '原始链接（http/https）' },
  text: { type: 'string', description: '主人转发的原始文本/分享文案（可留空）' },
  kind: {
    type: 'string',
    enum: ['image', 'xhs', 'wechat', 'link', 'video', 'bilibili', 'douyin', 'drama', 'game', 'article', 'product', 'idea', 'other'],
    description: '内容类型；看到想借来用的参考（视频/模板/构图/玩法/风格）用 idea',
  },
  summary: { type: 'string', description: '一句话摘要（≤60 字）' },
  author: { type: 'string' },
  site: { type: 'string', description: '平台名，如 小红书 / 微信公众号 / B站 / 抖音' },
  cover: { type: 'string', description: '封面图 URL（有就填）' },
  imagePaths: {
    type: 'array',
    items: { type: 'string' },
    description: '本地图片文件的绝对路径（≤100 张）。插件会把原图复制进媒体库，多张时第一张作为封面；从 ZIP/聊天记录里提取到图片时用这个字段',
  },
  importance: { type: 'integer', minimum: 1, maximum: 5, description: '重要程度 1-5（5=直接关系当前工作/钱/健康/家人）' },
  urgency: { type: 'integer', minimum: 1, maximum: 5, description: '紧急程度 1-5（5=今天不看就错过/损失）' },
  deadline: { type: 'string', description: '明确的时间节点，ISO 8601；没有明确时间不要填' },
  deadlineKind: {
    type: 'string',
    enum: ['airing', 'event', 'expiry', 'release', 'deadline', 'none'],
    description: '时效类型：剧集更新/活动/优惠截止/开播上线/其它截止',
  },
  tags: { type: 'array', items: { type: 'string' }, description: '2-4 个短标签' },
  durationMin: { type: 'integer', minimum: 1, maximum: 600, description: '预估阅读/观看分钟' },
  notes: { type: 'string' },
  reason: { type: 'string', description: '打分理由（一句话，会存进 ai.reason）' },
}

export function registerTools(ctx) {
  const tools = ctx.get('tools')
  if (!tools) return () => {}
  const disposers = []

  disposers.push(
    tools.register({
      name: 'watch_later_save',
      description:
        '把主人转发/粘贴的内容存入 DSH「稍后再看」中心（侧边栏 local-watch-later）。一次可存多条。主人说「稍后再看/收藏/存一下/回头再看/记下来」或明显是攒着以后看的内容时调用；调用前按内容判断 kind、importance(1-5)、urgency(1-5)，只有出现明确时间才填 deadline；「看到这个想照着做/想借来用」的参考素材（如「把视频剪成塞尔达那种」）用 kind=idea。不要编造内容，也不要因为要打分而反问主人。',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: { type: 'object', properties: ITEM_PROPERTIES, required: ['title'] },
          },
        },
        required: ['items'],
      },
      output: jsonOutput(),
      execute: async (args) => {
        const inputs = Array.isArray(args?.items) ? args.items : []
        if (inputs.length === 0) throw new Error('items 不能为空')
        const saved = []
        let duplicates = 0
        for (const rawInput of inputs.slice(0, 20)) {
          try {
            let input = { ...rawInput }
            if (Array.isArray(input.imagePaths) && input.imagePaths.length > 0) {
              const urls = []
              for (const path of input.imagePaths.slice(0, MAX_IMAGES)) {
                try {
                  const media = saveMediaFile(String(path))
                  urls.push(media.url)
                } catch {
                  // skip unreadable file
                }
              }
              if (urls.length > 0) {
                input.images = urls
                if (!input.cover) input.cover = urls[0]
                input.kind = 'image'
              }
              delete input.imagePaths
            }
            const result = addItem(
              {
                ...input,
                channel: 'agent',
                ai: {
                  classified: true,
                  reason: typeof input?.reason === 'string' ? input.reason.slice(0, 200) : '由大肥鱼整理',
                  confidence: 0.8,
                  at: new Date().toISOString(),
                },
              },
              { dedupe: true },
            )
            if (result.duplicate) duplicates += 1
            saved.push(compact(viewOf(result.item)))
          } catch {
            // skip a malformed row, keep saving the rest
          }
        }
        return { ok: saved.length > 0, saved, duplicates, hint: '已收入稍后再看，可在侧边栏「稍后再看」查看' }
      },
      presentCall: (args) => ({
        card: 'generic',
        title: '保存到稍后再看',
        kind: 'edit',
        rawInput: `${Array.isArray(args?.items) ? args.items.length : 0} 条`,
      }),
      presentResult: () => ({ card: 'generic', title: '已收入稍后再看' }),
    }),
  )

  disposers.push(
    tools.register({
      name: 'watch_later_list',
      description:
        '查看 DSH「稍后再看」队列。主人问「我稍后再看有什么 / 今天该看什么 / 有没有快过期的」时调用。scope=today 取现在和今天该看的，inbox 取刚收进的，expired 取时效已过的，kind 按类型筛，all 取全部未完成。返回精简条目（id/标题/分数/时效/截止）。',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['today', 'inbox', 'expired', 'all', 'kind'], description: '默认 today' },
          kind: { type: 'string', enum: ['image', 'xhs', 'wechat', 'link', 'video', 'bilibili', 'douyin', 'drama', 'game', 'article', 'product', 'idea', 'other'] },
          limit: { type: 'integer', minimum: 1, maximum: 30, description: '默认 10' },
          includeDone: { type: 'boolean', description: '是否包含已完成项' },
        },
      },
      output: jsonOutput(),
      execute: async (args) => {
        const scope = ['today', 'inbox', 'expired', 'all', 'kind'].includes(args?.scope) ? args.scope : 'today'
        const limit = Math.max(1, Math.min(30, Number(args?.limit) || 10))
        const snapshot = buildSnapshot({ nowMs: Date.now() })
        let rows = snapshot.items
        if (scope === 'today') rows = rows.filter((view) => view.triage === 'now' || view.triage === 'today')
        else if (scope === 'inbox') rows = rows.filter((view) => view.status === 'inbox')
        else if (scope === 'expired') rows = rows.filter((view) => view.triage === 'expired')
        else if (scope === 'kind') rows = rows.filter((view) => view.kind === args?.kind)
        if (!args?.includeDone) rows = rows.filter((view) => view.status !== 'done')
        return {
          ok: true,
          counts: snapshot.counts,
          total: rows.length,
          items: rows.slice(0, limit).map(compact),
          hasMore: rows.length > limit,
        }
      },
      presentCall: (args) => ({
        card: 'generic',
        title: '查看稍后再看',
        kind: 'search',
        rawInput: args?.scope || 'today',
      }),
      presentResult: () => ({ card: 'generic', title: '稍后再看队列' }),
    }),
  )

  disposers.push(
    tools.register({
      name: 'watch_later_update',
      description:
        '修改 DSH「稍后再看」里的一条：改分类 kind（游戏测评/攻略用 game、剧集动画用 drama、想借来用的参考素材用 idea）、标记已读（done，会同时从 B站稍后再看移出）/恢复、改重要度或紧急度、改截止时间、改标题/摘要/标签/笔记、设置稍后提醒。id 必须来自 watch_later_list 或 watch_later_save 的返回。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '条目 id（wl_ 开头）' },
          patch: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['image', 'xhs', 'wechat', 'link', 'video', 'bilibili', 'douyin', 'drama', 'game', 'article', 'product', 'idea', 'other'] },
              status: { type: 'string', enum: ['inbox', 'queued', 'doing', 'done'] },
              importance: { type: 'integer', minimum: 1, maximum: 5 },
              urgency: { type: 'integer', minimum: 1, maximum: 5 },
              deadline: { type: 'string', description: 'ISO 8601；空字符串表示清除' },
              deadlineKind: { type: 'string', enum: ['airing', 'event', 'expiry', 'release', 'deadline', 'none'] },
              title: { type: 'string' },
              summary: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              notes: { type: 'string' },
              snoozedUntil: { type: 'string', description: 'ISO 8601 稍后提醒时间；空字符串清除' },
            },
          },
        },
        required: ['id', 'patch'],
      },
      output: jsonOutput(),
      execute: async (args) => {
        const id = String(args?.id || '')
        if (!id) throw new Error('缺少 id')
        const item = getItem(id)
        if (!item) throw new Error('找不到这条稍后再看：' + id)
        const patch = args?.patch && typeof args.patch === 'object' ? { ...args.patch } : {}
        if (patch.deadline === '') patch.deadline = null
        if (patch.snoozedUntil === '') patch.snoozedUntil = null
        const updated = updateItem(id, patch)
        return { ok: true, item: compact(viewOf(updated)) }
      },
      presentCall: () => ({ card: 'generic', title: '更新稍后再看', kind: 'edit' }),
      presentResult: () => ({ card: 'generic', title: '稍后再看已更新' }),
    }),
  )

  disposers.push(
    tools.register({
      name: 'watch_later_sync',
      description:
        '同步主人的 B站 或 抖音「稍后再看」列表到 DSH。主人说「同步一下B站稍后再看」「看看抖音稍后再看」时调用。需要先在面板「同步」页配置对应 cookie；抖音如无公开接口会返回 supported:false 的说明。',
      parameters: {
        type: 'object',
        properties: {
          provider: { type: 'string', enum: ['bilibili', 'douyin'], description: '同步来源' },
        },
        required: ['provider'],
      },
      output: jsonOutput(),
      execute: async (args) => {
        const provider = args?.provider === 'douyin' ? 'douyin' : args?.provider === 'bilibili' ? 'bilibili' : null
        if (!provider) throw new Error('provider 只能是 bilibili 或 douyin')
        const result = await runSync(provider)
        return {
          ok: Boolean(result.ok),
          provider,
          imported: result.imported || 0,
          updated: result.updated || 0,
          skipped: result.skipped || 0,
          total: result.total || 0,
          supported: result.supported,
          error: result.error || null,
        }
      },
      presentCall: (args) => ({
        card: 'generic',
        title: '同步稍后再看',
        kind: 'fetch',
        rawInput: args?.provider,
      }),
      presentResult: () => ({ card: 'generic', title: '同步完成' }),
    }),
  )

  disposers.push(
    tools.register({
      name: 'watch_later_ingest_zip',
      description:
        '把一个微信聊天记录 ZIP 原包解包并存入稍后再看：自动把压缩包里所有原图存进媒体库（已有条目按图片 SHA 自动追加），并把聊天记录里的链接/文字导入。用户把聊天记录 ZIP 分享到 DSH（native-archive 草稿附件）后调用；path 必须是本机 ZIP 绝对路径。日常其实插件会自动扫收件目录，这个工具用于手动补一次或指定路径。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'ZIP 文件的绝对路径' },
          force: { type: 'boolean', description: '已导入过的 ZIP 是否强制再导一次（会去重，但可能补漏）' },
        },
        required: ['path'],
      },
      output: jsonOutput(),
      execute: async (args) => {
        const result = await ingestArchiveZip(String(args?.path || ''), { force: args?.force === true })
        return {
          ok: Boolean(result.ok),
          skipped: Boolean(result.skipped),
          newImages: result.newImages || 0,
          matchedImages: result.matched || 0,
          textItems: result.textItems || 0,
          galleryItemId: result.galleryItemId || null,
          error: result.error || null,
        }
      },
      presentCall: () => ({ card: 'generic', title: '导入聊天记录原包', kind: 'edit' }),
      presentResult: (_args, result) => ({ card: 'generic', title: '聊天记录原包已导入' }),
    }),
  )

  disposers.push(
    tools.register({
      name: 'watch_later_ai_review',
      description:
        '让大模型把「稍后再看」里的条目过一遍：读正文后重新判断分类(AI与Agent/设计/产品与商业/投资与量化/游戏/影游/摄影/生活与健康/成长与职业/工具与数码/截图存档/待归档)、类型 kind、重要度、紧急度、时效、摘要和标签。主人发来文件/链接、或说「用大模型过一遍」「AI 整理一下」时调用。不带 ids 时只整理最近 hours 小时内新入库的条目。',
      parameters: {
        type: 'object',
        properties: {
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: '只整理这些条目 id（wl_ 开头）；不传则整理最近新入库的',
          },
          limit: { type: 'integer', minimum: 1, maximum: 12, description: '最多整理几条，默认 8，上限 12' },
          hours: { type: 'number', description: '只处理最近 N 小时入库的条目，默认 3' },
        },
      },
      output: jsonOutput(),
      execute: async (args) => {
        const info = aiInfo(ctx)
        if (!info.available) return { ok: false, error: 'AI 服务不可用（当前 profile 没有 llm 服务）' }
        const limit = Math.max(1, Math.min(12, Number(args?.limit) || 8))
        const ids = Array.isArray(args?.ids) ? args.ids.map((id) => String(id || '')).filter(Boolean) : []
        if (ids.length) {
          const items = ids.map((id) => getItem(id)).filter(Boolean)
          if (!items.length) return { ok: false, error: '这些 id 都找不到' }
          // 走完整流水线：抓正文 → 补真封面 → 再让模型判类型/分类/标题
          const summary = await organizeItems(ctx, items)
          return {
            ok: !summary.error,
            updated: summary.processed,
            done: summary.done,
            partial: summary.partial,
            failed: summary.failed,
            model: info.model,
            error: summary.error || null,
          }
        }
        const hours = Number(args?.hours) > 0 ? Number(args.hours) : 3
        const result = await autoClassifyRecent(ctx, { hours, limit })
        return {
          ok: !result.error,
          updated: result.updated || 0,
          remaining: result.remaining || 0,
          skipped: result.skipped || null,
          model: info.model,
          error: result.error || null,
        }
      },
      presentCall: () => ({ card: 'generic', title: '让大模型整理稍后再看', kind: 'edit' }),
      presentResult: (_args, result) => ({ card: 'generic', title: '大模型已整理 ' + (result?.updated || 0) + ' 条' }),
    }),
  )

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        // ignore double disposers
      }
    }
  }
}

const PROMPT = `## 稍后再看
主人有一个 DSH 侧边栏「稍后再看」中心（插件 @local/dsh-watch-later），专门收他转发来的图片、小红书/公众号文章、普通链接、剧名、B站/抖音视频。
- 主人的使用习惯：他常把内容从微信文件传输助手里转发/粘贴给你，喜欢先攒着以后再看。**如果他把一整段内容转发过来、没有明确提问，默认理解为要存入稍后再看**（他明确说不用存时才不存），并简短确认存了什么。
- 当主人表达「稍后再看 / 收藏 / 存一下 / 回头再看 / 记下来」意图时，调用 watch_later_save 一次存完；不要先反问。
- 存时判断：kind（image/xhs/wechat/link/video/bilibili/douyin/drama/game/article/product/idea/other；游戏测评/攻略/想玩的游戏用 game，剧集/动画/番剧用 drama，看到想借来用的参考素材（模板/构图/玩法/风格）用 idea）；importance 1-5（和他在办的事/钱/健康/家人的相关度）；urgency 1-5（不马上看会不会错过/过期）；只有明确时间（开播/上映/截止/活动/剧集更新）才填 deadline（ISO 8601，Asia/Shanghai）；summary 一句话；tags 2-4 个。
- 收到微信聊天记录 ZIP（原生原包草稿）时，用 watch_later_ingest_zip 把里面所有原图和链接导入；如果能拿到 ZIP 的本地绝对路径就传 path。图片在原包里的话不要只写标题——原图要存下来。
- 主人问「稍后再看有什么 / 今天该看什么 / 有没有快过期的」→ watch_later_list；改状态/分数/截止 → watch_later_update；说「同步 B站/抖音」→ watch_later_sync。
- 不要编造条目，只有工具返回的 id 可用；图片确实存不进去时，就存标题+来源链接并说明。`

export function registerPrompt(ctx) {
  const systemPrompt = ctx.get('systemPrompt')
  if (!systemPrompt) return () => {}
  return systemPrompt.section({ name: 'dsh-watch-later', order: 460, text: PROMPT })
}


