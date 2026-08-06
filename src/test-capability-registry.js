// 能力机制（capability-registry）纯算法测试。
// registry 顶层只 import 纯/惰性模块，不碰 DB/网络，可直接 node 跑（与 tool-router 同）。
//
// Run: node src/test-capability-registry.js

import {
  BROWSER_TOOLS,
  CAPABILITIES,
  capabilityToolsFor,
  capabilityContextBlocks,
  findCapabilitiesByQuery,
  isDeviceMonitoringSubscriptionIntent,
  listCapabilities,
} from './capabilities/capability-registry.js'

let failed = 0
function assert(cond, label) {
  if (!cond) { console.error(`FAIL: ${label}`); failed++; process.exitCode = 1 }
  else { console.log(`PASS: ${label}`) }
}
const has = (arr, x) => arr.includes(x)
const none = (arr, xs) => xs.every(x => !arr.includes(x))
const EXPECTED_BROWSER_TOOLS = [
  'browser_navigate',
  'browser_navigate_back',
  'browser_navigate_forward',
  'browser_reload',
  'browser_snapshot',
  'browser_find',
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_select_option',
  'browser_press_key',
  'browser_hover',
  'browser_drag',
  'browser_wait_for',
  'browser_handle_dialog',
  'browser_tabs',
  'browser_take_screenshot',
  'browser_console_messages',
  'browser_resize',
  'browser_close',
]
const FORBIDDEN_BROWSER_TOOLS = [
  'web_search',
  'web_read',
  'fetch_url',
  'browser_read',
  'browser_sessions',
  'browser_open',
  'browser_inspect',
  'browser_act',
  'browser_run_code_unsafe',
  'browser_evaluate',
  'browser_file_upload',
  'browser_drop',
]

// ctx 构造器：text 小写正文 + rawText 原文 + isTick
function ctx(rawText, isTick = false) {
  return { text: String(rawText || '').toLowerCase(), rawText: String(rawText || ''), isTick }
}

// ===== 1) 能力清单 =====
{
  const caps = listCapabilities()
  const ids = caps.map(c => c.id)
  assert(['system-browser', 'interactive-browser', 'weather', 'hotspot', 'worldcup', 'typhoon', 'software-install', 'device-information-subscription'].every(id => ids.includes(id))
    && !ids.includes('web'),
    `1) listCapabilities 含台风在内的 v1 能力 (got: ${ids.join(',')})`)
  assert(caps.every(c => c.label && c.summary), '1) 每个能力都有 label + summary（自感知用）')
  assert(BROWSER_TOOLS.join(',') === EXPECTED_BROWSER_TOOLS.join(','),
    `1b) 浏览器能力只暴露官方 MCP 安全白名单 (got: ${BROWSER_TOOLS.join(',')})`)
  assert(none(BROWSER_TOOLS, FORBIDDEN_BROWSER_TOOLS),
    '1c) 自研会话工具、任意 JS 与文件入口不在浏览器白名单')
}
{
  const systemBrowser = capabilityToolsFor(ctx('用我电脑上的浏览器打开 https://example.com'))
  assert(has(systemBrowser, 'system_browser_open') && none(systemBrowser, BROWSER_TOOLS),
    `1d) 电脑浏览器与白龙马 Playwright 工具严格分离 (got: ${systemBrowser.join(',')})`)
}

