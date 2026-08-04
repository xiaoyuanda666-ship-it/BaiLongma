import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'

export const BUILTIN_CHROME_DEVTOOLS_ID = 'builtin_chrome_devtools'

// Public Bailongma names deliberately stay stable. The implementation below
// maps them to Chrome DevTools MCP 1.6.0 instead of exposing the upstream
// names directly to agents and existing skills.
export const BUILTIN_BROWSER_ALLOWED_TOOLS = Object.freeze([
  'browser_close',
  'browser_resize',
  'browser_console_messages',
  'browser_handle_dialog',
  'browser_find',
  'browser_fill_form',
  'browser_press_key',
  'browser_type',
  'browser_navigate',
  'browser_navigate_back',
  'browser_navigate_forward',
  'browser_reload',
  'browser_take_screenshot',
  'browser_snapshot',
  'browser_click',
  'browser_drag',
  'browser_hover',
  'browser_select_option',
  'browser_tabs',
  'browser_wait_for',
])

const require = createRequire(import.meta.url)
const ALLOWED = new Set(BUILTIN_BROWSER_ALLOWED_TOOLS)
const MUTATING = new Set([
  'browser_close', 'browser_resize', 'browser_handle_dialog', 'browser_fill_form',
  'browser_press_key', 'browser_type', 'browser_navigate', 'browser_navigate_back',
  'browser_navigate_forward', 'browser_reload', 'browser_click', 'browser_drag',
  'browser_hover', 'browser_select_option', 'browser_tabs',
])

const objectSchema = (properties = {}, required = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
})
const string = description => ({ type: 'string', description })
const number = description => ({ type: 'number', description })
const boolean = description => ({ type: 'boolean', description })
const uid = 'The uid from the latest browser_snapshot accessibility snapshot.'

