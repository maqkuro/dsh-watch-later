# sync/NOTES.md — B站 / 抖音「稍后再看」接入实测与限制

> 实测时间：2026-11-06 16:06–16:12（Asia/Shanghai）
> 环境：macOS，Node v22.23.1（内置 fetch/undici），curl 8.x
> 所有探测均为本机真实网络请求；测试文件 `test/sync.test.mjs` 不依赖真实网络。
> 文件职责：`sync/http.js`（HTTP 客户端）、`sync/bili.js`（B站）、`sync/douyin.js`（抖音）。

---

## 1. 结论速览

| 能力 | 结论 |
|---|---|
| B站账号信息（nav） | ✅ 真实可用，需要 Cookie（SESSDATA），未登录返回 `code=-101` |
| B站「稍后再看」列表 | ✅ 真实可用，`GET /x/v2/history/toview`，需要 Cookie（SESSDATA），单次返回全部（上限 100 条），无需翻页 |
| 抖音分享文案 → 短链 | ✅ 纯文本解析，稳定 |
| 抖音短链 → 视频 ID / 标准链接 | ✅ 实测 302 可解析（不登录也行） |
| 抖音 → 标题 / 作者 / 封面 | ❌ 无登录拿不到（见 §3.3），`resolveShareUrl` 返回结构化 error + 降级 item |
| 抖音「稍后再看」 | ⚠️ 网页端确实存在接口，但需要登录 Cookie，**未用真实登录 Cookie 验证过数据路径**（见 §3.4）；实现为 `supported:true` + 无 cookie 时返回可读错误，不伪造数据 |

---

## 2. B站实测

### 2.1 账号信息（nav）

```bash
curl -sS -m 12 'https://api.bilibili.com/x/web-interface/nav' \
  -H 'User-Agent: Mozilla/5.0 ... Chrome/124.0.0.0 Safari/537.36' \
  -H 'Referer: https://www.bilibili.com/'
```

未登录实测（HTTP 200）：

```json
{"code":-101,"message":"账号未登录","ttl":1,"data":{"isLogin":false,
  "wbi_img":{"img_url":"https://i0.hdslb.com/bfs/wbi/<hash>.png","sub_url":"https://i0.hdslb.com/bfs/wbi/<hash>.png"},
  "ip_region":"CN"}}
```

- 响应头同时带 `bili-status-code: -101`、`bili-trace-id`。
- 登录后 `code=0`，`data` 里用到的字段：`isLogin:true`、`uname`（昵称）、`face`（头像，可能是 http）、`mid`。
- 映射：`code=0 && data.isLogin===true` → `{ok:true,name,avatar,mid}`；否则按 `mapBiliCode()` 转人话。

### 2.2 单视频公开信息（view，无需 cookie）

```bash
curl -sS -m 12 'https://api.bilibili.com/x/web-interface/view?bvid=BV1GJ411x7h7'
```

实测 HTTP 200 + `code:0`，`data` 关键字段（与稍后再看列表项同源/同风格）：

| 字段 | 说明 |
|---|---|
| `bvid` / `aid` | 稿件 id |
| `title` | 标题 |
| `pic` | 封面（常为 `http://`） |
| `duration` | 时长（秒，数字） |
| `owner.name` / `owner.face` | UP主昵称 / 头像 |
| `pubdate` / `ctime` / `stat.*` / `pages[]` | 发布时间、分区、统计、分P |

非法 bvid 实测：HTTP 200 + `{"code":-400,"message":"请求错误"}`。

### 2.3 稍后再看列表（toview）

```bash
# 未登录
curl -sS -m 12 'https://api.bilibili.com/x/v2/history/toview'
# -> HTTP 200 {"code":-101,"message":"账号未登录","ttl":1}

# 伪造 SESSDATA
curl -sS -m 12 'https://api.bilibili.com/x/v2/history/toview' \
  -H 'Cookie: SESSDATA=bogus_invalid_value; bili_jct=abc'
# -> HTTP 200 {"code":-400,"message":"请求错误"}
```

