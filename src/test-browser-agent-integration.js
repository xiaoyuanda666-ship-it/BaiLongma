import assert from 'node:assert/strict'
import {
  BROWSER_CAPABILITY_TOOLS,
  BROWSER_DATA_TOOLS,
  BROWSER_DISPLAY_TOOLS,
  BROWSER_TOOLS,
  SYSTEM_BROWSER_TOOLS,
  capabilityContextBlocks,
  findCapabilitiesByQuery,
} from './capabilities/capability-registry.js'
import { selectTools } from './memory/tool-router.js'
import { classifyTool, evaluateToolPolicy } from './capabilities/tool-policy.js'
import { BUILTIN_BROWSER_ALLOWED_TOOLS } from './mcp/chrome-devtools-server.js'
import {
  buildToolAuditRecord,
  sanitizeToolAuditArgs,
  summarizeToolExecution,
} from './capabilities/tool-audit.js'
import { TOOL_SCHEMAS } from './capabilities/builtin-tools.js'
import { getToolSchemas } from './capabilities/schemas.js'
import { execBrowserSetDisplayMode } from './capabilities/tools/browser-display.js'
import { execBrowserClearData } from './capabilities/tools/browser-data.js'
import { execSystemBrowserOpen } from './capabilities/tools/system-browser.js'
import { isExplicitAgentBrowserDataDeletionRequest } from './mcp/browser-data-intent.js'
import { executeBuiltInChromeTool } from './mcp/client-manager.js'

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
  'browser_sessions',
  'browser_open',
  'browser_inspect',
  'browser_act',
  'browser_run_code_unsafe',
  'browser_evaluate',
  'browser_file_upload',
  'browser_drop',
]
const MUTATING_BROWSER_TOOLS = [
  'browser_navigate',
  'browser_navigate_back',
  'browser_navigate_forward',
  'browser_reload',
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
  'browser_resize',
  'browser_close',
]
const READ_ONLY_BROWSER_TOOLS = [
  'browser_snapshot',
  'browser_find',
  'browser_take_screenshot',
  'browser_console_messages',
]
const STATELESS_WEB_TOOLS = ['web_search', 'web_read', 'fetch_url', 'browser_read']
const LEGACY_BROWSER_TOOLS = ['browser_sessions', 'browser_open', 'browser_inspect', 'browser_act']
const REMOVED_WEB_AND_BROWSER_TOOLS = [...STATELESS_WEB_TOOLS, ...LEGACY_BROWSER_TOOLS]

assert.deepEqual(BROWSER_TOOLS, EXPECTED_BROWSER_TOOLS,
  'browser capability preserves stable public names in a fixed safe allowlist')
assert.deepEqual([...BROWSER_TOOLS].sort(), [...BUILTIN_BROWSER_ALLOWED_TOOLS].sort(),
  'router allowlist matches the built-in MCP process boundary')
assert.ok(FORBIDDEN_BROWSER_TOOLS.every(name => !BROWSER_TOOLS.includes(name)),
  'legacy browser tools, arbitrary JavaScript, and local-file ingress are not exposed')
assert.ok(REMOVED_WEB_AND_BROWSER_TOOLS.every(name => TOOL_SCHEMAS[name] === undefined),
  'removed web and self-built browser tools have no built-in model schema')
assert.deepEqual(getToolSchemas(REMOVED_WEB_AND_BROWSER_TOOLS), [],
  'schema lookup cannot expose removed web or self-built browser tools')
assert.deepEqual(BROWSER_DISPLAY_TOOLS, ['browser_set_display_mode'])
assert.ok(TOOL_SCHEMAS.browser_set_display_mode,
  'the presentation-only browser mode tool has a built-in schema')
assert.deepEqual(SYSTEM_BROWSER_TOOLS, ['system_browser_open'])
assert.ok(TOOL_SCHEMAS.system_browser_open,
  'the installed computer browser has a dedicated built-in schema')
