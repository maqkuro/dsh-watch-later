# dsh-watch-later 插件契约（唯一事实来源）

> 项目目录：`（项目根目录）`
> Bundle 包名：`@local/dsh-watch-later`；侧边栏 id / main 面板 key：`local-watch-later`
> 目标：DSH 侧边栏「稍后再看」中心。收进用户从微信文件传输助手转发来的图片、小红书文章、
> 微信公众号文章、普通链接、剧名等信息，按内容类型分类、按重要程度+紧急程度打分、提示时效性，
> 并同步 B 站 / 抖音的稍后再看，做成综合稍后再看中心。

## 0. 写入边界（硬约束）

| 角色 | 只能写这些文件 |
|---|---|
| Lead | `index.js` `store.js` `api.js` `tools.js` `ai.js` `ingest.js` `enrich.js` `import-text.js` `sync-run.js` `package.json` `cordis.patch.yml` `locale/*` `icon.svg` `README.md` `CONTRACT.md` `test/store.test.mjs` |
| ui-builder | `client.js`（只此一个文件） |
| score-builder | `score.js` `classify.js` `test/score.test.mjs`（只此三个） |
| sync-builder | `sync/http.js` `sync/bili.js` `sync/douyin.js` `sync/NOTES.md` `test/sync.test.mjs` |

不要改别人的文件，不要动 `~/.dsh/profiles/**`、不要安装/卸载插件、不要重启 DSH、不要停进程。
Node ESM（package.json `"type":"module"`）。宿主半（`index.js`）用 `export function apply(ctx, config)`。

## 1. 数据位置

- 数据目录：`~/.dsh/storages/watch-later/`（环境变量 `DSH_WATCH_LATER_DIR` 可覆盖，测试用）
  - `items.json` 主数据（Lead 的 store.js 写，原子写）
  - `media/` 本地封面 / 图片
  - `inbox/` 投递目录（用户/其他程序放文件自动收取）
  - `secrets.json` cookie（0600，仅宿主读，任何接口不得回显明文）
  - `sync-state.json` 同步状态
- 时间一律 ISO 8601 字符串（UTC，`new Date().toISOString()`）；`deadline` 可为 null。

## 2. Item 数据模型（items.json）

```ts
type Kind = 'image'|'xhs'|'wechat'|'link'|'video'|'bilibili'|'douyin'|'drama'|'article'|'product'|'other'
type Status = 'inbox'|'queued'|'doing'|'done'|'archived'
type DeadlineKind = 'airing'|'event'|'expiry'|'release'|'deadline'|'none'

interface Item {
  id: string                // 'wl_' + base36 时间 + 4 位随机
  kind: Kind
  title: string             // 必须非空（缺省用 url/文本首行/文件名）
  url: string | null
  summary: string | null    // 一句话摘要（AI 或 og:description）
  author: string | null
  site: string | null       // 展示用平台名：小红书 / 微信公众号 / B站 / 抖音 / 豆瓣…
  cover: string | null      // http(s) 外链封面，或本地相对路径 '/api/dsh-watch-later/media/xxx.jpg'
  raw: string | null        // 原始转发文本
  channel: 'manual'|'agent'|'inbox'|'paste'|'bilibili'|'douyin'
  tags: string[]
  status: Status
  importance: 1|2|3|4|5     // 重要程度
  urgency: 1|2|3|4|5        // 紧急程度
  deadline: string | null   // 时效性关键时间（开播/上映/截止/活动开始）
  deadlineKind: DeadlineKind
  durationMin: number | null// 预估阅读/观看分钟
  progress: number | null   // 0..100，可空
  notes: string | null
  createdAt: string
  updatedAt: string
  readAt: string | null
  archivedAt: string | null
  snoozedUntil: string | null
  ai: { classified: boolean; reason: string | null; confidence: number | null; at: string | null }
  sync: null | { provider: 'bilibili'|'douyin'; remoteId: string; syncedAt: string; owner?: string|null; stats?: Record<string, unknown>|null }
}
```

`items.json` 结构：`{ "version": 1, "items": Item[], "settings": Settings, "updatedAt": string }`
`Settings`（可被用户改的）：`{ autoAiOnSync: boolean, retentionDays: number, inboxEnabled: boolean }`

## 3. 派生计算规范（score-builder 实现，Lead 直接 import）

`score.js` 必须导出（纯函数、无 I/O、无第三方依赖）：

```js
export const KINDS            // 上述 13 个 kind 的完整数组（含 idea 灵感）
export const KIND_META        // { [kind]: { label: 中文名, weight: 0.4~0.9, icon: 英文短名 } }
export function classifyUrl(url)            // -> { kind: Kind, site: string|null }
export function timeSensitivity(deadlineIso, nowMs)  // -> { level: 'expired'|'critical'|'soon'|'ahead'|'none', hoursLeft: number|null, pressure: number }
export function computeScore(item, nowMs)   // -> { score: number(0..100 整数), triage: Triage, signals: {...} }
export function deriveItem(item, nowMs)     // -> ItemView（见 §6），不修改入参
export function deriveSnapshotView(item, nowMs) // = deriveItem 的别名，可省
export function countItems(items, nowMs)    // -> Counts（见 §6）
export function sortForQueue(items, nowMs)  // -> ItemView[]，排序规则见 §3.4
export const TRIAGE_RANK      // { expired:0, now:1, today:2, week:3, later:4, done:5, archived:6 }
```

`classify.js` 必须导出：

```js
export function extractUrls(text)                 // -> string[] 去重、按出现顺序
export function heuristicExtract(input)           // { url?, text?, title? } -> 部分 Item 字段
export function parseDeadlineFromText(text, nowMs) // -> { deadline: ISO|null, deadlineKind }
export function heuristicImportText(input)        // 纯文本 -> 候选 [{ title, url|null, kind, ... }] 数组
```

### 3.1 打分为主公式（重要度+紧急度占大头，时效性做加成）

```
importance = clamp(item.importance ?? 3, 1, 5)
urgency    = clamp(item.urgency ?? 3, 1, 5)
ageHours   = max(0, (now - Date.parse(createdAt)) / 3600e3)
freshness  = 100 * exp(-ageHours / 96)          // 4 天衰减到约 37%，10 天约 8%
ts         = timeSensitivity(item.deadline, now)
timePull   = max(freshness, ts.pressure)         // 0..100
score      = round(0.45 * importance*20 + 0.35 * urgency*20 + 0.20 * timePull)   // 0..100
if (status === 'done' || status === 'archived') score = min(score, 40)
```

### 3.2 timeSensitivity（deadline 为空 → level 'none', pressure 0）

| 距 deadline | level | pressure |
|---|---|---|
| 已过期 > 24h | `expired` | 0 |
| 已过期 ≤ 24h（刚过） | `expired` | 60 |
| ≤ 6h | `critical` | 100 |
| ≤ 24h | `critical` | 85 |
| ≤ 72h | `soon` | 65 |
| ≤ 168h | `soon` | 45 |
| ≤ 336h | `ahead` | 25 |
| 更远 | `ahead` | 10 |

### 3.3 triage 分桶（优先级从高到低判断）

```
if status done/archived -> triage = status（'done'|'archived'）
else if ts.level === 'expired' -> 'expired'
else if ts.pressure >= 85 || score >= 78 -> 'now'
else if ts.pressure >= 65 || score >= 62 -> 'today'
else if ts.pressure >= 45 || score >= 45 -> 'week'
else -> 'later'
```

### 3.4 排序

`sortForQueue`：先按 `TRIAGE_RANK[triage]` 升序；同一桶内：有时效 deadline 的按 deadline 升序（更早在前），
都没 deadline 的按 score 降序；再按 createdAt 降序。`triage==='done'|'archived'` 只保留在资料库视图，
快照默认不含（见 §6）。

### 3.5 deriveItem 输出（ItemView）

Item 全部字段 + 以下派生字段（**UI 只依赖这里**）：

```ts
{
  ...Item,
  score: number,
  triage: 'expired'|'now'|'today'|'week'|'later'|'done'|'archived',
  kindLabel: string,            // 中文
  ageHours: number,
  signals: { importance: number, urgency: number, freshness: number, deadlinePressure: number },
  timeSensitivity: { level: 'expired'|'critical'|'soon'|'ahead'|'none', hoursLeft: number|null },
  hasTimeSensitivity: boolean   // level !== 'none'
}
```

### 3.6 heuristicExtract / heuristicImportText 规则

- `classifyUrl`：`xiaohongshu.com`/`xhslink.com`→xhs；`mp.weixin.qq.com`→wechat；
  `bilibili.com`/`b23.tv`→bilibili；`douyin.com`/`iesdouyin.com`→douyin；`weibo.com`→link；
  `zhihu.com`→article；`github.com`→link；`youtube.com`/`youtu.be`→video；
  `taobao.com`/`tmall.com`/`jd.com`/`pinduoduo.com`→product；图片扩展名→image；视频扩展名→video；其余→link。
  `site` 取可读名（小红书/微信公众号/B站/抖音/微博/知乎/GitHub/YouTube/淘宝…）。
- 剧集识别：文本含 剧/集/第.季/开播/上线/定档/预告 + 平台词（爱奇艺/腾讯视频/优酷/芒果/Netflix/HBO）→ kind `drama`。
  纯标题无 URL 且有「剧名」意图（如「剧名：xxx」「想看」）也归 `drama`。
- `parseDeadlineFromText`：识别 `YYYY-MM-DD`、`MM月DD日`、`MM-DD`、`YYYY/MM/DD`，可带 `HH:mm`；
  缺失年份按当年；已过去超过 30 天按明年。识别「开播/上映/上线」→ `release`；
  「更新/第x集/每周x」→ `airing`；「截止/有效期/限时/优惠/报名/预售」→ `expiry`；
  「活动/演出/直播」→ `event`；其余有日期 → `deadline`。解析不出返回 `{ deadline: null, deadlineKind: 'none' }`（不要瞎猜日期）。
