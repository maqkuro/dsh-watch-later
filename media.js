/**
 * 「影游」分类：游戏 / 影视（剧集、动画、电影）相关内容。
 *
 * - relevant：kind 为 game / drama，或标签里带「影游」（旧标签「想玩/想看」会批量改名）。
 * - group 两类：
 *     guide —— 攻略 / 评测 / 解析 / 原文整理出来的内容
 *     list  —— 纯清单：只列作品名（+封面），没有实质正文的片单/游戏单/单部作品登记
 * 手动 mediaClass 优先于启发式；启发式只在没标过的时候兜底。
 */
export const MEDIA_CLASSES = ['guide', 'list']

const MEDIA_TAGS = new Set(['影游', '想玩', '想看'])
const LIST_TITLE_RE = /(清单|片单|书单|合集|盘点|推荐|排行榜|榜单|好番|番剧|游戏表|目录|大赏|安利|收藏夹|待玩|待看|想看|想玩)/i
const GUIDE_TITLE_RE = /(攻略|评测|测评|解析|分析|指南|教程|汇总|详解|拆解|数据|心得|体验|试玩|实机|推荐理由)/i
const GUIDE_TAGS = new Set(['攻略', '评测', '测评', '解析', '分析', '指南', '教程', '汇总', '支线', '数据', '心得', '体验', '试玩'])

export function mediaClassOf(item) {
  if (!item) return null
  if (MEDIA_CLASSES.includes(item.mediaClass)) return item.mediaClass
  const text = [item.title, item.summary, item.site, Array.isArray(item.tags) ? item.tags.join(' ') : '']
    .filter(Boolean)
    .join(' ')
  const tags = Array.isArray(item.tags) ? item.tags : []
  if (tags.some((tag) => GUIDE_TAGS.has(String(tag))) || GUIDE_TITLE_RE.test(tags.join(' ')) || GUIDE_TITLE_RE.test(item.title || '')) return 'guide'
  if (LIST_TITLE_RE.test(text)) return 'list'
  // 既没有链接也没有正文缓存的多半只是“登记了一部作品”
  if (!item.url && !item.content) return 'list'
  return 'guide'
}

export function isMediaItem(item) {
  if (!item) return false
  if (item.kind === 'game' || item.kind === 'drama') return true
  const tags = Array.isArray(item.tags) ? item.tags : []
  return tags.some((tag) => MEDIA_TAGS.has(String(tag)))
}

export function mediaInfo(item) {
  const relevant = isMediaItem(item)
  return {
    relevant,
    group: relevant ? mediaClassOf(item) : null,
  }
}