// ===== 2) tool 注入门解耦 =====
{
  // 搜索、读取、交互统一只暴露官方 Playwright MCP 白名单。
  const t = capabilityToolsFor(ctx('搜一下 vLLM'))
  assert(BROWSER_TOOLS.every(name => has(t, name)) && none(t, FORBIDDEN_BROWSER_TOOLS),
    `2a) 搜索 → 仅 Playwright MCP (got: ${t.join(',')})`)
}
{
  const staticRead = capabilityToolsFor(ctx('总结这篇文章正文 https://example.com/a'))
  assert(BROWSER_TOOLS.every(name => has(staticRead, name)) && none(staticRead, FORBIDDEN_BROWSER_TOOLS),
    `2a2) 静态正文 → 仅 Playwright MCP (got: ${staticRead.join(',')})`)
  const dynamicRead = capabilityToolsFor(ctx('用无头浏览器读取这个 JS 动态网页正文'))
  assert(BROWSER_TOOLS.every(name => has(dynamicRead, name)) && none(dynamicRead, FORBIDDEN_BROWSER_TOOLS),
    `2a3) 动态正文 → 仅 Playwright MCP (got: ${dynamicRead.join(',')})`)
  const stateful = capabilityToolsFor(ctx('打开 https://example.com 并点击登录'))
  assert(BROWSER_TOOLS.every(name => has(stateful, name))
    && none(stateful, FORBIDDEN_BROWSER_TOOLS),
  `2a4) 状态化网页 → 仅 Playwright 组 (got: ${stateful.join(',')})`)
  for (const phrase of [
    '访问 https://example.com', 'visit example.com',
    'go to https://example.com', '查看网站 https://example.com',
  ]) {
    const routed = capabilityToolsFor(ctx(phrase))
    assert(BROWSER_TOOLS.every(name => has(routed, name))
      && none(routed, FORBIDDEN_BROWSER_TOOLS),
    `2a5) 明确导航同义词 → 仅 Playwright: ${phrase} (got: ${routed.join(',')})`)
  }
  assert(none(capabilityToolsFor(ctx('go to definition in the editor')), BROWSER_TOOLS),
    '2a6) 无 URL 的普通技术表达不误触发 Playwright')
}
{
  // Tick 不因心跳身份自动预装业务能力；需要时由 find_tool 发现。
  const t = capabilityToolsFor(ctx('', true))
  assert(none(t, [...BROWSER_TOOLS, ...FORBIDDEN_BROWSER_TOOLS, 'hotspot_mode']),
    '2b) TICK → 不自动注入 browser/hotspot 工具')
}
{
  // hotspot 关键词但非 TICK → 不注入 hotspot 工具（只递规则块，工具靠 find_tool）
  const t = capabilityToolsFor(ctx('看看今天的热搜'))
  assert(none(t, ['hotspot_mode']), `2c) 热点关键词(非TICK) 不自动注入 hotspot_mode (got: ${t.join(',')})`)
}
{
  // worldcup 永不自动注入工具
  const t = capabilityToolsFor(ctx('世界杯比分怎么样'))
  assert(none(t, ['worldcup_mode']), `2d) 世界杯关键词不自动注入 worldcup_mode (got: ${t.join(',')})`)
}
{
  // typhoon 和世界杯相同：规则块按关键词注入，控制工具由 Agent 经 find_tool 自决加载。
  const t = capabilityToolsFor(ctx('台风路径怎么样'))
  assert(none(t, ['typhoon_mode']), `2d2) 台风关键词不自动注入 typhoon_mode (got: ${t.join(',')})`)
}
{
  // software-install → install_software
  const t = capabilityToolsFor(ctx('帮我安装一个 QQ'))
  assert(has(t, 'install_software'), `2e) 安装意图 → install_software (got: ${t.join(',')})`)
}
{
  // 天气也必须走唯一的官方 Playwright MCP 网页通道。
  const t = capabilityToolsFor(ctx('深圳天气怎么样'))
  assert(BROWSER_TOOLS.every(name => has(t, name)) && none(t, FORBIDDEN_BROWSER_TOOLS),
    `2f) 天气 → 仅 Playwright MCP (got: ${t.join(',')})`)
}
{
  const phrase = '我希望你关注我的鼠标键盘的电量信息，电量比较低的时候你提醒我充电'
  const t = capabilityToolsFor(ctx(phrase))
  assert(isDeviceMonitoringSubscriptionIntent(phrase)
    && has(t, 'manage_information_subscription')
    && !has(t, 'manage_reminder'),
  `2g) 自然语言设备关注请求 → 信息订阅工具 (got: ${t.join(',')})`)
  assert(!isDeviceMonitoringSubscriptionIntent('我的键盘是什么型号？'),
    '2h) 一次性设备问题不误判为持续订阅')
}

