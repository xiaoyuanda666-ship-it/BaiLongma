// 按需注入工具选择器（动态上下文记忆池第 4 步）。
//
// 之前 injector.js 把约 35-40 个工具 schema 全量塞进每轮 LLM 调用的 tools
// 字段，单这一项就占 6-9K token。这里按"领域 + 意图"分组，只注入这轮真正
// 用得上的组——其它组省掉。
//
// 规则要点：
//   1) 按"动作意图"匹配（动词为主），不复用 keywords.js 的话题抽取
//   2) ActionLog 保活：最近 10 次工具调用强制注入，保证跨轮连贯
//   3) TICK 心跳广注入：awakening exploration 阶段 agent 可能突发奇想
//   4) Fallback 安全网：最终工具数 < 8 时补 web + filesystem（最常用兜底）
//   5) 用户已安装工具永远全注入（marketplace 是用户主动行为）
//   6) 多模态生成工具：mmCaps 已配置 AND 关键词命中才注入，避免太激进
//
// 输入 ctx：
//   - messageBody          已剥离 envelope 的消息正文
//   - isTick               是否 TICK 心跳
//   - senderId             消息发送方 ID（用来判断要不要 search_memory）
//   - hasTask              是否有 active task
//   - hasRecall            state.prev_recall 是否非空
//   - mmCaps               多模态能力数组（registry.listCapabilities()）
//   - recentActionLog      最近 N 条 action_log（保活源）
//   - installedToolNames   marketplace 已安装的扩展工具
//   - startupSelfCheckActive  启动自检激活标志
//   - fastUserPath         可选——是否实时用户消息（用于"再激进省一点"，未传按 false）
//
// 输出：去重后的 tools: string[]

import { getStatus as getTickerStatus } from '../ticker.js'
import { isSoftwareInstallRequest, SOFTWARE_INSTALL_TRIGGERS } from '../software-install-intent.js'

// ---- 工具分组 ----
//
// core：任何场景都注入。
const CORE_TOOLS = [
  'send_message',
  'recall_memory',
  // find_tool：工具发现入口。每轮只注入约 35 个工具里命中意图的子集，模型若需要一个本轮没注入的
  // 工具（比如关键词没命中导致 generate_image / exec_command 没进来），可调 find_tool 搜出来并当场装载。
  'find_tool',
  'ui_set',
]

const TASK_CTRL_FULL    = ['set_task', 'complete_task', 'update_task_step', 'review_work']
const TASK_CTRL_OPENER  = ['set_task']  // 没任务时只暴露 set_task

// 成果审视：有任务时随 TASK_CTRL_FULL 常驻（"完成任务前找第二双眼睛"的主场景）；
// 无任务的临时成果，靠下面这组触发词 / find_tool 主动拉进来。
const REVIEW_TOOLS      = ['review_work']

const WEB_TOOLS         = ['web_search', 'fetch_url', 'browser_read']
const FILESYSTEM_TOOLS  = ['read_file', 'write_file', 'delete_file', 'list_dir', 'make_dir']
const EXEC_TOOLS        = ['exec_command', 'exec_quick_command', 'exec_task_command', 'exec_background_command', 'download_file', 'kill_process', 'list_processes']
const SOFTWARE_INSTALL_TOOLS = ['install_software', 'list_processes']
const MEDIA_TOOLS       = ['media_mode', 'music']
const REMINDER_TOOLS    = ['manage_reminder']
const PREFETCH_TOOLS    = ['manage_prefetch_task']
const TICKER_TOOLS      = ['set_tick_interval']
const HOTSPOT_TOOLS     = ['hotspot_mode']
// 世界杯模式打开面板即可（赛况数据由 runtime-injector 注入上下文）；
// 追问细节（首发名单/射手榜等）要联网，所以 WEB_TOOLS 一并带上
const WORLDCUP_TOOLS    = ['worldcup_mode', ...WEB_TOOLS]
const STARTUP_SELF_CHECK_TOOLS = [
  'speak',
  'complete_startup_self_check',
  ...FILESYSTEM_TOOLS,
  ...WEB_TOOLS,
  ...MEDIA_TOOLS,
  ...HOTSPOT_TOOLS,
]
const PERSON_CARD_TOOLS = ['person_card_mode']
const FOCUS_BANNER_TOOLS = ['focus_banner']
const ADMIN_TOOLS       = [
  'manage_tool_factory', 'install_tool', 'uninstall_tool', 'list_tools',
  'set_security', 'connect_wechat',
  'set_location', 'set_agent_name', 'manage_rule',
]

