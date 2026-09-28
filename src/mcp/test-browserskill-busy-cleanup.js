import test from 'node:test'
import assert from 'node:assert/strict'
import { BrowserSkillSession, stopBrowserSkillForContext } from './browserskill-client.js'

const busy = () => Object.assign(new Error('session already has an unfinished command'), {
  code: 'BSK_COMMAND_FAILED', details: { code: 'timeout', data: { reason: 'session_busy' } },
})
function fixture(waitResult, stopError) {
  const calls = []
  const options = { browser: 'dedicated-browser', binary: 'test-bsk' }
  let stopCount = 0
  const session = new BrowserSkillSession({ options, run: async (args, config) => {
    if (args[0] === 'session' && args[1] === 'request') return {state:args.includes('--prepare') ? 'prepared' : args.includes('--cancel') ? 'closed' : 'active', session:{session_id:'owned-session'}}
    if (args[0] === '--version') return {version:'0.3.1'}
    if (args[0] === 'status') return { daemon_version:'0.3.1', protocol_version:'1.3', browsers:[{instance_id:'dedicated-browser', browser_name:'chrome', extension_version:'0.3.1', extension_protocol_version:'1.3'}] }
    calls.push(args)
    assert.equal(config.options.browser, options.browser)
    assert.equal(config.signal, undefined, 'cleanup must survive the cancelled turn')
    if (args[0] === 'session' && args[1] === 'start') return { session_id: 'owned-session' }
    if (args[0] === 'debug') {
      assert.equal(config.timeout, 35000)
      return waitResult
    }
    if (++stopCount === 1) throw busy()
    if (stopError) throw stopError
    return { stopped: ['owned-session'], failed: [], return_failures: [] }
  } })
  return { session, calls, context: { browserSkillSession: session } }
}

test('busy cleanup waits for its owned session and retries stop exactly once', async () => {
  const f = fixture({ session_id: 'owned-session', activity: { state: 'idle', wait_complete: true, wait_timed_out: false } })
  await f.session.start()
  await stopBrowserSkillForContext(f.context)
  assert.deepEqual(f.calls.slice(1), [
    ['session', 'stop', 'owned-session'],
    ['debug', 'wait', '--session', 'owned-session', '--wait-ms', '30000'],
    ['session', 'stop', 'owned-session'],
  ])
  assert.equal(f.context.browserSkillSession, undefined)
  assert.equal(f.session.id, null)
})

test('bounded wait failure retains ownership without attempting premature stop', async () => {
  const f = fixture({ session_id: 'owned-session', activity: { state: 'running', wait_complete: false, wait_timed_out: true } })
  await f.session.start()
  await assert.rejects(stopBrowserSkillForContext(f.context), { code: 'BSK_CLEANUP_FAILED' })
  assert.equal(f.session.id, 'owned-session')
  assert.equal(f.context.browserSkillSession, f.session)
  assert.equal(f.calls.length, 3)
  await stopBrowserSkillForContext(f.context) // A later cleanup can still reclaim it.
})

test('a failed stop retry remains tracked and does not loop', async () => {
  const f = fixture({ session_id: 'owned-session', activity: { state: 'idle', wait_complete: true, wait_timed_out: false } }, busy())
  await f.session.start()
  await assert.rejects(stopBrowserSkillForContext(f.context), { code: 'BSK_COMMAND_FAILED' })
  assert.equal(f.calls.length, 4)
  assert.equal(f.session.id, 'owned-session')
  assert.equal(f.context.browserSkillSession, f.session)
  f.session.run = async () => ({ stopped: ['owned-session'] })
  await stopBrowserSkillForContext(f.context)
})
