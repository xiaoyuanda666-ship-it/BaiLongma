import test from 'node:test'
import assert from 'node:assert/strict'
import { browserBackend } from './browser-backend.js'
import { BrowserSkillSession, getBrowserSkillStatus, stopBrowserSkillForContext, releaseBrowserSkillForContext, controlBrowserTask, browserTasks } from './browserskill-client.js'
import { executeBrowserSkillTool, planBrowserSkillTool, browserSkillDescriptor } from './browserskill-tools.js'
import { getBuiltInBrowserToolDescriptor } from './chrome-devtools-server.js'

function fixture() {
  const commands = []
  let url = 'https://example.com/'
  const run = async args => {
    commands.push(args)
    if (args[0] === 'session' && args[1] === 'request') return {state:args.includes('--prepare') ? 'prepared' : args.includes('--cancel') ? 'closed' : 'active', session:{session_id:'test'}}
    if (args[0] === '--version') return {version:'0.3.1'}
    if (args[0] === 'status') return { daemon_version:'0.3.1', protocol_version:'1.3', browsers:[{instance_id:'chosen', browser_name:'chrome', extension_version:'0.3.1', extension_protocol_version:'1.3'}] }
    if (args[0] === 'session' && args[1] === 'start') return { session_id: 'test' }
    if (args[0] === 'session' && args[1] === 'stop') return { stopped: ['test'], failed: [], return_failures: [] }
    if (args[0] === 'navigate') { url = args[1]; return { tab_id: 42, url } }
    if (args[0] === 'observe') return { tab_id: 42, text: '@e1 link Learn more', truncated: false }
    if (args[0] === 'tab') return { tabs: [{ tab_id: 42, active: true, url }] }
    return { ok: true }
  }
  const session = new BrowserSkillSession({ run, options: { browser: 'chosen' } })
  const context = { browserLeaseState: { lease: null } }
  const invoke = async (name, args = {}) => JSON.parse(await executeBrowserSkillTool(name, args, context, { sessionFactory: () => session }))
  return { commands, context, session, invoke }
}
test('backend defaults safely and rejects misspellings', () => {
  assert.equal(browserBackend({}), 'browserskill')
  assert.equal(browserBackend({ BAILONGMA_BROWSER_BACKEND: 'browserskill' }), 'browserskill')
  assert.equal(browserBackend({ BAILONGMA_BROWSER_BACKEND: 'embedded' }), 'browserskill')
})
test('profile binding, fresh observation and explicit tab targeting', async () => {
  const f = fixture()
  try {
    const result = await f.invoke('browser_navigate', { url: 'https://example.com/' })
    assert.equal(result.ok, true)
    assert.match(result.content[0].text, /@e1/)
    assert.deepEqual(f.commands.find(a => a[0] === 'session' && a[1] === 'start').slice(0,6), ['session', 'start', '--name', 'Bailongma', '--browser', 'chosen'])
    assert.ok(f.commands.find(a => a[0] === 'observe').includes('--tab-id'))
    await f.invoke('browser_click', { ref: '@e1' })
    assert.equal(f.commands.filter(a => a[0] === 'session' && a[1] === 'start').length, 1)
  } finally { await stopBrowserSkillForContext(f.context) }
  assert.equal(f.session.id, null)
})
test('independent turn states do not share sessions', async () => {
  const a = fixture(), b = fixture()
  try {
    await a.invoke('browser_snapshot'); await b.invoke('browser_snapshot')
    assert.notEqual(a.context.browserLeaseState.browserSkillSession, b.context.browserLeaseState.browserSkillSession)
  } finally { await stopBrowserSkillForContext(a.context); await stopBrowserSkillForContext(b.context) }
})
test('input mapping preserves literal text, append semantics and option values', () => {
  const text = '$(touch /tmp/should-not-exist); `echo secret`'
  assert.deepEqual(planBrowserSkillTool('browser_type', { ref: '@e1', text }), [['fill', '--ref', '@e1', '--value', text, '--no-clear']])
  assert.equal(planBrowserSkillTool('browser_type', { ref: '@e1', text, replace: true })[0].includes('--no-clear'), false)
  assert.throws(() => planBrowserSkillTool('browser_click', { ref: '1_2' }))
  assert.throws(() => planBrowserSkillTool('browser_click', { ref: 'body' }))
  assert.throws(() => planBrowserSkillTool('browser_fill_form', { fields: [{ ref: '@e1', value: 'a' }, { ref: 'bad', value: 'b' }] }))
})
test('unsupported actions do not start any browser', async () => {
  const f = fixture()
  assert.equal((await f.invoke('browser_drag')).code, 'BSK_TOOL_UNSUPPORTED')
  assert.equal(f.commands.length, 0)
})
test('login URL prevents input without silently switching accounts', async () => {
  const f = fixture()
  try {
    await f.invoke('browser_navigate', { url: 'https://accounts.google.com/signin' })
    const result = await f.invoke('browser_type', { ref: '@e1', text: 'secret' })
    assert.equal(result.code, 'BSK_USER_CONTROL')
    assert.equal(result.details.pause_reason, 'login_required')
    assert.equal(f.commands.some(a => a[0] === 'fill'), false)
  } finally { await stopBrowserSkillForContext(f.context) }
})

