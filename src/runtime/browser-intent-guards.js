const KEEP_BROWSER_OPEN_PATTERNS = [
  /(?:不要|不必|不用|无需|请勿|勿|别|莫).{0,8}(?:关闭|关掉|关上|关|退出|离开).{0,10}(?:你的|白龙马|agent\s*)?(?:浏览器|当前网页|当前页面|网页|页面)/i,
  /(?:不要|不必|不用|无需|请勿|勿|别|莫).{0,8}(?:关闭|关掉|关上|关|退出|离开)(?:它|这个网页|这个页面|当前网页|当前页面)?(?:[，,。.!！?？\s]|$)/i,
  /(?:保持|继续保持|让).{0,10}(?:浏览器|当前网页|当前页面|网页|页面).{0,8}(?:打开|开着|开启|显示|停留)/i,
  /(?:保持|继续保持|让).{0,8}(?:打开|开着|开启).{0,10}(?:浏览器|当前网页|当前页面|网页|页面)/i,
  /(?:浏览器|当前网页|当前页面|网页|页面).{0,8}(?:保持打开|保持开着|继续开着|不要关|别关)/i,
  /(?:do\s+not|don't|dont|never)\s+(?:close|quit|exit)\s+(?:the\s+)?(?:browser|page|webpage)\b/i,
  /(?:keep|leave)\s+(?:the\s+)?(?:browser|page|webpage)\s+open\b/i,
]

const EXPLICIT_NO_LOCAL_TOOLS_RE = /(?:不要|别|请勿|禁止|不许|无需|不用).{0,16}(?:本地文件|本地目录|本地项目|工作区|文件系统).{0,8}(?:工具|能力|搜索|查找|读取|访问)?|(?:不要|别|请勿|禁止|不许).{0,12}(?:read_file|list_dir|find_tool)|(?:do\s+not|don't|dont|never).{0,18}(?:local\s+(?:file|filesystem|project|workspace)|read_file|list_dir)/i
const WEB_SCOPE_RE = /(?:网页|网站|浏览器|远程\s*github|github\s*(?:远端|页面|网站)|在线|上网|联网|https?:\/\/)|(?:web(?:page|site)?|browser|remote\s+github|github\s+(?:page|website)|online)\b/i
const COMBINED_SCOPE_RE = /(?:同时|并且|以及|还要|也要|都要|分别)|\b(?:also|both|and)\b/i
const EXPLICIT_LOCAL_SCOPE_RE = /(?:检查|查看|搜索|查找|读取|对比).{0,16}(?:本地|项目内|工作区|本地文件|本地目录|代码)|(?:本地|项目内|工作区).{0,16}(?:检查|查看|搜索|查找|读取|文件|目录|代码)|(?:check|search|inspect|read|compare).{0,16}(?:local|project|workspace|file|code)/i
const LOCAL_DISCOVERY_QUERY_RE = /(?:本地|项目|工作区|文件|目录|代码|read_file|list_dir|find\s+(?:a\s+)?(?:local\s+)?file|local\s+(?:file|filesystem|project|workspace)|directory|source\s+code)/i

export function explicitlyKeepsBrowserOpen(message = '') {
  const text = String(message || '').trim()
  return Boolean(text && KEEP_BROWSER_OPEN_PATTERNS.some(pattern => pattern.test(text)))
}

export function explicitlyForbidsLocalFileTools(message = '') {
  return EXPLICIT_NO_LOCAL_TOOLS_RE.test(String(message || ''))
}

export function isExplicitCombinedWebAndLocalTask(message = '') {
  const text = String(message || '')
  return WEB_SCOPE_RE.test(text) && COMBINED_SCOPE_RE.test(text) && EXPLICIT_LOCAL_SCOPE_RE.test(text)
}

export function isWebOnlyTask(message = '') {
  const text = String(message || '')
  return WEB_SCOPE_RE.test(text) && !isExplicitCombinedWebAndLocalTask(text)
}

export function isLocalFileToolCallBlocked(name, args = {}, message = '') {
  const tool = String(name || '')
  const explicitlyForbidden = explicitlyForbidsLocalFileTools(message)
  const webOnly = isWebOnlyTask(message)
  if (!explicitlyForbidden && !webOnly) return false

  if (['read_file', 'list_dir'].includes(tool)) return true
  if (explicitlyForbidden && ['write_file', 'edit_file', 'delete_file', 'make_dir'].includes(tool)) return true
  if (tool !== 'find_tool') return false
  const query = String(args?.query || args?.description || args?.capability || '')
  return LOCAL_DISCOVERY_QUERY_RE.test(query)
}