请求参数：无（接口一次返回全部，B站「稍后再看」容量上限 100 条，与契约「单次最多取 100 条」一致）。
返回结构（字段名经官方社区文档 `bilibili-API-collect` 与公开 view 接口交叉核对）：

```json
{ "code": 0, "message": "0", "ttl": 1,
  "data": { "count": 25,
            "list": [ { "aid": 200333024, "bvid": "BV1Yz411B7n3", "title": "...",
                        "pic": "http://i1.hdslb.com/...", "duration": 218,
                        "owner": {"mid": 14082, "name": "山新", "face": "..."},
                        "add_at": 1587041785, "progress": 32, ... } ] } }
```

`bili.js` 映射：

| 契约字段 | 来源 | 备注 |
|---|---|---|
| `remoteId` | `bvid`，缺失回退 `av${aid}` | 两者都没有的脏数据直接跳过 |
| `title` | `title`，缺失回退 remoteId | trim |
| `url` | `https://www.bilibili.com/video/${bvid}` / `.../av${aid}` | |
| `cover` | `pic` | `http://`、`//` 统一升为 `https://`（防混合内容） |
| `author` | `owner.name` | 可空 |
| `durationSec` | `duration` | 秒；非法/0 → null |
| `addedAt` | `add_at`（unix 秒） | ISO 8601 UTC；非法 → null |

其他处理：
- 结果按 `addedAt` 降序（接口本身按添加顺序升序，导入最新在前面符合使用直觉），最多 100 条。
- `fetchWatchLater` 并发请求 nav（补 `account` 昵称）；nav 失败不影响列表结果。

### 2.4 B站错误码映射（`mapBiliCode`）

| code | 人话 |
|---|---|
| `0` | 成功 |
| `-101` | cookie 已失效或未登录，请重新粘贴 SESSDATA |
| `-400` | cookie 无效或请求被拒，SESSDATA 可能已过期/格式不对 |
| `-111` | CSRF 校验失败 |
| `-352` / `-412` | 触发风控，稍后重试/换网络 |
| `-403` | 访问权限不足 |
| `90001` | 稍后再看列表已满 |
| 其他 | `B站接口返回错误（code=…，message=…）` |

HTTP 层：`412` 风控、`403` 拒绝、`429` 限频、其他 `HTTP n`。

---

## 3. 抖音实测

### 3.1 分享文案 → 短链（`parseShareText`，纯逻辑）

真实分享文案形如：

```
7.43 复制打开抖音，看看【某某的作品】标题文字 #话题 https://v.douyin.com/iRNBho6u/ 复制此链接，打开Dou音搜索，直接观看视频！
8.97 mQx:/ 复制打开抖音，看看【某某的作品】…… https://v.douyin.com/xxxxxxx/ ……
```

解析规则：
- 优先匹配 `https?://v.douyin.com/<code>/`；也接受无 scheme 的裸 `v.douyin.com/<code>/`；
- 没有短链时兜底匹配 `douyin.com` / `iesdouyin.com` 的 `/video|note/<id>` 链接，并规范化为标准链接；
- 标题 = 原文去掉链接后，清掉「复制打开抖音，看看」「复制此链接，打开Dou音搜索，直接观看视频！」等样板文案、开头随机版本号/随机短码，压缩空白、截 120 字；只剩样板时返回 `null`；
- 找不到任何抖音链接 → 返回 `null`。

### 3.2 短链 302（`resolveShareUrl` / `followShortLink`）

```bash
curl -sS -m 12 -D - -o /dev/null 'https://v.douyin.com/iRNBho6u/' \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ... Chrome/124.0.0.0 Safari/537.36'
```

实测 HTTP/2 **302**：

```
server: Tengine
location: https://www.iesdouyin.com/share/video/7298145681699622182/?region=CN&mid=7298145762238565171&u_code=...&share_version=170400&from_ssr=1&from=web_code_link
```

