import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { TOOL_SCHEMAS, getToolSchemas } from './capabilities/schemas.js'
import { BROWSER_TOOLS, findCapabilitiesByQuery } from './capabilities/capability-registry.js'
import { selectTools } from './memory/tool-router.js'
import { buildToolCatalogText } from './docs/auto-catalog.js'
import { evaluateToolPolicy } from './capabilities/tool-policy.js'
import { buildToolAuditRecord, sanitizeToolAuditArgs, summarizeToolExecution } from './capabilities/tool-audit.js'
import { executeTool } from './capabilities/executor.js'
import { config } from './config.js'
import { browserContextOptions } from './capabilities/tools/browser/runtime.js'
import { BROWSER_VIEWPORT } from './capabilities/tools/web/browser.js'
import {
  createBoundedBrowserShutdown,
  formatBrowserRuntimeContext,
  getBrowserRuntimeState,
  getBrowserSessionManager,
  installBrowserProcessShutdownHooks,
  __resetBrowserSessionManagerForTest,
  __setBrowserSessionManagerForTest,
} from './capabilities/tools/browser-tools.js'
import {
  assertBrowserUrlAllowed,
  BrowserSessionManager,
} from './capabilities/tools/browser/index.js'

const names = getToolSchemas(BROWSER_TOOLS).map(schema => schema.function.name)
assert.deepEqual(names, BROWSER_TOOLS, 'all browser schemas are discoverable')
for (const name of BROWSER_TOOLS) {
  assert.equal(TOOL_SCHEMAS[name].function.parameters.additionalProperties, false, `${name} schema is strict`)
  assert.match(TOOL_SCHEMAS[name].function.description, /untrusted/i)
}
assert.equal(TOOL_SCHEMAS.browser_act.function.parameters.properties.action.enum.includes('evaluate'), false)
assert.match(TOOL_SCHEMAS.browser_open.function.parameters.properties.visible.description, /Default true/)
assert.match(TOOL_SCHEMAS.browser_open.function.parameters.properties.persistent.description, /Default true/)
assert.match(TOOL_SCHEMAS.browser_open.function.description, /do not expire|not reclaimed/i)
assert.ok(TOOL_SCHEMAS.browser_navigate.function.parameters.properties.url)
assert.ok(TOOL_SCHEMAS.browser_sessions.function.parameters.properties.include_profiles)
assert.ok(TOOL_SCHEMAS.browser_close.function.parameters.properties.clear_profile)
assert.ok(TOOL_SCHEMAS.set_security.function.parameters.properties.browser_private_network)
assert.equal(browserContextOptions({}).serviceWorkers, 'block', 'service workers are blocked')
assert.equal(browserContextOptions({}, { visible: true }).viewport, null,
  'headed browser contexts follow native window resizes')
assert.deepEqual(browserContextOptions({}, { visible: false }).viewport, BROWSER_VIEWPORT,
  'headless browser contexts keep a deterministic viewport')
assert.equal(browserContextOptions({ viewport: null }, { visible: false }).viewport, null,
  'an explicit null viewport is preserved')
assert.deepEqual(browserContextOptions({ viewport: undefined }, { visible: false }).viewport, BROWSER_VIEWPORT,
  'an undefined viewport retains the headless default')
