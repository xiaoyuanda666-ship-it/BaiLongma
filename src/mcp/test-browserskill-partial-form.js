import test from 'node:test'
import assert from 'node:assert/strict'
import { BrowserSkillSession, stopBrowserSkillForContext } from './browserskill-client.js'
import { executeBrowserSkillTool } from './browserskill-tools.js'

async function fillWithFailure(failedRef) {
  const commands = []
  const session = new BrowserSkillSession({ options: {}, run: async args => {
    commands.push(args)
    if (args[0] === 'session' && args[1] === 'request') return {state:args.includes('--prepare') ? 'prepared' : args.includes('--cancel') ? 'closed' : 'active', session:{session_id:'partial-form-test'}}
    if (args[0] === '--version') return {version:'0.3.1'}
    if (args[0] === 'status') return { daemon_version:'0.3.1', protocol_version:'1.3', browsers:[{instance_id:'chosen', browser_name:'chrome', extension_version:'0.3.1', extension_protocol_version:'1.3'}] }
    if (args[0] === 'session' && args[1] === 'start') return { session_id: 'partial-form-test' }
    if (args[0] === 'session' && args[1] === 'stop') return { stopped: ['partial-form-test'] }
    if (args[0] === 'tab') return { tabs: [{ tab_id: 42, active: true, url: 'https://example.com/form' }] }
    if (args[0] === 'fill' && args[2] === failedRef) {
      throw Object.assign(new Error('transport disconnected'), { code: 'BSK_COMMAND_FAILED', details: { connection: 'closed' } })
    }
    if (args[0] === 'observe') return { text: 'Form snapshot' }
    return { ok: true }
  } })
  const context = { browserLeaseState: {} }
  try {
    const result = JSON.parse(await executeBrowserSkillTool('browser_fill_form', {
      fields: ['@e1', '@e2', '@e3'].map((ref, i) => ({ ref, value: `value-${i}` })),
    }, context, { sessionFactory: () => session }))
    return { result, commands }
  } finally { await stopBrowserSkillForContext(context) }
}

test('form failure reports committed fields and uncertain failed field without repeating inputs', async () => {
  const { result, commands } = await fillWithFailure('@e2')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'BSK_COMMAND_FAILED')
  assert.equal(result.partial_progress, true)
  assert.deepEqual(result.completed_steps, [{ step: 1, ref: '@e1' }])
  assert.deepEqual(result.failed_step, { step: 2, ref: '@e2', outcome: 'unknown' })
  assert.equal(result.total_steps, 3)
  assert.deepEqual(result.details, { connection: 'closed' })
  assert.match(result.recovery, /never automatically repeat/)
  assert.deepEqual(commands.filter(args => args[0] === 'fill').map(args => args[2]), ['@e1', '@e2'])
  assert.equal(commands.some(args => args[0] === 'observe'), false)
})

test('failure on first form field does not claim completed progress', async () => {
  const { result, commands } = await fillWithFailure('@e1')
  assert.equal(result.partial_progress, false)
  assert.deepEqual(result.completed_steps, [])
  assert.deepEqual(result.failed_step, { step: 1, ref: '@e1', outcome: 'unknown' })
  assert.equal(commands.filter(args => args[0] === 'fill').length, 1)
})

test('successful form executes each field once then observes', async () => {
  const { result, commands } = await fillWithFailure(null)
  assert.equal(result.ok, true)
  assert.deepEqual(commands.filter(args => ['fill', 'observe'].includes(args[0])).map(args => args[0]), ['fill', 'fill', 'fill', 'observe'])
})