- heuristicExtract 默认值：`importance: 3`, `urgency: 2`；有 deadline 且 72h 内 → `urgency ≥ 4`；
  文本含 今天/今晚/明天/限时/截止/开播 → `urgency = max(urgency, 3)`；`durationMin` 无据可依就 5。
- `heuristicImportText(text)`：先 `extractUrls`；每个 URL 生成一个候选，title 用 URL 前后最近的文本行清理
  掉 URL 后的内容（去空白，截 120 字），没有就用 URL 域名；若无 URL 且文本非空 → 单个 `kind:'other'` 候选，
  title 取首行（截 120 字）；空文本 → `[]`。候选字段至少含 `title,url,kind,site,importance,urgency,deadline,deadlineKind,tags`。

## 4. 宿主半（Lead 写，供理解上下文）

- `index.js`：`export function apply(ctx, config)`；inject `webServer`，可选 `ctx.get('tools')`、
  `ctx.get('systemPrompt')`、`ctx.get('llm')`、`ctx.get('agentDefaultModel')`。
- API 路由都注册在 `ctx.webServer.register({ kind:'exact', path, handler })`；只允许本机/私网访问。
- Agent 工具：`watch_later_save` / `watch_later_list` / `watch_later_update` / `watch_later_sync`。
- 启动：加载数据 → 注册路由/工具/提示词 → 扫描并监听 `inbox/`（fs.watch，防抖 1s，处理完移入 `inbox/done/`）。
- AI 分类（`ai.js`）：优先 `ctx.llm.stream({ provider, model, ... })`（provider/model 取
  `ctx.get('agentDefaultModel')?.currentSelection()`，兜底 `deepseek-official` / `deepseek-chat`）；
  一次最多 8 条，要求模型只输出 JSON；解析失败保留启发式结果，不抛给 UI。

## 5. HTTP API（Base：`/api/dsh-watch-later`）

所有变更类接口：`POST`，`Content-Type: application/json`，请求体 ≤ 12MB（图片 dataURL 用）。
成功 `{ ok:true, ... }`；失败 `{ ok:false, error:string }` + 非 2xx。UI 必须处理网络错误与 `ok:false`。

| 方法/路径 | body | 返回 |
|---|---|---|
| `GET /snapshot` | — | §6 Snapshot |
| `POST /add` | `{ title?, url?, text?, kind?, summary?, author?, site?, cover?, importance?, urgency?, deadline?, deadlineKind?, tags?, durationMin?, channel?, dataUrl?, imageName? }` | `{ ok, item: ItemView }` |
| `POST /import` | `{ text }` | `{ ok, items: ItemView[], skipped: number }` 粘贴文本批量解析（含多链接/抖音分享文案） |
| `POST /update` | `{ id, patch: { title?,url?,summary?,author?,site?,cover?,kind?,tags?,importance?,urgency?,deadline?,deadlineKind?,durationMin?,progress?,notes?,status? } }` | `{ ok, item }` |
| `POST /action` | `{ id, action:'done'|'archive'|'restore'|'start'|'snooze', until? }` | `{ ok, item }` |
| `POST /delete` | `{ id }` | `{ ok, deleted:true }` |
| `POST /ai/review` | `{ ids?: string[], limit?: number }` | `{ ok, updated: number, remaining: number, error?: string }` |
| `POST /sync` | `{ provider:'bilibili'|'douyin', force? }` | `{ ok, provider, imported, updated, skipped, total, error?: string }` |
| `POST /settings` | `{ patch?: {autoAiOnSync?,retentionDays?,inboxEnabled?}, cookie?: { provider, cookie } }` | `{ ok, settings, sync }` |
| `POST /resolve` | `{ url }` | `{ ok, preview: { title?, cover?, author?, durationMin?, site?, kind? } }` 添加前预览（尽力而为，可失败） |
| `POST /douyin/parse` | `{ text }` | `{ ok, item }` 抖音分享文案 → 解析入库（见 §7） |
| `GET /media?f=<filename>` | — | 图片二进制（防目录穿越，正确 content-type，允许 304） |
| `GET /export` | — | 全量 JSON 备份 |

## 6. Snapshot（UI 唯一数据源）

```ts
interface Snapshot {
  generatedAt: string
  counts: {
    total: number; active: number; inbox: number; now: number; today: number; week: number; later: number;
    expired: number; done: number; archived: number; timeSensitive: number;
    byKind: Record<string, number>
  }
  totals: { addedToday: number; doneToday: number; readMinutes: number }
  todayFocus: ItemView[]      // triage now/today，按 deadline 近→远、score 降序，最多 4 条
  expiring: ItemView[]        // timeSensitivity level critical 或 soon，按 deadline 升序，最多 8 条
  items: ItemView[]           // status !== 'archived' 的全部；已 done 的保留最近 7 天，其余不返回
  settings: {
    autoAiOnSync: boolean; retentionDays: number; inboxEnabled: boolean;
    inboxDir: string; dataDir: string; aiAvailable: boolean; aiModel: string | null;
  }
  sync: {
    bilibili: { supported: true; configured: boolean; connected: boolean | null; account: string | null;
                lastSyncAt: string | null; lastResult: { imported: number; updated: number; skipped: number; total: number } | null;
                lastError: string | null }
    douyin:   { supported: true; configured: boolean; connected: boolean | null; account: string | null;
                lastSyncAt: string | null; lastResult: { imported: number; updated: number; skipped: number; total: number } | null;
                lastError: string | null; autoSync: false; note: string }   // note: 抖音需要登录 Cookie（至少 sessionid）
  }
}
```

`counts` 口径：`active = status inbox+queued+doing`；`now/today/week/later/expired` 是 active 的 triage 计数；
`timeSensitive = active 中 hasTimeSensitivity`；`byKind` 只统计 active。

## 7. 同步模块契约（sync-builder 实现，Lead 调用）

`sync/http.js`：
```js
export async function request(url, { method='GET', headers={}, body, timeoutMs=12000, signal, redirect='follow' } = {})
// -> { status, url, headers, text(): Promise<string>, json(): Promise<any> }
export const UA   // 移动端/桌面 UA 字符串
```

`sync/bili.js`：
```js
export async function fetchAccount({ cookie, signal }) // -> { ok, name?, avatar?, error? }
export async function fetchWatchLater({ cookie, signal })
// -> { ok:boolean, items:[{ remoteId:string, title:string, url:string, cover:string|null, author:string|null,
//                          durationSec:number|null, addedAt:string|null }], account?:string|null, error?:string }
```
数据源优先 `https://api.bilibili.com/x/v2/history/toview`（带 cookie：至少 `SESSDATA`），
`-101`/`-400` 等映射为可读错误（如「B站 cookie 已失效或未登录」）。单次最多取 100 条（翻页看接口实际情况），
失败不要抛未捕获异常，返回 `{ ok:false, items:[], error }`。

`sync/douyin.js`：
```js
export function parseShareText(text)          // -> { url:string, title:string|null } | null
export async function resolveShareUrl({ url, signal })
// -> { ok, item?: { remoteId, title, url, cover, author, durationSec }, error? }
export async function fetchWatchLater({ cookie, signal })
// -> { ok, supported:boolean, items:[...同上], error? }
```
实测结论（sync-builder 2026-11-06）：抖音网页端存在 `/aweme/v1/web/watchlater/list/`（需登录，
未登录返回 items:null；`profile/self` 有 user_watchlater_count），因此 `fetchWatchLater` 按登录能力实现，
返回 `supported:true`，无 cookie / cookie 失效时给可读 error；分享短链可无登录解析出视频 ID 与标准链接，
但落地页不提供标题/作者/封面（`resolveShareUrl` 返回 ok:false + 降级 item，宿主用分享文案标题入库）。
上述实测写进 `sync/NOTES.md`。
「稍后再看」官方没有公开 Web 接口时，明确 supported:false 并在 error 里说明，**不许伪造数据**。
所有网络调用带 12s 超时，失败返回结构化错误；不要在模块顶层发网络请求。

`test/sync.test.mjs`、`test/score.test.mjs` 用 `node --test`；**禁止真实网络**参与断言（真实探测可手动跑后记录在 NOTES）。

## 8. UI 契约（ui-builder 只写 client.js）

### 8.1 模块外壳（照抄 dsh-stock-panel/client.js 的结构）

```js
window.__ModuleLoader__.load({
  id: '@local/dsh-watch-later',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    // ...组件...
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }))
        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register(
          { name:'main', key:'local-watch-later', locale:NS, inject: () => ({ t: translate }) },
          function WatchLaterHost() { return h(WatchLaterCenter, { t: translate }) }
        )))
        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name:'sidebar.panellist', id:'local-watch-later', order: 15, locale:NS, label: () => translate('title') },
          WatchLaterIcon
        )))
      }
    }
  }
})
```
`WatchLaterIcon({ size=16, active })` → inline SVG（书签+时钟，currentColor，stroke 1.5）。
注册顺序：`order: 15`（在 stock panel 的 20 前面）。**不要**注册除这两个 slot 以外的任何东西。

