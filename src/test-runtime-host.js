import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActivationLifecycle } from './runtime/activation-lifecycle.js'
import { snapshotAgentState } from './runtime/state-snapshot.js'

const quietLogger = { log() {}, error() {} }

test('activation waits for intro, cancels fallback and starts exactly once', async () => {
  const timers = new Map()
  const starts = []
  let nextTimer = 0
  const gate = createActivationLifecycle({
    start: async options => starts.push(options),
    setTimer(fn, ms) { assert.equal(ms, 60_000); timers.set(++nextTimer, fn); return nextTimer },
    clearTimer(id) { timers.delete(id) },
    logger: quietLogger,
  })
  gate.release()
  gate.defer()
  gate.defer()
  assert.equal(timers.size, 1)
  assert.deepEqual(starts, [])
  gate.release()
  gate.release()
  await Promise.resolve()
  assert.deepEqual(starts, [{ runImmediateTick: true }])
  assert.equal(timers.size, 0)
})

test('activation fallback releases loop and reports startup failure', async () => {
  let fallback
  const errors = []
  const failure = new Error('loop failed')
  const gate = createActivationLifecycle({
    start() { throw failure },
    setTimer(fn) { fallback = fn; return { unref() {} } },
    clearTimer() {},
    logger: { log() {}, error(...args) { errors.push(args) } },
  })
  gate.defer()
  fallback()
  gate.release()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(errors.length, 1)
  assert.equal(errors[0][1], failure)
})

test('state snapshots expose only public state and cannot mutate nested runtime data', () => {
  const state = {
    action: 'working', task: 'test', taskSteps: [{ text: 'step', metadata: { complete: false } }],
    lastToolResult: { args: { options: ['original'] } }, recentActions: [], thoughtStack: [],
    threadState: { secret: true },
  }
  const snapshot = snapshotAgentState(state)
  snapshot.taskSteps[0].metadata.complete = true
  snapshot.lastToolResult.args.options.push('changed')
  assert.equal(state.taskSteps[0].metadata.complete, false)
  assert.deepEqual(state.lastToolResult.args.options, ['original'])
  assert.equal('threadState' in snapshot, false)
})

// App dependencies use legacy config singletons. Keep their data isolated.
const testDir = mkdtempSync(join(tmpdir(), 'bailongma-runtime-host-'))
process.env.BAILONGMA_USER_DIR = testDir
const { startApplication } = await import('./app/interfaces.js')

test('App starts API before services and terminal, but does not start unactivated runtime', async () => {
  const calls = []
  let context
  const runtime = {
    needsActivation: true,
    getStateSnapshot: () => ({ task: 'ready' }),
    onActivated() {}, onActivationIntroComplete() {},
    startBackgroundServices() { calls.push('services') },
    async start() { calls.push('loop') },
  }
  const result = await startApplication({
    runtime, logger: quietLogger,
    startAPI({ runtimeContext }) { context = runtimeContext; calls.push('api'); return { port: 3721, protocol: 'http' } },
    startTerminal() { calls.push('terminal') },
  })
  assert.deepEqual(calls, ['api', 'services', 'terminal'])
  assert.equal(result.port, 3721)
  assert.equal(context.onActivated, runtime.onActivated)
  assert.equal(context.onActivationIntroComplete, runtime.onActivationIntroComplete)
  assert.deepEqual(context.getStateSnapshot(), { task: 'ready' })
  runtime.needsActivation = false
  calls.length = 0
  await startApplication({ runtime, logger: quietLogger,
    startAPI() { calls.push('api'); return { port: 3721, protocol: 'http' } },
    startTerminal() { calls.push('terminal') },
  })
  assert.deepEqual(calls, ['api', 'services', 'terminal', 'loop'])
})

test('App propagates synchronous runtime startup errors to its composition root', async () => {
  await assert.rejects(startApplication({
    runtime: { needsActivation: false, startBackgroundServices() {}, start() { throw new Error('cannot start') } },
    startAPI: () => ({ port: 3721, protocol: 'http' }), startTerminal() {}, logger: quietLogger,
  }), /cannot start/)
})

test('App is ready while the first runtime turn is pending and reports async failure', async () => {
  let rejectTurn
  const pendingTurn = new Promise((resolve, reject) => { rejectTurn = reject })
  const errors = []
  const startup = startApplication({
    runtime: { needsActivation: false, startBackgroundServices() {}, start: () => pendingTurn },
    startAPI: () => ({ port: 3721, protocol: 'http' }), startTerminal() {},
    logger: { log() {}, error(...args) { errors.push(args) } },
  })
  // A deterministic sentinel catches accidentally awaiting the first turn.
  const pending = Symbol('still waiting for the first turn')
  const result = await Promise.race([startup, Promise.resolve(pending)])
  assert.notEqual(result, pending)
  assert.equal(result.runtimeStarted, pendingTurn)
  assert.equal(result.port, 3721)
  const failure = new Error('first turn failed')
  rejectTurn(failure)
  await assert.rejects(result.runtimeStarted, /first turn failed/)
  assert.equal(errors.length, 1)
  assert.equal(errors[0][1], failure)
})

test('Runtime can initialize without App startup and preserves persisted task state', async () => {
  const { setConfig } = await import('./db.js')
  setConfig('current_task', 'headless task')
  setConfig('current_task_steps', JSON.stringify([{ text: 'resume', status: 'pending' }]))
  const { createAgentRuntime, buildToolContext } = await import('./runtime/agent-host.js')
  const progress = []
  const runtime = await createAgentRuntime({
    prepareRuntime: async () => ({ startupSkills: [], geoResult: null }),
    reportStartupProgress: (...args) => progress.push(args),
  })
  assert.equal(runtime.getStateSnapshot().task, 'headless task')
  assert.equal(runtime.getStateSnapshot().taskSteps[0].text, 'resume')
  assert.equal(typeof runtime.start, 'function')
  assert.equal(progress.at(-1)[0], 'skills')
  assert.deepEqual(buildToolContext({ currentTargetId: 'user-1' }).allowedTargetIds, ['user-1'])
  await assert.rejects(createAgentRuntime({ prepareRuntime: async () => { throw new Error('preparation failed') } }), /preparation failed/)
})

test('real turn builds model context from prepared geography without UI or network model calls', async () => {
  const { createAgentRuntime } = await import('./runtime/agent-host.js')
  const { setConfig } = await import('./db.js')
  setConfig('current_task', '')
  setConfig('current_task_steps', '[]')
  let runTurn
  const modelCalls = []
  await createAgentRuntime({
    prepareRuntime: async () => ({ startupSkills: [], geoResult: { location: { country_code: 'CN', timezone: 'Asia/Shanghai' } } }),
    createLoop(options) {
      runTurn = options.runTurn
      return { markLastTickAborted() {}, start() {} }
    },
    async callModel(args) {
      modelCalls.push(args)
      return { content: '', toolResult: null, aborted: true, delivered: false }
    },
  })
  await runTurn('你好', 'startup geography regression', {
    content: '你好', fromId: 'ID:000001', channel: 'TUI', priority: 100,
  })
  assert.equal(modelCalls.length, 1, 'real runTurn must reach the model after building prompt/context')
  assert.equal(modelCalls[0].message, '你好')
  assert.ok(modelCalls[0].systemPrompt.length > 0)
  assert.ok(modelCalls[0].messages.length > 0)
})

test.after(async () => {
  const { closeDBForTest } = await import('./db.js')
  closeDBForTest()
  rmSync(testDir, { recursive: true, force: true })
})