- Node 22 `fetch(..., {redirect:'manual'})` 能直接读到该 Location（已用 node 实测），所以 `followShortLink` 手动跟跳、记录 hops，最多 5 跳。
- 无效短码（如 `https://v.douyin.com/zzzzzzzzzz/`）实测 302 到 `https://www.douyin.com/` 首页 → 识别不到视频 ID，返回结构化错误。
- 最终能稳定拿到：`aweme/video id` + 标准链接 `https://www.douyin.com/video/<id>`（图文为 `/note/<id>`）。

### 3.3 落地页元数据：无登录拿不到

实测三种落地 URL（2026-11-06）：

| URL | 结果 |
|---|---|
| `https://www.iesdouyin.com/share/video/<id>/`（移动端 UA） | HTTP 200，32KB HTML；含 `window._ROUTER_DATA`，**只有页面上下文**（`itemId`、`ua`、`query`、`abParams` 等），无 `aweme_id`/`desc`/`author`/`cover`；`<title>` 为占位「在抖音记录美好生活YYYYMMDD - 抖音」；无 `og:title`/`og:image` |
| `https://www.iesdouyin.com/share/video/<id>/`（桌面 UA） | 302 → `https://www.douyin.com/video/<id>?previous_page=app_code_link`；PC 页面是 JS 反爬挑战页（73KB `jsvm` 脚本），无元数据 |
| `https://m.douyin.com/share/video/<id>` | HTTP 200，结构同上，`_ROUTER_DATA` 同样只有页面上下文 |

接口尝试（全部失败）：

| Endpoint | 实测结果 |
|---|---|
| `GET https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=<id>` | 无 Referer：HTTP 200 + **空 body**；带 Referer：`{"status_code":11110,"status_msg":"encrypt_data_miss"}` → 需要未公开的 encrypt_data 签名 |
| `GET https://www.iesdouyin.com/aweme/v1/web/aweme/detail/?aweme_id=<id>` | HTTP 403 `Blocked by ArgusSecurityPlugin Uifid Not Found` |
| `GET https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=<id>` | HTTP 403 `Blocked by ArgusSecurityPlugin Uifid Not Found`（带 ttwid cookie 也不行） |
| `GET https://www.douyin.com/aweme/v1/web/hot/search/list/`（对照） | HTTP 200 正常 JSON → 说明不是全局风控，单是详情类接口需要签名/安全 cookie |

**结论：无登录拿不到标题、作者、封面。** 因此 `resolveShareUrl`：
- 能解析时返回 `{ ok:false, error:<说明>, item:{ remoteId, title:'抖音视频 <id>'(占位), url:<标准链接>, cover:null, author:null, durationSec:null }, resolved:{ url, hops } }`；
- 解析不到视频 ID 时返回 `{ ok:false, error }`；
- 解析器保留 `parseSharePageMeta()`（`_ROUTER_DATA` / `RENDER_DATA` / og / JSON-LD / `<title>` 兜底），并**过滤抖音通用占位标题**，页面改版后若能恢复元数据会自动 `ok:true`。
- ⚠️ 宿主不要拿 `ok:false` 时的 `item.title`（`抖音视频 <id>`）当真实标题；标题优先用 `parseShareText` 的 `title` 或分享原文。

### 3.4 抖音「稍后再看」调研

试过的 endpoint（2026-11-06，未登录）：

| Endpoint | 结果 |
|---|---|
| `GET https://www.douyin.com/aweme/v1/web/watchlater/list/?count=20&offset=0` | HTTP 200 `{"status_code":0,"items":null,"list_num":0,"has_more":false,"invalid_item_ids":[],"offset":0,...}`（未登录时空列表，不报错） |
| 同接口加完整 web 公共参数 / 伪造 `sessionid` cookie | 同上，仍为空 |
| `GET https://www.douyin.com/aweme/v1/web/user/profile/self/?aid=6383` | HTTP 200：`status_code:8“用户未登录”`，但附带 **`user_watchlater_count:{"status_code":0,"user_watchlater_count":0}`** → 证明网页端存在「稍后再看」能力与计数 |
| `GET .../aweme/v1/web/watchlater/add/`、`/del/`、`/count/` | HTTP 404 `Unsupported path(Janus)`（只有 `list` 是注册路由） |