### 8.2 视觉规范
- 只能使用主题 token：`--dsw-alias-bg-base|bg-layer-1|bg-layer-2|bg-overlay|border-l1|border-l2|brand-primary|label-primary|label-secondary|state-error-primary|state-success-primary|state-warn-primary|state-idle-primary|--dsw-specific-sidebar-fill`。**不得写死任何颜色**（artwork/渐变蒙版可用 rgba 黑/白，但主体必须 token）。
- 风格：安静、纸感、信息密度高但不拥挤；圆角 10–12px；1px 边框用 border-l1；卡片 hover 时边框/背景 layer-2 微变。
- 字体继承宿主；字号 13/14 为主，标题 15–16；数字用 `font-variant-numeric: tabular-nums`。
- 不使用 emoji 当图标（可用内联 SVG；内容里的平台名短标签除外）。
- 布局：整页 `height:100%`，`display:flex; flex-direction:column`；header 固定；内容区可滚动；窄宽度自适应（grid `repeat(auto-fill, minmax(248px,1fr))`）。
- 组件自己渲染 `<style>`（带前缀 `.wl-`），不要注入 document。

### 8.3 信息架构（tab 顺序固定）
1. **今日** `today`：顶部今日焦点（todayFocus 横向 2–4 张 hero 卡，展示 deadline 倒计时+score）；下方「现在就读」「今天内」「本周」三组卡片（triage now/today/week）。空态给引导：「从微信转发给 DSH 助手，或点右上角 + 添加」。
2. **收件箱** `inbox`：status==='inbox' 全部，按 createdAt 降序；顶部提示条说明「转发/粘贴进来的先落这里」；每条可快捷设定分类/重要度/紧急度（行内 chip）。
3. **资料库** `library`：搜索框（标题/摘要/标签/来源）+ 类型筛选 chips（全部+11 类，带 byKind 计数）+ 状态筛选（全部/未读/已读/已完成）+ 排序（优先级/最新/截止最近）+ 视图密度?；网格卡片；已归档折叠入口。
4. **时效** `timeline`：按 `timeSensitivity.level` + 有 deadline 分组：已过期 / 24 小时内 / 3 天内 / 本周内 / 更远 / 无截止；每行倒计时（「剩 3 小时」「还剩 2 天」）；level=expired 红色提示；顶部解释「哪些内容过了时间就不值得看了」。
5. **同步** `sources`：B站卡 + 抖音卡。每张卡：平台名、未配置 → cookie 输入（password 输入框 + 保存）；已配置 → 账号、上次同步时间、上次结果、按钮「立即同步」「更新 cookie」「解除」；错误红色显示。抖音卡说明：网页端「稍后再看」需要登录 Cookie（至少含 sessionid），把 douyin.com 登录后的完整 Cookie 粘进来即可同步；抓不到标题/封面时只入库链接（也可用下方「粘贴抖音分享文案」解析入库，调 `/douyin/parse`）。同步中禁用按钮并显示进度感。
6. **设置** `settings`：AI 同步后自动整理开关（settings.autoAiOnSync）、数据目录/收件箱目录只读展示（可复制）、保留天数、导出按钮（`/export` 新窗口）、说明「投递到 inbox 目录的文件会自动收进来」。另放「AI 整理全部」按钮（`/ai/review` 无 ids，limit 最多 12，服务端会截断），显示结果 toast。

### 8.4 组件与交互（必须实现）
- `useSnapshot()`：挂载即 `GET /snapshot`；返回 `{ data, loading, error, reload }`；30s 轮询（页面可见时）；任意 action 后自动 reload；请求要带 `cache:'no-store'`。
- 顶部 header：标题「稍后再看」、今日要点（如「3 条现在该看 · 2 条快过期」）、右侧按钮：刷新、AI 整理、+ 添加、设置 tab 快捷。
- 卡片 `ItemCard`：封面（有 cover 显示；失败或无 cover 显示 kind 色块+平台名首字/图标）、kind 标签、score 圆角徽章（如 `82`，>=78 品牌色实底，>=62 描边，其余弱化）、title 两行截断、meta 行（site · author · 时长/字数）、重要/紧急小圆点（1–5，hover title 显示「重要 4/5」）、deadline chip（critical 红、soon 琥珀、expired 灰红删除线）、tags（最多 3） 、hover 操作：完成✓ / 归档 / 详情。
- 点击卡片 → 右侧抽屉 `ItemDrawer`（宽 min(420px, 92vw)）：大封面、完整标题、来源链接（点开新窗口并标记 doing）、摘要、可编辑：重要度/紧急度（1–5 分段选择）、deadline（datetime-local + 清除）、标签（逗号分隔）、笔记 textarea、「保存」；底部操作：完成 / 归档 / 删除（二次确认）/ 稍后提醒（+1 天）。
- `AddDialog`：模式切换「链接 / 文本 / 图片」；链接：url + 可选标题（失焦调 `/resolve` 预览填充）；文本：textarea（提示可一次粘多条链接）；图片：文件选择（FileReader → dataURL）+ 标题；公共字段：类型下拉（默认自动）、重要度/紧急度、deadline（可空）、标签；提交后关闭并 toast「已收入稍后再看」。
- `ExpiringBanner`：今日页顶部，若 expiring 非空，横向紧凑条：⚠ + 前 3 条「标题 · 剩 x」。
- `Toast`：右上角浮层，3s 消失；错误红色。
- 空态/加载态/错误态都必须有；错误态给「重试」。
- 键盘：Esc 关闭抽屉/弹窗；抽屉/弹窗有遮罩，点击遮罩关闭；focus 不要丢。
- 所有可点元素 `cursor:pointer` 且 `title` 提示；按钮 disabled 样式；不要 `alert()`/`confirm()`（删除用内联二次确认）。
- 本地状态只放 UI 状态（tab、筛选、抽屉选中 id），数据永远以 snapshot 为准。

### 8.5 文案（中文为主，en 提供简要对照）
标题「稍后再看」；副标题「把攒着的内容，按值得看的顺序排好」；
tab：今日 / 收件箱 / 资料库 / 时效 / 同步 / 设置；
按钮：刷新 / AI 整理 / 添加 / 立即同步 / 保存 / 完成 / 归档 / 删除 / 稍后提醒 / 解析；
空态：今日「今天没有必须看的内容，放松一下」；收件箱「收件箱是空的，把内容转发给 DSH 助手吧」；
同步说明：B站「在浏览器登录 B 站后，把 Cookie 里的 SESSDATA 等粘贴进来（F12 → Network → 任意请求 → Cookie）」；
抖音「网页端「稍后再看」需要登录 Cookie（至少含 sessionid）；粘贴 douyin.com 的完整 Cookie 后即可同步，抓不到标题/封面时只入库链接」。

### 8.6 验收（必须自测）
- 文件能被 `node --check` 通过（ESM 也行：`node --input-type=module --check < client.js` 不适用，用 `node --check client.js` 即可，因 `window` 不执行）。
- 打开面板：无 JS 报错、无 slot crash；600px 宽下不横向溢出；浅/深色主题下都只靠 token 可读。
- 所有按钮都有真实 API 调用/本地状态变化；失败有可见反馈。
- 不能假定 snapshot 字段一定存在（用可选链 + 默认值），字段缺失时 UI 仍渲染。

## 9. Agent 工具（Lead 实现，UI 不直接调用）

```
watch_later_save   { items: [{ title?, url?, text?, kind?, summary?, importance?, urgency?, deadline?, deadlineKind?, tags?, durationMin?, channel? }] }
watch_later_list   { scope?: 'today'|'inbox'|'expired'|'all'|'kind', kind?, limit? }
watch_later_update { id, patch: {...} }
watch_later_sync   { provider: 'bilibili'|'douyin' }
```
工具输出要精简（列表返回 id/标题/分数/时效/截止，不返回大字段）。

## 10. 验证与交付

- Lead 负责 `node --check` 所有 JS、单元测试、安装 bundle、curl 实测各 API、slot 注册检查。
- 任何对契约的改动必须先改本文件再改代码；发现契约不合理先给 Lead 发消息。
- 完成后在 `README.md` 写明：安装位置、数据位置、cookie 配置、三条入库路径（转发给 DSH 助手 / 加号添加 / inbox 目录投递）、B站/抖音同步现状与限制。

## 11. 分享内容作业协议（share job）—— 2026-11-06 追加

背景：macOS 分享扩展（`~/Applications/NativeArchiveReceivers/NativeArchiveHost-deepseek.app`，源码
`（本机接收端项目）`）原来只收微信聊天记录 ZIP。
现在要支持把 **图片 / 文字 / 链接 / 分享文案** 直接「分享到 DSH → 稍后再看」。

- 分享根目录（扩展容器内，DSH 未沙箱化可直接读写）：
  `~/Library/Containers/local.kuro.NativeArchiveReceiver.DirectShare.deepseek/Data/Library/Application Support/NativeArchiveBridge/inbox/watchlater`
- 作业目录：`<shareRoot>/<uuid>/`，扩展创建，目录与文件权限 0700/0600。
- `manifest.json`（扩展写）：
  ```json
  {
    "schemaVersion": 2, "kind": "share-content", "id": "<uuid>", "target": "watchlater",
    "state": "content-checked", "originalFilename": "分享名称（如 微信图片.jpg / 文章标题）",
    "byteCount": 12345, "sha256": "<job sha256>",
    "parts": [
      { "role": "text", "filename": "text-1.txt", "byteCount": 123, "sha256": "<part sha256>" },
      { "role": "image", "filename": "image-1.png", "byteCount": 999, "sha256": "<part sha256>" }
    ],
    "createdAt": "2026-11-06T08:00:00Z"
  }
  ```
  - `parts` 按文件名排序后依次拼接，拼接结果的 SHA-256 = `manifest.sha256`（DSH 校验用）。
  - text part：UTF-8，单 part ≤ 64 KiB；image part：png/jpg/jpeg/webp/gif，单 part ≤ 15 MiB，
    image part 最多 6 个；总 parts ≤ 12。
  - 链接类内容一律作为 text part 写入（形如 `标题\nhttps://...`）。
