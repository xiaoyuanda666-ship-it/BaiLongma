// A small, deliberately high-precision boundary between conversational text
// and requests that require an observable side effect.  This is not a general
// intent classifier: false positives here would turn ordinary Q&A into an
// annoying tool loop.  Add a contract only when the wording clearly asks the
// agent to change state or retrieve fresh external/local evidence.

import {
  inferBrowserDisplayMode,
  isExplicitBrowserDisplayModeRequest,
  isSystemBrowserRequest,
} from '../mcp/browser-display.js'
import { explicitlyKeepsBrowserOpen } from './browser-intent-guards.js'
import { filterStrictEvaluationTools } from './strict-evaluation.js'

const META_QUESTION_RE = /(?:你(?:有|会|能).{0,18}(?:工具|能力)|(?:多少|哪些|什么).{0,12}(?:工具|命令|能力)|工具.{0,12}(?:多少|哪些|什么)|怎么(?:调用|使用).{0,12}(?:工具|命令))/i
const BROWSER_NAVIGATION_URL_RE = /(?:https?:\/\/|www\.|(?:[\w-]+\.)+(?:com|cn|org|net|io)\b)/i
const BROWSER_INFORMATION_ACTION_RE = /(?:搜索|查询|查找|浏览(?!器)|阅读|播放|观看)|(?:search|browse|read|play|watch)\b/i
const BROWSER_OPEN_TARGET_RE = /(?:打开|访问|进入|前往|加载)\s*(?:一下\s*)?(?!这个(?:网页|页面)|当前(?:网页|页面)|刚才(?:的)?(?:网页|页面)|$)[\p{L}\p{N}]/iu
const BROWSER_OPEN_TARGET_EN_RE = /(?:open|visit|go\s+to|navigate\s+to|load)\s+(?!(?:this|the current|the previous)\s+(?:page|webpage)\b)[a-z0-9]/i
const BROWSER_CLOSE_RE = /(?:(?:关闭|关掉|退出).{0,12}(?:你的浏览器|白龙马浏览器|agent\s*浏览器|小窗口浏览器|大窗口浏览器|小浏览器|大浏览器|当前网页|当前页面|浏览器|网页|页面)|(?:close|quit|exit)\s+(?:your|the\s+bailongma|the\s+agent|the\s+current)?\s*(?:browser|webpage|page)\b)/i
const BROWSER_CLOSE_FILLER_RE = /(?:不用|无需|不要|别)(?:再)?(?:说话|解释|说明)|只(?:要|需)?(?:回复|回)?(?:一个)?(?:ok)?(?:的)?(?:👌)?(?:表情|图标)?|那(?:现在)?(?:怎么办)?|请|麻烦(?:你)?|帮我|帮忙|给我|现在|就|直接|真的|真正|先|再|把|将|好的?|行|可以|一下|吧|啊|呀|哦|呢|啦|谢谢(?:你)?|麻烦了|就行(?:了)?|即可|\b(?:please|now|just|simply|thanks|thank\s+you|do\s+it)\b/giu
const BROWSER_CLOSE_PUNCTUATION_RE = /[\s，。！？、；：,.!?;:'"“”‘’（）()\[\]{}<>《》…—-]/gu
const BROWSER_INTERACTION_TOOLS = [
  'browser_snapshot',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_press_key',
]
const BROWSER_LOGIN_REQUEST_RE = /(?:(?:帮我|请|给我|你(?:来|帮)|现在|直接).{0,18}(?:登录|登入)(?:.{0,20}(?:账号|帐号|网站|网页|x\b|twitter|google|谷歌))?|(?:登录|登入).{0,20}(?:我的|这个|该).{0,16}(?:账号|帐号|网站|网页|x\b|twitter))/i
const BROWSER_CONTINUATION_RE = /(?:^(?:没有|没).{0,8}(?:被墙|拦住|问题)|^(?:它|这个).{0,8}(?:能(?:走|打开|访问)|可以(?:走|打开|访问))|^(?:继续|再试|重试|接着|那就).{0,18}(?:登录|浏览器|网页|页面|操作)?$|^(?:continue|retry|go\s+on)\b)/i
const BROWSER_CONTEXT_RE = /(?:浏览器|网页|页面|登录|登入|账号|帐号|验证码|oauth|google|谷歌|\bx\b|twitter)/i
const MACOS_MUSIC_EXPLICIT_ACTION_RE = /(?:(?:播放|暂停|继续|恢复|停止|切换|打开|关闭|下一首|上一首|切歌|换一首).{0,20}(?:apple\s*music|music\.app|mac(?:os)?.{0,8}music|系统音乐|音乐播放器|音乐|歌曲|这首歌|当前歌曲|\bmusic\b)|(?:apple\s*music|music\.app|mac(?:os)?.{0,8}music|系统音乐|音乐播放器|这首歌|当前歌曲|\bmusic\b).{0,16}(?:播放|暂停|继续|恢复|停止|切换|打开|关闭|下一首|上一首|切歌|换一首)|(?:play|pause|resume|stop|open|next|previous).{0,16}(?:apple\s*music|music\.app|system music|current (?:song|track)))/i
const MACOS_MUSIC_BARE_CONTROL_RE = /^(?:请|帮我|现在|先|再|那就|好的?|直接|给我|把它|把这首歌|音乐)?\s*(?:暂停|继续|恢复播放|停止播放|播放|下一首|上一首|切歌|换一首|pause|resume|play|next|previous)\s*(?:一下|吧|音乐|这首|这首歌|歌曲|好吗|please)?[。.!！?？]*$/i
const MACOS_MUSIC_CONTEXT_RE = /(?:apple\s*music|music\.app|mac(?:os)?\s*(?:system\s*)?music|系统音乐|音乐播放器|播放.*(?:歌|音乐)|(?:歌|音乐).*(?:播放|暂停)|current track|playback state)/i
const MACOS_MUSIC_RUNTIME_RE = /\[macOS System Music\][\s\S]*(?:Music\.app is open|Authoritative playback state:)/i
const NEGATED_ACTION_START_RE = /^(?:(?:但(?:是)?|不过|然而|而是|而要|然后|接着|同时|并且|也|再|先|请|务必|千万|我(?:要求|希望|让)你)\s*)*(?:不要|别|无需|不用|请勿|禁止|不得)(?:再)?/iu
const NEGATED_ACTION_START_EN_RE = /^(?:(?:but|however|and|then|please|also)\s+)*(?:do\s+not|don't|never|must\s+not)\b/i

function browserInteractionContract(label = '检查并继续浏览器交互') {
  return {
    id: 'browser_interaction',
    label,
    requiredTools: [...BROWSER_INTERACTION_TOOLS],
  }
}

function hasRecentBrowserContext(conversationWindow = []) {
  return Array.isArray(conversationWindow)
    && conversationWindow.slice(-6).some(item => BROWSER_CONTEXT_RE.test(String(item?.content || '')))
}

function hasRecentMusicContext(conversationWindow = []) {
  return Array.isArray(conversationWindow)
    && conversationWindow.slice(-6).some(item => MACOS_MUSIC_CONTEXT_RE.test(String(item?.content || '')))
}

function hasAdditionalBrowserCloseTask(text = '') {
  // Treat the close as standalone only when everything outside the matched
  // close clause is known conversational filler. Unknown words are substantive
  // by default, so combined tasks cannot lose their real answer merely because
  // a new verb was absent from an enumerated intent regex.
  const remainder = String(text || '')
    .replace(BROWSER_CLOSE_RE, ' ')
    .replace(BROWSER_CLOSE_FILLER_RE, ' ')
    .replace(BROWSER_CLOSE_PUNCTUATION_RE, '')
  return remainder.length > 0
}

function isExplicitBrowserNavigationRequest(text = '') {
  const value = String(text || '').trim()
  return isExplicitBrowserDisplayModeRequest(value) && (
    BROWSER_NAVIGATION_URL_RE.test(value)
    || BROWSER_INFORMATION_ACTION_RE.test(value)
    || BROWSER_OPEN_TARGET_RE.test(value)
    || BROWSER_OPEN_TARGET_EN_RE.test(value)
  )
}

// Action contracts describe work the user wants performed. Explicitly
// forbidden work must not be turned into a mandatory tool call. Split only at
// strong clause boundaries and before an explicit negator, so a mixed request
// such as “不要删除旧文件，但创建新文件” still retains its positive action.
// This stays deliberately local to user intent classification; it does not
// scan assistant prose or guess missing tools from arbitrary keywords.
export function stripExplicitlyNegatedActionClauses(text = '') {
  const segmented = String(text || '')
    .replace(/[，,。！？!?；;\n]+/gu, '\n')
    .replace(/\s+(?=(?:but|however|then)\b)/giu, '\n')
    .replace(/(?=(?:但是|但|不过|然而|而是|而要|然后|接着|同时要))/gu, '\n')
    .replace(/([^\n])(?=(?:请\s*)?(?:不要|别|无需|不用|请勿|禁止|不得)(?:再)?)/gu, '$1\n')
    .replace(/([^\n])(?=(?:please\s+)?(?:do\s+not|don't|never|must\s+not)\b)/giu, '$1\n')

  return segmented
    .split('\n')
    .map(clause => clause.trim())
    .filter(Boolean)
    .filter(clause => !NEGATED_ACTION_START_RE.test(clause) && !NEGATED_ACTION_START_EN_RE.test(clause))
    .join('，')
}

const CONTRACTS = [
  {
    id: 'system_browser_open',
    label: '使用电脑浏览器打开网页',
    tools: ['system_browser_open'],
    match: isSystemBrowserRequest,
  },
  {
    id: 'browser_open_in_display_mode',
    label: '使用指定的白龙马浏览器打开网页',
    // Navigation already runs through the display mode selected
    // deterministically for this turn. Its browser_preview.mode is observable
    // evidence that both the requested presentation and navigation happened;
    // demanding an extra display-only call makes combined requests brittle.
    tools: ['browser_navigate'],
    match: isExplicitBrowserNavigationRequest,
    resolve: (text) => ({
      expectedBrowserDisplayMode: inferBrowserDisplayMode(text),
    }),
  },
  {
    id: 'browser_close',
    label: '真正关闭白龙马浏览器页面',
    tools: ['browser_close'],
    match: text => !explicitlyKeepsBrowserOpen(text) && BROWSER_CLOSE_RE.test(text),
    resolve: text => ({
      fixedReply: hasAdditionalBrowserCloseTask(text) ? '' : '👌',
    }),
  },
  {
    id: 'browser_display_mode',
    label: '切换浏览器显示大小',
    tools: ['browser_set_display_mode'],
    match: isExplicitBrowserDisplayModeRequest,
  },
  {
    id: 'browser_interaction',
    label: '检查并继续浏览器交互',
    tools: BROWSER_INTERACTION_TOOLS,
    match: text => BROWSER_LOGIN_REQUEST_RE.test(text),
  },
  {
    id: 'directory_create',
    label: '创建目录',
    tools: ['make_dir'],
    pattern: /(?:创建|新建).{0,40}(?:目录|文件夹|folder|directory)/i,
  },
  {
    id: 'file_delete',
    label: '删除文件',
    tools: ['delete_file'],
    pattern: /(?:删除|删掉|清理).{0,40}(?:文件|文档|代码|脚本|配置|readme|\.md\b|\.txt\b|\.json\b|\.js\b|\.py\b|\.html\b)/i,
  },
  {
    id: 'file_write',
    label: '写入或修改文件',
    tools: ['write_file'],
    pattern: /(?:创建|新建|写入|保存|修改|编辑|更新).{0,40}(?:文件|文档|代码|脚本|配置|readme|\.md\b|\.txt\b|\.json\b|\.js\b|\.py\b|\.html\b)|(?:帮我|请).{0,24}(?:改|修|写).{0,30}(?:代码|项目|脚本|页面|文件)/i,
  },
  {
    id: 'command',
    label: '执行命令或启动程序',
    tools: ['run_command'],
    pattern: /(?:请|帮我|给我)?\s*(?:运行|执行|启动|停止|杀掉|关闭).{0,40}(?:命令|程序|进程|服务|脚本|终端|powershell|bash|npm|node|python|server)|(?:run|execute|start|stop|kill)\s+(?:the\s+)?(?:command|process|server|script|npm|node|python)/i,
  },
  {
    id: 'web',
    label: '联网查询',
    // Requiring navigation prevents a stale snapshot/current-tab inspection
    // from being mistaken for a fresh web lookup. The normal router injects the
    // rest of the safe Playwright group for snapshot/find/click follow-through.
    tools: ['browser_navigate'],
    pattern: /(?:帮我|请|给我).{0,12}(?:上网|联网|搜索|查一下|查一查|检索|找一下|浏览).{0,40}|(?:搜索|查询|查找).{0,30}(?:网页|网站|新闻|资料|链接|网址)|\b(?:search|browse|look\s+up|fetch)\b/i,
  },
  {
    id: 'reminder',
    label: '创建或变更提醒',
    tools: ['manage_reminder'],
    pattern: /(?:提醒我|帮我提醒|设(?:置|一个).{0,12}提醒|取消.{0,12}提醒|删除.{0,12}提醒|remind me|set (?:a )?reminder)/i,
  },
  {
    id: 'memory_write',
    label: '保存记忆',
    tools: ['upsert_memory'],
    pattern: /(?:记住|记一下|帮我记|存到记忆|保存到记忆).{0,80}/i,
  },
  {
    id: 'software_install',
    label: '发起软件安装',
    tools: ['install_software'],
    pattern: /(?:帮我|请|给我).{0,16}(?:安装|装上|下载并安装).{0,40}(?:软件|应用|app|程序)?|(?:install|set up)\s+.+/i,
  },
  {
    id: 'ui_action',
    label: '更新界面状态',
    tools: ['focus_banner', 'hotspot_mode', 'worldcup_mode', 'typhoon_mode', 'ui_set'],
    pattern: /(?:打开|关闭|显示|隐藏).{0,30}(?:专注|热点|热搜|世界杯|台风|面板)|(?:进入|退出).{0,12}(?:专注|心流|focus)/i,
  },
]

export function classifyActionContract(message = '', { conversationWindow = [], runtimeContext = '' } = {}) {
  const text = String(message || '').trim()
  if (!text || META_QUESTION_RE.test(text)) return null
  // “怎么/如何做” requests an explanation, not the side effect itself.
  if (/^(?:请问[，,：:]?\s*)?(?:怎么|如何|怎样|能否|可否|what\b|how\b)/i.test(text)) return null
  const actionText = stripExplicitlyNegatedActionClauses(text)
  if (!actionText) return null

  if (process.platform === 'darwin' && (
    MACOS_MUSIC_EXPLICIT_ACTION_RE.test(actionText)
    || (MACOS_MUSIC_BARE_CONTROL_RE.test(actionText) && (
      hasRecentMusicContext(conversationWindow)
      || MACOS_MUSIC_RUNTIME_RE.test(String(runtimeContext || ''))
    ))
  )) {
    return {
      id: 'macos_system_music',
      label: '控制 macOS Music.app 播放状态',
      requiredTools: ['system_music'],
    }
  }

  // “没有被墙，它能走”这类承接话没有动作动词，但在一个正在进行的登录/网页任务里
  // 明确要求继续。把它绑定到最近的浏览器上下文，避免模型把想象中的进度当成已发生的操作。
  if (BROWSER_CONTINUATION_RE.test(actionText) && hasRecentBrowserContext(conversationWindow)) {
    return browserInteractionContract('继续当前浏览器交互')
  }

  const match = CONTRACTS.find(contract => (
    typeof contract.match === 'function'
      ? contract.match(actionText)
      : contract.pattern.test(actionText)
  ))
  if (!match) return null
  if (match.id === 'software_install' && /(?:工具|插件|plugin|npm|依赖|扩展)/i.test(actionText)) return null
  if (match.id === 'memory_write' && /(?:你|能).{0,12}记住.*[？?]$/i.test(actionText)) return null

  return {
    id: match.id,
    label: match.label,
    requiredTools: [...match.tools],
    ...(typeof match.resolve === 'function' ? match.resolve(actionText) : {}),
  }
}

// The production turn binds this immediately before routing tools.  Applying
// strict-mode exclusions here means the evidence gate can never demand a
// tool that the same turn is forbidden to call.
export function resolveActionContractForTurn(message = '', {
  conversationWindow = [],
  runtimeContext = '',
  strictEvaluation = null,
} = {}) {
  const contract = classifyActionContract(message, { conversationWindow, runtimeContext })
  if (!contract) return null
  const requiredTools = filterStrictEvaluationTools(contract.requiredTools, strictEvaluation)
  return requiredTools.length > 0 ? { ...contract, requiredTools } : null
}

export function actionContractToolSucceeded(contract, toolName, result) {
  if (!contract?.requiredTools?.includes(toolName)) return false
  const text = String(result || '').trim()
  if (!text) return true
  try {
    const parsed = JSON.parse(text)
    if (parsed?.ok === false || parsed?.error) return false
    if (contract.id === 'browser_open_in_display_mode') {
      return parsed?.browser_preview?.mode === contract.expectedBrowserDisplayMode
    }
    return true
  } catch {
    return !/^(?:错误|请求失败|执行失败|命令超时|命令执行失败|error|failed|execution failed|command timed out)/i.test(text)
  }
}

function hasSuccessfulBrowserTool(options, names) {
  const successful = options?.successfulToolNames
  if (!successful) return false
  const values = successful instanceof Set ? successful : new Set(successful)
  return names.some(name => values.has(name))
}

function browserInteractionCompletionIssue(text = '', options = {}) {
  const value = String(text || '').trim()
  if (!value) return ''
  const explicitlyUnconfirmedLogin = /(?:尚未|未|不能|无法|未能|不(?:能|可)?确认).{0,12}(?:登录|登入)/i.test(value)

  // A browser snapshot proves only that the current page was observed. It is
  // not evidence that navigation, typing, clicking, or authentication worked.
  if (!explicitlyUnconfirmedLogin
      && /(?:登录|登入).{0,8}(?:成功|完成|好了|进去了)|(?:已|已经).{0,12}(?:登录|登入)(?!页)/i.test(value)) {
    return 'A browser action did not verify that authentication succeeded. Report only the observed page state or ask the user to complete the login step.'
  }
  if (/(?:(?:已|已经|直接).{0,12}(?:打开|导航|跳转|加载).{0,18}(?:网页|页面|登录页|x\b|twitter)|(?:网页|页面|登录页|x\b|twitter).{0,12}(?:打开|导航|跳转|加载|显示))/i.test(value)
      && !hasSuccessfulBrowserTool(options, ['browser_navigate'])) {
    return 'The reply claims navigation/opening, but this turn has no successful browser_navigate result.'
  }
  if (/(?:已|已经).{0,12}(?:填好|填写|填入|输入).{0,18}(?:用户名|邮箱|密码|账号|帐号|输入框|字段)/i.test(value)
      && !hasSuccessfulBrowserTool(options, ['browser_type', 'browser_fill_form', 'browser_press_key'])) {
    return 'The reply claims form input, but this turn has no successful browser_type, browser_fill_form, or browser_press_key result.'
  }
  if (/(?:已|已经).{0,12}(?:点击|点了).{0,18}(?:下一步|登录|按钮|继续)/i.test(value)
      && !hasSuccessfulBrowserTool(options, ['browser_click', 'browser_press_key'])) {
    return 'The reply claims a click/submit, but this turn has no successful browser_click or browser_press_key result.'
  }
  if (/(?:到|进入|跳到).{0,12}(?:密码页|下一页|验证页)/i.test(value)
      && !(hasSuccessfulBrowserTool(options, ['browser_snapshot'])
        && hasSuccessfulBrowserTool(options, ['browser_click', 'browser_press_key']))) {
    return 'The reply claims a later login page without both an observed snapshot and a successful submit/navigation action.'
  }
  return ''
}

export function actionContractCompletionIssue(contract, text = '', options = {}) {
  if (contract?.id === 'browser_interaction') {
    return browserInteractionCompletionIssue(text, options)
  }
  if (contract?.id !== 'system_browser_open') return ''
  const value = String(text || '').trim()
  if (!value) return ''
  if (/(?:\b(?:safari|chrome|edge|firefox|arc|opera|brave)\b|谷歌浏览器|苹果浏览器)/i.test(value)) {
    return 'The tool verified only the computer default browser, not the browser application name.'
  }
  if (/(?:三个|三种).{0,16}浏览器.{0,20}(?:各自|彼此|互相|完全)?.{0,10}(?:独立|不共享|互不影响)/i.test(value)
      || /(?:你的浏览器).{0,30}(?:我的浏览器).{0,30}(?:各自独立|彼此独立|互不影响|不共享)/i.test(value)) {
    return 'Bailongma compact and large modes share one live page/profile; only the computer browser is separate.'
  }
  return ''
}

export function verifiedActionContractReply(contract, evidence = {}) {
  if (contract?.id === 'browser_close') return String(contract?.fixedReply || '')
  if (contract?.id !== 'system_browser_open') return ''
  let url = String(evidence?.args?.url || '').trim()
  try {
    const parsed = JSON.parse(String(evidence?.result || '{}'))
    if (parsed?.url) url = String(parsed.url)
  } catch {}
  const target = url ? `链接 \`${url}\`` : '链接'
  return `已将${target}交给电脑的系统默认浏览器打开。白龙马的“小窗口浏览器”和“大窗口浏览器”是同一个实时页面的两种显示形态；电脑浏览器与它们独立。`
}

export function containsUnsupportedCompletionClaim(text = '') {
  return /(?:已(?:经)?(?:完成|做好|创建|写入|保存|修改|更新|删除|打开|关闭|安装|执行)|(?:完成|创建|写入|保存|修改|更新|删除|打开|关闭|安装|执行)(?:好了|完成了)|(?:创建|写入|保存|修改|更新|删除|打开|关闭|安装|执行)(?:成功|完成)|搞定了|done|completed|created|installed|executed)/i.test(String(text || ''))
}