assert.deepEqual(BROWSER_DATA_TOOLS, ['browser_clear_data'])
assert.ok(TOOL_SCHEMAS.browser_clear_data,
  'persistent browser data deletion has a separate high-risk built-in schema')
const browserDiscoveryTools = findCapabilitiesByQuery('fill form')[0]?.tools || []
assert.equal(browserDiscoveryTools[0], 'browser_set_display_mode',
  'browser discovery puts the required model-selected display mode before page actions')
assert.deepEqual([...browserDiscoveryTools].sort(), [...BROWSER_CAPABILITY_TOOLS].sort(),
  'find_tool discovery loads dedicated Chrome plus the presentation-only display switch')

for (const messageBody of [
  '切换到小浏览器', '切换到大浏览器', '换成浏览器卡片', '改成外部浏览器',
  '用大的窗口打开', '请用大一点的窗口打开', '用大 窗口 口打', '用小的窗口打开',
  'switch browser to compact card', 'change browser to large window',
]) {
  const routed = selectTools({ messageBody, isTick: false })
  assert.ok(BROWSER_CAPABILITY_TOOLS.every(name => routed.includes(name)),
    `explicit browser size switch is executable in the first round: ${messageBody}`)
}

for (const messageBody of [
  '看看这个页面有没有机器学习',
  '机器学习在这页出现几次',
  '帮我在当前页面里找一下机器学习',
]) {
  const routed = selectTools({ messageBody, isTick: false })
  assert.ok(routed.includes('browser_find'), `current-page find is directly executable: ${messageBody}`)
  assert.ok(['download_file', 'run_command', 'exec_command'].every(name => !routed.includes(name)),
    `current-page find does not inject shell/download fallbacks: ${messageBody}`)
}

for (const messageBody of [
  '查查 Electron 官方网站',
  '查查看 Electron 官网',
  '找找 Electron 官方网站',
  '帮我看看 Electron 官网',
  '再帮我查查 Electron 官方网站',
]) {
  const routed = selectTools({ messageBody, isTick: false })
  assert.ok(BROWSER_CAPABILITY_TOOLS.every(name => routed.includes(name)),
    `concrete colloquial online lookup is executable without discovery: ${messageBody}`)
}
for (const messageBody of ['我只是随口说说，不用查查', '别帮我找找网站，我不需要']) {
  const routed = selectTools({ messageBody, isTick: false })
  assert.ok(BROWSER_TOOLS.every(name => !routed.includes(name)),
    `negated colloquial lookup does not activate the browser: ${messageBody}`)
}

for (const messageBody of [
  '不是详情页，我要回搜索结果列表页',
  '不对，回搜索结果列表',
  '我说的是结果页',
  '别进详情，回列表',
  '回刚才的搜索结果页',
]) {
  const routed = selectTools({
    messageBody,
    isTick: false,
    recentActionLog: [{ tool: 'browser_click' }],
  })
  assert.ok(BROWSER_CAPABILITY_TOOLS.every(name => routed.includes(name)),
    `results-list correction keeps direct browser continuity: ${messageBody}`)
}

assert.equal(findCapabilitiesByQuery('用大的窗口打开')[0]?.tools[0], 'browser_set_display_mode',
  'find_tool prioritizes the display switch for a spoken size request')

for (const messageBody of [
  '用我电脑上的浏览器打开 https://example.com',
  '用电脑的浏览器打开 https://example.com',
  '电脑浏览器打开这个网站',
  '用默认浏览器打开视频',
]) {
  const routed = selectTools({ messageBody, isTick: false })
  assert.ok(routed.includes('system_browser_open'),
    `computer browser request exposes its explicit first-round tool: ${messageBody}`)
  assert.ok(BROWSER_CAPABILITY_TOOLS.every(name => !routed.includes(name)),
    `computer browser request does not inject BaiLongma dedicated-Chrome tools: ${messageBody}`)
}