- `delivery.json`（DSH 稍后再看插件写，扩展轮询）：
  ```json
  { "target": "watchlater", "state": "draft-ready" | "error", "sha256": "<manifest.sha256>",
    "sessionId": "watch-later", "itemCount": 2, "error": "错误原因（可选）", "updatedAt": 1793954138.5 }
  ```
  扩展判定成功条件：target 匹配、sha256 匹配、state === "draft-ready"。失败展示 `error` 原文。
- DSH 侧处理：`share-inbox.js` 监听/轮询 shareRoot → 校验 manifest/parts → 图片存入 media 并建 image 条目，
  文字用 `extractImportCandidates` 解析入库（channel: 'inbox'）→ 写 delivery.json。重启后按 delivery.json 跳过。
- 分享扩展失败时必须在分享面板显示真实错误（非通用文案），便于诊断。
- 单个聊天记录 ZIP 的上限为 **512 MiB**（DSH 侧 `@local/native-archive-dsh` 0.1.8 已同步；原 50 MiB 会导致
  「选择内容一多就转发失败」）。

## 12. 登录简化（插件内登录，自动拿 session）

目标：不再让用户手工抠 Cookie。新增两个登录通道，全部在面板「同步」页内完成。

### 12.1 B站：面板扫码登录（官方 passport 接口）
- `POST /api/dsh-watch-later/login/bilibili/start` → `{ ok, qrKey, qrImage, expiresIn }`
  （`qrImage` 是 `/api/dsh-watch-later/login/bilibili/qr?key=<qrKey>`，PNG）
- `GET /api/dsh-watch-later/login/bilibili/qr?key=<qrKey>` → PNG 二维码（服务端用 `qrencode` 生成，失败时 500）
- `POST /api/dsh-watch-later/login/bilibili/poll` `{ qrKey }` →
  `{ ok, state: 'waiting'|'scanned'|'confirmed'|'expired'|'error', account?: {name,avatar,mid}, error? }`
  确认时服务端自动把 `SESSDATA` 等写进 secrets 并更新 sync 状态；UI 关闭弹窗并刷新。
- 实现模块：`login/bili-qr.js`，接口 `generateQr({signal})` / `pollQr({qrKey,signal})`。

### 12.2 抖音（及兜底）：插件内打开 Chrome 登录窗，自动读取 Cookie
- `POST /api/dsh-watch-later/login/chrome/start` `{ provider: 'douyin'|'bilibili' }` →
  `{ ok, state:'window-open', port }`：宿主用独立 user-data-dir 启动 Chrome
  `--remote-debugging-port=<port>` 打开对应登录页（用户扫码/登录）。
- `POST /api/dsh-watch-later/login/chrome/poll` `{ provider }` →
  `{ ok, state:'waiting'|'confirmed'|'closed'|'error', account?:{name?}, error? }`
  通过 CDP 读取 cookies，探测到 `sessionid`（抖音）或 `SESSDATA`（B站）即保存并返回 confirmed。
- `POST /api/dsh-watch-later/login/chrome/cancel` `{ provider }` → 关闭该登录窗口。
- 实现模块：`login/chrome-login.js`；Chrome 路径探测、端口 9300–9399、profile 目录
  `~/.dsh/storages/watch-later/login-chrome/<provider>`（保留登录态，下次可免登录）。
- 两平台都保留「手动粘贴 Cookie」作为兜底入口。

UI 契约（ui-builder）：同步页 B站卡片增加「扫码登录」按钮 → 弹窗显示二维码 + 状态
（等待扫码 / 已扫码待确认 / 登录成功）；抖音卡片增加「打开登录窗口」按钮 → 弹窗提示去浏览器完成登录 +
轮询状态；成功后自动刷新 sync 状态并关闭弹窗。失败显示真实错误。二维码弹窗需支持刷新二维码与取消。

## 13. 内容直读 + 相似内容归纳（2026-11-06 追加）

### 13.1 内容预览 API

`GET /api/dsh-watch-later/content?id=<itemId>&refresh=1`
→ `{ ok: true, item: ItemView, content: Content }`
Content（也存进 item.content 缓存，`refresh=1` 强制重抓，默认缓存 7 天）：
```ts
{
  type: 'image' | 'video' | 'article' | 'page' | 'none'
  text: string | null       // 正文/描述纯文本（≤20000 字符，去 HTML）
  images: string[]          // 内容内图片 URL（≤6，绝对 http(s) 或本地 media 路径）
  video: null | {
    embedUrl: string | null // B站 https://player.bilibili.com/player.html?bvid=...
    url: string
    cover: string | null
    durationSec: number | null
  }
  fetchedAt: string
  error: string | null      // 抓取失败原因（小红书/需登录等）
}
```
规则：
- image 条目：type=image，images=[cover]；
- bilibili：调用公开 view 接口补 title/cover/desc + embedUrl；抖音：type=video，embedUrl=null（无公开播放器）；
- wechat/article/page/link：抓取 HTML 提取正文纯文本（≤20000 字）+ 内容图；失败返回 error，不抛；
- xhs：先用**手机 UA** 直取分享页（PC UA 只会拿到首页），解析 `noteData.data.noteData`
  （title/desc/imageList/tagList/user.nickName）；再依次兜底 bsk 真浏览器、无头 Chrome、PC cookie 抓取。
  撞到 `/404/sec_*` 风控页时返回 error 含「风控」字样（可重试），并只取 `og:image` 作图。
- 抓取超时 12s，不阻塞其它接口。

### 13.2 相似内容聚类与归纳

- 纯函数模块 `cluster.js`：
  `buildClusters(items)` → `{ groups: [{ id, memberIds: string[], representativeId: string, size: number }], hiddenIds: string[] }`
  - 只对「有链接/正文」的内容类条目聚类（kind: article/wechat/link/xhs/video/bilibili；image/drama/product/other 不参与）；
  - 相似度 = 归一化标题（去标点/空白/数字/年份）的字符二元组 Jaccard，同 site +0.1，tags 交集 +0.05/个；阈值 ≥0.55 视为相似（并查集合并）；
  - 每个 group 的 representativeId = 综合分最高者（分数接近时优先 wechat/article，再按 createdAt 新→旧）；
  - size<2 的 group 不输出。
- snapshot（默认 `settings.dedupeClusters=true`）：
  - `items` 中**隐藏非代表条目**（进入 representative 的 `cluster` 字段）；
  - representative ItemView 增加：
    ```ts
    cluster: { id: string, size: number, memberIds: string[], titles: string[] } | null
    ```
  - `counts.duplicates` = 被隐藏的相似条目数。
- `POST /api/dsh-watch-later/cluster/review` `{ id }`（id=代表条目 id）→
  `{ ok, summary: string, members: [{id,title,url}] }`
  用 AI 把同组标题/摘要归纳成 2-3 句「这几篇在讲什么 + 建议看哪篇」，写入 representative 的 `ai.clusterSummary`；AI 不可用返回 error。
- settings 增加 `dedupeClusters: boolean`（默认 true），关闭后快照返回全部条目。

UI 契约（ui-builder）：
- 卡片/抽屉新增「预览」：图片全宽查看（可点开大图）、B站视频内嵌播放器（embedUrl iframe）、文章/链接显示正文前若干段（可滚动）＋「打开原文」；抓取失败显示 error + 打开原文按钮。
- 相似内容：卡片角标「相似 N 篇」；抽屉里列出同组标题（可点开各自原文）＋「AI 归纳」按钮（调 cluster/review）＋归纳结果展示。
- 设置页增加「合并相似内容」开关（dedupeClusters）。

## 14. 图片专区 + 加入素材库（2026-11-06 追加）

用户说明：截图往往是想加入「设计素材库」的参考图，图片类要单独一个 tab 重点看。

### 14.1 后端

- `POST /api/dsh-watch-later/library/push` `{ ids: string[], force?: boolean }` →
  `{ ok, results: [{ id, ok, error?, libraryItemId? }], pushed, failed }`
  - 只接受 `kind==='image'`（或 `contentType==='image'`）的条目；
  - 取图优先级：本地 media（`cover=/api/dsh-watch-later/media?f=xxx`，读 media 文件）→ http(s) cover（服务端下载）→ 无图返回 error；
  - 调用同机设计素材库插件 `POST /api/dsh-design/item`：
    `{ item: { title, tags: [...item.tags, '稍后再看'], notes: summary, sourceUrl, sourceName: '稍后再看' }, imageData: data:image/... }`，
    `styleId` 省略（素材库落到默认风格）；设计素材库未安装/未运行时返回可读 error；
  - 成功后条目标记 `libraryPushedAt` / `libraryItemId`（ItemView 可见）；非 force 时已推送的跳过并返回 `{skipped:true}`。
- item 模型新增字段：`libraryPushedAt: string|null`、`libraryItemId: string|null`。

### 14.2 UI（ui-builder）

新增 tab「图片」，顺序：今日 / **图片** / 收件箱 / 资料库 / 时效 / 同步 / 设置。
- 只展示 `kind==='image'` 的条目；大图网格（每行 2–4 张，随宽度自适应），hover 出现勾选框；
- 顶部：图片总数 / 已加入素材库数 / 「加入素材库」批量按钮（有选中时出现选中数）；
- 筛选：全部 / 待整理（status=inbox）/ 已处理（done）；
- 卡片：缩略图（无原图时显示「无原图」占位 + 说明「早期聊天转发只存了标题」）、标题一行、已加入素材库角标；
- 点击卡片 → 直接打开大图 lightbox（可直接看截图），lightbox 内有「详情」按钮打开原抽屉、标题/来源/「加入素材库」/完成/归档；
- 批量操作：加入素材库（POST /library/push）、完成（/action done）、归档（/action archive，失败提示即可）、删除（二次确认 → /delete）；
- 加入素材库成功后 toast「已加入素材库 N 张」，失败逐条提示 error，并刷新 snapshot（libraryPushedAt 角标出现）；
- 空态：提示「截图后分享到 DeepSeek Harness，或在面板 + 添加 → 图片」，并给「去添加」按钮。
- 只改 client.js，沿用 token/无新依赖。