const DESCRIPTORS = Object.freeze({
  browser_navigate: {
    description: 'Navigate the active page in BaiLongma built-in Chromium. Returns a fresh accessibility snapshot.',
    schema: objectSchema({ url: string('An HTTP(S) URL to open in BaiLongma dedicated Chrome.') }, ['url']),
  },
  browser_navigate_back: { description: 'Go back in the active BaiLongma Chrome tab and return a fresh snapshot.', schema: objectSchema() },
  browser_navigate_forward: { description: 'Go forward in the active BaiLongma Chrome tab and return a fresh snapshot.', schema: objectSchema() },
  browser_reload: { description: 'Reload the active BaiLongma Chrome tab and return a fresh snapshot.', schema: objectSchema({ ignore_cache: boolean('Ignore cached resources when reloading.') }) },
  browser_snapshot: { description: 'Read the active BaiLongma Chrome page as an accessibility snapshot. Prefer this over screenshots.', schema: objectSchema({ verbose: boolean('Include additional accessibility-tree details.') }) },
  browser_find: { description: 'Refresh the page accessibility snapshot so the requested text can be found. This is read-only.', schema: objectSchema({ text: string('Text to find in the page snapshot.') }, ['text']) },
  browser_click: { description: 'Click an element in BaiLongma dedicated Chrome. Never use this for accounts.google.com, X login, CAPTCHA, MFA, or OAuth consent; the user operates those personally.', schema: objectSchema({ uid: string(uid), target: string(uid), ref: string(uid), element: string('Human-readable element description.') }) },
  browser_type: { description: 'Focus an element and type ordinary non-authentication text. Account credentials, MFA, CAPTCHA and OAuth flows are user-only.', schema: objectSchema({ uid: string(uid), target: string(uid), ref: string(uid), element: string('Human-readable element description.'), text: string('Text to type.') }, ['text']) },
  browser_fill_form: { description: 'Fill ordinary non-authentication form fields. Credentials, MFA, CAPTCHA and OAuth fields must be completed by the user.', schema: objectSchema({ fields: { type: 'array', items: objectSchema({ uid: string(uid), target: string(uid), ref: string(uid), value: string('Value to enter.') }, ['value']) }, elements: { type: 'array', items: objectSchema({ uid: string(uid), value: string('Value to enter.') }, ['uid', 'value']) } }) },
  browser_select_option: { description: 'Select an option using its snapshot uid and visible value.', schema: objectSchema({ uid: string(uid), target: string(uid), ref: string(uid), value: string('Visible option value.') }, ['value']) },
  browser_press_key: { description: 'Press a key in BaiLongma Chrome. Do not use it to submit login, MFA, CAPTCHA, or OAuth consent.', schema: objectSchema({ key: string('Key or combination such as Enter or Control+L.') }, ['key']) },
  browser_hover: { description: 'Hover an element by its snapshot uid.', schema: objectSchema({ uid: string(uid), target: string(uid), ref: string(uid) }) },
  browser_drag: { description: 'Drag one snapshot element onto another.', schema: objectSchema({ from_uid: string(uid), to_uid: string(uid), source: string(uid), target: string(uid) }) },
  browser_wait_for: { description: 'Wait for text to appear on the active page and return a snapshot.', schema: objectSchema({ text: string('Text to wait for.'), timeout: number('Optional timeout in milliseconds.') }, ['text']) },
  browser_handle_dialog: { description: 'Handle a non-authentication browser dialog.', schema: objectSchema({ action: { type: 'string', enum: ['accept', 'dismiss'] }, prompt_text: string('Optional prompt text.') }, ['action']) },
  browser_tabs: { description: 'List, select, open, or close tabs in BaiLongma dedicated Chrome.', schema: objectSchema({ action: { type: 'string', enum: ['list', 'select', 'new', 'close'] }, page_id: number('Chrome DevTools MCP page id.'), index: number('Chrome DevTools MCP page id.'), url: string('HTTP(S) URL for a new tab.') }) },
  browser_take_screenshot: { description: 'Take a screenshot of the active BaiLongma Chrome page.', schema: objectSchema({ full_page: boolean('Capture the entire page.'), type: { type: 'string', enum: ['png', 'jpeg', 'webp'] } }) },
  browser_console_messages: { description: 'List console messages from the active BaiLongma Chrome page.', schema: objectSchema({ page_size: number('Maximum number of messages.') }) },
  browser_resize: { description: 'Resize the active BaiLongma Chrome window viewport.', schema: objectSchema({ width: number('Viewport width.'), height: number('Viewport height.') }, ['width', 'height']) },
  browser_close: { description: 'Close a BaiLongma Chrome tab without deleting its dedicated profile data. Without page_id, close the selected tab; if it is the last tab, create a blank replacement first because Chrome DevTools MCP never closes the final tab.', schema: objectSchema({ page_id: number('Chrome DevTools MCP page id. If omitted, the selected tab is closed safely.') }) },
})

function firstUid(args = {}) {
  return String(args.uid || args.target || args.ref || '').trim()
}

function requireUid(args, name) {
  const value = firstUid(args)
  if (!value) throw new TypeError(`${name} requires a uid from the latest browser_snapshot`)
  return value
}

function snapshotStep(verbose = false) {
  return { remoteName: 'take_snapshot', arguments: verbose ? { verbose: true } : {} }
}

export function isBuiltInBrowserToolAllowed(name) {
  return ALLOWED.has(String(name || ''))
}

export function getBuiltInBrowserToolDescriptor(name) {
  const normalized = String(name || '')
  const descriptor = DESCRIPTORS[normalized]
  if (!descriptor) return null
  return {
    name: normalized,
    title: normalized,
    description: descriptor.description,
    inputSchema: structuredClone(descriptor.schema),
    annotations: {
      readOnlyHint: !MUTATING.has(normalized),
      destructiveHint: MUTATING.has(normalized),
    },
  }
}

export function resolveStandaloneNodeModulePath(filePath, { existsSync = fs.existsSync } = {}) {
  const resolved = path.resolve(String(filePath || ''))
  const asarMarker = `.asar${path.sep}`
  if (!resolved.includes(asarMarker)) return resolved
  const unpacked = resolved.replace(asarMarker, `.asar.unpacked${path.sep}`)
  return existsSync(unpacked) ? unpacked : resolved
}

