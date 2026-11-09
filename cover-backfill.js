/**
 * 封面/配图补齐：文章类条目优先用文章自身的封面图（og:image / 正文首图），
 * 微信文章拿不到正文时用搜狗微信搜索的真实缩略图 + 摘要补齐；再兜底 favicon / 生成 SVG。
 *
 * 顺序：
 *   1. 微信文章：sogou.js（同 WorkBuddy wechat-article-search 的搜索数据源）→ 真缩略图 + 摘要 + 公众号名；
 *   2. 其它文章：解析 /content，取 og:image / 正文图片；
 *   3. 链接：站点 favicon；
 *   4. 最后才生成按 kind 配色的 SVG（标题首字），只作兜底，不再优先。
 *
 * 触发：启动、每 5 分钟、保存后、POST /enrich/covers。
 */
import { getItem, getItems, updateItem, MAX_IMAGES, MEDIA_DIR } from './store.js'
import { resolveContent } from './content.js'
import { faviconCover, generateCoverFor, pageCover } from './cover-art.js'
import { wechatPreviewForItem, shouldTrySogou } from './sogou.js'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const COVER_KINDS = ['xhs', 'wechat', 'link', 'article', 'video', 'bilibili', 'douyin', 'product', 'drama', 'other']

const LINKISH_KINDS = new Set(['link', 'article', 'product', 'video', 'bilibili', 'douyin', 'xhs', 'wechat'])
const ARTICLE_KINDS = new Set(['xhs', 'wechat', 'link', 'article', 'video', 'bilibili', 'douyin', 'product'])

/**
 * 平台占位图（不是内容图）：抓不到真图时站点 og:image / favicon 会甩给你一张
 * 「小红书」「抖音」的 logo 卡。主人 2026-11-09 明确吐槽「小红书的封面怎么都是小红书」。
 * 命中这些 hash 就当作「没有封面」，先补真图，补不到就清空，不再冒充封面。
 */
const PLACEHOLDER_HASHES = new Set([
  'a07313f9236c1abb975f3343a1a054d6e36000f3', // 小红书 logo 卡 600×315，58 条共用
  'b7b8a5bd51b5a96daca7bf79943b728f87327b1e', // 站点 favicon 兜底（1.4KB）
  '39929c9a345e045c37c4b58887d9983c6ee232ae', // 站点 favicon 兜底（1.7KB）
  '7af8467bbfe97a5a9e295d43256f5c852304193e', // 抖音 favicon 兜底
])

const coverHashCache = new Map()

function mediaFileOf(cover) {
  if (typeof cover !== 'string') return null
  const match = /[?&]f=([^&]+)/.exec(cover)
  if (!match) return null
  try {
    return join(MEDIA_DIR, decodeURIComponent(match[1]))
  } catch {
    return null
  }
}

/** 一张封面是不是平台 logo / favicon 之类的占位图（按内容 hash 判定，跟文件名无关）。 */
export function isPlaceholderCover(cover) {
  const file = mediaFileOf(cover)
  if (!file) return false
  if (coverHashCache.has(file)) return coverHashCache.get(file)
  let hit = false
  try {
    const bytes = readFileSync(file)
    hit = PLACEHOLDER_HASHES.has(createHash('sha1').update(bytes).digest('hex')) || bytes.length < 2600
  } catch {
    hit = false
  }
  coverHashCache.set(file, hit)
  return hit
}

/** 需要补封面的判据：没封面 / SVG 占位 / 平台 logo 占位。 */
function coverNeedsWork(cover) {
  if (!cover) return true
  if (isGeneratedCover(cover)) return true
  return isPlaceholderCover(cover)
}

export function isGeneratedCover(cover) {
  return typeof cover === 'string' && /\.svg(\?|$)/i.test(cover)
}

function summaryTooThin(summary) {
  return !summary || String(summary).trim().length < 16
}

/**
 * @param {{ limit?: number, force?: boolean, kinds?: string[], resolveFn?: Function, delayMs?: number }} options
 */