## 15. 右上角「登录授权」中心（2026-11-06 追加）

用户要求：小红书这类需要登录才能看正文的来源，要在插件右上角给登录授权入口。

### 15.1 后端

- snapshot 新增 `accounts`：
  ```ts
  accounts: {
    bilibili: { configured: boolean, account: string | null },
    douyin: { configured: boolean, account: string | null },
    xiaohongshu: { configured: boolean, account: string | null },   // 小红书无昵称，account 恒 null
  }
  ```
- Chrome 登录窗支持 provider：`douyin` / `bilibili` / `xiaohongshu`（登录页 https://www.xiaohongshu.com/，
  判定 `web_session` 或 `a1`，cookie 域 xiaohongshu.com）。
  `POST /login/chrome/start|poll|cancel { provider }` 三个接口已泛化。
- 新增 `POST /login/logout` `{ provider }` → 清掉该平台 cookie 与账号状态，返回 `{ ok, accounts }`。
- 内容直读：小红书优先用手机 UA 抓分享页并解析 `window.__INITIAL_STATE__`，两种形态都认：
  PC 版 `note.noteDetailMap[<id>].note`、手机版 `noteData.data.noteData`（title/desc/imageList/tagList/user）。
  图集落本地媒体库（按文件头判真实格式，图床常把 WebP 塞进 `.jpg` URL）；被 sec 风控时退避重试。

### 15.2 UI（ui-builder）

- 面板 header 右上角新增一个常驻「登录授权」图标按钮（钥匙/盾牌线性图标，沿用 16px 图标规范），
  点开「登录授权」弹窗；弹窗里三行：小红书 / B站 / 抖音。
- 每行：平台名 + 状态（已登录 / 未登录，来自 snapshot.accounts）+ 操作按钮：
  - 小红书：「打开登录窗口」（chrome start/poll xiaohongshu，独立 Chrome 里扫码/登录，成功自动保存并关窗）
  - B站：「扫码登录」（复用现有 QR 登录组件/端点）；也可保留同步页入口
  - 抖音：「打开登录窗口」（chrome start/poll douyin）
  - 已登录平台额外显示「退出登录」（POST /login/logout）
- 弹窗底部说明：「Cookie 只保存在本机 ~/.dsh/storages/watch-later/secrets.json，不会上传」。
- 状态变化后 reload snapshot；错误显示真实原因（如没装 Chrome）。
- 弹窗复用现有 Modal/Toast/token 样式；无新依赖。

### 15.3 手动确认登录（补充）

自动检测不一定可靠（小红书未登录访客也有 web_session）：新增
`POST /login/chrome/confirm { provider }` → `{ ok, accounts, error? }`：
- 从当前登录窗口读全部 cookie；小红书会先用该 cookie 真实抓一条已有小红书条目验证，
  抓不到正文则回滚 cookie 并返回「还没检测到小红书登录，请先登录后再点」；
- 成功后保存 cookie、关闭登录窗口、返回最新 accounts。
UI：登录授权弹窗里，Chrome 登录类平台（小红书/抖音/B站打开登录窗口时）除自动轮询外，提供
「我已完成登录」按钮调用该接口，失败显示真实原因。

### 15.4 小红书正文抓取（2026-11-06 追加）

现象：小红书会按 **TLS 指纹** 把 Node/undici 的请求 302 到 `/login?redirectPath=...`，所以即使登录了，服务端 fetch 也拿不到正文（而且给的是 200 空 body）。

做法：
- `login/chrome-login.js` 新增 `fetchPageViaBrowser({ url, provider })`：临时 profile 启动无头 Chrome（CDP），
  在页面还处于 `__INITIAL_STATE__` 存在时立刻抓 `document.documentElement.outerHTML`（页面随后可能跳风控页，所以要抢拍），
  失败自动重试一次，抓完必杀进程、删临时 profile。
- `content.js` 小红书分支：先用无头 Chrome 渲染再解析 `note.noteDetailMap`，HTTP fetch 仅作兜底；**不要求登录**（公开笔记游客也能看）。
- 解析出的图床图片用带 referer 的请求落到本地媒体库（最多 9 张），返回 `/api/dsh-watch-later/media?f=...`，避免面板图片被防盗链。
- 手动确认登录（`/login/chrome/confirm`）不再被“探测正文”拦下：用户点了就保存 cookie，`verified` 标记仅供参考。

## 16. 列表封面自动补齐（2026-11-06 追加）

- 文章类条目（`xhs` / `wechat` / `link` / `article`）如果列表里没有图，自动解析一次 `/content`，
  把正文图片落本地媒体库，第一张设为 `cover`、其余写进 `images`（≤12）。
- 触发：插件启动后 4s 补一批（上限 20）；之后每 5 分钟补漏（上限 10）；`watch_later_save`
  存入小红书/公众号/链接后异步补；`POST /enrich/covers {limit?, force?, kinds?}` 手动补。
- 如果条目缓存过失败结果（旧版本抓不到小红书），补图时会强制重抓一次，避免陈旧缓存挡住。
- 打开内容预览（`/content`）时也会顺手把解析到的图片写回 `cover` / `images`。
- 限制：公众号文章被官网验证页拦截、小黑盒动态页无法提取时跳过（不生成假封面）。

## 17. 「Agent」tab（2026-11-09 追加）

用户转发的 agent 相关内容很多（DSH 插件 / skill / 提示词 / GitHub 仓库 / Agent 工具文章），不想逐条读，要一个「Agent」tab：列表形式、每条一个「尝试一下」按钮，点了把内容**加载到 DSH**（新会话里预填一条提示词，用户可直接发送）。

### 17.1 后端（已实现）

- 每条 item 的 snapshot view 新增：
  ```ts
  agent: {
    relevant: boolean,                    // 本地启发式：GitHub/Gitee/npm 仓库，或标题里插件/skill/prompt/提示词/mcp/agent/智能体/workflow/DSH 等关键词（且带 AI 语境）
    kind: 'plugin' | 'skill' | 'prompt' | 'agent' | null,
    status: 'new' | 'opened' | 'tried' | 'skipped'   // 默认 new
  }
  ```
- `agentStatus` 可通过已有 `POST /update {id, patch:{agentStatus}}` 持久化（非法值报错）。
- 关键词规则在 `agent.js`：`agentInfo(item)` / `isAgentRelevant(item)` / `agentKindOf(item)`；不调用 AI、不改原字段。

### 17.2 UI（ui-builder）

- 新增第 8 个 tab **Agent**（放在「图片」之后，label 就是 `Agent`，图标沿用 16px 线性规范，可用 `spark`/`bot` 类 glyph）。
- 列表形式（不是卡片网格）：只取 `item.agent.relevant===true` 且状态为 inbox/queued/doing 的条目；
  行内显示 kind 徽章（插件 / Skill / 提示词 / Agent）、标题（点击开抽屉）、来源、状态 chip。
- 顶部筛选：全部 / 未试 / 已载入 / 已试 / 跳过；tab 上可带未试数量角标。
- 每条操作：
  - 「尝试一下」（主按钮）：见 §17.3 流程，成功后 `agentStatus='opened'` + toast「已载入 DSH 新会话」；
  - 「标记已试」→ `agentStatus='tried'`；「跳过」→ `agentStatus='skipped'`；都走 POST /update 后刷新 snapshot。
- 空状态：还没有识别到 Agent 相关内容，提示「转发的 GitHub 仓库/插件/skill/提示词会自动出现在这里」。
- 状态筛选/操作后本地更新或重新拉 snapshot；按钮有 loading，失败 toast 真实错误。

### 17.3 「尝试一下」加载到 DSH（复用原生接收插件的能力）

```js
const workspace = await ctx.workspaces.initializeDefault()
const sessionId = await ctx.sessions.create({ workspaceId: workspace.workspaceId })
const reference = ctx.sessions.retain(sessionId, { source: 'watch-later', signal })
await reference.ready
const scoped = ctx.sessions.scope(sessionId)
const input = ctx.conversation.input.for(scoped)
input.actions.setDraft(prompt)
input.actions.persistDraft?.()
ctx.uiWorkspace.openSession(sessionId)   // 跳到新会话
reference.release()                      // finally
```

- 能力缺失（ctx.sessions/workspaces/conversation/uiWorkspace 任一不可用）：降级为复制 prompt 到剪贴板 + toast「已复制提示词，去 DSH 新会话粘贴」，仍标记 opened。
- prompt 模板（中文）：
  ```
  帮我试试这条内容（来自「稍后再看」的 Agent 分类）：
  标题：{title}
  来源：{site} {url}
  摘要：{summary}

  请先判断它是什么（DSH 插件 / skill / 提示词 / 工具或文章），能不能直接在当前 DSH 里用：
  - 是插件/skill/prompt：给出安装或试用步骤、风险，再按我的确认执行；
  - 是文章/教程：提炼其中可直接照做的部分，给我一个最小可试方案。
  先别修改系统或装东西，等我确认。
  ```
- 点「尝试一下」后即使切走也没关系（会话已建好）；失败不改变 agentStatus。

## 18. 封面兜底（2026-11-09 追加）

微信文章抓取常被验证页拦截，导致列表里大量图文条目没有封面。现在 cover-backfill 在「正文解析不到图片」后：

1. 链接类条目先抓站点 favicon：`GET <origin>/favicon.ico`，只接受 png/jpeg/webp/gif 位图（ICO/SVG 不接受），按域名缓存；
   `mp.weixin.qq.com` 直接跳过（统一图标没意义）。
