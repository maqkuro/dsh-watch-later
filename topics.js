/**
 * topics.js — 「稍后再看」的内容分类体系（2026-11-09 主人要求「分类做做好」）
 *
 * 契约：条目 tags[0] 固定是分类名（TOPICS 之一），后面才是细标签。
 * 分类不写进独立字段，是为了不破坏既有 PATCH 白名单与面板渲染；
 * 客户端「分类」tab 就是按 tags 里第一个命中 TOPICS 的元素分组。
 *
 * 纯 ESM、纯函数、零 I/O，方便迁移脚本和单测直接 import。
 */

/** 展示顺序即这个数组的顺序。 */
export const TOPICS = [
  'AI与Agent',
  '设计',
  '产品与商业',
  '投资与量化',
  '游戏',
  '影游',
  '摄影',
  '生活与健康',
  '成长与职业',
  '工具与数码',
  '截图存档',
  '待归档',
]

const TOPIC_SET = new Set(TOPICS)

/** 影游 tab 依赖这几个标签，任何时候都不能被分类整理吃掉。 */
const MEDIA_TAGS = new Set(['影游', '想玩', '想看'])

/** 这些是来源标签，不是内容标签，整理时直接丢掉。 */
const SOURCE_TAGS = new Set([
  '小红书',
  '微信公众号',
  '公众号',
  '链接',
  '微信聊天记录',
  '微信转发',
  '微信文件',
  '图片',
  '视频',
  '文章',
  '商品',
  '其他',
])

/** 词表打分：标题权重 ×2，摘要 ×1，已有标签 ×1。顺序即平票时的优先级。 */
const RULES = [
  [
    '摄影',
    {
      摄影: 6, 拍照: 5, 修图: 5, 美姿: 5, 构图: 4, 相机: 5, 出片: 4, 调色: 3, 镜头: 3, 人像: 4, 照片: 3,
    },
  ],
  [
    '投资与量化',
    {
      股票: 5, A股: 5, 港股: 5, 美股: 5, 量化: 5, 交易: 4, 持仓: 5, 基金: 4, 指数: 3, 财报: 4,
      投研: 4, 行情: 3, 盯盘: 4, 估值: 3, ETF: 4, 资产: 2, 投资: 4, 债券: 3, 黄金: 3, 收益率: 3,
      仓位: 4, 止损: 4, 股市: 5, 中芯: 3, 智谱: 2, MiniMax: 2,
    },
  ],
  [
    '生活与健康',
    {
      极简: 4, 收纳: 4, 断舍离: 5, 家居: 4, 城市: 2, 旅行: 3, 酒店: 4, 泳池: 6, 游泳: 6, 健身: 4,
      跑步: 4, 睡眠: 4, 早睡: 4, 饮食: 3, 减肥: 4, 体检: 4, 租住: 4, 生活: 3, 清洁: 3, 通勤: 3,
      医院: 3, 健康: 3, 作息: 4,
    },
  ],
  [
    '影游',
    {
      番: 4, 动画: 4, 剧: 3, 电影: 4, 综艺: 4, 评分: 3, 追番: 4, 新番: 4, 影游: 4, 上映: 3, 演员: 2, 预告片: 3,
    },
  ],
  [
    '游戏',
    {
      游戏: 4, 攻略: 4, Deadlock: 5, 绝区零: 4, 影之刃: 5, Steam: 5, 对局: 4, 段位: 4, 主机: 3,
      Dota2: 5, 火焰纹章: 4, 死锁: 4, MOD: 3, mod: 3, 网游: 3, 通关: 3, 开黑: 3,
    },
  ],
  [
    '成长与职业',
    {
      职场: 5, 求职: 4, 副业: 4, 自由职业: 5, 读书: 3, 学习: 2, 效率: 3, 面试: 4, '30岁': 4,
      时间管理: 4, 演讲: 4, 表达: 3, 复盘: 3, 焦虑: 3, 习惯: 3, 成长: 3, 认知: 3, 人生: 2,
    },
  ],
  [
    '产品与商业',
    {
      产品: 3, PRD: 5, 需求: 3, 增长: 3, 商业化: 3, 变现: 3, 独立开发: 4, 定价: 3, 运营: 2,
      竞品: 3, 推广: 3, 渠道: 2, 客户: 2, 创业: 2, 路线图: 2, 埋点: 2, 转化: 2,
    },
  ],
  [
    '设计',
    {
      设计: 4, UI: 4, UX: 3, 界面: 3, 配色: 4, 视觉: 3, 字体: 3, 排版: 3, Figma: 4, 卡片: 3,
      动效: 3, 图标: 3, 组件: 3, 美学: 3, Design: 4, 交互: 3, 版式: 3, 插画: 3, 海报: 3,
      品牌: 2, 风格: 2,
    },
  ],
  [
    'AI与Agent',
    {
      AI: 3, ai: 2, Claude: 4, Codex: 4, GPT: 4, Gemini: 3, DeepSeek: 4, Kimi: 3, Astra: 3, Jev: 3,
      Opus: 3, Sonnet: 2, 大模型: 4, 模型: 2, 提示词: 4, prompt: 3, Prompt: 3, skill: 3, Skill: 3,
      Skills: 3, agent: 3, Agent: 4, MCP: 4, LLM: 3, 蒸馏: 3, 上下文: 2, 推理: 2, ChatGPT: 4,
      豆包: 3, 千问: 3, 元器: 2, GrokBot: 3, Lovart: 3, Stitch: 2, 'Vibe Coding': 4, vibecoding: 4,
      vibe: 2, 智能体: 2, 微调: 2, token: 2, Token: 2,
    },
  ],
  [
    '工具与数码',
    {
      GitHub: 3, 开源: 2, CLI: 4, App: 3, 软件: 4, 插件: 3, Mac: 4, iPhone: 4, NAS: 5, Switch: 4,
      硬件: 3, 订阅: 3, 系统: 3, 浏览器: 3, 输入法: 4, 脚本: 2, 命令行: 4, 快捷键: 3, 终端: 3,
      存储: 3, 云盘: 3, 备份: 3, 电脑: 3, 键盘: 3, 耳机: 3, iOS: 3, macOS: 4, Windows: 2,
    },
  ],
]

