import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-chrome-mcp-'))
process.env.BAILONGMA_USER_DIR = userDir

const {
  BUILTIN_BROWSER_ALLOWED_TOOLS,
  BUILTIN_CHROME_DEVTOOLS_ID,
  adaptBrowserToolCall,
  createBuiltInChromeDevtoolsServer,
  isProtectedLoginUrl,
  resolveChromeDevtoolsCli,
  resolveStandaloneNodeModulePath,
} = await import('./chrome-devtools-server.js')
const {
  executeBuiltInChromeTool,
  shutdownBuiltInChrome,
  shutdownMcpClients,
} = await import('./client-manager.js')
const { actionContractCompletionIssue, browserScreenshotPathFromEvidence } = await import('../runtime/action-contract.js')
const { inferBrowserSurface } = await import('./browser-display.js')

let failed = 0
function check(condition, label, detail = '') {
  if (condition) return console.log(`PASS: ${label}`)
  failed += 1
  console.error(`FAIL: ${label}${detail ? `\n  ${detail}` : ''}`)
}

function parse(result) {
  try { return JSON.parse(result) } catch { return null }
}

let pageUrl = 'https://example.com/'
let browserBackTarget = ''
let hideManagedPage = false
const clients = []
const calls = []
const remoteTools = [
  'navigate_page', 'take_snapshot', 'list_pages', 'take_screenshot',
  'click', 'type_text', 'fill_form', 'fill', 'press_key', 'hover', 'drag',
  'wait_for', 'handle_dialog', 'new_page', 'select_page', 'close_page',
  'list_console_messages', 'resize_page', 'evaluate_script',
].map(name => ({ name, inputSchema: { type: 'object' } }))

class FakeTransport {
  constructor(options) {
    this.options = options
    this.stderr = new EventEmitter()
  }
}

class FakeClient {
  constructor() {
    this.onclose = null
    this.onerror = null
    clients.push(this)
  }

  setNotificationHandler() {}
  async connect() {}
  async close() { this.closed = true }
  async listTools() { return { tools: remoteTools } }
  async callTool(request) {
    calls.push(request)
    const name = request.name
    if (name === 'list_pages') return {
      content: [{ type: 'text', text: hideManagedPage
        ? '## Pages\n99: Bailongma UI (http://127.0.0.1:3721/) [selected]'
        : `## Pages\n0: test page (${pageUrl}) [selected]` }],
      structuredContent: { pages: hideManagedPage
        ? [{ id: 99, url: 'http://127.0.0.1:3721/', title: 'Bailongma UI', selected: true }]
        : [{ id: 0, url: pageUrl, title: 'test page', selected: true }] },
    }
    if (name === 'navigate_page') {
      if (request.arguments?.type === 'url' && request.arguments.url === 'https://example.invalid/') {
        pageUrl = 'chrome-error://chromewebdata/'
        return { content: [{ type: 'text', text: 'Unable to navigate in the selected page: net::ERR_NAME_NOT_RESOLVED at https://example.invalid/.' }] }
      }
      if (request.arguments?.type === 'back' && browserBackTarget) {
        pageUrl = browserBackTarget
        browserBackTarget = ''
      }
      if (request.arguments?.type === 'url') pageUrl = request.arguments.url
      return { content: [{ type: 'text', text: `- Page URL: ${pageUrl}\n- Page Title: test page` }] }
    }
    if (name === 'take_snapshot') return { content: [{ type: 'text', text: `- Page URL: ${pageUrl}\n- Page Title: ${pageUrl.includes('x.com/home') ? 'X Home' : 'test page'}` }] }
    if (name === 'evaluate_script') {
      if (String(request.arguments?.function || '').includes('__bailongmaSearchSubmit')) {
        const beforeUrl = pageUrl
        pageUrl = 'https://example.com/search?q=OpenAI'
        return { content: [{ type: 'text', text: `Script ran on page and returned:\n\`\`\`json\n${JSON.stringify({ submitted: true, method: 'requestSubmit', before_url: beforeUrl })}\n\`\`\`` }] }
      }
      if (String(request.arguments?.function || '').includes('total_matches')) {
        const queryLiteral = String(request.arguments.function).match(/const query = ("(?:[^"\\]|\\.)*")/)?.[1]
        const query = queryLiteral ? JSON.parse(queryLiteral) : ''
        const searchableText = '机器学习推动人工智能。机器学习模型需要数据；这里再次讨论机器学习。'
        const totalMatches = query ? searchableText.split(query).length - 1 : 0
        return { content: [{ type: 'text', text: `Script ran on page and returned:\n\`\`\`json\n${JSON.stringify({
          query,
          found: totalMatches > 0,
          total_matches: totalMatches,
          current_match: totalMatches > 0 ? 1 : 0,
          case_sensitive: false,
          source: 'rendered_page_text',
          url: pageUrl,
          title: 'test page',
        })}\n\`\`\`` }] }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ url: pageUrl, title: 'test page', scrollY: 640, viewportHeight: 600, documentHeight: 2400 }) }] }
    }
    if (name === 'take_screenshot') return { content: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl8a1cAAAAASUVORK5CYII=' }] }
    return { content: [{ type: 'text', text: `${name} completed` }] }
  }
}