2. 仍没有就生成一张 SVG 封面（`cover-art.js`）：600×375，按 kind 配色渐变 + 大号标题首字 + 来源 + 标题，落到媒体库作为 cover。
   - 媒体服务支持 `.svg`（image/svg+xml）；生成内容只做 XML 转义，不含脚本/外链。
3. 已有的封面不会被覆盖（`force` 除外）；已经有封面的条目不再反复重试，避免公众号验证页每 5 分钟重抓。
4. 图片条目缺原图时不生成封面，仍走客户端「无原图」占位（UI 侧美化）。

## 19. 「想玩」tab + game 类型（2026-11-09 追加）

用户反馈：转发的**游戏测评/攻略**和**剧集/番剧**都是「以后要玩/要看」的东西，散在 link / wechat / xhs 里找不到，要求「列到稍后再玩，或者搞个娱乐分类把剧集动画游戏放一起」。方案：一个 tab 收三类。

### 19.1 数据模型

- `Kind` 增加 **`game`**（label「游戏」，weight 0.7，icon `game`）；`drama`（剧集）沿用。`KINDS` 里 `game` 排在 `drama` 之后、`article` 之前。
- 不新增字段：分组复用 `status`——`inbox`+`queued` = 想玩，`doing` = 在玩，`done` = 玩过。
- 「标记想玩」= 把 `kind` 改成 `game`（剧集则保持 `drama`）；取消则回退到 `link`。

### 19.2 分类规则（classify.js）

- `detectGame`：`GAME_WORD_RE`（测评/评测/评分/试玩/通关/攻略/支线/限时任务/隐藏内容/开箱/想玩/周目/掉率/赛季/天梯/段位/mod/DLC/补丁说明/首发/预售/主机版）× 平台线索（小黑盒/Steam/TapTap/NGA/游戏媒体/主机/B站），或「游戏词 + 《作品名》」。
- `detectGame` 优先于 `detectDrama`（游戏攻略标题常带「集/季」等字）。
- `detectDrama` 放宽：`《剧名》第 N 集/话/期` 不再强制要求平台词；`DRAMA_WORD_RE` 增加 新番/番剧/动画/剧场版/电影。
- URL 在 `removeUrls` 里已被剥掉，平台线索改为拼上 `classifyUrl` 给的 `site`（`detectText`）。
- `SITE_RULES` 增加：`xiaoheihe.cn` → link/小黑盒；`store.steampowered.com` → **game**/Steam。

### 19.3 一次性迁移（store.js `migrateWantTags`）

带 tag `想玩` 但 `kind` 不是 game/drama 的老条目，启动时按标题关键词升级（含 剧/番/动画/电影/第N集 → drama，其余 → game），跑完写 `state.migrations.wantV1`，不再重复。

### 19.4 UI（client.js）

- 第 9 个 tab **想玩**（`id: 'want'`），排在「图片」之后；badge = game+drama 且未归档条数。
- 三段分组：想玩 / 在玩 / 玩过；卡片带快捷「标记玩过」；空态引导 + 添加。
- 抽屉底部增加「标记想玩 / 取消想玩」，走 `POST /update {id,patch:{kind}}`。

## 20. 「影游」tab（2026-11-09 追加，改写 19.4）

**本节改写 19.4**：不再新增 tab，而是把现有 `id:'want'` 的「想玩」tab 更名为「影游」，内部分组从「想玩/在玩/玩过」改为两类。用户把「想玩/想看」统一改名为「影游」，并要求这个集合按两类展示：
- **攻略 / 原文整理**：攻略、评测、解析、汇总等有实质内容的东西；
- **清单**：单纯列游戏/影视作品（封面 + 名称）的片单、游戏单、单部作品登记。

### 20.1 后端（已实现）

- 标签批量改名：`想玩` / `想看` → `影游`；所有 game/drama 条目补 `影游` 标签。
- 每条 item 的 snapshot view 新增：
  ```ts
  media: {
    relevant: boolean,              // kind=game/drama 或标签含「影游」
    group: 'guide' | 'list' | null  // 手动 mediaClass 优先，其次启发式
  }
  ```
- `mediaClass` 可通过 `POST /update {id, patch:{mediaClass:'guide'|'list'}}` 修改（非法值报错）。
- 启发式在 `media.js`：标签/标题含攻略/评测/解析/汇总/数据等 → guide；标题含清单/片单/合集/盘点/推荐/好番/榜单等 → list；
  无链接且无正文 → 视为单部作品登记 → list；其余 guide。

### 20.2 UI（ui-builder）

- **复用现有 `id:'want'` 的 tab**，label 从「想玩」改为「影游」（位置保持「图片」之后；图标沿用现有）；不要新增第 9 个 tab。
- 只取 `item.media.relevant===true` 且 status ∈ inbox/queued/doing 的条目。
- 内部分组从「想玩/在玩/玩过」改为两个区块/筛选：
  1. **攻略 / 原文整理**（media.group==='guide'）：列表行：小封面 + 标题 + 来源 + 「攻略」徽章；右侧「标为清单」按钮。
  2. **清单**（media.group==='list'）：封面+名称的卡片网格（只显示封面和标题，像作品墙）；hover 可显示来源；底部「标为攻略」按钮。
- 顶部筛选：全部 / 攻略 / 清单，带各自数量；tab 角标 = 全部影游条目数。
- 空状态：「还没有影游内容；转发游戏/影视相关文章会自动归类」，以及分组的空态。
- 点击条目仍打开原抽屉；标类走 POST /update {id,patch:{mediaClass}} 后刷新 snapshot + toast。
- 复用现有 Cover/Modal/Toast/token；无新依赖、无 JSX、无 hex；ZH/EN 补齐；旧断言保持通过。

## 21. 真实封面优先 + 搜狗微信搜索（2026-11-09 追加）

用户反馈：很多封面只是「标题头两个字」的生成图，要求后续解析文章、用文章封面图补齐；
并点名用 `wechat-article-search`（WorkBuddy 的同源搜狗微信搜索）让预览信息更清楚。

### 21.1 封面优先级（cover-backfill.js）

1. **微信文章**：`sogou.js` 搜「标题」→ 匹配结果 → 下载 mmbiz 真实缩略图存为 cover；同时补 summary（搜狗摘要）、author（公众号）、site=公众号。
2. **其它文章**：`resolveContent` 解析正文，优先 `og:image` / `twitter:image`，其次正文图片；有图就替换生成封面。
3. 链接类：站点 favicon。
4. 最后才生成 SVG（标题首字），仅兜底；已有生成封面的条目会继续尝试真封面，但不会重复生成。

### 21.2 搜狗细节（sogou.js）

- 搜索 `https://weixin.sogou.com/weixin?type=2&query=<标题>&ie=utf8`，Chrome UA + referer；
- 解析 `sogou_vr_11002601_box_*` 结果块：标题/摘要/公众号/时间/`img01.sogoucdn` 缩略图里的 mmbiz URL；
- 标题相似度：全等 1、包含 0.55+0.4×长度比、否则二元组 Dice；阈值 0.55；
- 频率：每次请求间隔 2.4–4.2s；检测到 `antispider`/验证码 → 本轮停止后续搜索；
- 状态：`~/.dsh/storages/watch-later/sogou-covers.json` 记录每个条目查询时间和结果，7 天内不重复查；
- 不抓正文（微信对非客户端一律验证页），只补真实封面/摘要/账号，不改原文正文缓存。

## 22. 影游「清单」= 作品清单（2026-11-09 追加，修正 §20 的清单定义）

用户要求：影游的清单不能直接列原文链接；要**去获取作品的封面和标题来构建清单**，原文链接只在作品详情里展示。

### 22.1 后端（已实现）

- 新模块 `works.js`：
  - `extractWorkNames(item)`：从影游条目标题提取作品名（《…》/【…】优先，其次清洗「攻略/评测/汇总/第N集/截图」等后缀）；
  - `lookupWork(title, kind)`：Bangumi v0 搜索（game→type 4；drama→type 2/6），短标题只接受完全相等/前缀，避免「死锁」误配成「瑞奇与叮当 死锁」；下载真实封面存入媒体库，返回标准标题/简介/subjectId；
  - `syncWorks()`：从 game/drama/影游条目的作品名同步作品清单，按 Bangumi subjectId + 标题去重；作品记录 `{id,title,kind,cover,summary,sourceUrl,sourceTitle,sourceItemId,status,subjectId}`；
  - 存储 `~/.dsh/storages/watch-later/works.json`；启动后 8s 同步一次，之后每 10 分钟同步。
- snapshot 新增 `works` 数组（由 API 层附加）。
- 新接口：
  - `POST /works/sync {force?}` → 重新提取作品（返回 works）；
  - `POST /works/update {id, patch:{status:'want'|'playing'|'done'}}`；
  - `POST /works/delete {id}`。

### 22.2 UI（ui-builder）

- 「影游」tab 的**清单区块改为渲染 `snapshot.works`**（不再用 mediaClass='list' 的条目）：
  - 作品卡：封面 + 标题（作品卡不显示原文链接/来源，保持干净）；网格 4:3 封面；
  - 点作品卡打开作品详情弹窗：大封面 + 标题 + kind 徽章（游戏/剧集）+ 简介（有则显示）+ **来源区：文章标题 + 「打开原文」链接（sourceUrl 存在时才显示）** + 状态按钮 想玩/在玩/玩过（POST /works/update，toast + 刷新）；
  - 清单空态：「还没有作品清单；影游条目会自动提取作品并抓封面」；
  - 影游 toolbar 右侧加「同步清单」小按钮：POST /works/sync 后刷新 snapshot，loading 态。