assert.ok(BROWSER_TOOLS.every(name => buildToolCatalogText().includes(name)), 'automatic tool catalog includes browser tools')
assert.deepEqual(findCapabilitiesByQuery('fill form')[0]?.tools, BROWSER_TOOLS)
assert.ok(BROWSER_TOOLS.every(name => selectTools({ messageBody: 'please fill form and click website', isTick: false }).includes(name)))
assert.ok(BROWSER_TOOLS.every(name => selectTools({ messageBody: 'open website', isTick: false }).includes(name)))
assert.ok(BROWSER_TOOLS.every(name => !selectTools({ messageBody: 'search current news', isTick: false }).includes(name)))
assert.ok(BROWSER_TOOLS.every(name => selectTools({ messageBody: '继续刚才的页面', isTick: false }).includes(name)))
assert.ok(BROWSER_TOOLS.every(name => selectTools({ messageBody: 'is the browser open?', isTick: false }).includes(name)))
assert.ok(['web_search', 'web_read', 'fetch_url', 'browser_read'].every(name => !selectTools({
  messageBody: '打开网页并点击登录', isTick: false,
}).includes(name)), 'stateful browser intent excludes every stateless web fallback')
assert.deepEqual(selectTools({
  messageBody: '请读取并总结这个链接的网页正文 https://example.com/article', isTick: false,
}).filter(name => ['web_search', 'web_read', 'fetch_url', 'browser_read'].includes(name)), ['web_read'])
for (const messageBody of [
  'summarize this article', 'extract article content', 'read page content',
  '总结这篇文章正文', '提取文章正文',
]) {
  const routed = selectTools({ messageBody, isTick: false })
  assert.deepEqual(routed.filter(name => ['web_search', 'web_read', 'fetch_url', 'browser_read'].includes(name)), ['web_read'],
    `explicit static body read injects only web_read: ${messageBody}`)
  assert.ok(BROWSER_TOOLS.every(name => !routed.includes(name)),
    `explicit stateless body read does not inject Playwright: ${messageBody}`)
}
for (const messageBody of [
  'read this JavaScript-rendered article content', '用无头浏览器提取动态网页正文',
]) {
  const routed = selectTools({ messageBody, isTick: false })
  assert.deepEqual(routed.filter(name => ['web_search', 'web_read', 'fetch_url', 'browser_read'].includes(name)), ['web_read'],
    `explicit dynamic one-shot body read also injects web_read: ${messageBody}`)
  assert.ok(BROWSER_TOOLS.every(name => !routed.includes(name)))
}
assert.deepEqual(selectTools({ messageBody: 'search current news online', isTick: false })
  .filter(name => ['web_search', 'web_read', 'fetch_url', 'browser_read'].includes(name)), ['web_search', 'web_read'])
assert.ok(['web_search', 'web_read', ...BROWSER_TOOLS].every(name => selectTools({
  messageBody: 'search online then open website and click the first link', isTick: false,
}).includes(name)), 'combined search + interaction keeps both web and Playwright tools')
assert.ok(BROWSER_TOOLS.every(name => selectTools({
  messageBody: '继续', isTick: false, activeBrowserSessionCount: 1,
}).includes(name)), 'active session keeps the entire Playwright tool group available for terse follow-up')
assert.equal(selectTools({
  messageBody: '继续', isTick: false, activeBrowserSessionCount: 1,
  recentActionLog: [{ tool: 'browser_read' }],
}).includes('browser_read'), false, 'active-session terse follow-up cannot be diverted to browser_read')
assert.ok(BROWSER_TOOLS.every(name => selectTools({
  messageBody: 'continue', isTick: false, recentPlaywrightAction: true,
  recentActionLog: [{ tool: 'browser_tabs' }, { tool: 'browser_read' }],
}).includes(name)), 'recent Playwright action keeps the full group for a terse follow-up even after the session closed')
assert.equal(selectTools({
  messageBody: 'continue', isTick: false, recentPlaywrightAction: true,
  recentActionLog: [{ tool: 'browser_tabs' }, { tool: 'browser_read' }],
}).includes('browser_read'), false, 'recent-session terse follow-up removes competing browser_read from ActionLog')
assert.ok(BROWSER_TOOLS.every(name => !selectTools({
  messageBody: 'explain Playwright browser context isolation', isTick: false, activeBrowserSessionCount: 1,
}).includes(name)), 'an active session does not inject Playwright into an unrelated technical question')
assert.match(formatBrowserRuntimeContext({ count: 0, sessions: [] }, { includeEmpty: true }), /no active session/i)
for (const messageBody of [
  '打开浏览器', '打开网页', '继续刚才页面', '当前页面', '浏览器是否开着', '关闭浏览器',
  '切换标签页', '点击填写登录', '打开 https://example.com/path', '浏览器操作', '网页截图',
  'open the browser', 'continue the previous page', 'current page', 'close browser',
  'switch tabs', 'click the login button', 'fill the form', 'sign in', 'open example.com', 'open this link',
  '访问 https://example.com', 'visit example.com', 'go to https://example.com', '查看网站 https://example.com',
  'browser automation', 'interact with the page', 'take a screenshot',
]) {
  const routed = selectTools({ messageBody, isTick: false })
  assert.ok(BROWSER_TOOLS.every(name => routed.includes(name)), `stateful browser route: ${messageBody}`)
  assert.equal(routed.includes('browser_read'), false, `stateless browser_read does not compete: ${messageBody}`)
}
for (const messageBody of [
  'ClickHouse query', 'database table schema', 'tabular report',
  'Playwright browser context architecture', 'Browser API type definitions',
  'web worker lifecycle', 'URL parser implementation', 'React tab component',
  'Google OAuth implementation', '搜索算法实现', 'JavaScript webpage rendering architecture',
  'go to definition in the editor', 'visit pattern implementation',
]) {
  const routed = selectTools({ messageBody, isTick: false })
  assert.ok(BROWSER_TOOLS.every(name => !routed.includes(name)), `non-browser term does not trigger Playwright: ${messageBody}`)
  assert.ok(['web_search', 'web_read', 'fetch_url', 'browser_read'].every(name => !routed.includes(name)),
    `ordinary technical term does not trigger stateless web tools: ${messageBody}`)
}
assert.ok(BROWSER_TOOLS.every(name => !selectTools({ messageBody: 'click', isTick: false }).includes(name)),
  'objectless exact click requires active/recent browser continuity evidence')