for (const messageBody of [
  '打开浏览器', '打开网页', '继续刚才页面', '当前页面', '浏览器是否开着', '关闭浏览器',
  '切换标签页', '点击填写登录', '打开 https://example.com/path', '浏览器操作', '网页截图',
  'open the browser', 'continue the previous page', 'current page', 'close browser',
  'switch tabs', 'click the login button', 'fill the form', 'sign in', 'open example.com', 'open this link',
  '访问 https://example.com', 'visit example.com', 'go to https://example.com', '查看网站 https://example.com',
  'browser automation', 'interact with the page', 'take a screenshot',
]) {
  const routed = selectTools({ messageBody, isTick: false })
  assert.ok(BROWSER_CAPABILITY_TOOLS.every(name => routed.includes(name)), `explicit browser route is executable: ${messageBody}`)
  assert.ok([...FORBIDDEN_BROWSER_TOOLS, ...STATELESS_WEB_TOOLS].every(name => !routed.includes(name)),
    `legacy/unsafe tools excluded: ${messageBody}`)
}

for (const messageBody of [
  'ClickHouse query', 'database table schema', 'tabular report',
  'Playwright browser context architecture', 'Browser API type definitions',
  'web worker lifecycle', 'URL parser implementation', 'React tab component',
  'Google OAuth implementation', '搜索算法实现', 'JavaScript webpage rendering architecture',
  'go to definition in the editor', 'visit pattern implementation',
]) {
  const routed = selectTools({ messageBody, isTick: false })
  assert.ok(BROWSER_TOOLS.every(name => !routed.includes(name)), `non-browser term does not trigger dedicated Chrome: ${messageBody}`)
  assert.ok(REMOVED_WEB_AND_BROWSER_TOOLS.every(name => !routed.includes(name)),
    `ordinary technical term does not trigger removed web/browser tools: ${messageBody}`)
}

for (const messageBody of [
  'summarize this article', 'extract article content', 'read page content',
  '总结这篇文章正文', '提取文章正文',
  'read this JavaScript-rendered article content', '用无头浏览器提取动态网页正文',
]) {
  const routed = selectTools({ messageBody, isTick: false })
  assert.ok(BROWSER_CAPABILITY_TOOLS.every(name => routed.includes(name)),
    `one-shot body read is executable in the first round: ${messageBody}`)
  assert.ok(REMOVED_WEB_AND_BROWSER_TOOLS.every(name => !routed.includes(name)),
    `one-shot body read excludes removed tools: ${messageBody}`)
}

const combined = selectTools({
  messageBody: 'search online then open website and click the first link',
  isTick: false,
})
assert.ok(BROWSER_CAPABILITY_TOOLS.every(name => combined.includes(name))
  && REMOVED_WEB_AND_BROWSER_TOOLS.every(name => !combined.includes(name)),
  'combined search + interaction is executable in the first round')

assert.ok(BROWSER_TOOLS.every(name => !selectTools({
  messageBody: 'click',
  isTick: false,
}).includes(name)), 'objectless exact click requires recent browser continuity evidence')

const continued = selectTools({
  messageBody: 'click',
  isTick: false,
  recentActionLog: [{ tool: 'browser_snapshot' }],
})
assert.ok(BROWSER_TOOLS.every(name => !continued.includes(name)) && continued.includes('find_tool'),
  'a terse follow-up remains model-routed even after a browser action')
assert.ok([...FORBIDDEN_BROWSER_TOOLS, ...STATELESS_WEB_TOOLS].every(name => !continued.includes(name)),
  'browser continuity cannot restore legacy, unsafe, or removed web tools')

for (const messageBody of [
  '刷新一下。', '往下翻一屏。', '往上翻一屏。', '返回。', '再往前。', '放大一点。',
]) {
  const routed = selectTools({
    messageBody,
    isTick: false,
    recentActionLog: [{ tool: 'browser_snapshot' }],
  })
  assert.ok(BROWSER_CAPABILITY_TOOLS.every(name => routed.includes(name)),
    `recent browser state resolves a terse browser command directly: ${messageBody}`)
}
for (const messageBody of ['刷新一下。', '返回。', '放大一点。']) {
  const routed = selectTools({ messageBody, isTick: false, recentActionLog: [] })
  assert.ok(BROWSER_TOOLS.every(name => !routed.includes(name)),
    `ambiguous terse wording does not activate browser tools without browser continuity: ${messageBody}`)
}