const bridge = {
  closeCalls: 0,
  recoveryCalls: 0,
  async ensureEndpoint() {
    if (bridge.error) throw bridge.error
    return 'http://127.0.0.1:9222'
  },
  async getTarget() {
    return {
      webContentsId: 42,
      targetId: 'electron-live-target',
      debugUrl: pageUrl,
      url: pageUrl,
    }
  },
  async getState() {
    return { url: pageUrl, debugUrl: pageUrl, error: hideManagedPage ? { message: 'failed page target detached' } : null }
  },
  async recoverPage() {
    bridge.recoveryCalls += 1
    hideManagedPage = false
    pageUrl = 'about:blank#recovered-browser-page'
  },
  async closePage() { bridge.closeCalls += 1 },
}
const context = {
  browserDisplayMode: 'card',
  webUrlPolicyOptions: {
    hostnameResolver: async () => [{ address: '8.8.8.8' }],
  },
  mcpDeps: {
    chromeBridge: bridge,
    ClientClass: FakeClient,
    TransportClass: FakeTransport,
    builtInOptions: { cliPath: '/pinned/chrome-devtools-mcp.js', command: process.execPath },
  },
}

const turnController = new AbortController()
const originalAddAbortListener = turnController.signal.addEventListener.bind(turnController.signal)
const originalRemoveAbortListener = turnController.signal.removeEventListener.bind(turnController.signal)
let liveAbortListeners = 0
let peakAbortListeners = 0
turnController.signal.addEventListener = (type, listener, options) => {
  if (type === 'abort') {
    liveAbortListeners += 1
    peakAbortListeners = Math.max(peakAbortListeners, liveAbortListeners)
  }
  return originalAddAbortListener(type, listener, options)
}
turnController.signal.removeEventListener = (type, listener, options) => {
  if (type === 'abort') liveAbortListeners -= 1
  return originalRemoveAbortListener(type, listener, options)
}
context.signal = turnController.signal