/**
 * 一次性人工判定表：这 113 条词表打不准（截图包、纯文件名、模糊标题），
 * 2026-11-09 大肥鱼逐条看过标题后定的分类。新增条目不用往这里加。
 */
export const OVERRIDES = {
  wl_mw4q7dum_f8c090: '摄影',
  wl_mw4q7ert_d0335e: '生活与健康',
  wl_mw4q7ev8_8e56b8: 'AI与Agent',
  wl_mw4q7f61_7b6ba2: '影游',
  wl_mw8o40rb_1ce30f: '工具与数码',
  wl_mw8o40rb_20a6f0: '产品与商业',
  wl_mw8o40rb_7d0a03: '设计',
  wl_mw8oecni_50b077: '截图存档',
  wl_mw8oecnk_91f30f: '截图存档',
  wl_mw8oecnl_f82a25: '设计',
  wl_mw8oecnl_8c1da9: '投资与量化',
  wl_mw8oecnl_debc85: '设计',
  wl_mw8oecnm_74dcf2: '游戏',
  wl_mw8oecnn_768f45: '设计',
  wl_mw8oecno_d33f16: 'AI与Agent',
  wl_mw8oecnq_078a63: '投资与量化',
  wl_mw8oecnr_eb0ffa: '设计',
  wl_mw8oecns_4d8175: '游戏',
  wl_mw8oecnt_66f383: '设计',
  wl_mw8ohc14_0c106a: '截图存档',
  wl_mw8ohc15_149c14: '截图存档',
  wl_mw8ohc18_c6a112: 'AI与Agent',
  wl_mw8ohc19_cbead2: '游戏',
  wl_mw8ohc19_e0bed1: '设计',
  wl_mw8ohc1c_2d02fd: 'AI与Agent',
  wl_mw8ohc1o_797ce8: '投资与量化',
  wl_mw8ohc1u_379336: '设计',
  wl_mw8ohc1w_637bb3: '工具与数码',
  wl_mw8okz9f_f59ee4: '截图存档',
  wl_mw8okz9g_951f7f: '截图存档',
  wl_mw8okz9t_2c9dcd: '工具与数码',
  wl_mw8okz9x_a15209: '待归档',
  wl_mw8okz9y_74d097: '待归档',
  wl_mw8okza1_2d002a: 'AI与Agent',
  wl_mw8okza1_dd02fd: '投资与量化',
  wl_mw8oluea_ec8838: '待归档',
  wl_mw8oluef_5b2260: '工具与数码',
  wl_mw8olueg_d90d11: '工具与数码',
  wl_mw8oluej_d56538: '设计',
  wl_mw8om1lm_94e076: '影游',
  wl_mw8om1lr_bfbf94: 'AI与Agent',
  wl_mw8om1lu_f8cbc4: '设计',
  wl_mw8os0nb_cb7c43: '游戏',
  wl_mw8os0nh_3ef446: '游戏',
  wl_mw8os0ni_a22e40: '工具与数码',
  wl_mw8os0nk_1653c4: '待归档',
  wl_mw8os0nl_b05558: '待归档',
  wl_mw8os0nm_8906a4: '待归档',
  wl_mw8os0no_83602e: '待归档',
  wl_mw8os0ns_d0ccbb: '游戏',
  wl_mw8os0nu_76cbd4: '设计',
  wl_mw8os0o0_e2b1ba: '游戏',
  wl_mw8os0o2_0e150e: '游戏',
  wl_mw8os0o3_a47021: '待归档',
  wl_mw8os6ql_8a5303: '投资与量化',
  wl_mw8os6qn_6f448f: '生活与健康',
  wl_mw8os6qp_d48c5e: '待归档',
  wl_mw8os6qq_497c7f: '工具与数码',
  wl_mw8os6qs_e130db: '工具与数码',
  wl_mw8ove5d_01ac59: '截图存档',
  wl_mw8ove5n_97c21c: '投资与量化',
  wl_mw8ove5r_59eeaf: '投资与量化',
  wl_mw8ove5u_7da741: '工具与数码',
  wl_mw8ove5w_c011af: '设计',
  wl_mw8ove5x_81767c: '工具与数码',
  wl_mw8ove5z_7defb9: 'AI与Agent',
  wl_mw8ove61_b1ec93: '工具与数码',
  wl_mw8ove64_52213d: 'AI与Agent',
  wl_mw8ove66_d8068f: '设计',
  wl_mw8ove68_4c4ed4: 'AI与Agent',
  wl_mw8ove69_007dd3: 'AI与Agent',
  wl_mw8ove6d_18b1f0: '设计',
  wl_mw8ove6g_96cf34: '影游',
  wl_mw8ove6h_a1910c: 'AI与Agent',
  wl_mw8ove6i_e07d2b: '产品与商业',
  wl_mw8ove6j_585a69: 'AI与Agent',
  wl_mw8ove6l_d1e9ef: '设计',
  wl_mw8ove6r_521429: '待归档',
  wl_mw8ove6v_22226d: '成长与职业',
  wl_mw8oxu5f_c2c347: '设计',
  wl_mw8oxu62_c97b78: 'AI与Agent',
  wl_mw8oxu66_fba146: '设计',
  wl_mw8oxu6d_2f3637: '待归档',
  wl_mw8oxu6j_eaf7b8: '游戏',
  wl_mw8oxu6t_7f15c5: '待归档',
  wl_mw8oy51l_60026c: '待归档',
  wl_mw8oy51o_49d262: '设计',
  wl_mw8oy51q_ba58f4: '游戏',
  wl_mw8oy51s_b0d15d: 'AI与Agent',
  wl_mw8oy51x_e0cc72: '待归档',
  wl_mw8oy520_09dbc4: 'AI与Agent',
  wl_mw8oy521_0a58d6: '待归档',
  wl_mw8oy524_d099df: '待归档',
  wl_mw8oy525_c9785b: '待归档',
  wl_mw8oy527_b83e9f: '待归档',
  wl_mw8oy52a_69d643: '产品与商业',
  wl_mw8oy52b_775d11: '产品与商业',
  wl_mw8vzqdb_7dc62b: '截图存档',
  wl_mw8vzqdc_8860b6: '截图存档',
  wl_mw8vzqde_73f550: '产品与商业',
  wl_mw8vzqdk_557e9a: '设计',
  wl_mw8vzqdl_967975: '工具与数码',
  wl_mw8vzqdo_318a5d: '工具与数码',
  wl_mw8vzqdp_8316a6: '生活与健康',
  wl_mw8vzqdt_9e6dde: '投资与量化',
  wl_mw8vzqdu_8190a1: '工具与数码',
  wl_mw8vzqdz_bb4427: '工具与数码',
  wl_mw8vzqe1_505eb4: '产品与商业',
  wl_mw8vzqe4_d2fb21: 'AI与Agent',
  wl_mw8vzqe5_25a926: 'AI与Agent',
  wl_mw8vzqe7_5d5af3: '设计',
  wl_mw8w067d_1da177: '截图存档',
  wl_mw8w067i_9790c5: '产品与商业',
  wl_mw8w28ui_f047fa: 'AI与Agent',
  wl_mw8w2kvu_900cd6: '工具与数码',
  wl_mw8w2kvw_58fba5: '工具与数码',
  wl_mw8w2kwa_8bb5e4: '工具与数码',
  wl_mw8w2smk_9a3d71: '游戏',
  wl_mw8w2sm7_d00df7: '产品与商业',
  wl_mw8w28uq_b84fb4: '工具与数码',
}

