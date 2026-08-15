import assert from 'node:assert/strict'
import { TOOL_SCHEMAS, getToolSchema } from './capabilities/schemas.js'
import { executeTool } from './capabilities/executor.js'
import { evaluateToolPolicy } from './capabilities/tool-policy.js'
import { classifyActionContract } from './runtime/action-contract.js'

assert.ok(TOOL_SCHEMAS.run_command, 'run_command is registered')
assert.equal(getToolSchema('exec_command'), null, 'legacy exec_command is no longer model-visible')
assert.equal(getToolSchema('exec_quick_command'), null, 'legacy exec_quick_command is no longer model-visible')

const schema = getToolSchema('run_command')
assert.deepEqual(schema.function.parameters.properties.mode.enum, ['auto', 'quick', 'task', 'background', 'strict'])
assert.match(schema.function.description, /bind to 127\.0\.0\.1\/localhost by default/)

const quick = JSON.parse(await executeTool('run_command', {
  command: 'node -e "console.log(\'run-command-ok\')"',
  mode: 'quick',
}, { source: 'test' }))
assert.equal(quick.ok, true)
assert.equal(quick.tool, 'run_command')
assert.equal(quick.command_profile, 'quick')
assert.match(quick.stdout, /run-command-ok/)

const started = JSON.parse(await executeTool('run_command', {
  action: 'start',
  command: 'node -e "console.log(\'run-started\'); setTimeout(() => console.log(\'run-finished\'), 120)"',
  mode: 'task',
}, { source: 'test' }))
assert.equal(started.ok, true)
assert.match(started.run_id, /^cmd_/)
assert(['running', 'completed'].includes(started.state), 'explicit start returns an observable run state')

const waited = JSON.parse(await executeTool('run_command', {
  action: 'wait',
  run_id: started.run_id,
  timeout: 5,
}, { source: 'test' }))
assert.equal(waited.state, 'completed')
assert.equal(waited.timed_out, false)
assert.equal(waited.exit_code, 0)
assert.match(waited.stdout, /run-started/)
assert.match(waited.stdout, /run-finished/)

const output = JSON.parse(await executeTool('run_command', {
  action: 'read_output',
  run_id: started.run_id,
  cursor: 0,
}, { source: 'test' }))
assert.equal(output.state, 'completed')
assert(output.output.length > 0, 'read_output returns ordered output events')
assert(output.output_cursor > 0, 'read_output advances the output cursor')

const cancellable = JSON.parse(await executeTool('run_command', {
  action: 'start',
  command: 'node -e "setInterval(() => {}, 1000)"',
}, { source: 'test' }))
assert.equal(cancellable.state, 'running')
const cancelled = JSON.parse(await executeTool('run_command', {
  action: 'cancel',
  run_id: cancellable.run_id,
}, { source: 'test' }))
assert.equal(cancelled.state, 'cancelled')
assert.equal(cancelled.cancelled, true)

const waitTimedOut = JSON.parse(await executeTool('run_command', {
  command: 'node -e "setTimeout(() => console.log(\'too-late\'), 2000)"',
  mode: 'task',
  timeout: 1,
}, { source: 'test' }))
assert.equal(waitTimedOut.state, 'running')
assert.equal(waitTimedOut.timed_out, true)
assert.equal(waitTimedOut.still_running, true)
const cancelledAfterTimeout = JSON.parse(await executeTool('run_command', {
  action: 'cancel',
  run_id: waitTimedOut.run_id,
}, { source: 'test' }))
assert.equal(cancelledAfterTimeout.state, 'cancelled')

const explicitlyStartedForTimeout = JSON.parse(await executeTool('run_command', {
  action: 'start',
  command: 'node -e "setTimeout(() => {}, 2000)"',
  mode: 'task',
}, { source: 'test' }))
const explicitWaitTimedOut = JSON.parse(await executeTool('run_command', {
  action: 'wait',
  run_id: explicitlyStartedForTimeout.run_id,
  timeout: 1,
}, { source: 'test' }))
assert.equal(explicitWaitTimedOut.timed_out, true)
assert.equal(explicitWaitTimedOut.still_running, true)
await executeTool('run_command', { action: 'cancel', run_id: explicitlyStartedForTimeout.run_id }, { source: 'test' })

const invalid = JSON.parse(await executeTool('run_command', { command: 'echo no', mode: 'download' }, { source: 'test' }))
assert.equal(invalid.ok, false)
assert.match(invalid.error, /mode must be/)

const unsafePreview = JSON.parse(await executeTool('run_command', {
  action: 'start',
  command: 'python3 -m http.server 8321',
  mode: 'background',
}, { source: 'test', currentUserMessage: '在本机浏览器预览' }))
assert.equal(unsafePreview.ok, false)
assert.equal(unsafePreview.code, 'NETWORK_SERVICE_NOT_REQUESTED')
assert.match(unsafePreview.hint, /--bind 127\.0\.0\.1/)

const safePreview = JSON.parse(await executeTool('run_command', {
  action: 'start',
  command: 'node -e "require(\'http\').createServer((_q,r) => r.end(\'ok\')).listen(0, \'127.0.0.1\')"',
  mode: 'background',
}, { source: 'test', currentUserMessage: '在本机运行开发服务' }))
assert.equal(safePreview.ok, true)
assert.equal(safePreview.service_safety?.blocked, false, 'normal loopback development service remains allowed')
await executeTool('run_command', { action: 'cancel', run_id: safePreview.run_id }, { source: 'test' })

assert.equal(evaluateToolPolicy('run_command', { command: 'Get-ChildItem' }, { autonomous: true }).allowed, false)
assert.deepEqual(classifyActionContract('帮我执行 npm test')?.requiredTools, ['run_command'])

console.log('test-run-command passed')
