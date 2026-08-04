// Pure routing regression for browser-only web search.
//
// Run: node src/test-web-search.js

import assert from 'node:assert/strict'
import {
  BROWSER_CAPABILITY_TOOLS,
  BROWSER_TOOLS,
  capabilityContextBlocks,
  capabilityToolsFor,
  findCapabilitiesByQuery,
  listCapabilities,
} from './capabilities/capability-registry.js'
import { selectTools } from './memory/tool-router.js'

const LEGACY_WEB_TOOLS = ['web_search', 'web_read', 'fetch_url', 'browser_read']
const REQUIRED_SEARCH_CHAIN = [
  'browser_navigate',
  'browser_snapshot',
  'browser_find',
  'browser_click',
  'browser_type',
]

function capabilityContext(messageBody) {
  return {
    text: messageBody.toLowerCase(),
    rawText: messageBody,
    isTick: false,
  }
}

function assertBrowserOnly(tools, label) {
  assert.ok(REQUIRED_SEARCH_CHAIN.every(name => tools.includes(name)),
    `${label}: browser search chain is present (${tools.join(',')})`)
  assert.ok(LEGACY_WEB_TOOLS.every(name => !tools.includes(name)),
    `${label}: removed web tools stay absent (${tools.join(',')})`)
}

assert.equal(BROWSER_TOOLS.length, 20, 'browser-only web access exposes the fixed 20-tool allowlist')
assert.ok(!listCapabilities().some(capability => capability.id === 'web'),
  'legacy standalone web capability is removed')

for (const messageBody of [
  '搜一下 vLLM 最新版本',
  'search the web for the current Chrome DevTools MCP documentation',
  '总结网页正文 https://example.com/article',
  '读取这个 JavaScript 动态网页正文',
]) {
  assertBrowserOnly(
    capabilityToolsFor(capabilityContext(messageBody)),
    `capability routing: ${messageBody}`,
  )
  const turnTools = selectTools({ messageBody, isTick: false, senderId: 'ID:test' })
  assert.ok(BROWSER_CAPABILITY_TOOLS.every(name => turnTools.includes(name)),
    `turn routing makes explicit web intent executable: ${messageBody}`)
  assert.ok(LEGACY_WEB_TOOLS.every(name => !turnTools.includes(name)),
    `turn routing keeps removed web tools absent: ${messageBody}`)
}

const discovered = findCapabilitiesByQuery('上网搜索').find(capability => capability.id === 'interactive-browser')
assert.ok(discovered, 'find_tool discovery resolves web search to the interactive-browser capability')
assert.equal(discovered.tools[0], 'browser_set_display_mode',
  'discovery prioritizes the required model-selected display mode before page actions')
assert.deepEqual([...discovered.tools].sort(), [...BROWSER_CAPABILITY_TOOLS].sort(),
  'discovery returns the fixed dedicated-Chrome allowlist plus display-mode switching')

const context = capabilityContextBlocks(capabilityContext('帮我上网搜索 Chrome DevTools MCP'))
  .join('\n')
assert.match(context, /browser_navigate/)
assert.match(context, /https:\/\/www\.baidu\.com/)
assert.match(context, /browser_snapshot/)
assert.match(context, /browser_click/)
assert.match(context, /browser_type/)
assert.match(context, /Do not put keywords in a search-engine URL/)
assert.doesNotMatch(context, /bing\.com\/search\?q=/)
assert.match(context, /actions return a fresh accessibility snapshot/)
assert.match(context, /instead of routinely calling browser_snapshot/)
assert.match(context, /CAPTCHA\/challenge page/)
assert.match(context, /hard stop for automated web access in the current user turn/)
assert.match(context, /Do not navigate to another provider/)
assert.match(context, /Continue only in a new user turn after the user confirms/)
assert.match(context, /Chrome DevTools uid values[\s\S]*latest raw uid/)
assert.match(context, /dedicated Chrome profile/)
assert.match(context, /do not replace it with model memory for current\/latest\/recent facts/)
assert.match(context, /Count and name only sources that actually loaded/)
for (const name of LEGACY_WEB_TOOLS) {
  assert.match(context, new RegExp(`${name}[^\\n]*unavailable`, 'i'),
    `browser workflow explicitly marks ${name} unavailable`)
}

const sparse = selectTools({
  messageBody: '闲聊两句',
  isTick: false,
  senderId: 'ID:test',
})
assert.ok(BROWSER_TOOLS.every(name => !sparse.includes(name)),
  'browser tools are not injected into an unrelated sparse turn')

console.log('test-web-search passed: search/read intents route exclusively through Chrome DevTools MCP')