try {
  const cli = resolveChromeDevtoolsCli()
  check(cli.includes('chrome-devtools-mcp') && fs.existsSync(cli),
    'the Chrome DevTools MCP executable comes from the installed pinned dependency', cli)
  const packedCli = path.join('/Applications/Bailongma.app/Contents/Resources/app.asar', 'node_modules', 'chrome-devtools-mcp', 'build', 'src', 'bin', 'chrome-devtools-mcp.js')
  const unpackedCli = packedCli.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
  check(resolveStandaloneNodeModulePath(packedCli, { existsSync: value => value === unpackedCli }) === unpackedCli,
    'standalone Node is redirected from Electron ASAR to the unpacked Chrome DevTools MCP entry')
  const server = createBuiltInChromeDevtoolsServer({ endpoint: 'http://127.0.0.1:9222', cliPath: '/pinned/chrome-devtools-mcp.js' })
  check(server.id === BUILTIN_CHROME_DEVTOOLS_ID
    && server.args.includes('--browser-url=http://127.0.0.1:9222')
    && server.args.includes('--no-usage-statistics')
    && server.args.includes('--no-performance-crux')
    && server.args.includes('--experimental-page-id-routing')
    && server.env.CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS === '1'
    && !server.args.join(' ').includes('npx')
    && !server.args.join(' ').includes('@latest'),
  'built-in MCP uses a pinned local CLI with telemetry, CrUX and update checks disabled')
  const bundledNodeServer = createBuiltInChromeDevtoolsServer({
    endpoint: 'http://127.0.0.1:9222',
    cliPath: '/pinned/chrome-devtools-mcp.js',
    command: '/app/resources/node-runtime/node',
  })
  check(bundledNodeServer.command === '/app/resources/node-runtime/node'
    && bundledNodeServer.env.ELECTRON_RUN_AS_NODE === undefined,
  'bundled Node runs Chrome DevTools MCP without Electron compatibility environment')
  assert.throws(() => createBuiltInChromeDevtoolsServer({ endpoint: 'http://0.0.0.0:9222' }), /127\.0\.0\.1/)
  assert.throws(() => createBuiltInChromeDevtoolsServer({ endpoint: 'http://192.168.1.5:9222' }), /127\.0\.0\.1/)
  console.log('PASS: MCP refuses LAN and wildcard DevTools endpoints')
  check(BUILTIN_BROWSER_ALLOWED_TOOLS.includes('browser_navigate')
    && adaptBrowserToolCall('browser_navigate', { url: 'https://example.com' })[0].remoteName === 'navigate_page'
    && adaptBrowserToolCall('browser_snapshot')[0].remoteName === 'take_snapshot',
  'public browser_* names map to Chrome DevTools MCP without changing the agent contract')
  const replaceTypeSteps = adaptBrowserToolCall('browser_type', {
    uid: 'search-field', text: 'OpenAI', replace: true,
  })
  check(replaceTypeSteps.length === 1
    && replaceTypeSteps[0].remoteName === 'fill_form'
    && replaceTypeSteps[0].arguments?.elements?.[0]?.uid === 'search-field'
    && replaceTypeSteps[0].arguments?.elements?.[0]?.value === 'OpenAI',
  'browser_type replace mode fills the exact value without an extra focus/clear click')
  const fallbackSubmitSteps = adaptBrowserToolCall('browser_click', {
    search_submit: true, element: 'search submit',
  })
  check(fallbackSubmitSteps.length === 2
    && fallbackSubmitSteps[0].remoteName === 'evaluate_script'
    && fallbackSubmitSteps[0].browserSearchSubmit === true
    && fallbackSubmitSteps[1].remoteName === 'take_snapshot',
  'a missing accessibility submit button still uses one browser_click form-submit step')
  assert.throws(() => adaptBrowserToolCall('browser_tabs', { action: 'new', url: 'https://example.com' }), /one live page/i)
  console.log('PASS: the public tab contract no longer promises unsupported simultaneous tabs')
  const findSteps = adaptBrowserToolCall('browser_find', { text: '机器学习' })
  check(findSteps.length === 2
    && findSteps[0].remoteName === 'evaluate_script'
    && findSteps[0].browserFindCount === true
    && findSteps[1].remoteName === 'take_snapshot',
  'browser_find counts rendered current-page text and refreshes the snapshot without navigation')
  check(isProtectedLoginUrl('https://accounts.google.com/signin/v2/identifier')
    && isProtectedLoginUrl('https://x.com/i/flow/login')
    && !isProtectedLoginUrl('https://x.com/home'),
  'Google OAuth and X login URLs are recognized as user-only pages')

  pageUrl = 'https://www.bing.com/'
  calls.length = 0
  const replacedSearch = parse(await executeBuiltInChromeTool('browser_type', {
    uid: 'search-field', text: 'OpenAI', replace: true,
  }, context))
  check(replacedSearch?.ok === true
    && calls.filter(call => call.name === 'fill_form').length === 1
    && calls.every(call => !['click', 'type_text'].includes(call.name)),
  'live search replacement is one fill operation even when the field was prefilled', JSON.stringify(calls))
  calls.length = 0
  const fallbackSearchSubmit = parse(await executeBuiltInChromeTool('browser_click', {
    search_submit: true, element: 'search submit',
  }, context))
  check(fallbackSearchSubmit?.ok === true
    && fallbackSearchSubmit?.structured_content?.page_change?.url_changed === true
    && fallbackSearchSubmit?.browser_preview?.url === 'https://example.com/search?q=OpenAI'
    && calls.some(call => call.name === 'evaluate_script')
    && calls.some(call => call.name === 'take_snapshot')
    && calls.every(call => call.name !== 'click'),
  'form-submit fallback navigates and is verified by fresh URL/snapshot evidence', JSON.stringify(fallbackSearchSubmit))

  pageUrl = 'https://accounts.google.com/signin/v2/identifier'
  calls.length = 0
  const blockedLogin = parse(await executeBuiltInChromeTool('browser_type', { uid: 'email', text: 'person@example.com' }, context))
  check(blockedLogin?.ok === false
    && blockedLogin?.structured_content?.code === 'USER_LOGIN_REQUIRED'
    && calls.every(call => call.name !== 'type_text' && call.name !== 'click'),
  'Google OAuth page never receives agent-driven credentials or clicks', JSON.stringify(blockedLogin))

  calls.length = 0
  const openedLogin = parse(await executeBuiltInChromeTool('browser_navigate', { url: 'https://accounts.google.com/signin/v2/identifier' }, context))
  check(openedLogin?.ok === true
    && openedLogin?.structured_content?.user_action_required === true
    && openedLogin?.structured_content?.login_verification_required === true
    && openedLogin?.browser_preview?.renderer === 'webcontentsview'
    && openedLogin?.browser_preview?.native_view === true
    && calls.some(call => call.name === 'navigate_page')
    && calls.some(call => call.name === 'take_snapshot')
    && calls.every(call => call.name !== 'take_screenshot'),
  'browser actions update the live native page without taking preview screenshots', JSON.stringify(openedLogin))

  pageUrl = 'https://x.com/home'
  const observedAfterUser = parse(await executeBuiltInChromeTool('browser_snapshot', {}, context))
  check(observedAfterUser?.ok === true
    && observedAfterUser?.content?.some(item => /x\.com\/home/i.test(item.text || '')),
  'post-login state is only represented by a fresh real-page snapshot', JSON.stringify(observedAfterUser))
  check(Boolean(actionContractCompletionIssue(
    { id: 'browser_interaction' },
    '我已经登录成功。',
    { successfulToolNames: new Set(['browser_snapshot']) },
  )), 'an observed snapshot alone cannot authorize an unverified login-success claim')

  for (let index = 0; index < 30; index += 1) {
    const stableSnapshot = parse(await executeBuiltInChromeTool('browser_snapshot', {}, context))
    assert.equal(stableSnapshot?.ok, true)
  }
  check(liveAbortListeners === 0 && peakAbortListeners <= 1,
    '30 sequential MCP calls detach every listener from the turn-long AbortSignal',
    JSON.stringify({ liveAbortListeners, peakAbortListeners }))

  const screenshot = parse(await executeBuiltInChromeTool('browser_take_screenshot', { type: 'png' }, context))
  check(screenshot?.ok === true
    && typeof screenshot?.screenshot?.image_path === 'string'
    && fs.existsSync(screenshot.screenshot.image_path)
    && screenshot.screenshot.delivered === false,
  'browser screenshots are persisted as real deliverable image files', JSON.stringify(screenshot))
  check(browserScreenshotPathFromEvidence([{
    name: 'browser_take_screenshot',
    result: JSON.stringify(screenshot),
  }]) === screenshot.screenshot.image_path,
  'the screenshot delivery gate reads the persisted image path from tool evidence')

  calls.length = 0
  const pageFind = parse(await executeBuiltInChromeTool('browser_find', { text: '机器学习' }, context))
  check(pageFind?.ok === true
    && pageFind?.structured_content?.page_find?.query === '机器学习'
    && pageFind?.structured_content?.page_find?.found === true
    && pageFind?.structured_content?.page_find?.total_matches === 3
    && pageFind?.structured_content?.page_find?.current_match === 1,
  'browser_find returns a reliable structured occurrence count', JSON.stringify(pageFind))
  check(calls.some(call => call.name === 'evaluate_script')
    && calls.some(call => call.name === 'take_snapshot')
    && calls.every(call => !['navigate_page', 'new_page'].includes(call.name)),
  'browser_find stays on the current page and never navigates to count text', JSON.stringify(calls))

  pageUrl = 'https://example.com/detail'
  browserBackTarget = 'https://example.com/search?q=electron'
  const backedToResults = parse(await executeBuiltInChromeTool('browser_navigate_back', {}, context))
  check(backedToResults?.ok === true
    && backedToResults?.structured_content?.page_change?.url_changed === true
    && backedToResults?.browser_preview?.url === 'https://example.com/search?q=electron',
  'browser back succeeds only when the live page really changes', JSON.stringify(backedToResults))
  const unavailableBack = parse(await executeBuiltInChromeTool('browser_navigate_back', {}, context))
  check(unavailableBack?.ok === false
    && unavailableBack?.structured_content?.code === 'BROWSER_HISTORY_UNAVAILABLE'
    && unavailableBack?.structured_content?.page_change?.url_changed === false,
  'browser back reports unavailable history instead of claiming a same-page success', JSON.stringify(unavailableBack))

  pageUrl = 'https://example.com/'
  const failedNavigation = parse(await executeBuiltInChromeTool('browser_navigate', { url: 'https://example.invalid/' }, {
    ...context,
    mcpDeps: context.mcpDeps,
  }))
  check(failedNavigation?.ok === false
    && failedNavigation?.structured_content?.code === 'BROWSER_NAVIGATION_FAILED'
    && /ERR_NAME_NOT_RESOLVED/.test(failedNavigation?.error || ''),
  'a Chrome error document is returned as ok=false instead of false success', JSON.stringify(failedNavigation))
  hideManagedPage = true
  const recoveredAfterError = parse(await executeBuiltInChromeTool('browser_navigate', { url: 'https://example.com/' }, context))
  check(recoveredAfterError?.ok === true
    && recoveredAfterError?.browser_preview?.url === 'https://example.com/'
    && bridge.recoveryCalls === 1,
    'the same managed page remains controllable after an error document', JSON.stringify(recoveredAfterError))

  const closedPage = parse(await executeBuiltInChromeTool('browser_close', {}, context))
  check(closedPage?.browser_preview?.page_closed === true && closedPage?.browser_preview?.state === 'closed'
    && bridge.closeCalls === 1
    && calls.every(call => call.name !== 'new_page' && call.name !== 'close_page'),
  'browser_close destroys the managed live page without touching Bailongma UI targets', JSON.stringify(closedPage))

  const firstClient = clients.at(-1)
  firstClient.onclose?.()
  const beforeReconnect = clients.length
  await executeBuiltInChromeTool('browser_snapshot', {}, context)
  check(clients.length === beforeReconnect + 1,
    'an MCP connection close is recovered by reconnecting to the same loopback Chrome endpoint')
  bridge.error = new Error('BaiLongma Chrome window was closed')
  const closedWindow = parse(await executeBuiltInChromeTool('browser_snapshot', {}, context))
  check(closedWindow?.ok === false && closedWindow?.code === 'MCP_DISCONNECTED'
    && /Recovery:/i.test(closedWindow?.error || ''),
  'a user-closed Chrome window returns a recoverable MCP_DISCONNECTED error', JSON.stringify(closedWindow))
  delete bridge.error

  const mainSource = fs.readFileSync(path.resolve('electron/main.cjs'), 'utf8')
  const preloadSource = fs.readFileSync(path.resolve('electron/preload.cjs'), 'utf8')
  check(/WebContentsView|browser-embed-host/.test(mainSource)
    && /browserEmbed/.test(preloadSource),
  'compact mode exposes the real managed WebContentsView instead of a screenshot')
  check(inferBrowserSurface('用我电脑上的浏览器打开 https://example.com') === 'system'
    && inferBrowserSurface('请打开白龙马专用 Chrome') === 'chrome',
  'system/default browser remains a separate uncontrollable surface')
} catch (error) {
  failed += 1
  console.error(error.stack || error)
} finally {
  await shutdownBuiltInChrome()
  await shutdownMcpClients()
  fs.rmSync(userDir, { recursive: true, force: true })
}

if (failed === 0) console.log('All Chrome DevTools MCP migration tests passed.')
else process.exitCode = 1