- 攻略区块继续用条目的 `item.media.group==='guide'`，并排除 `mediaClass==='list'` 的条目（它们只是清单来源，不再占攻略区）。
- 筛选数量：攻略=guide 条目数，清单=works.length；tab 角标仍=影游条目数。
- 之前的条目级「标为清单/标为攻略」按钮从影游 tab 移除（清单不再是条目分类）；保留 `mediaClass` 字段兼容。

## 23. 收件箱分类筛选（2026-11-09 追加）

用户反馈：收件箱（status=inbox）内容没有分类筛选，堆在一起找东西不方便。

### 23.1 UI（ui-builder，只改 client.js）

- InboxView 在提示条下方增加一行分类筛选 chips（复用现有筛选 chip / token 样式）：
  - **全部**（默认）/ **图片** / **文章** / **视频** / **影游** / **其他**；
  - 分类映射：
    - 图片：kind === 'image'
    - 文章：kind ∈ xhs / wechat / link / article
    - 视频：kind ∈ video / bilibili / douyin
    - 影游：kind ∈ game / drama
    - 其他：kind ∈ other / product
  - 每个 chip 显示分类数量（基于当前 inbox 条目）；默认全部，切换后只渲染该分类条目；
  - 全部分类数量为 0 的 chip 仍显示但为禁用/淡态（保持布局稳定）；
  - 切换后空分类给轻量空态（「这个分类下还没有内容」），不影响整体空态文案；
- 不改后端、不加新 tab、不改 API；纯前端过滤。
- 旧断言保持通过，新增断言：chips 渲染与数量、切换过滤、每个分类映射、空分类状态。

## 24. 影游清单 = 影视库/游戏库（2026-11-09 追加）

用户明确：**要从文章提取作品**；清单要像「影视库/游戏库」，不是两条原文条目。

### 24.1 后端（已实现）

- `POST /works/extract {itemId}`：
  - 先 `resolveContent(item,{force:true})` 拿正文（小红书等可解析来源）；
  - `ai.extractWorks(ctx,item)` 用 LLM 从正文提取作品 `{works:[{title,type:'game|anime|drama|movie'}]}`；
  - 逐个 `works.addWork()`：Bangumi 查标准标题/封面/简介，去重入库，source 记录该文章；
  - 返回 `{ok,extracted,added,works,failed}`；正文拿不到时返回真实错误（提示公众号需能解析正文）。
- `POST /works/add {title,kind:'game'|'drama'}`：手动添加作品（Bangumi 查封面，去重）。
- works 列表在 snapshot.works。

### 24.2 UI（ui-builder）

- 「影游」tab 清单区改成**媒体库样式**：
  - 竖版海报网格（2:3 封面，圆角，hover 轻微放大/阴影），封面下方标题（2 行截断）+ kind 徽章（游戏/影视）；
  - 清单内筛选：全部 / 游戏 / 影视（带数量），默认全部；
  - 空态：「还没有作品清单，从攻略文章提取或手动添加」。
- 攻略区每条行增加「提取作品」按钮：POST /works/extract {itemId}，loading，成功 toast「已从文章提取 N 个作品」失败 toast 真实错误；成功后刷新 snapshot。
- 清单 toolbar 增加「+ 添加作品」按钮：弹窗输入名称 + 选择类型（游戏/影视）→ POST /works/add → 成功 toast + 刷新；错误 inline 显示。
- 保留「同步清单」按钮；作品详情弹窗保持（封面/简介/来源文章+打开原文/状态）。
- 只改 client.js；旧断言保持，新增：清单媒体库卡片、清单内 游戏/影视 筛选数量、提取作品按钮调用与 toast、添加作品弹窗 payload、空态。

## 25. 粘贴正文提取作品（2026-11-09 追加）

公众号正文无法自动抓取，文章里的作品提取需要一条可靠兜底：允许用户把正文粘进来提取。

### 25.1 后端（已实现）

- `POST /works/extract-text {title?, text, sourceUrl?}`：
  - text 至少 80 字；
  - 复用 `ai.extractWorks` 从粘贴正文提取作品 → `works.addWork()` 查 Bangumi 封面入库；
  - 返回 `{ok,extracted,added,works,failed}`。

### 25.2 UI（ui-builder）

- 影游 toolbar 在「+ 添加作品」旁新增「从正文提取」按钮：打开弹窗，含「文章标题（可选）」「文章正文（粘贴）」「来源链接（可选）」+ 提交；
  - 正文 <80 字 inline 提示；
  - 提交 POST /works/extract-text，loading，成功 toast「已提取 N 个作品」+ 刷新 snapshot，失败 toast/inline 真实错误。
- 影游攻略行的「提取作品」失败提示里补充「可复制正文后用『从正文提取』」。
- 保留现有「+ 添加作品」「同步清单」「提取作品」按钮和作品详情。

## 26. 「AI 整理」状态机（2026-11-09 追加，重写 §2 的 ai 字段）

用户要求：所有内容都要能一眼看出「已 AI 整理 / 未整理」，整理要补真封面、清洗标题，
队列要能整理**全部**未整理内容（不只是今日推荐），并且允许 AI 按现有分类体系重新归类。

### 26.1 判定口径（organize-core.js，唯一实现）

| state | 含义 |
| --- | --- |
| `none` | 没整理过。v1 的 `ai.classified` 布尔**不再算数**（启发式也会写 true），迁移时统一降级 |
| `partial` | 整理过一轮但没达标，还能再补 |
| `done` | 标题、摘要、真封面、分类四项同时达标 |
| `failed` | 这一轮抓取/模型失败，原因在 `ai.lastError` |

四项达标判据：
- 标题：6–40 字，且不像文件名/URL/聊天记录残渣（`looksLikeGarbageTitle`）；
- 摘要：≥12 字，且不是标题的复述（`summaryIsUsable`）；
- 封面：必须是真图，SVG 占位**不算**（`isRealCover`）；
- 分类：`tags[0]` 落在 `TOPICS` 里且不是「待归档」。

标题改写守门 `titleIsTrustworthy`：旧标题是垃圾时放行；否则新旧标题字符重合度需 ≥34%，
防止模型编一个完全无关的标题。改写前的原标题存进 `item.titleRaw`（只记第一次）。

### 26.2 Item 字段

```jsonc
{
  "titleRaw": "微信图片_202609041513_12",   // AI 改写前的原标题，撤销用
  "ai": {
    "state": "none|partial|done|failed",
    "version": 2,
    "fields": ["title", "topic"],            // 这次真正改了哪些字段
    "reason": "一句话理由",
    "confidence": 0.86,
    "at": "2026-11-09T06:40:00.000Z",
    "lastError": null,
    "suggest": { "kind": "game", "topic": "游戏" },  // 低置信时的建议，不改动数据
    "prev": { "title": "旧标题", "kind": "link", "topic": "设计" } // 撤销快照
  }
}
```

分类/类型是**高置信才改**：`confidence < 0.7` 时只写 `ai.suggest`，不动 `kind`/`tags`。

### 26.3 HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/ai/organize` | body `{mode:'all'|'pending', limit?}`；启动后台任务，立刻返回 `{ok, job, total, remaining}` |
| GET | `/ai/status` | `{ok, job:{running,total,processed,done,partial,failed,current,startedAt,finishedAt,lastError,cancelled}, remaining}` |
| POST | `/ai/cancel` | 请求停止，跑完当前批即停 |
| POST | `/ai/undo` | body `{id}`；按 `ai.prev` 还原标题/类型/分类，状态打回 `none` |
| POST | `/ai/review` | 兼容旧调用，改为走整理流水线，最多 12 条 |

流水线（organize.js）分三段，各自失败各自兜底：
1. 抓正文（`resolveContent`，7 天缓存，仅链接类）；
2. 补真封面（`backfillCovers({ids, force, allowGenerated:false, includeAll:true})`，不生成 SVG）；
3. 模型判类型/分类/标题/摘要 → 写回并判定 state。

### 26.4 Snapshot

`counts.organize = {total, done, partial, none, failed, pending}`，覆盖全部条目（含已完成/已归档）；
`pending = total - done`。

### 26.5 迁移

`migrations.aiStateV1`：给所有没有 `ai.state` 的存量条目补 `state:'none'`，
旧的 `ai.classified` 保留字段但不再作为判据，`classified` 现在由 `state !== 'none'` 派生。

## 26. Agent 列表：名称+作用标题、三分类（2026-11-09 追加）

用户要求：Agent 列表里把技能/插件/提示词的**名称、作用**作为标题，并按 **提示词 / 插件 / Skill** 三类筛选。

### 26.1 后端（已实现）

- `ai.enrichAgentItems(ctx, batch)`：LLM 为每条 agent 相关条目生成 `{name, purpose, category}`（category ∈ prompt/plugin/skill），写入 item：
  - `agentName`（≤80 字）、`agentPurpose`（≤160 字）、`agentCategory`（prompt/plugin/skill）。
- snapshot `item.agent` 增加 `name` / `purpose`，`kind` 优先取 `agentCategory`。
- `POST /agent/enrich {limit?}`：批量补名称/作用/分类（每次最多 60，8 条一批）；启动 12s 后自动补齐 24 条，之后每 10 分钟补 8 条。
- 未分类的条目（agentCategory 为空）不算三类之一。

### 26.2 UI（ui-builder）

- Agent 列表行标题改为 `agent.name || item.title`，副标题/摘要显示 `agent.purpose || item.summary`；kind 徽章显示 提示词/插件/Skill。
- 顶部筛选改为 **全部 / 提示词 / 插件 / Skill**（带数量，默认全部）；只展示 agent.kind ∈ prompt/plugin/skill 的条目。
- tab 角标 = 三类条目总数（而非全部 relevant）。
- toolbar 加「整理名称」按钮：POST /agent/enrich {limit:30} → toast「已整理 N 条」+ 刷新 snapshot；loading。
- 保留尝试一下 / 标记已试 / 跳过 / 空态（空态文案改为提示转发的插件/skill/提示词会自动整理）。

