// A small, deliberately high-precision boundary between conversational text
// and requests that require an observable side effect.  This is not a general
// intent classifier: false positives here would turn ordinary Q&A into an
// annoying tool loop.  Add a contract only when the wording clearly asks the
// agent to change state or retrieve fresh external/local evidence.

const META_QUESTION_RE = /(?:你(?:有|会|能).{0,18}(?:工具|能力)|(?:多少|哪些|什么).{0,12}(?:工具|命令|能力)|工具.{0,12}(?:多少|哪些|什么)|怎么(?:调用|使用).{0,12}(?:工具|命令))/i

const CONTRACTS = [
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
    tools: ['exec_command', 'exec_quick_command', 'exec_task_command', 'exec_background_command'],
    pattern: /(?:请|帮我|给我)?\s*(?:运行|执行|启动|停止|杀掉|关闭).{0,40}(?:命令|程序|进程|服务|脚本|终端|powershell|bash|npm|node|python|server)|(?:run|execute|start|stop|kill)\s+(?:the\s+)?(?:command|process|server|script|npm|node|python)/i,
  },
  {
    id: 'web',
    label: '联网查询',
    tools: ['web_search', 'web_read'],
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
    tools: ['focus_banner', 'hotspot_mode', 'worldcup_mode', 'typhoon_mode', 'person_card_mode', 'ui_set'],
    pattern: /(?:打开|关闭|显示|隐藏).{0,30}(?:专注|热点|热搜|世界杯|台风|人物卡|面板|卡片)|(?:进入|退出).{0,12}(?:专注|心流|focus)/i,
  },
]

export function classifyActionContract(message = '') {
  const text = String(message || '').trim()
  if (!text || META_QUESTION_RE.test(text)) return null
  // “怎么/如何做” requests an explanation, not the side effect itself.
  if (/^(?:请问[，,：:]?\s*)?(?:怎么|如何|怎样|能否|可否|what\b|how\b)/i.test(text)) return null

  const match = CONTRACTS.find(contract => contract.pattern.test(text))
  if (!match) return null
  if (match.id === 'software_install' && /(?:工具|插件|plugin|npm|依赖|扩展)/i.test(text)) return null
  if (match.id === 'memory_write' && /(?:你|能).{0,12}记住.*[？?]$/i.test(text)) return null

  return {
    id: match.id,
    label: match.label,
    requiredTools: [...match.tools],
  }
}

export function actionContractToolSucceeded(contract, toolName, result) {
  if (!contract?.requiredTools?.includes(toolName)) return false
  const text = String(result || '').trim()
  if (!text) return true
  try {
    const parsed = JSON.parse(text)
    return parsed?.ok !== false && !parsed?.error
  } catch {
    return !/^(?:错误|请求失败|执行失败|命令超时|命令执行失败|error|failed|execution failed|command timed out)/i.test(text)
  }
}

export function containsUnsupportedCompletionClaim(text = '') {
  return /(?:已(?:经)?(?:完成|做好|创建|写入|保存|修改|更新|删除|打开|关闭|安装|执行)|(?:完成|创建|写入|保存|修改|更新|删除|打开|关闭|安装|执行)(?:好了|完成了)|(?:创建|写入|保存|修改|更新|删除|打开|关闭|安装|执行)(?:成功|完成)|搞定了|done|completed|created|installed|executed)/i.test(String(text || ''))
}