结论：
- 抖音网页端**确实有**「稍后再看」列表接口 `/aweme/v1/web/watchlater/list/`，未签名请求能通过 Janus 安全层返回正常 envelope；登录后应返回数据。
- 但**没有真实登录 Cookie 可验证**数据路径（本机没有主人抖音 cookie；按约定不冒充登录）。因此：
  - `fetchWatchLater` 实现为 `supported:true`，**必须提供 cookie**；
  - 先用 `profile/self` 验证登录（`status_code=8` → 明确报「cookie 已失效/未登录」，避免把失效当成空列表）；
  - 再分页拉 `watchlater/list`（`count=20&offset=…`，最多 5 页 / 100 条），字段映射兼容 aweme 扁平结构与 `{aweme:{...}}` 包裹结构，`duration` 按毫秒→秒；
  - 无 cookie → `{ ok:false, supported:true, items:[], error:'…需要登录 Cookie…' }`，不伪造任何数据。
- **风险/待验证**：如果主人提供真实登录 Cookie 后实测仍返回空列表，说明该接口还需要未公开的 `a_bogus`/安全参数，应把 `fetchWatchLater` 回退为 `supported:false` 并在 error 中说明（代码 `supported` 字段已是参数化返回，改一处即可）。
- 如果宿主/UI 决定保持「抖音自动同步受限」的保守体验：忽略本能力即可，`ok:false` 文案已引导用户改用分享链接解析入库。

---

## 4. 模块与导出清单

### `sync/http.js`

```js
export const UA                     // 桌面 Chrome UA
export const MOBILE_UA              // 移动端 Safari UA（抖音分享页必须）
export const DEFAULT_TIMEOUT_MS     // 12000
export class RequestError           // code: TIMEOUT | ABORTED | NETWORK | PARSE
export function describeRequestError(err, opts?)   // -> 中文人话
export async function request(url, { method, headers, body, timeoutMs, signal, redirect })
// -> { status, url, ok, headers, text(), json() }
// headers 是「小写 key 的普通对象 + 非枚举 get()」，同时支持 headers['content-type'] 与 headers.get('Content-Type')
export default { ... }
```

- 默认 12s 超时（随 AbortController 生效，含读 body 阶段）；外部 `AbortSignal` 可取消；`redirect:'manual'` 可读 Location。
- `text()`/`json()` 结果缓存，重复调用安全；`json()` 非法时抛 `RequestError('PARSE')`。
- 模块顶层无请求、无副作用。

### `sync/bili.js`

```js
export async function fetchAccount({ cookie, signal })      // -> { ok, name?, avatar?, error? }
export async function fetchWatchLater({ cookie, signal })   // -> { ok, items[], account?, error? }
export const MAX_ITEMS = 100
export function buildCookieHeader(cookie)                   // 整段 Cookie 或裸 SESSDATA
export function mapBiliCode(code, message)
export function mapBiliHttpStatus(status)
export function normalizeBiliCover(pic)
export function mapToviewItem(raw)
export function parseToviewResponse(payload)                // -> { ok, items, count?, error? }
export function parseNavResponse(payload)                   // -> { ok, name, avatar, mid, error? }
export default { fetchAccount, fetchWatchLater }
```

### `sync/douyin.js`

```js
export function parseShareText(text)                        // -> { url, title|null } | null
export async function resolveShareUrl({ url, signal })      // -> { ok, item?, resolved?, error? }
export async function fetchWatchLater({ cookie, signal })   // -> { ok, supported, items[], account?, error? }
export function parseDouyinUrl(input)                       // -> { kind:'short'|'video'|'note'|'user'|'other', id, href, host } | null
export function resolveTargetFromUrl(input)                 // -> { kind, id, href } | null
export function parseSharePageMeta(html)                    // -> { title, author, cover, durationSec }（当前线上全 null）
export async function followShortLink(startUrl, opts?)      // -> { finalUrl, hops[] }
export function buildDouyinCookieHeader(cookie)
export function mapDouyinStatusCode(code, message)
export function mapDouyinHttpStatus(status)
export function mapDouyinAweme(raw)
export function parseDouyinWatchLaterResponse(payload)
export default { parseShareText, resolveShareUrl, fetchWatchLater }
```

