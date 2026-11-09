/**
 * Client half of the DSH 「稍后再看」 bundle (@local/dsh-watch-later).
 *
 * A sidebar entry plus a full-page panel with six views: today focus, inbox,
 * library, time sensitivity, Bilibili/Douyin sync and settings. All data comes
 * from the Host half under /api/dsh-watch-later/*; this module only renders it.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-watch-later',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-watch-later'
    const PANEL_ID = 'local-watch-later'
    const API_BASE = '/api/dsh-watch-later'
    /** Keep in sync with MAX_IMAGES in store.js: gallery thumbnails shown per item. */
    const MAX_GALLERY_IMAGES = 100
    const API = {
      snapshot: API_BASE + '/snapshot',
      add: API_BASE + '/add',
      importText: API_BASE + '/import',
      update: API_BASE + '/update',
      action: API_BASE + '/action',
      remove: API_BASE + '/delete',
      aiReview: API_BASE + '/ai/review',
      agentEnrich: API_BASE + '/agent/enrich',
      aiOrganize: API_BASE + '/ai/organize',
      aiStatus: API_BASE + '/ai/status',
      aiUndo: API_BASE + '/ai/undo',
      sync: API_BASE + '/sync',
      settings: API_BASE + '/settings',
      resolve: API_BASE + '/resolve',
      douyinParse: API_BASE + '/douyin/parse',
      loginBiliStart: API_BASE + '/login/bilibili/start',
      loginBiliPoll: API_BASE + '/login/bilibili/poll',
      loginChromeStart: API_BASE + '/login/chrome/start',
      loginChromePoll: API_BASE + '/login/chrome/poll',
      loginChromeCancel: API_BASE + '/login/chrome/cancel',
      loginChromeConfirm: API_BASE + '/login/chrome/confirm',
      loginLogout: API_BASE + '/login/logout',
      content: API_BASE + '/content',
      clusterReview: API_BASE + '/cluster/review',
      libraryPush: API_BASE + '/library/push',
      worksSync: API_BASE + '/works/sync',
      worksUpdate: API_BASE + '/works/update',
      worksExtract: API_BASE + '/works/extract',
      worksAdd: API_BASE + '/works/add',
      worksExtractText: API_BASE + '/works/extract-text',
      export: API_BASE + '/export',
    }
    const POLL_MS = 30000
    /** Fast snapshot/status poll while an AI organize job is running. */
    const AI_POLL_MS = 2000
    const CLOCK_MS = 30000
    const TOAST_MS = 3000
    const MAX_IMAGE_BYTES = 8 * 1024 * 1024
    const TAGS_LIMIT = 12

    const KINDS = ['image', 'xhs', 'wechat', 'link', 'video', 'bilibili', 'douyin', 'drama', 'game', 'article', 'product', 'idea', 'other']
    const FUN_KINDS = ['drama', 'game']
    const KIND_LABEL_KEYS = {
      image: 'kindImage',
      xhs: 'kindXhs',
      wechat: 'kindWechat',
      link: 'kindLink',
      video: 'kindVideo',
      bilibili: 'kindBilibili',
      douyin: 'kindDouyin',
      drama: 'kindDrama',
      game: 'kindGame',
      article: 'kindArticle',
      product: 'kindProduct',
      idea: 'kindIdea',
      other: 'kindOther',
    }
    const KIND_ICONS = {
      image: 'image',
      xhs: 'note',
      wechat: 'note',
      link: 'link',
      video: 'play',
      bilibili: 'play',
      douyin: 'play',
      drama: 'tv',
      game: 'play',
      article: 'file',
      product: 'bag',
      idea: 'sparkle',
      other: 'file',
    }
    const DEADLINE_KIND_KEYS = {
      airing: 'dkAiring',
      event: 'dkEvent',
      expiry: 'dkExpiry',
      release: 'dkRelease',
      deadline: 'dkDeadline',
      none: 'dkNone',
    }
    const STATUS_KEYS = {
      inbox: 'statusInbox',
      queued: 'statusQueued',
      doing: 'statusDoing',
      done: 'statusDone',
      archived: 'statusArchived',
    }
    const TRIAGE_KEYS = {
      expired: 'triExpired',
      now: 'triNow',
      today: 'triToday',
      week: 'triWeek',
      later: 'triLater',
      done: 'triDone',
      archived: 'triArchived',
    }
    const TRIAGE_RANK = { expired: 0, now: 1, today: 2, week: 3, later: 4, done: 5, archived: 6 }

    const ZH = {
      title: '稍后再看',
      subtitle: '把攒着的内容，按值得看的顺序排好',
      tabToday: '今日',
      tabInbox: '收件箱',
      tabLibrary: '资料库',
      tabTimeline: '时效',
      tabSources: '同步',
      tabSettings: '设置',
      tabAgent: 'Agent',
      agentFilterNew: '未试',
      agentFilterOpened: '已载入',
      agentFilterTried: '已试',
      agentFilterSkipped: '跳过',
      agentCount: 'Agent 内容 {n} 条',
      agentNewCount: '{n} 条未试',
      agentTry: '尝试一下',
      agentTrying: '载入中…',
      agentMarkTried: '标记已试',
      agentSkip: '跳过',
      agentStatusNew: '未试',
      agentStatusOpened: '已载入',
      agentStatusTried: '已试',
      agentStatusSkipped: '已跳过',
      agentKindPlugin: '插件',
      agentKindSkill: 'Skill',
      agentKindPrompt: '提示词',
      agentKindAgent: 'Agent',
      agentKindOther: 'Agent 相关',
      agentEmptyTitle: '还没有识别到 Agent 相关内容',
      agentEmptyDesc: '转发的插件 / skill / 提示词会自动整理到这里',
      agentFilteredEmpty: '没有符合筛选的内容',
      agentLaunched: '已载入 DSH 新会话',
      agentCopiedFallback: '已复制提示词，去 DSH 新会话粘贴',
      agentLaunchFailed: '载入 DSH 失败',
      agentUpdated: '状态已更新',
      agentEnrich: '整理名称',
      agentEnriching: '整理中…',
      agentEnriched: '已整理 {n} 条',
      agentEnrichFailed: '整理名称失败',
      agentPromptTemplate:
        '帮我试试这条内容（来自「稍后再看」的 Agent 分类）：\n标题：{title}\n来源：{site} {url}\n摘要：{summary}\n\n请先判断它是什么（DSH 插件 / skill / 提示词 / 工具或文章），能不能直接在当前 DSH 里用：\n- 是插件/skill/prompt：给出安装或试用步骤、风险，再按我的确认执行；\n- 是文章/教程：提炼其中可直接照做的部分，给我一个最小可试方案。\n先别修改系统或装东西，等我确认。',
      refresh: '刷新',
      refreshing: '刷新中',
      aiReview: 'AI 整理',
      aiReviewing: '整理中',
      aiBadgeDone: '已整理',
      aiBadgePartial: '部分',
      aiBadgeFailed: '失败',
      aiBadgeNone: '未整理',
      aiOrganizeAll: '整理全部',
      aiOrganizing: '整理中',
      aiOrganizeProgress: '整理中 {processed}/{total}',
      aiOrganizeStarted: '开始整理 {total} 条',
      aiOrganizeSummary: '整理完成：成功 {done} · 部分 {partial} · 失败 {failed}',
      aiNothingToOrganize: '没有需要整理的条目',
      aiPendingLeft: '待整理 {n} 条',
      aiDrawerTitle: 'AI 整理',
      aiStatusLabel: '状态',
      aiReason: '理由',
      aiUpdatedAt: '整理时间',
      aiConfidence: '置信度',
      aiFields: '写入字段',
      aiTitleRaw: '改写前标题',
      aiSuggestKind: '建议类型',
      aiSuggestTopic: '建议主题',
      aiLastError: '错误信息',
      aiUndo: '撤销 AI 整理',
      aiUndoTip: '撤销会恢复 AI 整理前的内容',
      aiUndone: '已撤销 AI 整理',
      aiUntouched: '还没整理过',
      aiMissingLabel: '待补',
      aiFieldTitle: '标题',
      aiFieldSummary: '摘要',
      aiFieldCover: '封面',
      aiFieldTopic: '分类',
      filterNeedsOrganize: '待整理',
      filterOrganized: '已整理',
      add: '添加',
      settings: '设置',
      loading: '加载中…',
      retry: '重试',
      errorPrefix: '出错了',
      metaNow: '{n} 条现在该看',
      metaExpiring: '{n} 条快过期',
      metaQuiet: '暂无紧急内容',
      metaStats: '{active} 条待看 · 今天收进 {added} · 完成 {done}',
      updatedAt: '更新于 {time}',
      todayFocus: '今日焦点',
      groupNow: '现在就读',
      groupToday: '今天内',
      groupWeek: '本周',
      todayEmptyTitle: '今天没有必须看的内容，放松一下',
      todayEmptyDesc: '从微信转发给大肥鱼，或点右上角 + 添加',
      noFocusHint: '暂时没有排进今天的条目，去资料库翻翻。',
      goLibrary: '去资料库',
      expiringLabel: '快过期',
      viewTimeline: '看时效',
      inboxNotice: '转发 / 粘贴进来的内容先落这里，再按重要度和紧急度归类。',
      inboxFilterImage: '图片',
      inboxFilterArticle: '文章',
      inboxFilterVideo: '视频',
      inboxFilterMedia: '影游',
      inboxFilterOther: '其他',
      inboxFilterEmpty: '这个分类下还没有内容',
      inboxNoticeFiles: '另有 {n} 个文件在 inbox 目录里等待收取。',
      inboxEmpty: '收件箱是空的，把内容转发给大肥鱼吧',
      inboxEmptyDesc: '也可以点右上角 + 添加，或把文件丢进 inbox 目录。',
      importance: '重要',
      urgency: '紧急',
      importanceTitle: '重要 {n}/5',
      urgencyTitle: '紧急 {n}/5',
      importanceLabel: '重要度',
      urgencyLabel: '紧急度',
      kind: '类型',
      autoDetect: '自动识别',
      librarySearch: '搜索标题、摘要、标签、来源',
      searchClear: '清空搜索',
      statusAll: '全部',
      statusUnread: '未读',
      statusRead: '已读',
      statusDone: '已完成',
      statusArchived: '已归档',
      sortLabel: '排序',
      sortPriority: '优先级',
      sortNewest: '最新',
      sortDeadline: '截止最近',
      densityGrid: '网格',
      densityList: '列表',
      density: '视图',
      libraryEmpty: '没有匹配的内容',
      libraryEmptyDesc: '换个筛选或关键字试试。',
      archivedToggle: '已归档 · {n} 条',
      archivedEmpty: '没有归档内容',
      archivedHint: '归档内容不在实时快照里，展开时从备份读取。',
      archivedLoadFailed: '读取归档失败',
      restore: '恢复',
      timelineIntro: '哪些内容过了时间就不值得看了。',
      timelineEmpty: '没有带时效的内容',
      timelineEmptyDesc: '添加时填上开播、截止或活动时间，这里会按剩余时间排好。',
      bucketExpired: '已过期',
      bucketWithin24: '24 小时内',
      bucketWithin3d: '3 天内',
      bucketWithinWeek: '本周内',
      bucketLater: '更远',
      bucketNone: '无截止',
      sourcesIntro: '把 B 站和抖音的稍后再看一起收进来。Cookie 只存在本机，不会回显。',
      platformBilibili: 'B站',
      platformDouyin: '抖音',
      configured: '已配置',
      notConfigured: '未配置',
      connected: '已连接',
      disconnected: '连接异常',
      unknownState: '状态未知',
      account: '账号',
      lastSync: '上次同步',
      neverSynced: '还没同步过',
      lastResult: '上次结果',
      syncNow: '立即同步',
      syncing: '同步中',
      updateCookie: '更新 Cookie',
      saveCookie: '保存 Cookie',
      removeCookie: '解除',
      cookieLabel: 'Cookie',
      cookieRequired: '先粘贴 Cookie 再保存',
      cookieBiliHint: '在浏览器登录 B 站后，把 Cookie 里的 SESSDATA 等粘贴进来（F12 → Network → 任意请求 → Cookie）',
      cookieDyHint: '登录 douyin.com 后把完整 Cookie 粘贴进来（至少含 sessionid）；抓不到标题/封面时只入库链接。',
      cookieSaved: 'Cookie 已保存',
      cookieRemoved: '已解除绑定',
      syncDone: '同步完成：新增 {imported} · 更新 {updated} · 跳过 {skipped}',
      syncFailed: '同步失败',
      syncUnsupported: '当前环境不支持自动同步',
      syncResult: '新增 {imported} · 更新 {updated} · 跳过 {skipped}',
      douyinNote: '抖音网页端「稍后再看」需要登录 Cookie（至少含 sessionid）；把 douyin.com 登录后的完整 Cookie 粘进来即可同步。分享页在未登录时拿不到标题/封面，属于正常限制。',
      douyinParsePlaceholder: '粘贴抖音分享链接或分享文案',
      parse: '解析',
      parsing: '解析中',
      douyinSaved: '已解析入库：{title}',
      loginScan: '扫码登录',
      loginOpenWindow: '打开登录窗口',
      loginManual: '手动粘贴',
      loginStarting: '正在启动…',
      loginPending: '启动中…',
      loginQrTitle: 'B站扫码登录',
      loginChromeTitle: '抖音登录',
      loginQrHint: '用 B站 App 扫一扫二维码，扫完在手机上确认，登录状态会自动保存。',
      loginChromeHint: '已打开独立 Chrome 登录窗口，请在里面扫码或登录，完成后会自动保存。',
      loginWaiting: '等待扫码…',
      loginScanned: '已扫码，请在手机上确认',
      loginExpired: '二维码已过期',
      loginChromeWaiting: '等待登录完成…',
      loginRefresh: '刷新二维码',
      loginQrFailed: '二维码获取失败，稍后再试',
      loginQrAlt: 'B站登录二维码',
      loginClosed: '登录窗口已关闭，未完成登录',
      loginBiliSuccess: 'B站登录成功',
      loginBiliSuccessName: 'B站登录成功：{name}',
      loginDouyinSuccess: '抖音登录成功',
      loginDouyinSuccessName: '抖音登录成功：{name}',
      loginError: '登录失败',
      loginCancel: '取消登录',
      loginClose: '关闭',
      loginRetry: '重试',
      authTitle: '登录授权',
      authLoggedIn: '已登录',
      authNotLoggedIn: '未登录',
      authLogout: '退出登录',
      authConfirmLogout: '确认退出',
      authConfirmLogin: '我已完成登录',
      authConfirming: '确认中…',
      authConfirmFailed: '还没检测到登录，请先在窗口里完成登录再点一次',
      authLogoutDone: '已退出登录',
      authCookieNote: 'Cookie 只保存在本机 ~/.dsh/storages/watch-later/secrets.json，不会上传。',
      platformXhs: '小红书',
      loginXhsTitle: '小红书登录',
      loginXhsSuccess: '小红书登录成功',
      loginXhsSuccessName: '小红书登录成功：{name}',
      previewTitle: '预览',
      previewLoading: '正在读取内容…',
      previewRefresh: '刷新内容',
      previewRefreshing: '读取中…',
      previewEmpty: '暂无可直接预览的内容',
      previewTextTruncated: '仅显示前 1200 字',
      previewImageAlt: '内容图片',
      previewLightbox: '查看大图',
      previewOpenVideo: '打开原视频',
      clusterBadge: '相似 {n} 篇',
      clusterTitle: '相似内容（{n} 篇）',
      clusterHint: '这些内容很相似；点标题可打开原条目，或先用 AI 归纳看看该看哪篇。',
      clusterCurrent: '当前',
      clusterSummarize: 'AI 归纳',
      clusterSummarizing: '归纳中…',
      clusterSummaryLabel: '归纳结果',
      clusterNoLink: '这条没有可打开的链接',
      tabWant: '影游',
      tabTopics: '分类',
      topicsEmptyTitle: '还没有可分类的条目',
      topicsEmptyDesc: '把内容转发给大肥鱼，它会自动打上分类标签',
      topicsUnsorted: '待归档',
      topicsMore: '还有 {n} 条',
      tabIdeas: '灵感',
      ideasTotal: '灵感 {n} 条',
      ideasHint: '想借来用的参考',
      ideasEmptyTitle: '还没有灵感',
      ideasEmptyDesc: '看到想借来用的参考（视频、模板、构图、玩法），存的时候标成「灵感」，就会归到这里',
      mediaTotal: '影游 {n} 条',
      mediaFilterGuide: '攻略',
      mediaFilterList: '清单',
      mediaGuideTitle: '攻略 / 原文整理',
      mediaListTitle: '清单',
      mediaBadgeGuide: '攻略',
      mediaBadgeList: '清单',
      mediaSyncWorks: '同步清单',
      mediaSyncing: '同步中…',
      mediaSyncDone: '已同步清单：新增 {n} 个作品',
      mediaSyncFailed: '同步清单失败',
      mediaWorksTitle: '作品清单',
      mediaWorksEmpty: '还没有作品清单',
      mediaWorksEmptyDesc: '从攻略文章提取，或手动添加作品',
      mediaWorkFilterGame: '游戏',
      mediaWorkFilterDrama: '影视',
      mediaAddWork: '+ 添加作品',
      mediaAddWorkTitle: '添加作品',
      mediaWorkTitleLabel: '作品名称',
      mediaWorkTitlePlaceholder: '输入作品名，如：影之刃零',
      mediaWorkKindLabel: '类型',
      mediaWorkAdding: '添加中…',
      mediaWorkAdded: '已添加作品：{title}',
      mediaWorkAddFailed: '添加作品失败',
      errWorkTitleRequired: '请先填写作品名称',
      mediaExtract: '提取作品',
      mediaExtracting: '提取中…',
      mediaExtracted: '已从文章提取 {n} 个作品',
      mediaExtractFailed: '{n} 个作品添加失败',
      mediaExtractError: '提取作品失败',
      mediaExtractText: '从正文提取',
      mediaExtractTextTitle: '从正文提取作品',
      mediaExtractTitleLabel: '文章标题（可选）',
      mediaExtractTitlePlaceholder: '如：某某公众号文章',
      mediaExtractBodyLabel: '文章正文',
      mediaExtractBodyPlaceholder: '粘贴文章正文，至少 80 字',
      mediaExtractSourceLabel: '来源链接（可选）',
      mediaExtractSourcePlaceholder: 'https://…',
      mediaExtractMinHint: '正文至少 80 字才能提取',
      mediaExtractTextDone: '已提取 {n} 个作品',
      mediaExtractAdvice: '可复制正文后用「从正文提取」',
      workDetailTitle: '作品详情',
      workKindGame: '游戏',
      workKindDrama: '剧集',
      workStatusWant: '想玩',
      workStatusPlaying: '在玩',
      workStatusDone: '玩过',
      workStatusSaved: '状态已更新',
      workSourceLabel: '来源文章',
      mediaEmptyTitle: '还没有影游内容',
      mediaEmptyDesc: '转发游戏 / 影视相关文章会自动归类',
      mediaGuideEmpty: '还没有攻略 / 原文整理内容',
      mediaListEmpty: '还没有清单内容',
      wantMark: '加入影游',
      wantUnmark: '移出影游',
      wantMarked: '已加入影游',
      tabImages: '图片',
      imagesTotal: '图片 {n} 张',
      imageCountBadge: '{n} 张',
      imageOriginalsCount: '共 {n} 张原图',
      viewerPrev: '上一张',
      viewerNext: '下一张',
      imagesPushed: '已加入素材库 {n} 张',
      imagesPending: '待整理',
      imagesDone: '已处理',
      imagesSelectAll: '全选',
      imagesUnselect: '取消选择',
      imagesSelected: '已选 {n} 张',
      imageSelect: '选择这张',
      imagePreview: '图片预览',
      imageNoOriginal: '无原图',
      imageNoOriginalHint: '早期聊天转发只存了标题，没有原图',
      imagePushedBadge: '已入素材库',
      imageLoadFailed: '图片加载失败',
      pushLibrary: '加入素材库',
      pushLibraryAgain: '重新加入',
      pushLibraryBusy: '加入中…',
      pushLibraryDone: '已加入素材库 {n} 张',
      pushLibraryRepushed: '已重新加入素材库 {n} 张',
      pushLibrarySkipped: '{n} 张已在素材库',
      pushLibraryFailedCount: '{n} 张加入失败',
      batchDoneToast: '已标记完成 {n} 张',
      batchArchiveToast: '已归档 {n} 张',
      batchDeleteToast: '已删除 {n} 张',
      batchFailed: '{n} 张操作失败',
      batchBusy: '处理中…',
      confirmDeleteSelected: '确认删除 {n} 张',
      imagesEmptyTitle: '还没有图片',
      imagesEmptyDesc: '截图后分享到 DeepSeek Harness，或在面板 + 添加 → 图片',
      goAdd: '去添加',
      imagesFilteredEmpty: '没有符合筛选的图片',
      settingsDedupe: '合并相似内容',
      settingsDedupeDesc: '相似的文章 / 链接合并成一条，避免重复占位。',
      settingsAutoAi: '同步后自动 AI 整理',
      settingsAutoAiDesc: '新内容进来后让模型补全标题、分类和摘要。',
      settingsInbox: '收件箱自动收取',
      settingsInboxDesc: '投递到 inbox 目录的文件会自动收进来。',
      settingsDirs: '数据位置',
      dataDir: '数据目录',
      inboxDir: '收件箱目录',
      copy: '复制',
      copied: '已复制',
      copyFail: '复制失败，请手动选中',
      settingsRetention: '保留天数',
      settingsRetentionDesc: '已完成的内容超过 {n} 天后自动清理。',
      settingsSave: '保存',
      settingsSaved: '设置已保存',
      daysUnit: '天',
      settingsExport: '导出备份',
      settingsExportDesc: '下载包含全部内容的 JSON 备份。',
      exportOpen: '导出',
      toastExport: '已打开备份',
      settingsAiAll: 'AI 整理全部',
      settingsAiAllDesc: '让模型批量整理当前待看内容（一次最多 20 条）。',
      settingsAiModel: '模型',
      settingsAiUnavailable: '暂不可用',
      settingsAbout: '说明',
      settingsAboutText: '三条入库路径：微信转发给大肥鱼、右上角 + 添加、投递到 inbox 目录。B站和抖音在「同步」里配置。',
      toastAiDone: '整理完成：更新 {n} 条',
      toastAiNone: '没有需要整理的内容',
      toastAiError: 'AI 整理失败：{error}',
      toastDone: '已标记完成',
      toastArchived: '已归档',
      toastRestored: '已恢复',
      toastDeleted: '已删除',
      toastSnoozed: '已稍后提醒，明天再看',
      toastStarted: '已开始阅读',
      toastSaved: '已保存',
      toastAdded: '已收入稍后再看',
      toastDuplicate: '已经在稍后再看里了',
      toastImported: '已导入 {n} 条',
      toastImportSkipped: '已导入 {n} 条，跳过 {skipped} 条重复',
      drawerDetails: '详情',
      close: '关闭',
      save: '保存',
      saving: '保存中',
      saveChanges: '保存修改',
      markDone: '完成',
      archive: '归档',
      details: '详情',
      deleteItem: '删除',
      confirmDelete: '确认删除',
      cancel: '取消',
      snooze: '稍后提醒',
      tagsLabel: '标签',
      tagsPlaceholder: '用逗号分隔，如：教程, 健身',
      notesLabel: '笔记',
      notesPlaceholder: '记点什么…',
      deadlineLabel: '截止时间',
      deadlineClear: '清除',
      summaryLabel: '摘要',
      noSummary: '还没有摘要',
      openOriginal: '打开原文',
      addTitle: '添加内容',
      modeLink: '链接',
      modeText: '文本',
      modeImage: '图片',
      urlLabel: '链接',
      urlPlaceholder: 'https://…',
      titleLabel: '标题',
      titlePlaceholder: '不填会自动获取',
      resolveLoading: '正在获取预览…',
      resolveDone: '已获取预览',
      resolveFailed: '预览获取失败，不影响添加',
      textLabel: '文本',
      textPlaceholder: '粘贴一条或多条链接、分享文案，可多行',
      textModeHint: '文本模式会按规则批量解析；需要精细设置请用链接或图片模式。',
      imageLabel: '图片',
      chooseImage: '选择图片',
      noImage: '还没有选择图片',
      submitAdd: '收入稍后再看',
      submitImport: '批量导入',
      submitting: '添加中…',
      errUrlRequired: '请先填链接',
      errTextRequired: '请先粘贴文本',
      errImageRequired: '请先选择图片',
      errImageTooLarge: '图片超过 8MB（转 base64 后会更大），换一张小一点的',
      errFileRead: '图片读取失败',
      errDeadline: '截止时间格式不对',
      remainMinutes: '剩 {n} 分钟',
      remainHours: '剩 {n} 小时',
      remainDays: '还剩 {n} 天',
      remainDate: '截止 {date}',
      expiredLabel: '已过期',
      justExpired: '刚过期',
      noDeadline: '无截止',
      dkAiring: '更新',
      dkEvent: '活动',
      dkExpiry: '有效期',
      dkRelease: '开播',
      dkDeadline: '截止',
      dkNone: '无',
      kindImage: '图片',
      kindXhs: '小红书',
      kindWechat: '公众号',
      kindLink: '链接',
      kindVideo: '视频',
      kindBilibili: 'B站',
      kindDouyin: '抖音',
      kindDrama: '剧集',
      kindGame: '游戏',
      kindFun: '娱乐',
      kindArticle: '文章',
      kindProduct: '商品',
      kindIdea: '灵感',
      kindOther: '其他',
      scoreTitle: '推荐分 {n}',
      untitled: '未命名',
      durationMinutes: '约 {n} 分钟',
      triNow: '现在看',
      triToday: '今天',
      triWeek: '本周',
      triLater: '以后',
      triExpired: '已过期',
      triDone: '已完成',
      triArchived: '已归档',
      agoJustNow: '刚刚',
      agoMinutes: '{n} 分钟前',
      agoHours: '{n} 小时前',
      agoDays: '{n} 天前',
      itemsCount: '{n} 条',
    }

    const EN = {
      title: 'Watch later',
      subtitle: 'Everything you saved, ordered by what is worth watching first',
      tabToday: 'Today',
      tabInbox: 'Inbox',
      tabLibrary: 'Library',
      tabTimeline: 'Timing',
      tabSources: 'Sync',
      tabSettings: 'Settings',
      tabAgent: 'Agent',
      agentFilterNew: 'New',
      agentFilterOpened: 'Loaded',
      agentFilterTried: 'Tried',
      agentFilterSkipped: 'Skipped',
      agentCount: '{n} agent items',
      agentNewCount: '{n} untried',
      agentTry: 'Try it',
      agentTrying: 'Loading…',
      agentMarkTried: 'Mark tried',
      agentSkip: 'Skip',
      agentStatusNew: 'New',
      agentStatusOpened: 'Loaded',
      agentStatusTried: 'Tried',
      agentStatusSkipped: 'Skipped',
      agentKindPlugin: 'Plugin',
      agentKindSkill: 'Skill',
      agentKindPrompt: 'Prompt',
      agentKindAgent: 'Agent',
      agentKindOther: 'Agent related',
      agentEmptyTitle: 'No agent-related items yet',
      agentEmptyDesc: 'Forwarded plugins / skills / prompts will be organized here automatically',
      agentFilteredEmpty: 'No items match this filter',
      agentLaunched: 'Loaded into a new DSH session',
      agentCopiedFallback: 'Prompt copied — paste it into a new DSH session',
      agentLaunchFailed: 'Failed to load into DSH',
      agentUpdated: 'Status updated',
      agentEnrich: 'Organize names',
      agentEnriching: 'Organizing…',
      agentEnriched: 'Organized {n} items',
      agentEnrichFailed: 'Failed to organize names',
      agentPromptTemplate:
        'Help me try this item (from the Agent category in Watch Later):\nTitle: {title}\nSource: {site} {url}\nSummary: {summary}\n\nFirst judge what it is (DSH plugin / skill / prompt / tool or article) and whether it can be used in the current DSH:\n- plugin/skill/prompt: give install or trial steps and risks, then execute after my confirmation;\n- article/tutorial: extract the directly actionable part and give me a minimal trial plan.\nDo not modify the system or install anything yet; wait for my confirmation.',
      refresh: 'Refresh',
      refreshing: 'Refreshing',
      aiReview: 'AI sort',
      aiReviewing: 'Sorting',
      aiBadgeDone: 'Sorted',
      aiBadgePartial: 'Partial',
      aiBadgeFailed: 'Failed',
      aiBadgeNone: 'Unsorted',
      aiOrganizeAll: 'Sort all',
      aiOrganizing: 'Sorting',
      aiOrganizeProgress: 'Sorting {processed}/{total}',
      aiOrganizeStarted: 'Sorting {total} items',
      aiOrganizeSummary: 'Sorting finished: {done} sorted · {partial} partial · {failed} failed',
      aiNothingToOrganize: 'Nothing needs sorting',
      aiPendingLeft: '{n} need sorting',
      aiDrawerTitle: 'AI sorting',
      aiStatusLabel: 'Status',
      aiReason: 'Reason',
      aiUpdatedAt: 'Sorted at',
      aiConfidence: 'Confidence',
      aiFields: 'Fields written',
      aiTitleRaw: 'Title before AI',
      aiSuggestKind: 'Suggested type',
      aiSuggestTopic: 'Suggested topic',
      aiLastError: 'Error',
      aiUndo: 'Undo AI sorting',
      aiUndoTip: 'Undo restores the fields from before AI sorting',
      aiUndone: 'AI sorting undone',
      aiUntouched: 'Not sorted yet',
      aiMissingLabel: 'Missing',
      aiFieldTitle: 'title',
      aiFieldSummary: 'summary',
      aiFieldCover: 'cover',
      aiFieldTopic: 'topic',
      filterNeedsOrganize: 'Needs sorting',
      filterOrganized: 'Sorted',
      add: 'Add',
      settings: 'Settings',
      loading: 'Loading…',
      retry: 'Retry',
      errorPrefix: 'Something went wrong',
      metaNow: '{n} waiting now',
      metaExpiring: '{n} expiring soon',
      metaQuiet: 'Nothing urgent',
      metaStats: '{active} waiting · {added} added today · {done} done',
      updatedAt: 'Updated {time}',
      todayFocus: "Today's focus",
      groupNow: 'Read now',
      groupToday: 'Today',
      groupWeek: 'This week',
      todayEmptyTitle: 'Nothing you must read today — take a break',
      todayEmptyDesc: 'Forward something to DaFeiyu on WeChat, or tap + to add',
      noFocusHint: 'Nothing landed in today. Have a look in the library.',
      goLibrary: 'Open library',
      expiringLabel: 'Expiring',
      viewTimeline: 'Timing',
      inboxNotice: 'Forwarded and pasted items land here first, then get sorted by importance and urgency.',
      inboxFilterImage: 'Images',
      inboxFilterArticle: 'Articles',
      inboxFilterVideo: 'Videos',
      inboxFilterMedia: 'Media',
      inboxFilterOther: 'Other',
      inboxFilterEmpty: 'Nothing in this category yet',
      inboxNoticeFiles: '{n} files are waiting in the inbox folder.',
      inboxEmpty: 'The inbox is empty — forward something to DaFeiyu',
      inboxEmptyDesc: 'Or tap + to add, or drop a file into the inbox folder.',
      importance: 'Important',
      urgency: 'Urgent',
      importanceTitle: 'Importance {n}/5',
      urgencyTitle: 'Urgency {n}/5',
      importanceLabel: 'Importance',
      urgencyLabel: 'Urgency',
      kind: 'Type',
      autoDetect: 'Auto',
      librarySearch: 'Search title, summary, tags, source',
      searchClear: 'Clear search',
      statusAll: 'All',
      statusUnread: 'Unread',
      statusRead: 'Read',
      statusDone: 'Done',
      statusArchived: 'Archived',
      sortLabel: 'Sort',
      sortPriority: 'Priority',
      sortNewest: 'Newest',
      sortDeadline: 'Deadline',
      densityGrid: 'Grid',
      densityList: 'List',
      density: 'View',
      libraryEmpty: 'Nothing matches',
      libraryEmptyDesc: 'Try another filter or keyword.',
      archivedToggle: 'Archived · {n}',
      archivedEmpty: 'Nothing archived',
      archivedHint: 'Archived items are not in the live snapshot; they are read from the backup when expanded.',
      archivedLoadFailed: 'Could not read the archive',
      restore: 'Restore',
      timelineIntro: 'What stops being worth it once time passes.',
      timelineEmpty: 'Nothing time-sensitive',
      timelineEmptyDesc: 'Add a release, deadline or event time and this view keeps it ordered.',
      bucketExpired: 'Expired',
      bucketWithin24: 'Within 24 hours',
      bucketWithin3d: 'Within 3 days',
      bucketWithinWeek: 'This week',
      bucketLater: 'Further out',
      bucketNone: 'No deadline',
      sourcesIntro: 'Bring Bilibili and Douyin watch-later lists together. Cookies stay on this machine and are never echoed.',
      platformBilibili: 'Bilibili',
      platformDouyin: 'Douyin',
      configured: 'Configured',
      notConfigured: 'Not configured',
      connected: 'Connected',
      disconnected: 'Connection error',
      unknownState: 'Unknown',
      account: 'Account',
      lastSync: 'Last sync',
      neverSynced: 'Never synced',
      lastResult: 'Last result',
      syncNow: 'Sync now',
      syncing: 'Syncing',
      updateCookie: 'Update cookie',
      saveCookie: 'Save cookie',
      removeCookie: 'Remove',
      cookieLabel: 'Cookie',
      cookieRequired: 'Paste a cookie before saving',
      cookieBiliHint: 'Log in to Bilibili in the browser, then paste SESSDATA and friends (F12 → Network → any request → Cookie)',
      cookieDyHint: 'Log in to douyin.com and paste the full cookie (sessionid at minimum); if the title or cover is unavailable, only the link is saved.',
      cookieSaved: 'Cookie saved',
      cookieRemoved: 'Cookie removed',
      syncDone: 'Synced: {imported} added · {updated} updated · {skipped} skipped',
      syncFailed: 'Sync failed',
      syncUnsupported: 'Auto sync is not available here',
      syncResult: '{imported} added · {updated} updated · {skipped} skipped',
      douyinNote: 'Douyin web watch later needs a login cookie (sessionid at minimum); paste the full cookie from douyin.com to sync. Share pages may not expose a title or cover without login — that is expected.',
      douyinParsePlaceholder: 'Paste a Douyin share link or share text',
      parse: 'Parse',
      parsing: 'Parsing',
      douyinSaved: 'Saved: {title}',
      loginScan: 'Scan to log in',
      loginOpenWindow: 'Open login window',
      loginManual: 'Paste manually',
      loginStarting: 'Starting…',
      loginPending: 'Starting…',
      loginQrTitle: 'Bilibili QR login',
      loginChromeTitle: 'Douyin login',
      loginQrHint: 'Scan the QR code with the Bilibili app and confirm on your phone — the session is saved automatically.',
      loginChromeHint: 'A separate Chrome login window was opened. Scan or log in there and the session is saved automatically.',
      loginWaiting: 'Waiting for scan…',
      loginScanned: 'Scanned — confirm on your phone',
      loginExpired: 'QR code expired',
      loginChromeWaiting: 'Waiting for login…',
      loginRefresh: 'Refresh QR code',
      loginQrFailed: 'Could not fetch the QR code, try again later',
      loginQrAlt: 'Bilibili login QR code',
      loginClosed: 'Login window closed before finishing',
      loginBiliSuccess: 'Bilibili login succeeded',
      loginBiliSuccessName: 'Bilibili login succeeded: {name}',
      loginDouyinSuccess: 'Douyin login succeeded',
      loginDouyinSuccessName: 'Douyin login succeeded: {name}',
      loginError: 'Login failed',
      loginCancel: 'Cancel login',
      loginClose: 'Close',
      loginRetry: 'Retry',
      authTitle: 'Authorizations',
      authLoggedIn: 'Signed in',
      authNotLoggedIn: 'Not signed in',
      authLogout: 'Sign out',
      authConfirmLogout: 'Confirm sign out',
      authConfirmLogin: 'I have finished logging in',
      authConfirming: 'Checking…',
      authConfirmFailed: 'Login not detected yet — finish logging in, then tap again',
      authLogoutDone: 'Signed out',
      authCookieNote: 'Cookies are stored only on this machine at ~/.dsh/storages/watch-later/secrets.json and are never uploaded.',
      platformXhs: 'Xiaohongshu',
      loginXhsTitle: 'Xiaohongshu login',
      loginXhsSuccess: 'Xiaohongshu login succeeded',
      loginXhsSuccessName: 'Xiaohongshu login succeeded: {name}',
      previewTitle: 'Preview',
      previewLoading: 'Loading content…',
      previewRefresh: 'Refresh content',
      previewRefreshing: 'Loading…',
      previewEmpty: 'Nothing to preview directly',
      previewTextTruncated: 'Showing the first 1200 characters',
      previewImageAlt: 'Content image',
      previewLightbox: 'View full size',
      previewOpenVideo: 'Open original video',
      clusterBadge: '{n} similar',
      clusterTitle: 'Similar items ({n})',
      clusterHint: 'These items look alike; open one below, or let AI summarize which one to read.',
      clusterCurrent: 'Current',
      clusterSummarize: 'AI summarize',
      clusterSummarizing: 'Summarizing…',
      clusterSummaryLabel: 'Summary',
      clusterNoLink: 'This item has no link to open',
      tabWant: 'Media',
      tabTopics: 'Topics',
      topicsEmptyTitle: 'No items to group yet',
      topicsEmptyDesc: 'Forward something to DaFeiyu and it will be tagged automatically',
      topicsUnsorted: 'Unsorted',
      topicsMore: '{n} more',
      tabIdeas: 'Ideas',
      ideasTotal: '{n} ideas',
      ideasHint: 'References worth borrowing',
      ideasEmptyTitle: 'No ideas yet',
      ideasEmptyDesc: 'When something is worth borrowing (a video, a template, a framing, a mechanic), save it as an idea and it lands here',
      mediaTotal: '{n} media items',
      mediaFilterGuide: 'Guides',
      mediaFilterList: 'Lists',
      mediaGuideTitle: 'Guides / write-ups',
      mediaListTitle: 'Lists',
      mediaBadgeGuide: 'Guide',
      mediaBadgeList: 'List',
      mediaSyncWorks: 'Sync list',
      mediaSyncing: 'Syncing…',
      mediaSyncDone: 'List synced: {n} works added',
      mediaSyncFailed: 'Failed to sync the list',
      mediaWorksTitle: 'Works',
      mediaWorksEmpty: 'No works list yet',
      mediaWorksEmptyDesc: 'Extract from guide articles, or add a work manually',
      mediaWorkFilterGame: 'Games',
      mediaWorkFilterDrama: 'Film & TV',
      mediaAddWork: '+ Add work',
      mediaAddWorkTitle: 'Add a work',
      mediaWorkTitleLabel: 'Title',
      mediaWorkTitlePlaceholder: 'e.g. Phantom Blade Zero',
      mediaWorkKindLabel: 'Type',
      mediaWorkAdding: 'Adding…',
      mediaWorkAdded: 'Work added: {title}',
      mediaWorkAddFailed: 'Failed to add the work',
      errWorkTitleRequired: 'Enter a work title first',
      mediaExtract: 'Extract works',
      mediaExtracting: 'Extracting…',
      mediaExtracted: 'Extracted {n} works from the article',
      mediaExtractFailed: '{n} works failed to add',
      mediaExtractError: 'Failed to extract works',
      mediaExtractText: 'Extract from text',
      mediaExtractTextTitle: 'Extract works from pasted text',
      mediaExtractTitleLabel: 'Article title (optional)',
      mediaExtractTitlePlaceholder: 'e.g. an article from a public account',
      mediaExtractBodyLabel: 'Article text',
      mediaExtractBodyPlaceholder: 'Paste the article text, at least 80 characters',
      mediaExtractSourceLabel: 'Source URL (optional)',
      mediaExtractSourcePlaceholder: 'https://…',
      mediaExtractMinHint: 'Paste at least 80 characters of text',
      mediaExtractTextDone: 'Extracted {n} works',
      mediaExtractAdvice: 'Copy the text and use "Extract from text"',
      workDetailTitle: 'Work details',
      workKindGame: 'Game',
      workKindDrama: 'Series',
      workStatusWant: 'Want to play',
      workStatusPlaying: 'Playing',
      workStatusDone: 'Played',
      workStatusSaved: 'Status updated',
      workSourceLabel: 'Source article',
      mediaEmptyTitle: 'No media items yet',
      mediaEmptyDesc: 'Forwarded game / film & TV articles will be grouped here automatically',
      mediaGuideEmpty: 'No guides / write-ups yet',
      mediaListEmpty: 'No lists yet',
      wantMark: 'Add to Media',
      wantUnmark: 'Remove from Media',
      wantMarked: 'Added to Media',
      tabImages: 'Images',
      imagesTotal: '{n} images',
      imageCountBadge: '{n} images',
      imageOriginalsCount: '{n} original images',
      viewerPrev: 'Previous image',
      viewerNext: 'Next image',
      imagesPushed: '{n} in library',
      imagesPending: 'To sort',
      imagesDone: 'Done',
      imagesSelectAll: 'Select all',
      imagesUnselect: 'Clear selection',
      imagesSelected: '{n} selected',
      imageSelect: 'Select this image',
      imagePreview: 'Image preview',
      imageNoOriginal: 'No original image',
      imageNoOriginalHint: 'Early chat forwards kept only the title, no image file',
      imagePushedBadge: 'In library',
      imageLoadFailed: 'Image failed to load',
      pushLibrary: 'Add to library',
      pushLibraryAgain: 'Add again',
      pushLibraryBusy: 'Adding…',
      pushLibraryDone: '{n} added to the library',
      pushLibraryRepushed: '{n} re-added to the library',
      pushLibrarySkipped: '{n} already in the library',
      pushLibraryFailedCount: '{n} failed to add',
      batchDoneToast: '{n} marked done',
      batchArchiveToast: '{n} archived',
      batchDeleteToast: '{n} deleted',
      batchFailed: '{n} failed',
      batchBusy: 'Working…',
      confirmDeleteSelected: 'Delete {n} images',
      imagesEmptyTitle: 'No images yet',
      imagesEmptyDesc: 'Share a screenshot to DeepSeek Harness, or use + Add → Image in the panel',
      goAdd: 'Add now',
      imagesFilteredEmpty: 'No images match this filter',
      settingsDedupe: 'Merge similar items',
      settingsDedupeDesc: 'Cluster similar articles and links into one entry to avoid duplicates.',
      settingsAutoAi: 'Auto AI sort after sync',
      settingsAutoAiDesc: 'Let the model fill in title, kind and summary for new items.',
      settingsInbox: 'Auto-collect inbox',
      settingsInboxDesc: 'Files dropped into the inbox folder are collected automatically.',
      settingsDirs: 'Data locations',
      dataDir: 'Data dir',
      inboxDir: 'Inbox dir',
      copy: 'Copy',
      copied: 'Copied',
      copyFail: 'Copy failed — select it manually',
      settingsRetention: 'Retention days',
      settingsRetentionDesc: 'Finished items are cleaned up after {n} days.',
      settingsSave: 'Save',
      settingsSaved: 'Settings saved',
      daysUnit: 'days',
      settingsExport: 'Export backup',
      settingsExportDesc: 'Download a JSON backup with everything.',
      exportOpen: 'Export',
      toastExport: 'Backup opened',
      settingsAiAll: 'AI sort all',
      settingsAiAllDesc: 'Classify pending items in bulk (up to 20 at a time).',
      settingsAiModel: 'Model',
      settingsAiUnavailable: 'Unavailable',
      settingsAbout: 'About',
      settingsAboutText: 'Three ways in: forward to DaFeiyu on WeChat, tap + to add, or drop files into the inbox folder. Configure Bilibili and Douyin under Sync.',
      toastAiDone: 'Sorted: {n} updated',
      toastAiNone: 'Nothing to sort',
      toastAiError: 'AI sort failed: {error}',
      toastDone: 'Marked done',
      toastArchived: 'Archived',
      toastRestored: 'Restored',
      toastDeleted: 'Deleted',
      toastSnoozed: 'Snoozed until tomorrow',
      toastStarted: 'Started reading',
      toastSaved: 'Saved',
      toastAdded: 'Added to watch later',
      toastDuplicate: 'Already in watch later',
      toastImported: 'Imported {n}',
      toastImportSkipped: 'Imported {n}, skipped {skipped} duplicates',
      drawerDetails: 'Details',
      close: 'Close',
      save: 'Save',
      saving: 'Saving',
      saveChanges: 'Save changes',
      markDone: 'Done',
      archive: 'Archive',
      details: 'Details',
      deleteItem: 'Delete',
      confirmDelete: 'Confirm delete',
      cancel: 'Cancel',
      snooze: 'Snooze',
      tagsLabel: 'Tags',
      tagsPlaceholder: 'Comma separated, e.g. tutorial, fitness',
      notesLabel: 'Notes',
      notesPlaceholder: 'Write a note…',
      deadlineLabel: 'Deadline',
      deadlineClear: 'Clear',
      summaryLabel: 'Summary',
      noSummary: 'No summary yet',
      openOriginal: 'Open original',
      addTitle: 'Add to watch later',
      modeLink: 'Link',
      modeText: 'Text',
      modeImage: 'Image',
      urlLabel: 'URL',
      urlPlaceholder: 'https://…',
      titleLabel: 'Title',
      titlePlaceholder: 'Auto-filled if empty',
      resolveLoading: 'Fetching preview…',
      resolveDone: 'Preview ready',
      resolveFailed: 'Preview failed — you can still add it',
      textLabel: 'Text',
      textPlaceholder: 'Paste one or more links or share texts, one per line',
      textModeHint: 'Text mode parses in bulk; use Link or Image mode for fine control.',
      imageLabel: 'Image',
      chooseImage: 'Choose image',
      noImage: 'No image selected',
      submitAdd: 'Save to watch later',
      submitImport: 'Import all',
      submitting: 'Adding…',
      errUrlRequired: 'Enter a URL first',
      errTextRequired: 'Paste some text first',
      errImageRequired: 'Choose an image first',
      errImageTooLarge: 'Image is over 8MB (base64 grows it further) — pick a smaller one',
      errFileRead: 'Could not read the image',
      errDeadline: 'That deadline format is not valid',
      remainMinutes: '{n} min left',
      remainHours: '{n} h left',
      remainDays: '{n} days left',
      remainDate: 'Due {date}',
      expiredLabel: 'Expired',
      justExpired: 'Just expired',
      noDeadline: 'No deadline',
      dkAiring: 'Airing',
      dkEvent: 'Event',
      dkExpiry: 'Valid until',
      dkRelease: 'Release',
      dkDeadline: 'Deadline',
      dkNone: 'None',
      kindImage: 'Image',
      kindXhs: 'Xiaohongshu',
      kindWechat: 'WeChat',
      kindLink: 'Link',
      kindVideo: 'Video',
      kindBilibili: 'Bilibili',
      kindDouyin: 'Douyin',
      kindDrama: 'Series',
      kindGame: 'Game',
      kindFun: 'Fun',
      kindArticle: 'Article',
      kindProduct: 'Product',
      kindIdea: 'Inspiration',
      kindOther: 'Other',
      scoreTitle: 'Rank {n}',
      untitled: 'Untitled',
      durationMinutes: '~{n} min',
      triNow: 'Now',
      triToday: 'Today',
      triWeek: 'This week',
      triLater: 'Later',
      triExpired: 'Expired',
      triDone: 'Done',
      triArchived: 'Archived',
      agoJustNow: 'just now',
      agoMinutes: '{n} min ago',
      agoHours: '{n} h ago',
      agoDays: '{n} days ago',
      itemsCount: '{n}',
    }

    /* ---------------------------------------------------------------- utils */

    function hasOwn(object, key) {
      return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key)
    }

    function asObject(value) {
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    }

    function asArray(value) {
      return Array.isArray(value) ? value : []
    }

    function asText(value) {
      return value === null || value === undefined ? '' : String(value)
    }

    function asNumber(value) {
      if (value === null || value === undefined || value === '') return null
      const number = Number(value)
      return Number.isFinite(number) ? number : null
    }

    function numOr(value, fallback) {
      const number = asNumber(value)
      return number === null ? fallback : number
    }

    function clampInt(value, min, max) {
      const number = Math.round(numOr(value, min))
      return Math.min(max, Math.max(min, number))
    }

    function tr(t, key) {
      let value = null
      try {
        value = t(key)
      } catch {
        value = null
      }
      if (typeof value === 'string' && value && value !== key) return value
      return hasOwn(ZH, key) ? ZH[key] : key
    }

    function ti(t, key, params) {
      let text = tr(t, key)
      const map = params || {}
      Object.keys(map).forEach((name) => {
        text = text.split('{' + name + '}').join(String(map[name]))
      })
      return text
    }

    function parseTime(value) {
      if (typeof value === 'number') return Number.isFinite(value) ? value : null
      if (!value) return null
      const ms = Date.parse(String(value))
      return Number.isFinite(ms) ? ms : null
    }

    function pad2(value) {
      return String(value).padStart(2, '0')
    }

    function fmtDateTime(ms) {
      if (!Number.isFinite(ms)) return ''
      const date = new Date(ms)
      return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
    }

    function fmtShort(input) {
      const ms = parseTime(input)
      if (ms === null) return ''
      const date = new Date(ms)
      return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
    }

    function fmtTime(ms) {
      const input = typeof ms === 'number' ? ms : parseTime(ms)
      if (input === null) return ''
      const date = new Date(input)
      return pad2(date.getHours()) + ':' + pad2(date.getMinutes())
    }

    function toLocalInput(input) {
      const ms = parseTime(input)
      if (ms === null) return ''
      const date = new Date(ms)
      return (
        date.getFullYear() +
        '-' +
        pad2(date.getMonth() + 1) +
        '-' +
        pad2(date.getDate()) +
        'T' +
        pad2(date.getHours()) +
        ':' +
        pad2(date.getMinutes())
      )
    }

    function fromLocalInput(value) {
      if (!value) return null
      const ms = Date.parse(String(value))
      return Number.isFinite(ms) ? new Date(ms).toISOString() : null
    }

    function timeAgo(t, input, nowMs) {
      const ms = parseTime(input)
      if (ms === null) return ''
      const now = Number.isFinite(nowMs) ? nowMs : Date.now()
      const minutes = Math.floor(Math.max(0, now - ms) / 60000)
      if (minutes < 1) return tr(t, 'agoJustNow')
      if (minutes < 60) return ti(t, 'agoMinutes', { n: minutes })
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return ti(t, 'agoHours', { n: hours })
      return ti(t, 'agoDays', { n: Math.floor(hours / 24) })
    }

    function kindLabel(t, kind) {
      return tr(t, KIND_LABEL_KEYS[kind] || 'kindOther')
    }

    function kindIcon(kind) {
      return KIND_ICONS[kind] || 'file'
    }

    function deadlineKindLabel(t, kind) {
      return tr(t, DEADLINE_KIND_KEYS[kind] || 'dkDeadline')
    }

    const AGENT_KIND_KEYS = {
      plugin: 'agentKindPlugin',
      skill: 'agentKindSkill',
      prompt: 'agentKindPrompt',
      agent: 'agentKindAgent',
    }
    const AGENT_CATEGORIES = ['prompt', 'plugin', 'skill']
    const AGENT_STATUS_KEYS = {
      new: 'agentStatusNew',
      opened: 'agentStatusOpened',
      tried: 'agentStatusTried',
      skipped: 'agentStatusSkipped',
    }

    function agentKindLabel(t, kind) {
      return tr(t, AGENT_KIND_KEYS[kind] || 'agentKindOther')
    }

    function agentStatusLabel(t, status) {
      return tr(t, AGENT_STATUS_KEYS[status] || 'agentStatusNew')
    }

    function statusLabel(t, status) {
      return tr(t, STATUS_KEYS[status] || 'statusInbox')
    }

    function triageLabel(t, triage) {
      return tr(t, TRIAGE_KEYS[triage] || 'triLater')
    }

    function tagsOf(item) {
      const raw = item && item.tags
      if (Array.isArray(raw)) {
        return raw.map((tag) => asText(tag).trim()).filter(Boolean)
      }
      if (typeof raw === 'string') {
        return raw
          .split(/[,，、\n]/)
          .map((tag) => tag.trim())
          .filter(Boolean)
      }
      return []
    }

    function parseTags(input) {
      const seen = {}
      const tags = []
      asText(input)
        .split(/[,，、\n]/)
        .map((tag) => tag.trim())
        .filter(Boolean)
        .forEach((tag) => {
          const key = tag.toLowerCase()
          if (seen[key]) return
          seen[key] = true
          if (tags.length < TAGS_LIMIT) tags.push(tag)
        })
      return tags
    }

    function domainOf(url) {
      const raw = asText(url)
      if (!raw) return ''
      try {
        return new URL(raw).hostname.replace(/^www\./i, '')
      } catch {
        return raw.replace(/^https?:\/\//i, '').split('/')[0]
      }
    }

    function hoursLeftOf(item, nowMs) {
      const sensitivity = asObject(item && item.timeSensitivity)
      const direct = asNumber(sensitivity.hoursLeft)
      if (direct !== null) return direct
      const deadline = parseTime(item && item.deadline)
      if (deadline === null) return null
      return (deadline - (Number.isFinite(nowMs) ? nowMs : Date.now())) / 3600e3
    }

    function levelOf(item, nowMs) {
      const sensitivity = asObject(item && item.timeSensitivity)
      if (typeof sensitivity.level === 'string' && sensitivity.level) return sensitivity.level
      const hours = hoursLeftOf(item, nowMs)
      if (hours === null) return 'none'
      if (hours < 0) return 'expired'
      if (hours <= 24) return 'critical'
      if (hours <= 72) return 'soon'
      if (hours <= 336) return 'ahead'
      return 'ahead'
    }

    function countdownOf(t, item, nowMs) {
      const hours = hoursLeftOf(item, nowMs)
      const level = levelOf(item, nowMs)
      if (hours === null) return { known: false, level: 'none', tone: 'none', text: '' }
      const tone = level === 'expired' ? 'expired' : level === 'critical' ? 'critical' : level === 'soon' ? 'soon' : 'normal'
      if (hours < 0) {
        const text = hours > -24 ? tr(t, 'justExpired') : tr(t, 'expiredLabel')
        return { known: true, level, tone, text, hours }
      }
      if (hours < 1) {
        return { known: true, level, tone, text: ti(t, 'remainMinutes', { n: Math.max(1, Math.round(hours * 60)) }), hours }
      }
      if (hours < 24) {
        return { known: true, level, tone, text: ti(t, 'remainHours', { n: Math.max(1, Math.round(hours)) }), hours }
      }
      const days = Math.max(1, Math.floor(hours / 24))
      if (days <= 30) {
        return { known: true, level, tone, text: ti(t, 'remainDays', { n: days }), hours }
      }
      return { known: true, level, tone, text: ti(t, 'remainDate', { date: fmtShort(item && item.deadline) }), hours }
    }

    function triageOf(item, nowMs) {
      const status = asText(item && item.status)
      if (status === 'done' || status === 'archived') return status
      const triage = asText(item && item.triage)
      if (triage === 'expired' || triage === 'now' || triage === 'today' || triage === 'week' || triage === 'later') return triage
      const hours = hoursLeftOf(item, nowMs)
      if (hours === null) return 'week'
      if (hours < 0) return 'expired'
      if (hours <= 24) return 'now'
      if (hours <= 72) return 'today'
      return 'week'
    }

    function isActiveStatus(status) {
      return status === 'inbox' || status === 'queued' || status === 'doing'
    }

    function byCreatedDesc(a, b) {
      return (parseTime(b && b.createdAt) || 0) - (parseTime(a && a.createdAt) || 0)
    }

    function byPriority(nowMs) {
      return (a, b) => {
        const rankA = TRIAGE_RANK[triageOf(a, nowMs)] === undefined ? 9 : TRIAGE_RANK[triageOf(a, nowMs)]
        const rankB = TRIAGE_RANK[triageOf(b, nowMs)] === undefined ? 9 : TRIAGE_RANK[triageOf(b, nowMs)]
        if (rankA !== rankB) return rankA - rankB
        return numOr(b && b.score, 0) - numOr(a && a.score, 0)
      }
    }

    function sortByDeadline(a, b) {
      const deadlineA = parseTime(a && a.deadline)
      const deadlineB = parseTime(b && b.deadline)
      if (deadlineA === null && deadlineB === null) return numOr(b && b.score, 0) - numOr(a && a.score, 0)
      if (deadlineA === null) return 1
      if (deadlineB === null) return -1
      if (deadlineA !== deadlineB) return deadlineA - deadlineB
      return numOr(b && b.score, 0) - numOr(a && a.score, 0)
    }

    function matchesQuery(item, query) {
      const needle = asText(query).trim().toLowerCase()
      if (!needle) return true
      const haystack = [
        asText(item && item.title),
        asText(item && item.summary),
        asText(item && item.site),
        asText(item && item.author),
        tagsOf(item).join(' '),
      ]
        .join(' ')
        .toLowerCase()
      return haystack.indexOf(needle) >= 0
    }

    function itemGallery(item) {
      const source = asArray(asObject(item).images)
        .map((entry) => asText(entry))
        .filter(Boolean)
      if (source.length) return source.slice(0, MAX_GALLERY_IMAGES)
      const cover = asText(asObject(item).cover)
      return cover ? [cover] : []
    }

    function contentGallery(item, content) {
      const list = []
      const push = (value) => {
        const url = asText(value)
        if (url && list.indexOf(url) < 0 && list.length < 12) list.push(url)
      }
      asArray(asObject(item).images).forEach(push)
      asArray(asObject(content).images).forEach(push)
      push(asObject(item).cover)
      return list
    }

    function formatDuration(t, minutes) {
      const value = asNumber(minutes)
      if (value === null || value <= 0) return ''
      return ti(t, 'durationMinutes', { n: Math.round(value) })
    }

    function copyText(text) {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(String(text)).catch(() => {})
          return true
        }
      } catch {
        // clipboard is best effort
      }
      return false
    }

    function agentPromptText(t, item) {
      const source = asObject(item)
      return ti(t, 'agentPromptTemplate', {
        title: asText(source.title) || tr(t, 'untitled'),
        site: asText(source.site) || '—',
        url: asText(source.url) || '—',
        summary: asText(source.summary) || tr(t, 'noSummary'),
      })
    }

    function canLaunchAgent(runtime) {
      const services = asObject(runtime)
      const workspaces = asObject(services.workspaces)
      const sessions = asObject(services.sessions)
      const conversation = asObject(services.conversation)
      const input = asObject(conversation.input)
      const uiWorkspace = asObject(services.uiWorkspace)
      return Boolean(
        typeof workspaces.initializeDefault === 'function' &&
          typeof sessions.create === 'function' &&
          typeof sessions.retain === 'function' &&
          typeof sessions.scope === 'function' &&
          typeof input.for === 'function' &&
          typeof uiWorkspace.openSession === 'function',
      )
    }

    async function launchAgentSession(runtime, prompt) {
      const services = asObject(runtime)
      const workspace = await services.workspaces.initializeDefault()
      const workspaceId = asText(workspace && (workspace.workspaceId || workspace.id))
      if (!workspaceId) throw new Error('DSH workspace 初始化失败')
      const created = await services.sessions.create({ workspaceId })
      const sessionId = asText(
        typeof created === 'string' ? created : created && (created.id || created.sessionId),
      )
      if (!sessionId) throw new Error('DSH 会话创建失败')
      let reference = null
      try {
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        reference = services.sessions.retain(sessionId, {
          source: 'watch-later',
          ...(controller ? { signal: controller.signal } : {}),
        })
        if (reference && reference.ready && typeof reference.ready.then === 'function') await reference.ready
        const scoped = services.sessions.scope(sessionId)
        const input = services.conversation.input.for(scoped)
        const actions = asObject(input && input.actions)
        if (typeof actions.setDraft !== 'function') throw new Error('DSH 会话草稿不可写')
        actions.setDraft(prompt)
        if (typeof actions.persistDraft === 'function') {
          try {
            await actions.persistDraft()
          } catch {
            // persist is best effort
          }
        }
        services.uiWorkspace.openSession(sessionId)
        return sessionId
      } finally {
        if (reference && typeof reference.release === 'function') {
          try {
            reference.release()
          } catch {
            // release is best effort
          }
        }
      }
    }

    async function postJson(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify(body || {}),
      })
      let data = null
      try {
        data = await response.json()
      } catch {
        data = null
      }
      if (!response.ok || !data || data.ok === false) {
        throw new Error((data && data.error) || 'HTTP ' + response.status)
      }
      return data
    }

    async function postJsonSoft(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify(body || {}),
      })
      let data = null
      try {
        data = await response.json()
      } catch {
        data = null
      }
      if (!response.ok) throw new Error((data && data.error) || 'HTTP ' + response.status)
      if (!data || typeof data !== 'object') throw new Error('HTTP ' + response.status)
      return data
    }

    async function getJson(path) {
      const response = await fetch(path, { cache: 'no-store' })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      return response.json()
    }

    /* ----------------------------------------------------------------- data */

    function useSnapshot() {
      const [state, setState] = React.useState({ data: null, loading: true, error: null })
      const [refreshing, setRefreshing] = React.useState(false)
      const mounted = React.useRef(true)
      const requestId = React.useRef(0)

      const load = React.useCallback(async (manual) => {
        const ticket = ++requestId.current
        if (manual === true) setRefreshing(true)
        try {
          const response = await fetch(API.snapshot, { cache: 'no-store' })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          const data = await response.json()
          if (!mounted.current || ticket !== requestId.current) return
          setState({ data: data && typeof data === 'object' ? data : {}, loading: false, error: null })
        } catch (error) {
          if (!mounted.current || ticket !== requestId.current) return
          setState((previous) => ({
            data: previous.data,
            loading: false,
            error: String((error && error.message) || error),
          }))
        } finally {
          if (mounted.current && manual === true) setRefreshing(false)
        }
      }, [])

      React.useEffect(() => {
        mounted.current = true
        load(false)
        const poll = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          load(false)
        }
        const timer = window.setInterval(poll, POLL_MS)
        const onVisibility = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'visible') load(false)
        }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
        return () => {
          mounted.current = false
          window.clearInterval(timer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [load])

      const reload = React.useCallback(() => load(true), [load])
      const retry = React.useCallback(() => load(false), [load])

      return { data: state.data, loading: state.loading, error: state.error, refreshing, reload, retry }
    }

    function useNow(intervalMs) {
      const [now, setNow] = React.useState(() => Date.now())
      React.useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), intervalMs || CLOCK_MS)
        return () => window.clearInterval(timer)
      }, [intervalMs])
      return now
    }

    function useContentPreview(itemId) {
      const [state, setState] = React.useState({ loading: true, fetchError: null, content: null })
      const [refreshing, setRefreshing] = React.useState(false)
      const mounted = React.useRef(true)
      const requestId = React.useRef(0)

      const load = React.useCallback(
        async (force) => {
          const ticket = ++requestId.current
          const id = asText(itemId)
          if (!id) {
            setState({ loading: false, fetchError: null, content: null })
            return
          }
          if (force) setRefreshing(true)
          try {
            const query = '?id=' + encodeURIComponent(id) + (force ? '&refresh=1' : '')
            const response = await fetch(API.content + query, { cache: 'no-store' })
            let data = null
            try {
              data = await response.json()
            } catch {
              data = null
            }
            if (!response.ok || !data || data.ok === false) {
              throw new Error((data && data.error) || 'HTTP ' + response.status)
            }
            if (!mounted.current || ticket !== requestId.current) return
            setState({ loading: false, fetchError: null, content: asObject(data.content) })
          } catch (failure) {
            if (!mounted.current || ticket !== requestId.current) return
            setState({ loading: false, fetchError: String((failure && failure.message) || failure), content: null })
          } finally {
            if (mounted.current && force) setRefreshing(false)
          }
        },
        [itemId],
      )

      React.useEffect(() => {
        mounted.current = true
        setState({ loading: true, fetchError: null, content: null })
        load(false)
        return () => {
          mounted.current = false
        }
      }, [load])

      return {
        loading: state.loading,
        fetchError: state.fetchError,
        content: state.content,
        refreshing,
        reload: () => {
          const promise = load(true)
          if (promise && typeof promise.catch === 'function') promise.catch(() => {})
        },
      }
    }

    function useEscape(onEscape, active) {
      const handler = React.useRef(onEscape)
      handler.current = onEscape
      React.useEffect(() => {
        if (active === false) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape' && typeof handler.current === 'function') handler.current()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [active])
    }

    /* ---------------------------------------------------------------- icons */

    function Icon(props) {
      const name = props && props.name ? props.name : 'dot'
      const size = props && props.size ? props.size : 16
      const className = 'wl-icon' + (props && props.className ? ' ' + props.className : '')
      const common = {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        className,
        'aria-hidden': true,
        focusable: false,
      }
      if (name === 'refresh') {
        return h('svg', common, h('path', { d: 'M13.1 8.2A5.2 5.2 0 1 1 11.4 4' }), h('path', { d: 'M13.1 2.4v2.8h-2.8' }))
      }
      if (name === 'sparkle') {
        return h(
          'svg',
          common,
          h('path', { d: 'M6.6 2.2 7.9 6l3.8 1.3-3.8 1.3-1.3 3.8-1.3-3.8L1.5 7.3 5.3 6z' }),
          h('path', { d: 'M12.3 9.6l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6z' }),
        )
      }
      if (name === 'plus') return h('svg', common, h('path', { d: 'M8 2.8v10.4' }), h('path', { d: 'M2.8 8h10.4' }))
      if (name === 'settings') {
        return h(
          'svg',
          common,
          h('path', { d: 'M2.4 5h11.2' }),
          h('path', { d: 'M2.4 11h11.2' }),
          h('circle', { cx: 6, cy: 5, r: 1.7 }),
          h('circle', { cx: 10.4, cy: 11, r: 1.7 }),
        )
      }
      if (name === 'search') return h('svg', common, h('circle', { cx: 6.9, cy: 6.9, r: 4.1 }), h('path', { d: 'M10 10l3.4 3.4' }))
      if (name === 'close') return h('svg', common, h('path', { d: 'M4 4l8 8' }), h('path', { d: 'M12 4l-8 8' }))
      if (name === 'check') return h('svg', common, h('path', { d: 'M2.8 8.6l3.1 3.1 7.3-7.4' }))
      if (name === 'archive') {
        return h(
          'svg',
          common,
          h('path', { d: 'M2.2 5.4h11.6v7.4H2.2z' }),
          h('path', { d: 'M1.8 2.9h12.4v2.5H1.8z' }),
          h('path', { d: 'M6.4 8.6h3.2' }),
        )
      }
      if (name === 'trash') {
        return h(
          'svg',
          common,
          h('path', { d: 'M2.8 4.4h10.4' }),
          h('path', { d: 'M6.2 4.4V2.9h3.6v1.5' }),
          h('path', { d: 'M4.5 4.4l.7 8.7h5.6l.7-8.7' }),
          h('path', { d: 'M6.8 7v3.7' }),
          h('path', { d: 'M9.2 7v3.7' }),
        )
      }
      if (name === 'clock') return h('svg', common, h('circle', { cx: 8, cy: 8, r: 5.4 }), h('path', { d: 'M8 4.9v3.4l2.3 1.4' }))
      if (name === 'warning') {
        return h('svg', common, h('path', { d: 'M8 2.4 14 13H2z' }), h('path', { d: 'M8 6.4v3.2' }), h('path', { d: 'M8 11.6h.01' }))
      }
      if (name === 'external') {
        return h(
          'svg',
          common,
          h('path', { d: 'M9.4 2.6h4v4' }),
          h('path', { d: 'M13.4 2.6 7.9 8.1' }),
          h('path', { d: 'M11.6 9.6v3.8H2.6V4.4h3.8' }),
        )
      }
      if (name === 'chevron') return h('svg', common, h('path', { d: 'M4 6.2l4 4 4-4' }))
      if (name === 'image') {
        return h('svg', common, h('rect', { x: 2.2, y: 3, width: 11.6, height: 10, rx: 1.6 }), h('circle', { cx: 5.9, cy: 6.3, r: 1.2 }), h('path', { d: 'M3 11.4l3.2-3 2.3 2.1 2-1.8 2.3 2.3' }))
      }
      if (name === 'note' || name === 'file') {
        return h(
          'svg',
          common,
          h('path', { d: 'M3.6 2.4h5.6l3.2 3.2v8H3.6z' }),
          h('path', { d: 'M9.2 2.4v3.4h3.2' }),
          h('path', { d: 'M5.8 8.2h4.4' }),
          h('path', { d: 'M5.8 10.6h4.4' }),
        )
      }
      if (name === 'link') {
        return h(
          'svg',
          common,
          h('path', { d: 'M6.6 9.4l2.8-2.8' }),
          h('path', { d: 'M6.3 4.8l1.2-1.2a2.7 2.7 0 0 1 3.8 3.8l-1.2 1.2' }),
          h('path', { d: 'M9.7 11.2l-1.2 1.2a2.7 2.7 0 0 1-3.8-3.8l1.2-1.2' }),
        )
      }
      if (name === 'play') {
        return h('svg', common, h('rect', { x: 2.2, y: 3.4, width: 11.6, height: 9.2, rx: 1.8 }), h('path', { d: 'M6.7 6.1l3.2 1.9-3.2 1.9z' }))
      }
      if (name === 'tv') {
        return h('svg', common, h('rect', { x: 2.2, y: 4.4, width: 11.6, height: 8.6, rx: 1.6 }), h('path', { d: 'M8 4.4 6.2 2.2' }), h('path', { d: 'M8 4.4l1.8-2.2' }))
      }
      if (name === 'bag') {
        return h('svg', common, h('path', { d: 'M3.2 5.4h9.6l-.8 8H4z' }), h('path', { d: 'M5.8 5.4V4a2.2 2.2 0 0 1 4.4 0v1.4' }))
      }
      if (name === 'chevronLeft') return h('svg', common, h('path', { d: 'M9.8 3.8 5.6 8l4.2 4.2' }))
      if (name === 'chevronRight') return h('svg', common, h('path', { d: 'M6.2 3.8 10.4 8l-4.2 4.2' }))
      if (name === 'library') {
        return h(
          'svg',
          common,
          h('path', { d: 'M2.4 13.2h11.2' }),
          h('path', { d: 'M3.9 13.2V5.6' }),
          h('path', { d: 'M8 13.2V3.9' }),
          h('path', { d: 'M12.1 13.2V7.4' }),
          h('path', { d: 'M3.1 3.9h9.8' }),
        )
      }
      if (name === 'shield') {
        return h(
          'svg',
          common,
          h('path', { d: 'M8 1.9 13 3.7v4.2c0 3.1-2.1 5.2-5 6.2-2.9-1-5-3.1-5-6.2V3.7z' }),
          h('circle', { cx: 8, cy: 6.9, r: 1.5 }),
          h('path', { d: 'M8 8.4v2.2' }),
        )
      }
      if (name === 'eye') {
        return h(
          'svg',
          common,
          h('path', { d: 'M1.8 8s2.2-4.2 6.2-4.2S14.2 8 14.2 8s-2.2 4.2-6.2 4.2S1.8 8 1.8 8z' }),
          h('circle', { cx: 8, cy: 8, r: 2.1 }),
        )
      }
      if (name === 'qr') {
        return h(
          'svg',
          common,
          h('path', { d: 'M2.6 2.6h4.2v4.2H2.6z' }),
          h('path', { d: 'M9.2 2.6h4.2v4.2H9.2z' }),
          h('path', { d: 'M2.6 9.2h4.2v4.2H2.6z' }),
          h('path', { d: 'M9.2 9.2h1.3v1.3H9.2z' }),
          h('path', { d: 'M12.1 9.2h1.3v1.3h-1.3z' }),
          h('path', { d: 'M9.2 12.1h1.3v1.3H9.2z' }),
          h('path', { d: 'M12.1 12.1h1.3v1.3h-1.3z' }),
        )
      }
      if (name === 'grid') {
        return h('svg', common, h('rect', { x: 2.4, y: 2.4, width: 4.6, height: 4.6, rx: 1 }), h('rect', { x: 9, y: 2.4, width: 4.6, height: 4.6, rx: 1 }), h('rect', { x: 2.4, y: 9, width: 4.6, height: 4.6, rx: 1 }), h('rect', { x: 9, y: 9, width: 4.6, height: 4.6, rx: 1 }))
      }
      if (name === 'list') {
        return h('svg', common, h('path', { d: 'M5.4 4h8.2' }), h('path', { d: 'M5.4 8h8.2' }), h('path', { d: 'M5.4 12h8.2' }), h('path', { d: 'M2.6 4h.01' }), h('path', { d: 'M2.6 8h.01' }), h('path', { d: 'M2.6 12h.01' }))
      }
      return h('svg', common, h('circle', { cx: 8, cy: 8, r: 2.4 }))
    }

    /* ------------------------------------------------------------- ui atoms */

    function coverInitials(title) {
      const text = asText(title)
        .replace(/\s+/g, ' ')
        .replace(/[「」『』【】《》（）()\[\]<>·—\-_,，。!！?？:：;；'"“”‘’]/g, '')
        .trim()
      if (!text) return '·'
      const cjk = text.match(/[\u4e00-\u9fa5]/g) || []
      if (cjk.length >= 2) return cjk.slice(0, 2).join('')
      if (cjk.length === 1) return cjk[0]
      const words = text.split(' ').filter(Boolean)
      if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
      return text.slice(0, 2).toUpperCase()
    }

    function Cover(props) {
      const t = props.t
      const item = asObject(props.item)
      const kind = asText(item.kind) || 'other'
      const source = asText(item.cover)
      const [failed, setFailed] = React.useState(false)
      React.useEffect(() => {
        setFailed(false)
      }, [source])
      const className = 'wl-cover' + (props.className ? ' ' + props.className : '')
      if (source && !failed) {
        return h(
          'div',
          { className },
          h('img', {
            className: 'wl-cover-img',
            src: source,
            alt: '',
            loading: 'lazy',
            draggable: false,
            onError: () => setFailed(true),
          }),
        )
      }
      const title = asText(item.title)
      const site = asText(item.site)
      const noImage = kind === 'image'
      return h(
        'div',
        {
          className: className + ' wl-cover-fallback' + (noImage ? ' wl-cover-fallback-empty' : ''),
          'data-kind': kind,
        },
        h(
          'span',
          { className: 'wl-cover-glyph', 'aria-hidden': true },
          h(Icon, { name: kindIcon(kind), size: props.hero ? 78 : 56 }),
        ),
        h(
          'div',
          { className: 'wl-cover-foot' },
          h('span', { className: 'wl-cover-mark' }, coverInitials(title)),
          h(
            'span',
            { className: 'wl-cover-caption' },
            h('span', { className: 'wl-cover-site', title: site || kindLabel(t, kind) }, site || kindLabel(t, kind)),
            h('span', { className: 'wl-cover-kicker' }, kindLabel(t, kind)),
          ),
        ),
        noImage ? h('span', { className: 'wl-cover-empty-tag' }, tr(t, 'imageNoOriginal')) : null,
      )
    }

    function ScoreBadge(props) {
      const value = asNumber(props.score)
      const tone = value === null ? 'weak' : value >= 78 ? 'high' : value >= 62 ? 'mid' : 'weak'
      const title = value === null ? tr(props.t, 'scoreTitle').replace('{n}', '—') : ti(props.t, 'scoreTitle', { n: Math.round(value) })
      return h('span', { className: 'wl-score', 'data-tone': tone, title }, value === null ? '—' : String(Math.round(value)))
    }

    function LevelDots(props) {
      const level = clampInt(props.value, 1, 5)
      const title = props.label + ' ' + level + '/5'
      return h(
        'span',
        { className: 'wl-dots', title, 'aria-label': title },
        h('span', { className: 'wl-dots-label' }, props.label),
        h(
          'span',
          { className: 'wl-dots-track', 'data-tone': props.tone || 'brand' },
          [1, 2, 3, 4, 5].map((step) => h('span', { key: step, className: 'wl-dot', 'data-on': step <= level ? 'true' : 'false' })),
        ),
      )
    }

    function LevelDotsInput(props) {
      const level = clampInt(props.value, 1, 5)
      return h(
        'div',
        { className: 'wl-dots-input' },
        h('span', { className: 'wl-field-label' }, props.label),
        h(
          'div',
          { className: 'wl-dots-track', 'data-tone': props.tone || 'brand', role: 'group', 'aria-label': props.label },
          [1, 2, 3, 4, 5].map((step) =>
            h(
              'button',
              {
                key: step,
                type: 'button',
                className: 'wl-dot-btn',
                title: props.label + ' ' + step + '/5',
                'aria-label': props.label + ' ' + step + '/5',
                'aria-pressed': step === level ? 'true' : 'false',
                'data-on': step <= level ? 'true' : 'false',
                disabled: Boolean(props.disabled),
                onClick: () => {
                  if (typeof props.onChange === 'function') props.onChange(step)
                },
              },
              h('span', { className: 'wl-dot' }),
            ),
          ),
        ),
      )
    }

    function Switch(props) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': props.checked ? 'true' : 'false',
          'aria-label': props.label,
          title: props.label,
          className: 'wl-switch',
          'data-on': props.checked ? 'true' : 'false',
          disabled: Boolean(props.disabled),
          onClick: () => {
            if (typeof props.onChange === 'function') props.onChange(!props.checked)
          },
        },
        h('span', { className: 'wl-switch-thumb' }),
      )
    }

    function KindChip(props) {
      const kind = asText(props.kind) || 'other'
      return h('span', { className: 'wl-kind-chip', 'data-kind': kind, title: kindLabel(props.t, kind) }, kindLabel(props.t, kind))
    }

    const AI_STATE_KEYS = {
      done: 'aiBadgeDone',
      partial: 'aiBadgePartial',
      failed: 'aiBadgeFailed',
      none: 'aiBadgeNone',
    }

    /** Normalised AI organize state of one item: done | partial | failed | none. */
    function aiStateOf(item) {
      const state = asText(asObject(asObject(item).ai).state)
      return state === 'done' || state === 'partial' || state === 'failed' ? state : 'none'
    }

    function aiStateLabel(t, state) {
      return tr(t, AI_STATE_KEYS[state] || 'aiBadgeNone')
    }

    const AI_MISSING_KEYS = { title: 'aiFieldTitle', summary: 'aiFieldSummary', cover: 'aiFieldCover', topic: 'aiFieldTopic' }

    function AiBadge(props) {
      const t = props.t
      const item = asObject(props.item)
      const ai = asObject(item.ai)
      const state = aiStateOf(item)
      const label = aiStateLabel(t, state)
      const reason = asText(ai.reason)
      const lastError = asText(ai.lastError)
      const missing = asArray(ai.missing)
        .map((key) => tr(t, AI_MISSING_KEYS[key] || 'aiFieldTitle'))
        .filter(Boolean)
      const lines = [tr(t, 'aiDrawerTitle') + ' · ' + label]
      if (reason) lines.push(reason)
      if (missing.length) lines.push(tr(t, 'aiMissingLabel') + '：' + missing.join('、'))
      if (lastError) lines.push(tr(t, 'aiLastError') + '：' + lastError)
      const title = lines.join('\n')
      return h(
        'span',
        { className: 'wl-ai-badge is-' + state, 'data-ai-state': state, title, 'aria-label': title },
        state === 'none' ? null : h(Icon, { name: 'sparkle', size: 10 }),
        h('span', { className: 'wl-ai-badge-label' }, label),
      )
    }

    function DeadlineChip(props) {
      const item = asObject(props.item)
      if (!asText(item.deadline)) return null
      const info = countdownOf(props.t, item, props.now)
      if (!info.known) return null
      const deadlineMs = parseTime(item.deadline)
      const title = [deadlineKindLabel(props.t, item.deadlineKind), fmtDateTime(deadlineMs)].filter(Boolean).join(' · ')
      return h(
        'span',
        { className: 'wl-deadline', 'data-tone': info.tone, title },
        h(Icon, { name: 'clock', size: 12 }),
        h('span', null, info.text),
      )
    }

    function LoadingState(props) {
      return h(
        'div',
        { className: 'wl-state' },
        h('div', { className: 'wl-state-icon wl-pulse' }, h(Icon, { name: 'clock', size: 20 })),
        h('p', { className: 'wl-state-title' }, tr(props.t, 'loading')),
      )
    }

    function ErrorState(props) {
      return h(
        'div',
        { className: 'wl-state wl-state-error', role: 'alert' },
        h('div', { className: 'wl-state-icon' }, h(Icon, { name: 'warning', size: 20 })),
        h('p', { className: 'wl-state-title' }, tr(props.t, 'errorPrefix')),
        h('p', { className: 'wl-state-desc' }, asText(props.error)),
        h(
          'button',
          { type: 'button', className: 'wl-btn wl-btn-primary', title: tr(props.t, 'retry'), onClick: props.onRetry },
          tr(props.t, 'retry'),
        ),
      )
    }

    function ErrorBar(props) {
      if (!props.error) return null
      return h(
        'div',
        { className: 'wl-error-bar', role: 'alert' },
        h(Icon, { name: 'warning', size: 14 }),
        h('span', { className: 'wl-error-text' }, tr(props.t, 'errorPrefix') + '：' + asText(props.error)),
        props.onRetry
          ? h('button', { type: 'button', className: 'wl-btn wl-btn-sm', title: tr(props.t, 'retry'), onClick: props.onRetry }, tr(props.t, 'retry'))
          : null,
      )
    }

    function EmptyState(props) {
      return h(
        'div',
        { className: 'wl-state' },
        h('div', { className: 'wl-state-icon' }, h(Icon, { name: props.icon || 'archive', size: 20 })),
        h('p', { className: 'wl-state-title' }, props.title),
        props.desc ? h('p', { className: 'wl-state-desc' }, props.desc) : null,
        props.actionLabel && props.onAction
          ? h('button', { type: 'button', className: 'wl-btn', title: props.actionLabel, onClick: props.onAction }, props.actionLabel)
          : null,
      )
    }

    function SectionHead(props) {
      return h(
        'div',
        { className: 'wl-section-head' },
        h('h2', { className: 'wl-section-title' }, props.title),
        props.count === null || props.count === undefined
          ? null
          : h('span', { className: 'wl-section-count' }, ti(props.t, 'itemsCount', { n: props.count })),
        props.onMore
          ? h('button', { type: 'button', className: 'wl-link-btn', title: props.moreLabel, onClick: props.onMore }, props.moreLabel)
          : null,
      )
    }

    /* ---------------------------------------------------------- image viewer */

    function ImageViewer(props) {
      const t = props.t
      const images = asArray(props.images)
        .map((value) => asText(value))
        .filter(Boolean)
      const total = images.length
      const [index, setIndex] = React.useState(() => clampInt(props.index, 0, Math.max(0, total - 1)))
      const [failed, setFailed] = React.useState(false)

      React.useEffect(() => {
        setIndex(clampInt(props.index, 0, Math.max(0, total - 1)))
        setFailed(false)
      }, [props.index, total])

      React.useEffect(() => {
        setFailed(false)
      }, [index])

      useEscape(() => {
        if (typeof props.onClose === 'function') props.onClose()
      }, true)

      React.useEffect(() => {
        if (total < 2) return undefined
        const onKey = (event) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault()
            setIndex((previous) => (previous - 1 + total) % total)
          } else if (event.key === 'ArrowRight') {
            event.preventDefault()
            setIndex((previous) => (previous + 1) % total)
          }
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [total])

      const close = (event) => {
        if (event) event.stopPropagation()
        if (typeof props.onClose === 'function') props.onClose()
      }
      const go = (delta) => {
        setFailed(false)
        setIndex((previous) => {
          if (!total) return 0
          return (previous + delta + total) % total
        })
      }
      const currentIndex = total ? clampInt(index, 0, total - 1) : 0
      const src = images[currentIndex] || ''

      return h(
        'div',
        {
          className: 'wl-imglb',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': tr(t, 'imagePreview'),
          onClick: close,
        },
        h(
          'div',
          { className: 'wl-imglb-panel', onClick: (event) => event.stopPropagation() },
          h(
            'div',
            { className: 'wl-imglb-media' },
            src && !failed
              ? h('img', {
                  className: 'wl-imglb-img',
                  src,
                  alt: asText(props.title) || tr(t, 'imagePreview'),
                  onError: () => setFailed(true),
                })
              : h(
                  'div',
                  { className: 'wl-imglb-placeholder' },
                  h(Icon, { name: 'image', size: 28 }),
                  h('strong', null, failed ? tr(t, 'imageLoadFailed') : tr(t, 'imageNoOriginal')),
                  h('span', { className: 'wl-imglb-placeholder-hint' }, tr(t, 'imageNoOriginalHint')),
                ),
            total > 1
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'wl-icon-btn wl-imglb-nav wl-imglb-prev',
                    title: tr(t, 'viewerPrev'),
                    'aria-label': tr(t, 'viewerPrev'),
                    onClick: (event) => {
                      event.stopPropagation()
                      go(-1)
                    },
                  },
                  h(Icon, { name: 'chevronLeft', size: 18 }),
                )
              : null,
            total > 1
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'wl-icon-btn wl-imglb-nav wl-imglb-next',
                    title: tr(t, 'viewerNext'),
                    'aria-label': tr(t, 'viewerNext'),
                    onClick: (event) => {
                      event.stopPropagation()
                      go(1)
                    },
                  },
                  h(Icon, { name: 'chevronRight', size: 18 }),
                )
              : null,
            total > 1
              ? h('span', { className: 'wl-imglb-counter' }, String(currentIndex + 1) + ' / ' + String(total))
              : null,
          ),
          asText(props.title) || props.meta || props.actions
            ? h(
                'div',
                { className: 'wl-imglb-info' },
                asText(props.title) ? h('h3', { className: 'wl-imglb-title' }, asText(props.title)) : null,
                asText(props.meta) ? h('div', { className: 'wl-imglb-meta' }, asText(props.meta)) : null,
                props.actions || null,
              )
            : null,
          h(
            'button',
            {
              type: 'button',
              className: 'wl-icon-btn wl-imglb-close',
              title: tr(t, 'close'),
              'aria-label': tr(t, 'close'),
              onClick: close,
            },
            h(Icon, { name: 'close', size: 18 }),
          ),
        ),
      )
    }

    /* -------------------------------------------------------------- preview */

    function ContentPreview(props) {
      const t = props.t
      const item = asObject(props.item)
      const preview = asObject(props.preview)
      const content = asObject(preview.content)
      const loading = preview.loading === true
      const fetchError = asText(preview.fetchError)
      const contentError = asText(content.error)
      const videoInfo = asObject(content.video)
      const openUrl = asText(item.url) || asText(videoInfo.url)
      const zoom = (list, index) => {
        const gallery = asArray(list)
          .map((entry) => asText(entry))
          .filter(Boolean)
        if (!gallery.length) return
        if (typeof props.onOpenViewer === 'function') {
          props.onOpenViewer(gallery, clampInt(index, 0, Math.max(0, gallery.length - 1)))
        }
      }
      const openExternal = () => {
        if (openUrl && typeof props.onOpenExternal === 'function') props.onOpenExternal(openUrl)
      }
      const openButton = openUrl
        ? h(
            'button',
            { type: 'button', className: 'wl-btn wl-btn-sm', title: tr(t, 'openOriginal'), onClick: openExternal },
            h(Icon, { name: 'external', size: 13 }),
            tr(t, 'openOriginal'),
          )
        : null
      const refreshButton = h(
        'button',
        {
          type: 'button',
          className: 'wl-btn wl-btn-sm',
          title: tr(t, 'previewRefresh'),
          disabled: loading || preview.refreshing === true,
          onClick: () => {
            if (typeof preview.reload === 'function') preview.reload()
          },
        },
        h(Icon, { name: 'refresh', size: 13, className: preview.refreshing ? 'wl-spin' : '' }),
        preview.refreshing ? tr(t, 'previewRefreshing') : tr(t, 'previewRefresh'),
      )
      const kind = asText(item.kind)
      const type =
        asText(content.type) ||
        (kind === 'image' ? 'image' : kind === 'bilibili' || kind === 'douyin' || kind === 'video' ? 'video' : 'article')
      let body = null
      if (loading) {
        body = h('p', { className: 'wl-preview-empty wl-pulse' }, tr(t, 'previewLoading'))
      } else if (fetchError) {
        body = h(
          'div',
          { className: 'wl-preview-body' },
          h(
            'div',
            { className: 'wl-error-bar', role: 'alert' },
            h(Icon, { name: 'warning', size: 14 }),
            h('span', { className: 'wl-error-text' }, fetchError),
          ),
          openButton ? h('div', { className: 'wl-preview-foot' }, openButton) : null,
        )
      } else {
        const images = asArray(content.images)
          .map((entry) => asText(entry))
          .filter(Boolean)
        const text = asText(content.text)
        const parts = []
        if (contentError) {
          parts.push(
            h(
              'div',
              { className: 'wl-warn-bar', role: 'status' },
              h(Icon, { name: 'warning', size: 13 }),
              h('span', { className: 'wl-warn-text' }, contentError),
            ),
          )
        }
        if (type === 'image') {
          const gallery = contentGallery(item, content)
          if (gallery.length > 1) {
            parts.push(h('span', { className: 'wl-preview-count' }, ti(t, 'imageOriginalsCount', { n: gallery.length })))
            parts.push(
              h(
                'div',
                { className: 'wl-preview-thumbs wl-preview-thumbs-many' },
                gallery.slice(0, MAX_GALLERY_IMAGES).map((src, index) =>
                  h(
                    'button',
                    {
                      key: src + index,
                      type: 'button',
                      className: 'wl-preview-thumb',
                      title: tr(t, 'previewLightbox'),
                      onClick: () => zoom(gallery, index),
                    },
                    h('img', { src, alt: tr(t, 'previewImageAlt'), loading: 'lazy' }),
                  ),
                ),
              ),
            )
          } else if (gallery.length === 1) {
            const src = gallery[0]
            parts.push(
              h(
                'button',
                {
                  type: 'button',
                  className: 'wl-preview-image-btn',
                  title: tr(t, 'previewLightbox'),
                  onClick: () => zoom(gallery, 0),
                },
                h('img', { className: 'wl-preview-image', src, alt: tr(t, 'previewImageAlt'), loading: 'lazy' }),
              ),
            )
          } else {
            parts.push(h('p', { className: 'wl-preview-empty' }, tr(t, 'previewEmpty')))
          }
        } else if (type === 'video') {
          const embed = asText(videoInfo.embedUrl)
          if (embed) {
            parts.push(
              h(
                'div',
                { className: 'wl-preview-video' },
                h('iframe', {
                  src: embed,
                  title: asText(item.title) || tr(t, 'previewTitle'),
                  allow: 'autoplay; fullscreen; picture-in-picture',
                  allowFullScreen: true,
                  loading: 'lazy',
                }),
              ),
            )
            if (text) parts.push(h('p', { className: 'wl-preview-desc' }, text.slice(0, 400)))
          } else {
            const cover = asText(videoInfo.cover) || images[0] || asText(item.cover)
            if (cover) {
              parts.push(
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'wl-preview-image-btn',
                    title: tr(t, 'previewLightbox'),
                    onClick: () => zoom([cover], 0),
                  },
                  h('img', { className: 'wl-preview-image', src: cover, alt: tr(t, 'previewImageAlt'), loading: 'lazy' }),
                ),
              )
            }
            if (text) parts.push(h('p', { className: 'wl-preview-desc' }, text.slice(0, 400)))
            if (!cover && !text) parts.push(h('p', { className: 'wl-preview-empty' }, tr(t, 'previewEmpty')))
            const videoUrl = asText(videoInfo.url) || openUrl
            if (videoUrl) {
              parts.push(
                h(
                  'div',
                  { className: 'wl-preview-foot' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'wl-btn wl-btn-sm wl-btn-accent',
                      title: tr(t, 'previewOpenVideo'),
                      onClick: () => {
                        if (typeof props.onOpenExternal === 'function') props.onOpenExternal(videoUrl)
                      },
                    },
                    h(Icon, { name: 'external', size: 13 }),
                    tr(t, 'previewOpenVideo'),
                  ),
                ),
              )
            }
          }
        } else if (type === 'article' || type === 'page' || type === 'link') {
          if (text) {
            parts.push(h('div', { className: 'wl-preview-text' }, text.slice(0, 1200) + (text.length > 1200 ? '…' : '')))
            if (text.length > 1200) parts.push(h('span', { className: 'wl-preview-hint' }, tr(t, 'previewTextTruncated')))
          }
          if (images.length) {
            parts.push(
              h(
                'div',
                { className: 'wl-preview-thumbs' },
                images.slice(0, 3).map((src, index) =>
                  h(
                    'button',
                    {
                      key: src + index,
                      type: 'button',
                      className: 'wl-preview-thumb',
                      title: tr(t, 'previewLightbox'),
                      onClick: () => zoom(images.slice(0, 3), index),
                    },
                    h('img', { src, alt: tr(t, 'previewImageAlt'), loading: 'lazy' }),
                  ),
                ),
              ),
            )
          }
          if (!text && !images.length) parts.push(h('p', { className: 'wl-preview-empty' }, tr(t, 'previewEmpty')))
        } else {
          if (text) {
            parts.push(h('div', { className: 'wl-preview-text' }, text.slice(0, 1200) + (text.length > 1200 ? '…' : '')))
          } else {
            parts.push(h('p', { className: 'wl-preview-empty' }, tr(t, 'previewEmpty')))
          }
        }
        if (openButton && !(type === 'video' && !asText(videoInfo.embedUrl))) {
          parts.push(h('div', { className: 'wl-preview-foot' }, openButton))
        }
        body = h(
          'div',
          { className: 'wl-preview-body' },
          parts.map((part, index) => h(React.Fragment, { key: index }, part)),
        )
      }
      return h(
        'section',
        { className: 'wl-drawer-section wl-preview', 'aria-label': tr(t, 'previewTitle') },
        h(
          'div',
          { className: 'wl-preview-head' },
          h('h3', { className: 'wl-drawer-label' }, h(Icon, { name: 'eye', size: 13 }), tr(t, 'previewTitle')),
          h('span', { className: 'wl-spacer' }),
          refreshButton,
        ),
        body,
      )
    }

    /* -------------------------------------------------------------- cluster */

    function ClusterSection(props) {
      const t = props.t
      const item = asObject(props.item)
      const cluster = asObject(item.cluster)
      const size = numOr(cluster.size, 0)
      const memberIds = asArray(cluster.memberIds).map((value) => asText(value))
      const titles = asArray(cluster.titles).map((value) => asText(value))
      const currentId = asText(item.id)
      const aiSummary = asText(asObject(item.ai).clusterSummary)
      const alive = React.useRef(true)
      const [summary, setSummary] = React.useState(aiSummary)
      const [reviewMembers, setReviewMembers] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)

      React.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      React.useEffect(() => {
        setSummary(aiSummary)
        setError(null)
      }, [currentId, aiSummary])

      if (size < 2) return null

      const members =
        reviewMembers ||
        memberIds.map((id, index) => ({ id, title: titles[index] || tr(t, 'untitled'), url: '' }))

      const openMember = async (member) => {
        const id = asText(member.id)
        if (!id || id === currentId) return
        if (typeof props.onOpenMember === 'function' && props.onOpenMember(id)) return
        if (asText(member.url)) {
          if (typeof props.onOpenExternal === 'function') props.onOpenExternal(member.url)
          return
        }
        let popup = null
        try {
          popup = window.open('', '_blank')
        } catch {
          popup = null
        }
        try {
          const response = await fetch(API.content + '?id=' + encodeURIComponent(id), { cache: 'no-store' })
          let data = null
          try {
            data = await response.json()
          } catch {
            data = null
          }
          const url = asText(asObject(asObject(data).item).url)
          if (url) {
            if (popup && !popup.closed) {
              popup.location.href = url
              if (typeof popup.focus === 'function') popup.focus()
            } else if (typeof props.onOpenExternal === 'function') {
              props.onOpenExternal(url)
            }
          } else {
            if (popup && !popup.closed) popup.close()
            if (typeof props.notify === 'function') props.notify(tr(t, 'clusterNoLink'), 'warn')
          }
        } catch (failure) {
          if (popup && !popup.closed) popup.close()
          if (typeof props.notify === 'function') props.notify(String((failure && failure.message) || failure), 'error')
        }
      }

      const summarize = async () => {
        if (busy) return
        setBusy(true)
        setError(null)
        try {
          const data = await postJson(API.clusterReview, { id: currentId })
          if (!alive.current) return
          const nextSummary = asText(data.summary)
          if (nextSummary) setSummary(nextSummary)
          const list = asArray(data.members)
            .map((member) => ({
              id: asText(member.id),
              title: asText(member.title) || tr(t, 'untitled'),
              url: asText(member.url),
            }))
            .filter((member) => member.id)
          if (list.length) setReviewMembers(list)
          if (typeof props.onReload === 'function') props.onReload()
        } catch (failure) {
          if (!alive.current) return
          setError(String((failure && failure.message) || failure))
        } finally {
          if (alive.current) setBusy(false)
        }
      }

      return h(
        'section',
        { className: 'wl-drawer-section wl-cluster', 'aria-label': ti(t, 'clusterTitle', { n: size }) },
        h('h3', { className: 'wl-drawer-label' }, ti(t, 'clusterTitle', { n: size })),
        h('p', { className: 'wl-field-hint' }, tr(t, 'clusterHint')),
        h(
          'div',
          { className: 'wl-cluster-list' },
          members.map((member, index) =>
            h(
              'button',
              {
                key: (member.id || 'member') + '-' + index,
                type: 'button',
                className: 'wl-cluster-member',
                'data-current': member.id === currentId ? 'true' : 'false',
                title: member.id === currentId ? tr(t, 'clusterCurrent') : member.title || tr(t, 'untitled'),
                disabled: member.id === currentId,
                onClick: () => {
                  const promise = openMember(member)
                  if (promise && typeof promise.catch === 'function') promise.catch(() => {})
                },
              },
              h('span', { className: 'wl-cluster-member-title' }, member.title || tr(t, 'untitled')),
              member.id === currentId
                ? h('span', { className: 'wl-cluster-member-tag' }, tr(t, 'clusterCurrent'))
                : null,
            ),
          ),
        ),
        summary
          ? h(
              'div',
              { className: 'wl-cluster-summary' },
              h('span', { className: 'wl-field-label' }, tr(t, 'clusterSummaryLabel')),
              h('p', { className: 'wl-cluster-summary-text' }, summary),
            )
          : null,
        error
          ? h(
              'div',
              { className: 'wl-error-bar', role: 'alert' },
              h(Icon, { name: 'warning', size: 14 }),
              h('span', { className: 'wl-error-text' }, error),
            )
          : null,
        h(
          'div',
          { className: 'wl-cluster-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'wl-btn wl-btn-sm',
              title: tr(t, 'clusterSummarize'),
              disabled: busy,
              onClick: summarize,
            },
            h(Icon, { name: 'sparkle', size: 13 }),
            busy ? tr(t, 'clusterSummarizing') : tr(t, 'clusterSummarize'),
          ),
        ),
      )
    }

    /* ----------------------------------------------------------------- card */

    function ItemCard(props) {
      const t = props.t
      const item = asObject(props.item)
      const now = props.now
      const title = asText(item.title) || tr(t, 'untitled')
      const kind = asText(item.kind) || 'other'
      const site = asText(item.site)
      const author = asText(item.author)
      const duration = formatDuration(t, item.durationMin)
      const meta = [site, author, duration].filter(Boolean)
      const tags = tagsOf(item).slice(0, 3)
      const cluster = asObject(item.cluster)
      const clusterSize = numOr(cluster.size, 0)
      const pending = Boolean(props.pending)
      const openDetail = () => {
        if (typeof props.onOpen === 'function') props.onOpen(item.id)
      }
      const runAction = (action) => (event) => {
        if (event) {
          event.stopPropagation()
          event.preventDefault()
        }
        if (pending) return
        if (typeof props.onAction === 'function') props.onAction(item, action)
      }
      return h(
        'article',
        {
          className: 'wl-card' + (props.hero ? ' wl-card-hero' : '') + (props.dense ? ' wl-card-dense' : ''),
          role: 'button',
          tabIndex: 0,
          title: tr(t, 'details'),
          onClick: openDetail,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              openDetail()
            }
          },
        },
        h(Cover, { t, item, iconSize: props.hero ? 28 : 22 }),
        h(
          'div',
          { className: 'wl-card-body' },
          h(
            'div',
            { className: 'wl-card-head' },
            h(KindChip, { t, kind }),
            h(AiBadge, { t, item }),
            clusterSize >= 2
              ? h(
                  'span',
                  { className: 'wl-cluster-badge', title: ti(t, 'clusterBadge', { n: clusterSize }) },
                  ti(t, 'clusterBadge', { n: clusterSize }),
                )
              : null,
            h('span', { className: 'wl-spacer' }),
            h(ScoreBadge, { t, score: item.score }),
          ),
          h('h3', { className: 'wl-card-title', title }, title),
          meta.length ? h('div', { className: 'wl-card-meta' }, meta.join(' · ')) : null,
          h(
            'div',
            { className: 'wl-card-foot' },
            h(
              'div',
              { className: 'wl-card-signals' },
              h(LevelDots, { label: tr(t, 'importance'), value: item.importance, tone: 'brand' }),
              h(LevelDots, { label: tr(t, 'urgency'), value: item.urgency, tone: 'warn' }),
            ),
            h(DeadlineChip, { t, item, now }),
          ),
          tags.length
            ? h(
                'div',
                { className: 'wl-tags' },
                tags.map((tag, index) => h('span', { key: tag + index, className: 'wl-tag', title: tag }, tag)),
              )
            : null,
        ),
        h(
          'div',
          { className: 'wl-card-actions' },
          h(
            'button',
            { type: 'button', className: 'wl-card-act', title: tr(t, 'markDone'), 'aria-label': tr(t, 'markDone'), disabled: pending, onClick: runAction('done') },
            h(Icon, { name: 'check', size: 14 }),
          ),
          h(
            'button',
            { type: 'button', className: 'wl-card-act', title: tr(t, 'archive'), 'aria-label': tr(t, 'archive'), disabled: pending, onClick: runAction('archive') },
            h(Icon, { name: 'archive', size: 14 }),
          ),
          h(
            'button',
            { type: 'button', className: 'wl-card-act', title: tr(t, 'details'), 'aria-label': tr(t, 'details'), onClick: openDetail },
            h(Icon, { name: 'chevron', size: 14 }),
          ),
        ),
      )
    }

    function ExpiringBanner(props) {
      const list = asArray(props.items).filter(Boolean).slice(0, 3)
      if (!list.length) return null
      return h(
        'section',
        { className: 'wl-banner', 'aria-label': tr(props.t, 'expiringLabel') },
        h('span', { className: 'wl-banner-lead' }, h(Icon, { name: 'warning', size: 14 }), tr(props.t, 'expiringLabel')),
        h(
          'div',
          { className: 'wl-banner-list' },
          list.map((item, index) => {
            const countdown = countdownOf(props.t, item, props.now)
            return h(
              'button',
              {
                key: asText(item.id) || 'exp-' + index,
                type: 'button',
                className: 'wl-banner-item',
                title: tr(props.t, 'details'),
                onClick: () => {
                  if (typeof props.onOpen === 'function') props.onOpen(item.id)
                },
              },
              h('span', { className: 'wl-banner-title' }, asText(item.title) || tr(props.t, 'untitled')),
              h('span', { className: 'wl-banner-time', 'data-tone': countdown.tone }, countdown.text),
            )
          }),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'wl-link-btn',
            title: tr(props.t, 'viewTimeline'),
            onClick: () => {
              if (typeof props.onViewAll === 'function') props.onViewAll()
            },
          },
          tr(props.t, 'viewTimeline'),
        ),
      )
    }

    /* --------------------------------------------------------------- drawer */

    function drawerForm(item) {
      const source = asObject(item)
      return {
        importance: clampInt(source.importance, 1, 5),
        urgency: clampInt(source.urgency, 1, 5),
        deadline: toLocalInput(source.deadline),
        tags: tagsOf(source).join(', '),
        notes: asText(source.notes),
      }
    }

    function ItemDrawer(props) {
      const t = props.t
      const item = asObject(props.item)
      const panelRef = React.useRef(null)
      const [form, setForm] = React.useState(() => drawerForm(item))
      const [saving, setSaving] = React.useState(false)
      const [deleting, setDeleting] = React.useState(false)
      const [confirmDelete, setConfirmDelete] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [viewer, setViewer] = React.useState(null)
      const [undoing, setUndoing] = React.useState(false)
      const itemId = asText(item.id)
      const preview = useContentPreview(itemId)

      React.useEffect(() => {
        setForm(drawerForm(item))
        setConfirmDelete(false)
        setError(null)
        setViewer(null)
      }, [itemId])

      React.useEffect(() => {
        const previous = typeof document !== 'undefined' ? document.activeElement : null
        const node = panelRef.current
        if (node && typeof node.focus === 'function') node.focus()
        return () => {
          if (previous && typeof previous.focus === 'function') {
            try {
              previous.focus()
            } catch {
              // the previous node may be gone
            }
          }
        }
      }, [])

      useEscape(() => {
        if (viewer) {
          setViewer(null)
          return
        }
        props.onClose()
      }, true)

      const patchForm = (patch) => setForm((previous) => Object.assign({}, previous, patch))
      const title = asText(item.title) || tr(t, 'untitled')
      const summary = asText(item.summary)
      const meta = [triageLabel(t, triageOf(item, props.now)), asText(item.site), asText(item.author)]
        .filter(Boolean)
        .join(' · ')
      const isDone = item.status === 'done'
      const isArchived = item.status === 'archived'
      const isWant = asText(item.kind) === 'game' || asText(item.kind) === 'drama'

      // 「AI 整理」在这条上的痕迹：状态、理由、建议、可撤销快照
      const aiInfo = asObject(item.ai)
      const aiState = aiStateOf(item)
      const aiReason = asText(aiInfo.reason)
      const aiLastError = asText(aiInfo.lastError)
      const aiAt = parseTime(aiInfo.at)
      const aiFields = asArray(aiInfo.fields)
      const aiSuggest = asObject(aiInfo.suggest)
      const aiSuggestKind = asText(aiSuggest.kind)
      const aiSuggestTopic = asText(aiSuggest.topic)
      const aiPrev = asObject(aiInfo.prev)
      const aiCanUndo = Object.keys(aiPrev).length > 0
      const aiTitleRaw = asText(item.titleRaw)

      const close = (event) => {
        if (event) event.stopPropagation()
        if (typeof props.onClose === 'function') props.onClose()
      }

      const save = async () => {
        if (saving) return
        const deadlineIso = form.deadline ? fromLocalInput(form.deadline) : null
        if (form.deadline && !deadlineIso) {
          setError(tr(t, 'errDeadline'))
          return
        }
        const patch = {
          importance: clampInt(form.importance, 1, 5),
          urgency: clampInt(form.urgency, 1, 5),
          tags: parseTags(form.tags),
          notes: asText(form.notes).trim() || null,
          deadline: deadlineIso,
          deadlineKind: deadlineIso ? (item.deadlineKind && item.deadlineKind !== 'none' ? item.deadlineKind : 'deadline') : 'none',
        }
        setSaving(true)
        setError(null)
        try {
          await props.onSave(patch)
          if (typeof props.onClose === 'function') props.onClose()
        } catch (failure) {
          setError(String((failure && failure.message) || failure))
        } finally {
          setSaving(false)
        }
      }

      const runAction = (action, extra) => {
        const promise = props.onAction(item, action, extra)
        if (promise && typeof promise.catch === 'function') promise.catch(() => {})
      }

      const undoOrganize = async () => {
        if (undoing) return
        setUndoing(true)
        try {
          await props.onUndo(item)
          if (typeof props.onClose === 'function') props.onClose()
        } catch (failure) {
          setError(String((failure && failure.message) || failure))
        } finally {
          setUndoing(false)
        }
      }

      const remove = async () => {
        if (deleting) return
        setDeleting(true)
        try {
          await props.onDelete(item)
          if (typeof props.onClose === 'function') props.onClose()
        } catch (failure) {
          setError(String((failure && failure.message) || failure))
        } finally {
          setDeleting(false)
        }
      }

      const openLink = () => {
        if (typeof props.onStart === 'function') {
          const promise = props.onStart(item)
          if (promise && typeof promise.catch === 'function') promise.catch(() => {})
        }
      }

      const openExternal = (url) => {
        const target = asText(url)
        if (!target) return
        if (typeof props.onStart === 'function') {
          const promise = props.onStart(item)
          if (promise && typeof promise.catch === 'function') promise.catch(() => {})
        }
        try {
          window.open(target, '_blank', 'noopener,noreferrer')
        } catch {
          // popup blocked
        }
      }

      return h(
        React.Fragment,
        null,
        h('div', { className: 'wl-backdrop', 'aria-hidden': true, onClick: close }),
        h(
          'aside',
          {
            className: 'wl-drawer',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': tr(t, 'drawerDetails'),
            tabIndex: -1,
            ref: panelRef,
            onClick: (event) => event.stopPropagation(),
          },
          h(
            'div',
            { className: 'wl-drawer-head' },
            h(KindChip, { t, kind: item.kind }),
            meta ? h('span', { className: 'wl-drawer-meta-line' }, meta) : null,
            h('span', { className: 'wl-spacer' }),
            h(
              'button',
              { type: 'button', className: 'wl-icon-btn', title: tr(t, 'close'), 'aria-label': tr(t, 'close'), onClick: close },
              h(Icon, { name: 'close', size: 16 }),
            ),
          ),
          h(
            'div',
            { className: 'wl-drawer-scroll' },
            h(Cover, { t, item, className: 'wl-drawer-cover', iconSize: 32 }),
            h('h2', { className: 'wl-drawer-title' }, title),
            h(
              'div',
              { className: 'wl-drawer-stats' },
              h(ScoreBadge, { t, score: item.score }),
              h('span', { className: 'wl-drawer-stat' }, tr(t, 'importance') + ' ' + clampInt(item.importance, 1, 5) + '/5'),
              h('span', { className: 'wl-drawer-stat' }, tr(t, 'urgency') + ' ' + clampInt(item.urgency, 1, 5) + '/5'),
              formatDuration(t, item.durationMin)
                ? h('span', { className: 'wl-drawer-stat' }, formatDuration(t, item.durationMin))
                : null,
              item.createdAt
                ? h('span', { className: 'wl-drawer-stat' }, timeAgo(t, item.createdAt, props.now))
                : null,
            ),
            aiState !== 'none' || aiCanUndo || aiSuggestKind || aiSuggestTopic
              ? h(
                  'section',
                  { className: 'wl-drawer-section wl-drawer-ai', 'data-ai-state': aiState },
                  h(
                    'h3',
                    { className: 'wl-drawer-label' },
                    h(Icon, { name: 'sparkle', size: 13 }),
                    tr(t, 'aiDrawerTitle'),
                    h('span', { className: 'wl-ai-badge is-' + aiState, 'data-ai-state': aiState }, aiStateLabel(t, aiState)),
                  ),
                  aiReason ? h('p', { className: 'wl-drawer-summary' }, aiReason) : null,
                  aiSuggestKind || aiSuggestTopic
                    ? h(
                        'p',
                        { className: 'wl-drawer-ai-suggest' },
                        [
                          aiSuggestKind ? tr(t, 'aiSuggestKind') + '：' + kindLabel(t, aiSuggestKind) : '',
                          aiSuggestTopic ? tr(t, 'aiSuggestTopic') + '：' + aiSuggestTopic : '',
                        ]
                          .filter(Boolean)
                          .join(' · '),
                      )
                    : null,
                  aiLastError
                    ? h('p', { className: 'wl-drawer-ai-error' }, tr(t, 'aiLastError') + '：' + aiLastError)
                    : null,
                  h(
                    'p',
                    { className: 'wl-drawer-ai-meta' },
                    [
                      aiAt ? tr(t, 'aiUpdatedAt') + ' ' + fmtDateTime(aiAt) : '',
                      aiFields.length ? tr(t, 'aiFields') + ' ' + aiFields.join(' / ') : '',
                    ]
                      .filter(Boolean)
                      .join(' · ') || tr(t, 'aiUntouched'),
                  ),
                  aiTitleRaw
                    ? h(
                        'p',
                        { className: 'wl-drawer-ai-raw', title: aiTitleRaw },
                        tr(t, 'aiTitleRaw') + '：' + aiTitleRaw,
                      )
                    : null,
                  aiCanUndo
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'wl-btn wl-btn-sm wl-btn-quiet',
                          title: tr(t, 'aiUndoTip'),
                          disabled: undoing,
                          onClick: undoOrganize,
                        },
                        h(Icon, { name: 'refresh', size: 13 }),
                        h('span', { className: 'wl-btn-label' }, tr(t, 'aiUndo')),
                      )
                    : null,
                )
              : null,
            asText(item.url)
              ? h(
                  'a',
                  {
                    className: 'wl-drawer-link',
                    href: item.url,
                    target: '_blank',
                    rel: 'noreferrer noopener',
                    title: asText(item.url),
                    onClick: openLink,
                  },
                  h(Icon, { name: 'link', size: 14 }),
                  h('span', { className: 'wl-drawer-link-text' }, domainOf(item.url) || asText(item.url)),
                  h(Icon, { name: 'external', size: 13 }),
                )
              : null,
            h(
              'section',
              { className: 'wl-drawer-section' },
              h('h3', { className: 'wl-drawer-label' }, tr(t, 'summaryLabel')),
              h('p', { className: 'wl-drawer-summary' + (summary ? '' : ' wl-muted') }, summary || tr(t, 'noSummary')),
            ),
            h(ContentPreview, {
              t,
              item,
              preview,
              onOpenExternal: openExternal,
              onOpenViewer: (images, index) => setViewer({ images, index }),
            }),
            item.cluster
              ? h(ClusterSection, {
                  t,
                  item,
                  notify: props.notify,
                  onOpenMember: props.onOpenMember,
                  onOpenExternal: openExternal,
                  onReload: props.onReload,
                })
              : null,
            h(
              'section',
              { className: 'wl-drawer-section' },
              h(
                'div',
                { className: 'wl-form-row' },
                h(LevelDotsInput, {
                  label: tr(t, 'importanceLabel'),
                  value: form.importance,
                  tone: 'brand',
                  disabled: saving,
                  onChange: (value) => patchForm({ importance: value }),
                }),
                h(LevelDotsInput, {
                  label: tr(t, 'urgencyLabel'),
                  value: form.urgency,
                  tone: 'warn',
                  disabled: saving,
                  onChange: (value) => patchForm({ urgency: value }),
                }),
              ),
              h(
                'div',
                { className: 'wl-field' },
                h('span', { className: 'wl-field-label' }, tr(t, 'deadlineLabel')),
                h(
                  'div',
                  { className: 'wl-inline' },
                  h('input', {
                    type: 'datetime-local',
                    className: 'wl-input',
                    value: form.deadline,
                    'aria-label': tr(t, 'deadlineLabel'),
                    disabled: saving,
                    onChange: (event) => patchForm({ deadline: event.target.value }),
                  }),
                  form.deadline
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'wl-btn wl-btn-sm',
                          title: tr(t, 'deadlineClear'),
                          disabled: saving,
                          onClick: () => patchForm({ deadline: '' }),
                        },
                        tr(t, 'deadlineClear'),
                      )
                    : null,
                ),
              ),
              h(
                'div',
                { className: 'wl-field' },
                h('span', { className: 'wl-field-label' }, tr(t, 'tagsLabel')),
                h('input', {
                  type: 'text',
                  className: 'wl-input',
                  value: form.tags,
                  placeholder: tr(t, 'tagsPlaceholder'),
                  'aria-label': tr(t, 'tagsLabel'),
                  title: tr(t, 'tagsLabel'),
                  disabled: saving,
                  onChange: (event) => patchForm({ tags: event.target.value }),
                }),
              ),
              h(
                'div',
                { className: 'wl-field' },
                h('span', { className: 'wl-field-label' }, tr(t, 'notesLabel')),
                h('textarea', {
                  className: 'wl-textarea',
                  rows: 3,
                  value: form.notes,
                  placeholder: tr(t, 'notesPlaceholder'),
                  'aria-label': tr(t, 'notesLabel'),
                  title: tr(t, 'notesLabel'),
                  disabled: saving,
                  onChange: (event) => patchForm({ notes: event.target.value }),
                }),
              ),
            ),
            error ? h('div', { className: 'wl-error-bar', role: 'alert' }, h(Icon, { name: 'warning', size: 14 }), h('span', { className: 'wl-error-text' }, error)) : null,
          ),
          h(
            'div',
            { className: 'wl-drawer-foot' },
            h(
              'button',
              { type: 'button', className: 'wl-btn wl-btn-primary wl-btn-block', title: tr(t, 'saveChanges'), disabled: saving, onClick: save },
              h(Icon, { name: 'check', size: 14 }),
              saving ? tr(t, 'saving') : tr(t, 'saveChanges'),
            ),
            h(
              'div',
              { className: 'wl-drawer-foot-row' },
              isDone || isArchived
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'wl-btn',
                      title: tr(t, 'restore'),
                      onClick: () => runAction('restore'),
                    },
                    tr(t, 'restore'),
                  )
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'wl-btn',
                      title: tr(t, 'markDone'),
                      onClick: () => runAction('done'),
                    },
                    h(Icon, { name: 'check', size: 14 }),
                    tr(t, 'markDone'),
                  ),
              isArchived
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'wl-btn',
                      title: tr(t, 'archive'),
                      onClick: () => runAction('archive'),
                    },
                    h(Icon, { name: 'archive', size: 14 }),
                    tr(t, 'archive'),
                  ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'wl-btn',
                  title: tr(t, 'snooze'),
                  onClick: () => runAction('snooze', { until: new Date(Date.now() + 86400e3).toISOString() }),
                },
                h(Icon, { name: 'clock', size: 14 }),
                tr(t, 'snooze'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'wl-btn',
                  title: isWant ? tr(t, 'wantUnmark') : tr(t, 'wantMark'),
                  onClick: () => {
                    if (typeof props.onSave !== 'function') return
                    props.onSave(isWant ? { kind: wantFallbackKind(item) } : { kind: 'game' })
                  },
                },
                h(Icon, { name: isWant ? 'check' : 'play', size: 14 }),
                isWant ? tr(t, 'wantUnmark') : tr(t, 'wantMark'),
              ),
              h('span', { className: 'wl-spacer' }),
              confirmDelete
                ? h(
                    'span',
                    { className: 'wl-confirm' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'wl-btn wl-btn-danger',
                        title: tr(t, 'confirmDelete'),
                        disabled: deleting,
                        onClick: remove,
                      },
                      tr(t, 'confirmDelete'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'wl-btn wl-btn-sm',
                        title: tr(t, 'cancel'),
                        disabled: deleting,
                        onClick: () => setConfirmDelete(false),
                      },
                      tr(t, 'cancel'),
                    ),
                  )
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'wl-btn wl-btn-danger-ghost',
                      title: tr(t, 'deleteItem'),
                      onClick: () => setConfirmDelete(true),
                    },
                    h(Icon, { name: 'trash', size: 14 }),
                    tr(t, 'deleteItem'),
                  ),
            ),
          ),
        ),
        viewer
          ? h(ImageViewer, {
              t,
              images: asArray(viewer.images),
              index: numOr(viewer.index, 0),
              title: asText(item.title) || tr(t, 'untitled'),
              onClose: () => setViewer(null),
            })
          : null,
      )
    }

    /* --------------------------------------------------------------- add dialog */

    function AddDialog(props) {
      const t = props.t
      const panelRef = React.useRef(null)
      const fileRef = React.useRef(null)
      const alive = React.useRef(true)
      const [mode, setMode] = React.useState('link')
      const [url, setUrl] = React.useState('')
      const [title, setTitle] = React.useState('')
      const [text, setText] = React.useState('')
      const [image, setImage] = React.useState(null)
      const [kind, setKind] = React.useState('')
      const [importance, setImportance] = React.useState(3)
      const [urgency, setUrgency] = React.useState(2)
      const [deadline, setDeadline] = React.useState('')
      const [tags, setTags] = React.useState('')
      const [preview, setPreview] = React.useState(null)
      const [resolving, setResolving] = React.useState(false)
      const [resolveFailed, setResolveFailed] = React.useState(false)
      const [pending, setPending] = React.useState(false)
      const [error, setError] = React.useState(null)

      React.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      React.useEffect(() => {
        const previous = typeof document !== 'undefined' ? document.activeElement : null
        const node = panelRef.current
        if (node && typeof node.focus === 'function') node.focus()
        return () => {
          if (previous && typeof previous.focus === 'function') {
            try {
              previous.focus()
            } catch {
              // the trigger may be gone
            }
          }
        }
      }, [])

      useEscape(() => {
        if (!pending) props.onClose()
      }, true)

      const close = (event) => {
        if (event) event.stopPropagation()
        if (pending) return
        if (typeof props.onClose === 'function') props.onClose()
      }

      const switchMode = (next) => {
        setMode(next)
        setError(null)
      }

      const resolveUrl = async () => {
        const target = url.trim()
        if (!/^https?:\/\//i.test(target)) return
        setResolving(true)
        setResolveFailed(false)
        try {
          const data = await postJson(API.resolve, { url: target })
          if (!alive.current) return
          const result = asObject(data.preview)
          setPreview(result)
          if (!title.trim() && asText(result.title)) setTitle(asText(result.title))
        } catch {
          if (alive.current) {
            setPreview(null)
            setResolveFailed(true)
          }
        } finally {
          if (alive.current) setResolving(false)
        }
      }

      const chooseFile = () => {
        if (fileRef.current && typeof fileRef.current.click === 'function') fileRef.current.click()
      }

      const onFile = (event) => {
        const file = event.target.files && event.target.files[0]
        if (!file) return
        setError(null)
        if (file.size > MAX_IMAGE_BYTES) {
          setError(tr(t, 'errImageTooLarge'))
          return
        }
        const reader = new FileReader()
        reader.onload = () => {
          if (!alive.current) return
          setImage({ dataUrl: String(reader.result || ''), name: asText(file.name) })
        }
        reader.onerror = () => {
          if (alive.current) setError(tr(t, 'errFileRead'))
        }
        reader.readAsDataURL(file)
      }

      const submit = async () => {
        if (pending) return
        setError(null)
        const trimmedUrl = url.trim()
        const trimmedText = text.trim()
        if (mode === 'link' && !/^https?:\/\//i.test(trimmedUrl)) {
          setError(tr(t, 'errUrlRequired'))
          return
        }
        if (mode === 'text' && !trimmedText) {
          setError(tr(t, 'errTextRequired'))
          return
        }
        if (mode === 'image' && (!image || !image.dataUrl)) {
          setError(tr(t, 'errImageRequired'))
          return
        }
        setPending(true)
        try {
          if (mode === 'text') {
            const data = await postJson(API.importText, { text: trimmedText })
            if (!alive.current) return
            const imported = asArray(data.items).length
            const skipped = numOr(data.skipped, 0)
            if (typeof props.notify === 'function') {
              props.notify(skipped > 0 ? ti(t, 'toastImportSkipped', { n: imported, skipped }) : ti(t, 'toastImported', { n: imported }))
            }
          } else {
            const body = {
              channel: 'manual',
              importance: clampInt(importance, 1, 5),
              urgency: clampInt(urgency, 1, 5),
            }
            if (kind) body.kind = kind
            const tagList = parseTags(tags)
            if (tagList.length) body.tags = tagList
            const deadlineIso = deadline ? fromLocalInput(deadline) : null
            if (deadline && !deadlineIso) throw new Error(tr(t, 'errDeadline'))
            if (deadlineIso) {
              body.deadline = deadlineIso
              body.deadlineKind = 'deadline'
            }
            if (mode === 'link') {
              body.url = trimmedUrl
              if (title.trim()) body.title = title.trim()
              const result = asObject(preview)
              if (!body.title && asText(result.title)) body.title = asText(result.title)
              if (asText(result.cover)) body.cover = asText(result.cover)
              if (asText(result.author)) body.author = asText(result.author)
              if (asText(result.site)) body.site = asText(result.site)
              if (asText(result.summary)) body.summary = asText(result.summary)
              if (asNumber(result.durationMin) !== null) body.durationMin = asNumber(result.durationMin)
              if (!body.kind && asText(result.kind)) body.kind = asText(result.kind)
            } else {
              body.dataUrl = image.dataUrl
              body.imageName = image.name || 'image'
              body.title = title.trim() || image.name.replace(/\.[a-z0-9]+$/i, '') || tr(t, 'kindImage')
            }
            const data = await postJson(API.add, body)
            if (!alive.current) return
            if (typeof props.notify === 'function') {
              props.notify(data.duplicate ? tr(t, 'toastDuplicate') : tr(t, 'toastAdded'))
            }
          }
          if (typeof props.onAdded === 'function') props.onAdded()
          if (typeof props.onClose === 'function') props.onClose()
        } catch (failure) {
          if (!alive.current) return
          setError(String((failure && failure.message) || failure))
        } finally {
          if (alive.current) setPending(false)
        }
      }

      const field = (label, control, hint) =>
        h(
          'div',
          { className: 'wl-field' },
          h('span', { className: 'wl-field-label' }, label),
          control,
          hint ? h('span', { className: 'wl-field-hint' }, hint) : null,
        )

      const titleInput = h('input', {
        type: 'text',
        className: 'wl-input',
        value: title,
        placeholder: tr(t, 'titlePlaceholder'),
        'aria-label': tr(t, 'titleLabel'),
        title: tr(t, 'titleLabel'),
        disabled: pending,
        onChange: (event) => setTitle(event.target.value),
      })

      const commonFields =
        mode === 'text'
          ? h('p', { className: 'wl-field-hint' }, tr(t, 'textModeHint'))
          : h(
              React.Fragment,
              null,
              field(
                tr(t, 'kind'),
                h(
                  'select',
                  {
                    className: 'wl-select',
                    value: kind,
                    'aria-label': tr(t, 'kind'),
                    title: tr(t, 'kind'),
                    disabled: pending,
                    onChange: (event) => setKind(event.target.value),
                  },
                  h('option', { value: '' }, tr(t, 'autoDetect')),
                  KINDS.map((value) => h('option', { key: value, value }, kindLabel(t, value))),
                ),
              ),
              h(
                'div',
                { className: 'wl-form-row' },
                h(LevelDotsInput, {
                  label: tr(t, 'importanceLabel'),
                  value: importance,
                  tone: 'brand',
                  disabled: pending,
                  onChange: setImportance,
                }),
                h(LevelDotsInput, {
                  label: tr(t, 'urgencyLabel'),
                  value: urgency,
                  tone: 'warn',
                  disabled: pending,
                  onChange: setUrgency,
                }),
              ),
              field(
                tr(t, 'deadlineLabel'),
                h(
                  'div',
                  { className: 'wl-inline' },
                  h('input', {
                    type: 'datetime-local',
                    className: 'wl-input',
                    value: deadline,
                    'aria-label': tr(t, 'deadlineLabel'),
                    disabled: pending,
                    onChange: (event) => setDeadline(event.target.value),
                  }),
                  deadline
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'wl-btn wl-btn-sm',
                          title: tr(t, 'deadlineClear'),
                          disabled: pending,
                          onClick: () => setDeadline(''),
                        },
                        tr(t, 'deadlineClear'),
                      )
                    : null,
                ),
              ),
              field(
                tr(t, 'tagsLabel'),
                h('input', {
                  type: 'text',
                  className: 'wl-input',
                  value: tags,
                  placeholder: tr(t, 'tagsPlaceholder'),
                  'aria-label': tr(t, 'tagsLabel'),
                  title: tr(t, 'tagsLabel'),
                  disabled: pending,
                  onChange: (event) => setTags(event.target.value),
                }),
              ),
            )

      return h(
        React.Fragment,
        null,
        h('div', { className: 'wl-backdrop', 'aria-hidden': true, onClick: close }),
        h(
          'div',
          {
            className: 'wl-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': tr(t, 'addTitle'),
            tabIndex: -1,
            ref: panelRef,
            onClick: (event) => event.stopPropagation(),
          },
          h(
            'div',
            { className: 'wl-dialog-head' },
            h('h2', { className: 'wl-dialog-title' }, tr(t, 'addTitle')),
            h(
              'button',
              { type: 'button', className: 'wl-icon-btn', title: tr(t, 'close'), 'aria-label': tr(t, 'close'), disabled: pending, onClick: close },
              h(Icon, { name: 'close', size: 16 }),
            ),
          ),
          h(
            'div',
            { className: 'wl-dialog-body' },
            h(
              'div',
              { className: 'wl-seg', role: 'tablist' },
              [
                ['link', 'modeLink'],
                ['text', 'modeText'],
                ['image', 'modeImage'],
              ].map((entry) =>
                h(
                  'button',
                  {
                    key: entry[0],
                    type: 'button',
                    role: 'tab',
                    'aria-selected': mode === entry[0] ? 'true' : 'false',
                    className: 'wl-seg-btn',
                    'data-active': mode === entry[0] ? 'true' : 'false',
                    title: tr(t, entry[1]),
                    disabled: pending,
                    onClick: () => switchMode(entry[0]),
                  },
                  tr(t, entry[1]),
                ),
              ),
            ),
            mode === 'link'
              ? field(
                  tr(t, 'urlLabel'),
                  h('input', {
                    type: 'url',
                    className: 'wl-input',
                    value: url,
                    placeholder: tr(t, 'urlPlaceholder'),
                    'aria-label': tr(t, 'urlLabel'),
                    title: tr(t, 'urlLabel'),
                    disabled: pending,
                    onChange: (event) => {
                      setUrl(event.target.value)
                      setPreview(null)
                      setResolveFailed(false)
                    },
                    onBlur: resolveUrl,
                  }),
                  resolving ? tr(t, 'resolveLoading') : resolveFailed ? tr(t, 'resolveFailed') : preview ? tr(t, 'resolveDone') : '',
                )
              : null,
            mode === 'link' ? field(tr(t, 'titleLabel'), titleInput) : null,
            mode === 'text'
              ? field(
                  tr(t, 'textLabel'),
                  h('textarea', {
                    className: 'wl-textarea',
                    rows: 6,
                    value: text,
                    placeholder: tr(t, 'textPlaceholder'),
                    'aria-label': tr(t, 'textLabel'),
                    title: tr(t, 'textLabel'),
                    disabled: pending,
                    onChange: (event) => setText(event.target.value),
                  }),
                )
              : null,
            mode === 'image'
              ? h(
                  React.Fragment,
                  null,
                  h('input', { ref: fileRef, type: 'file', accept: 'image/*', style: { display: 'none' }, onChange: onFile }),
                  h(
                    'div',
                    { className: 'wl-field' },
                    h('span', { className: 'wl-field-label' }, tr(t, 'imageLabel')),
                    h(
                      'div',
                      { className: 'wl-image-pick' },
                      image && image.dataUrl
                        ? h('img', { className: 'wl-dialog-thumb', src: image.dataUrl, alt: '' })
                        : h('div', { className: 'wl-dialog-thumb wl-dialog-thumb-empty' }, h(Icon, { name: 'image', size: 22 })),
                      h(
                        'div',
                        { className: 'wl-image-pick-side' },
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'wl-btn',
                            title: tr(t, 'chooseImage'),
                            disabled: pending,
                            onClick: chooseFile,
                          },
                          h(Icon, { name: 'image', size: 14 }),
                          tr(t, 'chooseImage'),
                        ),
                        h('span', { className: 'wl-field-hint' }, image && image.name ? image.name : tr(t, 'noImage')),
                      ),
                    ),
                  ),
                  field(tr(t, 'titleLabel'), titleInput),
                )
              : null,
            commonFields,
            error
              ? h(
                  'div',
                  { className: 'wl-error-bar', role: 'alert' },
                  h(Icon, { name: 'warning', size: 14 }),
                  h('span', { className: 'wl-error-text' }, error),
                )
              : null,
          ),
          h(
            'div',
            { className: 'wl-dialog-foot' },
            h(
              'button',
              { type: 'button', className: 'wl-btn', title: tr(t, 'cancel'), disabled: pending, onClick: close },
              tr(t, 'cancel'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'wl-btn wl-btn-primary',
                title: mode === 'text' ? tr(t, 'submitImport') : tr(t, 'submitAdd'),
                disabled: pending || resolving,
                onClick: submit,
              },
              pending ? tr(t, 'submitting') : mode === 'text' ? tr(t, 'submitImport') : tr(t, 'submitAdd'),
            ),
          ),
        ),
      )
    }

    /* ---------------------------------------------------------------- views */

    function TodayView(props) {
      const t = props.t
      const snapshot = asObject(props.snapshot)
      const now = props.now
      const pending = props.pendingOf || (() => false)
      const activeItems = asArray(snapshot.items).filter((item) => item && isActiveStatus(asText(item.status)))
      const focusRaw = asArray(snapshot.todayFocus).filter(Boolean).slice(0, 4)
      const groups = [
        { key: 'now', title: tr(t, 'groupNow'), items: activeItems.filter((item) => triageOf(item, now) === 'now') },
        { key: 'today', title: tr(t, 'groupToday'), items: activeItems.filter((item) => triageOf(item, now) === 'today') },
        { key: 'week', title: tr(t, 'groupWeek'), items: activeItems.filter((item) => triageOf(item, now) === 'week') },
      ]
      const fallbackFocus = groups.reduce((result, group) => result.concat(group.items), []).slice(0, 4)
      const focus = focusRaw.length ? focusRaw : fallbackFocus
      const hasContent = focus.length > 0 || groups.some((group) => group.items.length > 0)
      if (!hasContent) {
        return h(
          React.Fragment,
          null,
          h(ExpiringBanner, {
            t,
            items: snapshot.expiring,
            now,
            onOpen: props.onOpen,
            onViewAll: () => props.onNavigate('timeline'),
          }),
          h(EmptyState, {
            t,
            icon: 'clock',
            title: tr(t, 'todayEmptyTitle'),
            desc: tr(t, 'todayEmptyDesc'),
            actionLabel: activeItems.length > 0 ? tr(t, 'goLibrary') : null,
            onAction: activeItems.length > 0 ? () => props.onNavigate('library') : null,
          }),
        )
      }
      return h(
        React.Fragment,
        null,
        h(ExpiringBanner, {
          t,
          items: snapshot.expiring,
          now,
          onOpen: props.onOpen,
          onViewAll: () => props.onNavigate('timeline'),
        }),
        focus.length
          ? h(
              'section',
              { className: 'wl-section' },
              h(SectionHead, { t, title: tr(t, 'todayFocus'), count: focus.length }),
              h(
                'div',
                { className: 'wl-hero-grid' },
                focus.map((item, index) =>
                  h(ItemCard, {
                    key: asText(item.id) || 'focus-' + index,
                    t,
                    item,
                    now,
                    hero: true,
                    pending: pending(item),
                    onOpen: props.onOpen,
                    onAction: props.onAction,
                  }),
                ),
              ),
            )
          : null,
        groups.map((group) =>
          group.items.length
            ? h(
                'section',
                { className: 'wl-section', key: group.key },
                h(SectionHead, { t, title: group.title, count: group.items.length }),
                h(
                  'div',
                  { className: 'wl-grid' },
                  group.items.map((item, index) =>
                    h(ItemCard, {
                      key: asText(item.id) || group.key + '-' + index,
                      t,
                      item,
                      now,
                      pending: pending(item),
                      onOpen: props.onOpen,
                      onAction: props.onAction,
                    }),
                  ),
                ),
              )
            : null,
        ),
      )
    }

    function InboxRow(props) {
      const t = props.t
      const item = asObject(props.item)
      const now = props.now
      const pending = Boolean(props.pending)
      const title = asText(item.title) || tr(t, 'untitled')
      const meta = [asText(item.site), asText(item.author), timeAgo(t, item.createdAt, now), formatDuration(t, item.durationMin)]
        .filter(Boolean)
        .join(' · ')
      const update = (patch) => {
        if (pending) return
        if (typeof props.onUpdate === 'function') props.onUpdate(item, patch)
      }
      const stop = (callback) => (event) => {
        if (event) event.stopPropagation()
        callback()
      }
      return h(
        'div',
        {
          className: 'wl-inbox',
          role: 'button',
          tabIndex: 0,
          title: tr(t, 'details'),
          onClick: () => {
            if (typeof props.onOpen === 'function') props.onOpen(item.id)
          },
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              if (typeof props.onOpen === 'function') props.onOpen(item.id)
            }
          },
        },
        h('div', { className: 'wl-inbox-thumb' }, h(Cover, { t, item, iconSize: 18 })),
        h(
          'div',
          { className: 'wl-inbox-main' },
          h(
            'div',
            { className: 'wl-inbox-head' },
            h('h3', { className: 'wl-inbox-title', title }, title),
            h(AiBadge, { t, item }),
            h(ScoreBadge, { t, score: item.score }),
          ),
          meta ? h('div', { className: 'wl-inbox-meta' }, meta) : null,
          h(
            'div',
            { className: 'wl-inbox-controls', onClick: (event) => event.stopPropagation() },
            h(
              'select',
              {
                className: 'wl-select wl-select-sm',
                value: asText(item.kind) || 'other',
                title: tr(t, 'kind'),
                'aria-label': tr(t, 'kind'),
                disabled: pending,
                onClick: (event) => event.stopPropagation(),
                onChange: (event) => update({ kind: event.target.value }),
              },
              KINDS.map((value) => h('option', { key: value, value }, kindLabel(t, value))),
            ),
            h(LevelDotsInput, {
              label: tr(t, 'importance'),
              value: item.importance,
              tone: 'brand',
              disabled: pending,
              onChange: (value) => update({ importance: value }),
            }),
            h(LevelDotsInput, {
              label: tr(t, 'urgency'),
              value: item.urgency,
              tone: 'warn',
              disabled: pending,
              onChange: (value) => update({ urgency: value }),
            }),
          ),
        ),
        h(
          'div',
          { className: 'wl-inbox-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'wl-card-act',
              title: tr(t, 'markDone'),
              'aria-label': tr(t, 'markDone'),
              disabled: pending,
              onClick: stop(() => props.onAction(item, 'done')),
            },
            h(Icon, { name: 'check', size: 14 }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'wl-card-act',
              title: tr(t, 'archive'),
              'aria-label': tr(t, 'archive'),
              disabled: pending,
              onClick: stop(() => props.onAction(item, 'archive')),
            },
            h(Icon, { name: 'archive', size: 14 }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'wl-card-act',
              title: tr(t, 'details'),
              'aria-label': tr(t, 'details'),
              onClick: stop(() => props.onOpen(item.id)),
            },
            h(Icon, { name: 'chevron', size: 14 }),
          ),
        ),
      )
    }

    const INBOX_CATEGORIES = [
      { id: 'all', key: 'statusAll', kinds: null },
      { id: 'image', key: 'inboxFilterImage', kinds: ['image'] },
      { id: 'article', key: 'inboxFilterArticle', kinds: ['xhs', 'wechat', 'link', 'article'] },
      { id: 'video', key: 'inboxFilterVideo', kinds: ['video', 'bilibili', 'douyin'] },
      { id: 'media', key: 'inboxFilterMedia', kinds: ['game', 'drama'] },
      { id: 'other', key: 'inboxFilterOther', kinds: ['other', 'product'] },
    ]

    function InboxView(props) {
      const t = props.t
      const snapshot = asObject(props.snapshot)
      const pending = props.pendingOf || (() => false)
      const [category, setCategory] = React.useState('all')
      const [organizeFilter, setOrganizeFilter] = React.useState('all')
      const items = asArray(snapshot.items)
        .filter((item) => item && asText(item.status) === 'inbox')
        .sort(byCreatedDesc)
      const pendingFiles = numOr(asObject(snapshot.inbox).pendingFiles, 0)
      const categories = INBOX_CATEGORIES.map((entry) => ({
        id: entry.id,
        label: tr(t, entry.key),
        count: entry.kinds ? items.filter((item) => entry.kinds.indexOf(asText(item.kind)) >= 0).length : items.length,
      }))
      const active = INBOX_CATEGORIES.find((entry) => entry.id === category) || INBOX_CATEGORIES[0]
      const needsCount = items.filter((item) => {
        const state = aiStateOf(item)
        return state === 'none' || state === 'failed'
      }).length
      const organizedCount = items.filter((item) => {
        const state = aiStateOf(item)
        return state === 'done' || state === 'partial'
      }).length
      const matchesOrganize = (item) => {
        const state = aiStateOf(item)
        if (organizeFilter === 'needs') return state === 'none' || state === 'failed'
        if (organizeFilter === 'organized') return state === 'done' || state === 'partial'
        return true
      }
      const visible = items.filter((item) => (active.kinds ? active.kinds.indexOf(asText(item.kind)) >= 0 : true) && matchesOrganize(item))
      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'wl-notice' },
          h(Icon, { name: 'note', size: 14 }),
          h(
            'div',
            { className: 'wl-notice-text' },
            tr(t, 'inboxNotice'),
            pendingFiles > 0 ? h('span', { className: 'wl-notice-extra' }, ti(t, 'inboxNoticeFiles', { n: pendingFiles })) : null,
          ),
        ),
        items.length
          ? h(
              'div',
              { className: 'wl-inbox-filters', role: 'group', 'aria-label': tr(t, 'tabInbox') },
              categories.map((entry) =>
                h(
                  'button',
                  {
                    key: entry.id,
                    type: 'button',
                    className: 'wl-chip',
                    'data-active': category === entry.id ? 'true' : 'false',
                    title: entry.label,
                    'aria-pressed': category === entry.id ? 'true' : 'false',
                    disabled: entry.id !== 'all' && entry.count === 0,
                    onClick: () => setCategory(entry.id),
                  },
                  entry.label,
                  h('span', { className: 'wl-chip-count' }, String(entry.count)),
                ),
              ),
              h('span', { className: 'wl-chip-sep', 'aria-hidden': 'true' }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'wl-chip wl-chip-ai',
                  'data-active': organizeFilter === 'needs' ? 'true' : 'false',
                  title: tr(t, 'filterNeedsOrganize'),
                  'aria-pressed': organizeFilter === 'needs' ? 'true' : 'false',
                  disabled: needsCount === 0 && organizeFilter !== 'needs',
                  onClick: () => setOrganizeFilter(organizeFilter === 'needs' ? 'all' : 'needs'),
                },
                tr(t, 'filterNeedsOrganize'),
                h('span', { className: 'wl-chip-count' }, String(needsCount)),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'wl-chip wl-chip-ai',
                  'data-active': organizeFilter === 'organized' ? 'true' : 'false',
                  title: tr(t, 'filterOrganized'),
                  'aria-pressed': organizeFilter === 'organized' ? 'true' : 'false',
                  disabled: organizedCount === 0 && organizeFilter !== 'organized',
                  onClick: () => setOrganizeFilter(organizeFilter === 'organized' ? 'all' : 'organized'),
                },
                tr(t, 'filterOrganized'),
                h('span', { className: 'wl-chip-count' }, String(organizedCount)),
              ),
            )
          : null,
        items.length === 0
          ? h(EmptyState, { t, icon: 'note', title: tr(t, 'inboxEmpty'), desc: tr(t, 'inboxEmptyDesc') })
          : visible.length
            ? h(
                'div',
                { className: 'wl-inbox-list' },
                visible.map((item, index) =>
                  h(InboxRow, {
                    key: asText(item.id) || 'inbox-' + index,
                    t,
                    item,
                    now: props.now,
                    pending: pending(item),
                    onOpen: props.onOpen,
                    onUpdate: props.onUpdate,
                    onAction: props.onAction,
                  }),
                ),
              )
            : h('div', { className: 'wl-inbox-filter-empty' }, tr(t, 'inboxFilterEmpty')),
      )
    }

    function ArchivedSection(props) {
      const t = props.t
      const [open, setOpen] = React.useState(false)
      const [state, setState] = React.useState({ loading: false, error: null, items: null })
      const count = numOr(props.count, 0)

      React.useEffect(() => {
        if (!open) return undefined
        let alive = true
        setState({ loading: true, error: null, items: null })
        getJson(API.export)
          .then((data) => {
            if (!alive) return
            const items = Array.isArray(data && data.items) ? data.items : Array.isArray(data) ? data : []
            setState({
              loading: false,
              error: null,
              items: items.filter((item) => item && asText(item.status) === 'archived'),
            })
          })
          .catch((error) => {
            if (!alive) return
            setState({ loading: false, error: String((error && error.message) || error), items: null })
          })
        return () => {
          alive = false
        }
      }, [open])

      const restore = async (item) => {
        try {
          await props.onRestore(item)
          setState((previous) => ({
            loading: false,
            error: previous.error,
            items: asArray(previous.items).filter((entry) => entry !== item),
          }))
        } catch {
          // the parent already surfaced the failure as a toast
        }
      }

      const items = asArray(state.items)
      return h(
        'section',
        { className: 'wl-archive' },
        h(
          'button',
          {
            type: 'button',
            className: 'wl-archive-toggle',
            title: open ? tr(t, 'close') : tr(t, 'archivedToggle').replace('{n}', String(count)),
            'aria-expanded': open ? 'true' : 'false',
            onClick: () => setOpen(!open),
          },
          h(Icon, { name: open ? 'chevron' : 'archive', size: 14 }),
          h('span', null, ti(t, 'archivedToggle', { n: count })),
        ),
        open
          ? h(
              'div',
              { className: 'wl-archive-body' },
              h('p', { className: 'wl-field-hint' }, tr(t, 'archivedHint')),
              state.loading ? h('p', { className: 'wl-field-hint' }, tr(t, 'loading')) : null,
              state.error
                ? h(
                    'div',
                    { className: 'wl-error-bar', role: 'alert' },
                    h(Icon, { name: 'warning', size: 14 }),
                    h('span', { className: 'wl-error-text' }, tr(t, 'archivedLoadFailed') + '：' + state.error),
                  )
                : null,
              items.length
                ? h(
                    'div',
                    { className: 'wl-archive-list' },
                    items.map((item, index) =>
                      h(
                        'div',
                        { className: 'wl-archive-row', key: asText(item.id) || 'arch-' + index },
                        h(KindChip, { t, kind: item.kind }),
                        h('span', { className: 'wl-archive-title', title: asText(item.title) }, asText(item.title) || tr(t, 'untitled')),
                        h('span', { className: 'wl-archive-meta' }, timeAgo(t, item.createdAt, props.now)),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'wl-btn wl-btn-sm',
                            title: tr(t, 'restore'),
                            onClick: () => restore(item),
                          },
                          tr(t, 'restore'),
                        ),
                      ),
                    ),
                  )
                : state.loading || state.error
                  ? null
                  : h('p', { className: 'wl-field-hint' }, tr(t, 'archivedEmpty')),
            )
          : null,
      )
    }

    function LibraryView(props) {
      const t = props.t
      const snapshot = asObject(props.snapshot)
      const now = props.now
      const pending = props.pendingOf || (() => false)
      const [query, setQuery] = React.useState('')
      const [kind, setKind] = React.useState('all')
      const [status, setStatus] = React.useState('all')
      const [sort, setSort] = React.useState('priority')
      const [density, setDensity] = React.useState('grid')
      const all = asArray(snapshot.items).filter(Boolean)
      const counts = asObject(snapshot.counts)
      const byKind = asObject(counts.byKind)
      const filtered = all
        .filter((item) => {
          const itemKind = asText(item.kind)
          if (kind === 'fun') {
            if (!FUN_KINDS.includes(itemKind)) return false
          } else if (kind !== 'all' && itemKind !== kind) return false
          const itemStatus = asText(item.status)
          if (status === 'done') return itemStatus === 'done'
          if (itemStatus === 'done') return false
          if (status === 'unread') return !asText(item.readAt)
          if (status === 'read') return Boolean(asText(item.readAt))
          return true
        })
        .filter((item) => matchesQuery(item, query))
      const sorted = filtered.slice().sort(sort === 'newest' ? byCreatedDesc : sort === 'deadline' ? sortByDeadline : byPriority(now))
      const statusOptions = [
        ['all', 'statusAll'],
        ['unread', 'statusUnread'],
        ['read', 'statusRead'],
        ['done', 'statusDone'],
      ]
      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'wl-toolbar' },
          h(
            'div',
            { className: 'wl-search' },
            h(Icon, { name: 'search', size: 14 }),
            h('input', {
              type: 'search',
              className: 'wl-search-input',
              value: query,
              placeholder: tr(t, 'librarySearch'),
              'aria-label': tr(t, 'librarySearch'),
              title: tr(t, 'librarySearch'),
              onChange: (event) => setQuery(event.target.value),
            }),
            query
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'wl-icon-btn wl-icon-btn-sm',
                    title: tr(t, 'searchClear'),
                    'aria-label': tr(t, 'searchClear'),
                    onClick: () => setQuery(''),
                  },
                  h(Icon, { name: 'close', size: 13 }),
                )
              : null,
          ),
          h(
            'div',
            { className: 'wl-toolbar-right' },
            h(
              'select',
              {
                className: 'wl-select wl-select-sm',
                value: sort,
                title: tr(t, 'sortLabel'),
                'aria-label': tr(t, 'sortLabel'),
                onChange: (event) => setSort(event.target.value),
              },
              h('option', { value: 'priority' }, tr(t, 'sortPriority')),
              h('option', { value: 'newest' }, tr(t, 'sortNewest')),
              h('option', { value: 'deadline' }, tr(t, 'sortDeadline')),
            ),
            h(
              'div',
              { className: 'wl-density', role: 'group', 'aria-label': tr(t, 'density') },
              h(
                'button',
                {
                  type: 'button',
                  className: 'wl-icon-btn wl-icon-btn-sm',
                  title: tr(t, 'densityGrid'),
                  'aria-label': tr(t, 'densityGrid'),
                  'aria-pressed': density === 'grid' ? 'true' : 'false',
                  'data-active': density === 'grid' ? 'true' : 'false',
                  onClick: () => setDensity('grid'),
                },
                h(Icon, { name: 'grid', size: 14 }),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'wl-icon-btn wl-icon-btn-sm',
                  title: tr(t, 'densityList'),
                  'aria-label': tr(t, 'densityList'),
                  'aria-pressed': density === 'list' ? 'true' : 'false',
                  'data-active': density === 'list' ? 'true' : 'false',
                  onClick: () => setDensity('list'),
                },
                h(Icon, { name: 'list', size: 14 }),
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'wl-filter-row' },
          h(
            'button',
            {
              type: 'button',
              className: 'wl-chip',
              'data-active': kind === 'all' ? 'true' : 'false',
              title: tr(t, 'statusAll'),
              onClick: () => setKind('all'),
            },
            tr(t, 'statusAll'),
            h('span', { className: 'wl-chip-count' }, String(all.length)),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'wl-chip',
              'data-active': kind === 'fun' ? 'true' : 'false',
              title: tr(t, 'kindFun'),
              onClick: () => setKind('fun'),
            },
            tr(t, 'kindFun'),
            h(
              'span',
              { className: 'wl-chip-count' },
              String(FUN_KINDS.reduce((sum, value) => sum + numOr(byKind[value], 0), 0)),
            ),
          ),
          KINDS.map((value) =>
            h(
              'button',
              {
                key: value,
                type: 'button',
                className: 'wl-chip',
                'data-active': kind === value ? 'true' : 'false',
                title: kindLabel(t, value),
                onClick: () => setKind(value),
              },
              kindLabel(t, value),
              h('span', { className: 'wl-chip-count' }, String(numOr(byKind[value], 0))),
            ),
          ),
        ),
        h(
          'div',
          { className: 'wl-filter-row' },
          statusOptions.map((entry) =>
            h(
              'button',
              {
                key: entry[0],
                type: 'button',
                className: 'wl-chip wl-chip-quiet',
                'data-active': status === entry[0] ? 'true' : 'false',
                title: tr(t, entry[1]),
                onClick: () => setStatus(entry[0]),
              },
              tr(t, entry[1]),
            ),
          ),
          h('span', { className: 'wl-spacer' }),
          h('span', { className: 'wl-section-count' }, ti(t, 'itemsCount', { n: sorted.length })),
        ),
        sorted.length
          ? h(
              'div',
              { className: 'wl-grid' + (density === 'list' ? ' wl-grid-list' : '') },
              sorted.map((item, index) =>
                h(ItemCard, {
                  key: asText(item.id) || 'lib-' + index,
                  t,
                  item,
                  now,
                  dense: density === 'list',
                  pending: pending(item),
                  onOpen: props.onOpen,
                  onAction: props.onAction,
                }),
              ),
            )
          : h(EmptyState, { t, icon: 'search', title: tr(t, 'libraryEmpty'), desc: tr(t, 'libraryEmptyDesc') }),
        h(ArchivedSection, {
          t,
          count: numOr(counts.archived, 0),
          now,
          onRestore: props.onRestore,
        }),
      )
    }

    function TimelineRow(props) {
      const t = props.t
      const item = asObject(props.item)
      const now = props.now
      const pending = Boolean(props.pending)
      const countdown = countdownOf(t, item, now)
      const title = asText(item.title) || tr(t, 'untitled')
      const meta = [
        asText(item.site),
        asText(item.deadline) ? deadlineKindLabel(t, item.deadlineKind) + ' · ' + fmtShort(item.deadline) : '',
      ]
        .filter(Boolean)
        .join(' · ')
      const open = () => {
        if (typeof props.onOpen === 'function') props.onOpen(item.id)
      }
      return h(
        'div',
        {
          className: 'wl-tl-row',
          role: 'button',
          tabIndex: 0,
          title: tr(t, 'details'),
          onClick: open,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              open()
            }
          },
        },
        h('span', { className: 'wl-tl-dot', 'data-tone': countdown.known ? countdown.tone : 'normal' }),
        h(
          'div',
          { className: 'wl-tl-main' },
          h('div', { className: 'wl-tl-head' }, h(KindChip, { t, kind: item.kind }), h('h3', { className: 'wl-tl-title', title }, title)),
          meta ? h('div', { className: 'wl-tl-meta' }, meta) : null,
        ),
        h(
          'div',
          { className: 'wl-tl-side' },
          h('span', { className: 'wl-tl-time', 'data-tone': countdown.known ? countdown.tone : 'normal' }, countdown.known ? countdown.text : tr(t, 'noDeadline')),
          h(
            'button',
            {
              type: 'button',
              className: 'wl-card-act',
              title: tr(t, 'archive'),
              'aria-label': tr(t, 'archive'),
              disabled: pending,
              onClick: (event) => {
                event.stopPropagation()
                if (typeof props.onAction === 'function') props.onAction(item, 'archive')
              },
            },
            h(Icon, { name: 'archive', size: 14 }),
          ),
        ),
      )
    }

    function TimelineView(props) {
      const t = props.t
      const snapshot = asObject(props.snapshot)
      const now = props.now
      const pending = props.pendingOf || (() => false)
      const items = asArray(snapshot.items).filter((item) => item && asText(item.status) !== 'done' && asText(item.status) !== 'archived')
      const buckets = [
        { key: 'expired', title: tr(t, 'bucketExpired') },
        { key: 'within24', title: tr(t, 'bucketWithin24') },
        { key: 'within3d', title: tr(t, 'bucketWithin3d') },
        { key: 'withinWeek', title: tr(t, 'bucketWithinWeek') },
        { key: 'later', title: tr(t, 'bucketLater') },
        { key: 'none', title: tr(t, 'bucketNone') },
      ]
      const grouped = buckets.map((bucket) => Object.assign({ items: [] }, bucket))
      items.forEach((item) => {
        const hours = hoursLeftOf(item, now)
        let key = 'none'
        if (hours !== null) {
          if (levelOf(item, now) === 'expired' || hours < 0) key = 'expired'
          else if (hours <= 24) key = 'within24'
          else if (hours <= 72) key = 'within3d'
          else if (hours <= 168) key = 'withinWeek'
          else key = 'later'
        }
        const bucket = grouped.find((entry) => entry.key === key)
        if (bucket) bucket.items.push(item)
      })
      grouped.forEach((bucket) => {
        if (bucket.key === 'none') bucket.items.sort(byCreatedDesc)
        else bucket.items.sort(sortByDeadline)
      })
      return h(
        React.Fragment,
        null,
        h('p', { className: 'wl-intro' }, tr(t, 'timelineIntro')),
        items.length
          ? grouped.map((bucket) =>
              bucket.items.length
                ? h(
                    'section',
                    { className: 'wl-section', key: bucket.key },
                    h(SectionHead, { t, title: bucket.title, count: bucket.items.length }),
                    h(
                      'div',
                      { className: 'wl-timeline' },
                      bucket.items.map((item, index) =>
                        h(TimelineRow, {
                          key: asText(item.id) || bucket.key + '-' + index,
                          t,
                          item,
                          now,
                          pending: pending(item),
                          onOpen: props.onOpen,
                          onAction: props.onAction,
                        }),
                      ),
                    ),
                  )
                : null,
            )
          : h(EmptyState, { t, icon: 'clock', title: tr(t, 'timelineEmpty'), desc: tr(t, 'timelineEmptyDesc') }),
      )
    }

    /* ------------------------------------------------------------ auth center */

    function AuthCenterDialog(props) {
      const t = props.t
      const accounts = asObject(props.accounts)
      const alive = React.useRef(true)
      const [login, setLogin] = React.useState(null)
      const [pending, setPending] = React.useState('')
      const [confirmLogout, setConfirmLogout] = React.useState('')
      const [errors, setErrors] = React.useState({})

      React.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      useEscape(() => {
        if (login) return
        if (confirmLogout) {
          setConfirmLogout('')
          return
        }
        if (typeof props.onClose === 'function') props.onClose()
      }, true)

      const clearError = (provider) => {
        setErrors((previous) => {
          if (!previous[provider]) return previous
          const next = Object.assign({}, previous)
          delete next[provider]
          return next
        })
      }
      const setError = (provider, message) => {
        setErrors((previous) => Object.assign({}, previous, { [provider]: message }))
      }
      const closeDialog = (event) => {
        if (event) event.stopPropagation()
        if (login) return
        if (typeof props.onClose === 'function') props.onClose()
      }

      const startQrLogin = async () => {
        if (pending) return
        setPending('bilibili')
        clearError('bilibili')
        try {
          const data = await postJson(API.loginBiliStart, {})
          const qrKey = asText(data.qrKey)
          const qrImage = asText(data.qrImage)
          if (!qrKey || !qrImage) throw new Error(tr(t, 'loginQrFailed'))
          if (!alive.current) return
          setLogin({ provider: 'bilibili', qr: { qrKey, qrImage } })
        } catch (failure) {
          if (!alive.current) return
          setError('bilibili', String((failure && failure.message) || failure))
        } finally {
          if (alive.current) setPending('')
        }
      }

      const startChromeLogin = async (provider) => {
        if (pending) return
        setPending(provider)
        clearError(provider)
        try {
          const data = await postJson(API.loginChromeStart, { provider })
          if (!alive.current) return
          setLogin({ provider, port: data.port })
        } catch (failure) {
          if (!alive.current) return
          setError(provider, String((failure && failure.message) || failure))
        } finally {
          if (alive.current) setPending('')
        }
      }

      const logout = async (provider) => {
        if (pending) return
        setPending('logout:' + provider)
        clearError(provider)
        try {
          await postJson(API.loginLogout, { provider })
          if (!alive.current) return
          setConfirmLogout('')
          if (typeof props.notify === 'function') props.notify(tr(t, 'authLogoutDone'))
          if (typeof props.onReload === 'function') props.onReload()
        } catch (failure) {
          if (!alive.current) return
          setError(provider, String((failure && failure.message) || failure))
        } finally {
          if (alive.current) setPending('')
        }
      }

      const platforms = [
        { id: 'xiaohongshu', label: tr(t, 'platformXhs'), kind: 'chrome' },
        { id: 'bilibili', label: tr(t, 'platformBilibili'), kind: 'qr' },
        { id: 'douyin', label: tr(t, 'platformDouyin'), kind: 'chrome' },
      ]

      const renderRow = (platform) => {
        const meta = asObject(accounts[platform.id])
        const configured = meta.configured === true
        const account = asText(meta.account)
        const busy = pending === platform.id || pending === 'logout:' + platform.id
        const loginLabel = platform.kind === 'qr' ? tr(t, 'loginScan') : tr(t, 'loginOpenWindow')
        return h(
          'div',
          { className: 'wl-auth-row', key: platform.id, 'data-provider': platform.id },
          h(
            'div',
            { className: 'wl-auth-main' },
            h(
              'div',
              { className: 'wl-auth-line' },
              h('span', { className: 'wl-status-dot', 'data-state': configured ? 'ok' : 'off' }),
              h('strong', { className: 'wl-auth-label' }, platform.label),
              h(
                'span',
                { className: 'wl-auth-status', 'data-state': configured ? 'ok' : 'off' },
                configured ? tr(t, 'authLoggedIn') : tr(t, 'authNotLoggedIn'),
              ),
              configured && account
                ? h('span', { className: 'wl-auth-account', title: account }, account)
                : null,
            ),
            errors[platform.id]
              ? h(
                  'div',
                  { className: 'wl-auth-error', role: 'alert' },
                  h(Icon, { name: 'warning', size: 12 }),
                  h('span', { className: 'wl-error-text' }, errors[platform.id]),
                )
              : null,
          ),
          h(
            'div',
            { className: 'wl-auth-actions' },
            configured
              ? confirmLogout === platform.id
                ? h(
                    'span',
                    { className: 'wl-confirm' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'wl-btn wl-btn-sm wl-btn-danger',
                        title: tr(t, 'authConfirmLogout'),
                        disabled: busy,
                        onClick: () => {
                          const promise = logout(platform.id)
                          if (promise && typeof promise.catch === 'function') promise.catch(() => {})
                        },
                      },
                      tr(t, 'authConfirmLogout'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'wl-btn wl-btn-sm',
                        title: tr(t, 'cancel'),
                        onClick: () => setConfirmLogout(''),
                      },
                      tr(t, 'cancel'),
                    ),
                  )
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'wl-btn wl-btn-sm wl-btn-danger-ghost',
                      title: tr(t, 'authLogout'),
                      disabled: busy,
                      onClick: () => setConfirmLogout(platform.id),
                    },
                    tr(t, 'authLogout'),
                  )
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'wl-btn wl-btn-sm wl-btn-accent',
                    title: loginLabel,
                    disabled: busy,
                    onClick: () => {
                      const promise = platform.kind === 'qr' ? startQrLogin() : startChromeLogin(platform.id)
                      if (promise && typeof promise.catch === 'function') promise.catch(() => {})
                    },
                  },
                  busy ? tr(t, 'loginPending') : loginLabel,
                ),
          ),
        )
      }

      return h(
        React.Fragment,
        null,
        h('div', { className: 'wl-backdrop', 'aria-hidden': true, onClick: closeDialog }),
        h(
          'div',
          {
            className: 'wl-dialog wl-auth-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': tr(t, 'authTitle'),
            onClick: (event) => event.stopPropagation(),
          },
          h(
            'div',
            { className: 'wl-dialog-head' },
            h('h2', { className: 'wl-dialog-title' }, h(Icon, { name: 'shield', size: 16 }), tr(t, 'authTitle')),
            h(
              'button',
              {
                type: 'button',
                className: 'wl-icon-btn',
                title: tr(t, 'close'),
                'aria-label': tr(t, 'close'),
                onClick: closeDialog,
              },
              h(Icon, { name: 'close', size: 16 }),
            ),
          ),
          h('div', { className: 'wl-dialog-body wl-auth-body' }, platforms.map(renderRow)),
          h(
            'div',
            { className: 'wl-auth-note' },
            h(Icon, { name: 'shield', size: 12 }),
            h('span', null, tr(t, 'authCookieNote')),
          ),
        ),
        login
          ? h(LoginDialog, {
              t,
              provider: login.provider,
              qr: login.qr,
              notify: props.notify,
              onLoggedIn: props.onReload,
              onClose: () => setLogin(null),
            })
          : null,
      )
    }

    /* --------------------------------------------------------------- login */

    function LoginDialog(props) {
      const t = props.t
      const provider =
        props.provider === 'douyin' ? 'douyin' : props.provider === 'xiaohongshu' ? 'xiaohongshu' : 'bilibili'
      const isQr = provider === 'bilibili'
      const chromeProvider = isQr ? '' : provider
      const panelRef = React.useRef(null)
      const alive = React.useRef(true)
      const pollingRef = React.useRef(false)
      const finishedRef = React.useRef(false)
      const [phase, setPhase] = React.useState('waiting')
      const [qr, setQr] = React.useState(() => {
        const initial = asObject(props.qr)
        if (!isQr || !asText(initial.qrKey) || !asText(initial.qrImage)) return null
        return { qrKey: asText(initial.qrKey), qrImage: asText(initial.qrImage) }
      })
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [confirming, setConfirming] = React.useState(false)
      const [confirmError, setConfirmError] = React.useState(null)

      React.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      React.useEffect(() => {
        const previous = typeof document !== 'undefined' ? document.activeElement : null
        const node = panelRef.current
        if (node && typeof node.focus === 'function') node.focus()
        return () => {
          if (previous && typeof previous.focus === 'function') {
            try {
              previous.focus()
            } catch {
              // the trigger may be gone
            }
          }
        }
      }, [])

      const pollingEnabled = (phase === 'waiting' || phase === 'scanned') && (!isQr || Boolean(qr && qr.qrKey))

      React.useEffect(() => {
        if (!pollingEnabled) return undefined
        let cancelled = false
        const poll = async () => {
          if (pollingRef.current || cancelled || finishedRef.current) return
          pollingRef.current = true
          try {
            const data = isQr
              ? await postJsonSoft(API.loginBiliPoll, { qrKey: qr && qr.qrKey })
              : await postJsonSoft(API.loginChromePoll, { provider: chromeProvider })
            if (cancelled || !alive.current || finishedRef.current) return
            const state = asText(data.state) || 'waiting'
            if (state === 'waiting') {
              setError(null)
              setPhase('waiting')
              return
            }
            if (state === 'scanned') {
              setError(null)
              setPhase('scanned')
              return
            }
            if (state === 'confirmed') {
              finishedRef.current = true
              const account = asObject(data.account)
              const name = asText(account.name)
              let message = ''
              if (isQr) message = name ? ti(t, 'loginBiliSuccessName', { name }) : tr(t, 'loginBiliSuccess')
              else if (provider === 'xiaohongshu') message = name ? ti(t, 'loginXhsSuccessName', { name }) : tr(t, 'loginXhsSuccess')
              else message = name ? ti(t, 'loginDouyinSuccessName', { name }) : tr(t, 'loginDouyinSuccess')
              if (typeof props.notify === 'function') props.notify(message)
              if (typeof props.onLoggedIn === 'function') props.onLoggedIn()
              if (typeof props.onClose === 'function') props.onClose()
              return
            }
            if (state === 'expired') {
              setError(null)
              setPhase('expired')
              return
            }
            if (state === 'closed') {
              finishedRef.current = true
              if (typeof props.notify === 'function') props.notify(tr(t, 'loginClosed'), 'warn')
              if (typeof props.onClose === 'function') props.onClose()
              return
            }
            setPhase('error')
            setError(asText(data.error) || tr(t, 'loginError'))
          } catch (failure) {
            if (cancelled || !alive.current) return
            setError(String((failure && failure.message) || failure))
          } finally {
            pollingRef.current = false
          }
        }
        poll()
        const timer = window.setInterval(poll, 2000)
        return () => {
          cancelled = true
          window.clearInterval(timer)
        }
      }, [isQr, pollingEnabled, qr && qr.qrKey])

      const cancel = async () => {
        if (busy) return
        if (isQr) {
          if (typeof props.onClose === 'function') props.onClose()
          return
        }
        setBusy('cancel')
        setError(null)
        try {
          await postJson(API.loginChromeCancel, { provider: chromeProvider })
        } catch (failure) {
          if (typeof props.notify === 'function') props.notify(String((failure && failure.message) || failure), 'error')
        } finally {
          if (alive.current) setBusy('')
        }
        if (typeof props.onClose === 'function') props.onClose()
      }

      useEscape(() => {
        if (!busy) cancel()
      }, true)

      const refresh = async () => {
        if (busy) return
        setBusy('refresh')
        setError(null)
        try {
          const data = await postJson(API.loginBiliStart, {})
          const qrKey = asText(data.qrKey)
          const qrImage = asText(data.qrImage)
          if (!qrKey || !qrImage) throw new Error(tr(t, 'loginQrFailed'))
          if (!alive.current) return
          setQr({ qrKey, qrImage })
          setPhase('waiting')
        } catch (failure) {
          if (!alive.current) return
          setError(String((failure && failure.message) || failure))
        } finally {
          if (alive.current) setBusy('')
        }
      }

      const retry = () => {
        setError(null)
        setPhase('waiting')
      }

      const confirmLogin = async () => {
        if (confirming || busy) return
        setConfirming(true)
        setConfirmError(null)
        try {
          const data = await postJsonSoft(API.loginChromeConfirm, { provider: chromeProvider })
          if (!alive.current || finishedRef.current) return
          if (!data || data.ok === false) {
            setConfirmError(asText(data && data.error) || tr(t, 'authConfirmFailed'))
            return
          }
          finishedRef.current = true
          if (typeof props.notify === 'function') {
            props.notify(provider === 'xiaohongshu' ? tr(t, 'loginXhsSuccess') : tr(t, 'loginDouyinSuccess'))
          }
          if (typeof props.onLoggedIn === 'function') props.onLoggedIn()
          if (typeof props.onClose === 'function') props.onClose()
        } catch (failure) {
          if (!alive.current) return
          setConfirmError(String((failure && failure.message) || failure))
        } finally {
          if (alive.current) setConfirming(false)
        }
      }

      const statusText =
        phase === 'scanned'
          ? tr(t, 'loginScanned')
          : phase === 'expired'
            ? tr(t, 'loginExpired')
            : phase === 'error'
              ? tr(t, 'loginError')
              : isQr
                ? tr(t, 'loginWaiting')
                : tr(t, 'loginChromeWaiting')
      const statusTone = phase === 'scanned' ? 'ok' : phase === 'expired' ? 'warn' : phase === 'error' ? 'danger' : 'waiting'

      return h(
        React.Fragment,
        null,
        h('div', {
          className: 'wl-backdrop',
          'aria-hidden': true,
          onClick: () => {
            if (!busy) cancel()
          },
        }),
        h(
          'div',
          {
            className: 'wl-dialog wl-login-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': isQr ? tr(t, 'loginQrTitle') : provider === 'xiaohongshu' ? tr(t, 'loginXhsTitle') : tr(t, 'loginChromeTitle'),
            tabIndex: -1,
            ref: panelRef,
            onClick: (event) => event.stopPropagation(),
          },
          h(
            'div',
            { className: 'wl-dialog-head' },
            h('h2', { className: 'wl-dialog-title' }, isQr ? tr(t, 'loginQrTitle') : provider === 'xiaohongshu' ? tr(t, 'loginXhsTitle') : tr(t, 'loginChromeTitle')),
            h(
              'button',
              {
                type: 'button',
                className: 'wl-icon-btn',
                title: tr(t, 'loginClose'),
                'aria-label': tr(t, 'loginClose'),
                disabled: Boolean(busy),
                onClick: cancel,
              },
              h(Icon, { name: 'close', size: 16 }),
            ),
          ),
          h(
            'div',
            { className: 'wl-dialog-body wl-login-body' },
            isQr
              ? h(
                  'div',
                  { className: 'wl-login-qr' },
                  qr && qr.qrImage
                    ? h('img', {
                        className: 'wl-login-qr-img',
                        src: qr.qrImage,
                        alt: tr(t, 'loginQrAlt'),
                        width: 200,
                        height: 200,
                      })
                    : h('span', { className: 'wl-login-qr-empty' }, tr(t, 'loginStarting')),
                )
              : h('div', { className: 'wl-login-chrome-icon' }, h(Icon, { name: 'external', size: 22 })),
            h('p', { className: 'wl-login-hint' }, isQr ? tr(t, 'loginQrHint') : tr(t, 'loginChromeHint')),
            h(
              'div',
              { className: 'wl-login-status', 'data-tone': statusTone, role: 'status' },
              h('span', { className: 'wl-login-dot' }),
              h('span', null, statusText),
            ),
            phase === 'error' && error
              ? h(
                  'div',
                  { className: 'wl-error-bar wl-login-error', role: 'alert' },
                  h(Icon, { name: 'warning', size: 14 }),
                  h('span', { className: 'wl-error-text' }, error),
                )
              : null,
            error && phase !== 'error'
              ? h(
                  'div',
                  { className: 'wl-login-poll-error', role: 'status' },
                  h(Icon, { name: 'warning', size: 13 }),
                  h('span', { className: 'wl-error-text' }, error),
                )
              : null,
            confirmError
              ? h(
                  'div',
                  { className: 'wl-error-bar wl-login-error', role: 'alert' },
                  h(Icon, { name: 'warning', size: 14 }),
                  h('span', { className: 'wl-error-text' }, confirmError),
                )
              : null,
          ),
          h(
            'div',
            { className: 'wl-dialog-foot wl-login-foot' },
            isQr && (phase === 'expired' || phase === 'error')
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'wl-btn',
                    title: tr(t, 'loginRefresh'),
                    disabled: Boolean(busy),
                    onClick: refresh,
                  },
                  busy === 'refresh' ? tr(t, 'loginStarting') : tr(t, 'loginRefresh'),
                )
              : null,
            !isQr && phase === 'error'
              ? h(
                  'button',
                  { type: 'button', className: 'wl-btn', title: tr(t, 'loginRetry'), disabled: Boolean(busy), onClick: retry },
                  tr(t, 'loginRetry'),
                )
              : null,
            !isQr
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'wl-btn wl-btn-primary',
                    title: tr(t, 'authConfirmLogin'),
                    disabled: Boolean(busy) || confirming,
                    onClick: () => {
                      const promise = confirmLogin()
                      if (promise && typeof promise.catch === 'function') promise.catch(() => {})
                    },
                  },
                  confirming ? tr(t, 'authConfirming') : tr(t, 'authConfirmLogin'),
                )
              : null,
            h(
              'button',
              {
                type: 'button',
                className: isQr ? 'wl-btn wl-btn-primary' : 'wl-btn',
                title: tr(t, 'loginCancel'),
                disabled: Boolean(busy),
                onClick: cancel,
              },
              tr(t, 'loginCancel'),
            ),
          ),
        ),
      )
    }

    function ProviderCard(props) {
      const t = props.t
      const provider = props.provider
      const meta = asObject(props.meta)
      const configured = meta.configured === true
      const supported = meta.supported !== false
      const alive = React.useRef(true)
      const [editing, setEditing] = React.useState(false)
      const [cookie, setCookie] = React.useState('')
      const [pending, setPending] = React.useState('')
      const [error, setError] = React.useState(null)
      const [warning, setWarning] = React.useState(null)
      const [shareText, setShareText] = React.useState('')

      React.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      React.useEffect(() => {
        setEditing(false)
        setCookie('')
      }, [configured])

      const stateKey = asText(meta.lastError) ? 'error' : meta.connected === true ? 'ok' : configured ? 'idle' : 'off'
      const stateText =
        stateKey === 'error'
          ? tr(t, 'disconnected')
          : stateKey === 'ok'
            ? tr(t, 'connected')
            : stateKey === 'idle'
              ? tr(t, 'configured')
              : tr(t, 'notConfigured')

      const saveCookie = async () => {
        const value = cookie.trim()
        if (!value) {
          setError(tr(t, 'cookieRequired'))
          return
        }
        setPending('cookie')
        setError(null)
        setWarning(null)
        try {
          await postJson(API.settings, { cookie: { provider, cookie: value } })
          if (!alive.current) return
          setCookie('')
          setEditing(false)
          props.notify(tr(t, 'cookieSaved'))
          props.onChanged()
        } catch (failure) {
          if (!alive.current) return
          setError(String((failure && failure.message) || failure))
        } finally {
          if (alive.current) setPending('')
        }
      }

      const removeCookie = async () => {
        if (pending) return
        setPending('remove')
        setError(null)
        setWarning(null)
        try {
          await postJson(API.settings, { cookie: { provider, cookie: '' } })
          if (!alive.current) return
          props.notify(tr(t, 'cookieRemoved'))
          props.onChanged()
        } catch (failure) {
          if (!alive.current) return
          setError(String((failure && failure.message) || failure))
        } finally {
          if (alive.current) setPending('')
        }
      }

      const syncNow = async () => {
        if (pending) return
        setPending('sync')
        setError(null)
        setWarning(null)
        try {
          const data = await postJson(API.sync, { provider, force: true })
          if (!alive.current) return
          if (asText(data.error)) {
            setError(asText(data.error))
            props.notify(asText(data.error), 'error')
          } else {
            props.notify(
              ti(t, 'syncDone', {
                imported: numOr(data.imported, 0),
                updated: numOr(data.updated, 0),
                skipped: numOr(data.skipped, 0),
              }),
            )
          }
          props.onChanged()
        } catch (failure) {
          if (!alive.current) return
          const message = String((failure && failure.message) || failure)
          setError(message)
          props.notify(message, 'error')
        } finally {
          if (alive.current) setPending('')
        }
      }

      const parseShare = async () => {
        const value = shareText.trim()
        if (!value || pending) return
        setPending('parse')
        setError(null)
        setWarning(null)
        try {
          const data = await postJson(API.douyinParse, { text: value })
          if (!alive.current) return
          const item = asObject(data.item)
          setWarning(asText(data.warning) || null)
          props.notify(ti(t, 'douyinSaved', { title: asText(item.title) || tr(t, 'untitled') }))
          setShareText('')
          props.onChanged()
        } catch (failure) {
          if (!alive.current) return
          const message = String((failure && failure.message) || failure)
          setError(message)
          setWarning(null)
          props.notify(message, 'error')
        } finally {
          if (alive.current) setPending('')
        }
      }

      const startLogin = async () => {
        if (pending) return
        setPending('login')
        setError(null)
        setWarning(null)
        try {
          if (provider === 'bilibili') {
            const data = await postJson(API.loginBiliStart, {})
            const qrKey = asText(data.qrKey)
            const qrImage = asText(data.qrImage)
            if (!qrKey || !qrImage) throw new Error(tr(t, 'loginQrFailed'))
            if (!alive.current) return
            if (typeof props.onLogin === 'function') props.onLogin({ provider, qr: { qrKey, qrImage } })
          } else {
            const data = await postJson(API.loginChromeStart, { provider: 'douyin' })
            if (!alive.current) return
            if (typeof props.onLogin === 'function') props.onLogin({ provider, port: data.port })
          }
        } catch (failure) {
          if (!alive.current) return
          setError(String((failure && failure.message) || failure))
        } finally {
          if (alive.current) setPending('')
        }
      }

      const lastResult = asObject(meta.lastResult)
      const resultText =
        meta.lastResult && typeof meta.lastResult === 'object'
          ? ti(t, 'syncResult', {
              imported: numOr(lastResult.imported, 0),
              updated: numOr(lastResult.updated, 0),
              skipped: numOr(lastResult.skipped, 0),
            })
          : ''
      const cookieHint = provider === 'bilibili' ? tr(t, 'cookieBiliHint') : tr(t, 'cookieDyHint')
      const loginLabel = provider === 'bilibili' ? tr(t, 'loginScan') : tr(t, 'loginOpenWindow')

      return h(
        'article',
        { className: 'wl-source', 'data-provider': provider },
        h(
          'div',
          { className: 'wl-source-head' },
          h('h2', { className: 'wl-source-title' }, provider === 'bilibili' ? tr(t, 'platformBilibili') : tr(t, 'platformDouyin')),
          h('span', { className: 'wl-status-dot', 'data-state': stateKey }),
          h('span', { className: 'wl-source-state', 'data-state': stateKey }, stateText),
          h('span', { className: 'wl-spacer' }),
          h(
            'button',
            {
              type: 'button',
              className: 'wl-btn wl-btn-sm wl-btn-accent',
              title: loginLabel,
              disabled: Boolean(pending) || Boolean(props.loginActive),
              onClick: startLogin,
            },
            h(Icon, { name: provider === 'bilibili' ? 'qr' : 'external', size: 13 }),
            pending === 'login' ? tr(t, 'loginPending') : loginLabel,
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'wl-btn wl-btn-sm',
              title: supported ? tr(t, 'syncNow') : tr(t, 'syncUnsupported'),
              disabled: Boolean(pending) || !supported,
              onClick: syncNow,
            },
            pending === 'sync' ? tr(t, 'syncing') : tr(t, 'syncNow'),
          ),
        ),
        configured
          ? h(
              'div',
              { className: 'wl-source-rows' },
              h(
                'div',
                { className: 'wl-kv' },
                h('span', { className: 'wl-kv-k' }, tr(t, 'account')),
                h('span', { className: 'wl-kv-v' }, asText(meta.account) || '—'),
              ),
              h(
                'div',
                { className: 'wl-kv' },
                h('span', { className: 'wl-kv-k' }, tr(t, 'lastSync')),
                h(
                  'span',
                  { className: 'wl-kv-v' },
                  meta.lastSyncAt ? fmtDateTime(parseTime(meta.lastSyncAt)) : tr(t, 'neverSynced'),
                ),
              ),
              resultText
                ? h(
                    'div',
                    { className: 'wl-kv' },
                    h('span', { className: 'wl-kv-k' }, tr(t, 'lastResult')),
                    h('span', { className: 'wl-kv-v' }, resultText),
                  )
                : null,
            )
          : h('p', { className: 'wl-source-hint' }, tr(t, 'notConfigured')),
        provider === 'douyin'
          ? h('p', { className: 'wl-source-note' }, tr(t, 'douyinNote'))
          : asText(meta.note)
            ? h('p', { className: 'wl-source-note' }, asText(meta.note))
            : null,
        asText(meta.lastError)
          ? h(
              'div',
              { className: 'wl-error-bar', role: 'alert' },
              h(Icon, { name: 'warning', size: 14 }),
              h('span', { className: 'wl-error-text' }, asText(meta.lastError)),
            )
          : null,
        warning
          ? h(
              'div',
              { className: 'wl-warn-bar', role: 'status' },
              h(Icon, { name: 'warning', size: 14 }),
              h('span', { className: 'wl-warn-text' }, warning),
            )
          : null,
        error
          ? h(
              'div',
              { className: 'wl-error-bar', role: 'alert' },
              h(Icon, { name: 'warning', size: 14 }),
              h('span', { className: 'wl-error-text' }, error),
            )
          : null,
        editing
          ? h(
              'div',
              { className: 'wl-cookie-form' },
              h(
                'div',
                { className: 'wl-field' },
                h('span', { className: 'wl-field-label' }, tr(t, 'cookieLabel')),
                h('input', {
                  type: 'password',
                  className: 'wl-input',
                  value: cookie,
                  placeholder: provider === 'bilibili' ? 'SESSDATA=…; bili_jct=…' : 'sessionid=…',
                  'aria-label': tr(t, 'cookieLabel'),
                  title: tr(t, 'cookieLabel'),
                  autoComplete: 'off',
                  spellCheck: false,
                  disabled: Boolean(pending),
                  onChange: (event) => setCookie(event.target.value),
                }),
              ),
              h(
                'div',
                { className: 'wl-inline' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'wl-btn wl-btn-primary wl-btn-sm',
                    title: tr(t, 'saveCookie'),
                    disabled: Boolean(pending),
                    onClick: saveCookie,
                  },
                  tr(t, 'saveCookie'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'wl-btn wl-btn-sm',
                    title: tr(t, 'cancel'),
                    disabled: Boolean(pending),
                    onClick: () => {
                      setEditing(false)
                      setCookie('')
                      setError(null)
                    },
                  },
                  tr(t, 'cancel'),
                ),
              ),
              h('p', { className: 'wl-field-hint' }, cookieHint),
            )
          : h(
              'div',
              { className: 'wl-inline' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'wl-btn wl-btn-sm',
                  title: configured ? tr(t, 'updateCookie') : tr(t, 'loginManual'),
                  disabled: Boolean(pending),
                  onClick: () => setEditing(true),
                },
                configured ? tr(t, 'updateCookie') : tr(t, 'loginManual'),
              ),
              configured
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'wl-btn wl-btn-sm wl-btn-danger-ghost',
                      title: tr(t, 'removeCookie'),
                      disabled: Boolean(pending),
                      onClick: removeCookie,
                    },
                    tr(t, 'removeCookie'),
                  )
                : null,
            ),
        provider === 'douyin'
          ? h(
              'div',
              { className: 'wl-share' },
              h(
                'div',
                { className: 'wl-field' },
                h('span', { className: 'wl-field-label' }, tr(t, 'platformDouyin')),
                h('input', {
                  type: 'text',
                  className: 'wl-input',
                  value: shareText,
                  placeholder: tr(t, 'douyinParsePlaceholder'),
                  'aria-label': tr(t, 'douyinParsePlaceholder'),
                  title: tr(t, 'douyinParsePlaceholder'),
                  disabled: Boolean(pending),
                  onChange: (event) => setShareText(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      parseShare()
                    }
                  },
                }),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'wl-btn wl-btn-sm',
                  title: tr(t, 'parse'),
                  disabled: Boolean(pending) || !shareText.trim(),
                  onClick: parseShare,
                },
                pending === 'parse' ? tr(t, 'parsing') : tr(t, 'parse'),
              ),
            )
          : null,
      )
    }

    function SourcesView(props) {
      const t = props.t
      const snapshot = asObject(props.snapshot)
      const sync = asObject(snapshot.sync)
      const [login, setLogin] = React.useState(null)
      const openLogin = React.useCallback((payload) => {
        setLogin(payload && payload.provider ? payload : null)
      }, [])
      const closeLogin = React.useCallback(() => setLogin(null), [])
      const loggedIn = React.useCallback(() => {
        if (typeof props.onChanged === 'function') props.onChanged()
      }, [props.onChanged])
      return h(
        React.Fragment,
        null,
        h('p', { className: 'wl-intro' }, tr(t, 'sourcesIntro')),
        h(
          'div',
          { className: 'wl-sources' },
          h(ProviderCard, {
            t,
            provider: 'bilibili',
            meta: sync.bilibili,
            notify: props.notify,
            onChanged: props.onChanged,
            onLogin: openLogin,
            loginActive: Boolean(login),
          }),
          h(ProviderCard, {
            t,
            provider: 'douyin',
            meta: sync.douyin,
            notify: props.notify,
            onChanged: props.onChanged,
            onLogin: openLogin,
            loginActive: Boolean(login),
          }),
        ),
        login
          ? h(LoginDialog, {
              t,
              provider: login.provider,
              qr: login.qr,
              notify: props.notify,
              onLoggedIn: loggedIn,
              onClose: closeLogin,
            })
          : null,
      )
    }

    /* --------------------------------------------------------------- images */

    function ImageTile(props) {
      const t = props.t
      const item = asObject(props.item)
      const cover = asText(item.cover)
      const title = asText(item.title) || tr(t, 'untitled')
      const pushed = Boolean(asText(item.libraryPushedAt))
      const imageCount = itemGallery(item).length
      const [failed, setFailed] = React.useState(false)
      React.useEffect(() => {
        setFailed(false)
      }, [cover])
      const open = () => {
        if (typeof props.onOpen === 'function') props.onOpen(asText(item.id))
      }
      const toggle = (event) => {
        if (event) {
          event.stopPropagation()
          event.preventDefault()
        }
        if (typeof props.onToggle === 'function') props.onToggle(asText(item.id))
      }
      return h(
        'div',
        {
          className: 'wl-image-tile',
          'data-selected': props.selected ? 'true' : 'false',
          role: 'button',
          tabIndex: 0,
          title: tr(t, 'imagePreview'),
          onClick: open,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              open()
            }
          },
        },
        h(
          'div',
          { className: 'wl-image-tile-media' },
          cover && !failed
            ? h('img', {
                className: 'wl-image-tile-img',
                src: cover,
                alt: '',
                loading: 'lazy',
                draggable: false,
                onError: () => setFailed(true),
              })
            : h(
                'div',
                { className: 'wl-image-tile-placeholder' },
                h(Icon, { name: 'image', size: 20 }),
                h('span', { className: 'wl-image-tile-placeholder-label' }, failed ? tr(t, 'imageLoadFailed') : tr(t, 'imageNoOriginal')),
                h('span', { className: 'wl-image-tile-placeholder-hint' }, tr(t, 'imageNoOriginalHint')),
              ),
          h(
            'button',
            {
              type: 'button',
              className: 'wl-image-check',
              title: tr(t, 'imageSelect'),
              'aria-label': tr(t, 'imageSelect'),
              'aria-pressed': props.selected ? 'true' : 'false',
              onClick: toggle,
            },
            props.selected ? h(Icon, { name: 'check', size: 13 }) : null,
          ),
          imageCount > 1
            ? h(
                'span',
                { className: 'wl-image-tile-count', title: ti(t, 'imageCountBadge', { n: imageCount }) },
                ti(t, 'imageCountBadge', { n: imageCount }),
              )
            : null,
          pushed
            ? h('span', { className: 'wl-image-tile-badge', title: tr(t, 'imagePushedBadge') }, tr(t, 'imagePushedBadge'))
            : null,
        ),
        h('div', { className: 'wl-image-tile-title', title }, title),
      )
    }

    function ImagesView(props) {
      const t = props.t
      const snapshot = asObject(props.snapshot)
      const now = props.now
      const alive = React.useRef(true)
      const [filter, setFilter] = React.useState('all')
      const [selected, setSelected] = React.useState({})
      const [pending, setPending] = React.useState('')
      const [confirmDelete, setConfirmDelete] = React.useState(false)
      const [errors, setErrors] = React.useState([])
      const [viewing, setViewing] = React.useState(null)

      React.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const images = asArray(snapshot.items)
        .filter((item) => item && asText(item.kind) === 'image')
        .sort(byCreatedDesc)
      const itemById = {}
      images.forEach((item) => {
        itemById[asText(item.id)] = item
      })
      const pushedCount = images.filter((item) => Boolean(asText(item.libraryPushedAt))).length
      const filtered = images.filter((item) => {
        const status = asText(item.status)
        if (filter === 'pending') return status === 'inbox'
        if (filter === 'done') return status === 'done'
        return true
      })
      const selectedItems = images.filter((item) => selected[asText(item.id)])
      const selectedIds = selectedItems.map((item) => asText(item.id))
      const allFilteredSelected = filtered.length > 0 && filtered.every((item) => Boolean(selected[asText(item.id)]))
      const viewingItem = viewing
        ? images.find((item) => asText(item.id) === asText(viewing.id)) || null
        : null

      const toggleSelect = (id) => {
        if (!id) return
        setSelected((previous) => {
          const next = Object.assign({}, previous)
          if (next[id]) delete next[id]
          else next[id] = true
          return next
        })
      }

      const toggleSelectAll = () => {
        if (allFilteredSelected) {
          setSelected({})
          return
        }
        const next = {}
        filtered.forEach((item) => {
          const id = asText(item.id)
          if (id) next[id] = true
        })
        setSelected(next)
      }

      const itemTitle = (id) => {
        const entry = itemById[id]
        return entry ? asText(entry.title) || tr(t, 'untitled') : asText(id)
      }

      const pushToLibrary = async (items) => {
        const list = asArray(items).filter(Boolean)
        const ids = list.map((item) => asText(item.id)).filter(Boolean)
        if (!ids.length || pending) return null
        const force = list.every((item) => Boolean(asText(item.libraryPushedAt)))
        setPending('push')
        setErrors([])
        try {
          const data = await postJsonSoft(API.libraryPush, { ids, force })
          if (!alive.current) return null
          const results = asArray(data.results)
          const pushed = numOr(data.pushed, 0)
          const failed = numOr(data.failed, 0)
          const skipped = results.filter((entry) => entry && entry.skipped).length
          const failures = results
            .filter((entry) => entry && entry.ok === false)
            .map((entry) => ({
              id: asText(entry.id),
              title: itemTitle(asText(entry.id)),
              error: asText(entry.error) || tr(t, 'pushLibraryFailedCount'),
            }))
          if (failures.length) setErrors(failures)
          const parts = []
          if (pushed > 0) parts.push(force ? ti(t, 'pushLibraryRepushed', { n: pushed }) : ti(t, 'pushLibraryDone', { n: pushed }))
          if (skipped > 0) parts.push(ti(t, 'pushLibrarySkipped', { n: skipped }))
          if (failed > 0) parts.push(ti(t, 'pushLibraryFailedCount', { n: failed }))
          if (parts.length && typeof props.notify === 'function') {
            props.notify(parts.join('；'), failed > 0 ? 'error' : pushed > 0 ? 'ok' : 'warn')
          }
          if (pushed > 0) {
            setSelected({})
            if (typeof props.onReload === 'function') props.onReload()
          }
          return { pushed, failed, skipped }
        } catch (failure) {
          if (!alive.current) return null
          const message = String((failure && failure.message) || failure)
          setErrors([{ id: '', title: '', error: message }])
          if (typeof props.notify === 'function') props.notify(message, 'error')
          return null
        } finally {
          if (alive.current) setPending('')
        }
      }

      const runBatch = async (action) => {
        const list = selectedItems
        if (!list.length || pending) return
        setPending(action)
        setErrors([])
        try {
          const results = await Promise.all(
            list.map((item) =>
              postJson(API.action, { id: asText(item.id), action })
                .then(() => ({ ok: true, id: asText(item.id) }))
                .catch((failure) => ({ ok: false, id: asText(item.id), error: String((failure && failure.message) || failure) })),
            ),
          )
          if (!alive.current) return
          const failures = results.filter((entry) => !entry.ok)
          const count = results.length - failures.length
          if (failures.length) {
            setErrors(failures.map((entry) => ({ id: entry.id, title: itemTitle(entry.id), error: entry.error })))
          }
          if (count > 0) {
            if (typeof props.notify === 'function') {
              const key = action === 'archive' ? 'batchArchiveToast' : 'batchDoneToast'
              props.notify(ti(t, key, { n: count }), failures.length ? 'warn' : 'ok')
            }
          } else if (failures.length && typeof props.notify === 'function') {
            props.notify(ti(t, 'batchFailed', { n: failures.length }), 'error')
          }
          setSelected({})
          if (typeof props.onReload === 'function') props.onReload()
        } finally {
          if (alive.current) setPending('')
        }
      }

      const runDelete = async () => {
        const list = selectedItems
        if (!list.length || pending) return
        setPending('delete')
        setErrors([])
        try {
          const results = await Promise.all(
            list.map((item) =>
              postJson(API.remove, { id: asText(item.id) })
                .then(() => ({ ok: true, id: asText(item.id) }))
                .catch((failure) => ({ ok: false, id: asText(item.id), error: String((failure && failure.message) || failure) })),
            ),
          )
          if (!alive.current) return
          const failures = results.filter((entry) => !entry.ok)
          const count = results.length - failures.length
          if (count > 0 && typeof props.notify === 'function') {
            props.notify(ti(t, 'batchDeleteToast', { n: count }), failures.length ? 'warn' : 'ok')
          }
          if (failures.length) {
            setErrors(failures.map((entry) => ({ id: entry.id, title: itemTitle(entry.id), error: entry.error })))
            if (count === 0 && typeof props.notify === 'function') props.notify(ti(t, 'batchFailed', { n: failures.length }), 'error')
          }
          setConfirmDelete(false)
          setSelected({})
          if (typeof props.onReload === 'function') props.onReload()
        } finally {
          if (alive.current) setPending('')
        }
      }

      const runLightboxAction = async (action) => {
        if (!viewingItem || typeof props.onAction !== 'function') return
        try {
          await props.onAction(viewingItem, action)
          if (alive.current) setViewing(null)
        } catch {
          // the center already surfaced the failure
        }
      }

      const openDetail = () => {
        if (!viewingItem) return
        if (typeof props.onOpen === 'function') props.onOpen(asText(viewingItem.id))
        setViewing(null)
      }

      const pushLightbox = async () => {
        if (!viewingItem) return
        const result = await pushToLibrary([viewingItem])
        if (result && result.pushed > 0 && alive.current) setViewing(null)
      }

      const filterButton = (id, label) =>
        h(
          'button',
          {
            type: 'button',
            className: 'wl-chip',
            'data-active': filter === id ? 'true' : 'false',
            title: label,
            onClick: () => setFilter(id),
          },
          label,
        )

      if (!images.length) {
        return h(EmptyState, {
          t,
          icon: 'image',
          title: tr(t, 'imagesEmptyTitle'),
          desc: tr(t, 'imagesEmptyDesc'),
          actionLabel: tr(t, 'goAdd'),
          onAction: () => {
            if (typeof props.onAdd === 'function') props.onAdd()
          },
        })
      }

      const toolbar = h(
        'div',
        { className: 'wl-images-toolbar' },
        h(
          'div',
          { className: 'wl-images-stats' },
          h('span', { className: 'wl-images-stat' }, ti(t, 'imagesTotal', { n: images.length })),
          h('span', { className: 'wl-images-stat wl-muted' }, ti(t, 'imagesPushed', { n: pushedCount })),
          h('span', { className: 'wl-spacer' }),
          filterButton('all', tr(t, 'statusAll')),
          filterButton('pending', tr(t, 'imagesPending')),
          filterButton('done', tr(t, 'imagesDone')),
          h(
            'button',
            {
              type: 'button',
              className: 'wl-btn wl-btn-sm',
              title: allFilteredSelected ? tr(t, 'imagesUnselect') : tr(t, 'imagesSelectAll'),
              disabled: Boolean(pending),
              onClick: toggleSelectAll,
            },
            allFilteredSelected ? tr(t, 'imagesUnselect') : tr(t, 'imagesSelectAll'),
          ),
        ),
        selectedIds.length
          ? h(
              'div',
              { className: 'wl-images-batch' },
              h('span', { className: 'wl-images-selected' }, ti(t, 'imagesSelected', { n: selectedIds.length })),
              h(
                'button',
                {
                  type: 'button',
                  className: 'wl-btn wl-btn-sm wl-btn-accent',
                  title: tr(t, 'pushLibrary'),
                  disabled: Boolean(pending),
                  onClick: () => {
                    pushToLibrary(selectedItems)
                  },
                },
                h(Icon, { name: 'library', size: 13 }),
                pending === 'push' ? tr(t, 'pushLibraryBusy') : tr(t, 'pushLibrary'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'wl-btn wl-btn-sm',
                  title: tr(t, 'markDone'),
                  disabled: Boolean(pending),
                  onClick: () => runBatch('done'),
                },
                h(Icon, { name: 'check', size: 13 }),
                tr(t, 'markDone'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'wl-btn wl-btn-sm',
                  title: tr(t, 'archive'),
                  disabled: Boolean(pending),
                  onClick: () => runBatch('archive'),
                },
                h(Icon, { name: 'archive', size: 13 }),
                tr(t, 'archive'),
              ),
              confirmDelete
                ? h(
                    'span',
                    { className: 'wl-confirm' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'wl-btn wl-btn-sm wl-btn-danger',
                        title: ti(t, 'confirmDeleteSelected', { n: selectedIds.length }),
                        disabled: Boolean(pending),
                        onClick: runDelete,
                      },
                      ti(t, 'confirmDeleteSelected', { n: selectedIds.length }),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'wl-btn wl-btn-sm',
                        title: tr(t, 'cancel'),
                        disabled: Boolean(pending),
                        onClick: () => setConfirmDelete(false),
                      },
                      tr(t, 'cancel'),
                    ),
                  )
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'wl-btn wl-btn-sm wl-btn-danger-ghost',
                      title: tr(t, 'deleteItem'),
                      disabled: Boolean(pending),
                      onClick: () => setConfirmDelete(true),
                    },
                    h(Icon, { name: 'trash', size: 13 }),
                    tr(t, 'deleteItem'),
                  ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'wl-btn wl-btn-sm',
                  title: tr(t, 'imagesUnselect'),
                  disabled: Boolean(pending),
                  onClick: () => {
                    setSelected({})
                    setConfirmDelete(false)
                  },
                },
                tr(t, 'imagesUnselect'),
              ),
              pending ? h('span', { className: 'wl-images-stat' }, tr(t, 'batchBusy')) : null,
            )
          : null,
        errors.length
          ? h(
              'div',
              { className: 'wl-images-errors' },
              errors.map((entry, index) =>
                h(
                  'div',
                  { key: entry.id + '-' + index, className: 'wl-error-bar', role: 'alert' },
                  h(Icon, { name: 'warning', size: 13 }),
                  h(
                    'span',
                    { className: 'wl-error-text' },
                    (entry.title ? entry.title + '：' : '') + entry.error,
                  ),
                ),
              ),
            )
          : null,
      )

      const lightbox = viewingItem
        ? h(ImageViewer, {
            t,
            images: itemGallery(viewingItem),
            index: viewing && Number.isFinite(viewing.index) ? viewing.index : 0,
            title: asText(viewingItem.title) || tr(t, 'untitled'),
            meta: [
              asText(viewingItem.site),
              timeAgo(t, viewingItem.createdAt, now),
              asText(viewingItem.libraryPushedAt) ? tr(t, 'imagePushedBadge') : '',
            ]
              .filter(Boolean)
              .join(' · '),
            actions: h(
              'div',
              { className: 'wl-imglb-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'wl-btn wl-btn-sm',
                  title: tr(t, 'details'),
                  onClick: openDetail,
                },
                h(Icon, { name: 'note', size: 13 }),
                tr(t, 'details'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'wl-btn wl-btn-sm wl-btn-accent',
                  title: asText(viewingItem.libraryPushedAt) ? tr(t, 'pushLibraryAgain') : tr(t, 'pushLibrary'),
                  disabled: Boolean(pending),
                  onClick: pushLightbox,
                },
                h(Icon, { name: 'library', size: 13 }),
                pending === 'push'
                  ? tr(t, 'pushLibraryBusy')
                  : asText(viewingItem.libraryPushedAt)
                    ? tr(t, 'pushLibraryAgain')
                    : tr(t, 'pushLibrary'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'wl-btn wl-btn-sm',
                  title: tr(t, 'markDone'),
                  onClick: () => runLightboxAction('done'),
                },
                h(Icon, { name: 'check', size: 13 }),
                tr(t, 'markDone'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'wl-btn wl-btn-sm',
                  title: tr(t, 'archive'),
                  onClick: () => runLightboxAction('archive'),
                },
                h(Icon, { name: 'archive', size: 13 }),
                tr(t, 'archive'),
              ),
            ),
            onClose: () => setViewing(null),
          })
        : null

      return h(
        React.Fragment,
        null,
        toolbar,
        filtered.length
          ? h(
              'div',
              { className: 'wl-images-grid' },
              filtered.map((item) =>
                h(ImageTile, {
                  key: asText(item.id),
                  t,
                  item,
                  now,
                  selected: Boolean(selected[asText(item.id)]),
                  onToggle: toggleSelect,
                  onOpen: (id) => setViewing({ id, index: 0 }),
                }),
              ),
            )
          : h(EmptyState, { t, icon: 'image', title: tr(t, 'imagesFilteredEmpty') }),
        lightbox,
      )
    }

    /* ----------------------------------------------------------------- want */

    const WANT_SITE_KIND = {
      小红书: 'xhs',
      公众号: 'wechat',
      微信公众号: 'wechat',
      B站: 'bilibili',
      抖音: 'douyin',
      小黑盒: 'link',
    }

    /** 取消想玩时回退到来源类型：优先用条目上记录的原始 kind，否则按 site 推断，兜底 link。 */
    function wantFallbackKind(item) {
      const source = asObject(item)
      const recorded = asText(source.kindBefore) || asText(source.originalKind)
      if (recorded) return recorded
      return WANT_SITE_KIND[asText(source.site)] || 'link'
    }

    function isMediaActive(item) {
      if (!item) return false
      if (asObject(item.media).relevant !== true) return false
      const status = asText(item.status)
      return status === 'inbox' || status === 'queued' || status === 'doing'
    }

    function mediaGroupOf(item) {
      return asText(asObject(item && item.media).group) === 'list' ? 'list' : 'guide'
    }

    function workKindLabel(t, kind) {
      return tr(t, kind === 'drama' ? 'workKindDrama' : 'workKindGame')
    }

    function workShelfKindLabel(t, kind) {
      return tr(t, kind === 'drama' ? 'mediaWorkFilterDrama' : 'mediaWorkFilterGame')
    }

    function workStatusLabel(t, status) {
      if (status === 'playing') return tr(t, 'workStatusPlaying')
      if (status === 'done') return tr(t, 'workStatusDone')
      return tr(t, 'workStatusWant')
    }

    function workAsItem(work) {
      const source = asObject(work)
      return {
        kind: asText(source.kind) === 'drama' ? 'drama' : 'game',
        cover: asText(source.cover),
        title: asText(source.title),
        site: '',
      }
    }

    function WorkDialog(props) {
      const t = props.t
      const work = asObject(props.work)
      const panelRef = React.useRef(null)
      const alive = React.useRef(true)
      const [status, setStatus] = React.useState(asText(work.status) || 'want')
      const [pending, setPending] = React.useState('')
      const [error, setError] = React.useState(null)

      React.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      React.useEffect(() => {
        setStatus(asText(work.status) || 'want')
        setError(null)
      }, [asText(work.id)])

      useEscape(() => {
        if (typeof props.onClose === 'function') props.onClose()
      }, true)

      React.useEffect(() => {
        const node = panelRef.current
        if (node && typeof node.focus === 'function') node.focus()
      }, [])

      const close = (event) => {
        if (event) event.stopPropagation()
        if (typeof props.onClose === 'function') props.onClose()
      }

      const changeStatus = async (next) => {
        if (pending || next === status) return
        setPending(next)
        setError(null)
        try {
          const data = await postJson(API.worksUpdate, { id: asText(work.id), patch: { status: next } })
          if (!alive.current) return
          setStatus(asText(asObject(data.work).status) || next)
          if (typeof props.notify === 'function') props.notify(tr(t, 'workStatusSaved'))
          if (typeof props.onReload === 'function') props.onReload()
        } catch (failure) {
          if (!alive.current) return
          setError(String((failure && failure.message) || failure))
        } finally {
          if (alive.current) setPending('')
        }
      }

      const coverItem = workAsItem(work)
      const title = asText(work.title) || tr(t, 'untitled')
      const summary = asText(work.summary)
      const sourceUrl = asText(work.sourceUrl)
      const sourceTitle = asText(work.sourceTitle)
      const statuses = ['want', 'playing', 'done']

      return h(
        React.Fragment,
        null,
        h('div', { className: 'wl-backdrop', 'aria-hidden': true, onClick: close }),
        h(
          'div',
          {
            className: 'wl-dialog wl-work-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': tr(t, 'workDetailTitle'),
            tabIndex: -1,
            ref: panelRef,
            onClick: (event) => event.stopPropagation(),
          },
          h(
            'div',
            { className: 'wl-dialog-head' },
            h('h2', { className: 'wl-dialog-title' }, tr(t, 'workDetailTitle')),
            h(
              'button',
              { type: 'button', className: 'wl-icon-btn', title: tr(t, 'close'), 'aria-label': tr(t, 'close'), onClick: close },
              h(Icon, { name: 'close', size: 16 }),
            ),
          ),
          h(
            'div',
            { className: 'wl-dialog-body wl-work-body' },
            h('div', { className: 'wl-work-cover' }, h(Cover, { t, item: coverItem, iconSize: 42 })),
            h(
              'div',
              { className: 'wl-work-line' },
              h('span', { className: 'wl-work-kind' }, workKindLabel(t, work.kind)),
              h('h3', { className: 'wl-work-title' }, title),
            ),
            summary ? h('p', { className: 'wl-work-summary' }, summary) : null,
            sourceUrl
              ? h(
                  'div',
                  { className: 'wl-work-source' },
                  h('span', { className: 'wl-work-source-label' }, tr(t, 'workSourceLabel')),
                  sourceTitle
                    ? h('span', { className: 'wl-work-source-title', title: sourceTitle }, sourceTitle)
                    : null,
                  h(
                    'a',
                    {
                      className: 'wl-btn wl-btn-sm',
                      href: sourceUrl,
                      target: '_blank',
                      rel: 'noreferrer noopener',
                      title: sourceUrl,
                    },
                    h(Icon, { name: 'external', size: 13 }),
                    tr(t, 'openOriginal'),
                  ),
                )
              : null,
            h(
              'div',
              { className: 'wl-work-status-row' },
              statuses.map((entry) =>
                h(
                  'button',
                  {
                    key: entry,
                    type: 'button',
                    className: 'wl-chip',
                    'data-active': status === entry ? 'true' : 'false',
                    title: workStatusLabel(t, entry),
                    disabled: Boolean(pending),
                    onClick: () => changeStatus(entry),
                  },
                  pending === entry ? tr(t, 'saving') : workStatusLabel(t, entry),
                ),
              ),
            ),
            error
              ? h(
                  'div',
                  { className: 'wl-error-bar', role: 'alert' },
                  h(Icon, { name: 'warning', size: 14 }),
                  h('span', { className: 'wl-error-text' }, error),
                )
              : null,
          ),
        ),
      )
    }

    function AddWorkDialog(props) {
      const t = props.t
      const panelRef = React.useRef(null)
      const alive = React.useRef(true)
      const [title, setTitle] = React.useState('')
      const [kind, setKind] = React.useState('game')
      const [pending, setPending] = React.useState(false)
      const [error, setError] = React.useState(null)

      React.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      useEscape(() => {
        if (!pending && typeof props.onClose === 'function') props.onClose()
      }, true)

      React.useEffect(() => {
        const node = panelRef.current
        if (!node) return
        const input = node.querySelector('input')
        if (input && typeof input.focus === 'function') input.focus()
        else if (typeof node.focus === 'function') node.focus()
      }, [])

      const close = (event) => {
        if (event) event.stopPropagation()
        if (pending) return
        if (typeof props.onClose === 'function') props.onClose()
      }

      const submit = async () => {
        const value = title.trim()
        if (!value) {
          setError(tr(t, 'errWorkTitleRequired'))
          return
        }
        if (pending) return
        setPending(true)
        setError(null)
        try {
          const data = await postJson(API.worksAdd, { title: value, kind })
          if (!alive.current) return
          if (typeof props.notify === 'function') {
            const addedTitle = asText(asObject(asObject(data).work).title) || value
            props.notify(ti(t, 'mediaWorkAdded', { title: addedTitle }))
          }
          if (typeof props.onReload === 'function') props.onReload()
          if (typeof props.onClose === 'function') props.onClose()
        } catch (failure) {
          if (!alive.current) return
          setError(String((failure && failure.message) || failure))
        } finally {
          if (alive.current) setPending(false)
        }
      }

      return h(
        React.Fragment,
        null,
        h('div', { className: 'wl-backdrop', 'aria-hidden': true, onClick: close }),
        h(
          'div',
          {
            className: 'wl-dialog wl-addwork-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': tr(t, 'mediaAddWorkTitle'),
            tabIndex: -1,
            ref: panelRef,
            onClick: (event) => event.stopPropagation(),
          },
          h(
            'div',
            { className: 'wl-dialog-head' },
            h('h2', { className: 'wl-dialog-title' }, tr(t, 'mediaAddWorkTitle')),
            h(
              'button',
              { type: 'button', className: 'wl-icon-btn', title: tr(t, 'close'), 'aria-label': tr(t, 'close'), disabled: pending, onClick: close },
              h(Icon, { name: 'close', size: 16 }),
            ),
          ),
          h(
            'div',
            { className: 'wl-dialog-body wl-addwork-body' },
            h(
              'div',
              { className: 'wl-field' },
              h('span', { className: 'wl-field-label' }, tr(t, 'mediaWorkTitleLabel')),
              h('input', {
                type: 'text',
                className: 'wl-input',
                value: title,
                placeholder: tr(t, 'mediaWorkTitlePlaceholder'),
                'aria-label': tr(t, 'mediaWorkTitleLabel'),
                title: tr(t, 'mediaWorkTitleLabel'),
                disabled: pending,
                onChange: (event) => setTitle(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    submit()
                  }
                },
              }),
            ),
            h(
              'div',
              { className: 'wl-field' },
              h('span', { className: 'wl-field-label' }, tr(t, 'mediaWorkKindLabel')),
              h(
                'div',
                { className: 'wl-work-kind-row', role: 'group', 'aria-label': tr(t, 'mediaWorkKindLabel') },
                ['game', 'drama'].map((entry) =>
                  h(
                    'button',
                    {
                      key: entry,
                      type: 'button',
                      className: 'wl-chip',
                      'data-active': kind === entry ? 'true' : 'false',
                      title: workShelfKindLabel(t, entry),
                      disabled: pending,
                      onClick: () => setKind(entry),
                    },
                    workShelfKindLabel(t, entry),
                  ),
                ),
              ),
            ),
            error
              ? h(
                  'div',
                  { className: 'wl-error-bar', role: 'alert' },
                  h(Icon, { name: 'warning', size: 14 }),
                  h('span', { className: 'wl-error-text' }, error),
                )
              : null,
          ),
          h(
            'div',
            { className: 'wl-dialog-foot' },
            h(
              'button',
              { type: 'button', className: 'wl-btn', title: tr(t, 'cancel'), disabled: pending, onClick: close },
              tr(t, 'cancel'),
            ),
            h(
              'button',
              { type: 'button', className: 'wl-btn wl-btn-primary', title: tr(t, 'mediaAddWork'), disabled: pending, onClick: submit },
              pending ? tr(t, 'mediaWorkAdding') : tr(t, 'mediaAddWork'),
            ),
          ),
        ),
      )
    }

    function ExtractTextDialog(props) {
      const t = props.t
      const panelRef = React.useRef(null)
      const alive = React.useRef(true)
      const [title, setTitle] = React.useState('')
      const [text, setText] = React.useState('')
      const [sourceUrl, setSourceUrl] = React.useState('')
      const [pending, setPending] = React.useState(false)
      const [error, setError] = React.useState(null)

      React.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      useEscape(() => {
        if (!pending && typeof props.onClose === 'function') props.onClose()
      }, true)

      React.useEffect(() => {
        const node = panelRef.current
        if (!node) return
        const textarea = node.querySelector('textarea')
        if (textarea && typeof textarea.focus === 'function') textarea.focus()
        else if (typeof node.focus === 'function') node.focus()
      }, [])

      const close = (event) => {
        if (event) event.stopPropagation()
        if (pending) return
        if (typeof props.onClose === 'function') props.onClose()
      }

      const submit = async () => {
        const body = text.trim()
        if (body.length < 80) {
          setError(tr(t, 'mediaExtractMinHint'))
          return
        }
        if (pending) return
        setPending(true)
        setError(null)
        try {
          const data = await postJson(API.worksExtractText, {
            title: title.trim(),
            text: body,
            sourceUrl: sourceUrl.trim(),
          })
          if (!alive.current) return
          const added = numOr(data.added, asArray(data.works).length)
          const failed = asArray(data.failed).length
          if (typeof props.notify === 'function') {
            const message =
              ti(t, 'mediaExtractTextDone', { n: added }) +
              (failed > 0 ? '；' + ti(t, 'mediaExtractFailed', { n: failed }) : '')
            props.notify(message, failed > 0 ? 'warn' : 'ok')
          }
          if (typeof props.onReload === 'function') props.onReload()
          if (typeof props.onClose === 'function') props.onClose()
        } catch (failure) {
          if (!alive.current) return
          const message = String((failure && failure.message) || failure)
          setError(message)
          if (typeof props.notify === 'function') {
            props.notify(tr(t, 'mediaExtractError') + '：' + message, 'error')
          }
        } finally {
          if (alive.current) setPending(false)
        }
      }

      return h(
        React.Fragment,
        null,
        h('div', { className: 'wl-backdrop', 'aria-hidden': true, onClick: close }),
        h(
          'div',
          {
            className: 'wl-dialog wl-extracttext-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': tr(t, 'mediaExtractTextTitle'),
            tabIndex: -1,
            ref: panelRef,
            onClick: (event) => event.stopPropagation(),
          },
          h(
            'div',
            { className: 'wl-dialog-head' },
            h('h2', { className: 'wl-dialog-title' }, tr(t, 'mediaExtractTextTitle')),
            h(
              'button',
              { type: 'button', className: 'wl-icon-btn', title: tr(t, 'close'), 'aria-label': tr(t, 'close'), disabled: pending, onClick: close },
              h(Icon, { name: 'close', size: 16 }),
            ),
          ),
          h(
            'div',
            { className: 'wl-dialog-body wl-extracttext-body' },
            h(
              'div',
              { className: 'wl-field' },
              h('span', { className: 'wl-field-label' }, tr(t, 'mediaExtractTitleLabel')),
              h('input', {
                type: 'text',
                className: 'wl-input',
                value: title,
                placeholder: tr(t, 'mediaExtractTitlePlaceholder'),
                'aria-label': tr(t, 'mediaExtractTitleLabel'),
                title: tr(t, 'mediaExtractTitleLabel'),
                disabled: pending,
                onChange: (event) => setTitle(event.target.value),
              }),
            ),
            h(
              'div',
              { className: 'wl-field' },
              h('span', { className: 'wl-field-label' }, tr(t, 'mediaExtractBodyLabel')),
              h('textarea', {
                className: 'wl-textarea wl-extracttext-textarea',
                value: text,
                placeholder: tr(t, 'mediaExtractBodyPlaceholder'),
                'aria-label': tr(t, 'mediaExtractBodyLabel'),
                title: tr(t, 'mediaExtractBodyLabel'),
                rows: 8,
                disabled: pending,
                onChange: (event) => setText(event.target.value),
              }),
              h('span', { className: 'wl-field-hint' }, tr(t, 'mediaExtractMinHint')),
            ),
            h(
              'div',
              { className: 'wl-field' },
              h('span', { className: 'wl-field-label' }, tr(t, 'mediaExtractSourceLabel')),
              h('input', {
                type: 'text',
                className: 'wl-input',
                value: sourceUrl,
                placeholder: tr(t, 'mediaExtractSourcePlaceholder'),
                'aria-label': tr(t, 'mediaExtractSourceLabel'),
                title: tr(t, 'mediaExtractSourceLabel'),
                disabled: pending,
                onChange: (event) => setSourceUrl(event.target.value),
              }),
            ),
            error
              ? h(
                  'div',
                  { className: 'wl-error-bar', role: 'alert' },
                  h(Icon, { name: 'warning', size: 14 }),
                  h('span', { className: 'wl-error-text' }, error),
                )
              : null,
          ),
          h(
            'div',
            { className: 'wl-dialog-foot' },
            h(
              'button',
              { type: 'button', className: 'wl-btn', title: tr(t, 'cancel'), disabled: pending, onClick: close },
              tr(t, 'cancel'),
            ),
            h(
              'button',
              { type: 'button', className: 'wl-btn wl-btn-primary', title: tr(t, 'mediaExtractText'), disabled: pending, onClick: submit },
              pending ? tr(t, 'mediaExtracting') : tr(t, 'mediaExtractText'),
            ),
          ),
        ),
      )
    }

    function WantView(props) {
      const t = props.t
      const snapshot = asObject(props.snapshot)
      const now = props.now
      const alive = React.useRef(true)
      const [filter, setFilter] = React.useState('all')
      const [workFilter, setWorkFilter] = React.useState('all')
      const [syncing, setSyncing] = React.useState(false)
      const [extracting, setExtracting] = React.useState('')
      const [addOpen, setAddOpen] = React.useState(false)
      const [extractTextOpen, setExtractTextOpen] = React.useState(false)
      const [viewing, setViewing] = React.useState(null)

      React.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const items = asArray(snapshot.items).filter((item) => isMediaActive(item))
      const guides = items
        .filter((item) => mediaGroupOf(item) === 'guide' && asText(item.mediaClass) !== 'list')
        .sort(byCreatedDesc)
      const works = asArray(snapshot.works).filter((work) => work && asText(work.id))
      const gameWorks = works.filter((work) => asText(work.kind) !== 'drama')
      const dramaWorks = works.filter((work) => asText(work.kind) === 'drama')
      const visibleWorks = works.filter((work) => workFilter === 'all' || asText(work.kind) === workFilter)
      const viewingWork = viewing ? works.find((work) => asText(work.id) === asText(viewing)) || null : null

      const syncWorks = async () => {
        if (syncing) return
        setSyncing(true)
        try {
          const data = await postJson(API.worksSync, {})
          if (!alive.current) return
          const created = numOr(data.created, asArray(data.works).length)
          if (typeof props.notify === 'function') props.notify(ti(t, 'mediaSyncDone', { n: created }))
          if (typeof props.onReload === 'function') props.onReload()
        } catch (failure) {
          if (!alive.current) return
          if (typeof props.notify === 'function') {
            props.notify(tr(t, 'mediaSyncFailed') + '：' + String((failure && failure.message) || failure), 'error')
          }
        } finally {
          if (alive.current) setSyncing(false)
        }
      }

      const extractFromItem = async (item) => {
        const id = asText(item && item.id)
        if (!id || extracting) return
        setExtracting(id)
        try {
          const data = await postJson(API.worksExtract, { itemId: id })
          if (!alive.current) return
          const added = numOr(data.added, asArray(data.works).length)
          const failed = asArray(data.failed).length
          if (typeof props.notify === 'function') {
            const text =
              ti(t, 'mediaExtracted', { n: added }) + (failed > 0 ? '；' + ti(t, 'mediaExtractFailed', { n: failed }) : '')
            props.notify(text, failed > 0 ? 'warn' : 'ok')
          }
          if (typeof props.onReload === 'function') props.onReload()
        } catch (failure) {
          if (!alive.current) return
          if (typeof props.notify === 'function') {
            const message = String((failure && failure.message) || failure)
            props.notify(tr(t, 'mediaExtractError') + '：' + message + '；' + tr(t, 'mediaExtractAdvice'), 'error')
          }
        } finally {
          if (alive.current) setExtracting('')
        }
      }

      if (!guides.length && !works.length) {
        return h(EmptyState, {
          t,
          icon: 'play',
          title: tr(t, 'mediaEmptyTitle'),
          desc: tr(t, 'mediaEmptyDesc'),
        })
      }

      const filterButton = (id, label, count, onChange, active) =>
        h(
          'button',
          {
            type: 'button',
            className: 'wl-chip',
            'data-active': active === id ? 'true' : 'false',
            title: label,
            onClick: () => onChange(id),
          },
          label,
          h('span', { className: 'wl-chip-count' }, String(count)),
        )

      const renderGuideRow = (item) => {
        const id = asText(item.id)
        const busy = extracting === id
        const title = asText(item.title) || tr(t, 'untitled')
        const meta = [asText(item.site), timeAgo(t, item.createdAt, now)].filter(Boolean).join(' · ')
        return h(
          'div',
          { className: 'wl-media-row', key: id || title },
          h('div', { className: 'wl-media-thumb' }, h(Cover, { t, item, iconSize: 18 })),
          h(
            'div',
            { className: 'wl-media-main' },
            h(
              'div',
              { className: 'wl-media-line' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'wl-media-title',
                  title: tr(t, 'details'),
                  onClick: () => {
                    if (typeof props.onOpen === 'function') props.onOpen(id)
                  },
                },
                title,
              ),
              h('span', { className: 'wl-media-badge' }, tr(t, 'mediaBadgeGuide')),
            ),
            meta ? h('div', { className: 'wl-media-meta' }, meta) : null,
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'wl-btn wl-btn-sm',
              title: tr(t, 'mediaExtract'),
              disabled: busy,
              onClick: () => extractFromItem(item),
            },
            h(Icon, { name: 'sparkle', size: 13 }),
            busy ? tr(t, 'mediaExtracting') : tr(t, 'mediaExtract'),
          ),
        )
      }

      const renderWorkCard = (work) => {
        const id = asText(work.id)
        const title = asText(work.title) || tr(t, 'untitled')
        const kind = asText(work.kind) === 'drama' ? 'drama' : 'game'
        return h(
          'div',
          {
            className: 'wl-work-card',
            key: id || title,
            role: 'button',
            tabIndex: 0,
            title: tr(t, 'workDetailTitle'),
            onClick: () => setViewing(id),
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                setViewing(id)
              }
            },
          },
          h('div', { className: 'wl-work-poster' }, h(Cover, { t, item: workAsItem(work), iconSize: 30 })),
          h(
            'div',
            { className: 'wl-work-card-body' },
            h('div', { className: 'wl-work-card-title', title }, title),
            h('span', { className: 'wl-work-card-kind', 'data-kind': kind }, workShelfKindLabel(t, kind)),
          ),
        )
      }

      const toolbar = h(
        'div',
        { className: 'wl-media-toolbar' },
        h('span', { className: 'wl-media-total' }, ti(t, 'mediaTotal', { n: guides.length + works.length })),
        h('span', { className: 'wl-spacer' }),
        filterButton('all', tr(t, 'statusAll'), guides.length + works.length, setFilter, filter),
        filterButton('guide', tr(t, 'mediaFilterGuide'), guides.length, setFilter, filter),
        filterButton('list', tr(t, 'mediaFilterList'), works.length, setFilter, filter),
        h(
          'button',
          {
            type: 'button',
            className: 'wl-btn wl-btn-sm',
            title: tr(t, 'mediaAddWork'),
            onClick: () => setAddOpen(true),
          },
          h(Icon, { name: 'plus', size: 13 }),
          tr(t, 'mediaAddWork'),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'wl-btn wl-btn-sm',
            title: tr(t, 'mediaExtractText'),
            onClick: () => setExtractTextOpen(true),
          },
          h(Icon, { name: 'file', size: 13 }),
          tr(t, 'mediaExtractText'),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'wl-btn wl-btn-sm',
            title: tr(t, 'mediaSyncWorks'),
            disabled: syncing,
            onClick: syncWorks,
          },
          h(Icon, { name: 'refresh', size: 13, className: syncing ? 'wl-spin' : '' }),
          syncing ? tr(t, 'mediaSyncing') : tr(t, 'mediaSyncWorks'),
        ),
      )

      return h(
        React.Fragment,
        null,
        toolbar,
        filter === 'all' || filter === 'guide'
          ? guides.length
            ? h(
                'section',
                { className: 'wl-media-section', 'aria-label': tr(t, 'mediaGuideTitle') },
                h(
                  'div',
                  { className: 'wl-section-head' },
                  h('h2', { className: 'wl-media-section-title' }, tr(t, 'mediaGuideTitle')),
                  h('span', { className: 'wl-section-count' }, String(guides.length)),
                ),
                h('div', { className: 'wl-media-guide-list' }, guides.map(renderGuideRow)),
              )
            : filter === 'guide'
              ? h(EmptyState, { t, icon: 'note', title: tr(t, 'mediaGuideEmpty') })
              : h('p', { className: 'wl-media-section-empty' }, tr(t, 'mediaGuideEmpty'))
          : null,
        filter === 'all' || filter === 'list'
          ? works.length
            ? h(
                'section',
                { className: 'wl-media-section', 'aria-label': tr(t, 'mediaWorksTitle') },
                h(
                  'div',
                  { className: 'wl-section-head' },
                  h('h2', { className: 'wl-media-section-title' }, tr(t, 'mediaWorksTitle')),
                  h('span', { className: 'wl-section-count' }, String(works.length)),
                  h(
                    'span',
                    { className: 'wl-work-section-tools' },
                    filterButton('all', tr(t, 'statusAll'), works.length, setWorkFilter, workFilter),
                    filterButton('game', tr(t, 'mediaWorkFilterGame'), gameWorks.length, setWorkFilter, workFilter),
                    filterButton('drama', tr(t, 'mediaWorkFilterDrama'), dramaWorks.length, setWorkFilter, workFilter),
                  ),
                ),
                h('div', { className: 'wl-work-grid' }, visibleWorks.map(renderWorkCard)),
              )
            : filter === 'list'
              ? h(EmptyState, { t, icon: 'play', title: tr(t, 'mediaWorksEmpty'), desc: tr(t, 'mediaWorksEmptyDesc') })
              : h(
                  'p',
                  { className: 'wl-media-section-empty' },
                  tr(t, 'mediaWorksEmpty') + ' · ' + tr(t, 'mediaWorksEmptyDesc'),
                )
          : null,
        viewingWork
          ? h(WorkDialog, {
              t,
              work: viewingWork,
              notify: props.notify,
              onReload: props.onReload,
              onClose: () => setViewing(null),
            })
          : null,
        addOpen
          ? h(AddWorkDialog, {
              t,
              notify: props.notify,
              onReload: props.onReload,
              onClose: () => setAddOpen(false),
            })
          : null,
        extractTextOpen
          ? h(ExtractTextDialog, {
              t,
              notify: props.notify,
              onReload: props.onReload,
              onClose: () => setExtractTextOpen(false),
            })
          : null,
      )
    }

    /* --------------------------------------------------------------- topics */

    const TOPIC_CATEGORIES = [
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
    const TOPIC_UNSORTED = '待归档'
    const TOPIC_GROUP_LIMIT = 30

    function topicOf(item) {
      const tags = tagsOf(item)
      for (let index = 0; index < tags.length; index += 1) {
        if (TOPIC_CATEGORIES.indexOf(tags[index]) >= 0) return tags[index]
      }
      return TOPIC_UNSORTED
    }

    function byTopicOrder(a, b) {
      const scoreA = numOr(a && a.score, -1)
      const scoreB = numOr(b && b.score, -1)
      if (scoreA !== scoreB) return scoreB - scoreA
      return byCreatedDesc(a, b)
    }

    function TopicView(props) {
      const t = props.t
      const snapshot = asObject(props.snapshot)
      const [collapsed, setCollapsed] = React.useState({})

      const items = asArray(snapshot.items).filter((item) => item && isActiveStatus(asText(item.status)))
      const groups = TOPIC_CATEGORIES.map((name) => ({
        name,
        rows: items.filter((item) => topicOf(item) === name).sort(byTopicOrder),
      })).filter((group) => group.rows.length)

      if (!items.length) {
        return h(EmptyState, {
          t,
          icon: 'note',
          title: tr(t, 'topicsEmptyTitle'),
          desc: tr(t, 'topicsEmptyDesc'),
        })
      }

      const toggle = (name) => {
        setCollapsed((previous) => {
          const next = Object.assign({}, previous)
          if (next[name]) delete next[name]
          else next[name] = true
          return next
        })
      }

      const labelOf = (name) => (name === TOPIC_UNSORTED ? tr(t, 'topicsUnsorted') : name)

      const renderRow = (item, index) => {
        const id = asText(item.id)
        const title = asText(item.title) || tr(t, 'untitled')
        const meta = [asText(item.site), kindLabel(t, asText(item.kind) || 'other')].filter(Boolean).join(' · ')
        const tags = tagsOf(item).slice(0, 4)
        return h(
          'button',
          {
            type: 'button',
            className: 'wl-topics-row',
            key: id || 'topic-' + index,
            title: tr(t, 'details'),
            onClick: () => {
              if (typeof props.onOpen === 'function') props.onOpen(id)
            },
          },
          h(
            'span',
            { className: 'wl-topics-main' },
            h('span', { className: 'wl-topics-title' }, title),
            meta ? h('span', { className: 'wl-topics-meta' }, meta) : null,
            tags.length
              ? h(
                  'span',
                  { className: 'wl-topics-tags' },
                  tags.map((tag) => h('span', { className: 'wl-tag', key: tag }, tag)),
                )
              : null,
          ),
          h(ScoreBadge, { t, score: item.score }),
        )
      }

      return h(
        'div',
        { className: 'wl-topics' },
        groups.map((group) => {
          const isCollapsed = Boolean(collapsed[group.name])
          const hidden = Math.max(0, group.rows.length - TOPIC_GROUP_LIMIT)
          return h(
            'section',
            { className: 'wl-topics-group', key: group.name, 'data-collapsed': isCollapsed ? 'true' : 'false' },
            h(
              'button',
              {
                type: 'button',
                className: 'wl-topics-head',
                title: labelOf(group.name),
                'aria-expanded': isCollapsed ? 'false' : 'true',
                onClick: () => toggle(group.name),
              },
              h(Icon, { name: 'chevron', size: 14, className: 'wl-topics-chevron' }),
              h('span', { className: 'wl-topics-name' }, labelOf(group.name)),
              h('span', { className: 'wl-section-count' }, ti(t, 'itemsCount', { n: group.rows.length })),
            ),
            isCollapsed
              ? null
              : h(
                  'div',
                  { className: 'wl-topics-list' },
                  group.rows.slice(0, TOPIC_GROUP_LIMIT).map(renderRow),
                  hidden ? h('p', { className: 'wl-topics-more' }, ti(t, 'topicsMore', { n: hidden })) : null,
                ),
          )
        }),
      )
    }

    /* ---------------------------------------------------------------- idea */

    function IdeaView(props) {
      const t = props.t
      const snapshot = asObject(props.snapshot)
      const now = props.now
      const ideas = asArray(snapshot.items)
        .filter((item) => item && asText(item.kind) === 'idea')
        .filter((item) => ['inbox', 'queued', 'doing'].indexOf(asText(item.status)) >= 0)
        .sort(byCreatedDesc)

      if (!ideas.length) {
        return h(EmptyState, {
          t,
          icon: 'sparkle',
          title: tr(t, 'ideasEmptyTitle'),
          desc: tr(t, 'ideasEmptyDesc'),
        })
      }

      const renderCard = (item) => {
        const id = asText(item.id)
        const title = asText(item.title) || tr(t, 'untitled')
        const summary = asText(item.summary)
        const meta = [asText(item.site), timeAgo(t, item.createdAt, now)].filter(Boolean).join(' · ')
        return h(
          'div',
          {
            className: 'wl-media-card wl-idea-card',
            key: id || title,
            role: 'button',
            tabIndex: 0,
            title: tr(t, 'details'),
            onClick: () => {
              if (typeof props.onOpen === 'function') props.onOpen(id)
            },
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                if (typeof props.onOpen === 'function') props.onOpen(id)
              }
            },
          },
          h('div', { className: 'wl-media-card-cover' }, h(Cover, { t, item, iconSize: 24 })),
          h(
            'div',
            { className: 'wl-media-card-body' },
            h('div', { className: 'wl-media-card-title', title }, title),
            summary ? h('p', { className: 'wl-idea-note' }, summary) : null,
            meta ? h('div', { className: 'wl-media-meta' }, meta) : null,
          ),
        )
      }

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'wl-media-toolbar' },
          h('span', { className: 'wl-media-total' }, ti(t, 'ideasTotal', { n: ideas.length })),
          h('span', { className: 'wl-spacer' }),
          h('span', { className: 'wl-media-total' }, tr(t, 'ideasHint')),
        ),
        h('div', { className: 'wl-media-wall' }, ideas.map(renderCard)),
      )
    }

    /* ---------------------------------------------------------------- agent */

    function AgentView(props) {
      const t = props.t
      const snapshot = asObject(props.snapshot)
      const now = props.now
      const runtime = asObject(props.runtime)
      const alive = React.useRef(true)
      const [filter, setFilter] = React.useState('all')
      const [pending, setPending] = React.useState('')
      const [enriching, setEnriching] = React.useState(false)

      React.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const items = asArray(snapshot.items)
        .filter((item) => {
          if (!item) return false
          const agent = asObject(item.agent)
          if (agent.relevant !== true) return false
          const status = asText(item.status)
          if (status !== 'inbox' && status !== 'queued' && status !== 'doing') return false
          return AGENT_CATEGORIES.indexOf(asText(agent.kind)) >= 0
        })
        .sort(byCreatedDesc)
      const statusOf = (item) => {
        const status = asText(asObject(item.agent).status)
        return ['new', 'opened', 'tried', 'skipped'].indexOf(status) >= 0 ? status : 'new'
      }
      const categoryOf = (item) => asText(asObject(item.agent).kind)
      const counts = {}
      AGENT_CATEGORIES.forEach((kind) => {
        counts[kind] = items.filter((item) => categoryOf(item) === kind).length
      })
      const filtered = filter === 'all' ? items : items.filter((item) => categoryOf(item) === filter)

      const setStatus = async (item, status) => {
        const id = asText(item && item.id)
        if (!id || pending) return
        setPending(id)
        try {
          await postJson(API.update, { id, patch: { agentStatus: status } })
          if (!alive.current) return
          if (typeof props.notify === 'function') props.notify(tr(t, 'agentUpdated'))
          if (typeof props.onReload === 'function') props.onReload()
        } catch (failure) {
          if (!alive.current) return
          if (typeof props.notify === 'function') {
            props.notify(String((failure && failure.message) || failure), 'error')
          }
        } finally {
          if (alive.current) setPending('')
        }
      }

      const tryAgent = async (item) => {
        const id = asText(item && item.id)
        if (!id || pending) return
        setPending(id)
        const prompt = agentPromptText(t, item)
        try {
          if (canLaunchAgent(runtime)) {
            await launchAgentSession(runtime, prompt)
            await postJson(API.update, { id, patch: { agentStatus: 'opened' } })
            if (!alive.current) return
            if (typeof props.notify === 'function') props.notify(tr(t, 'agentLaunched'))
            if (typeof props.onReload === 'function') props.onReload()
          } else {
            const copied = copyText(prompt)
            if (!copied) {
              if (alive.current && typeof props.notify === 'function') props.notify(tr(t, 'copyFail'), 'error')
              return
            }
            await postJson(API.update, { id, patch: { agentStatus: 'opened' } })
            if (!alive.current) return
            if (typeof props.notify === 'function') props.notify(tr(t, 'agentCopiedFallback'))
            if (typeof props.onReload === 'function') props.onReload()
          }
        } catch (failure) {
          if (!alive.current) return
          if (typeof props.notify === 'function') {
            const message = String((failure && failure.message) || failure)
            props.notify(tr(t, 'agentLaunchFailed') + '：' + message, 'error')
          }
        } finally {
          if (alive.current) setPending('')
        }
      }

      const enrichNames = async () => {
        if (enriching) return
        setEnriching(true)
        try {
          const data = await postJson(API.agentEnrich, { limit: 30 })
          if (!alive.current) return
          const updated = numOr(data.updated, 0)
          if (typeof props.notify === 'function') props.notify(ti(t, 'agentEnriched', { n: updated }))
          if (typeof props.onReload === 'function') props.onReload()
        } catch (failure) {
          if (!alive.current) return
          if (typeof props.notify === 'function') {
            const message = String((failure && failure.message) || failure)
            props.notify(tr(t, 'agentEnrichFailed') + '：' + message, 'error')
          }
        } finally {
          if (alive.current) setEnriching(false)
        }
      }

      const filters = [
        { id: 'all', label: tr(t, 'statusAll') },
        { id: 'prompt', label: agentKindLabel(t, 'prompt') },
        { id: 'plugin', label: agentKindLabel(t, 'plugin') },
        { id: 'skill', label: agentKindLabel(t, 'skill') },
      ]

      if (!items.length) {
        return h(EmptyState, {
          t,
          icon: 'sparkle',
          title: tr(t, 'agentEmptyTitle'),
          desc: tr(t, 'agentEmptyDesc'),
        })
      }

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'wl-agent-toolbar' },
          h('span', { className: 'wl-images-stat' }, ti(t, 'agentCount', { n: items.length })),
          h('span', { className: 'wl-spacer' }),
          filters.map((entry) =>
            h(
              'button',
              {
                key: entry.id,
                type: 'button',
                className: 'wl-chip',
                'data-active': filter === entry.id ? 'true' : 'false',
                title: entry.label,
                onClick: () => setFilter(entry.id),
              },
              entry.label,
              h('span', { className: 'wl-chip-count' }, String(entry.id === 'all' ? items.length : counts[entry.id])),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'wl-btn wl-btn-sm',
              title: tr(t, 'agentEnrich'),
              disabled: enriching,
              onClick: enrichNames,
            },
            h(Icon, { name: 'refresh', size: 13, className: enriching ? 'wl-spin' : '' }),
            enriching ? tr(t, 'agentEnriching') : tr(t, 'agentEnrich'),
          ),
        ),
        filtered.length
          ? h(
              'div',
              { className: 'wl-agent-list' },
              filtered.map((item) => {
                const id = asText(item.id)
                const agent = asObject(item.agent)
                const kind = categoryOf(item)
                const status = statusOf(item)
                const busy = pending === id
                const title = asText(agent.name) || asText(item.title) || tr(t, 'untitled')
                const purpose = asText(agent.purpose) || asText(item.summary)
                const meta = [asText(item.site), timeAgo(t, item.createdAt, now), formatDuration(t, item.durationMin)]
                  .filter(Boolean)
                  .join(' · ')
                return h(
                  'div',
                  { className: 'wl-agent-row', key: id || title },
                  h(
                    'div',
                    { className: 'wl-agent-main' },
                    h(
                      'div',
                      { className: 'wl-agent-head' },
                      h('span', { className: 'wl-agent-kind', 'data-kind': kind }, agentKindLabel(t, kind)),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'wl-agent-title',
                          title: tr(t, 'details'),
                          onClick: () => {
                            if (typeof props.onOpen === 'function') props.onOpen(id)
                          },
                        },
                        title,
                      ),
                      h('span', { className: 'wl-agent-status', 'data-status': status }, agentStatusLabel(t, status)),
                    ),
                    purpose ? h('div', { className: 'wl-agent-purpose', title: purpose }, purpose) : null,
                    meta ? h('div', { className: 'wl-agent-meta' }, meta) : null,
                  ),
                  h(
                    'div',
                    { className: 'wl-agent-actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'wl-btn wl-btn-sm wl-btn-primary',
                        title: tr(t, 'agentTry'),
                        disabled: busy,
                        onClick: () => tryAgent(item),
                      },
                      busy ? tr(t, 'agentTrying') : tr(t, 'agentTry'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'wl-btn wl-btn-sm',
                        title: tr(t, 'agentMarkTried'),
                        disabled: busy || status === 'tried',
                        onClick: () => setStatus(item, 'tried'),
                      },
                      tr(t, 'agentMarkTried'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'wl-btn wl-btn-sm',
                        title: tr(t, 'agentSkip'),
                        disabled: busy || status === 'skipped',
                        onClick: () => setStatus(item, 'skipped'),
                      },
                      tr(t, 'agentSkip'),
                    ),
                  ),
                )
              }),
            )
          : h(EmptyState, { t, icon: 'sparkle', title: tr(t, 'agentFilteredEmpty') }),
      )
    }

    function SettingsView(props) {
      const t = props.t
      const snapshot = asObject(props.snapshot)
      const settings = asObject(snapshot.settings)
      const alive = React.useRef(true)
      const [busyKey, setBusyKey] = React.useState('')
      const [retention, setRetention] = React.useState(String(numOr(settings.retentionDays, 30)))

      React.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      React.useEffect(() => {
        setRetention(String(numOr(settings.retentionDays, 30)))
      }, [settings.retentionDays])

      const patchSetting = async (patch, key, message) => {
        if (busyKey) return
        setBusyKey(key)
        try {
          await postJson(API.settings, { patch })
          if (!alive.current) return
          if (message) props.notify(message)
          props.onChanged()
        } catch (failure) {
          if (!alive.current) return
          props.notify(String((failure && failure.message) || failure), 'error')
        } finally {
          if (alive.current) setBusyKey('')
        }
      }

      const saveRetention = async () => {
        const value = Math.max(1, Math.min(3650, Math.round(numOr(retention, 30))))
        if (busyKey) return
        setBusyKey('retention')
        try {
          await postJson(API.settings, { patch: { retentionDays: value } })
          if (!alive.current) return
          setRetention(String(value))
          props.notify(tr(t, 'settingsSaved'))
          props.onChanged()
        } catch (failure) {
          if (!alive.current) return
          props.notify(String((failure && failure.message) || failure), 'error')
        } finally {
          if (alive.current) setBusyKey('')
        }
      }

      const runAiReview = async () => {
        if (busyKey) return
        setBusyKey('ai')
        try {
          await props.onAiReview()
        } catch {
          // the parent surfaces the failure as a toast
        } finally {
          if (alive.current) setBusyKey('')
        }
      }

      const openExport = () => {
        try {
          window.open(API.export, '_blank')
          props.notify(tr(t, 'toastExport'))
        } catch {
          props.notify(tr(t, 'exportOpen'), 'error')
        }
      }

      const copyDir = (value) => {
        if (copyText(value)) props.notify(tr(t, 'copied'))
        else props.notify(tr(t, 'copyFail'), 'error')
      }

      const setting = (title, desc, control) =>
        h(
          'div',
          { className: 'wl-setting' },
          h(
            'div',
            { className: 'wl-setting-main' },
            h('h3', { className: 'wl-setting-title' }, title),
            desc ? h('p', { className: 'wl-setting-desc' }, desc) : null,
          ),
          h('div', { className: 'wl-setting-control' }, control),
        )

      const dirRow = (label, value) =>
        h(
          'div',
          { className: 'wl-kv' },
          h('span', { className: 'wl-kv-k' }, label),
          h('span', { className: 'wl-kv-v wl-kv-path', title: value }, asText(value) || '—'),
          h(
            'button',
            {
              type: 'button',
              className: 'wl-btn wl-btn-sm',
              title: tr(t, 'copy'),
              onClick: () => copyDir(value),
            },
            tr(t, 'copy'),
          ),
        )

      const aiStatus = settings.aiAvailable ? asText(settings.aiModel) || '—' : tr(t, 'settingsAiUnavailable')

      return h(
        React.Fragment,
        null,
        h(
          'section',
          { className: 'wl-settings' },
          setting(
            tr(t, 'settingsAutoAi'),
            tr(t, 'settingsAutoAiDesc'),
            h(Switch, {
              checked: settings.autoAiOnSync !== false,
              disabled: busyKey === 'autoAiOnSync',
              label: tr(t, 'settingsAutoAi'),
              onChange: (next) => patchSetting({ autoAiOnSync: next }, 'autoAiOnSync'),
            }),
          ),
          setting(
            tr(t, 'settingsInbox'),
            tr(t, 'settingsInboxDesc'),
            h(Switch, {
              checked: settings.inboxEnabled !== false,
              disabled: busyKey === 'inboxEnabled',
              label: tr(t, 'settingsInbox'),
              onChange: (next) => patchSetting({ inboxEnabled: next }, 'inboxEnabled'),
            }),
          ),
          setting(
            tr(t, 'settingsDedupe'),
            tr(t, 'settingsDedupeDesc'),
            h(Switch, {
              checked: settings.dedupeClusters !== false,
              disabled: busyKey === 'dedupeClusters',
              label: tr(t, 'settingsDedupe'),
              onChange: (next) => patchSetting({ dedupeClusters: next }, 'dedupeClusters'),
            }),
          ),
          setting(
            tr(t, 'settingsDirs'),
            null,
            h(
              'div',
              { className: 'wl-dir-list' },
              dirRow(tr(t, 'dataDir'), settings.dataDir),
              dirRow(tr(t, 'inboxDir'), settings.inboxDir),
            ),
          ),
          setting(
            tr(t, 'settingsRetention'),
            ti(t, 'settingsRetentionDesc', { n: numOr(settings.retentionDays, 30) }),
            h(
              'div',
              { className: 'wl-inline' },
              h('input', {
                type: 'number',
                min: 1,
                max: 3650,
                className: 'wl-input wl-input-num',
                value: retention,
                'aria-label': tr(t, 'settingsRetention'),
                title: tr(t, 'settingsRetention'),
                disabled: busyKey === 'retention',
                onChange: (event) => setRetention(event.target.value),
              }),
              h('span', { className: 'wl-field-hint' }, tr(t, 'daysUnit')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'wl-btn wl-btn-sm',
                  title: tr(t, 'settingsSave'),
                  disabled: busyKey === 'retention',
                  onClick: saveRetention,
                },
                tr(t, 'settingsSave'),
              ),
            ),
          ),
          setting(
            tr(t, 'settingsAiAll'),
            tr(t, 'settingsAiAllDesc'),
            h(
              'div',
              { className: 'wl-inline' },
              h('span', { className: 'wl-field-hint' }, tr(t, 'settingsAiModel') + ' · ' + aiStatus),
              h(
                'button',
                {
                  type: 'button',
                  className: 'wl-btn wl-btn-sm',
                  title: tr(t, 'settingsAiAll'),
                  disabled: busyKey === 'ai' || settings.aiAvailable === false,
                  onClick: runAiReview,
                },
                busyKey === 'ai' ? tr(t, 'aiReviewing') : tr(t, 'aiReview'),
              ),
            ),
          ),
          setting(
            tr(t, 'settingsExport'),
            tr(t, 'settingsExportDesc'),
            h(
              'button',
              { type: 'button', className: 'wl-btn wl-btn-sm', title: tr(t, 'exportOpen'), onClick: openExport },
              h(Icon, { name: 'external', size: 13 }),
              tr(t, 'exportOpen'),
            ),
          ),
        ),
        h(
          'section',
          { className: 'wl-settings wl-settings-about' },
          h('h3', { className: 'wl-setting-title' }, tr(t, 'settingsAbout')),
          h('p', { className: 'wl-setting-desc' }, tr(t, 'settingsAboutText')),
        ),
      )
    }

    /* ---------------------------------------------------------------- center */

    function WatchLaterCenter(props) {
      const t = props.t
      const snapshotRes = useSnapshot()
      const now = useNow(CLOCK_MS)
      const [tab, setTab] = React.useState('today')
      const [drawerId, setDrawerId] = React.useState(null)
      const [addOpen, setAddOpen] = React.useState(false)
      const [toast, setToast] = React.useState(null)
      const [busy, setBusy] = React.useState({})
      const [authOpen, setAuthOpen] = React.useState(false)
      const [aiJob, setAiJob] = React.useState(null)
      const busyRef = React.useRef({})
      const aiWasRunning = React.useRef(false)
      const aiPollErrors = React.useRef(0)
      const snapshot = snapshotRes.data
      const snapshotObj = asObject(snapshot)
      const items = asArray(snapshotObj.items)
      const counts = asObject(snapshotObj.counts)
      const totals = asObject(snapshotObj.totals)
      const settings = asObject(snapshotObj.settings)
      const accounts = asObject(snapshotObj.accounts)
      const aiRunning = Boolean(aiJob && aiJob.running)
      const aiTotal = numOr(aiJob && aiJob.total, 0)
      const aiProcessed = numOr(aiJob && aiJob.processed, 0)
      const aiPercent = aiTotal > 0 ? Math.min(100, Math.round((aiProcessed / aiTotal) * 100)) : aiRunning ? 8 : 0
      const aiPendingCount = numOr(asObject(counts.organize).pending, 0)
      const authMissing =
        Boolean(snapshot) &&
        ['bilibili', 'douyin', 'xiaohongshu'].some((key) => asObject(accounts[key]).configured !== true)
      const isDesktop = typeof navigator !== 'undefined' && /electron/i.test(navigator.userAgent || '')

      const notify = React.useCallback((text, kind) => {
        if (!text) return
        setToast({ id: Date.now() + Math.random(), text: String(text), kind: kind === 'error' ? 'error' : kind === 'warn' ? 'warn' : 'ok' })
      }, [])

      React.useEffect(() => {
        if (!toast) return undefined
        const timer = window.setTimeout(() => setToast(null), TOAST_MS)
        return () => window.clearTimeout(timer)
      }, [toast])

      const perform = React.useCallback(
        async (key, task, message) => {
          if (busyRef.current[key]) return null
          busyRef.current[key] = true
          setBusy((previous) => Object.assign({}, previous, { [key]: true }))
          try {
            const result = await task()
            if (message) notify(typeof message === 'function' ? message(result) : message)
            snapshotRes.reload()
            return result
          } catch (error) {
            notify(String((error && error.message) || error), 'error')
            throw error
          } finally {
            busyRef.current[key] = false
            setBusy((previous) => {
              if (!previous[key]) return previous
              const next = Object.assign({}, previous)
              delete next[key]
              return next
            })
          }
        },
        [notify, snapshotRes.reload],
      )

      const actionMessage = (action) => {
        if (action === 'done') return tr(t, 'toastDone')
        if (action === 'archive') return tr(t, 'toastArchived')
        if (action === 'restore') return tr(t, 'toastRestored')
        if (action === 'snooze') return tr(t, 'toastSnoozed')
        return ''
      }

      const runAction = (item, action, extra) => {
        const id = asText(item && item.id)
        return perform(
          id,
          () => postJson(API.action, Object.assign({ id, action }, extra || {})),
          actionMessage(action),
        )
      }

      const updateItem = (item, patch) => {
        const id = asText(item && item.id)
        return perform(id, () => postJson(API.update, { id, patch }), null)
      }

      const saveItem = (item, patch) => {
        const id = asText(item && item.id)
        return perform(id, () => postJson(API.update, { id, patch }), tr(t, 'toastSaved'))
      }

      const deleteItem = (item) => {
        const id = asText(item && item.id)
        return perform(id, () => postJson(API.remove, { id }), tr(t, 'toastDeleted'))
      }

      const startItem = (item) => {
        const id = asText(item && item.id)
        return perform(id, () => postJson(API.action, { id, action: 'start' }), null)
      }

      const restoreArchived = (item) => {
        const id = asText(item && item.id)
        return perform('archived:' + id, () => postJson(API.action, { id, action: 'restore' }), tr(t, 'toastRestored'))
      }

      const undoAiSort = (item) => {
        const id = asText(item && item.id)
        return perform('undo:' + id, () => postJson(API.aiUndo, { id }), tr(t, 'aiUndone'))
      }

      const aiReview = React.useCallback(() => {
        if (aiJob && aiJob.running) return Promise.resolve(null)
        aiPollErrors.current = 0
        return perform('@ai', async () => {
          // 默认只补「没整理过 / 失败」的，已经 done 的不重复花钱
          const data = await postJson(API.aiOrganize, { mode: 'pending', states: ['none', 'failed'] })
          const total = numOr(data.total, 0)
          setAiJob({
            running: true,
            mode: 'all',
            total,
            processed: 0,
            done: 0,
            partial: 0,
            failed: 0,
            current: null,
            startedAt: new Date().toISOString(),
            finishedAt: null,
            lastError: null,
          })
          notify(total > 0 ? ti(t, 'aiOrganizeStarted', { total }) : tr(t, 'aiNothingToOrganize'))
          return data
        })
      }, [perform, notify, t, aiJob])

      /* While an organize job runs, poll its status every 2s and quietly refresh the snapshot. */
      const pollAiStatus = React.useCallback(async () => {
        try {
          const data = await getJson(API.aiStatus)
          aiPollErrors.current = 0
          setAiJob(asObject(data.job))
          snapshotRes.retry()
        } catch {
          aiPollErrors.current += 1
          if (aiPollErrors.current >= 3) {
            setAiJob((previous) => (previous ? Object.assign({}, previous, { running: false }) : previous))
          }
        }
      }, [snapshotRes.retry])

      React.useEffect(() => {
        if (!aiRunning) return undefined
        let alive = true
        const tick = () => {
          if (!alive) return
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          pollAiStatus()
        }
        const timer = window.setInterval(tick, AI_POLL_MS)
        tick()
        return () => {
          alive = false
          window.clearInterval(timer)
        }
      }, [aiRunning, pollAiStatus])

      /* Attach to a job that was already running before this panel mounted. */
      React.useEffect(() => {
        let alive = true
        getJson(API.aiStatus)
          .then((data) => {
            if (!alive) return
            const job = asObject(data.job)
            if (job.running === true) {
              aiWasRunning.current = true
              setAiJob(job)
            }
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [])

      /* Summarise the job with a toast when it stops running. */
      React.useEffect(() => {
        const running = Boolean(aiJob && aiJob.running)
        if (aiWasRunning.current && !running && aiJob) {
          const failed = numOr(aiJob.failed, 0)
          const lastError = asText(aiJob.lastError)
          let text = ti(t, 'aiOrganizeSummary', {
            done: numOr(aiJob.done, 0),
            partial: numOr(aiJob.partial, 0),
            failed,
          })
          if (lastError) text = text + ' · ' + tr(t, 'aiLastError') + '：' + lastError
          notify(text, failed > 0 || lastError ? 'warn' : 'ok')
          snapshotRes.reload()
        }
        aiWasRunning.current = running
      }, [aiJob, notify, t, snapshotRes.reload])

      const selected = React.useMemo(() => {
        if (!drawerId) return null
        return items.find((item) => item && asText(item.id) === drawerId) || null
      }, [drawerId, items])

      React.useEffect(() => {
        if (drawerId && !selected) setDrawerId(null)
      }, [drawerId, selected])

      const pendingOf = React.useCallback((item) => Boolean(item && busy[asText(item.id)]), [busy])

      const openItem = React.useCallback((id) => {
        if (id) setDrawerId(String(id))
      }, [])

      const openAdd = () => setAddOpen(true)
      const changeTab = (next) => setTab(next)

      let hotText = ''
      let statsText = ''
      let stampText = ''
      if (snapshot) {
        const nowCount = numOr(counts.now, 0)
        const expiringCount = asArray(snapshotObj.expiring).length
        const hot = []
        if (nowCount > 0) hot.push(ti(t, 'metaNow', { n: nowCount }))
        if (expiringCount > 0) hot.push(ti(t, 'metaExpiring', { n: expiringCount }))
        hotText = hot.length ? hot.join(' · ') : tr(t, 'metaQuiet')
        statsText = ti(t, 'metaStats', {
          active: numOr(counts.active, 0),
          added: numOr(totals.addedToday, 0),
          done: numOr(totals.doneToday, 0),
        })
        stampText = snapshotObj.generatedAt ? ti(t, 'updatedAt', { time: fmtTime(snapshotObj.generatedAt) }) : ''
      }

      let content = null
      if (!snapshot) {
        content = snapshotRes.error
          ? h(ErrorState, { t, error: snapshotRes.error, onRetry: snapshotRes.retry })
          : h(LoadingState, { t })
      } else if (tab === 'images') {
        content = h(ImagesView, {
          t,
          snapshot,
          now,
          notify,
          onOpen: openItem,
          onAction: runAction,
          onReload: snapshotRes.reload,
          onAdd: openAdd,
        })
      } else if (tab === 'want') {
        content = h(WantView, {
          t,
          snapshot,
          now,
          notify,
          onOpen: openItem,
          onReload: snapshotRes.reload,
        })
      } else if (tab === 'ideas') {
        content = h(IdeaView, { t, snapshot, now, onOpen: openItem })
      } else if (tab === 'topics') {
        content = h(TopicView, { t, snapshot, now, onOpen: openItem })
      } else if (tab === 'agent') {
        content = h(AgentView, {
          t,
          snapshot,
          now,
          runtime: props.runtime,
          notify,
          onOpen: openItem,
          onReload: snapshotRes.reload,
        })
      } else if (tab === 'inbox') {
        content = h(InboxView, {
          t,
          snapshot,
          now,
          pendingOf,
          onOpen: openItem,
          onUpdate: updateItem,
          onAction: runAction,
        })
      } else if (tab === 'library') {
        content = h(LibraryView, {
          t,
          snapshot,
          now,
          pendingOf,
          onOpen: openItem,
          onAction: runAction,
          onRestore: restoreArchived,
        })
      } else if (tab === 'timeline') {
        content = h(TimelineView, { t, snapshot, now, pendingOf, onOpen: openItem, onAction: runAction })
      } else if (tab === 'sources') {
        content = h(SourcesView, { t, snapshot, notify, onChanged: snapshotRes.reload })
      } else if (tab === 'settings') {
        content = h(SettingsView, { t, snapshot, notify, onChanged: snapshotRes.reload, onAiReview: aiReview })
      } else {
        content = h(TodayView, { t, snapshot, now, pendingOf, onOpen: openItem, onAction: runAction, onNavigate: changeTab })
      }

      const agentItems = items.filter((item) => {
        if (!item) return false
        const agent = asObject(item.agent)
        if (agent.relevant !== true) return false
        const status = asText(item.status)
        if (status !== 'inbox' && status !== 'queued' && status !== 'doing') return false
        return AGENT_CATEGORIES.indexOf(asText(agent.kind)) >= 0
      })
      const mediaCount = items.filter((item) => isMediaActive(item)).length
      const imageCount = items.filter((item) => {
        if (!item || asText(item.kind) !== 'image') return false
        return ['inbox', 'queued', 'doing'].indexOf(asText(item.status)) >= 0
      }).length
      const ideaCount = items.filter((item) => {
        if (!item || asText(item.kind) !== 'idea') return false
        return ['inbox', 'queued', 'doing'].indexOf(asText(item.status)) >= 0
      }).length
      const tabs = [
        { id: 'today', key: 'tabToday', badge: 0 },
        { id: 'images', key: 'tabImages', badge: imageCount },
        { id: 'want', key: 'tabWant', badge: mediaCount },
        { id: 'ideas', key: 'tabIdeas', badge: ideaCount, icon: 'sparkle' },
        { id: 'topics', key: 'tabTopics', badge: 0 },
        { id: 'agent', key: 'tabAgent', badge: agentItems.length, icon: 'sparkle' },
        { id: 'inbox', key: 'tabInbox', badge: numOr(counts.inbox, 0) },
        { id: 'library', key: 'tabLibrary', badge: 0 },
        { id: 'timeline', key: 'tabTimeline', badge: numOr(counts.timeSensitive, 0) },
        { id: 'sources', key: 'tabSources', badge: 0 },
        { id: 'settings', key: 'tabSettings', badge: 0 },
      ]

      return h(
        'div',
        { className: 'wl-root', 'data-desktop': isDesktop ? 'true' : 'false' },
        h('style', null, CSS),
        h(
          'header',
          { className: 'wl-header' },
          h(
            'div',
            { className: 'wl-head-main' },
            h(
              'div',
              { className: 'wl-head-titles' },
              h('h1', { className: 'wl-title' }, tr(t, 'title')),
              h('p', { className: 'wl-subtitle' }, tr(t, 'subtitle')),
            ),
            snapshot
              ? h(
                  'div',
                  { className: 'wl-head-meta' },
                  h('span', { className: 'wl-head-hot' }, hotText),
                  h('span', { className: 'wl-head-stats' }, statsText),
                  aiPendingCount > 0
                    ? h('span', { className: 'wl-head-pending', title: tr(t, 'filterNeedsOrganize') }, ti(t, 'aiPendingLeft', { n: aiPendingCount }))
                    : null,
                  aiRunning
                    ? h(
                        'span',
                        { className: 'wl-ai-progress', title: ti(t, 'aiOrganizeProgress', { processed: aiProcessed, total: aiTotal }) },
                        h('span', { className: 'wl-ai-progress-bar', style: { width: aiPercent + '%' } }),
                      )
                    : null,
                  stampText ? h('span', { className: 'wl-head-stamp' }, stampText) : null,
                )
              : null,
          ),
          h(
            'div',
            { className: 'wl-head-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'wl-btn',
                title: tr(t, 'refresh'),
                disabled: snapshotRes.refreshing,
                onClick: () => snapshotRes.reload(),
              },
              h(Icon, { name: 'refresh', size: 14, className: snapshotRes.refreshing ? 'wl-spin' : '' }),
              h('span', { className: 'wl-btn-label' }, snapshotRes.refreshing ? tr(t, 'refreshing') : tr(t, 'refresh')),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'wl-btn' + (aiRunning ? ' wl-btn-busy' : ''),
                title: aiRunning
                  ? ti(t, 'aiOrganizeProgress', { processed: aiProcessed, total: aiTotal })
                  : tr(t, 'aiOrganizeAll'),
                disabled: Boolean(busy['@ai']) || aiRunning,
                onClick: () => {
                  const promise = aiReview()
                  if (promise && typeof promise.catch === 'function') promise.catch(() => {})
                },
              },
              h(Icon, { name: 'sparkle', size: 14 }),
              h(
                'span',
                { className: 'wl-btn-label' },
                aiRunning
                  ? ti(t, 'aiOrganizeProgress', { processed: aiProcessed, total: aiTotal })
                  : tr(t, 'aiReview'),
              ),
            ),
            h(
              'button',
              { type: 'button', className: 'wl-btn wl-btn-primary', title: tr(t, 'add'), onClick: openAdd },
              h(Icon, { name: 'plus', size: 14 }),
              h('span', { className: 'wl-btn-label' }, tr(t, 'add')),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'wl-icon-btn wl-auth-entry',
                title: tr(t, 'authTitle'),
                'aria-label': tr(t, 'authTitle'),
                onClick: () => setAuthOpen(true),
              },
              h(Icon, { name: 'shield', size: 16 }),
              authMissing ? h('span', { className: 'wl-auth-entry-dot', 'aria-hidden': true }) : null,
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'wl-icon-btn',
                title: tr(t, 'settings'),
                'aria-label': tr(t, 'settings'),
                onClick: () => changeTab('settings'),
              },
              h(Icon, { name: 'settings', size: 16 }),
            ),
          ),
        ),
        h(
          'nav',
          { className: 'wl-tabs', role: 'tablist' },
          tabs.map((entry) =>
            h(
              'button',
              {
                key: entry.id,
                type: 'button',
                role: 'tab',
                className: 'wl-tab',
                'data-active': tab === entry.id ? 'true' : 'false',
                'aria-selected': tab === entry.id ? 'true' : 'false',
                title: tr(t, entry.key),
                onClick: () => changeTab(entry.id),
              },
              entry.icon ? h(Icon, { name: entry.icon, size: 14 }) : null,
              tr(t, entry.key),
              entry.badge > 0 ? h('span', { className: 'wl-tab-badge' }, String(entry.badge)) : null,
            ),
          ),
        ),
        h(
          'div',
          { className: 'wl-scroll' },
          h(
            'div',
            { className: 'wl-content' },
            snapshot && snapshotRes.error
              ? h(ErrorBar, { t, error: snapshotRes.error, onRetry: snapshotRes.retry })
              : null,
            content,
          ),
        ),
        selected
          ? h(ItemDrawer, {
              key: asText(selected.id),
              t,
              item: selected,
              now,
              onClose: () => setDrawerId(null),
              onSave: (patch) => saveItem(selected, patch),
              onAction: runAction,
              onDelete: deleteItem,
              onStart: startItem,
              onUndo: undoAiSort,
              notify,
              onReload: () => snapshotRes.reload(),
              onOpenMember: (id) => {
                const found = items.some((entry) => entry && asText(entry.id) === asText(id))
                if (!found) return false
                setDrawerId(asText(id))
                return true
              },
            })
          : null,
        addOpen
          ? h(AddDialog, {
              t,
              notify,
              onClose: () => setAddOpen(false),
              onAdded: () => snapshotRes.reload(),
            })
          : null,
        authOpen
          ? h(AuthCenterDialog, {
              t,
              accounts,
              notify,
              onReload: () => snapshotRes.reload(),
              onClose: () => setAuthOpen(false),
            })
          : null,
        toast
          ? h(
              'div',
              { className: 'wl-toast', 'data-kind': toast.kind, role: 'status' },
              h(Icon, { name: toast.kind === 'ok' ? 'check' : 'warning', size: 14 }),
              h('span', { className: 'wl-toast-text' }, toast.text),
            )
          : null,
      )
    }

    /* ----------------------------------------------------------- sidebar icon */

    function WatchLaterIcon(props) {
      const size = props && props.size ? props.size : 16
      const active = Boolean(props && props.active)
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
          style: { display: 'block', flexShrink: 0 },
        },
        // 书签：圆角肩 + 深 V 缺口；选中时只给书签本身一层 14% 填充。
        h('path', {
          d: 'M5.3 2.4h5.4a1.5 1.5 0 0 1 1.5 1.5v9.7L8 11.2l-4.2 2.4V3.9a1.5 1.5 0 0 1 1.5-1.5Z',
          fill: active ? 'currentColor' : 'none',
          fillOpacity: active ? 0.14 : 0,
        }),
        // 内部小时钟：比书签线更细一档，16px 下不会和书签边线糊在一起。
        h('circle', { cx: 8, cy: 6.5, r: 2, strokeWidth: 1.2 }),
        h('path', { d: 'M8 5.3v1.3l.95.65', strokeWidth: 1.2 }),
      )
    }

    /* ---------------------------------------------------------------- styles */

    const CSS = `
      .wl-root {
        --wl-base: var(--dsw-alias-bg-base);
        --wl-surface: var(--dsw-alias-bg-layer-1);
        --wl-surface-2: var(--dsw-alias-bg-layer-2);
        --wl-overlay: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-2));
        --wl-line: var(--dsw-alias-border-l1);
        --wl-line-2: var(--dsw-alias-border-l2);
        --wl-text: var(--dsw-alias-label-primary);
        --wl-muted: var(--dsw-alias-label-secondary);
        --wl-brand: var(--dsw-alias-brand-primary);
        --wl-danger: var(--dsw-alias-state-error-primary);
        --wl-ok: var(--dsw-alias-state-success-primary);
        --wl-warn: var(--dsw-alias-state-warn-primary);
        --wl-idle: var(--dsw-alias-state-idle-primary);
        --wl-sidebar: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-layer-2));
        --wl-soft-brand: color-mix(in srgb, var(--wl-brand) 12%, transparent);
        --wl-soft-danger: color-mix(in srgb, var(--wl-danger) 12%, transparent);
        --wl-soft-warn: color-mix(in srgb, var(--wl-warn) 14%, transparent);
        --wl-shadow: 0 6px 18px rgb(0 0 0 / 5%);
        --wl-radius: 12px;
        --wl-num: ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace;
        height: 100%;
        min-height: 0;
        display: flex;
        flex-direction: column;
        color: var(--wl-text);
        background:
          radial-gradient(760px 250px at 5% -12%, color-mix(in srgb, var(--wl-brand) 4%, transparent), transparent 62%),
          var(--wl-base);
        font-size: 13px;
        line-height: 1.5;
        -webkit-font-smoothing: antialiased;
        tab-size: 4;
      }
      .wl-root *, .wl-root *::before, .wl-root *::after { box-sizing: border-box; }
      .wl-root button { font-family: inherit; }
      .wl-root :focus-visible { outline: 2px solid var(--wl-brand); outline-offset: 2px; border-radius: 6px; }
      .wl-root ::-webkit-scrollbar { width: 10px; height: 10px; }
      .wl-root ::-webkit-scrollbar-track { background: transparent; }
      .wl-root ::-webkit-scrollbar-thumb {
        background: color-mix(in srgb, var(--wl-muted) 24%, transparent);
        border: 3px solid transparent; border-radius: 99px; background-clip: content-box;
      }
      .wl-root ::-webkit-scrollbar-thumb:hover { background-color: color-mix(in srgb, var(--wl-muted) 42%, transparent); }
      .wl-icon { flex: none; display: block; }
      .wl-spacer { flex: 1 1 auto; }
      .wl-muted { color: var(--wl-muted); }

      .wl-header { flex: none; display: flex; align-items: flex-start; gap: 10px 18px; flex-wrap: wrap; padding: 18px 24px 0; }
      .wl-root[data-desktop="true"] .wl-header { padding-top: 44px; }
      .wl-head-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1 1 300px; }
      .wl-head-titles { min-width: 0; }
      .wl-title { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: .01em; display: flex; align-items: center; }
      .wl-title::before {
        content: ""; width: 3px; height: 16px; margin-right: 9px; border-radius: 99px;
        background: linear-gradient(180deg, var(--wl-brand), color-mix(in srgb, var(--wl-brand) 32%, transparent));
        flex: none;
      }
      .wl-subtitle { margin: 1px 0 0; color: var(--wl-muted); font-size: 12px; letter-spacing: .01em; }
      .wl-head-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 3px 10px; font-size: 11.5px; color: var(--wl-muted); font-variant-numeric: tabular-nums; }
      .wl-head-hot { color: var(--wl-text); font-weight: 600; }
      .wl-head-hot:empty { display: none; }
      .wl-head-stats { color: var(--wl-muted); }
      .wl-head-stamp { color: var(--wl-muted); opacity: .8; }
      .wl-head-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-left: auto; }

      .wl-btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 5px;
        font: inherit; font-size: 12px; font-weight: 600; line-height: 18px;
        padding: 5px 10px; border-radius: 9px;
        color: var(--wl-text); background: var(--wl-surface); border: 1px solid var(--wl-line);
        cursor: pointer; text-decoration: none;
        transition: border-color .16s ease, color .16s ease, background .16s ease, transform .12s ease;
      }
      .wl-btn:hover:not(:disabled) { border-color: var(--wl-brand); color: var(--wl-brand); background: var(--wl-soft-brand); }
      .wl-btn:active:not(:disabled) { transform: scale(.97); }
      .wl-btn:disabled { opacity: .5; cursor: default; }
      .wl-btn-sm { padding: 3px 8px; font-size: 11.5px; border-radius: 8px; }
      .wl-btn-block { width: 100%; }
      .wl-btn-primary { color: var(--wl-base); background: var(--wl-brand); border-color: var(--wl-brand); }
      .wl-btn-primary:hover:not(:disabled) {
        color: var(--wl-base); border-color: var(--wl-brand);
        background: color-mix(in srgb, var(--wl-brand) 88%, var(--wl-base));
      }
      .wl-btn-danger { color: var(--wl-base); background: var(--wl-danger); border-color: var(--wl-danger); }
      .wl-btn-danger:hover:not(:disabled) {
        color: var(--wl-base); border-color: var(--wl-danger);
        background: color-mix(in srgb, var(--wl-danger) 86%, var(--wl-base));
      }
      .wl-btn-danger-ghost { color: var(--wl-danger); background: transparent; border-color: color-mix(in srgb, var(--wl-danger) 38%, var(--wl-line)); }
      .wl-btn-danger-ghost:hover:not(:disabled) { color: var(--wl-danger); background: var(--wl-soft-danger); border-color: var(--wl-danger); }
      .wl-btn-label { white-space: nowrap; }
      .wl-btn-accent {
        color: var(--wl-brand); background: var(--wl-soft-brand);
        border-color: color-mix(in srgb, var(--wl-brand) 40%, var(--wl-line));
      }
      .wl-btn-accent:hover:not(:disabled) {
        color: var(--wl-brand); border-color: var(--wl-brand);
        background: color-mix(in srgb, var(--wl-brand) 18%, transparent);
      }
      .wl-icon-btn {
        display: inline-flex; align-items: center; justify-content: center;
        width: 28px; height: 28px; padding: 0; border-radius: 9px;
        color: var(--wl-muted); background: transparent; border: 1px solid transparent;
        cursor: pointer; transition: color .16s ease, background .16s ease, border-color .16s ease;
      }
      .wl-icon-btn:hover:not(:disabled) { color: var(--wl-text); background: var(--wl-surface); border-color: var(--wl-line); }
      .wl-icon-btn:disabled { opacity: .5; cursor: default; }
      .wl-icon-btn-sm { width: 24px; height: 24px; border-radius: 8px; }
      .wl-icon-btn[data-active="true"] {
        color: var(--wl-brand); background: var(--wl-soft-brand);
        border-color: color-mix(in srgb, var(--wl-brand) 30%, transparent);
      }
      .wl-link-btn {
        font: inherit; font-size: 11.5px; font-weight: 600; color: var(--wl-brand);
        background: none; border: 0; padding: 0; cursor: pointer;
      }
      .wl-link-btn:hover { text-decoration: underline; text-underline-offset: 2px; }

      .wl-tabs {
        flex: none; display: flex; gap: 2px; padding: 12px 24px 0;
        border-bottom: 1px solid var(--wl-line);
        overflow-x: auto; scrollbar-width: none;
      }
      .wl-tabs::-webkit-scrollbar { display: none; }
      .wl-tab {
        position: relative; flex: none; font: inherit; font-size: 13px;
        padding: 6px 11px 10px; color: var(--wl-muted);
        background: none; border: 0; display: inline-flex; align-items: center; gap: 5px;
        cursor: pointer; white-space: nowrap; transition: color .16s ease;
      }
      .wl-tab:hover { color: var(--wl-text); }
      .wl-tab[data-active="true"] { color: var(--wl-text); font-weight: 600; }
      .wl-tab[data-active="true"]::after {
        content: ""; position: absolute; left: 8px; right: 8px; bottom: -1px; height: 2px;
        border-radius: 2px 2px 0 0;
        background: linear-gradient(90deg, var(--wl-brand), color-mix(in srgb, var(--wl-brand) 30%, transparent));
      }
      .wl-tab-badge {
        min-width: 16px; height: 16px; padding: 0 5px; border-radius: 99px;
        font-size: 10px; line-height: 16px; text-align: center; font-weight: 700;
        color: var(--wl-muted); background: var(--wl-surface-2); font-variant-numeric: tabular-nums;
      }

      .wl-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 18px 24px 34px; }
      .wl-content { max-width: 1080px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }
      .wl-intro { margin: 0; color: var(--wl-muted); font-size: 12px; line-height: 1.6; }

      .wl-section { display: flex; flex-direction: column; gap: 10px; }
      .wl-section-head { display: flex; align-items: baseline; gap: 8px; }
      .wl-section-title { margin: 0; font-size: 12.5px; font-weight: 600; letter-spacing: .03em; }
      .wl-section-count { color: var(--wl-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
      .wl-section-head .wl-link-btn { margin-left: auto; }
      .wl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(248px, 1fr)); gap: 14px; }
      .wl-hero-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(196px, 1fr)); gap: 14px; }

      .wl-card {
        position: relative; display: flex; flex-direction: column; min-width: 0;
        text-align: left; background: var(--wl-surface);
        border: 1px solid var(--wl-line); border-radius: var(--wl-radius);
        overflow: hidden; cursor: pointer;
        transition: border-color .16s ease, background .16s ease, box-shadow .16s ease, transform .16s ease;
      }
      .wl-card:hover {
        border-color: var(--wl-line-2); box-shadow: var(--wl-shadow);
        background: color-mix(in srgb, var(--wl-surface) 82%, var(--wl-surface-2));
        transform: translateY(-1px);
      }
      .wl-cover { position: relative; flex: none; aspect-ratio: 16 / 10; background: var(--wl-surface-2); overflow: hidden; }
      .wl-cover-img { display: block; width: 100%; height: 100%; object-fit: cover; }
      .wl-cover-fallback {
        position: relative; overflow: hidden;
        background:
          radial-gradient(120% 95% at 84% 8%, color-mix(in srgb, var(--wl-kind-accent, var(--wl-muted)) 22%, transparent), transparent 64%),
          linear-gradient(135deg, var(--wl-kind-a, var(--wl-surface-2)), var(--wl-kind-b, var(--wl-surface)));
        color: var(--wl-muted);
      }
      .wl-cover-fallback::before {
        content: ""; position: absolute; inset: 0;
        background: repeating-linear-gradient(
          115deg,
          color-mix(in srgb, var(--wl-kind-accent, var(--wl-muted)) 6%, transparent) 0 1px,
          transparent 1px 14px
        );
        opacity: .85;
      }
      .wl-cover-glyph {
        position: absolute; right: 7%; top: 50%; transform: translateY(-56%);
        line-height: 0; color: var(--wl-kind-accent, var(--wl-muted)); opacity: .18;
      }
      .wl-cover-foot {
        position: absolute; left: 10px; right: 10px; bottom: 8px;
        display: flex; align-items: center; gap: 7px; min-width: 0;
      }
      .wl-cover-mark {
        flex: none; min-width: 24px; height: 24px; padding: 0 6px;
        display: inline-flex; align-items: center; justify-content: center;
        border-radius: 8px; font-size: 11px; font-weight: 700; letter-spacing: .01em;
        color: var(--wl-text);
        background: color-mix(in srgb, var(--wl-surface) 78%, transparent);
        border: 1px solid color-mix(in srgb, var(--wl-line-2) 65%, transparent);
      }
      .wl-cover-caption { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
      .wl-cover-site {
        font-size: 10.5px; font-weight: 600; letter-spacing: .03em; color: var(--wl-text);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .wl-cover-kicker { font-size: 9.5px; letter-spacing: .06em; color: var(--wl-muted); }
      .wl-cover-empty-tag {
        position: absolute; top: 8px; left: 8px; z-index: 1;
        padding: 1px 8px; border-radius: 99px; font-size: 10px; font-weight: 600;
        color: var(--wl-muted);
        background: color-mix(in srgb, var(--wl-surface) 82%, transparent);
        border: 1px solid var(--wl-line);
      }
      .wl-cover-fallback-empty {
        --wl-kind-accent: var(--wl-muted);
        background: linear-gradient(135deg, var(--wl-surface-2), color-mix(in srgb, var(--wl-muted) 8%, var(--wl-surface)));
      }
      .wl-cover-fallback-empty .wl-cover-glyph { opacity: .13; }
      .wl-cover-fallback[data-kind="xhs"], .wl-cover-fallback[data-kind="drama"] {
        --wl-kind-accent: var(--wl-danger);
        --wl-kind-a: color-mix(in srgb, var(--wl-danger) 14%, var(--wl-surface-2));
        --wl-kind-b: color-mix(in srgb, var(--wl-danger) 5%, var(--wl-surface));
      }
      .wl-cover-fallback[data-kind="wechat"] {
        --wl-kind-accent: var(--wl-ok);
        --wl-kind-a: color-mix(in srgb, var(--wl-ok) 14%, var(--wl-surface-2));
        --wl-kind-b: color-mix(in srgb, var(--wl-ok) 5%, var(--wl-surface));
      }
      .wl-cover-fallback[data-kind="bilibili"],
      .wl-cover-fallback[data-kind="link"],
      .wl-cover-fallback[data-kind="article"] {
        --wl-kind-accent: var(--wl-brand);
        --wl-kind-a: color-mix(in srgb, var(--wl-brand) 13%, var(--wl-surface-2));
        --wl-kind-b: color-mix(in srgb, var(--wl-brand) 4%, var(--wl-surface));
      }
      .wl-cover-fallback[data-kind="product"] {
        --wl-kind-accent: var(--wl-warn);
        --wl-kind-a: color-mix(in srgb, var(--wl-warn) 14%, var(--wl-surface-2));
        --wl-kind-b: color-mix(in srgb, var(--wl-warn) 5%, var(--wl-surface));
      }
      .wl-cover-fallback[data-kind="douyin"],
      .wl-cover-fallback[data-kind="video"] {
        --wl-kind-accent: var(--wl-idle);
        --wl-kind-a: color-mix(in srgb, var(--wl-idle) 16%, var(--wl-surface-2));
        --wl-kind-b: color-mix(in srgb, var(--wl-idle) 6%, var(--wl-surface));
      }
      .wl-cover-fallback[data-kind="image"],
      .wl-cover-fallback[data-kind="other"] { --wl-kind-accent: var(--wl-muted); }
      .wl-card-hero .wl-cover { aspect-ratio: 2.2 / 1; }
      .wl-card-hero .wl-cover-glyph { right: 6%; opacity: .2; }
      .wl-card-body { display: flex; flex-direction: column; gap: 6px; padding: 11px 13px 12px; min-width: 0; }
      .wl-card-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
      .wl-kind-chip {
        display: inline-flex; align-items: center; font-size: 10.5px; font-weight: 600;
        letter-spacing: .04em; padding: 1px 6px; border-radius: 99px;
        color: var(--wl-muted); background: var(--wl-surface-2); white-space: nowrap;
      }
      .wl-score {
        display: inline-flex; align-items: center; justify-content: center;
        min-width: 26px; height: 20px; padding: 0 6px; border-radius: 7px;
        font-family: var(--wl-num); font-size: 11px; font-weight: 700;
        letter-spacing: -.02em; font-variant-numeric: tabular-nums;
      }
      .wl-score[data-tone="high"] { color: var(--wl-base); background: var(--wl-brand); }
      .wl-score[data-tone="mid"] {
        color: var(--wl-brand); background: transparent;
        border: 1px solid color-mix(in srgb, var(--wl-brand) 55%, transparent);
      }
      .wl-score[data-tone="weak"] { color: var(--wl-muted); background: var(--wl-surface-2); }
      .wl-card-title {
        margin: 0; font-size: 13.5px; font-weight: 600; line-height: 1.45;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
        overflow: hidden; overflow-wrap: anywhere;
      }
      .wl-card-hero .wl-card-title { font-size: 14.5px; }
      .wl-card-meta { color: var(--wl-muted); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .wl-card-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 1px; }
      .wl-card-signals { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
      .wl-card-actions {
        position: absolute; top: 8px; right: 8px; display: flex; gap: 4px;
        opacity: 0; pointer-events: none; transition: opacity .14s ease;
      }
      .wl-card:hover .wl-card-actions, .wl-card:focus-within .wl-card-actions { opacity: 1; pointer-events: auto; }
      .wl-card-act {
        display: inline-flex; align-items: center; justify-content: center;
        width: 26px; height: 26px; padding: 0; border-radius: 8px;
        color: var(--wl-text); background: var(--wl-surface); border: 1px solid var(--wl-line);
        cursor: pointer; transition: color .14s ease, border-color .14s ease, background .14s ease;
      }
      .wl-card-act:hover:not(:disabled) { color: var(--wl-brand); border-color: var(--wl-brand); background: var(--wl-soft-brand); }
      .wl-card-act:disabled { opacity: .5; cursor: default; }

      .wl-dots { display: inline-flex; align-items: center; gap: 4px; min-width: 0; }
      .wl-dots-label { font-size: 10px; color: var(--wl-muted); letter-spacing: .04em; white-space: nowrap; }
      .wl-dots-track { display: inline-flex; align-items: center; gap: 2px; }
      .wl-dot { display: block; width: 5px; height: 5px; border-radius: 99px; background: var(--wl-surface-2); border: 1px solid var(--wl-line); }
      .wl-dot[data-on="true"] { border-color: transparent; }
      .wl-dots-track[data-tone="brand"] .wl-dot[data-on="true"] { background: var(--wl-brand); }
      .wl-dots-track[data-tone="warn"] .wl-dot[data-on="true"] { background: var(--wl-warn); }
      .wl-dots-input { display: flex; flex-direction: column; gap: 4px; }
      .wl-dots-input .wl-dots-track { gap: 1px; }
      .wl-dot-btn {
        display: inline-flex; align-items: center; justify-content: center;
        width: 18px; height: 18px; padding: 0; border: 0; border-radius: 6px;
        background: none; cursor: pointer;
      }
      .wl-dot-btn:hover:not(:disabled) { background: var(--wl-surface-2); }
      .wl-dot-btn:disabled { cursor: default; opacity: .55; }
      .wl-dot-btn .wl-dot { width: 7px; height: 7px; }

      .wl-deadline {
        display: inline-flex; align-items: center; gap: 3px; margin-left: auto;
        font-size: 10.5px; font-weight: 600; font-variant-numeric: tabular-nums;
        white-space: nowrap; padding: 1px 6px; border-radius: 99px;
        color: var(--wl-muted); background: var(--wl-surface-2);
      }
      .wl-deadline[data-tone="critical"] { color: var(--wl-danger); background: var(--wl-soft-danger); }
      .wl-deadline[data-tone="soon"] { color: var(--wl-warn); background: var(--wl-soft-warn); }
      .wl-deadline[data-tone="expired"] { color: var(--wl-danger); background: transparent; text-decoration: line-through; opacity: .72; }
      .wl-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 1px; max-height: 20px; overflow: hidden; }
      .wl-tag {
        font-size: 10px; color: var(--wl-muted); background: var(--wl-surface-2);
        border-radius: 6px; padding: 0 5px; line-height: 16px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px;
      }

      .wl-grid-list { grid-template-columns: minmax(0, 1fr); }
      .wl-grid-list .wl-card { flex-direction: row; align-items: stretch; }
      .wl-grid-list .wl-card > .wl-cover { width: 108px; min-height: 78px; aspect-ratio: auto; }
      .wl-grid-list .wl-card-body { flex: 1 1 auto; justify-content: center; }
      .wl-grid-list .wl-cover-foot { display: none; }
      .wl-grid-list .wl-cover-empty-tag { display: none; }
      .wl-grid-list .wl-cover-glyph { right: 12%; opacity: .2; }
      .wl-grid-list .wl-card-actions { top: 50%; transform: translateY(-50%); }
      .wl-card-dense .wl-tags { display: none; }
      .wl-card-dense .wl-card-foot { margin-top: 0; }

      .wl-banner {
        display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
        padding: 8px 12px; border-radius: 10px;
        background: var(--wl-soft-warn);
        border: 1px solid color-mix(in srgb, var(--wl-warn) 26%, transparent);
      }
      .wl-banner-lead { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 700; letter-spacing: .04em; color: var(--wl-warn); flex: none; }
      .wl-banner-list { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; min-width: 0; }
      .wl-banner-item {
        display: inline-flex; align-items: baseline; gap: 5px; max-width: 320px; min-width: 0;
        font: inherit; font-size: 11.5px; padding: 2px 8px; border-radius: 7px; cursor: pointer;
        color: var(--wl-text); background: var(--wl-base); border: 1px solid var(--wl-line);
      }
      .wl-banner-item:hover { border-color: var(--wl-warn); }
      .wl-banner-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 190px; }
      .wl-banner-time { font-size: 10.5px; font-weight: 600; color: var(--wl-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
      .wl-banner-time[data-tone="critical"], .wl-banner-time[data-tone="expired"] { color: var(--wl-danger); }
      .wl-banner-time[data-tone="soon"] { color: var(--wl-warn); }
      .wl-banner .wl-link-btn { margin-left: auto; }

      .wl-notice {
        display: flex; align-items: flex-start; gap: 8px;
        padding: 9px 12px; border-radius: 10px;
        border: 1px solid var(--wl-line); background: var(--wl-surface);
        color: var(--wl-muted); font-size: 11.5px; line-height: 1.6;
      }
      .wl-notice .wl-icon { margin-top: 1px; }
      .wl-notice-text { min-width: 0; }
      .wl-notice-extra { display: block; color: var(--wl-text); margin-top: 1px; }

      .wl-inbox-filters { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
      .wl-inbox-filter-empty {
        padding: 22px 16px; text-align: center;
        color: var(--wl-muted); font-size: 12px;
        border: 1px dashed var(--wl-line); border-radius: var(--wl-radius);
        background: color-mix(in srgb, var(--wl-surface) 60%, transparent);
      }
      .wl-chip:disabled { opacity: .5; cursor: default; }
      .wl-inbox-list { display: flex; flex-direction: column; gap: 8px; }
      .wl-inbox {
        display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px;
        border-radius: var(--wl-radius); background: var(--wl-surface);
        border: 1px solid var(--wl-line); cursor: pointer;
        transition: border-color .16s ease, background .16s ease;
      }
      .wl-inbox:hover { border-color: var(--wl-line-2); background: color-mix(in srgb, var(--wl-surface) 82%, var(--wl-surface-2)); }
      .wl-inbox-thumb { flex: none; width: 44px; height: 44px; border-radius: 9px; overflow: hidden; border: 1px solid var(--wl-line); background: var(--wl-surface-2); }
      .wl-inbox-thumb .wl-cover { width: 100%; height: 100%; aspect-ratio: auto; }
      .wl-inbox-thumb .wl-cover-foot { display: none; }
      .wl-inbox-thumb .wl-cover-empty-tag { display: none; }
      .wl-inbox-thumb .wl-cover-glyph { right: 50%; top: 50%; transform: translate(50%, -50%); opacity: .32; }
      .wl-inbox-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
      .wl-inbox-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .wl-inbox-title { margin: 0; font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1 1 auto; }
      .wl-inbox-meta { color: var(--wl-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
      .wl-inbox-controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .wl-inbox-actions { display: flex; align-items: center; gap: 4px; flex: none; }

      .wl-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .wl-search {
        display: flex; align-items: center; gap: 6px; flex: 1 1 240px; min-width: 0;
        padding: 0 10px; height: 30px; border-radius: 9px;
        background: var(--wl-base); border: 1px solid var(--wl-line); color: var(--wl-muted);
        transition: border-color .16s ease, box-shadow .16s ease;
      }
      .wl-search:focus-within { border-color: var(--wl-brand); box-shadow: 0 0 0 3px var(--wl-soft-brand); }
      .wl-search-input {
        flex: 1 1 auto; min-width: 0; font: inherit; font-size: 12px;
        color: var(--wl-text); background: transparent; border: 0; outline: none; padding: 0;
      }
      .wl-search-input::placeholder { color: var(--wl-muted); }
      .wl-search-input::-webkit-search-cancel-button { display: none; }
      .wl-toolbar-right { display: flex; align-items: center; gap: 6px; }
      .wl-density { display: inline-flex; align-items: center; gap: 1px; padding: 1px; border-radius: 9px; border: 1px solid var(--wl-line); }
      .wl-density .wl-icon-btn { width: 26px; height: 24px; }
      .wl-filter-row { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
      .wl-chip {
        display: inline-flex; align-items: center; gap: 5px;
        font: inherit; font-size: 11.5px; line-height: 18px; padding: 2px 8px;
        border-radius: 99px; cursor: pointer; color: var(--wl-muted);
        background: transparent; border: 1px solid var(--wl-line);
        transition: color .14s ease, border-color .14s ease, background .14s ease;
      }
      .wl-chip:hover { color: var(--wl-text); border-color: var(--wl-line-2); }
      .wl-chip[data-active="true"] {
        color: var(--wl-brand); border-color: color-mix(in srgb, var(--wl-brand) 42%, transparent);
        background: var(--wl-soft-brand);
      }
      .wl-chip-quiet { border-color: transparent; }
      .wl-chip-quiet[data-active="true"] { color: var(--wl-text); border-color: var(--wl-line); background: var(--wl-surface-2); }
      .wl-chip-count { font-family: var(--wl-num); font-size: 10px; color: var(--wl-muted); font-variant-numeric: tabular-nums; }
      .wl-chip[data-active="true"] .wl-chip-count { color: var(--wl-brand); }

      .wl-archive { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
      .wl-archive-toggle {
        display: inline-flex; align-items: center; gap: 6px; align-self: flex-start;
        font: inherit; font-size: 11.5px; font-weight: 600; color: var(--wl-muted);
        background: none; border: 0; padding: 2px 0; cursor: pointer;
      }
      .wl-archive-toggle:hover { color: var(--wl-text); }
      .wl-archive-body {
        display: flex; flex-direction: column; gap: 6px;
        padding: 10px 12px; border: 1px solid var(--wl-line); border-radius: 10px; background: var(--wl-surface);
      }
      .wl-archive-list { display: flex; flex-direction: column; }
      .wl-archive-row {
        display: flex; align-items: center; gap: 8px; padding: 6px 0; min-width: 0; font-size: 12px;
        border-bottom: 1px solid color-mix(in srgb, var(--wl-line) 55%, transparent);
      }
      .wl-archive-row:last-child { border-bottom: 0; }
      .wl-archive-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wl-archive-meta { color: var(--wl-muted); font-size: 11px; white-space: nowrap; }

      .wl-timeline { border: 1px solid var(--wl-line); border-radius: var(--wl-radius); background: var(--wl-surface); overflow: hidden; }
      .wl-tl-row { display: flex; align-items: center; gap: 10px; padding: 9px 12px; cursor: pointer; transition: background .14s ease; }
      .wl-tl-row + .wl-tl-row { border-top: 1px solid color-mix(in srgb, var(--wl-line) 55%, transparent); }
      .wl-tl-row:hover { background: color-mix(in srgb, var(--wl-surface) 78%, var(--wl-surface-2)); }
      .wl-tl-dot { flex: none; width: 6px; height: 6px; border-radius: 99px; background: var(--wl-muted); }
      .wl-tl-dot[data-tone="critical"], .wl-tl-dot[data-tone="expired"] { background: var(--wl-danger); }
      .wl-tl-dot[data-tone="soon"] { background: var(--wl-warn); }
      .wl-tl-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      .wl-tl-head { display: flex; align-items: center; gap: 7px; min-width: 0; }
      .wl-tl-title { margin: 0; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
      .wl-tl-meta { color: var(--wl-muted); font-size: 11px; font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wl-tl-side { display: flex; align-items: center; gap: 8px; flex: none; }
      .wl-tl-time { font-size: 11.5px; font-weight: 600; color: var(--wl-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
      .wl-tl-time[data-tone="critical"] { color: var(--wl-danger); }
      .wl-tl-time[data-tone="soon"] { color: var(--wl-warn); }
      .wl-tl-time[data-tone="expired"] { color: var(--wl-danger); opacity: .75; text-decoration: line-through; }
      .wl-tl-side .wl-card-act { width: 24px; height: 24px; }

      .wl-sources { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; align-items: start; }
      .wl-source {
        display: flex; flex-direction: column; gap: 10px; min-width: 0;
        padding: 14px 16px; border-radius: var(--wl-radius);
        background: var(--wl-surface); border: 1px solid var(--wl-line);
      }
      .wl-source-head { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
      .wl-source-title { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: .01em; }
      .wl-status-dot { width: 6px; height: 6px; border-radius: 99px; background: var(--wl-muted); }
      .wl-status-dot[data-state="ok"] { background: var(--wl-ok); }
      .wl-status-dot[data-state="error"] { background: var(--wl-danger); }
      .wl-status-dot[data-state="idle"] { background: var(--wl-brand); }
      .wl-source-state { font-size: 10.5px; font-weight: 600; letter-spacing: .05em; color: var(--wl-muted); }
      .wl-source-state[data-state="ok"] { color: var(--wl-ok); }
      .wl-source-state[data-state="error"] { color: var(--wl-danger); }
      .wl-source-state[data-state="idle"] { color: var(--wl-brand); }
      .wl-source-rows { display: flex; flex-direction: column; gap: 3px; }
      .wl-kv { display: flex; align-items: baseline; gap: 8px; font-size: 11.5px; min-width: 0; }
      .wl-kv-k { flex: none; color: var(--wl-muted); }
      .wl-kv-v { color: var(--wl-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
      .wl-kv-path { font-family: var(--wl-num); font-size: 10.5px; }
      .wl-source-hint { margin: 0; color: var(--wl-muted); font-size: 11.5px; }
      .wl-source-note {
        margin: 0; color: var(--wl-muted); font-size: 11px; line-height: 1.55;
        padding: 7px 9px; border-radius: 8px; background: var(--wl-surface-2);
      }
      .wl-cookie-form {
        display: flex; flex-direction: column; gap: 8px;
        padding: 10px; border-radius: 9px; background: var(--wl-base); border: 1px solid var(--wl-line);
      }
      .wl-share { display: flex; align-items: flex-end; gap: 8px; }
      .wl-login-dialog { width: min(420px, 94vw); }
      .wl-dialog-body.wl-login-body { align-items: center; text-align: center; gap: 12px; padding: 16px 16px 10px; }
      .wl-login-qr {
        width: 200px; height: 200px; flex: none; display: flex; align-items: center; justify-content: center;
        padding: 8px; border-radius: 12px; border: 1px solid var(--wl-line); background: var(--wl-base);
      }
      .wl-login-qr-img { display: block; width: 100%; height: 100%; object-fit: contain; border-radius: 6px; }
      .wl-login-qr-empty { color: var(--wl-muted); font-size: 11.5px; }
      .wl-login-chrome-icon {
        width: 46px; height: 46px; flex: none; display: flex; align-items: center; justify-content: center;
        border-radius: 13px; color: var(--wl-brand); background: var(--wl-soft-brand);
        border: 1px solid color-mix(in srgb, var(--wl-brand) 24%, transparent);
      }
      .wl-login-hint { margin: 0; max-width: 340px; color: var(--wl-muted); font-size: 11.5px; line-height: 1.65; }
      .wl-login-status {
        display: inline-flex; align-items: center; justify-content: center; gap: 6px;
        font-size: 12px; font-weight: 600; color: var(--wl-muted);
      }
      .wl-login-dot { width: 6px; height: 6px; border-radius: 99px; background: currentColor; animation: wl-pulse 1.4s ease-in-out infinite; }
      .wl-login-status[data-tone="ok"] { color: var(--wl-ok); }
      .wl-login-status[data-tone="warn"] { color: var(--wl-warn); }
      .wl-login-status[data-tone="danger"] { color: var(--wl-danger); }
      .wl-login-status[data-tone="waiting"] { color: var(--wl-brand); }
      .wl-login-foot { justify-content: flex-end; }
      .wl-cluster-badge {
        display: inline-flex; align-items: center; padding: 0 6px; border-radius: 99px;
        font-size: 10.5px; font-weight: 600; white-space: nowrap;
        color: var(--wl-brand); background: var(--wl-soft-brand);
        border: 1px solid color-mix(in srgb, var(--wl-brand) 26%, transparent);
      }
      .wl-preview { gap: 8px; }
      .wl-preview-head { display: flex; align-items: center; gap: 8px; }
      .wl-preview-head .wl-drawer-label { display: inline-flex; align-items: center; gap: 4px; }
      .wl-preview-body { display: flex; flex-direction: column; gap: 10px; }
      .wl-preview-empty { margin: 0; padding: 10px 0; color: var(--wl-muted); font-size: 12px; text-align: center; }
      .wl-preview-image-btn {
        display: block; width: 100%; padding: 0; cursor: zoom-in;
        border: 1px solid var(--wl-line); border-radius: 10px; overflow: hidden; background: var(--wl-surface-2);
      }
      .wl-preview-image { display: block; width: 100%; max-height: 52vh; object-fit: contain; }
      .wl-preview-video {
        position: relative; width: 100%; aspect-ratio: 16 / 9;
        border: 1px solid var(--wl-line); border-radius: 10px; overflow: hidden; background: var(--wl-surface-2);
      }
      .wl-preview-video iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
      .wl-preview-text {
        max-height: 42vh; overflow: auto; margin: 0; padding: 12px 14px;
        white-space: pre-wrap; overflow-wrap: anywhere;
        font-size: 12.5px; line-height: 1.78; letter-spacing: .01em;
        color: var(--wl-text); background: var(--wl-base);
        border: 1px solid var(--wl-line); border-radius: 10px;
        user-select: text;
      }
      .wl-preview-hint { font-size: 10.5px; color: var(--wl-muted); margin-top: -2px; }
      .wl-preview-desc {
        margin: 0; font-size: 11.5px; line-height: 1.6; color: var(--wl-muted);
        max-height: 120px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.68;
      }
      .wl-preview-thumbs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
      .wl-preview-thumb {
        width: 100%; aspect-ratio: 1 / 1; padding: 0; cursor: zoom-in; overflow: hidden;
        border: 1px solid var(--wl-line); border-radius: 9px; background: var(--wl-surface-2);
      }
      .wl-preview-thumb img { display: block; width: 100%; height: 100%; object-fit: cover; }
      .wl-preview-foot { display: flex; align-items: center; justify-content: flex-end; gap: 6px; flex-wrap: wrap; }
      .wl-cluster { gap: 6px; }
      .wl-cluster-list { display: flex; flex-direction: column; gap: 4px; }
      .wl-cluster-member {
        display: flex; align-items: center; gap: 6px; width: 100%; text-align: left;
        padding: 6px 8px; border-radius: 8px; cursor: pointer;
        font: inherit; font-size: 12px; color: var(--wl-text);
        background: var(--wl-base); border: 1px solid var(--wl-line);
      }
      .wl-cluster-member:hover:not(:disabled) { border-color: var(--wl-brand); background: var(--wl-soft-brand); }
      .wl-cluster-member[data-current="true"] { cursor: default; border-style: dashed; color: var(--wl-muted); background: var(--wl-surface-2); }
      .wl-cluster-member-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wl-cluster-member-tag { flex: none; font-size: 10px; color: var(--wl-brand); }
      .wl-cluster-summary {
        padding: 8px 10px; border-radius: 8px; font-size: 12px; line-height: 1.7;
        white-space: pre-wrap; overflow-wrap: anywhere;
        background: var(--wl-soft-brand);
        border: 1px solid color-mix(in srgb, var(--wl-brand) 22%, transparent);
      }
      .wl-cluster-summary-text { margin: 2px 0 0; }
      .wl-cluster-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .wl-auth-entry { position: relative; }
      .wl-auth-entry-dot {
        position: absolute; top: 4px; right: 4px; width: 6px; height: 6px;
        border-radius: 99px; background: var(--wl-warn); border: 1px solid var(--wl-surface);
      }
      .wl-auth-dialog { width: min(460px, 94vw); }
      .wl-auth-dialog .wl-dialog-title { display: inline-flex; align-items: center; gap: 6px; }
      .wl-auth-body { gap: 2px; padding: 8px 16px; }
      .wl-auth-row { display: flex; align-items: center; gap: 10px; padding: 10px 0; }
      .wl-auth-row + .wl-auth-row { border-top: 1px solid color-mix(in srgb, var(--wl-line) 55%, transparent); }
      .wl-auth-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
      .wl-auth-line { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; min-width: 0; }
      .wl-auth-label { font-size: 13px; font-weight: 600; }
      .wl-auth-status { font-size: 10.5px; font-weight: 600; color: var(--wl-muted); }
      .wl-auth-status[data-state="ok"] { color: var(--wl-ok); }
      .wl-auth-account {
        font-size: 11px; color: var(--wl-muted); max-width: 180px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .wl-auth-error { display: flex; align-items: flex-start; gap: 5px; font-size: 11px; color: var(--wl-danger); }
      .wl-auth-actions { flex: none; display: flex; align-items: center; gap: 5px; }
      .wl-auth-note {
        flex: none; display: flex; align-items: flex-start; gap: 6px;
        padding: 10px 16px 12px; border-top: 1px solid var(--wl-line);
        font-size: 11px; color: var(--wl-muted); line-height: 1.55;
      }
      .wl-auth-note .wl-icon { margin-top: 1px; }
      .wl-agent-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .wl-agent-list { display: flex; flex-direction: column; gap: 8px; }
      .wl-agent-row {
        display: flex; align-items: center; gap: 12px; padding: 11px 12px;
        background: var(--wl-surface); border: 1px solid var(--wl-line);
        border-radius: var(--wl-radius); transition: border-color .16s ease, background .16s ease;
      }
      .wl-agent-row:hover { border-color: var(--wl-line-2); background: color-mix(in srgb, var(--wl-surface) 84%, var(--wl-surface-2)); }
      .wl-agent-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
      .wl-agent-head { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
      .wl-agent-kind {
        flex: none; font-size: 10.5px; font-weight: 600; padding: 1px 6px; border-radius: 99px;
        color: var(--wl-brand); background: var(--wl-soft-brand);
        border: 1px solid color-mix(in srgb, var(--wl-brand) 26%, transparent);
      }
      .wl-agent-purpose {
        font-size: 11.5px; line-height: 1.5; color: var(--wl-muted);
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
        overflow: hidden; overflow-wrap: anywhere;
      }
      .wl-agent-title {
        flex: 1 1 auto; min-width: 0; text-align: left; padding: 0;
        font: inherit; font-size: 13px; font-weight: 600; color: var(--wl-text);
        background: none; border: 0; cursor: pointer;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .wl-agent-title:hover { color: var(--wl-brand); }
      .wl-agent-status {
        flex: none; font-size: 10.5px; font-weight: 600; padding: 1px 6px; border-radius: 99px;
        color: var(--wl-muted); background: var(--wl-surface-2);
      }
      .wl-agent-status[data-status="new"] { color: var(--wl-warn); background: var(--wl-soft-warn); }
      .wl-agent-status[data-status="opened"] { color: var(--wl-ok); background: color-mix(in srgb, var(--wl-ok) 12%, transparent); }
      .wl-agent-meta {
        font-size: 11px; color: var(--wl-muted); font-variant-numeric: tabular-nums;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .wl-agent-actions { flex: none; display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
      .wl-images-toolbar { display: flex; flex-direction: column; gap: 8px; }
      .wl-images-stats { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 11.5px; color: var(--wl-muted); font-variant-numeric: tabular-nums; }
      .wl-images-stat { white-space: nowrap; }
      .wl-media-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .wl-media-total { font-size: 11.5px; color: var(--wl-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
      .wl-media-section { display: flex; flex-direction: column; gap: 10px; margin-top: 14px; }
      .wl-media-section-title { margin: 0; font-size: 13px; font-weight: 600; color: var(--wl-text); }
      .wl-media-section-empty { margin: 0; padding: 6px 0; color: var(--wl-muted); font-size: 11.5px; }
      .wl-media-guide-list { display: flex; flex-direction: column; gap: 8px; }
      .wl-media-row {
        display: flex; align-items: center; gap: 10px; padding: 9px 11px;
        background: var(--wl-surface); border: 1px solid var(--wl-line);
        border-radius: var(--wl-radius);
        transition: border-color .16s ease, background .16s ease;
      }
      .wl-media-row:hover { border-color: var(--wl-line-2); background: color-mix(in srgb, var(--wl-surface) 84%, var(--wl-surface-2)); }
      .wl-media-thumb {
        flex: none; width: 56px; height: 44px; border-radius: 9px; overflow: hidden;
        border: 1px solid var(--wl-line); background: var(--wl-surface-2);
      }
      .wl-media-thumb .wl-cover { width: 100%; height: 100%; aspect-ratio: auto; }
      .wl-media-thumb .wl-cover-foot, .wl-media-thumb .wl-cover-empty-tag { display: none; }
      .wl-media-thumb .wl-cover-glyph { right: 50%; top: 50%; transform: translate(50%, -50%); opacity: .32; }
      .wl-media-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
      .wl-media-line { display: flex; align-items: center; gap: 7px; min-width: 0; }
      .wl-media-title {
        flex: 1 1 auto; min-width: 0; text-align: left; padding: 0;
        font: inherit; font-size: 13px; font-weight: 600; color: var(--wl-text);
        background: none; border: 0; cursor: pointer;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .wl-media-title:hover { color: var(--wl-brand); }
      .wl-media-badge {
        flex: none; font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 99px;
        color: var(--wl-brand); background: var(--wl-soft-brand);
        border: 1px solid color-mix(in srgb, var(--wl-brand) 26%, transparent);
      }
      .wl-media-meta {
        font-size: 11px; color: var(--wl-muted); font-variant-numeric: tabular-nums;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .wl-media-wall { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; }
      .wl-media-card {
        display: flex; flex-direction: column; min-width: 0; overflow: hidden; cursor: pointer;
        background: var(--wl-surface); border: 1px solid var(--wl-line); border-radius: var(--wl-radius);
        transition: border-color .16s ease, box-shadow .16s ease, transform .16s ease;
      }
      .wl-media-card:hover { border-color: var(--wl-line-2); box-shadow: var(--wl-shadow); transform: translateY(-1px); }
      .wl-media-card-cover { position: relative; aspect-ratio: 4 / 3; background: var(--wl-surface-2); overflow: hidden; }
      .wl-media-card-cover .wl-cover { width: 100%; height: 100%; aspect-ratio: auto; }
      .wl-media-card-body { display: flex; flex-direction: column; gap: 4px; padding: 8px 9px 9px; min-width: 0; }
      .wl-media-card-title {
        font-size: 12px; font-weight: 600; line-height: 1.4;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
        overflow: hidden; overflow-wrap: anywhere;
      }
      .wl-idea-card .wl-media-card-cover { aspect-ratio: 3 / 2; }
      .wl-idea-note {
        margin: 0; font-size: 11.5px; line-height: 1.5; color: var(--wl-muted);
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
        overflow: hidden; overflow-wrap: anywhere;
      }
      .wl-work-card .wl-media-card-body { padding: 8px 10px 10px; }
      .wl-work-section-tools { display: flex; align-items: center; gap: 4px; margin-left: auto; flex-wrap: wrap; }
      .wl-work-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(128px, 1fr)); gap: 12px; }
      .wl-work-card {
        display: flex; flex-direction: column; min-width: 0; overflow: hidden; cursor: pointer;
        background: var(--wl-surface); border: 1px solid var(--wl-line); border-radius: 12px;
        transition: border-color .16s ease, box-shadow .16s ease, transform .16s ease;
      }
      .wl-work-card:hover {
        border-color: var(--wl-line-2); box-shadow: var(--wl-shadow);
        transform: translateY(-2px) scale(1.012);
      }
      .wl-work-poster {
        position: relative; aspect-ratio: 2 / 3; background: var(--wl-surface-2); overflow: hidden;
      }
      .wl-work-poster .wl-cover { width: 100%; height: 100%; aspect-ratio: auto; }
      .wl-work-card .wl-cover-img { transition: transform .22s ease; }
      .wl-work-card:hover .wl-cover-img { transform: scale(1.04); }
      .wl-work-card-body { display: flex; flex-direction: column; gap: 4px; padding: 7px 8px 9px; min-width: 0; }
      .wl-work-card-title {
        font-size: 11.5px; font-weight: 600; line-height: 1.4;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
        overflow: hidden; overflow-wrap: anywhere;
      }
      .wl-work-card-kind {
        align-self: flex-start; font-size: 9.5px; font-weight: 600; letter-spacing: .04em;
        padding: 0 6px; border-radius: 99px; line-height: 16px;
        color: var(--wl-brand); background: var(--wl-soft-brand);
        border: 1px solid color-mix(in srgb, var(--wl-brand) 24%, transparent);
      }
      .wl-work-card-kind[data-kind="drama"] {
        color: var(--wl-warn); background: var(--wl-soft-warn);
        border-color: color-mix(in srgb, var(--wl-warn) 24%, transparent);
      }
      .wl-addwork-dialog { width: min(400px, 94vw); }
      .wl-addwork-body { gap: 10px; padding: 12px 16px 6px; }
      .wl-work-kind-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .wl-extracttext-dialog { width: min(440px, 94vw); }
      .wl-extracttext-body { gap: 10px; padding: 12px 16px 6px; }
      .wl-extracttext-textarea { min-height: 148px; resize: vertical; line-height: 1.6; }
      .wl-work-dialog { width: min(480px, 94vw); }
      .wl-work-body { align-items: stretch; gap: 10px; padding: 14px 16px 16px; }
      .wl-work-cover {
        aspect-ratio: 16 / 10; overflow: hidden; border-radius: 11px;
        border: 1px solid var(--wl-line); background: var(--wl-surface-2);
      }
      .wl-work-cover .wl-cover { width: 100%; height: 100%; aspect-ratio: auto; }
      .wl-work-line { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .wl-work-kind {
        flex: none; font-size: 10.5px; font-weight: 600; padding: 1px 6px; border-radius: 99px;
        color: var(--wl-brand); background: var(--wl-soft-brand);
        border: 1px solid color-mix(in srgb, var(--wl-brand) 26%, transparent);
      }
      .wl-work-title { margin: 0; font-size: 15px; font-weight: 600; line-height: 1.4; overflow-wrap: anywhere; }
      .wl-work-summary { margin: 0; font-size: 12.5px; line-height: 1.7; color: var(--wl-text); max-height: 30vh; overflow: auto; overflow-wrap: anywhere; }
      .wl-work-source {
        display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
        padding: 8px 10px; border-radius: 9px;
        background: var(--wl-surface-2); border: 1px solid var(--wl-line);
        font-size: 11.5px; color: var(--wl-muted);
      }
      .wl-work-source-label { flex: none; font-weight: 600; }
      .wl-work-source-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--wl-text); }
      .wl-work-source .wl-btn { flex: none; text-decoration: none; }
      .wl-work-status-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .wl-images-batch {
        display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
        padding: 8px 10px; border-radius: 10px;
        background: var(--wl-soft-brand);
        border: 1px solid color-mix(in srgb, var(--wl-brand) 26%, transparent);
      }
      .wl-images-selected { font-size: 11.5px; font-weight: 600; color: var(--wl-brand); white-space: nowrap; }
      .wl-images-errors { display: flex; flex-direction: column; gap: 4px; }
      .wl-images-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
      .wl-image-tile {
        display: flex; flex-direction: column; min-width: 0; cursor: pointer;
        border: 1px solid var(--wl-line); border-radius: var(--wl-radius);
        background: var(--wl-surface); overflow: hidden;
        transition: border-color .16s ease, box-shadow .16s ease, background .16s ease;
      }
      .wl-image-tile:hover { border-color: var(--wl-line-2); box-shadow: var(--wl-shadow); }
      .wl-image-tile[data-selected="true"] { border-color: var(--wl-brand); box-shadow: 0 0 0 2px var(--wl-soft-brand); }
      .wl-image-tile-media { position: relative; aspect-ratio: 4 / 3; background: var(--wl-surface-2); overflow: hidden; }
      .wl-image-tile-img { display: block; width: 100%; height: 100%; object-fit: cover; }
      .wl-image-tile-placeholder {
        display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
        width: 100%; height: 100%; padding: 12px; text-align: center; color: var(--wl-muted);
        background: linear-gradient(150deg, color-mix(in srgb, var(--wl-brand) 5%, var(--wl-sidebar)), var(--wl-sidebar));
      }
      .wl-image-tile-placeholder-label { font-size: 11.5px; font-weight: 600; }
      .wl-image-tile-placeholder-hint { font-size: 10px; line-height: 1.5; max-width: 170px; }
      .wl-image-check {
        position: absolute; top: 8px; right: 8px; z-index: 1;
        display: inline-flex; align-items: center; justify-content: center;
        width: 22px; height: 22px; padding: 0; border-radius: 99px; cursor: pointer;
        color: var(--wl-base); background: var(--wl-surface); border: 1px solid var(--wl-line-2);
        opacity: 0; transition: opacity .14s ease, background .14s ease, border-color .14s ease;
      }
      .wl-image-tile:hover .wl-image-check,
      .wl-image-tile:focus-within .wl-image-check,
      .wl-image-tile[data-selected="true"] .wl-image-check { opacity: 1; }
      .wl-image-check[aria-pressed="true"] { background: var(--wl-brand); border-color: var(--wl-brand); }
      .wl-image-tile-count {
        position: absolute; top: 8px; left: 8px; z-index: 1;
        padding: 1px 6px; border-radius: 99px; font-size: 10px; font-weight: 600;
        color: var(--wl-text); background: var(--wl-surface); border: 1px solid var(--wl-line-2);
      }
      .wl-image-tile-badge {
        position: absolute; left: 8px; bottom: 8px; padding: 1px 6px; border-radius: 99px;
        font-size: 10px; font-weight: 600; color: var(--wl-brand); background: var(--wl-soft-brand);
        border: 1px solid color-mix(in srgb, var(--wl-brand) 26%, transparent);
      }
      .wl-image-tile-title {
        padding: 7px 10px 8px; font-size: 12px; line-height: 1.45;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .wl-imglb {
        position: fixed; inset: 0; z-index: 240; display: flex; align-items: center; justify-content: center;
        padding: 24px; background: rgb(0 0 0 / 74%);
      }
      .wl-imglb-panel {
        position: relative; display: flex; flex-direction: column; max-width: 92vw; max-height: 90vh;
        border-radius: 12px; overflow: hidden;
        background: var(--wl-base); border: 1px solid var(--wl-line-2);
        box-shadow: 0 24px 60px rgb(0 0 0 / 36%);
      }
      .wl-imglb-media {
        position: relative; flex: 1 1 auto; min-height: 0;
        display: flex; align-items: center; justify-content: center;
        background: var(--wl-surface-2); overflow: hidden;
      }
      .wl-imglb-nav {
        position: absolute; top: 50%; transform: translateY(-50%); z-index: 2;
        width: 32px; height: 32px; color: var(--wl-text);
        background: var(--wl-surface); border: 1px solid var(--wl-line-2);
      }
      .wl-imglb-prev { left: 10px; }
      .wl-imglb-next { right: 10px; }
      .wl-imglb-counter {
        position: absolute; left: 50%; bottom: 10px; transform: translateX(-50%); z-index: 2;
        padding: 2px 10px; border-radius: 99px; font-size: 11px; font-weight: 600;
        font-variant-numeric: tabular-nums; color: var(--wl-text);
        background: var(--wl-surface); border: 1px solid var(--wl-line-2);
      }
      .wl-preview-count { font-size: 10.5px; color: var(--wl-muted); }
      .wl-preview-thumbs-many { grid-template-columns: repeat(4, minmax(0, 1fr)); }
      .wl-imglb-img { display: block; max-width: min(88vw, 1080px); max-height: 72vh; object-fit: contain; }
      .wl-imglb-placeholder {
        display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
        padding: 60px 40px; text-align: center; color: var(--wl-muted);
      }
      .wl-imglb-placeholder strong { font-size: 14px; color: var(--wl-text); }
      .wl-imglb-placeholder-hint { font-size: 11.5px; max-width: 320px; line-height: 1.6; }
      .wl-imglb-info {
        flex: none; display: flex; flex-direction: column; gap: 8px;
        padding: 12px 16px 14px; border-top: 1px solid var(--wl-line); background: var(--wl-base);
      }
      .wl-imglb-title { margin: 0; font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
      .wl-imglb-meta { font-size: 11px; color: var(--wl-muted); font-variant-numeric: tabular-nums; }
      .wl-imglb-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .wl-imglb-close { position: absolute; top: 10px; right: 10px; z-index: 2; color: var(--wl-text); background: var(--wl-surface); border: 1px solid var(--wl-line-2); }
      .wl-login-error { width: 100%; }
      .wl-login-poll-error {
        display: flex; align-items: flex-start; gap: 6px; width: 100%; text-align: left;
        padding: 7px 9px; border-radius: 8px; font-size: 11px;
        color: var(--wl-warn); background: var(--wl-soft-warn);
        border: 1px solid color-mix(in srgb, var(--wl-warn) 30%, transparent);
      }
      .wl-share .wl-field { flex: 1 1 auto; }

      .wl-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
      .wl-field-label { font-size: 11px; font-weight: 600; color: var(--wl-muted); letter-spacing: .03em; }
      .wl-field-hint { font-size: 11px; color: var(--wl-muted); line-height: 1.5; overflow-wrap: anywhere; }
      .wl-inline { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .wl-form-row { display: flex; align-items: flex-start; gap: 18px; flex-wrap: wrap; }
      .wl-input, .wl-select, .wl-textarea {
        font: inherit; font-size: 12.5px; color: var(--wl-text); background: var(--wl-base);
        border: 1px solid var(--wl-line); border-radius: 9px; padding: 6px 9px; min-width: 0;
      }
      .wl-input:focus, .wl-select:focus, .wl-textarea:focus {
        outline: none; border-color: var(--wl-brand); box-shadow: 0 0 0 3px var(--wl-soft-brand);
      }
      .wl-input::placeholder, .wl-textarea::placeholder { color: var(--wl-muted); }
      .wl-input:disabled, .wl-select:disabled, .wl-textarea:disabled { opacity: .6; }
      .wl-input-num { width: 76px; font-variant-numeric: tabular-nums; }
      .wl-select { cursor: pointer; padding-right: 6px; }
      .wl-select-sm { font-size: 11.5px; padding: 2px 6px; border-radius: 7px; }
      .wl-textarea { resize: vertical; min-height: 64px; line-height: 1.6; width: 100%; }

      .wl-switch {
        flex: none; position: relative; width: 32px; height: 19px; padding: 0;
        border-radius: 99px; cursor: pointer; background: var(--wl-surface-2);
        border: 1px solid var(--wl-line);
        transition: background .16s ease, border-color .16s ease;
      }
      .wl-switch[data-on="true"] { background: var(--wl-brand); border-color: var(--wl-brand); }
      .wl-switch:disabled { opacity: .5; cursor: default; }
      .wl-switch-thumb {
        position: absolute; top: 2px; left: 2px; width: 13px; height: 13px;
        border-radius: 99px; background: var(--wl-base);
        box-shadow: 0 1px 2px rgb(0 0 0 / 18%); transition: transform .16s ease;
      }
      .wl-switch[data-on="true"] .wl-switch-thumb { transform: translateX(13px); }

      .wl-settings { display: flex; flex-direction: column; border: 1px solid var(--wl-line); border-radius: var(--wl-radius); background: var(--wl-surface); overflow: hidden; }
      .wl-setting { display: flex; align-items: center; gap: 12px 18px; flex-wrap: wrap; padding: 12px 16px; }
      .wl-setting + .wl-setting { border-top: 1px solid color-mix(in srgb, var(--wl-line) 60%, transparent); }
      .wl-setting-main { flex: 1 1 320px; min-width: 0; }
      .wl-setting-title { margin: 0; font-size: 13px; font-weight: 600; }
      .wl-setting-desc { margin: 2px 0 0; color: var(--wl-muted); font-size: 11.5px; line-height: 1.55; }
      .wl-setting-control { flex: 0 1 auto; max-width: 100%; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .wl-dir-list { display: flex; flex-direction: column; gap: 4px; width: 100%; }
      .wl-dir-list .wl-kv { align-items: center; }
      .wl-dir-list .wl-kv-v { flex: 1 1 auto; }
      .wl-settings-about { gap: 3px; padding: 12px 16px; }

      .wl-state { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 44px 20px; text-align: center; color: var(--wl-muted); }
      .wl-state-icon {
        display: flex; align-items: center; justify-content: center; width: 40px; height: 40px;
        border-radius: 12px; border: 1px solid var(--wl-line); background: var(--wl-surface); color: var(--wl-muted);
      }
      .wl-state-title { margin: 2px 0 0; font-size: 13.5px; font-weight: 600; color: var(--wl-text); }
      .wl-state-desc { margin: 0; font-size: 11.5px; max-width: 420px; line-height: 1.6; }
      .wl-state-error .wl-state-icon { color: var(--wl-danger); border-color: color-mix(in srgb, var(--wl-danger) 32%, transparent); background: var(--wl-soft-danger); }
      .wl-error-bar {
        display: flex; align-items: center; gap: 7px; padding: 8px 11px; border-radius: 9px;
        color: var(--wl-danger); background: var(--wl-soft-danger);
        border: 1px solid color-mix(in srgb, var(--wl-danger) 30%, transparent); font-size: 11.5px;
      }
      .wl-error-text { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
      .wl-error-bar .wl-btn { flex: none; }
      .wl-warn-bar {
        display: flex; align-items: flex-start; gap: 7px; padding: 8px 11px; border-radius: 9px;
        color: var(--wl-warn); background: var(--wl-soft-warn);
        border: 1px solid color-mix(in srgb, var(--wl-warn) 30%, transparent); font-size: 11.5px;
      }
      .wl-warn-text { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
      .wl-pulse { animation: wl-pulse 1.4s ease-in-out infinite; }
      @keyframes wl-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
      .wl-spin { animation: wl-spin .9s linear infinite; }
      @keyframes wl-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

      .wl-backdrop { position: fixed; inset: 0; z-index: 220; background: rgb(0 0 0 / 30%); }
      .wl-drawer {
        position: fixed; top: 0; right: 0; bottom: 0; z-index: 221;
        width: min(420px, 92vw); display: flex; flex-direction: column;
        background: var(--wl-base); border-left: 1px solid var(--wl-line-2);
        box-shadow: -16px 0 42px rgb(0 0 0 / 18%);
        animation: wl-slide-in .2s ease;
      }
      @keyframes wl-slide-in { from { opacity: 0; transform: translateX(14px); } to { opacity: 1; transform: translateX(0); } }
      .wl-drawer-head {
        flex: none; display: flex; align-items: center; gap: 7px; min-width: 0;
        padding: 14px 16px 10px;
        border-bottom: 1px solid color-mix(in srgb, var(--wl-line) 60%, transparent);
      }
      .wl-drawer-meta-line { color: var(--wl-muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
      .wl-drawer-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 14px 16px 20px; display: flex; flex-direction: column; gap: 12px; }
      .wl-drawer-cover { border-radius: 11px; border: 1px solid var(--wl-line); aspect-ratio: 16 / 10; }
      .wl-drawer-title { margin: 0; font-size: 16px; font-weight: 600; line-height: 1.45; overflow-wrap: anywhere; }
      .wl-drawer-stats { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; color: var(--wl-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
      .wl-drawer-stat { white-space: nowrap; }
      .wl-drawer-link {
        display: flex; align-items: center; gap: 6px; min-width: 0;
        font-size: 11.5px; color: var(--wl-brand); text-decoration: none;
        padding: 6px 9px; border-radius: 8px; background: var(--wl-soft-brand);
        border: 1px solid color-mix(in srgb, var(--wl-brand) 22%, transparent);
      }
      .wl-drawer-link:hover { border-color: var(--wl-brand); }
      .wl-drawer-link-text {
        flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        text-decoration: underline; text-underline-offset: 2px;
      }
      .wl-drawer-section { display: flex; flex-direction: column; gap: 6px; padding-top: 12px; border-top: 1px solid color-mix(in srgb, var(--wl-line) 60%, transparent); }
      .wl-drawer-label { margin: 0; font-size: 11px; font-weight: 700; letter-spacing: .05em; color: var(--wl-muted); }
      .wl-drawer-summary { margin: 0; font-size: 12.5px; line-height: 1.7; overflow-wrap: anywhere; }
      .wl-drawer-foot { flex: none; display: flex; flex-direction: column; gap: 8px; padding: 12px 16px 16px; border-top: 1px solid var(--wl-line); background: var(--wl-base); }
      .wl-drawer-foot-row { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
      .wl-confirm { display: inline-flex; align-items: center; gap: 5px; }

      .wl-dialog {
        position: fixed; inset: 0; z-index: 221; margin: auto;
        width: min(560px, 94vw); max-height: 88vh;
        display: flex; flex-direction: column;
        background: var(--wl-base); border: 1px solid var(--wl-line-2); border-radius: 14px;
        box-shadow: 0 24px 60px rgb(0 0 0 / 24%); overflow: hidden;
        animation: wl-dialog-in .18s ease;
      }
      @keyframes wl-dialog-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
      .wl-dialog-head {
        flex: none; display: flex; align-items: center; justify-content: space-between; gap: 10px;
        padding: 14px 16px 10px;
        border-bottom: 1px solid color-mix(in srgb, var(--wl-line) 60%, transparent);
      }
      .wl-dialog-title { margin: 0; font-size: 15px; font-weight: 600; }
      .wl-dialog-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 11px; }
      .wl-dialog-foot { flex: none; display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 11px 16px 14px; border-top: 1px solid var(--wl-line); }
      .wl-seg {
        display: inline-flex; align-items: center; gap: 2px; align-self: flex-start;
        padding: 2px; border-radius: 9px; background: var(--wl-surface-2); border: 1px solid var(--wl-line);
      }
      .wl-seg-btn {
        font: inherit; font-size: 12px; padding: 3px 12px; border-radius: 7px;
        border: 0; background: transparent; color: var(--wl-muted); cursor: pointer;
      }
      .wl-seg-btn:hover:not(:disabled) { color: var(--wl-text); }
      .wl-seg-btn[data-active="true"] { color: var(--wl-text); background: var(--wl-base); box-shadow: 0 1px 2px rgb(0 0 0 / 8%); }
      .wl-seg-btn:disabled { opacity: .55; cursor: default; }
      .wl-image-pick { display: flex; align-items: center; gap: 10px; }
      .wl-dialog-thumb {
        flex: none; width: 88px; height: 66px; border-radius: 9px; object-fit: cover;
        border: 1px solid var(--wl-line); background: var(--wl-surface-2);
      }
      .wl-dialog-thumb-empty { display: flex; align-items: center; justify-content: center; color: var(--wl-muted); }
      .wl-image-pick-side { display: flex; flex-direction: column; gap: 5px; min-width: 0; }

      .wl-toast {
        position: fixed; top: 16px; right: 16px; z-index: 300;
        display: flex; align-items: flex-start; gap: 7px;
        max-width: min(360px, calc(100vw - 32px));
        padding: 9px 12px; border-radius: 10px;
        font-size: 12px; color: var(--wl-text);
        background: var(--wl-overlay); border: 1px solid var(--wl-line-2);
        box-shadow: 0 10px 28px rgb(0 0 0 / 16%);
        animation: wl-toast-in .18s ease;
      }
      .wl-toast[data-kind="ok"] .wl-icon { color: var(--wl-ok); }
      .wl-toast[data-kind="error"] {
        color: var(--wl-danger); background: var(--wl-soft-danger);
        border-color: color-mix(in srgb, var(--wl-danger) 34%, transparent);
      }
      .wl-toast[data-kind="warn"] {
        color: var(--wl-warn); background: var(--wl-soft-warn);
        border-color: color-mix(in srgb, var(--wl-warn) 34%, transparent);
      }
      .wl-toast[data-kind="warn"] .wl-icon { color: var(--wl-warn); }
      .wl-toast-text { min-width: 0; overflow-wrap: anywhere; line-height: 1.5; }
      @keyframes wl-toast-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }

      .wl-topics { display: flex; flex-direction: column; gap: 16px; }
      .wl-topics-group { display: flex; flex-direction: column; gap: 8px; }
      .wl-topics-head {
        display: flex; align-items: center; gap: 6px; align-self: flex-start;
        font: inherit; color: var(--wl-text); background: none; border: 0; padding: 0; cursor: pointer;
      }
      .wl-topics-name { font-size: 13px; font-weight: 600; letter-spacing: .01em; }
      .wl-topics-head:hover .wl-topics-name { color: var(--wl-brand); }
      .wl-topics-chevron { color: var(--wl-muted); transition: transform .16s ease; }
      .wl-topics-group[data-collapsed="true"] .wl-topics-chevron { transform: rotate(-90deg); }
      .wl-topics-list { display: flex; flex-direction: column; gap: 6px; }
      .wl-topics-row {
        display: flex; align-items: center; gap: 10px; width: 100%;
        padding: 8px 11px; text-align: left; font: inherit; color: var(--wl-text); cursor: pointer;
        background: var(--wl-surface); border: 1px solid var(--wl-line); border-radius: var(--wl-radius);
        transition: border-color .16s ease, background .16s ease;
      }
      .wl-topics-row:hover { border-color: var(--wl-line-2); background: color-mix(in srgb, var(--wl-surface) 84%, var(--wl-surface-2)); }
      .wl-topics-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      .wl-topics-title { font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wl-topics-meta { font-size: 11px; color: var(--wl-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wl-topics-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 1px; }
      .wl-topics-more { margin: 0; padding: 2px 2px 0; font-size: 11.5px; font-weight: 600; color: var(--wl-muted); }

      @media (max-width: 720px) {
        .wl-header { padding: 14px 16px 0; }
        .wl-root[data-desktop="true"] .wl-header { padding-top: 40px; }
        .wl-tabs { padding: 10px 16px 0; }
        .wl-scroll { padding: 14px 16px 30px; }
        .wl-head-actions { margin-left: 0; width: 100%; }
        .wl-title { font-size: 16px; }
        .wl-grid { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
        .wl-banner-item { max-width: 100%; }
        .wl-banner-title { max-width: 150px; }
        .wl-login-qr { width: 168px; height: 168px; }
        .wl-images-grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
        .wl-preview-thumbs-many { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        .wl-agent-row { flex-wrap: wrap; }
        .wl-agent-actions { width: 100%; justify-content: flex-end; }
        .wl-work-grid { grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 10px; }
        .wl-drawer { width: min(420px, 100vw); }
        .wl-dialog { width: 96vw; max-height: 92vh; }
      }
      @media (hover: none) {
        .wl-card-actions { opacity: 1; pointer-events: auto; }
        .wl-image-check { opacity: 1; }
      }
      @media (prefers-reduced-motion: reduce) {
        .wl-root *, .wl-root *::before, .wl-root *::after {
          animation-duration: .01ms !important; animation-iteration-count: 1 !important;
          transition-duration: .01ms !important;
        }
      }

      /* ---- AI 整理：徽章 / 进度 / 抽屉 ---- */
      .wl-ai-badge {
        display: inline-flex; align-items: center; gap: 3px; flex: 0 0 auto;
        font-size: 10.5px; line-height: 16px; padding: 1px 6px; border-radius: 99px;
        border: 1px solid var(--wl-line); color: var(--wl-muted);
        background: transparent; white-space: nowrap;
      }
      .wl-ai-badge.is-done {
        color: var(--wl-brand); border-color: color-mix(in srgb, var(--wl-brand) 38%, transparent);
        background: color-mix(in srgb, var(--wl-brand) 10%, transparent);
      }
      .wl-ai-badge.is-partial {
        color: #b07d1e; border-color: color-mix(in srgb, #b07d1e 38%, transparent);
        background: color-mix(in srgb, #b07d1e 9%, transparent);
      }
      .wl-ai-badge.is-failed {
        color: #c04a3a; border-color: color-mix(in srgb, #c04a3a 38%, transparent);
        background: color-mix(in srgb, #c04a3a 9%, transparent);
      }
      .wl-ai-badge.is-none { opacity: .6; border-style: dashed; }
      .wl-ai-badge-label { font-weight: 600; letter-spacing: .01em; }
      .wl-head-pending { color: var(--wl-muted); }
      .wl-ai-progress {
        position: relative; display: inline-block; align-self: center;
        width: 92px; height: 4px; border-radius: 99px; overflow: hidden;
        background: var(--wl-line);
      }
      .wl-ai-progress-bar {
        display: block; height: 100%; width: 0;
        background: var(--wl-brand); transition: width .3s ease;
      }
      .wl-btn-busy { opacity: .78; }
      .wl-chip-ai[data-active="true"] {
        color: var(--wl-brand); border-color: color-mix(in srgb, var(--wl-brand) 42%, transparent);
        background: color-mix(in srgb, var(--wl-brand) 9%, transparent);
      }
      .wl-drawer-ai {
        border-left: 2px solid color-mix(in srgb, var(--wl-brand) 28%, transparent);
        padding-left: 10px;
      }
      .wl-drawer-ai .wl-drawer-label { display: flex; align-items: center; gap: 6px; }
      .wl-drawer-ai-suggest { margin: 2px 0; font-size: 11.5px; color: var(--wl-muted); }
      .wl-drawer-ai-error { margin: 2px 0; font-size: 11.5px; color: #c04a3a; }
      .wl-drawer-ai-meta { margin: 0; font-size: 11px; color: var(--wl-muted); }
      .wl-drawer-ai-raw {
        margin: 0; font-size: 11px; color: var(--wl-muted);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
    `

    /* -------------------------------------------------------------- register */

    return {
      inject: ['slots', 'locale', 'workspaces', 'sessions', 'conversation', 'uiWorkspace'],
      apply(ctx) {
        const readService = (name) => {
          try {
            if (typeof ctx.get === 'function') {
              const value = ctx.get(name)
              if (value) return value
            }
          } catch {
            // fall through
          }
          try {
            return ctx[name]
          } catch {
            return null
          }
        }
        const agentRuntime = {
          workspaces: readService('workspaces'),
          sessions: readService('sessions'),
          conversation: readService('conversation'),
          uiWorkspace: readService('uiWorkspace'),
        }
        const translate = (key) => {
          try {
            const bound = ctx.locale.bind(NS)
            const value = bound(key)
            if (typeof value === 'string' && value && value !== key) return value
          } catch {
            // fall through to the bundled dictionary
          }
          return hasOwn(ZH, key) ? ZH[key] : key
        }
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }))
        ctx.effect(() =>
          ctx.slots.inject('main', () =>
            ctx.slots.register(
              {
                name: 'main',
                key: PANEL_ID,
                locale: NS,
                inject: () => ({ t: translate, runtime: agentRuntime }),
              },
              function WatchLaterHost() {
                return h(WatchLaterCenter, { t: translate, runtime: agentRuntime })
              },
            ),
          ),
        )
        ctx.effect(() =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: 15,
                locale: NS,
                label: () => translate('title'),
              },
              WatchLaterIcon,
            ),
          ),
        )
      },
    }
  },
})
