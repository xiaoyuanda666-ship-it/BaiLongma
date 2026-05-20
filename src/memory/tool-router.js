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

// ---- 工具分组 ----
//
// core：任何场景都注入。ACUI 工具默认带上（白龙马侧 Phase 1 决策，组件少 token 便宜）。
const CORE_TOOLS = [
  'send_message',
  'recall_memory',
  'ui_show', 'ui_update', 'ui_hide', 'ui_register', 'ui_patch',
]

const TASK_CTRL_FULL    = ['set_task', 'complete_task', 'update_task_step']
const TASK_CTRL_OPENER  = ['set_task']  // 没任务时只暴露 set_task

const WEB_TOOLS         = ['web_search', 'fetch_url', 'browser_read']
const FILESYSTEM_TOOLS  = ['read_file', 'write_file', 'delete_file', 'list_dir', 'make_dir']
const EXEC_TOOLS        = ['exec_command', 'kill_process', 'list_processes']
const MEDIA_TOOLS       = ['media_mode', 'music']
const REMINDER_TOOLS    = ['manage_reminder']
const PREFETCH_TOOLS    = ['manage_prefetch_task']
const TICKER_TOOLS      = ['set_tick_interval']
const HOTSPOT_TOOLS     = ['hotspot_mode']
const PERSON_CARD_TOOLS = ['person_card_mode']
const FOCUS_BANNER_TOOLS = ['focus_banner']
const ADMIN_TOOLS       = [
  'install_tool', 'uninstall_tool', 'list_tools',
  'set_security', 'connect_wechat',
  'set_location', 'set_agent_name', 'manage_app',
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

const PERSON_CARD_TRIGGERS = [
  '介绍', '是谁', '是个什么人', '是什么人', '百科', '人物', '生平', '简介',
  'who is', 'tell me about', 'wiki', 'biography', 'background',
]

const FOCUS_BANNER_TRIGGERS = [
  '专注', '沉浸', '小目标', '目标定', '横幅', '锁定', '别打扰', '勿扰',
  'focus mode', 'banner', 'do not disturb', 'dnd', 'immersive',
]

const ADMIN_TRIGGERS = [
  '装一下', '安装', '装个', '卸载', '装好', '装上', '工具市场', '插件',
  '安全', '沙箱', '权限', '微信', '绑定', '连接', '配对',
  '位置', '在哪', '改名字', '改名', '叫你', '叫我', '管理应用', 'app 列表',
  'install tool', 'uninstall', 'plugin', 'security', 'sandbox', 'wechat',
  'connect ', 'location', 'rename', 'apps',
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

// 通用辅助：消息正文里是否含有给定触发词之一（lower-case 包含）。
// 全部走 includes —— 中文不需要词边界，英文混进来无所谓多注入。
function hits(body, triggers) {
  if (!body) return false
  for (const t of triggers) {
    if (body.includes(t)) return true
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

  // 任务控制：有任务 → 全组；没任务 → 仅 set_task（用户能开任务）
  for (const t of (hasTask ? TASK_CTRL_FULL : TASK_CTRL_OPENER)) out.add(t)

  // 记忆搜索：跟原行为对齐
  if (senderId || hasRecall || isTick) out.add('search_memory')

  // 启动自检
  if (startupSelfCheckActive) out.add('complete_startup_self_check')

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
  }
  if (hits(body, REMINDER_TRIGGERS) || isTick) {
    for (const t of REMINDER_TOOLS) out.add(t)
  }
  if (hits(body, PREFETCH_TRIGGERS) || isTick) {
    for (const t of PREFETCH_TOOLS) out.add(t)
  }
  if (hits(body, TICKER_TRIGGERS) || isTick) {
    for (const t of TICKER_TOOLS) out.add(t)
  }
  if (hits(body, HOTSPOT_TRIGGERS) || isTick) {
    for (const t of HOTSPOT_TOOLS) out.add(t)
  }
  if (hits(body, PERSON_CARD_TRIGGERS)) {
    for (const t of PERSON_CARD_TOOLS) out.add(t)
  }
  if (hits(body, FOCUS_BANNER_TRIGGERS) || hasTask) {
    for (const t of FOCUS_BANNER_TOOLS) out.add(t)
  }
  if (hits(body, ADMIN_TRIGGERS)) {
    for (const t of ADMIN_TOOLS) out.add(t)
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

  // —— ActionLog 保活 ——
  // 上轮（或最近 10 次）调用过的工具强制带上：跨轮工作流不能因为关键词没命中就断链。
  // 保活只覆盖白龙马的"已知工具"——installed 工具走单独的全注入路径。
  if (Array.isArray(recentActionLog)) {
    for (const entry of recentActionLog) {
      const name = entry?.tool
      if (typeof name === 'string' && name) out.add(name)
    }
  }

  // —— 用户安装的扩展工具：永远全注入（用户主动装的不能省） ——
  if (Array.isArray(installedToolNames)) {
    for (const name of installedToolNames) {
      if (name) out.add(name)
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

  return [...out]
}