## 27. 公众号正文：真浏览器兜底通道（2026-11-09 追加）

### 背景
微信对**部分**公众号文章做文章级风控：curl / Node fetch / 无头 Chromium 一律 302 到
`mp/wappoc_appmsgcaptcha` 验证页（"环境异常，完成验证后即可继续访问"）。实测对照：
同一台机器、同一 UA、同一出口 IP（上海电信直连），队列里其他公众号文章能正常抓 2.6–3.5 MB
全文，只有个别文章被拦。所以这不是网络或代理问题，换工具也没用。

### 方案
接腾讯 BrowserSkill（`bsk` CLI，GitHub: Tencent/BrowserSkill）作为兜底：不破解验证码，
而是把页面放进用户**已登录的 Chrome** 里打开。落到验证页时点一下 `#js_verify`（"去验证"），
Chrome 里的信任态会自动放行，正文随即出现。

- CLI：`bsk` v0.4.2，装在 `~/.local/bin/bsk`，daemon 自动起在 `ws://127.0.0.1:<port>`。
- 扩展：CRX 从谷歌更新服务直下后解包，`Load unpacked` 到
  `~/.local/share/browserskill/extension-0.4.2`（商店页安装会报 `Image decode failed`）。
- 扩展必须保持"连接"开关打开；MV3 后台脚本会空闲休眠，`bsk doctor` 前 60 秒健康缓存可快速失败。

### 代码
- `wechat.js`：`fetchWechatHtmlViaBsk(url)`，全进程串行队列、必停 session、健康检查缓存 60s。
- `content.js`：`pageContent()` 里 `kind==='wechat'` 时，直连被拦或正文 < 120 字 → 走 bsk，
  拿到 HTML 后复用原有 `extractArticleText` / `extractImages` 解析；成功的 `content.via='bsk'`。
- `content.js`：新增 `contentNeedsRetry()` —— 缓存里存的是"被拦截"类错误时不算已抓取，
  否则接了浏览器通道后老条目会一直命中缓存不重试。
- `ai.js`：`prefetchIngestContent()` —— 「新增入库」流程在过大模型前先补公众号正文
  （原来只喂标题/摘要）。AI 整理流程本来就经 `resolveContent`，自动继承。
- `content.js`：`extractWechatCdnImages()` —— 全屏长图类文章不走 `<img>`，直扫微信图床域名。

### 已知边界
- 纯 JS 渲染 / 受限的公众号文章（如部分写真图集），浏览器通道拿到的 HTML 里既无正文也无图片，
  仍然返回"没有提取到正文"的 error，属于准确的能力边界。
- 扩展连接断开时 bsk 快速失败，条目降级为标题+摘要 + error，不影响入库。

## 28. 「失效」区（2026-11-09 追加）

被作者删掉、链接挂掉的条目不再混在今日/收件箱里，单独进「失效」tab，可批量删除或一键清空。

### 28.1 Item 字段

```jsonc
{ "invalid": { "reason": "小红书笔记已删除或不可见（404）", "at": "2026-11-09T08:10:00.000Z" } }
```

`invalid` 为 `null` 表示正常条目。

### 28.2 自动标记（store.setItemContent）

正文抓取写回时，如果 `content.error` 命中 `已删除|页面不见了|笔记不存在|链接已失效|404|不存在或已删除|已下线`，
自动打上 `invalid`；反过来，如果之后抓到了正文且带图，自动摘掉标记（防误杀）。

### 28.3 快照

- `snapshot.items` / `counts.*` **不含**失效条目；
- `snapshot.invalidItems: ItemView[]`（按 `invalid.at` 倒序）；
- `counts.invalid: number`；`counts.total` 仍是全部条目数。

### 28.4 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/delete` | `{ids:[...]}` 批量删除（最多 2000 条）→ `{ok,deleted,failed}`；`{id}` 单条仍兼容 |
| POST | `/invalid` | `{action:'mark'|'clear', ids:[...]}`；`clear` 用于「恢复」 |

## 29. 小红书风控闸门（2026-11-09 追加）

小红书按 IP 做风控：连续抓一百多条后整站 302 到 `/404/sec_*`（真浏览器里是
`error_code=300031 当前笔记暂时无法浏览`），连原来能打开的笔记也一起打不开。
所以「入库预抓 / AI 整理 / 封面补齐 / 详情页直读 / 失效巡检」五条链路统一过闸门 `xhs-guard.js`。

### 29.1 闸门行为

| 能力 | 规则 |
| --- | --- |
| 节流 | 两次小红书抓取间隔 ≥ 6 秒（`waitXhsTurn`，跨进程看 `lastFetchAt`） |
| 冷却 | 命中一次风控 → 冷却 30 分钟；连续命中翻倍（60 / 120 分钟封顶） |
| 冷却期内 | 直接返回 `error:「小红书风控冷却中（约 N 分钟后重试），本条先保留待补」`，**不打网络、不计失败、不写失效** |
| 命中判定 | 跳转 `/404/sec_*`、页面含 `xhs_sec_server`，或错误文案含 `sec_404 / sec_server / 风控 / 300031 / 暂时无法浏览` |
| 恢复 | 抓到正常笔记即清空连续命中与冷却 |

状态文件：`$DATA_DIR/xhs-guard.json`
```jsonc
{ "lastFetchAt": "2026-11-09T08:59:23.836Z", "blockedUntil": "2026-11-09T09:29:42.349Z",
  "consecutiveBlocks": 1, "lastBlockAt": "...", "lastSuccessAt": null }
```
`GET /health` 增加 `xhsGuard` 字段暴露同一份状态（`cooling / cooldownMs / consecutiveBlocks`）。

### 29.2 各链路接入点

- **入库预抓（ai.prefetchIngestContent）**：`CONTENT_PREFETCH_KINDS` 加入 `xhs`；冷却期内整段跳过，
  模型照常凭标题/摘要整理，正文下一轮再补。
- **AI 整理（organize.prepareContent）**：冷却期内不抓、不覆盖已有正文，条目留在 pending。
- **封面补齐（cover-backfill）**：冷却期内 xhs 全部跳过；正常时每条 ≥ 6 秒，连续两次被拦即停手。
- **失效巡检（organize.sweepInvalid）**：冷却期内跳过 xhs，避免把风控误判成「内容已失效」。
- **详情页（`GET /content`）**：命中冷却时秒回（实测 34ms），返回已有封面/正文，不再空等浏览器通道。

### 29.3 失效判定例外（修正 §28.2）

`store.setItemContent` 先判风控：

```js
const RISK_CONTROL_PATTERN = /sec_404|sec_server|风控|300031|暂时无法浏览|冷却中/i
if (contentError && RISK_CONTROL_PATTERN.test(contentError)) item.invalid = null   // 风控不是失效，并撤销误判
else if (contentError && DEAD_PATTERN.test(contentError)) item.invalid = { reason, at }
```

教训：2026-11-09 曾有 4 条小红书被风控挡住的笔记因为错误文案里带「404」被判成失效、从列表里消失。

## 28. 「移除」统一 + 已读写回（2026-11-09 追加，取代 §2 的 archive 语义）

### 背景
1. 原「归档」和「删除」是两个动作，主人要求合并成**一个「移除」**。
2. 同步以前是纯单向（平台 → 本地），本地删了下次同步还会复活；主人要求**移除要写回平台**。
3. 主人追加：**已读状态也要同步**。

### 平台能力边界
| 平台 | 移出稍后再看 | 标记已读 |
|---|---|---|
| B站 | ✅ `POST /x/v2/history/toview/del`（Cookie + csrf=`bili_jct`） | ❌ 无此接口 |
| 抖音 | ❌ 缺 `a_bogus` 签名，未实现 | ❌ |

所以「已读」在平台侧只能表达为**移出**；抖音两边都做不到，只在本地标记。

### 语义（本地）
- **已读 `done`**：平台移出 + **本地保留** status='done'，**不写墓碑**
- **移除 `remove`**：平台移出 + **本地删除** + 写墓碑

### aid 换算（关键坑）
`toview/del` 只认数字 `aid`，而同步存的是 `bvid`。**不能用 `bvidToAid` 纯算法反推**：
该算法只对早期 9 位 aid 成立，2026 年后新视频 aid 已到 15 位
（实测 `BV1MqxQ6FE4P` → 117557197539987），算出来是**别的视频的 aid**，拿去删除等于误删用户其他视频。

正确顺序：
1. 同步时把接口返回的 `aid` 存进 `sync.stats.aid`（`mapToviewItem` 已带出）
2. 老条目没有 `aid` → 调公开接口 `GET /x/web-interface/view?bvid=` 实时解析
3. `normalizeAids` **只接受** `av号` / 纯数字，传 bvid 直接跳过，不猜

### 墓碑
`DATA_DIR/removed-remote.json`，key = `provider:remoteId`。
- B站写回失败 → 写墓碑（本地已删、远端还在，不写就会同步复活）
- **抖音移除 → 必写墓碑**（写不回平台，否则下次同步又导回来）
- `sync-run.js` 的 `mergeRemoteItems` 循环开头查墓碑，命中就跳过

### 接口
- `POST /action {action:'remove'}` → 同 `/delete` 单条
- `POST /action {action:'done'}` → 本地置 done + 远端移出，响应带 `remote: {ok, unsupported, error}`
- `POST /delete {id|ids}` → `{removed, deleted, remoteRemoved, remoteFailed, unsupported, errors}`
- `archive` 动作已下线（返回 400）

### 迁移
`migrateArchivedV1`：存量 `status='archived'` → `'done'`，保留 `archivedAt`，
并把 `readAt/updatedAt` 刷新为当前时间——否则会立刻被 retention 判过期删掉。