test('missing task tab is recoverable without a false login pause', async () => {
  const f = fixture()
  try {
    await f.invoke('browser_snapshot')
    const run = f.session.run
    f.session.run = async args => args[0] === 'tab' && args[1] === 'list' ? { tabs: [] } : run(args)
    const result = await f.invoke('browser_click', { ref: '@e1' })
    assert.equal(result.code, 'BSK_TAB_UNAVAILABLE')
    assert.equal(f.session.humanControl, false)
    assert.equal(f.commands.some(a => a[0] === 'click'), false)
    f.session.run = run
    await f.invoke('browser_snapshot')
    assert.equal((await f.invoke('browser_click', { ref: '@e1' })).ok, true)
  } finally { await stopBrowserSkillForContext(f.context) }
})

test('interrupted session preserves its reason and requires confirmed idle before resume', async () => {
  const f = fixture()
  try {
    await f.invoke('browser_snapshot')
    f.context.signal = AbortSignal.abort()
    await releaseBrowserSkillForContext(f.context)
    delete f.context.signal
    const count = f.commands.length
    const blocked = await f.invoke('browser_navigate', { url: 'https://example.com/' })
    assert.equal(blocked.details.pause_reason, 'turn_interrupted')
    assert.match(blocked.recovery, /bsk/)
    assert.equal(f.commands.length, count)
    assert.equal(browserTasks().find(t => t.session_id === 'test').pause_reason, 'turn_interrupted')
    await assert.rejects(controlBrowserTask('test', 'resume'), { code: 'BSK_STILL_BUSY' })
    const run = f.session.run
    let idle = false
    f.session.run = async args => args[0] === 'debug'
      ? { activity: { state: idle ? 'idle' : 'running', wait_complete: idle } } : run(args)
    await assert.rejects(controlBrowserTask('test', 'settle'), { code: 'BSK_STILL_BUSY' })
    assert.equal(f.session.pauseReason, 'turn_interrupted')
    idle = true
    await controlBrowserTask('test', 'settle')
    await controlBrowserTask('test', 'resume')
    assert.equal(f.session.pauseReason, null)
    assert.equal((await f.invoke('browser_click', { ref: '@e1' })).code, 'BSK_FRESH_OBSERVATION_REQUIRED')
    await f.invoke('browser_snapshot')
    assert.equal((await f.invoke('browser_click', { ref: '@e1' })).ok, true)
  } finally { await stopBrowserSkillForContext(f.context) }
})

test('turn cancellation does not overwrite an existing login pause', async () => {
  const f = fixture()
  try {
    await f.invoke('browser_navigate', { url: 'https://accounts.google.com/signin' })
    f.context.signal = AbortSignal.abort()
    await releaseBrowserSkillForContext(f.context)
    assert.equal(f.session.pauseReason, 'login_required')
  } finally { await stopBrowserSkillForContext(f.context) }
})

test('challenge observation records verification rather than user takeover', async () => {
  const f = fixture()
  try {
    const run = f.session.run
    f.session.run = async args => args[0] === 'observe'
      ? { tab_id: 42, text: '请输入验证码' } : run(args)
    const result = await f.invoke('browser_snapshot')
    assert.equal(result.user_action_required, true)
    assert.equal(result.details.pause_reason, 'challenge_required')
    assert.equal((await f.invoke('browser_tabs', { action: 'create' })).code, 'BSK_USER_CONTROL')
  } finally { await stopBrowserSkillForContext(f.context) }
})

test('explicit takeover and cancel report distinct reasons and clear after resume', async () => {
  for (const [action, reason] of [['takeover', 'user_takeover'], ['cancel', 'user_cancelled']]) {
    const f = fixture()
    try {
      await f.invoke('browser_snapshot')
      const run = f.session.run
      f.session.run = async args => args[0] === 'debug'
        ? { activity: { state: 'idle', wait_complete: true } } : run(args)
      await controlBrowserTask('test', action)
      assert.equal((await f.invoke('browser_close')).details.pause_reason, reason)
      await controlBrowserTask('test', 'resume')
      assert.equal(browserTasks().find(t => t.session_id === 'test').pause_reason, undefined)
    } finally { await stopBrowserSkillForContext(f.context) }
  }
})