export async function backfillCovers(options = {}) {
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(0, Number(options.limit)) : 20
  const kinds = Array.isArray(options.kinds) && options.kinds.length > 0 ? options.kinds : COVER_KINDS
  const resolve = typeof options.resolveFn === 'function' ? options.resolveFn : resolveContent
  const force = options.force === true
  const useSogou = options.sogou !== false
  // 「AI 整理」模式：只认真图，不生成占位 SVG；且要能覆盖已归档条目。
  const allowGenerated = options.allowGenerated !== false
  const includeAll = options.includeAll === true
  const idSet =
    Array.isArray(options.ids) && options.ids.length > 0 ? new Set(options.ids.map((id) => String(id))) : null
  const delayGiven = Number.isFinite(Number(options.delayMs))
  const delayMs = delayGiven ? Math.max(0, Number(options.delayMs)) : 250
  const summary = { checked: 0, covered: 0, skipped: 0, failed: 0, results: [] }
  if (limit === 0) return summary

  const pending = getItems()
    .filter((item) => (idSet ? idSet.has(item.id) : true))
    .filter((item) => kinds.includes(item.kind))
    .filter((item) => force || coverNeedsWork(item.cover))
    .filter((item) => includeAll || ['inbox', 'queued', 'doing'].includes(item.status))
    .slice(0, idSet ? Math.max(limit, idSet.size) : limit)

  let sogouBlocked = false
  // 小红书按 IP 做风控：连续撞到 sec_404 就停手，本轮剩下的 xhs 留到下一轮再补，
  // 每条约 6 秒（主人 2026-11-09 反馈「小红书全都没封面」，慢一点才不会整批被拦）。
  let xhsBlocked = 0
  let xhsRestBlocked = false
  for (const item of pending) {
    summary.checked += 1
    let covered = false
    if (item.kind === 'xhs' && xhsRestBlocked) {
      summary.skipped += 1
      continue
    }

    // 1) 微信文章：搜狗搜索拿真实缩略图 + 摘要（正文被验证页拦住也能补）
    if (useSogou && !sogouBlocked && item.kind === 'wechat' && (force || shouldTrySogou(item))) {
      try {
        const preview = await wechatPreviewForItem(item, { force })
        if (preview && preview.blocked) sogouBlocked = true
        if (preview && preview.ok) {
          const patch = {}
          if (preview.cover) patch.cover = preview.cover
          if (preview.summary && summaryTooThin(item.summary)) patch.summary = preview.summary.slice(0, 140)
          if (preview.account && !item.author) patch.author = preview.account
          if (preview.account && (!item.site || item.site === '微信公众号')) patch.site = '公众号'
          if (Object.keys(patch).length > 0) {
            updateItem(item.id, patch)
            summary.covered += 1
            covered = true
            summary.results.push({ id: item.id, ok: true, via: 'sogou', cover: Boolean(preview.cover) })
          }
        }
      } catch (error) {
        summary.results.push({ id: item.id, ok: false, via: 'sogou', reason: String(error?.message || error) })
      }
    }

    // 2) 其它文章（以及搜狗没补到的微信）：解析正文取 og:image / 正文图片
    if (!covered && ARTICLE_KINDS.has(item.kind)) {
      try {
        const cached = item.content
        const staleError = Boolean(cached && cached.error)
        const content = await resolve(item, { force: force || isGeneratedCover(item.cover) || isPlaceholderCover(item.cover) || staleError })
        const images = Array.isArray(content && content.images) ? content.images.filter(Boolean) : []
        if (images.length > 0) {
          const patch = {}
          if (!item.cover || isGeneratedCover(item.cover) || isPlaceholderCover(item.cover) || force) patch.cover = images[0]
          if (!Array.isArray(item.images) || item.images.length === 0 || force) patch.images = images.slice(0, MAX_IMAGES)
          updateItem(item.id, patch)
          summary.covered += 1
          covered = true
          summary.results.push({ id: item.id, ok: true, via: 'content', images: patch.images ? patch.images.length : 0 })
        }
      } catch (error) {
        summary.failed += 1
        summary.results.push({ id: item.id, ok: false, via: 'content', reason: String(error?.message || error) })
      }
    }

    // 小红书被风控：记账并在连续两次之后停手，避免把整批条目都撞成 404
    if (item.kind === 'xhs' && !covered) {
      const latestForXhs = getItem(item.id) || item
      const errText = String((latestForXhs.content && latestForXhs.content.error) || '')
      if (/sec_404|风控/.test(errText)) {
        xhsBlocked += 1
        if (xhsBlocked >= 2) xhsRestBlocked = true
      }
    }

    // 3) 站点 favicon（仅链接类，且还没有封面或只有生成封面时不覆盖已有真封面）
    const latest = getItem(item.id) || item
    if (coverNeedsWork(latest.cover)) {
      let fallback = null
      if (LINKISH_KINDS.has(latest.kind) && latest.kind !== 'wechat') {
        fallback = await pageCover(latest)
        if (fallback && isPlaceholderCover(fallback)) fallback = null
        if (!fallback) {
          const icon = await faviconCover(latest)
          fallback = icon && !isPlaceholderCover(icon) ? icon : null
        }
      }
      // 4) 最后才生成 SVG；已生成过的条目不再重复生成（AI 整理模式下整段跳过）
      if (allowGenerated && !fallback && (!latest.cover || !isGeneratedCover(latest.cover))) fallback = generateCoverFor(latest)
      if (fallback) {
        try {
          updateItem(latest.id, { cover: fallback })
          summary.covered += 1
          summary.results.push({ id: latest.id, ok: true, generated: true })
        } catch (error) {
          summary.failed += 1
          summary.results.push({ id: latest.id, ok: false, reason: String(error?.message || error) })
        }
      } else if (!covered) {
        // 真图补不到：把「小红书/抖音 logo」这类占位清掉，别让它冒充内容封面
        if (latest.cover && isPlaceholderCover(latest.cover) && !allowGenerated) {
          try {
            updateItem(latest.id, { cover: null })
            summary.results.push({ id: latest.id, ok: false, reason: '只有平台 logo，已清空封面' })
          } catch {
            // 条目消失，忽略
          }
        }
        summary.skipped += 1
      }
    } else if (!covered) {
      summary.skipped += 1
    }

    const waitMs = item.kind === 'xhs' && !delayGiven ? Math.max(delayMs, 6000) : delayMs
    if (waitMs > 0) await new Promise((wait) => setTimeout(wait, waitMs))
  }
  return summary
}

/**
 * 一次性补齐：只给「没有封面」的条目生成标题卡（SVG），不联网、不碰已有封面。
 * 用途：把平台 logo / 空白清掉之后，别让列表整片空着（主人 2026-11-09 要求）。
 */
export function fillMissingCovers(options = {}) {
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(0, Number(options.limit)) : 1000
  const summary = { filled: 0, skipped: 0 }
  const pending = getItems().filter((item) => item && !item.cover).slice(0, limit)
  for (const item of pending) {
    try {
      const cover = generateCoverFor(item)
      if (!cover) {
        summary.skipped += 1
        continue
      }
      updateItem(item.id, { cover })
      summary.filled += 1
    } catch {
      summary.skipped += 1
    }
  }
  return summary
}