assert.ok(BROWSER_TOOLS.every(name => selectTools({
  messageBody: 'click', isTick: false, activeBrowserSessionCount: 1,
}).includes(name)), 'objectless exact click is accepted as a live-session follow-up')

const previousLanAccess = config.network.allowLanAccess
const previousBrowserPrivateNetwork = config.security.browserPrivateNetwork
config.network.allowLanAccess = true
config.security.browserPrivateNetwork = false
const permissionManager = getBrowserSessionManager()
assert.equal(permissionManager.allowPrivateNetwork(), false, 'backend LAN listening does not grant browser private-network access')
config.security.browserPrivateNetwork = true
assert.equal(permissionManager.allowPrivateNetwork(), true, 'dedicated browser permission controls private-network access')
await __resetBrowserSessionManagerForTest()
config.network.allowLanAccess = previousLanAccess
config.security.browserPrivateNetwork = previousBrowserPrivateNetwork

assert.equal(evaluateToolPolicy('browser_act', { action: 'click' }, { autonomous: true }).allowed, false)
assert.equal(evaluateToolPolicy('browser_open', { visible: true }, { autonomous: true }).allowed, false)
assert.equal(evaluateToolPolicy('browser_open', { persistent: true }, { autonomous: true }).allowed, false)
assert.equal(evaluateToolPolicy('browser_open', { visible: 'false' }, { autonomous: true }).allowed, false)
assert.equal(evaluateToolPolicy('browser_open', { persistent: 1 }, { autonomous: true }).allowed, false)
assert.equal(evaluateToolPolicy('browser_open', { url: 'https://example.com' }, { autonomous: true }).allowed, false)
assert.equal(evaluateToolPolicy('browser_open', { url: 'https://example.com', visible: false }, { autonomous: true }).allowed, false)
assert.equal(evaluateToolPolicy('browser_open', { url: 'https://example.com', visible: false, persistent: false }, { autonomous: true }).allowed, true)
assert.equal(evaluateToolPolicy('browser_open', { visible: false, persistent: false }, { autonomous: true }).allowed, true)
assert.equal(evaluateToolPolicy('browser_open', {}, {}).allowed, true)
assert.equal(evaluateToolPolicy('browser_inspect', {}, { autonomous: true }).allowed, true)
assert.equal(evaluateToolPolicy('browser_sessions', {}, { autonomous: true }).allowed, true)
assert.equal(evaluateToolPolicy('browser_close', {}, { autonomous: true }).allowed, true)
assert.equal(evaluateToolPolicy('browser_close', { clear_profile: true }, { autonomous: true }).allowed, false)
assert.equal(evaluateToolPolicy('browser_close', { clear_profile: true }, {}).risk, 'high')
const previousBlockedTools = config.security.blockedTools
config.security.blockedTools = ['web_read']
assert.equal(evaluateToolPolicy('web_read', {}).allowed, false)
assert.equal(evaluateToolPolicy('fetch_url', {}).allowed, false, 'legacy read aliases inherit the canonical block')
config.security.blockedTools = previousBlockedTools