// 多模态生成（按 mmCaps gate；关键词命中后才注入对应工具）
const MM_GEN_TOOLS = {
  tts:    'speak',
  lyrics: 'generate_lyrics',
  music:  'generate_music',
  image:  'generate_image',
}

// ---- 关键词触发集 ----
//
// 设计原则：动词 + 强名词，宁可漏命中也不要误命中导致全 schema 都灌进去。
// 中文用纯字面包含；英文需考虑单词边界，但 messageBody.includes 已经够鲁棒
// （"file" 不会误中 "filename" 也无所谓，命中只是多注入而不是漏）。
// 全部 lower-cased。

const FILESYSTEM_TRIGGERS = [
  '文件', '路径', '目录', '文件夹', '读取', '读一下', '读下', '看下文件',
  '写入', '保存', '另存', '存到', '新建', '建一个', '建个文件',
  '删除', '删掉', '清理', '文档', 'readme', '日志', '配置文件',
  'file', 'folder', 'directory', 'path', 'read ', 'write ', 'save ',
  'create file', 'delete file', 'mkdir', 'ls ', 'dir ', '.txt', '.md',
  '.json', '.js', '.py', '.html', '.csv',
]

const EXEC_TRIGGERS = [
  '运行', '执行', '跑一下', '跑个', '命令', '终端', '控制台', '进程', '杀掉',
  '启动', '停止', '关掉程序', 'shell',
  'run ', 'execute', 'cmd', 'command', 'process', 'kill', 'pid', 'powershell',
  'bash', 'terminal', 'console',
]

const WEB_TRIGGERS = [
  '搜', '搜索', '查一下', '查查', '百度', '谷歌', '上网', '在线', '网页',
  '网址', '链接', '浏览', '打开网页', '看看网上', '抓一下',
  'search', 'google', 'bing', 'fetch', 'http://', 'https://', 'url',
  'web', 'browser', 'browse', 'website', '.com', '.cn', '.org', '.io',
]

const MEDIA_TRIGGERS = [
  '音乐', '歌', '听', '播放', '放首', '放一首', '放点', '视频', '看视频',
  '抖音', 'b站', 'bilibili', '电影', '电视剧',
  'play ', 'music', 'song', 'video', 'movie', 'mv ', 'spotify', 'netease',
]

const REMINDER_TRIGGERS = [
  '提醒', '记一下', '别忘', '到时候', '明天', '后天', '今晚', '明早',
  '几点', '点钟', '点叫', '点喊', '计划', '安排', '日程',
  'remind', 'reminder', 'schedule', 'alarm', 'wake me', 'notify',
]

const PREFETCH_TRIGGERS = [
  '预热', '预取', '订阅', '定期', '每天', '每小时', '推送', '关注', 'feed',
  'subscribe', 'rss', 'periodic', 'prefetch', 'cron',
]

const TICKER_TRIGGERS = [
  '心跳', '节奏', '间隔', '频率', '多久叫一次', '别老叫', 'tick', 'cadence',
  'heartbeat', 'interval',
]

const HOTSPOT_TRIGGERS = [
  '热点', '热搜', '热门', '新闻', '今日', '趋势', '榜单', '头条', 'trending',
  'news', 'hot ', 'top ', '微博热搜', '热议',
]

const WORLDCUP_TRIGGERS = [
  '世界杯', '赛况', '比分', '赛程', '对阵', '积分榜', '小组赛', '淘汰赛',
  '谁赢', '进球', '几比几', '揭幕战', '球赛', '足球赛',
  'world cup', 'worldcup', 'fifa',
]

const PERSON_CARD_TRIGGERS = [
  '谁是', '是谁', '是誰', '是个什么人', '是個什麼人', '是什么人', '是什麼人',
  '是干嘛的', '是幹嘛的', '人物卡片', '人物卡', 'person card',
  'who is', 'tell me about', 'biography of', 'profile of',
]

const FOCUS_BANNER_TRIGGERS = [
  '专注', '沉浸', '小目标', '目标定', '横幅', '锁定', '别打扰', '勿扰',
  'focus mode', 'banner', 'do not disturb', 'dnd', 'immersive',
]

