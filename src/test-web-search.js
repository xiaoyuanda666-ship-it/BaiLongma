import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, after } from 'node:test'
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-web-routes-'))
process.env.BAILONGMA_USER_DIR = temp
process.env.BAILONGMA_RESOURCES_DIR = process.cwd()
const { config } = await import('./config.js')
const { TOOL_SCHEMAS } = await import('./capabilities/builtin-tools.js')
const { getToolSchema } = await import('./capabilities/schemas.js')
const { listMcpTools, getMcpToolSchema, executeMcpTool } = await import('./mcp/client-manager.js')
const { executeTool } = await import('./capabilities/executor.js')
const { selectTools } = await import('./memory/tool-router.js')
const { capabilityContextBlocks } = await import('./capabilities/capability-registry.js')
const { classifyActionContract, actionContractToolSucceeded } = await import('./runtime/action-contract.js')
const { callLLM } = await import('./llm.js')
const { closeDBForTest } = await import('./db.js')
after(() => { closeDBForTest(); fs.rmSync(temp, { recursive: true, force: true }) })

test('only provider web_search is exposed as a dedicated web function', async () => {
  assert.deepEqual(Object.keys(TOOL_SCHEMAS).filter(name => /web|browser/.test(name)), ['web_search'])
  for (const name of ['model_web_search', 'model_web_fetch', 'web_read', 'fetch_url', 'system_browser_open',
    'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_scroll', 'browser_download_manage', 'start_browser_download_task']) {
    assert.equal(getToolSchema(name), null)
    assert.equal(getMcpToolSchema(name), null)
    assert.equal(JSON.parse(await executeTool(name, {})).ok, false)
    assert.equal(JSON.parse(await executeMcpTool(name, {})).ok, false)
  }
  assert.equal(listMcpTools().some(tool => tool.name.startsWith('browser_')), false)
})

test('search, browser routing and dynamic discovery use the two new entry points', async () => {
  Object.assign(config, { provider: 'deepseek', model: 'deepseek-v4-pro', apiKey: 'test-key', baseURL: 'https://api.deepseek.com' })
  assert.ok(selectTools({ messageBody: '搜索最新资料' }).includes('web_search'))
  const browser = selectTools({ messageBody: '用浏览器打开 https://example.com' })
  assert.ok(browser.includes('run_command') && browser.includes('read_file'))
  assert.ok(browser.every(name => !name.startsWith('browser_')))
  const found = JSON.parse(await executeTool('find_tool', { query: 'bsk' }))
  assert.ok(found.loaded.includes('run_command'))
  assert.ok(found.capabilities.some(cap => cap.id === 'bsk' && cap.workflow.includes('SKILL.md')))
  const context = capabilityContextBlocks({ rawText: '用浏览器打开网页', text: '用浏览器打开网页' }).join('\n')
  assert.match(context, /bsk.*SKILL\.md/)
  assert.doesNotMatch(context, /All web access must|https:\/\/www.baidu.com/)
})

test('bsk completion requires an actual completed CLI action, not setup or a failed process', () => {
  const contract = classifyActionContract('打开 https://example.com')
  assert.equal(contract.id, 'bsk')
  assert.deepEqual(contract.requiredTools, ['run_command'])
  const result = command => JSON.stringify({ ok: true, command, exit_code: 0 })
  assert.equal(actionContractToolSucceeded(contract, 'run_command', result('bsk navigate https://example.com --session task')), true)
  for (const command of ['bsk doctor', 'bsk --help', 'bsk session start', 'echo bsk navigate https://example.com', 'curl https://example.com']) {
    assert.equal(actionContractToolSucceeded(contract, 'run_command', result(command)), false, command)
  }
  assert.equal(actionContractToolSucceeded(contract, 'run_command', JSON.stringify({ ok: true, command: 'bsk observe --session task', exit_code: 0, stdout: '{"ok":false,"error":"paused"}' })), false)
  for (const exit_code of [null, 1]) assert.equal(actionContractToolSucceeded(contract, 'run_command', JSON.stringify({ ok: true, command: 'bsk navigate https://example.com', exit_code })), false)
})

test('agent can execute bsk through run_command and deliver its answer without requesting wrappers', async () => {
  const executed = []
  let round = 0
  const contract = classifyActionContract('打开 https://example.com')
  const result = await callLLM({ systemPrompt: 'Use the bsk CLI skill.', message: '打开 https://example.com',
    tools: ['read_file', 'run_command'], mustReply: true, localReply: true,
    toolContext: { currentTargetId: 'ID:test', actionContract: contract },
    _streamOnceForTest: async ({ toolSchemas }) => {
      assert.ok(toolSchemas.every(schema => !schema.function.name.startsWith('browser_')))
      if (++round === 1) return { content: '', aborted: false, toolCalls: [{ id: 'cli', name: 'run_command', arguments: JSON.stringify({ command: 'bsk navigate https://example.com --session task' }) }] }
      assert.equal(round, 2)
      return { content: '页面已打开。', aborted: false, toolCalls: [] }
    },
    _executeToolForTest: async (name, args) => {
      executed.push(name)
      return name === 'run_command' ? JSON.stringify({ ok: true, command: args.command, exit_code: 0, stdout: '{"url":"https://example.com"}' })
        : JSON.stringify({ ok: true, delivered: true })
    },
  })
  assert.equal(result.delivered, true)
  assert.deepEqual(executed, ['send_message', 'run_command', 'send_message'])
})