test('timed-out idle confirmation and failed resume retain the pause', async () => {
  const f = fixture()
  try {
    await f.invoke('browser_snapshot')
    const run = f.session.run
    let timedOut = true
    let observationFails = true
    f.session.run = async args => {
      if (args[0] === 'debug') return { activity: { state: 'idle', wait_complete: true, wait_timed_out: timedOut } }
      if (args[0] === 'observe' && observationFails) throw new Error('disconnected')
      return run(args)
    }
    await assert.rejects(controlBrowserTask('test', 'takeover'), { code: 'BSK_STILL_BUSY' })
    assert.equal(f.session.unsettled, true)
    await assert.rejects(controlBrowserTask('test', 'resume'), { code: 'BSK_STILL_BUSY' })
    timedOut = false
    await controlBrowserTask('test', 'settle')
    await assert.rejects(controlBrowserTask('test', 'resume'), /disconnected/)
    assert.equal(f.session.humanControl, true)
    assert.equal(f.session.pauseReason, 'user_takeover')
    observationFails = false
    await controlBrowserTask('test', 'resume')
    assert.equal(f.session.humanControl, false)
  } finally { await stopBrowserSkillForContext(f.context) }
})
test('a committed click is not repeated when observation fails', async () => {
  const f = fixture()
  try {
    await f.invoke('browser_snapshot')
    const run = f.session.run
    f.session.run = async args => { if (args[0] === 'observe') throw new Error('lost transport'); return run(args) }
    const result = await f.invoke('browser_click', { ref: '@e1' })
    assert.equal(result.action_completed, true)
    assert.equal(result.code, 'BSK_OBSERVATION_FAILED')
    assert.equal(f.commands.filter(a => a[0] === 'click').length, 1)
  } finally { await stopBrowserSkillForContext(f.context) }
})
test('turn cancellation still cleans up the session', async () => {
  const f = fixture()
  await f.invoke('browser_snapshot')
  const controller = new AbortController(); controller.abort()
  f.context.signal = controller.signal
  assert.equal((await f.invoke('browser_snapshot')).ok, false)
  await stopBrowserSkillForContext(f.context)
  assert.ok(f.commands.some(a => a[0] === 'session' && a[1] === 'stop'))
})
test('failed stop retains ownership for later cleanup', async () => {
  const f = fixture()
  await f.invoke('browser_snapshot')
  const run = f.session.run
  f.session.run = async args => args[1] === 'stop' ? { stopped: [], failed: ['test'] } : run(args)
  await assert.rejects(stopBrowserSkillForContext(f.context), /incomplete/)
  assert.equal(f.session.id, 'test')
  f.session.run = run
  await stopBrowserSkillForContext(f.context)
})
test('status never auto-starts the daemon and distinguishes missing extension', async () => {
  const status = await getBrowserSkillStatus({ run: async (args, options) => {
    assert.equal(options.autoStart, false)
    return { browsers: [] }
  } })
  assert.equal(status.ready, false)
  assert.equal(status.state, 'browser_not_connected')
})
test('descriptor exposes new refs and truthful option semantics', () => {
  const descriptor = browserSkillDescriptor(getBuiltInBrowserToolDescriptor('browser_select_option'))
  assert.match(descriptor.description, /value attribute/)
  assert.doesNotMatch(descriptor.inputSchema.properties.uid.description, /accessibility snapshot/)
})

test('same-session commands serialize even after a failed command', async () => {
  const f = fixture(), order = []
  const first = f.session.enqueue(async () => { await new Promise(resolve => setTimeout(resolve, 5)); order.push(1); throw new Error('failed') })
  const second = f.session.enqueue(async () => order.push(2))
  await assert.rejects(first)
  await second
  assert.deepEqual(order, [1, 2])
})
test('cancellation while session starts preserves its ID for cleanup', async () => {
  const f = fixture(), controller = new AbortController(), run = f.session.run
  f.context.signal = controller.signal
  f.session.run = async args => {
    const result = await run(args)
    if (args[0] === 'session' && args[1] === 'start') controller.abort()
    return result
  }
  assert.equal((await f.invoke('browser_snapshot')).ok, false)
  await stopBrowserSkillForContext(f.context)
  assert.equal(f.session.id, null)
  assert.equal(f.commands.some(args => args[0] === 'observe'), false)
})
test('status route requires authentication before probing CLI', async () => {
  const { handleBrowserPreviewRoutes } = await import('../api/routes/browser-preview.js')
  let status
  const res = { writeHead(code) { status = code }, end() {} }
  assert.equal(await handleBrowserPreviewRoutes({ method: 'GET' }, res, new URL('http://localhost/browser-backend/status')), true)
  assert.equal(status, 403)
})

test('concurrent turn cleanup and shutdown stop a session only once', async () => {
  const f = fixture()
  await f.invoke('browser_snapshot')
  await Promise.all([f.session.stop(), f.session.stop()])
  assert.equal(f.commands.filter(args => args[0] === 'session' && args[1] === 'stop').length, 1)
})
test('shutdown waits for in-flight session creation and stops its eventual ID', async () => {
  const { shutdownBrowserSkill } = await import('./browserskill-client.js')
  const f = fixture(), run = f.session.run
  let releaseStart, started
  const startEntered = new Promise(resolve => { started = resolve })
  f.session.run = async args => {
    if (args[0] === 'session' && args[1] === 'start') {
      started()
      await new Promise(resolve => { releaseStart = resolve })
    }
    return run(args)
  }
  const pending = f.invoke('browser_snapshot')
  await startEntered
  const closing = shutdownBrowserSkill()
  releaseStart()
  await pending
  assert.deepEqual(await closing, [])
  assert.equal(f.session.id, null)
  assert.ok(f.commands.some(args => args[1] === 'stop'))
})