const secret = `FORM_SECRET_${Date.now()}_${Math.random()}`
const sanitized = sanitizeToolAuditArgs('browser_act', {
  session_id: 'bs_test', action: 'fill', ref: 'ref-1', value: secret, values: [secret],
})
assert.equal(sanitized.value, '[redacted]')
assert.equal(sanitized.values, '[redacted]')
assert.equal(summarizeToolExecution('browser_act', sanitized), 'browser_act(session=bs_test, action=fill)')
for (const name of ['browser_open', 'browser_tabs', 'browser_close']) {
  const urlSecret = `AUDIT_URL_SECRET_${name}`
  const safeBrowserArgs = sanitizeToolAuditArgs(name, {
    url: `https://user:password@example.com/path?token=${urlSecret}#${urlSecret}`,
  })
  assert.equal(safeBrowserArgs.url, 'https://example.com/path')
  assert.equal(JSON.stringify(safeBrowserArgs).includes(urlSecret), false)
}

for (const url of [
  'file:///etc/passwd', 'javascript:alert(1)', 'data:text/plain,x', 'chrome://settings', 'devtools://devtools',
  'https://user:pass@example.com/',
]) {
  await assert.rejects(assertBrowserUrlAllowed(url), err => err.code === 'URL_BLOCKED')
}
await assert.rejects(assertBrowserUrlAllowed('http://127.0.0.1/'), err => err.code === 'PRIVATE_NETWORK_BLOCKED')
await assert.rejects(assertBrowserUrlAllowed('http://localhost/'), err => err.code === 'PRIVATE_NETWORK_BLOCKED')
await assert.rejects(
  assertBrowserUrlAllowed('https://rebind.test/', { hostnameResolver: async () => [{ address: '192.168.1.5' }] }),
  err => err.code === 'PRIVATE_NETWORK_BLOCKED',
)
assert.equal(await assertBrowserUrlAllowed('http://127.0.0.1/', { allowPrivateNetwork: true }), 'http://127.0.0.1/')
assert.equal(
  await assertBrowserUrlAllowed('https://public.test/', { hostnameResolver: async () => [{ address: '203.0.113.10' }] }),
  'https://public.test/',
)

