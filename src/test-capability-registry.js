// 能力机制（capability-registry）纯算法测试。
// registry 顶层只 import 纯/惰性模块，不碰 DB/网络，可直接 node 跑（与 tool-router 同）。
//
// Run: node src/test-capability-registry.js

import {
  CAPABILITIES,
  capabilityToolsFor,
  capabilityContextBlocks,
  findCapabilitiesByQuery,
  listCapabilities,
} from './capabilities/capability-registry.js'

let failed = 0
function assert(cond, label) {
  if (!cond) { console.error(`FAIL: ${label}`); failed++; process.exitCode = 1 }
  else { console.log(`PASS: ${label}`) }
}
const has = (arr, x) => arr.includes(x)
const none = (arr, xs) => xs.every(x => !arr.includes(x))

// ctx 构造器：text 小写正文 + rawText 原文 + isTick
function ctx(rawText, isTick = false) {
  return { text: String(rawText || '').toLowerCase(), rawText: String(rawText || ''), isTick }
}

// ===== 1) 能力清单 =====
{
  const caps = listCapabilities()
  const ids = caps.map(c => c.id)
  assert(['web', 'weather', 'hotspot', 'worldcup', 'typhoon', 'software-install'].every(id => ids.includes(id)),
    `1) listCapabilities 含台风在内的 v1 能力 (got: ${ids.join(',')})`)
  assert(caps.every(c => c.label && c.summary), '1) 每个能力都有 label + summary（自感知用）')
}

// ===== 2) tool 注入门解耦 =====
{
  // 无状态搜索只暴露搜索工具，避免和正文抓取/浏览器渲染竞争。
  const t = capabilityToolsFor(ctx('搜一下 vLLM'))
  assert(has(t, 'web_search') && has(t, 'web_read') && none(t, ['fetch_url', 'browser_read']), `2a) 搜索 → web_search + web_read (got: ${t.join(',')})`)
}
{
  const staticRead = capabilityToolsFor(ctx('总结这篇文章正文 https://example.com/a'))
  assert(has(staticRead, 'web_read') && none(staticRead, ['web_search', 'fetch_url', 'browser_read']),
    `2a2) 静态正文 → 仅 web_read (got: ${staticRead.join(',')})`)
  const dynamicRead = capabilityToolsFor(ctx('用无头浏览器读取这个 JS 动态网页正文'))
  assert(has(dynamicRead, 'web_read') && none(dynamicRead, ['web_search', 'fetch_url', 'browser_read']),
    `2a3) 动态无状态正文 → 同一 web_read (got: ${dynamicRead.join(',')})`)
  const stateful = capabilityToolsFor(ctx('打开 https://example.com 并点击登录'))
  assert(['browser_sessions', 'browser_open', 'browser_navigate', 'browser_inspect', 'browser_act', 'browser_tabs', 'browser_close'].every(name => has(stateful, name))
    && none(stateful, ['web_search', 'fetch_url', 'browser_read']),
  `2a4) 状态化网页 → 仅 Playwright 组 (got: ${stateful.join(',')})`)
  for (const phrase of [
    '访问 https://example.com', 'visit example.com',
    'go to https://example.com', '查看网站 https://example.com',
  ]) {
    const routed = capabilityToolsFor(ctx(phrase))
    assert(['browser_sessions', 'browser_open', 'browser_navigate', 'browser_inspect', 'browser_act', 'browser_tabs', 'browser_close'].every(name => has(routed, name))
      && none(routed, ['web_search', 'fetch_url', 'browser_read']),
    `2a5) 明确导航同义词 → 仅 Playwright: ${phrase} (got: ${routed.join(',')})`)
  }
  assert(none(capabilityToolsFor(ctx('go to definition in the editor')), ['browser_open', 'browser_act']),
    '2a6) 无 URL 的普通技术表达不误触发 Playwright')
}
{
  // Tick 不因心跳身份自动预装业务能力；需要时由 find_tool 发现。
  const t = capabilityToolsFor(ctx('', true))
  assert(none(t, ['web_search', 'hotspot_mode']), '2b) TICK → 不自动注入 web/hotspot 工具')
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
  // 天气 → 带上 web 工具（修复旧路径偶尔无 fetch 的缺口）
  const t = capabilityToolsFor(ctx('深圳天气怎么样'))
  assert(has(t, 'web_read') && !has(t, 'web_search'), `2f) 天气 → 仅 web_read (got: ${t.join(',')})`)
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
  assert(capabilityContextBlocks(ctx('随便聊两句')).length === 0,
    '3e) 中性消息 → 无能力工作流块')
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
  assert(findCapabilitiesByQuery('上网搜索').some(c => c.id === 'web'), '4d) "上网搜索" → 发现 web')
  assert(findCapabilitiesByQuery('上网搜索').find(c => c.id === 'web')?.tools.join(',') === 'web_search,web_read',
    '4d2) 搜索发现加载 web_search + web_read')
  assert(findCapabilitiesByQuery('读取网页正文').find(c => c.id === 'web')?.tools.join(',') === 'web_read',
    '4d3) 静态正文发现只加载 web_read')
  assert(findCapabilitiesByQuery('读取 JS 动态网页正文').find(c => c.id === 'web')?.tools.join(',') === 'web_read',
    '4d4) 动态正文发现也只加载 web_read')
  assert(findCapabilitiesByQuery('').length === 0, '4e) 空 query → 无发现')
}

if (failed === 0) console.log('\nAll capability-registry checks complete.')
else console.log(`\n${failed} check(s) failed.`)