export function resolveChromeDevtoolsCli({ cliPath = process.env.BAILONGMA_CHROME_DEVTOOLS_MCP_CLI } = {}) {
  if (String(cliPath || '').trim()) return resolveStandaloneNodeModulePath(String(cliPath).trim())
  try {
    const packagePath = require.resolve('chrome-devtools-mcp/package.json')
    const entry = path.join(path.dirname(packagePath), 'build', 'src', 'bin', 'chrome-devtools-mcp.js')
    if (fs.existsSync(entry)) return resolveStandaloneNodeModulePath(entry)
  } catch {}
  throw new Error('Pinned chrome-devtools-mcp dependency is unavailable. Reinstall BaiLongma dependencies.')
}

export function createBuiltInChromeDevtoolsServer({
  endpoint,
  cliPath,
  command = process.env.BAILONGMA_MCP_NODE_PATH || process.execPath,
  electronRuntime = command === process.execPath && Boolean(process.versions.electron),
} = {}) {
  const browserUrl = String(endpoint || '').trim()
  const parsed = new URL(browserUrl)
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port) {
    throw new Error('BaiLongma Chrome DevTools endpoint must be http://127.0.0.1:<port>')
  }
  return {
    id: BUILTIN_CHROME_DEVTOOLS_ID,
    name: 'BaiLongma Dedicated Chrome',
    enabled: true,
    transport: 'stdio',
    command,
    args: [
      resolveChromeDevtoolsCli({ cliPath }),
      `--browser-url=${browserUrl}`,
      '--no-usage-statistics',
      '--no-performance-crux',
      '--no-category-performance',
      '--no-category-network',
      '--experimental-page-id-routing',
      '--experimental-structured-content',
    ],
    env: {
      CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
      CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
      ...(electronRuntime ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
    allowedTools: [...BUILTIN_BROWSER_ALLOWED_TOOLS],
    allowAutonomousReadOnly: false,
    timeoutMs: 90_000,
    builtIn: true,
    chromeDevtools: true,
    exposeRemoteNames: true,
    catalogVisible: true,
    enforceAllowedTools: true,
    lazy: true,
    persistent: true,
    headed: true,
    loopbackOnly: true,
    profile: 'bailongma_dedicated_chrome',
  }
}

// Convert the established Bailongma browser_* input contract into the pinned
// Chrome DevTools MCP 1.6.0 contract. The final snapshot step preserves the
// historical "action returns fresh page state" behavior.
export function adaptBrowserToolCall(name, args = {}) {
  const normalized = String(name || '')
  if (!isBuiltInBrowserToolAllowed(normalized)) throw new Error(`Browser tool "${normalized}" is not allowed`)
  switch (normalized) {
    case 'browser_navigate': return [{ remoteName: 'navigate_page', arguments: { type: 'url', url: String(args.url || '') } }, snapshotStep()]
    case 'browser_navigate_back': return [{ remoteName: 'navigate_page', arguments: { type: 'back' } }, snapshotStep()]
    case 'browser_navigate_forward': return [{ remoteName: 'navigate_page', arguments: { type: 'forward' } }, snapshotStep()]
    case 'browser_reload': return [{ remoteName: 'navigate_page', arguments: { type: 'reload', ...(args.ignore_cache === true ? { ignoreCache: true } : {}) } }, snapshotStep()]
    case 'browser_snapshot': return [snapshotStep(args.verbose === true)]
    case 'browser_find': return [snapshotStep(true)]
    // Do not trust the click tool's inline snapshot as the final page state.
    // A link may commit navigation just after the DOM click completes, so take
    // a separate snapshot after the click/navigation lifecycle settles.
    case 'browser_click': return [
      { remoteName: 'click', arguments: { uid: requireUid(args, normalized) } },
      snapshotStep(),
    ]
    case 'browser_type': {
      const text = String(args.text ?? args.value ?? '')
      if (!text) throw new TypeError('browser_type requires text')
      const steps = []
      if (firstUid(args)) steps.push({ remoteName: 'click', arguments: { uid: requireUid(args, normalized) } })
      steps.push({ remoteName: 'type_text', arguments: { text } }, snapshotStep())
      return steps
    }
    case 'browser_fill_form': {
      const source = Array.isArray(args.elements) ? args.elements : (Array.isArray(args.fields) ? args.fields : [])
      const elements = source.map(field => ({ uid: requireUid(field, normalized), value: String(field.value ?? field.text ?? '') }))
      if (!elements.length) throw new TypeError('browser_fill_form requires fields or elements')
      return [{ remoteName: 'fill_form', arguments: { elements, includeSnapshot: true } }]
    }
    case 'browser_select_option': return [{ remoteName: 'fill', arguments: { uid: requireUid(args, normalized), value: String(args.value ?? ''), includeSnapshot: true } }]
    case 'browser_press_key': return [
      { remoteName: 'press_key', arguments: { key: String(args.key || '') } },
      snapshotStep(),
    ]
    case 'browser_hover': return [{ remoteName: 'hover', arguments: { uid: requireUid(args, normalized), includeSnapshot: true } }]
    case 'browser_drag': return [{ remoteName: 'drag', arguments: { from_uid: String(args.from_uid || args.source || ''), to_uid: String(args.to_uid || args.target || ''), includeSnapshot: true } }]
    case 'browser_wait_for': return [{ remoteName: 'wait_for', arguments: { text: [String(args.text || '')].filter(Boolean), ...(Number.isFinite(args.timeout) ? { timeout: args.timeout } : {}) } }]
    case 'browser_handle_dialog': return [{ remoteName: 'handle_dialog', arguments: { action: String(args.action || ''), ...(args.prompt_text ? { promptText: String(args.prompt_text) } : {}) } }, snapshotStep()]
    case 'browser_tabs': {
      const action = String(args.action || 'list').toLowerCase()
      if (action === 'new') return [{ remoteName: 'new_page', arguments: { url: String(args.url || 'about:blank') } }, snapshotStep()]
      if (action === 'select') return [{ remoteName: 'select_page', arguments: { pageId: Number(args.page_id ?? args.index), bringToFront: true } }, snapshotStep()]
      if (action === 'close') return [{ remoteName: 'close_page', arguments: { pageId: Number(args.page_id ?? args.index) } }, { remoteName: 'list_pages', arguments: {} }]
      return [{ remoteName: 'list_pages', arguments: {} }]
    }
    case 'browser_take_screenshot': return [{ remoteName: 'take_screenshot', arguments: { format: String(args.type || 'png'), ...(args.full_page === true ? { fullPage: true } : {}) } }]
    case 'browser_console_messages': return [{ remoteName: 'list_console_messages', arguments: { ...(Number.isFinite(args.page_size) ? { pageSize: args.page_size } : {}) } }]
    case 'browser_resize': return [{ remoteName: 'resize_page', arguments: { width: Number(args.width), height: Number(args.height) } }, snapshotStep()]
    case 'browser_close': {
      const pageId = Number(args.page_id)
      return Number.isInteger(pageId) && pageId >= 0
        ? [{ remoteName: 'close_page', arguments: { pageId } }, { remoteName: 'list_pages', arguments: {} }]
        : [{ remoteName: 'navigate_page', arguments: { type: 'url', url: 'about:blank' } }, snapshotStep()]
    }
    default: throw new Error(`Browser tool "${normalized}" is not supported`)
  }
}

export function isProtectedLoginUrl(value) {
  try {
    const url = new URL(String(value || ''))
    const host = url.hostname.toLowerCase()
    return host === 'accounts.google.com'
      || host.endsWith('.accounts.google.com')
      || ((host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com'))
        && /\/(?:i\/flow\/login|login|account\/access)/i.test(url.pathname))
  } catch {
    return false
  }
}

export const __internal = { DESCRIPTORS, firstUid, requireUid }