---

## 5. 宿主 / UI 必须注意的限制

1. **B站 cookie 字段**：至少 `SESSDATA`；整段 Cookie（`F12 → Network → 任意请求 → Cookie`）或只粘 SESSDATA 值都支持。过期后 `nav`/`toview` 会返回 `-101` 或 `-400`，UI 应提示「重新粘贴 Cookie」。
2. **B站上限**：稍后再看最多 100 条；`fetchWatchLater` 一次请求拿全量，不需要翻页。
3. **抖音 cookie 字段**：整段 `douyin.com` Cookie（至少 `sessionid`，建议连 `ttwid` 一起）。
4. **抖音 sync 可能受限**：`supported:true` 表示「网页端存在该能力」，真实数据路径未用登录 Cookie 验证（§3.4）。如果实测为空，按 §3.4 回退 `supported:false`。
5. **抖音分享链接**：`resolveShareUrl` 正常会返回 `ok:false`（拿不到标题/作者/封面），但 `item.remoteId` 与 `item.url` 可用；标题请用 `parseShareText().title` 或分享原文，**不要**把 `item.title`（`抖音视频 <id>` 占位）当真实标题。
6. 所有网络调用 12s 超时、可被 `AbortSignal` 取消；超时/取消/网络错误/风控/接口变更都返回结构化 `{ ok:false, error }`，不会抛未捕获异常；模块顶层不发请求。
7. 无第三方依赖，只用 Node 22 内置 fetch。

---

## 6. 测试（不依赖真实网络）

`test/sync.test.mjs` 共 44 条用例：

- 契约导出检查；
- `parseShareText`（典型文案、随机短码/版本号、裸短链、样板文案、完整链接兜底、空输入、长标题截断）；
- 抖音 URL 解析、落地页元数据解析（现网结构 → 全 null；RENDER_DATA / og / JSON-LD 兜底；通用占位标题过滤）；
- B站 `toview`/`nav` 响应映射（字段、排序、https 封面、av 兜底、脏数据跳过、100 条上限、`-101`/`-400`/空响应/结构异常）、错误码映射、cookie 规整；
- 抖音 `watchlater` 响应映射（空列表、正常条目、`aweme_list` 兜底、`status_code=8`）、错误码映射、cookie 规整；
- 无 cookie / 已取消 signal 的结构化错误分支（不发网络请求）；
- `request()` 网络层用 **127.0.0.1 临时 http.Server** 验证：响应解析、headers 双形态、302 manual/follow、60ms 超时 → `TIMEOUT`、AbortSignal → `ABORTED`、连接失败 → `NETWORK`、非法 JSON → `PARSE`；
- `followShortLink` 本地 302 跟跳。

复验命令：

```bash
cd /Users/kuro/Documents/deepseek-harness/default-workspace/dsh-watch-later
node --check sync/http.js sync/bili.js sync/douyin.js
node --test test/sync.test.mjs
```

---

## 7. 待验证 / 风险

1. **抖音 watchlater 真实数据**：无登录 Cookie，未验证登录后返回结构；`mapDouyinAweme` 按 aweme 标准结构写了兼容映射，若接口字段不同会显示占位标题（不会崩，但需按实测调整）。
2. **B站 toview 真实列表**：同理，无主人 Cookie 未验证登录后返回；映射依据官方社区文档 + 公开 view 接口字段风格。
3. 抖音如果后续开放分享页 SSR/详情接口，`parseSharePageMeta` 可能自动恢复元数据；届时可把 `resolveShareUrl` 的 `ok:false` 分支去掉。
4. B站风控（HTTP 412 / code -352）在频繁请求时可能出现，已映射为人话并建议稍后重试。