const ADMIN_TRIGGERS = [
  '装一下', '安装', '装个', '卸载', '装好', '装上', '工具市场', '插件',
  '自写工具', '自己写工具', '工具工厂', '工具审核', '生成工具', '注册工具',
  '安全', '沙箱', '权限', '微信', '绑定', '连接', '配对',
  '位置', '在哪', '改名字', '改名', '叫你', '叫我', '管理应用', 'app 列表',
  'install tool', 'tool factory', 'generated tool', 'review tool', 'register tool',
  'uninstall', 'plugin', 'security', 'sandbox', 'wechat',
  'connect ', 'location', 'rename', 'apps',
  '规则', '关键词规则', '上下文规则', '记忆注入',
  'rule', 'rules', 'context rule', 'keyword rule', 'memory injection',
]

// 多模态生成专用触发（关键词必须足够具体——单字"说""画"在中文里太宽泛
// 会被"没说""画面"误命中。优先用 2+ 字组合 / 明确动词短语。）
const TTS_TRIGGERS = [
  '朗读', '念出来', '念一下', '读出来', '读给我听', '念给我',
  '播报', '语音播报', '用声音', '说出来',
  'speak this', 'read aloud', 'tts ', 'voice over',
]
const LYRICS_TRIGGERS = [
  '作词', '写词', '帮我写歌词', '歌词', 'lyrics',
]
const MUSIC_GEN_TRIGGERS = [
  '作曲', '生成音乐', '编曲', '配乐', '写首歌', '做首歌',
  'compose', 'generate music', 'make a song',
]
const IMAGE_GEN_TRIGGERS = [
  '画个', '画一张', '画一幅', '画张', '帮我画',
  '生成图', '生成图片', '出张图', '配图',
  // 注：曾包含 '画图'，但常被"没说画图"等反语命中——改用更强限定的词组
  'draw', 'paint', 'generate image', 'image of', 'picture of',
]
// AI 视频生成（Seedance）专用触发。不按 mmCaps gate：即使未配置 key 也暴露工具，
// 让模型能在"未配置"时拿到 generate_video 的引导返回值去提醒用户配置（不做硬拦截）。
const VIDEO_GEN_TRIGGERS = [
  '生成视频', '生成个视频', '生成一段视频', '做个视频', '做段视频', '做一段视频',
  '文生视频', '图生视频', 'ai视频', 'ai 视频', '视频生成',
  '帮我生成视频', '用图生成视频', '把图变成视频', '让图片动起来', '让照片动起来',
  'seedance', '即梦', '火山视频',
  'generate video', 'text to video', 'image to video', 'make a video', 'create a video',
]

const REVIEW_TRIGGERS = [
  '检查成果', '检查一下成果', '审视', '复查', '核对', '把关', '验收', '自检',
  '检查工作', '检查我做的', '再检查', '复核', '查验',
  'review', 'double-check', 'double check', 'verify the work', 'check my work', 'sanity check',
]

// 触发词 → 工具组的单一数据源。selectTools（按轮注入）和 find_tool（模型主动搜工具）
// 共用它，避免两处各维护一份中文关键词。注：CORE / task / memory / 多模态 mmCaps gate 等
// 特殊注入逻辑仍在 selectTools 里，这里只收录"纯关键词触发的专业组"，正好是 find_tool 要搜的范围。
export const TOOL_GROUPS = [
  { triggers: FILESYSTEM_TRIGGERS,   tools: FILESYSTEM_TOOLS },
  { triggers: EXEC_TRIGGERS,         tools: EXEC_TOOLS },
  { triggers: WEB_TRIGGERS,          tools: WEB_TOOLS },
  { triggers: MEDIA_TRIGGERS,        tools: MEDIA_TOOLS },
  { triggers: REMINDER_TRIGGERS,     tools: REMINDER_TOOLS },
  { triggers: PREFETCH_TRIGGERS,     tools: PREFETCH_TOOLS },
  { triggers: TICKER_TRIGGERS,       tools: TICKER_TOOLS },
  { triggers: HOTSPOT_TRIGGERS,      tools: HOTSPOT_TOOLS },
  { triggers: WORLDCUP_TRIGGERS,     tools: WORLDCUP_TOOLS },
  { triggers: PERSON_CARD_TRIGGERS,  tools: PERSON_CARD_TOOLS },
  { triggers: FOCUS_BANNER_TRIGGERS, tools: FOCUS_BANNER_TOOLS },
  { triggers: SOFTWARE_INSTALL_TRIGGERS, tools: SOFTWARE_INSTALL_TOOLS },
  { triggers: ADMIN_TRIGGERS,        tools: ADMIN_TOOLS },
  { triggers: TTS_TRIGGERS,          tools: [MM_GEN_TOOLS.tts] },
  { triggers: LYRICS_TRIGGERS,       tools: [MM_GEN_TOOLS.lyrics] },
  { triggers: MUSIC_GEN_TRIGGERS,    tools: [MM_GEN_TOOLS.music] },
  { triggers: IMAGE_GEN_TRIGGERS,    tools: [MM_GEN_TOOLS.image] },
  { triggers: VIDEO_GEN_TRIGGERS,    tools: ['generate_video'] },
  { triggers: REVIEW_TRIGGERS,       tools: REVIEW_TOOLS },
]

