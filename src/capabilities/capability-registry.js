// =============================================================================
// capability-registry.js —— 能力机制（Capability Mechanism）唯一真相源
//
// 背景 / 第一性原理：
//   Jarvis里「一个领域的能力」原本被切成 3~4 片，散在不同文件、靠重复的关键词表
//   手动同步：工具半在 tool-router.js（XXX_TRIGGERS + XXX_TOOLS），工作流半在
//   prompt.js（XXX_BLOCK + shouldInjectXxx），数据预喂半在 runtime-injector.js
//   （buildXxxRuntimeContext）。每改一个领域要同时动两三个文件、对齐两份关键词。
//
//   能力 = 一段工作流上下文（prompt 块）+ 配套工具 + 运行时数据预喂，由情境触发、
//   打包一起注入，且Jarvis能自我感知、按需主动激活。本模块把上述三半收敛成一个
//   声明式单元，让每个能力的关键词、工具、工作流、数据只剩一处。
//
// 关键设计：保留「分面解耦」。现有架构故意让 tools / context / prefeed 各有自己的
//   激活条件（例：热点、世界杯工具都不自动注入，但两者的 prompt 块随关键词注入）。
//   强行用单一 detect 会把「关键词自动加载工具」加回来——正是先前特意删掉的。
//   所以每个能力分别声明：
//     - detect(ctx)   领域相关信号 → 控 context 注入 +（默认）tool 注入门
//     - toolWhen(ctx) tool 自动注入条件（可覆盖 detect；不写则用 detect）
//     - prefeed(ctx)  运行时数据预喂（自门控，复用现成 build 函数）
//     - triggers      关键词集 → find_tool 发现 + 自感知按需激活
//
// 本模块是工具名数组（WEB_TOOLS 等已迁能力的）的归属地，tool-router.js 反向 import，
// 保持单向依赖、无循环。未迁能力（filesystem/exec/media/...）的工具名仍在 tool-router。
// =============================================================================

import { isSoftwareInstallRequest, SOFTWARE_INSTALL_TRIGGERS } from '../software-install-intent.js'
import { buildHotspotRuntimeContext } from '../hotspots.js'
import { buildWorldcupRuntimeContext } from '../worldcup.js'
import { buildTyphoonRuntimeContext } from '../typhoon.js'
import { buildWeatherRuntimeContext } from '../weather.js'
import { listApiSlotCapabilities } from './api-slots.js'

// ---- 已迁能力的工具名数组（本模块为唯一定义处；tool-router 从这里 import）----
export const WEB_TOOLS = ['web_search', 'fetch_url', 'browser_read']
export const HOTSPOT_TOOLS = ['hotspot_mode']
// 世界杯模式打开面板即可（赛况数据由 prefeed 注入上下文）；追问细节（首发名单/射手榜等）
// 要联网，所以 WEB_TOOLS 一并带上。
export const WORLDCUP_TOOLS = ['worldcup_mode', ...WEB_TOOLS]
export const TYPHOON_TOOLS = ['typhoon_mode']
export const SOFTWARE_INSTALL_TOOLS = ['install_software', 'list_processes']