class FakePage extends EventEmitter {
  constructor() { super(); this.closed = false }
  setDefaultTimeout() {}
  setDefaultNavigationTimeout() {}
  isClosed() { return this.closed }
  url() { return 'about:blank' }
  async close() { this.closed = true; this.emit('close') }
}
class FakeContext extends EventEmitter {
  constructor() { super(); this.routeHandler = null; this.webSocketHandler = null; this.page = new FakePage() }
  pages() { return [] }
  async route(_pattern, handler) { this.routeHandler = handler }
  async routeWebSocket(_pattern, handler) { this.webSocketHandler = handler }
  async newPage() { return this.page }
  async close() { await this.page.close() }
}
class FakeBrowser extends EventEmitter {
  constructor(context) { super(); this.context = context; this.closed = false }
  isConnected() { return !this.closed }
  async newContext() { return this.context }
  async close() { this.closed = true; this.emit('disconnected') }
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-browser-agent-'))
const guardedContext = new FakeContext()
const guardedBrowser = new FakeBrowser(guardedContext)
const guardedManager = new BrowserSessionManager({
  sandboxRoot: path.join(tempRoot, 'sandbox'), userDataRoot: path.join(tempRoot, 'user'),
  chromiumLoader: async () => ({ launch: async () => guardedBrowser }),
  hostnameResolver: async () => [{ address: '203.0.113.10' }],
})
try {
  await assert.rejects(guardedManager.open({ visible: 'false' }), err => err.code === 'INVALID_ARGUMENT')
  await assert.rejects(guardedManager.open({ persistent: 'false' }), err => err.code === 'INVALID_ARGUMENT')
  const userOpened = await guardedManager.open({ url: 'about:blank' })
  assert.equal(userOpened.visible, true, 'user-driven browser defaults to visible')
  assert.equal(userOpened.persistent, false, 'about:blank remains ephemeral because it has no site origin')
  assert.equal(typeof guardedContext.routeHandler, 'function', 'request/redirect guard is installed on context')
  assert.equal(typeof guardedContext.webSocketHandler, 'function', 'WebSocket guard is installed on context')
  let continued = false
  await guardedContext.routeHandler({
    request: () => ({ url: () => 'https://public.test/asset.js' }),
    continue: async () => { continued = true }, abort: async () => assert.fail('public request aborted'),
  })
  assert.equal(continued, true)
  let aborted = false
  await guardedContext.routeHandler({
    request: () => ({ url: () => 'http://169.254.169.254/latest/meta-data' }),
    continue: async () => assert.fail('private redirect/request continued'), abort: async () => { aborted = true },
  })
  assert.equal(aborted, true, 'private redirect/request is aborted')
  let socketConnected = false
  await guardedContext.webSocketHandler({
    url: () => 'wss://public.test/socket', connectToServer: () => { socketConnected = true },
    close: async () => assert.fail('public WebSocket closed'),
  })
  assert.equal(socketConnected, true)
  let socketClosed = false
  await guardedContext.webSocketHandler({
    url: () => 'ws://127.0.0.1/socket', connectToServer: () => assert.fail('private WebSocket connected'),
    close: async () => { socketClosed = true },
  })
  assert.equal(socketClosed, true, 'private WebSocket is closed by policy')
} finally {
  await guardedManager.shutdown()
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

const degradedRuntimeSecret = 'https://example.test/?access_token=DO_NOT_INJECT'
const degradedRuntimeManager = {
  listSessions() {
    return {
      ok: true,
      count: 0,
      sessions: [],
      degraded_sessions: [{
        session_id: 'bs_degraded',
        state: 'degraded',
        close_reason: 'USER_CLOSE',
        failure_code: 'SESSION_CLOSE_FAILED',
        visible: true,
        persistent: false,
        url: degradedRuntimeSecret,
      }],
    }
  },
  async shutdown() {},
}
await __setBrowserSessionManagerForTest(degradedRuntimeManager)
try {
  const degradedRuntimeContext = formatBrowserRuntimeContext(getBrowserRuntimeState())
  assert.match(degradedRuntimeContext, /no active session exists, but degraded sessions remain tracked/i)
  assert.match(degradedRuntimeContext, /bs_degraded/)
  assert.match(degradedRuntimeContext, /SESSION_CLOSE_FAILED/)
  assert.equal(degradedRuntimeContext.includes(degradedRuntimeSecret), false, 'runtime injection whitelists degraded diagnostics')
} finally {
  await __resetBrowserSessionManagerForTest()
}

const fakeManager = {
  listSessions() { return { ok: true, count: 1, sessions: [{ session_id: 'bs_fake', visible: true, persistent: false, active_page_id: 'bp_fake', pages: [{ page_id: 'bp_fake', active: true, url: 'about:blank' }] }] } },
  async open() { return { ok: true, session_id: 'bs_fake', page_id: 'bp_fake', url: 'about:blank' } },
  async navigate(args) { return { ok: true, session_id: args.session_id, page_id: args.page_id, url: args.url } },
  async inspect() { const err = new Error('missing fake session'); err.code = 'SESSION_NOT_FOUND'; throw err },
  async act(args) { return { ok: true, session_id: args.session_id, action: args.action, echo: args.value } },
  async tabs() { return { ok: true, pages: [] } },
  async close() { return { ok: true, closed: true } },
  async shutdown() {},
}
await __setBrowserSessionManagerForTest(fakeManager)
try {
  const found = JSON.parse(await executeTool('find_tool', { query: 'fill form' }))
  assert.ok(BROWSER_TOOLS.every(name => found.loaded.includes(name)), 'find_tool loads browser capability')
  assert.equal(JSON.parse(await executeTool('browser_open', {})).ok, true, 'executor maps browser success')
  assert.equal(JSON.parse(await executeTool('browser_navigate', {
    session_id: 'bs_fake', page_id: 'bp_fake', url: 'https://example.com',
  })).url, 'https://example.com', 'executor maps browser navigation')
  assert.equal(JSON.parse(await executeTool('browser_sessions', {})).count, 1, 'executor maps browser session listing')
  const failed = JSON.parse(await executeTool('browser_inspect', { session_id: 'missing' }))
  assert.deepEqual({ ok: failed.ok, code: failed.code }, { ok: false, code: 'SESSION_NOT_FOUND' })
  await executeTool('browser_act', {
    session_id: 'bs_fake', action: 'fill', ref: 'ref-1', value: secret,
  })
  const log = buildToolAuditRecord({
    name: 'browser_act', args: { session_id: 'bs_fake', action: 'fill', ref: 'ref-1', value: secret },
    context: {}, policy: { risk: 'high' }, status: 'ok',
    result: JSON.stringify({
      ok: true, session_id: 'bs_fake', action: 'fill', echo: secret,
      url: `https://x.test/?q=${encodeURIComponent(secret)}#${secret}`,
    }),
    error: secret, startedAt: Date.now(),
  })
  const persistedAudit = JSON.stringify(log)
  assert.equal(persistedAudit.includes(secret), false, 'fill value absent from entire persisted audit record')
  assert.match(log.summary, /session=bs_fake.*action=fill/)
  assert.equal(log.argsJson.includes('[redacted]'), true)
  assert.equal(log.resultPreview.includes('echo'), false)
  assert.equal(log.error, 'browser action failed')
} finally {
  await __resetBrowserSessionManagerForTest()
}

let resolveShutdown
let shutdownCalls = 0
const shutdownGate = new Promise(resolve => { resolveShutdown = resolve })
const fakeProcess = new EventEmitter()
const exits = []
const hooks = installBrowserProcessShutdownHooks({
  processTarget: fakeProcess,
  shutdown: async () => { shutdownCalls += 1; await shutdownGate },
  timeoutMs: 1_000,
  exit: code => exits.push(code),
})
fakeProcess.emit('SIGTERM')
fakeProcess.emit('SIGINT')
await Promise.resolve()
assert.equal(shutdownCalls, 1, 'multiple signals share one shutdown')
assert.deepEqual(exits, [], 'process waits for browser shutdown')
resolveShutdown()
await hooks.run('SIGTERM')
assert.deepEqual(exits, [143], 'process exits once after shutdown')
hooks.dispose()

let boundedCompleted = false
const bounded = createBoundedBrowserShutdown({
  shutdown: () => new Promise(() => {}),
  timeoutMs: 5,
  onComplete: () => { boundedCompleted = true },
})
await bounded('SIGTERM')
assert.equal(boundedCompleted, true, 'shutdown has a hard timeout')

console.log('test-browser-agent-integration passed')
