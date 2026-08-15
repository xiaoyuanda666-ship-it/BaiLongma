// Regression contract after removing the legacy in-process web tools.
//
// The old names must remain unavailable to the model/executor while the
// built-in Chrome DevTools MCP keeps the stable browser_* tools usable.
//
// Run: node src/test-web-read.js

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tempUserDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-web-removal-'))
process.env.BAILONGMA_USER_DIR = tempUserDir
process.env.BAILONGMA_RESOURCES_DIR = process.cwd()

const LEGACY_WEB_TOOLS = ['web_search', 'web_read', 'fetch_url', 'browser_read']
const FORBIDDEN_CHROME_TOOLS = [
  'browser_run_code_unsafe',
  'browser_evaluate',
  'browser_file_upload',
  'browser_drop',
  'browser_network_requests',
  'browser_network_request',
]

const { BUILTIN_TOOL_NAMES, TOOL_SCHEMAS } = await import('./capabilities/builtin-tools.js')
const { BROWSER_CAPABILITY_TOOLS } = await import('./capabilities/capability-registry.js')
const { getToolSchemas } = await import('./capabilities/schemas.js')
const { executeTool } = await import('./capabilities/executor.js')
const { evaluateToolPolicy } = await import('./capabilities/tool-policy.js')
const {
  listMcpTools,
  reconcileMcpClients,
  shutdownMcpClients,
} = await import('./mcp/client-manager.js')

const advertisedTools = [
  {
    name: 'navigate_page',
    description: 'Navigate to a URL',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'take_snapshot',
    description: 'Capture accessibility snapshot',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  ...FORBIDDEN_CHROME_TOOLS.map(name => ({
    name,
    description: `Forbidden ${name}`,
    inputSchema: { type: 'object', properties: {} },
    annotations: {},
  })),
]

class FakeTransport {
  constructor(params) {
    this.params = params
    this.stderr = { on() {} }
  }
}

class FakeClient {
  setNotificationHandler() {}

  async connect(transport) {
    this.transport = transport
  }

  async listTools() {
    return { tools: advertisedTools }
  }

  async callTool(request) {
    return {
      content: [{
        type: 'text',
        text: request.name === 'take_snapshot'
          ? '### Page\n- Page URL: https://example.com/\n### Snapshot\n- heading "Example Domain" [ref=e1]'
          : `called:${request.name}`,
      }],
    }
  }

  async close() {
    this.onclose?.()
  }
}

const mcpDeps = {
  ClientClass: FakeClient,
  TransportClass: FakeTransport,
  chromeBridge: { ensureEndpoint: async () => 'http://127.0.0.1:9222' },
  builtInOptions: {
    cliPath: path.join(tempUserDir, 'chrome-devtools-mcp.js'),
    command: '/fake/node',
    electronRuntime: false,
  },
}

try {
  for (const name of LEGACY_WEB_TOOLS) {
    assert.equal(TOOL_SCHEMAS[name], undefined, `${name} has no built-in schema`)
    assert.equal(BUILTIN_TOOL_NAMES.has(name), true, `${name} remains reserved against marketplace replacement`)
  }

  assert.deepEqual(
    getToolSchemas([...LEGACY_WEB_TOOLS]).map(schema => schema.function.name),
    [],
    'legacy web tools cannot be loaded into a model turn',
  )

  for (const name of LEGACY_WEB_TOOLS) {
    assert.equal(
      await executeTool(name, {}, { source: 'test' }),
      `错误：未知工具 "${name}"`,
      `${name} has no legacy executor path`,
    )
  }

  await reconcileMcpClients([], mcpDeps)
  const tools = listMcpTools()
  assert.ok(tools.some(tool => tool.name === 'browser_navigate' && tool.builtIn === true),
    'built-in dedicated-Chrome navigation remains model-visible under its native name')
  assert.ok(tools.some(tool => tool.name === 'browser_snapshot' && tool.builtIn === true),
    'built-in dedicated-Chrome snapshot remains model-visible under its native name')
  assert.ok(FORBIDDEN_CHROME_TOOLS.every(name => !tools.some(tool => tool.name === name)),
    'forbidden upstream Chrome tools stay outside the exposed catalog')
  const browserDiscovery = JSON.parse(await executeTool(
    'find_tool',
    { query: '浏览器打开网页' },
    { source: 'test', currentUserMessage: '打开网页' },
  ))
  assert.equal(browserDiscovery.ok, true, JSON.stringify(browserDiscovery))
  assert.equal(browserDiscovery.loaded[0], 'browser_set_display_mode',
    'generic browser discovery loads display-mode selection before navigation')
  assert.ok(browserDiscovery.loaded.includes('browser_navigate'),
    'generic browser discovery still loads navigation after display-mode selection')
  assert.ok(BROWSER_CAPABILITY_TOOLS.every(name => browserDiscovery.loaded.includes(name)),
    'browser discovery loads every available browser capability tool without truncation')
  assert.ok(browserDiscovery.loaded.length > 8,
    'find_tool no longer applies the former eight-schema loading limit')
  const exactCloseDiscovery = JSON.parse(await executeTool(
    'find_tool',
    { query: 'browser_close 关闭浏览器' },
    { source: 'test', currentUserMessage: '关闭浏览器' },
  ))
  assert.equal(exactCloseDiscovery.loaded[0], 'browser_close',
    'an exact tool-name query ranks browser_close first')
  assert.ok(exactCloseDiscovery.loaded.length > 10,
    'exact browser discovery keeps every broader browser match instead of truncating at ten')
  assert.equal(
    evaluateToolPolicy('browser_navigate', { url: 'https://example.com' }, { autonomous: true }).allowed,
    false,
    'ordinary autonomous Tick cannot navigate the interactive browser',
  )
  assert.equal(
    evaluateToolPolicy('browser_navigate', { url: 'https://example.com' }, {
      autonomous: true,
      startupSelfCheck: { active: true },
    }).allowed,
    true,
    'startup self-check has a narrow built-in dedicated-Chrome navigation exception',
  )

  assert.deepEqual(
    getToolSchemas([...LEGACY_WEB_TOOLS, 'browser_snapshot']).map(schema => schema.function.name),
    ['browser_snapshot'],
    'schema loading replaces removed web tools with the native dedicated-Chrome tool',
  )

  const browserToolContext = {
    source: 'test',
    mcpDeps,
    browserDisplayState: { mode: null },
  }
  const modeSelection = JSON.parse(await executeTool(
    'browser_set_display_mode',
    { mode: 'card', reason: 'test model explicitly selected compact presentation' },
    browserToolContext,
  ))
  assert.equal(modeSelection.ok, true, JSON.stringify(modeSelection))

  const snapshot = JSON.parse(await executeTool(
    'browser_snapshot',
    {},
    browserToolContext,
  ))
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot))
  assert.equal(snapshot.remote_tool, 'browser_snapshot')
  assert.match(snapshot.content?.[0]?.text || '', /Example Domain/)

  console.log('test-web-read passed: legacy web tools removed; Chrome DevTools MCP remains usable')
} finally {
  await shutdownMcpClients()
  fs.rmSync(tempUserDir, { recursive: true, force: true })
}
