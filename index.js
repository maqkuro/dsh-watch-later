/**
 * Host half of the DSH watch-later center bundle.
 *
 * Registers loopback-only JSON routes under /api/dsh-watch-later/*, the four
 * agent tools, one prompt section, and the inbox drop-zone watcher.
 * The Client half is client.js (sidebar icon + full panel).
 */
import { applyRoutes } from './api.js'
import { registerTools, registerPrompt } from './tools.js'
import { ensureDirs, loadState, stats, DATA_DIR } from './store.js'
import { startInboxWatcher } from './ingest.js'
import { startShareWatcher, DEFAULT_SHARE_INBOX } from './share-inbox.js'
import { startArchiveWatcher, DEFAULT_ARCHIVE_INBOX } from './zip-ingest.js'
import { backfillCovers, fillMissingCovers } from './cover-backfill.js'
import { syncWorks } from './works.js'
import { agentInfo } from './agent.js'
import { enrichAgentItems } from './ai.js'
import { autoClassifyRecent } from './ai.js'

export const name = 'dsh-watch-later'
export const inject = ['webServer']

export function apply(ctx) {
  ensureDirs()
  const state = loadState()

  applyRoutes(ctx)

  const tools = ctx.get('tools')
  if (tools) ctx.effect(() => registerTools(ctx))

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt) ctx.effect(() => registerPrompt(ctx))

  ctx.effect(() => startInboxWatcher())

  // macOS 分享扩展送来的图片/文字/链接（可以多选）落在这个沙盒容器目录里。
  const shareRoot = process.env.DSH_WATCH_LATER_SHARE_ROOT || DEFAULT_SHARE_INBOX
  ctx.effect(() => startShareWatcher(shareRoot))

  // 微信聊天记录 ZIP（native-archive 收件目录）：自动解包并把里面所有原图入库。
  const archiveRoot = process.env.DSH_WATCH_LATER_ARCHIVE_INBOX || DEFAULT_ARCHIVE_INBOX
  ctx.effect(() => startArchiveWatcher(archiveRoot))

  // Agent 条目：启动后把技能/插件/提示词补成「名称 + 作用 + 三分类」。
  ctx.effect(() => {
    const run = async (limit) => {
      const candidates = (await import('./store.js')).getItems()
        .filter((item) => agentInfo(item).relevant)
        .filter((item) => !item.agentName || !item.agentCategory)
        .slice(0, limit)
      for (let index = 0; index < candidates.length; index += 8) {
        try {
          await enrichAgentItems(ctx, candidates.slice(index, index + 8))
        } catch {
          // best effort
        }
      }
    }
    const startup = setTimeout(() => run(24).catch(() => {}), 12000)
    const timer = setInterval(() => run(8).catch(() => {}), 10 * 60 * 1000)
    timer.unref?.()
    return () => {
      clearTimeout(startup)
      clearInterval(timer)
    }
  })

  // 影游清单：启动后从影游条目同步作品（Bangumi 封面/标准标题），之后每 10 分钟补一次。
  ctx.effect(() => {
    const startup = setTimeout(() => {
      syncWorks().catch(() => {})
    }, 8000)
    const timer = setInterval(() => {
      syncWorks().catch(() => {})
    }, 10 * 60 * 1000)
    timer.unref?.()
    return () => {
      clearTimeout(startup)
      clearInterval(timer)
    }
  })

  // 文章类条目（小红书/公众号/链接）自动补封面图：启动后补一批，之后每 5 分钟补漏。
  ctx.effect(() => {
    const startup = setTimeout(() => {
      // 先给「没有封面」的条目垫一张标题卡（不联网），再慢慢去补真图
      try {
        fillMissingCovers({ limit: 500 })
      } catch {
        // 补齐失败不影响启动
      }
      backfillCovers({ limit: 20 }).catch(() => {})
    }, 4000)
    const timer = setInterval(() => {
      backfillCovers({ limit: 10 }).catch(() => {})
    }, 5 * 60 * 1000)
    timer.unref?.()
    return () => {
      clearTimeout(startup)
      clearInterval(timer)
    }
  })

  // 主人 2026-11-09 的要求：每次转发文件入库都要大模型过一遍。
  // 每 2 分钟扫一次最近 3 小时新入库、还没被 AI 整理过的条目，每轮最多 8 条（面板设置里 autoAiOnIngest 可关）。
  ctx.effect(() => {
    let running = false
    const pass = () => {
      if (running) return
      running = true
      autoClassifyRecent(ctx, { hours: 3, limit: 8 })
        .then((result) => {
          if (result?.updated) {
            ctx.logger?.info?.(`[dsh-watch-later] 新条目已过大模型：${result.updated} 条`)
          }
        })
        .catch(() => {})
        .finally(() => {
          running = false
        })
    }
    const startup = setTimeout(pass, 12000)
    const timer = setInterval(pass, 2 * 60 * 1000)
    timer.unref?.()
    return () => {
      clearTimeout(startup)
      clearInterval(timer)
    }
  })

  ctx.logger?.info?.(
    `[dsh-watch-later] ready: ${state.items.length} items, data at ${DATA_DIR}, share inbox at ${shareRoot}`,
  )
}

export { stats }