const unrelatedAfterBrowser = selectTools({
  messageBody: 'explain this project architecture',
  isTick: false,
  recentActionLog: [{ tool: 'browser_snapshot' }],
})
assert.ok(BROWSER_TOOLS.every(name => !unrelatedAfterBrowser.includes(name)),
  'a recent browser action does not leak one stranded action tool into an unrelated turn')

const oldAction = selectTools({
  messageBody: '继续',
  isTick: false,
  recentActionLog: [{ tool: 'browser_act' }, { tool: 'browser_open' }],
})
assert.ok(FORBIDDEN_BROWSER_TOOLS.every(name => !oldAction.includes(name)),
  'historical ActionLog entries cannot revive removed self-built tools')
assert.ok(STATELESS_WEB_TOOLS.every(name => !oldAction.includes(name)),
  'historical ActionLog entries cannot revive removed stateless web tools')

const browserContext = capabilityContextBlocks({
  text: '打开网页并点击登录',
  rawText: '打开网页并点击登录',
  isTick: false,
}).find(block => block.includes('BaiLongma Built-in Chromium')) || ''
assert.match(browserContext, /browser_navigate[\s\S]*actions return a fresh accessibility snapshot/)
assert.match(browserContext, /instead of routinely calling browser_snapshot/)
assert.match(browserContext, /browser_navigate_forward[\s\S]*browser_reload/)
assert.match(browserContext, /Never reopen the current URL with browser_navigate[\s\S]*"forward" or "reload"/)
assert.match(browserContext, /click completes navigation only when its result shows a changed final URL or a meaningful changed page state/)
assert.match(browserContext, /Match search results against the user's full meaning/)
assert.match(browserContext, /remote GitHub page[\s\S]*Do not switch to read_file, list_dir, find_tool for local files/)
assert.match(browserContext, /Final replies should report only the key result and real failures/)
assert.match(browserContext, /browser_find/)
assert.match(browserContext, /query, found, total_matches, and current_match/)
assert.match(browserContext, /Never navigate away, download the page, call run_command\/exec_command\/curl\/grep/)
assert.match(browserContext, /window mode is not operating-system fullscreen/i)
assert.match(browserContext, /browser_snapshot rather than a screenshot/)
assert.match(browserContext, /CAPTCHA\/challenge page is a hard stop[\s\S]*Do not navigate to another provider/)
assert.match(browserContext, /Chrome DevTools uid values[\s\S]*latest raw uid/)
assert.match(browserContext, /no automatic timeout[\s\S]*stays visible after the response and across later turns/)
assert.match(browserContext, /asks to open, show, browse, watch, or keep a page[\s\S]*do not call browser_close/)
assert.match(browserContext, /one-shot lookup or extraction[\s\S]*call browser_close[\s\S]*only when the page is no longer useful/)
assert.match(browserContext, /intent is ambiguous, prefer leaving the page visible/)
assert.match(browserContext, /browser_close closes\/resets the active dedicated-Chrome page/)
assert.match(browserContext, /Closing a page never deletes browser data[\s\S]*dedicated Chrome profile/)
assert.match(browserContext, /browser_clear_data is the only operation allowed[\s\S]*current user message explicitly asks/)
assert.match(browserContext, /browser_set_display_mode[\s\S]*mode="card"[\s\S]*mode="window"/)
assert.match(browserContext, /must not navigate or reload/)
for (const name of ['browser_run_code_unsafe', 'browser_evaluate', 'browser_file_upload', 'browser_drop']) {
  assert.match(browserContext, new RegExp(name), `${name} is explicitly unavailable in the workflow`)
}
for (const legacyTerm of ['browser_sessions', 'browser_open', 'session_id', 'page_id', 'ref epoch']) {
  const isPresent = legacyTerm === 'browser_open'
    ? /(^|[^A-Za-z0-9_])browser_open([^A-Za-z0-9_]|$)/.test(browserContext)
    : browserContext.includes(legacyTerm)
  assert.equal(isPresent, false, `legacy prompt term removed: ${legacyTerm}`)
}

for (const name of MUTATING_BROWSER_TOOLS) {
  assert.equal(evaluateToolPolicy(name, {}, { autonomous: true }).allowed, false,
    `autonomous Tick cannot call mutating MCP browser tool: ${name}`)
  assert.equal(evaluateToolPolicy(name, {}, {}).allowed, true,
    `user-driven context can call allowlisted MCP browser tool: ${name}`)
}
for (const name of READ_ONLY_BROWSER_TOOLS) {
  assert.equal(classifyTool(name), 'low', `${name} has a read-only fallback risk classification`)
}
assert.equal(classifyTool('browser_set_display_mode'), 'low')
assert.equal(evaluateToolPolicy('browser_set_display_mode', {}, { autonomous: true }).allowed, true,
  'presentation-only mode switching is reversible and available to autonomous Agent judgment')
assert.equal(classifyTool('system_browser_open'), 'medium')
assert.equal(evaluateToolPolicy('system_browser_open', {}, { autonomous: true }).allowed, false,
  'an autonomous Tick cannot open a user-owned desktop browser')
assert.equal(evaluateToolPolicy('system_browser_open', { url: 'https://www.baidu.com' }, {
  currentUserMessage: '在百度搜索一下 MCP',
}).allowed, false, 'ordinary web search cannot fall back to the user-owned desktop browser')
assert.equal(evaluateToolPolicy('system_browser_open', { url: 'https://www.baidu.com' }, {
  currentUserMessage: '用电脑默认浏览器打开百度',
}).allowed, true, 'an explicit current request may open the user-owned desktop browser')

for (const currentUserMessage of [
  '不要关闭浏览器',
  '保持浏览器打开',
  '别关当前网页',
  '切回你的小窗口浏览器，最后停留在小窗口，不要关闭浏览器',
]) {
  const policy = evaluateToolPolicy('browser_close', {}, { currentUserMessage })
  assert.equal(policy.allowed, false, `runtime rejects browser_close for: ${currentUserMessage}`)
  assert.match(policy.reason, /keep.*open|rejected closing/i)
}
for (const currentUserMessage of ['现在真正关掉你的浏览器', '关闭当前网页']) {
  assert.equal(evaluateToolPolicy('browser_close', {}, { currentUserMessage }).allowed, true,
    `runtime permits explicit browser close for: ${currentUserMessage}`)
}

const remoteGithubOnly = '只在 GitHub 远端页面查找 browser-data.cjs，不要切换成本地文件搜索'
for (const name of ['read_file', 'list_dir']) {
  const policy = evaluateToolPolicy(name, { path: '.' }, { currentUserMessage: remoteGithubOnly })
  assert.equal(policy.allowed, false, `${name} is blocked for a browser-only remote task`)
  assert.match(policy.reason, /local filesystem fallback/i)
}
assert.equal(evaluateToolPolicy('find_tool', { query: 'find local file browser-data.cjs' }, {
  currentUserMessage: remoteGithubOnly,
}).allowed, false, 'find_tool cannot discover a local-file fallback for a browser-only task')
assert.equal(evaluateToolPolicy('find_tool', { query: 'browser click link' }, {
  currentUserMessage: remoteGithubOnly,
}).allowed, true, 'browser capability discovery remains available')
assert.equal(evaluateToolPolicy('read_file', { path: 'browser-data.cjs' }, {
  currentUserMessage: '请在 GitHub 远端页面查找 browser-data.cjs',
}).allowed, false, 'a clearly remote-only GitHub task cannot silently downgrade to local files')
const combinedWebLocal = '请同时检查 GitHub 远端页面和本地项目里的 browser-data.cjs'
assert.equal(evaluateToolPolicy('read_file', { path: 'browser-data.cjs' }, {
  currentUserMessage: combinedWebLocal,
}).allowed, true, 'an explicit combined web-and-local task may use local files')
assert.equal(evaluateToolPolicy('find_tool', { query: 'find local file' }, {
  currentUserMessage: combinedWebLocal,
}).allowed, true, 'combined scope may discover local file tools')

for (const text of [
  '删除agent自带的浏览器数据',
  '清除你的浏览器 Cookie 和登录数据',
  '删除我的浏览器历史数据',
  '把白龙马浏览器最近一小时的历史记录删掉',
  'clear Bailongma browser data',
]) {
  assert.equal(isExplicitAgentBrowserDataDeletionRequest(text), true, `explicit Agent browser deletion recognized: ${text}`)
  assert.equal(selectTools({ messageBody: text, isTick: false }).includes('browser_clear_data'), true,
    `explicit Agent-browser deletion authority injects the guarded tool: ${text}`)
}
for (const text of [
  '关闭你的浏览器',
  '清除浏览器数据',
  '不要删除你的浏览器数据',
  '退出这个网站的登录',
  '清除我电脑浏览器的 Cookie',
]) {
  assert.equal(isExplicitAgentBrowserDataDeletionRequest(text), false, `ambiguous/out-of-scope deletion rejected: ${text}`)
  assert.equal(selectTools({ messageBody: text, isTick: false }).includes('browser_clear_data'), false,
    `clear tool stays absent without explicit Agent-browser deletion authority: ${text}`)
}
assert.equal(selectTools({
  messageBody: '今天天气怎么样',
  isTick: false,
  recentActionLog: [{ tool: 'browser_clear_data' }],
}).includes('browser_clear_data'), false,
'a prior authorized deletion never carries browser_clear_data authority into a later turn')
assert.equal(classifyTool('browser_clear_data'), 'high')
assert.equal(evaluateToolPolicy('browser_clear_data', {
  data_types: ['history'], time_range: 'last_hour',
}, { currentUserMessage: '删除agent自带浏览器最近一小时的历史数据' }).allowed, true)
assert.equal(evaluateToolPolicy('browser_clear_data', {
  data_types: ['history'], time_range: 'last_hour',
}, { currentUserMessage: '清理一下' }).allowed, false)
assert.equal(evaluateToolPolicy('browser_clear_data', {
  data_types: ['history'], time_range: 'last_hour',
}, { currentUserMessage: '删除agent自带浏览器最近一小时的历史数据', autonomous: true }).allowed, false)

const clearCalls = []
const shutdownCalls = []
const clearResult = JSON.parse(await execBrowserClearData(
  { data_types: ['history'], time_range: 'all_time' },
  {
    currentUserMessage: '删除agent自带浏览器所有历史数据',
    shutdownBuiltInChromeFn: async () => shutdownCalls.push('chrome'),
    browserDataBridge: {
      closePage: async () => clearCalls.push({ action: 'closePage' }),
      clearData: async request => {
        clearCalls.push(request)
        return { scope: 'bailongma_dedicated_chrome_only', profile_deleted: true }
      },
    },
  },
))
assert.equal(clearResult.ok, true)
assert.deepEqual(shutdownCalls, ['chrome'])
assert.deepEqual(clearCalls, [
  { action: 'closePage' },
  { dataTypes: ['history'], timeRange: 'all_time' },
])
assert.equal(JSON.parse(await execBrowserClearData(
  { data_types: ['history'], time_range: 'all_time' },
  { currentUserMessage: '关闭你的浏览器' },
)).code, 'EXPLICIT_USER_REQUEST_REQUIRED')
assert.equal(JSON.parse(await execBrowserClearData(
  { data_types: ['cookies'], time_range: 'last_hour' },
  { currentUserMessage: '清除你的浏览器最近一小时的 Cookie' },
)).code, 'PROFILE_TIME_RANGE_UNSUPPORTED')

const displayState = { mode: 'card' }
const switchResult = JSON.parse(execBrowserSetDisplayMode(
  { mode: 'window', reason: 'user takeover' },
  { browserDisplayState: displayState },
))
assert.equal(switchResult.ok, true)
assert.equal(switchResult.browser_preview.mode, 'window')
assert.equal(switchResult.browser_preview.transition, true)
assert.equal(displayState.mode, 'window', 'mode switching updates the shared per-turn browser state')

const displayRequired = JSON.parse(await executeBuiltInChromeTool(
  'browser_navigate',
  { url: 'https://example.com' },
  { browserDisplayState: { mode: null } },
))
assert.equal(displayRequired.ok, false)
assert.equal(displayRequired.code, 'BROWSER_DISPLAY_MODE_REQUIRED',
  'browser navigation cannot silently choose a card or window when the model has not selected one')
assert.match(displayRequired.error, /browser_set_display_mode[\s\S]*retry/i,
  'the missing-mode error tells the model how to recover in the same tool loop')

const systemLaunches = []
const systemBrowserResult = JSON.parse(await execSystemBrowserOpen(
  { url: 'https://example.com/path?query=1' },
  {
    platform: 'darwin',
    openSystemBrowser: async (command, args) => systemLaunches.push({ command, args }),
  },
))
assert.equal(systemBrowserResult.ok, true)
assert.equal(systemBrowserResult.surface, 'system')
assert.equal(systemBrowserResult.controllable, false)
assert.deepEqual(systemLaunches, [{ command: 'open', args: ['https://example.com/path?query=1'] }])
assert.equal(JSON.parse(await execSystemBrowserOpen({ url: 'file:///tmp/private' })).ok, false,
  'computer browser tool accepts HTTP(S) only')

const urlSecret = `AUDIT_URL_SECRET_${Date.now()}_${Math.random()}`
for (const name of ['browser_navigate', 'browser_tabs']) {
  const safeBrowserArgs = sanitizeToolAuditArgs(name, {
    action: name === 'browser_tabs' ? 'new' : undefined,
    url: `https://user:password@example.com/path?token=${urlSecret}#${urlSecret}`,
  })
  assert.equal(safeBrowserArgs.url, 'https://example.com/path')
  assert.equal(JSON.stringify(safeBrowserArgs).includes(urlSecret), false)
}

const secret = `FORM_SECRET_${Date.now()}_${Math.random()}`
const sanitizedType = sanitizeToolAuditArgs('browser_type', {
  element: 'Password', target: 'ref-1', text: secret, submit: true,
})
assert.equal(sanitizedType.text, '[redacted]')
assert.equal(summarizeToolExecution('browser_type', sanitizedType),
  'browser_type(target=ref-1)')

const sanitizedForm = sanitizeToolAuditArgs('browser_fill_form', {
  fields: [
    { name: 'Email', type: 'textbox', target: 'ref-2', value: secret },
    { name: 'Remember me', type: 'checkbox', target: 'ref-3', value: 'true' },
  ],
})
assert.deepEqual(sanitizedForm.fields.map(field => field.value), ['[redacted]', '[redacted]'])
assert.equal(summarizeToolExecution('browser_fill_form', sanitizedForm),
  'browser_fill_form(fields=2)')

for (const name of ['browser_type', 'browser_fill_form']) {
  const args = name === 'browser_type'
    ? { target: 'ref-secret', text: secret }
    : { fields: [{ name: 'Secret', type: 'textbox', target: 'ref-secret', value: secret }] }
  const log = buildToolAuditRecord({
    name,
    args,
    context: {},
    policy: { risk: 'high' },
    status: 'error',
    result: JSON.stringify({ ok: false, echoed: secret }),
    error: `failed to input ${secret}`,
    startedAt: Date.now(),
  })
  const persistedAudit = JSON.stringify(log)
  assert.equal(persistedAudit.includes(secret), false,
    `${name} sensitive text is absent from the entire persisted audit record`)
  assert.equal(log.argsJson.includes('[redacted]'), true)
  assert.equal(log.resultPreview, 'browser input failed')
  assert.equal(log.error, 'browser input failed')
}

console.log('test-browser-agent-integration passed')