// ===== 3) 工作流块注入（context）=====
{
  assert(capabilityContextBlocks(ctx('今天天气')).some(b => b.includes('Weather Surface Rules')),
    '3a) 天气 → Weather Surface Rules 块')
  assert(capabilityContextBlocks(ctx('看热搜')).some(b => b.includes('Hotspot Panel')),
    '3b) 热点 → Hotspot Panel 块')
  assert(capabilityContextBlocks(ctx('世界杯赛况')).some(b => b.includes('World Cup Panel')),
    '3c) 世界杯 → World Cup Panel 块')
  assert(capabilityContextBlocks(ctx('台风路径')).some(b => b.includes('Typhoon Monitoring Panel')),
    '3c2) 台风 → Typhoon Monitoring Panel 块')
  assert(capabilityContextBlocks(ctx('安装微信')).some(b => b.includes('Software Install Workflow')),
    '3d) 安装 → Software Install Workflow 块')
  const browserContext = capabilityContextBlocks(ctx('打开网页并点击登录')).find(b => b.includes('BaiLongma Built-in Chromium')) || ''
  assert(browserContext.includes('browser_navigate') && browserContext.includes('browser_snapshot')
    && browserContext.includes('actions return a fresh accessibility snapshot')
    && browserContext.includes('instead of routinely calling browser_snapshot')
    && browserContext.includes('Chrome DevTools uid values') && browserContext.includes('browser_run_code_unsafe'),
  '3e) 浏览器工作流说明专用 Chrome 自动 snapshot、显式兜底、安全截图和禁用工具')
  assert(['browser_sessions', 'session_id', 'page_id', 'ref epoch'].every(term => !browserContext.includes(term))
    && !/(^|[^A-Za-z0-9_])browser_open([^A-Za-z0-9_]|$)/.test(browserContext),
    '3f) 浏览器工作流不再提示自研会话/profile/epoch 模型')
  assert(capabilityContextBlocks(ctx('随便聊两句')).length === 0,
    '3g) 中性消息 → 无能力工作流块')
  const deviceSubscriptionContext = capabilityContextBlocks(ctx('请持续关注鼠标电量，低了提醒我'))
    .find(block => block.includes('Device Information Subscription')) || ''
  assert(deviceSubscriptionContext.includes('provider_id="device_peripherals"')
    && deviceSubscriptionContext.includes('subscriber="agent"'),
  '3h) 设备关注请求 → 订阅工作流块，指定设备 provider 与 Agent 所有权')
}

// ===== 4) find_tool 能力发现（自感知按需激活）=====
{
  const hits = findCapabilitiesByQuery('装软件')
  assert(hits.some(c => c.id === 'software-install'), '4a) "装软件" → 发现 software-install 能力')
  assert(hits.find(c => c.id === 'software-install')?.tools.includes('install_software'),
    '4a) 发现的能力带 install_software 工具')
  assert(!!hits.find(c => c.id === 'software-install')?.context,
    '4a) 发现的能力带 context（工作流，供回带摘要）')
}
{
  assert(findCapabilitiesByQuery('看热点').some(c => c.id === 'hotspot'), '4b) "看热点" → 发现 hotspot')
  assert(findCapabilitiesByQuery('天气').some(c => c.id === 'weather'), '4c) "天气" → 发现 weather')
  assert(findCapabilitiesByQuery('台风路径').some(c => c.id === 'typhoon'), '4c2) "台风路径" → 发现 typhoon')
  assert(findCapabilitiesByQuery('用我电脑上的浏览器').some(c => (
    c.id === 'system-browser' && c.tools.includes('system_browser_open')
  )), '4c3) “电脑浏览器” → 发现独立系统浏览器能力')
  assert(findCapabilitiesByQuery('上网搜索').some(c => c.id === 'interactive-browser'),
    '4d) "上网搜索" → 发现统一 Playwright 网页能力')
  for (const query of ['上网搜索', '读取网页正文', '读取 JS 动态网页正文']) {
    const tools = findCapabilitiesByQuery(query).find(c => c.id === 'interactive-browser')?.tools || []
    assert(BROWSER_TOOLS.every(name => tools.includes(name)) && none(tools, FORBIDDEN_BROWSER_TOOLS),
      `4d) ${query} → 仅发现 Playwright MCP 白名单`)
  }
  assert(findCapabilitiesByQuery('').length === 0, '4e) 空 query → 无发现')
  const device = findCapabilitiesByQuery('关注鼠标键盘电量').find(c => c.id === 'device-information-subscription')
  assert(device?.tools.includes('manage_information_subscription'),
    '4f) 设备电量关注 → 可发现信息订阅能力')
}

if (failed === 0) console.log('\nAll capability-registry checks complete.')
else console.log(`\n${failed} check(s) failed.`)
