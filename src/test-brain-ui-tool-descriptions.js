import assert from 'node:assert/strict'
import { ThoughtStream, friendlyToolIcon, friendlyToolName } from './ui/brain-ui/thought-stream.js'
import { setLocale } from './ui/brain-ui/i18n/index.js'
import { BUILTIN_PLAYWRIGHT_ALLOWED_TOOLS } from './mcp/playwright-server.js'

const storage = { getItem: () => null, setItem: () => {} }
setLocale('zh-CN', { storage })

for (const toolName of BUILTIN_PLAYWRIGHT_ALLOWED_TOOLS) {
  const label = friendlyToolName(toolName)
  assert.notEqual(label, toolName, `${toolName} must not be shown as its internal identifier`)
  assert.notEqual(label, '处理事务', `${toolName} needs a specific user-facing action`)
  assert.notEqual(friendlyToolIcon(toolName), '⚙️', `${toolName} needs a specific icon`)
}

assert.equal(friendlyToolName('browser_navigate'), '打开网页')
assert.equal(friendlyToolName('browser_navigate_forward'), '前进到下一页')
assert.equal(friendlyToolName('browser_reload'), '重新加载网页')
assert.equal(friendlyToolName('browser_fill_form'), '填写表单')
assert.equal(friendlyToolName('browser_press_key', { key: 'End' }), '滚动页面')
assert.equal(friendlyToolName('browser_tabs', { action: 'select' }), '切换标签页')
assert.equal(friendlyToolName('system_browser_open'), '用电脑浏览器打开')
assert.notEqual(friendlyToolIcon('system_browser_open'), '⚙️')
assert.equal(
  friendlyToolName('mcp__custom_playwright__browser_navigate'),
  '打开网页',
  'MCP aliases should use the same friendly action',
)
assert.equal(
  friendlyToolName('private_internal_tool_name'),
  '处理事务',
  'unknown internal identifiers must not leak into the user-facing UI',
)

setLocale('en-US', { storage })
assert.equal(friendlyToolName('read_file'), 'Read file')
assert.equal(friendlyToolName('browser_press_key', { key: 'End' }), 'Scroll page')
assert.equal(friendlyToolName('browser_tabs', { action: 'select' }), 'Switch tab')
assert.equal(friendlyToolName('private_internal_tool_name'), 'Handle task')

const formatter = Object.create(ThoughtStream.prototype)
formatter.toolDetailLength = 160
assert.equal(formatter.formatToolDetail('read_file', {}, 'smoke content'), 'Content preview: smoke content')
assert.equal(
  formatter.formatToolDetail('run_command', {}, JSON.stringify({ ok: true, exit_code: 0 })),
  'Command completed (exit code 0).',
)
assert.equal(
  formatter.formatToolDetail('search_memory', {}, JSON.stringify({ ok: true, hits: [] })),
  'No memories matched.',
)

console.log('[PASS] Brain UI tool descriptions')
