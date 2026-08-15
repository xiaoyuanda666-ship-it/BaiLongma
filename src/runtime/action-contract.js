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
const BROWSER_CLOSE_RE = /(?:(?:关闭|关掉|退出).{0,12}(?:你的浏览器|白龙马浏览器|agent\s*浏览器|小窗口浏览器|大窗口浏览器|小浏览器|大浏览器|当前网页|当前页面|浏览器|网页|页面)|(?:你的浏览器|白龙马浏览器|agent\s*浏览器|小窗口浏览器|大窗口浏览器|小浏览器|大浏览器|浏览器).{0,8}(?:关一下|关了|关闭|关掉)|(?:close|quit|exit)\s+(?:your|the\s+bailongma|the\s+agent|the\s+current)?\s*(?:browser|webpage|page)\b)/i
const BROWSER_SCREENSHOT_RE = /(?:(?:截|截图)(?:一?张|个)?(?:当前|现在|这个|网页|页面|浏览器|这一屏|整页)?.{0,16}(?:图|给我|发我|看看|看一下)?|(?:给我|发我|让我看看).{0,12}(?:截图|截屏)|take\s+(?:a\s+)?screenshot)/i
const BROWSER_PAGE_SCOPE_RE = /(?:这个|当前|现在|本|这一个)(?:网页|页面)|(?:这|当前)页|(?:网页|页面)(?:里|内|中|上)|(?:this|current)\s+(?:page|webpage)/i
const BROWSER_PAGE_FIND_ACTION_RE = /(?:有没有|有无|是否(?:有|包含)|包含|找(?:一下|一找)?|查找|搜(?:一下|索)?|出现(?:了)?(?:几|多少|\d+)?(?:次|处)?|几处|几次|多少次|find|look\s+for|contain|occur|how\s+many)/i
const BROWSER_SEARCH_BOX_SUBMIT_RE = /(?:在\s*)?(?:(?:这个|当前)(?:网页|页面)?\s*)?搜索框(?:里|内|中)?\s*(?:输入|填入|键入)\s*[“‘'"]?(.{1,120}?)[”’'"]?\s*(?:并|然后|再)?\s*(?:点击\s*)?(?:搜索|查找|提交|搜一下)(?:按钮)?(?:一下)?[。.!！?？]*$/iu
const BROWSER_SEARCH_RESULT_CLICK_RE = /(?:点开|打开|点击|进入)\s*(?:第\s*)?([\d一二两三四五六七八九十]+)\s*(?:个|条)?\s*(?:搜索)?结果(?:项|链接)?/iu
const BROWSER_RESULT_LIST_CORRECTION_RE = /^(?:(?:不是(?:详情页?|详情|原文页?|内容页?)[，,]\s*)?(?:我(?:要|要的是)|我要的是)?\s*(?:回(?:到|去)?(?:刚才的)?(?:搜索)?结果(?:列表)?页|回(?:到|去)?(?:搜索)?结果列表|回(?:到|去)?列表(?:页)?)|不对[，,]\s*(?:我(?:要|要的是)\s*)?(?:回(?:到|去)?(?:搜索)?结果(?:列表)?页?|回(?:到|去)?列表(?:页)?)|我说的是(?:搜索)?结果(?:列表)?页|我要的是(?:搜索)?结果(?:列表)?页|别进(?:详情页?|详情|原文页?|原文)[，,]\s*回(?:到|去)?(?:(?:搜索)?结果)?列表(?:页)?)[。.!！?？]*$/iu
const COLLOQUIAL_OFFICIAL_SITE_LOOKUP_RE = /^(?:再\s*)?(?:(?:帮我|给我|麻烦你|请)\s*)?(?:查查(?:看)?|查查看|找找|帮我看看|看看)\s*[“‘'"]?(.{1,80}?)[”’'"]?\s*(?:的)?(?:官方网站|官网)[。.!！?？]*$/iu
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
const WEB_RESEARCH_REQUEST_RE = /(?:今天|今日|最近|近期|最新|刚刚|这两天|这几天|本周).{0,20}(?:新闻|消息|动态|资讯|热点|新鲜事|发生(?:了)?(?:什么|啥)|有(?:什么|啥)(?:大事|动静)|有何动静|都在聊什么)|(?:新闻|消息|动态|资讯|热点).{0,16}(?:挑|找|搜|查|看看|看下|有什么|有哪些|怎么回事)|(?:说说|聊聊|讲讲|看看).{0,10}(?:今天|今日|最近|近期|这两天|这几天|本周).{0,20}(?:大事|动静|发生)|(?:AI|人工智能|科技|芯片|行业|市场|政策|OpenAI|苹果|谷歌|微软).{0,12}(?:最近|最新).{0,12}(?:进展|更新|变化)|(?:today|recent|latest|current).{0,16}(?:news|headlines|updates)|(?:news|headlines).{0,16}(?:today|recent|latest|current)/i
const WEB_FRESH_FACT_REQUEST_RE = /(?:现在|目前|今天|今日|实时|最新).{0,18}(?:价格|报价|金价|油价|汇率|股价|大盘|指数|比分|排名|票房|天气|航班)|(?:比特币|btc|黄金|金价|油价|汇率|股价|股票|大盘|指数|票房|比分|排名|天气|航班|软件版本|系统版本).{0,18}(?:多少|什么价|怎么样|涨了|跌了|现在|目前|今天|实时|最新)/i
const NEGATED_ACTION_START_RE = /^(?:(?:但(?:是)?|不过|然而|而是|而要|然后|接着|同时|并且|也|再|先|请|务必|千万|我(?:要求|希望|让)你)\s*)*(?:不要|别|无需|不用|请勿|禁止|不得)(?:再)?/iu
const NEGATED_ACTION_START_EN_RE = /^(?:(?:but|however|and|then|please|also)\s+)*(?:do\s+not|don't|never|must\s+not)\b/i

function browserInteractionContract(label = '检查并继续浏览器交互') {
  return {
    id: 'browser_interaction',
    label,
    requiredTools: [...BROWSER_INTERACTION_TOOLS],
  }
}

export function isBrowserPageFindRequest(text = '') {
  const value = String(text || '')
  return BROWSER_PAGE_SCOPE_RE.test(value) && BROWSER_PAGE_FIND_ACTION_RE.test(value)
}

export function extractBrowserPageFindQuery(text = '') {
  const value = String(text || '').trim()
  const quoted = value.match(/[“‘'\"]([^”’'\"]{1,120})[”’'\"]/)
  if (quoted?.[1]) return quoted[1].trim()

  const candidates = [
    value.match(/(.{1,120}?)\s*(?:在|于)(?:这个|当前|现在|本|这一个|这)?(?:网页|页面|页)(?:里|内|中|上)?\s*(?:出现(?:了)?(?:几|多少)?(?:次|处)|有几处|有几次|出现次数)/i)?.[1],
    value.match(/(?:有没有|有无|是否(?:有|包含)|包含)\s*[“‘'\"]?(.{1,120}?)(?:[”’'\"]?\s*(?:这几个字|几个字|这个词|这个短语|吗|呢|，|,|。|\?|？|$))/i)?.[1],
    value.match(/(?:找(?:一下|一找)?|查找|搜(?:一下|索)?)\s*[“‘'\"]?(.{1,120}?)(?:[”’'\"]?\s*(?:这几个字|几个字|这个词|这个短语|，|,|。|\?|？|$))/i)?.[1],
    value.match(/(?:find|look\s+for|count)\s+["']?(.{1,120}?)["']?\s+(?:in|on)\s+(?:this|the\s+current)\s+(?:page|webpage)/i)?.[1],
  ]
  for (const candidate of candidates) {
    const cleaned = String(candidate || '')
      .replace(/^(?:一下|一找)\s*/, '')
      .replace(/\s*(?:这几个字|几个字|这个词|这个短语)$/i, '')
      .trim()
    if (cleaned) return cleaned
  }
  return ''
}

function chineseCount(value = '') {
  const normalized = String(value || '').trim()
  if (/^\d+$/.test(normalized)) return Number(normalized)
  const digits = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  if (normalized === '十') return 10
  if (normalized.startsWith('十')) return 10 + (digits[normalized.slice(1)] || 0)
  if (normalized.endsWith('十')) return (digits[normalized.slice(0, -1)] || 0) * 10
  if (normalized.includes('十')) {
    const [tens, ones] = normalized.split('十')
    return (digits[tens] || 0) * 10 + (digits[ones] || 0)
  }
  return digits[normalized] || 0
}

export function inferWebResearchSourceCount(text = '') {
  const value = String(text || '')
  const match = value.match(/([\d零一二两三四五六七八九十]+)\s*(?:条|个|篇|则)(?:新闻|消息|动态|资讯|报道)?/i)
  const requested = match ? chineseCount(match[1]) : 0
  if (requested > 0) return requested
  if (/(?:这个|这条|这则|该).{0,8}(?:新闻|消息|报道)|(?:新闻|消息).{0,8}怎么回事|what\s+happened\s+with/i.test(value)) return 1
  return 3
}

function safeJson(value) {
  try { return JSON.parse(String(value || '{}')) } catch { return null }
}

function normalizedEvidenceUrl(value = '') {
  try {
    const url = new URL(String(value || '').trim())
    if (!/^https?:$/.test(url.protocol)) return ''
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_.+|spm|from|source|ref|referrer|campaign)$/i.test(key)) url.searchParams.delete(key)
    }
    const text = url.toString()
    return text.endsWith('/') && url.pathname !== '/' ? text.slice(0, -1) : text
  } catch {
    return ''
  }
}

function isSearchOrListingUrl(value = '') {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    const path = url.pathname.toLowerCase().replace(/\/+$/, '') || '/'
    if (/(?:^|\.)bing\.com$/.test(host) && (path === '/search' || path === '/news/search')) return true
    if (/(?:^|\.)google\.[a-z.]+$/.test(host) && path === '/search') return true
    if (/(?:^|\.)baidu\.com$/.test(host) && (path === '/s' || path === '/baidu')) return true
    if (/(?:^|\.)duckduckgo\.com$/.test(host) && (url.searchParams.has('q') || path === '/html')) return true
    if (host === 'search.yahoo.com' || /\/(?:search|search-results?|results)$/.test(path)) return true
    return new Set(['/', '/news', '/latest', '/headlines', '/articles', '/blog', '/index']).has(path)
  } catch {
    return true
  }
}

function likelyArticleUrl(value = '') {
  if (!value || isSearchOrListingUrl(value)) return false
  try {
    const path = new URL(value).pathname.replace(/\/+$/, '')
    const segments = path.split('/').filter(Boolean)
    if (segments.length >= 2) return true
    const last = segments[0] || ''
    return last.length >= 12 || /[-_]|\.(?:html?|shtml|php|aspx)$/i.test(last)
  } catch {
    return false
  }
}

function resultSnapshot(parsed) {
  return parsed?.structured_content?.snapshot
    || parsed?.structuredContent?.snapshot
    || parsed?.snapshot
    || null
}

function resultUrl(parsed, evidence = {}) {
  const snapshot = resultSnapshot(parsed)
  return normalizedEvidenceUrl(
    parsed?.url
    || parsed?.final_url
    || parsed?.finalUrl
    || parsed?.browser_preview?.url
    || snapshot?.url
    || evidence?.args?.url
    || '',
  )
}

function resultTitle(parsed) {
  const snapshot = resultSnapshot(parsed)
  return String(parsed?.title || parsed?.browser_preview?.title || snapshot?.name || '').replace(/\s+/g, ' ').trim()
}

function resultEvidenceText(parsed) {
  const content = Array.isArray(parsed?.content)
    ? parsed.content.map(item => String(item?.text || '')).join('\n')
    : ''
  return `${content}\n${JSON.stringify(resultSnapshot(parsed) || {})}`
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizedSearchText(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/(?:官方网站|官方站点|官网|网站|网页|主页|首页)/gu, ' ')
    .replace(/[\p{P}\p{S}\s]+/gu, ' ')
    .trim()
}

function meaningfulQueryTerms(value = '') {
  const normalized = normalizedSearchText(value)
  if (!normalized) return []
  const latin = normalized.match(/[a-z0-9][a-z0-9._+-]*/g) || []
  const han = normalized.match(/[\p{Script=Han}]{2,}/gu) || []
  return [...new Set([...latin, ...han])].filter(term => term.length >= 2)
}

function textMatchesQuery(value = '', query = '') {
  const haystack = normalizedSearchText(value).replace(/\s+/g, '')
  const terms = meaningfulQueryTerms(query)
  return terms.length > 0 && terms.some(term => haystack.includes(term.replace(/\s+/g, '')))
}

function isSearchEngineResultsUrl(value = '') {
  try {
    const url = new URL(String(value || ''))
    const host = url.hostname.toLowerCase()
    const path = url.pathname.toLowerCase().replace(/\/+$/, '') || '/'
    if (/(?:^|\.)bing\.com$/.test(host)) return path === '/search' || path === '/news/search'
    if (/(?:^|\.)google\.[a-z.]+$/.test(host)) return path === '/search'
    if (/(?:^|\.)baidu\.com$/.test(host)) return path === '/s' || path === '/baidu'
    if (/(?:^|\.)duckduckgo\.com$/.test(host)) return url.searchParams.has('q') || path === '/html'
    return host === 'search.yahoo.com'
  } catch {
    return false
  }
}

function resultPageState(result, evidence = {}) {
  const parsed = safeJson(result)
  if (!parsed || parsed.ok === false || parsed.error) return null
  return {
    url: resultUrl(parsed, evidence),
    title: resultTitle(parsed),
    text: resultEvidenceText(parsed),
  }
}

function latestBrowserPageState(evidenceList = []) {
  for (const evidence of [...(Array.isArray(evidenceList) ? evidenceList : [])].reverse()) {
    if (!['browser_type', 'browser_snapshot', 'browser_click', 'browser_navigate'].includes(evidence?.name)) continue
    const state = resultPageState(evidence?.result, evidence)
    if (state) return state
  }
  return null
}

function searchResultUrlMatchesQuery(urlValue = '', query = '') {
  if (!isSearchEngineResultsUrl(urlValue)) return false
  try {
    const url = new URL(urlValue)
    const queryValue = ['q', 'query', 'wd', 'word', 'keyword', 'search_query', 'text']
      .map(key => url.searchParams.get(key) || '')
      .find(Boolean) || decodeURIComponent(`${url.pathname} ${url.search}`)
    return textMatchesQuery(queryValue, query)
  } catch {
    return false
  }
}

function hasStructuredSearchResultsEvidence(state, query = '') {
  if (!state) return false
  if (searchResultUrlMatchesQuery(state.url, query)) return true
  const queryMatches = textMatchesQuery(`${state.title} ${state.text}`, query)
  if (!queryMatches) return false
  return /(?:search results?|results? for|搜索结果|相关结果|结果列表|\bresult\s+\d+\b|role[=: ]+link|\blink\b.{0,120}\blink\b)/iu.test(`${state.title}\n${state.text}`)
}

function browserSearchSubmissionSucceeded(contract, result, evidence = {}, options = {}) {
  const after = resultPageState(result, evidence)
  if (!after || !hasStructuredSearchResultsEvidence(after, contract?.query)) return false
  const before = latestBrowserPageState(options?.successfulToolEvidence || [])
  if (!before) {
    return searchResultUrlMatchesQuery(after.url, contract?.query)
      || textMatchesQuery(after.title, contract?.query)
  }
  if (after.url && before.url && after.url !== before.url) return true
  if (after.title && before.title && after.title !== before.title) return true
  return !hasStructuredSearchResultsEvidence(before, contract?.query)
    && hasStructuredSearchResultsEvidence(after, contract?.query)
}

function normalizedExactSearchQuery(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/\s+/gu, ' ')
    .trim()
}

function findSnapshotNodeById(node, expectedId = '') {
  if (!node || typeof node !== 'object') return null
  if (String(node.id || '') === String(expectedId || '')) return node
  for (const child of Array.isArray(node.children) ? node.children : []) {
    const match = findSnapshotNodeById(child, expectedId)
    if (match) return match
  }
  return null
}

function latestSnapshotNodeForUid(evidenceList = [], uid = '') {
  if (!uid) return null
  for (const evidence of [...(Array.isArray(evidenceList) ? evidenceList : [])].reverse()) {
    const parsed = safeJson(evidence?.result)
    const node = findSnapshotNodeById(resultSnapshot(parsed), uid)
    if (node) return node
  }
  return null
}

function isSearchSubmitControlLabel(value = '') {
  const label = String(value || '').normalize('NFKC').trim()
  if (!label) return false
  if (/(?:搜索框|查找框|输入框|search\s*box|searchbox|clear|清除|删除|voice|语音|image|图像|camera|相机)/iu.test(label)) return false
  return /(?:搜索|查找|查询|搜一下|提交|放大镜|search|submit|\bgo\b)/iu.test(label)
}

function isSearchSubmitClick(contract, args = {}, evidenceList = []) {
  if (contract?.id !== 'browser_search_submit') return true
  if (args?.search_submit === true) return true
  const uid = String(args?.uid || args?.target || args?.ref || '').trim()
  const node = latestSnapshotNodeForUid(evidenceList, uid)
  if (node) {
    const role = String(node.role || '').toLocaleLowerCase()
    return /^(?:button|link)$/u.test(role) && isSearchSubmitControlLabel(node.name || node.description)
  }
  return isSearchSubmitControlLabel(args?.element || args?.label || args?.description)
}

function browserSearchTypeSucceeded(contract, parsed, args = {}) {
  if (args?.replace !== true) return false
  const expected = normalizedExactSearchQuery(contract?.query)
  const actual = normalizedExactSearchQuery(args?.text ?? args?.value)
  if (!expected || actual !== expected) return false
  const snapshot = resultSnapshot(parsed)
  if (!snapshot) return true
  const uid = String(args?.uid || args?.target || args?.ref || '').trim()
  const field = findSnapshotNodeById(snapshot, uid)
  if (!field || field.value == null) return true
  return normalizedExactSearchQuery(field.value) === expected
}

function browserOfficialSiteSucceeded(contract, result, evidence = {}) {
  const state = resultPageState(result, evidence)
  if (!state?.url || isSearchEngineResultsUrl(state.url)) return false
  try {
    const url = new URL(state.url)
    if (!/^https?:$/.test(url.protocol)) return false
    return textMatchesQuery(`${url.hostname} ${url.pathname} ${state.title} ${state.text}`, contract?.officialSiteTarget)
  } catch {
    return false
  }
}

function titleTokens(value = '') {
  const normalized = String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return new Set()
  const tokens = new Set(normalized.match(/[a-z0-9][a-z0-9._-]*/g) || [])
  for (const run of normalized.match(/[\p{Script=Han}]{2,}/gu) || []) {
    for (let index = 0; index < run.length - 1; index += 1) tokens.add(run.slice(index, index + 2))
  }
  return tokens
}

function titlesLikelyDuplicate(left = '', right = '') {
  const a = titleTokens(left)
  const b = titleTokens(right)
  if (a.size < 3 || b.size < 3) return false
  let overlap = 0
  for (const token of a) if (b.has(token)) overlap += 1
  const containment = overlap / Math.min(a.size, b.size)
  const union = a.size + b.size - overlap
  const jaccard = union > 0 ? overlap / union : 0
  return containment >= 0.88 || jaccard >= 0.72
}

function resultHasArticleEvidence(parsed, rawResult = '') {
  if (!parsed || parsed.ok === false || parsed.error) return false
  const snapshot = resultSnapshot(parsed)
  if (snapshot?.busy === true) return false
  if (/Unable to navigate|Navigation timeout|ERR_[A-Z_]+|net::ERR_/i.test(String(rawResult || ''))) return false
  const contentText = Array.isArray(parsed.content)
    ? parsed.content.map(item => String(item?.text || '')).join('\n')
    : ''
  const evidenceText = `${contentText}\n${JSON.stringify(snapshot || {})}`.replace(/\s+/g, ' ').trim()
  return evidenceText.length >= 120
}

export function collectVerifiedWebResearchSources(evidenceList = []) {
  const sources = []
  const seen = new Set()
  for (const evidence of Array.isArray(evidenceList) ? evidenceList : []) {
    if (!['browser_navigate', 'browser_click'].includes(evidence?.name)) continue
    const parsed = safeJson(evidence?.result)
    const url = resultUrl(parsed, evidence)
    if (!likelyArticleUrl(url) || !resultHasArticleEvidence(parsed, evidence?.result)) continue
    const key = normalizedEvidenceUrl(url)
    if (!key || seen.has(key)) continue
    const title = resultTitle(parsed)
    if (title && sources.some(source => titlesLikelyDuplicate(source.title, title))) continue
    seen.add(key)
    const aliases = [...new Set([
      key,
      normalizedEvidenceUrl(evidence?.args?.url || ''),
    ].filter(Boolean))]
    sources.push({ url: key, title: title || key, aliases })
  }
  return sources
}

function urlsInReply(text = '') {
  const matches = String(text || '').match(/https?:\/\/[^\s)\]}>"'。，！？]+/gi) || []
  return [...new Set(matches
    .map(value => value.replace(/[.,;:!?]+$/g, ''))
    .map(normalizedEvidenceUrl)
    .filter(Boolean))]
}

function markdownLinkLabel(value = '') {
  return String(value || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/([\[\]])/g, '\\$1')
    .trim()
    .slice(0, 160)
}

function webResearchCompletionIssue(contract, text = '', options = {}) {
  const required = Math.max(1, Number(contract?.minimumVerifiedSources) || 3)
  const sources = collectVerifiedWebResearchSources(options?.successfulToolEvidence || [])
  if (sources.length < required) {
    return `Only ${sources.length} of ${required} requested article/source pages were actually opened and verified. A search-results page or snippet is discovery only. Continue opening distinct original source pages before answering.`
  }
  const verified = new Set(sources.flatMap(source => source.aliases || [source.url]))
  const linkedVerified = urlsInReply(text).filter(url => verified.has(url))
  if (linkedVerified.length < required) {
    return `The reply includes only ${linkedVerified.length} of ${required} links to pages that were actually opened and verified in this turn. Use the verified source URLs, not search-result or unvisited links.`
  }
  return ''
}

function hasRecentBrowserContext(conversationWindow = [], runtimeContext = '') {
  return (Array.isArray(conversationWindow)
    && conversationWindow.slice(-6).some(item => BROWSER_CONTEXT_RE.test(String(item?.content || ''))))
    || /browser_(?:navigate|snapshot|find|click|type|reload|press_key|tabs|take_screenshot|set_display_mode|close)/i.test(String(runtimeContext || ''))
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

function classifyDirectBrowserAction(text = '', { browserContinuity = false } = {}) {
  const value = String(text || '').trim()
  const hasExplicitPage = /(?:浏览器|网页|页面|标签页|结果页|列表页|https?:\/\/|www\.|(?:[\w-]+\.)+(?:com|cn|org|net|io)\b)/i.test(value)
  const contextAllowsTerse = browserContinuity || hasExplicitPage
  const base = {
    directBrowserAction: true,
    restrictTools: true,
    runtimeOwnedReply: true,
  }

  if ((browserContinuity || /(?:结果|列表)页/iu.test(value)) && BROWSER_RESULT_LIST_CORRECTION_RE.test(value)) {
    return { ...base, id: 'browser_back', label: '返回浏览器搜索结果列表页', requiredTools: ['browser_navigate_back'] }
  }

  const searchQuery = extractBrowserSearchSubmissionQuery(value)
  if (searchQuery) {
    return {
      ...base,
      id: 'browser_search_submit',
      label: '在当前页面的搜索框中输入并提交搜索',
      requiredTools: ['browser_snapshot', 'browser_type', 'browser_click'],
      requireAllTools: true,
      query: searchQuery,
    }
  }

  const resultOrdinal = extractBrowserSearchResultOrdinal(value)
  if (resultOrdinal > 0 && (browserContinuity || /搜索结果/iu.test(value))) {
    return {
      ...base,
      id: 'browser_search_result_click',
      label: `点开第 ${resultOrdinal} 个搜索结果`,
      requiredTools: ['browser_snapshot', 'browser_click'],
      requireAllTools: true,
      resultOrdinal,
    }
  }

  const officialSiteTarget = extractColloquialOfficialSiteTarget(value)
  if (officialSiteTarget) {
    return {
      ...base,
      id: 'browser_official_site_lookup',
      label: `打开并核验 ${officialSiteTarget} 官方网站`,
      requiredTools: ['browser_navigate', 'browser_type', 'browser_click'],
      officialSiteTarget,
    }
  }

  if (contextAllowsTerse && /^(?:好的?[，,]?\s*|行[，,]?\s*|请\s*|帮我\s*|再\s*)*(?:刷新(?:一下)?|重新加载(?:一下)?)(?:当前)?(?:浏览器|网页|页面)?[。.!！?？]*$/i.test(value)) {
    return { ...base, id: 'browser_reload', label: '刷新当前浏览器页面', requiredTools: ['browser_reload'] }
  }
  if (contextAllowsTerse && /^(?:好的?[，,]?\s*|行[，,]?\s*|请\s*|帮我\s*|再\s*)*(?:往下翻|向下翻|下翻)(?:一屏|一页|一下)?[。.!！?？]*$/i.test(value)) {
    return { ...base, id: 'browser_scroll', label: '向下滚动当前页面', requiredTools: ['browser_press_key'], expectedKey: 'PageDown', scrollDirection: 'down' }
  }
  if (contextAllowsTerse && /^(?:好的?[，,]?\s*|行[，,]?\s*|请\s*|帮我\s*|再\s*)*(?:往上翻|向上翻|上翻)(?:一屏|一页|一下)?[。.!！?？]*$/i.test(value)) {
    return { ...base, id: 'browser_scroll', label: '向上滚动当前页面', requiredTools: ['browser_press_key'], expectedKey: 'PageUp', scrollDirection: 'up' }
  }
  if (contextAllowsTerse && /^(?:请\s*|帮我\s*)*(?:翻到|滚到|到)(?:页面)?底部[。.!！?？]*$/i.test(value)) {
    return { ...base, id: 'browser_scroll', label: '滚动到当前页面底部', requiredTools: ['browser_press_key'], expectedKey: 'End', scrollDirection: 'end' }
  }
  if (contextAllowsTerse && /^(?:请\s*|帮我\s*)*(?:返回|后退|上一页|回(?:到|去)?上一页|回(?:到)?(?:搜索)?结果(?:列表)?页|回(?:到)?结果列表页|回列表页)(?:一下)?[。.!！?？]*$/i.test(value)) {
    return { ...base, id: 'browser_back', label: '返回浏览器上一页', requiredTools: ['browser_navigate_back'] }
  }
  if (contextAllowsTerse && /^(?:请\s*|帮我\s*)*(?:前进|下一页|再往前|回到刚才点开的页面)(?:一下)?[。.!！?？]*$/i.test(value)) {
    return { ...base, id: 'browser_forward', label: '前进到浏览器下一页', requiredTools: ['browser_navigate_forward'] }
  }
  if (/^(?:请\s*|帮我\s*)*(?:现在|当前)?(?:有|开着)?\s*(?:几个|多少个)\s*标签页[呢吗？?。.!！]*$/i.test(value)) {
    return { ...base, id: 'browser_tabs_list', label: '列出当前浏览器标签页', requiredTools: ['browser_tabs'] }
  }
  if (/^(?:请\s*|帮我\s*)*(?:重新|再次|再)打开\s*(?:https?:\/\/|www\.|(?:[\w-]+\.)+(?:com|cn|org|net|io)\b).*[。.!！?？]*$/i.test(value)) {
    return { ...base, id: 'browser_reopen', label: '重新打开指定网页', requiredTools: ['browser_navigate'] }
  }
  const knownSiteUrl = extractKnownBrowserSiteUrl(value)
  if (knownSiteUrl) {
    return {
      ...base,
      id: 'browser_open_url',
      label: '打开指定网站',
      requiredTools: ['browser_navigate'],
      expectedUrl: knownSiteUrl,
    }
  }
  const directUrl = extractDirectBrowserUrl(value)
  if (directUrl
      && !isSystemBrowserRequest(value)
      && !isExplicitBrowserDisplayModeRequest(value)
      && /^(?:请\s*|帮我\s*)*(?:打开|访问|进入|前往|加载)\s+/i.test(value)) {
    return {
      ...base,
      id: 'browser_open_url',
      label: '打开指定网页',
      requiredTools: ['browser_navigate'],
      expectedUrl: directUrl,
    }
  }
  if (browserContinuity && /^(?:请\s*|帮我\s*)*(?:放大|放大一点|大一点)(?:吧|一下)?[。.!！?？]*$/i.test(value)) {
    return {
      ...base,
      id: 'browser_display_mode',
      label: '切换浏览器显示大小',
      requiredTools: ['browser_set_display_mode'],
      expectedBrowserDisplayMode: 'window',
    }
  }
  return null
}

function extractBrowserSearchSubmissionQuery(text = '') {
  const match = String(text || '').trim().match(BROWSER_SEARCH_BOX_SUBMIT_RE)
  return String(match?.[1] || '').trim()
}

function extractBrowserSearchResultOrdinal(text = '') {
  const match = String(text || '').trim().match(BROWSER_SEARCH_RESULT_CLICK_RE)
  return match ? chineseCount(match[1]) : 0
}

function extractColloquialOfficialSiteTarget(text = '') {
  const match = String(text || '').trim().match(COLLOQUIAL_OFFICIAL_SITE_LOOKUP_RE)
  return String(match?.[1] || '').trim()
}

function extractKnownBrowserSiteUrl(text = '') {
  const match = String(text || '').trim().match(
    /^(?:好的?[，,]?\s*|行[，,]?\s*|请\s*|帮我\s*)*(?:打开|访问|进入|前往|加载)\s*(?:一下\s*)?(.+?)(?:的)?(?:主页|首页|网站)?[。.!！?？]*$/iu,
  )
  const target = String(match?.[1] || '').trim().replace(/\s+/g, '').toLowerCase()
  if (/^(?:duckduckgo|duckgo|鸭鸭走)$/.test(target)) return 'https://duckduckgo.com/'
  if (/^(?:百度|baidu)$/.test(target)) return 'https://www.baidu.com/'
  if (/^(?:谷歌|google)$/.test(target)) return 'https://www.google.com/'
  if (/^(?:必应|bing)$/.test(target)) return 'https://www.bing.com/'
  return ''
}

function extractDirectBrowserUrl(text = '') {
  const value = String(text || '')
  const raw = value.match(/https?:\/\/[^\s，。！？；]+/iu)?.[0]
    || value.match(/(?:www\.)?(?:[\w-]+\.)+(?:com|cn|org|net|io)(?:\/[^\s，。！？；]*)?/iu)?.[0]
    || ''
  if (!raw) return ''
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).toString()
  } catch {
    return ''
  }
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
    resolve: text => {
      const standalone = !hasAdditionalBrowserCloseTask(text)
      return {
        fixedReply: standalone ? '👌' : '',
        ...(standalone ? { directBrowserAction: true, restrictTools: true, runtimeOwnedReply: true } : {}),
      }
    },
  },
  {
    id: 'browser_screenshot',
    label: '截取并发送浏览器截图',
    tools: ['browser_take_screenshot'],
    match: text => BROWSER_SCREENSHOT_RE.test(text),
    resolve: () => ({ directBrowserAction: true, restrictTools: true }),
  },
  {
    id: 'browser_page_find',
    label: '在当前浏览器页面中查找并计数文本',
    tools: ['browser_find'],
    match: text => isBrowserPageFindRequest(text) && !!extractBrowserPageFindQuery(text),
    resolve: text => ({
      query: extractBrowserPageFindQuery(text),
      directBrowserAction: true,
      restrictTools: true,
      runtimeOwnedReply: true,
    }),
  },
  {
    id: 'browser_display_mode',
    label: '切换浏览器显示大小',
    tools: ['browser_set_display_mode'],
    match: text => isExplicitBrowserDisplayModeRequest(text) || /(?:缩回|收回).{0,8}(?:小卡片|卡片|小窗口)/i.test(text),
    resolve: text => ({
      expectedBrowserDisplayMode: inferBrowserDisplayMode(text),
      directBrowserAction: true,
      restrictTools: true,
      runtimeOwnedReply: true,
    }),
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
    id: 'web_research',
    label: '联网检索并核验原文来源',
    tools: ['browser_navigate', 'browser_click'],
    match: text => WEB_RESEARCH_REQUEST_RE.test(text),
    resolve: text => ({ minimumVerifiedSources: inferWebResearchSourceCount(text) }),
  },
  {
    id: 'web',
    label: '联网查询',
    // Requiring navigation prevents a stale snapshot/current-tab inspection
    // from being mistaken for a fresh web lookup. The normal router injects the
    // rest of the safe Playwright group for snapshot/find/click follow-through.
    tools: ['browser_navigate'],
    match: text => WEB_FRESH_FACT_REQUEST_RE.test(text)
      || /(?:帮我|请|给我).{0,12}(?:上网|联网|搜索|查一下|查一查|检索|找一下|浏览).{0,40}|(?:搜索|查询|查找).{0,30}(?:网页|网站|新闻|资料|链接|网址)|\b(?:search|browse|look\s+up|fetch)\b/i.test(text),
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
  const browserContinuity = hasRecentBrowserContext(conversationWindow, runtimeContext)
  if (BROWSER_CONTINUATION_RE.test(actionText) && browserContinuity) {
    return browserInteractionContract('继续当前浏览器交互')
  }

  const directBrowserAction = classifyDirectBrowserAction(actionText, { browserContinuity })
  if (directBrowserAction) return directBrowserAction

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

export function actionContractToolCallIssue(contract, toolName, args = {}, options = {}) {
  if (contract?.id === 'browser_search_submit'
      && ['browser_snapshot', 'browser_type', 'browser_click'].includes(toolName)) {
    const attempted = options?.attemptedToolNames || []
    if (attempted.includes(toolName)) {
      return `${toolName} is single-use for this search request. Do not repeat the snapshot, type the query again, or click the submit button again; report the unchanged page honestly.`
    }
    const successful = options?.successfulToolNames instanceof Set
      ? options.successfulToolNames
      : new Set(options?.successfulToolNames || [])
    const expectedTool = ['browser_snapshot', 'browser_type', 'browser_click']
      .find(name => !successful.has(name)) || ''
    if (expectedTool && toolName !== expectedTool) {
      const fallback = expectedTool === 'browser_click'
        ? ' If the accessibility snapshot has no submit-button uid, call browser_click with search_submit=true and element="search submit".'
        : ''
      return `Search submission order is fixed: browser_snapshot, then browser_type, then browser_click. Call ${expectedTool} next.${fallback}`
    }
    if (toolName === 'browser_type'
        && normalizedExactSearchQuery(args?.text ?? args?.value) !== normalizedExactSearchQuery(contract?.query)) {
      return `browser_type must replace the search field with the exact requested query: ${contract?.query || ''}`
    }
    if (toolName === 'browser_click'
        && !isSearchSubmitClick(contract, args, options?.successfulToolEvidence || [])) {
      return 'browser_click must target the actual search-submit control, not the search field, clear button, suggestion, voice button, or image button. If no submit uid is exposed, call browser_click with search_submit=true and element="search submit".'
    }
  }
  if (contract?.id === 'browser_official_site_lookup'
      && toolName === 'browser_navigate'
      && isSearchEngineResultsUrl(args?.url)) {
    return 'Do not navigate directly to a search-engine results URL with query parameters. Open the search-engine homepage and use its visible form, or navigate directly to the known official site.'
  }
  return ''
}

export function actionContractToolSucceeded(contract, toolName, result, args = {}, options = {}) {
  if (!contract?.requiredTools?.includes(toolName)) return false
  const text = String(result || '').trim()
  if (!text) return true
  try {
    const parsed = JSON.parse(text)
    if (parsed?.ok === false || parsed?.error) return false
    if (contract.id === 'browser_open_in_display_mode') {
      return parsed?.browser_preview?.mode === contract.expectedBrowserDisplayMode
    }
    if (contract.id === 'browser_open_url' && contract.expectedUrl) {
      const actual = resultUrl(parsed, { args })
      const requested = normalizedEvidenceUrl(args?.url || '')
      return !!actual && requested === normalizedEvidenceUrl(contract.expectedUrl)
    }
    if (contract.id === 'browser_display_mode') {
      return parsed?.browser_preview?.mode === contract.expectedBrowserDisplayMode
    }
    if (contract.id === 'browser_scroll') {
      return String(args?.key || '').toLowerCase() === String(contract.expectedKey || '').toLowerCase()
    }
    if (contract.id === 'browser_tabs_list') {
      return String(args?.action || 'list').toLowerCase() === 'list'
    }
    if (contract.id === 'browser_page_find') {
      const pageFind = browserPageFindResultFromParsed(parsed)
      return !!pageFind
        && pageFind.query.normalize('NFKC') === String(contract.query || '').normalize('NFKC')
    }
    if (contract.id === 'browser_search_submit') {
      if (toolName === 'browser_type') return browserSearchTypeSucceeded(contract, parsed, args)
      if (toolName === 'browser_click') {
        if (!isSearchSubmitClick(contract, args, options?.successfulToolEvidence || [])) return false
        return browserSearchSubmissionSucceeded(contract, text, { args }, options)
      }
    }
    if (contract.id === 'browser_official_site_lookup') {
      if (!['browser_navigate', 'browser_click'].includes(toolName)) return false
      return browserOfficialSiteSucceeded(contract, text, { args })
    }
    return true
  } catch {
    return !/^(?:错误|请求失败|执行失败|命令超时|命令执行失败|error|failed|execution failed|command timed out)/i.test(text)
  }
}

export function filterMemoriesForActionContract(memories = [], contract = null) {
  const values = Array.isArray(memories) ? memories : []
  if (contract?.restrictTools !== true || !String(contract?.id || '').startsWith('browser_')) {
    return [...values]
  }
  const allowed = new Set([...(contract.requiredTools || []), 'send_message'])
  return values.filter(memory => {
    const text = [
      memory?.mem_id,
      memory?.title,
      memory?.content,
      memory?.detail,
      memory?.tags,
    ].filter(Boolean).join(' ')
    const mentionedTools = text.match(/\b(?:browser_[a-z_]+|download_file|run_command|exec_command)\b/gi) || []
    if (mentionedTools.some(name => !allowed.has(String(name).toLowerCase()))) return false
    if (contract.id === 'browser_screenshot'
        && /(?:截图|screenshot).{0,30}(?:无法|不能|拿不到|不可).{0,24}(?:发送|转发|send|forward)|BROWSER_DISPLAY_MODE_REQUIRED/i.test(text)) {
      return false
    }
    return true
  })
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

export function browserScreenshotPathFromEvidence(evidenceList = []) {
  for (const evidence of [...(Array.isArray(evidenceList) ? evidenceList : [])].reverse()) {
    if (evidence?.name !== 'browser_take_screenshot') continue
    const parsed = safeJson(evidence?.result)
    const imagePath = String(parsed?.screenshot?.image_path || '').trim()
    if (parsed?.ok !== false && imagePath) return imagePath
  }
  return ''
}

function browserPageFindResultFromParsed(parsed) {
  const value = parsed?.structured_content?.page_find
    || parsed?.structuredContent?.page_find
    || parsed?.page_find
    || null
  const query = String(value?.query || '').trim()
  const totalMatches = Number(value?.total_matches)
  const currentMatch = Number(value?.current_match)
  if (!query || !Number.isInteger(totalMatches) || totalMatches < 0) return null
  if (!Number.isInteger(currentMatch) || currentMatch < 0 || currentMatch > totalMatches) return null
  return {
    query,
    found: totalMatches > 0,
    total_matches: totalMatches,
    current_match: currentMatch,
    url: String(value?.url || ''),
    title: String(value?.title || ''),
    source: String(value?.source || 'rendered_page_text'),
  }
}

export function browserPageFindResultFromEvidence(evidenceList = []) {
  for (const evidence of [...(Array.isArray(evidenceList) ? evidenceList : [])].reverse()) {
    if (evidence?.name !== 'browser_find') continue
    const parsed = safeJson(evidence?.result)
    if (parsed?.ok === false) continue
    const pageFind = browserPageFindResultFromParsed(parsed)
    if (pageFind) return pageFind
  }
  return null
}

export function browserScreenshotDeliveryMatches(evidenceList = [], messageArgs = {}) {
  const imagePath = browserScreenshotPathFromEvidence(evidenceList)
  const sentPath = String(messageArgs?.image_path || messageArgs?.media_path || '').trim()
  return !!imagePath && sentPath === imagePath
}

function browserScreenshotCompletionIssue(text = '', options = {}) {
  const imagePath = browserScreenshotPathFromEvidence(options?.successfulToolEvidence || [])
  if (!imagePath) return 'The screenshot tool did not produce a persisted image_path, so no image can be claimed or delivered.'
  const sentPath = String(options?.messageArgs?.image_path || options?.messageArgs?.media_path || '').trim()
  if (sentPath !== imagePath) {
    return `The screenshot was captured but not delivered. Call send_message with image_path exactly equal to ${imagePath}. A live browser card or text-only acknowledgement is not the screenshot.`
  }
  if (/(?:没有|未能?|还没|尚未).{0,10}(?:发送|发出|送达)|(?:发送|投递).{0,8}(?:失败|不成功)|not\s+(?:sent|delivered)|delivery\s+failed/i.test(String(text || ''))) {
    return 'The send_message payload includes the captured image but its text falsely says delivery failed. Remove that contradictory failure claim.'
  }
  return ''
}

function browserDisplayModeCompletionIssue(contract, text = '') {
  if (contract?.expectedBrowserDisplayMode === 'window' && /(?:全屏|全屏幕|full[ -]?screen)/i.test(String(text || ''))) {
    return 'The tool proved only window mode (an independent large window), not operating-system fullscreen.'
  }
  return ''
}

export function actionContractCompletionIssue(contract, text = '', options = {}) {
  if (contract?.id === 'browser_screenshot') {
    return browserScreenshotCompletionIssue(text, options)
  }
  if (contract?.id === 'browser_display_mode') {
    return browserDisplayModeCompletionIssue(contract, text)
  }
  if (contract?.id === 'browser_interaction') {
    return browserInteractionCompletionIssue(text, options)
  }
  if (contract?.id === 'web_research') {
    return webResearchCompletionIssue(contract, text, options)
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

export function verifiedActionContractReply(contract, evidence = {}, options = {}) {
  if (contract?.id === 'browser_close') return String(contract?.fixedReply || '')
  if (contract?.id === 'browser_screenshot') return '截图已经生成，但图片还没有成功发送。'
  if (contract?.id === 'browser_page_find') {
    const pageFind = browserPageFindResultFromEvidence(options?.successfulToolEvidence || [evidence])
    if (!pageFind) return '当前页面的文本无法可靠计数；页面保持在原处，我没有改用下载、命令行或其他网址猜测。'
    return pageFind.found
      ? `当前页面里找到了“${pageFind.query}”，共出现 ${pageFind.total_matches} 处。`
      : `当前页面里没有找到“${pageFind.query}”。`
  }
  if (contract?.id === 'browser_search_submit') return `已搜索“${contract.query}”。`
  if (contract?.id === 'browser_official_site_lookup') {
    const parsed = safeJson(evidence?.result)
    const url = resultUrl(parsed, evidence)
    return url
      ? `已打开并核验 ${contract.officialSiteTarget} 官方网站：${url}`
      : `已打开并核验 ${contract.officialSiteTarget} 官方网站。`
  }
  if (contract?.id === 'browser_search_result_click') {
    const labels = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
    const ordinal = labels[contract.resultOrdinal] || String(contract.resultOrdinal || '')
    return `已点开第${ordinal}个搜索结果。`
  }
  if (contract?.id === 'browser_reload') return '已刷新当前页面。'
  if (contract?.id === 'browser_back') return '已返回上一页。'
  if (contract?.id === 'browser_forward') return '已前进到下一页。'
  if (contract?.id === 'browser_scroll') {
    if (contract.scrollDirection === 'up') return '已向上翻了一屏。'
    if (contract.scrollDirection === 'end') return '已滚动到页面底部。'
    return '已向下翻了一屏。'
  }
  if (contract?.id === 'browser_tabs_list') return '当前只有 1 个受控网页。'
  if (contract?.id === 'browser_reopen' || contract?.id === 'browser_open_url') {
    const parsed = safeJson(evidence?.result)
    const url = String(parsed?.browser_preview?.url || parsed?.url || evidence?.args?.url || '').trim()
    if (contract.id === 'browser_open_url') return url ? `已打开 ${url}` : '已打开指定网页。'
    return url ? `已重新打开 ${url}` : '已重新打开指定网页。'
  }
  if (contract?.id === 'browser_display_mode') {
    const parsed = safeJson(evidence?.result)
    const mode = parsed?.browser_preview?.mode || contract.expectedBrowserDisplayMode
    return mode === 'window' ? '已切换到独立大窗口。' : '已缩回小卡片。'
  }
  if (contract?.id === 'web_research') {
    const required = Math.max(1, Number(contract?.minimumVerifiedSources) || 3)
    const sources = collectVerifiedWebResearchSources(options?.successfulToolEvidence || [])
    const lines = sources.map(source => `- [${markdownLinkLabel(source.title)}](${source.url})`)
    const summary = sources.length < required
      ? `这次联网检索只完成了 ${sources.length}/${required} 个原文来源的实际打开与核验，因此不会用搜索摘要或猜测补足。`
      : `这次联网检索已实际打开并核验 ${sources.length} 个原文来源；为避免加入未访问或无法核验的内容，下面只保留这些来源。`
    return [
      summary,
      ...(lines.length ? ['已核验的来源：', ...lines] : []),
    ].join('\n')
  }
  if (contract?.id !== 'system_browser_open') return ''
  let url = String(evidence?.args?.url || '').trim()
  try {
    const parsed = JSON.parse(String(evidence?.result || '{}'))
    if (parsed?.url) url = String(parsed.url)
  } catch {}
  const target = url ? `链接 \`${url}\`` : '链接'
  return `已将${target}交给电脑的系统默认浏览器打开。白龙马的“小窗口浏览器”和“大窗口浏览器”是同一个实时页面的两种显示形态；电脑浏览器与它们独立。`
}

export function containsUnsupportedCompletionClaim(text = '', contract = null) {
  const value = String(text || '')
  if (contract?.id === 'browser_search_submit'
      && /(?:已(?:经)?(?:搜索|搜完|提交)|搜索(?:成功|完成|好了)|搜(?:索)?好了)/i.test(value)) return true
  if (contract?.id === 'browser_back'
      && /(?:已(?:经)?(?:返回|回到|退回)|(?:返回|回到).{0,10}(?:成功|完成|好了))/i.test(value)) return true
  if (contract?.id === 'browser_official_site_lookup'
      && /(?:已(?:经)?(?:找到|打开|核验)|是.{0,12}(?:官网|官方网站)|official site)/i.test(value)) return true
  return /(?:已(?:经)?(?:完成|做好|创建|写入|保存|修改|更新|删除|打开|关闭|安装|执行)|(?:完成|创建|写入|保存|修改|更新|删除|打开|关闭|安装|执行)(?:好了|完成了)|(?:创建|写入|保存|修改|更新|删除|打开|关闭|安装|执行)(?:成功|完成)|搞定了|done|completed|created|installed|executed)/i.test(value)
}