// 通用辅助：消息正文里是否含有给定触发词之一（lower-case 包含）。
// 全部走 includes —— 中文不需要词边界，英文混进来无所谓多注入。
function hits(body, triggers) {
  if (!body) return false
  for (const t of triggers) {
    if (body.includes(t)) return true
  }
  return false
}

const PERSON_CARD_NON_PERSON_SUBJECT_RE = /(?:项目|功能|系统|工具|代码|文件|文档|文章|报告|方案|计划|任务|流程|架构|设计|页面|网站|应用|app|接口|api|正则|问题|bug|卡片|面板|按钮|图片|视频|音乐|游戏|天气|热点|热搜)/i
const PERSON_CARD_GENERIC_SUBJECT_RE = /^(?:这个人|那个人|这人|那人|这位|那位|某个人|某位|有人|谁|哪位|什么人|人物|人物卡|人物卡片)$/i

function cleanPersonCardCandidate(value = '') {
  return String(value || '')
    .trim()
    .replace(/^["'“”‘’「」『』《》]+|["'“”‘’「」『』《》]+$/g, '')
    .replace(/[，,。.!！：:；;、]+$/g, '')
    .replace(/\s*(?:是谁|是誰|是什么人|是什麼人|是个什么人|是個什麼人|是干嘛的|是幹嘛的)$/g, '')
    .replace(/(?:的)?(?:生平|资料|資料|背景|简介|簡介|履历|履歷|故事|百科|个人资料|個人資料)$/g, '')
    .trim()
}

function looksLikePersonCardName(value = '') {
  const name = cleanPersonCardCandidate(value)
  if (!name || name.length > 32) return false
  if (PERSON_CARD_NON_PERSON_SUBJECT_RE.test(name)) return false
  if (PERSON_CARD_GENERIC_SUBJECT_RE.test(name)) return false
  if (/[?？]/.test(name)) return false
  if (/(?:帮我|给我|请|麻烦|写|做|生成|打开|关闭|修|改|看下|看看|一下)/.test(name)) return false

  const compact = name.replace(/\s+/g, '')
  if (/^[\u4e00-\u9fa5·]{2,8}$/.test(compact)) return true

  const latinName = name.replace(/[·]/g, ' ').replace(/\s+/g, ' ').trim()
  const latinTokens = latinName.split(' ').filter(Boolean)
  if (latinTokens.length >= 2 && latinTokens.length <= 4) {
    return latinTokens.every(token => /^[A-Za-z][A-Za-z.'-]{1,24}$/.test(token))
  }
  return false
}

function hitsPersonCardIntent(messageBody = '') {
  const raw = String(messageBody || '').trim()
  if (!raw || /热点|热搜/.test(raw)) return false

  if (/(?:打开|显示|弹出|关闭|隐藏|收起).{0,8}(?:人物卡片|人物卡|person card)|(?:人物卡片|人物卡|person card).{0,8}(?:打开|显示|弹出|关闭|隐藏|收起)/i.test(raw)) {
    return true
  }

  const patterns = [
    /^谁是\s*(.+?)[？?]?$/,
    /^(.+?)\s*(?:是谁|是誰|是什么人|是什麼人|是个什么人|是個什麼人|是干嘛的|是幹嘛的|为什么火|為什麼火|为什么红|為什麼紅)[？?]?$/,
    /^(?:介绍一下|介绍下|查一下|了解一下|认识一下)\s*(.+?)[？?]?$/,
    /^(?:who is|tell me about|biography of|profile of)\s+(.+?)[?.!]?$/i,
  ]

  for (const pattern of patterns) {
    const match = raw.match(pattern)
    if (looksLikePersonCardName(match?.[1])) return true
  }
  return false
}

export function selectTools(ctx = {}) {
  const {
    messageBody = '',
    isTick = false,
    senderId = null,
    hasTask = false,
    hasRecall = false,
    mmCaps = [],
    recentActionLog = [],
    installedToolNames = [],
    startupSelfCheckActive = false,
    fastUserPath = false,
  } = ctx

  const body = (messageBody || '').toLowerCase()
  const out = new Set(CORE_TOOLS)
  // 被显式抑制的工具名:ActionLog 保活 / installed 列表 / fallback 兜底都要跳过,
  // 最后一道 delete 兜底,确保不被任何路径加回来。当前唯一用法是跨 turn 抑制 set_tick_interval。
  const suppressed = new Set()

  // 任务控制：有任务 → 全组；没任务 → 仅 set_task（用户能开任务）
  for (const t of (hasTask ? TASK_CTRL_FULL : TASK_CTRL_OPENER)) out.add(t)

  // 记忆搜索：跟原行为对齐
  if (senderId || hasRecall || isTick) out.add('search_memory')

  // probe_memory：无副作用的诊断工具，主 agent 想自检"如果现在问 X，会拉到什么"时用。
  // 跟 search_memory 同一触发条件——任何会需要 search_memory 的场景都可能想用 probe_memory。
  if (senderId || hasRecall || isTick) out.add('probe_memory')

  // 启动自检：这条链路是一次性系统检查，指令里明确要求语音播报、文件读写、热点面板和视频模式。
  if (startupSelfCheckActive) {
    for (const t of STARTUP_SELF_CHECK_TOOLS) out.add(t)
  }

  // —— 按关键词逐组判断 ——

  if (hits(body, FILESYSTEM_TRIGGERS)) {
    for (const t of FILESYSTEM_TOOLS) out.add(t)
  }
  if (hits(body, EXEC_TRIGGERS)) {
    for (const t of EXEC_TOOLS) out.add(t)
  }
  if (hits(body, WEB_TRIGGERS) || isTick) {
    for (const t of WEB_TOOLS) out.add(t)
  }
  if (hits(body, MEDIA_TRIGGERS)) {
    for (const t of MEDIA_TOOLS) out.add(t)
    // 媒体场景常需要先联网找链接——尤其视频要 web_search 搜到可嵌入的 B 站 BV 才能播。
    // 不一并注入 web 工具的话，模型拿不到 web_search，会误以为"没有联网搜索"而直接放弃找视频
    // （这是"找的视频不能播放/找不到视频"的一个隐藏根因）。音乐用不到也无妨。
    for (const t of WEB_TOOLS) out.add(t)
  }
  if (hits(body, REMINDER_TRIGGERS) || isTick) {
    for (const t of REMINDER_TOOLS) out.add(t)
  }
  if (hits(body, PREFETCH_TRIGGERS) || isTick) {
    for (const t of PREFETCH_TOOLS) out.add(t)
  }
  // Ticker 跨 turn 抑制：用户消息含 ticker 关键词 → 永远注入(用户在主动调度)。
  // TICK 心跳路径 → 仅在当前没有生效的 custom interval、或剩余 ttl <= 3 时注入。
  // 已经设过 120s × 15 轮的话,TICK 路径里模型根本看不到这个工具,自然不会反复调。
  // ttl <= 3 时重新放开,模型如果想延长当前节奏还有机会。
  // 被抑制的工具进 suppressed,后续 ActionLog 保活也不会把它捞回来。
  if (hits(body, TICKER_TRIGGERS)) {
    for (const t of TICKER_TOOLS) out.add(t)
  } else if (isTick) {
    const tickerStatus = getTickerStatus()
    const tickerLocked = tickerStatus.active && tickerStatus.ttl > 3
    if (!tickerLocked) {
      for (const t of TICKER_TOOLS) out.add(t)
    } else {
      for (const t of TICKER_TOOLS) suppressed.add(t)
    }
  }
  // 热点/世界杯：关键词自动注入已移除——改由 Agent 依 prompt 规则自决是否开面板。
  //   hotspot_mode/worldcup_mode 仍在 TOOL_GROUPS 里，Agent 想用时 find_tool 即可发现并当场装载。
  //   仅保留 TICK 心跳对 hotspot 的广注入：awakening exploration 阶段 agent 可能主动想浏览热点。
  if (isTick) {
    for (const t of HOTSPOT_TOOLS) out.add(t)
  }
  if (hitsPersonCardIntent(messageBody)) {
    for (const t of PERSON_CARD_TOOLS) out.add(t)
  }
  if (hits(body, FOCUS_BANNER_TRIGGERS) || hasTask) {
    for (const t of FOCUS_BANNER_TOOLS) out.add(t)
  }
  if (isSoftwareInstallRequest(messageBody)) {
    for (const t of SOFTWARE_INSTALL_TOOLS) out.add(t)
  }
  if (hits(body, ADMIN_TRIGGERS)) {
    for (const t of ADMIN_TOOLS) out.add(t)
  }
  // 成果审视：有任务时已随 TASK_CTRL_FULL 注入；这里覆盖"无任务但用户明确要求检查/验收成果"的临时场景。
  if (hits(body, REVIEW_TRIGGERS)) {
    for (const t of REVIEW_TOOLS) out.add(t)
  }
  // 注：TICK 路径不主动注入 memory 搜索之外的 search_memory（已在上面处理）。
  // TICK 时按需求注入：core + web + memory + reminders + prefetch + ticker + hotspot
  // → 已通过 isTick OR 分支覆盖。filesystem / exec / admin / media 仅靠关键词。

  // —— 多模态生成：mmCaps gate + 关键词命中 ——
  // 没配能力就别暴露工具（暴露了 agent 也调不通）。
  // 配了能力但本轮没关键词命中也省掉——TTS schema 三百字符不小，每轮都灌太亏。
  if (mmCaps.includes('tts')    && hits(body, TTS_TRIGGERS))       out.add(MM_GEN_TOOLS.tts)
  if (mmCaps.includes('lyrics') && hits(body, LYRICS_TRIGGERS))    out.add(MM_GEN_TOOLS.lyrics)
  if (mmCaps.includes('music')  && hits(body, MUSIC_GEN_TRIGGERS)) out.add(MM_GEN_TOOLS.music)
  if (mmCaps.includes('image')  && hits(body, IMAGE_GEN_TRIGGERS)) out.add(MM_GEN_TOOLS.image)
  // AI 视频生成：不 gate mmCaps，关键词命中即暴露（未配置时由工具返回值引导用户配置）
  if (hits(body, VIDEO_GEN_TRIGGERS)) out.add('generate_video')

  // —— ActionLog 保活 ——
  // 上轮（或最近 10 次）调用过的工具强制带上：跨轮工作流不能因为关键词没命中就断链。
  // 保活只覆盖白龙马的"已知工具"——installed 工具走单独的全注入路径。
  // 被抑制的工具(如 ticker 跨 turn 抑制下的 set_tick_interval)跳过 —— 否则模型刚调过又被
  // ActionLog 拉回来,抑制完全失效。
  if (Array.isArray(recentActionLog)) {
    for (const entry of recentActionLog) {
      const name = entry?.tool
      if (typeof name === 'string' && name && !suppressed.has(name)) out.add(name)
    }
  }

  // —— 用户安装的扩展工具：永远全注入（用户主动装的不能省） ——
  if (Array.isArray(installedToolNames)) {
    for (const name of installedToolNames) {
      if (name && !suppressed.has(name)) out.add(name)
    }
  }

  // —— Fastpath 收紧（可选） ——
  // 实时用户消息：保留 core + web 兜底 + 已命中关键词的所有组，不再额外补。
  // 当前实现里 fastUserPath 只是个 hint——上面的策略已经天然偏紧；这里仅
  // 防御性地不做扩张。（不在 fastpath 里删工具，避免误删导致 agent "我不能"）
  void fastUserPath

  // —— Fallback 安全网 ——
  // 目标：避免"消息没传明确意图、agent 啥专业能力都没有"的尴尬。
  // 阈值算法：CORE=7 + 通常 set_task=1 + senderId 带来 search_memory=1 = 9 是常态基线。
  // < 12 大致表示"基线之外几乎没多组专业能力"，此时补两组最常用兜底（web + filesystem）。
  if (out.size < 12) {
    for (const t of WEB_TOOLS) out.add(t)
    for (const t of FILESYSTEM_TOOLS) out.add(t)
  }

  // 最后一道兜底:被 suppressed 的工具不论谁加回来都剃掉。
  // 防御未来扩展时(新分组、新 fallback、新 marketplace 路径)破坏抑制语义。
  for (const name of suppressed) out.delete(name)

  return [...out]
}