function countOf(haystack, needle) {
  if (!haystack || !needle) return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/** 词表打分：返回 { topic, score }，score 太低就是判不出来。 */
export function scoreTopics(item = {}) {
  const title = String(item.title || '')
  const summary = String(item.summary || '')
  const tags = Array.isArray(item.tags) ? item.tags.join(' ') : String(item.tags || '')
  let best = null
  let bestScore = 0
  for (const [topic, keywords] of RULES) {
    let score = 0
    for (const word of Object.keys(keywords)) {
      const weight = keywords[word]
      score += weight * (countOf(title, word) * 2 + countOf(summary, word) + countOf(tags, word))
    }
    if (score > bestScore) {
      bestScore = score
      best = topic
    }
  }
  return { topic: best, score: bestScore }
}

/** 判定一条内容的分类。人工表优先，其次词表，判不出来归「待归档」。 */
export function topicOf(item = {}) {
  const id = typeof item.id === 'string' ? item.id : ''
  if (id && OVERRIDES[id]) return OVERRIDES[id]
  const { topic, score } = scoreTopics(item)
  return topic && score >= 3 ? topic : '待归档'
}

/** 当前标签里是否已经有分类（第一条命中 TOPICS 的即分类）。 */
export function topicTagOf(tags) {
  if (!Array.isArray(tags)) return null
  for (const tag of tags) {
    const name = String(tag || '').trim()
    if (TOPIC_SET.has(name)) return name
  }
  return null
}

/**
 * 把分类放到 tags[0]，顺手清掉来源标签和重复项，最多留 4 个标签。
 * 影游族的标签（影游/想玩/想看）永远保留 —— 影游 tab 靠它们判定。
 */
export function withTopic(tags, topic) {
  const name = TOPIC_SET.has(topic) ? topic : '待归档'
  const raw = Array.isArray(tags) ? tags.map((tag) => String(tag || '').trim()).filter(Boolean) : []
  const kept = []
  for (const tag of raw) {
    if (!tag || tag === name || SOURCE_TAGS.has(tag) || kept.includes(tag)) continue
    // 「影游」既是分类也是影游 tab 的判定标签：分类不是它时也要留着。
    if (TOPIC_SET.has(tag) && !MEDIA_TAGS.has(tag)) continue
    kept.push(tag)
  }
  const media = kept.filter((tag) => MEDIA_TAGS.has(tag))
  const rest = kept.filter((tag) => !MEDIA_TAGS.has(tag))
  return [name, ...media, ...rest].slice(0, 4).filter((tag, index, list) => list.indexOf(tag) === index)
}

/** 统计用：给一组条目按分类计数（顺序遵循 TOPICS）。 */
export function topicCounts(items) {
  const counts = new Map(TOPICS.map((topic) => [topic, 0]))
  for (const item of Array.isArray(items) ? items : []) {
    if (!item) continue
    const topic = topicTagOf(item.tags) || topicOf(item)
    counts.set(topic, (counts.get(topic) || 0) + 1)
  }
  return TOPICS.map((topic) => ({ topic, count: counts.get(topic) || 0 }))
}