// ---- 触发词 / 触发正则 ----
// 工具半历史上用字面包含的字符串数组（tool-router），工作流半用正则（prompt）。两者各自
// 与既有行为对齐，能力对象同时持有，detect 用正则、find_tool 发现用 triggers 数组。
const WEB_TRIGGERS = [
  '搜', '搜索', '查一下', '查查', '百度', '谷歌', '上网', '在线', '网页',
  '网址', '链接', '浏览', '打开网页', '看看网上', '抓一下',
  'search', 'google', 'bing', 'fetch', 'http://', 'https://', 'url',
  'web', 'browser', 'browse', 'website', '.com', '.cn', '.org', '.io',
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
const TYPHOON_TRIGGERS = [
  '台风', '热带气旋', '台风路径', '台风预警', '风圈', '登陆台风', 'typhoon', 'tropical cyclone',
]

const WEATHER_KEYWORD_RE = /天气|温度|气温|下雨|降雨|下雪|台风|雾霾|阴天|晴天|多云|wttr|weather/i
const HOTSPOT_KEYWORD_RE = /热点|热搜|热门|新闻|今日|趋势|榜单|头条|热议|微博热搜|trending|headline/i
const WORLDCUP_KEYWORD_RE = /世界杯|赛况|比分|赛程|对阵|积分榜|小组赛|淘汰赛|揭幕战|进球|几比几|world ?cup|worldcup|fifa/i
const TYPHOON_KEYWORD_RE = /台风|热带气旋|台风路径|台风预警|风圈|登陆台风|typhoon|tropical cyclone/i

// ---- 工作流块（prompt 注入用；从 prompt.js / index.js 搬来，文本逐字保留）----
const WEATHER_CONTEXT_BLOCK = `### Weather Surface Rules
- The data source must be wttr.in only. Do not use search engines or other weather sites. Use this fixed call:
  fetch_url("https://wttr.in/{city-English-name}?format=j1&lang=zh")
- Map the following fields the weather kind actually renders. Only fill a field that is actually present in the JSON; leave a missing field empty rather than supplying a typical value or a guess:
  - city       <- nearest_area[0].areaName[0].value, any language is fine; if missing, use the city the user asked about.
  - temp       <- current_condition[0].temp_C, number
  - condition  <- current_condition[0].lang_zh[0].value or weatherDesc[0].value
  - variant    <- "compact" for a 3-day card, or "week" when the user asks for one week / seven days.
  - forecast   <- compact: three items from weather[0..2]; week: seven items if available. Each item is { day, low, high, condition }.
- Call: ui_set({ id: "weather-<city>", kind: "weather", data: { variant, city, temp, condition, forecast }, intent: "ambient" })
- If a matching weather surface is already listed in Supplemental Context, do not call ui_set again unless the user asks to refresh or the surface data is clearly missing.
- To refresh, call ui_set again with the same id.`

const HOTSPOT_CONTEXT_BLOCK = `### Hotspot Panel
- You have a hotspot_mode tool that opens a visual hotspot / trending-topics panel. It is NOT pre-loaded each turn — if it is not in your current tool list, call find_tool("热点 面板 hotspot") first to load it, then call it.
- Open it (action="show") only when the user actually wants to browse trending topics, or a demo/scene needs it; close it (action="hide") when asked. Do not open it for ordinary Q&A.
- While the panel is open, current hotspot data is injected into your context automatically — answer from that rather than guessing.`

const WORLDCUP_CONTEXT_BLOCK = `### World Cup Panel
- You have a worldcup_mode tool that opens a panel with live scores, schedule and group standings (FIFA World Cup, Beijing time). It is NOT pre-loaded each turn — if it is not in your current tool list, call find_tool("世界杯 比分 worldcup") first to load it, then call it.
- Open it (action="show") when the user asks about World Cup matches, scores or schedule and a visual panel helps; close it (action="hide") when asked.
- While the panel is open, current match data is injected into your context automatically; for deeper details (lineups, scorers) use web tools.`

const TYPHOON_CONTEXT_BLOCK = `### Typhoon Monitoring Panel
- You have a typhoon_mode tool that opens a visual typhoon monitoring panel. It shows current active-typhoon tracks, intensity, wind circles, and forecast tracks from the Central Meteorological Observatory. It is NOT pre-loaded each turn — if it is not in your current tool list, call find_tool("台风 路径 typhoon") first to load it.
- Open it (action="show") when the user explicitly asks to view typhoon paths, tracking, or monitoring; close it (action="hide") when asked.
- The panel's data is for situational awareness. Do not present it as a replacement for official local emergency instructions.`

// 安装工作流：原先以 directions.unshift 注入在 index.js，现归位为能力 context，统一经
// buildSystemPrompt 注入（同一份文本、同一道 isSoftwareInstallRequest 门）。
const SOFTWARE_INSTALL_CONTEXT_BLOCK = `## Software Install Workflow
- First use injected installed-software context to see whether the app is already installed. If installation is still needed, call install_software first. install_software starts a background job and normally returns immediately with status="started" and job_id; this only means the job began, not that the app is installed. After a started result, tell the user briefly that installation is running in the background and stop the round. Do not call install_software again for the same app, do not poll repeatedly, and do not claim success until a later background APP_SIGNAL/list_processes result says succeeded/already installed/current. Do not run raw winget commands with exec_command, do not browse vendor pages, and do not enumerate download URLs before install_software has returned a terminal structured failure. On Windows this tool owns the winget path, including candidate selection and stale-manifest fallback such as Tencent.QQ.NT before Tencent.QQ for QQ. Installs run silently by default (no installer-wizard clicks); pass silent=false only if the user wants to watch or click the installer UI. If the final job result reports all winget candidates failed or no candidates, explain that concrete result and only then use find_tool to load web/download tools for a targeted official fallback if the user still wants it.`

// 通用辅助：text 已小写，triggers 字面包含。
function hits(text, triggers) {
  if (!text) return false
  for (const t of triggers) {
    if (text.includes(t)) return true
  }
  return false
}

// =============================================================================
// 能力定义（v1：已配对的 web / weather / hotspot / worldcup / software-install）
//
// 每个能力字段：
//   id / label / summary —— 标识 + 自感知/发现用的人读描述
//   triggers             —— 关键词数组（find_tool 发现 + 按需激活）
//   tools                —— 配套工具名
//   detect(ctx)          —— 领域相关？控 context 注入 + prefeed +（默认）tool 注入门
//   toolWhen(ctx)        —— 可选：tool 自动注入条件，覆盖 detect
//   context              —— 可选：工作流块（detect 命中且存在时注入 prompt）
//   prefeed(ctx)         —— 可选：运行时数据预喂（自门控，返回字符串/Promise<字符串>）
// ctx 形状：{ text(小写正文), rawText(原文), isTick, mmCaps, hasTask, hasActiveFocus }
// =============================================================================
export const CAPABILITIES = [
  {
    id: 'web',
    label: '上网',
    summary: '联网搜索、抓取网页正文、读取链接内容（web_search / fetch_url / browser_read）。',
    triggers: WEB_TRIGGERS,
    tools: WEB_TOOLS,
    // 上网无独立工作流块。Tick 先由主模型判断，再经 find_tool 按需加载，
    // 不因为心跳本身预装联网能力。
    detect: (ctx) => hits(ctx.text, WEB_TRIGGERS),
    toolWhen: (ctx) => hits(ctx.text, WEB_TRIGGERS),
    context: null,
    prefeed: null,
  },
  {
    id: 'weather',
    label: '天气',
    summary: '查实时天气（仅 wttr.in 取数）并以 weather 卡片投影；含地理实况预喂。',
    triggers: ['天气', '温度', '气温', '下雨', '下雪', '台风', 'weather', 'wttr'],
    // 天气需要 fetch_url 抓 wttr.in，因此命中即带上 web 工具（修复旧路径偶尔无 fetch 可用的缺口）。
    tools: WEB_TOOLS,
    detect: (ctx) => WEATHER_KEYWORD_RE.test(ctx.rawText || ''),
    context: WEATHER_CONTEXT_BLOCK,
    prefeed: (ctx) => buildWeatherRuntimeContext(ctx.rawText || ''),
  },
  {
    id: 'hotspot',
    label: '热点面板',
    summary: '打开热搜/趋势可视化面板（hotspot_mode）；面板开启时实时热点数据自动预喂。',
    triggers: HOTSPOT_TRIGGERS,
    tools: HOTSPOT_TOOLS,
    detect: (ctx) => HOTSPOT_KEYWORD_RE.test(ctx.rawText || ''),
    // 面板工具不自动注入；无论用户轮还是 Tick，Agent 判断需要后经 find_tool 装载。
    toolWhen: () => false,
    context: HOTSPOT_CONTEXT_BLOCK,
    prefeed: (ctx) => buildHotspotRuntimeContext(ctx.rawText || ''),
  },
  {
    id: 'worldcup',
    label: '世界杯面板',
    summary: '打开世界杯比分/赛程/积分榜面板（worldcup_mode）；面板开启时赛况自动预喂。',
    triggers: WORLDCUP_TRIGGERS,
    tools: WORLDCUP_TOOLS,
    detect: (ctx) => WORLDCUP_KEYWORD_RE.test(ctx.rawText || ''),
    // 工具不自动注入（schema 较大且拖 WEB_TOOLS）；只递规则块，Agent 想用时 find_tool 装载。
    toolWhen: () => false,
    context: WORLDCUP_CONTEXT_BLOCK,
    prefeed: (ctx) => buildWorldcupRuntimeContext(ctx.rawText || ''),
  },
  {
    id: 'typhoon',
    label: '台风监测面板',
    summary: '打开台风实时路径、强度、风圈与预报路径面板（typhoon_mode）；数据来自中央气象台台风网。',
    triggers: TYPHOON_TRIGGERS,
    tools: TYPHOON_TOOLS,
    detect: (ctx) => TYPHOON_KEYWORD_RE.test(ctx.rawText || ''),
    toolWhen: () => false,
    context: TYPHOON_CONTEXT_BLOCK,
    prefeed: (ctx) => buildTyphoonRuntimeContext(ctx.rawText || ''),
  },
  {
    id: 'software-install',
    label: '安装软件',
    summary: '用 winget 静默安装 Windows 软件，后台 job 进度以 progress 卡实时投影。',
    triggers: SOFTWARE_INSTALL_TRIGGERS,
    tools: SOFTWARE_INSTALL_TOOLS,
    detect: (ctx) => isSoftwareInstallRequest(ctx.rawText || ''),
    context: SOFTWARE_INSTALL_CONTEXT_BLOCK,
    prefeed: null,
  },
]

const CAPABILITY_BY_ID = new Map(CAPABILITIES.map(c => [c.id, c]))

// ---- 消费端 helpers ----

function allCapabilities() {
  return [...CAPABILITIES, ...listApiSlotCapabilities()]
}

// 领域相关的能力（detect 命中）——用于 context 注入与自感知「现在哪些能力在场」。
export function selectActiveCapabilities(ctx = {}) {
  return allCapabilities().filter(c => safeCall(c.detect, ctx))
}

// 本轮要自动注入的工具名（去重）。每能力用 toolWhen（缺省回落 detect）单独判断，
// 保留 tools / context 解耦。
export function capabilityToolsFor(ctx = {}) {
  const out = new Set()
  for (const c of allCapabilities()) {
    const gate = c.toolWhen || c.detect
    if (safeCall(gate, ctx)) {
      for (const name of (c.tools || [])) out.add(name)
    }
  }
  return [...out]
}

// 本轮要注入的工作流块（detect 命中且能力有 context）。
export function capabilityContextBlocks(ctx = {}) {
  const blocks = []
  for (const c of selectActiveCapabilities(ctx)) {
    if (c.context) blocks.push(c.context)
  }
  return blocks
}

// 运行时数据预喂：跑所有能力的 prefeed（自门控，非相关返回空），并发 await。
// 返回 { text: 拼好的非空预喂文本, byId: { [capId]: 该能力预喂文本 } }。
export async function runCapabilityPrefeed(ctx = {}) {
  const withPrefeed = allCapabilities().filter(c => typeof c.prefeed === 'function')
  const results = await Promise.all(withPrefeed.map(async (c) => {
    try {
      const text = await c.prefeed(ctx)
      return [c.id, typeof text === 'string' ? text : '']
    } catch {
      return [c.id, '']
    }
  }))
  const byId = {}
  for (const [id, text] of results) byId[id] = text
  const text = results.map(([, t]) => t).filter(Boolean).join('\n\n')
  return { text, byId }
}

// 自感知 / find_tool 用的能力清单。
export function listCapabilities() {
  return allCapabilities().map(c => ({
    id: c.id,
    label: c.label,
    summary: c.summary,
    tools: [...(c.tools || [])],
    triggers: [...(c.triggers || [])],
    hasContext: !!c.context,
  }))
}

// find_tool 发现：query 命中能力的 triggers / label / summary → 返回该能力（含工具与工作流摘要）。
// 实现「自感知按需激活」的发现半：关键词没在 prompt 注入时，Agent 调 find_tool 也能找到能力、
// 拿到工具并知道怎么用。
export function findCapabilitiesByQuery(query = '') {
  const q = String(query || '').toLowerCase().trim()
  if (!q) return []
  const terms = q.split(/[\s,，、。.；;]+/).map(t => t.trim()).filter(Boolean)
  const matched = []
  for (const c of allCapabilities()) {
    const hitTrigger = (c.triggers || []).some(t => q.includes(String(t).toLowerCase()))
    const hay = `${c.id} ${c.label} ${c.summary}`.toLowerCase()
    const hitText = terms.some(t => t.length >= 2 && hay.includes(t))
    if (hitTrigger || hitText) {
      matched.push({ id: c.id, label: c.label, summary: c.summary, tools: [...(c.tools || [])], context: c.context || '' })
    }
  }
  return matched
}

export function getCapability(id) {
  return CAPABILITY_BY_ID.get(id) || allCapabilities().find(c => c.id === id) || null
}

function safeCall(fn, ctx) {
  if (typeof fn !== 'function') return false
  try { return !!fn(ctx) } catch { return false }
}
