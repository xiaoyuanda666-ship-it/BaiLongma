// Focused tests for helpers extracted from index.js.
//
// Run: node src/test-index-refactor-modules.js

import assert from 'node:assert/strict'
import { createAwakeningManager, STARTUP_SELF_CHECK_VERSION } from './awakening.js'
import { createTaskManager, TASK_IDLE_TICK_LIMIT } from './task-manager.js'

function makeConfigStore(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    getConfig: (key) => store.has(key) ? store.get(key) : null,
    setConfig: (key, value) => { store.set(key, value) },
    store,
  }
}

function testAwakeningManager() {
  const cfg = makeConfigStore()
  const manager = createAwakeningManager({
    getConfig: cfg.getConfig,
    setConfig: cfg.setConfig,
    nowTimestamp: () => '2026-06-21T00:00:00.000Z',
    buildDelegationAskDirections: () => 'delegate permissions?',
  })

  assert.equal(manager.getAwakeningTicks(), 10)
  manager.decrementAwakeningTick()
  assert.equal(cfg.store.get('awakening_ticks_remaining'), '9')
  assert.match(manager.buildAwakeningExplorationDirections(), /Exploration \(1\/2\)/)

  cfg.setConfig('awakening_exploration_index', '2')
  assert.equal(manager.buildAwakeningExplorationDirections(), 'delegate permissions?')

  const state = {}
  const first = manager.ensureStartupSelfCheckState(state)
  assert.equal(first.version, STARTUP_SELF_CHECK_VERSION)
  assert.equal(first.status, 'running')
  assert.equal(first.active, true)
  assert.equal(first.attempts, 1)
  assert.equal(state.startupSelfCheck, first)
  assert.match(manager.buildStartupSelfCheckDirections(first), /complete_startup_self_check/)

  manager.writeStartupSelfCheckState({
    version: STARTUP_SELF_CHECK_VERSION,
    status: 'completed',
    summary: 'ok',
  })
  const completed = manager.ensureStartupSelfCheckState(state)
  assert.equal(completed.active, false)
  assert.equal(completed.status, 'completed')
}

function testTaskManager() {
  const cfg = makeConfigStore()
  const state = {
    task: null,
    taskSteps: [],
    taskIdleTickCount: 0,
    lastTaskRefreshTick: 99,
    tickCounter: 7,
    threadState: { threads: [], foregroundId: null, commitments: [] },
  }
  const events = []
  const memories = []
  let saveCount = 0
  let closeArgs = null

  const manager = createTaskManager({
    state,
    getConfig: cfg.getConfig,
    setConfig: cfg.setConfig,
    saveThreadState: () => { saveCount++ },
    openCommitment: (_state, payload) => ({ id: `commit-${payload.tick}` }),
    closeCommitment: (_state, args) => { closeArgs = args; return true },
    emitEvent: (type, data) => events.push({ type, data }),
    insertMemory: (memory) => memories.push(memory),
    nowTimestamp: () => '2026-06-21T00:00:00.000Z',
  })

  manager.setTask('Refactor index.js', ['extract awakening', 'extract task manager'])
  assert.equal(state.task, 'Refactor index.js')
  assert.equal(state.lastTaskRefreshTick, -10)
  assert.deepEqual(state.taskSteps.map(s => s.status), ['pending', 'pending'])
  assert.equal(cfg.store.get('current_task'), 'Refactor index.js')
  assert.equal(cfg.store.get('current_task_commitment_id'), 'commit-7')
  assert.equal(state.taskCommitmentId, 'commit-7')
  assert.equal(saveCount, 1)
  assert.equal(events.at(-1).type, 'task_set')

  const progress = manager.updateTaskStep(0, 'done', 'moved')
  assert.equal(progress.progress, '1/2')
  assert.equal(progress.allTerminal, false)
  assert.equal(progress.nextIndex, 1)
  assert.equal(state.task, 'Refactor index.js')

  const complete = manager.updateTaskStep(1, 'done', 'moved')
  assert.equal(complete.allTerminal, true)
  assert.equal(state.task, null)
  assert.equal(state.taskSteps.length, 0)
  assert.equal(state.taskIdleTickCount, 0)
  assert.equal(cfg.store.get('current_task'), '')
  assert.equal(cfg.store.get('current_task_steps'), '[]')
  assert.deepEqual(closeArgs, { commitmentId: 'commit-7', status: 'done' })
  assert.equal(memories.at(-1).event_type, 'task_complete')
  assert.match(events.at(-1).data.summary, /Auto-cleared/)

  manager.setTaskFromMarker(' marker task ')
  assert.equal(state.task, 'marker task')
  manager.clearTaskFromMarker()
  assert.equal(state.task, null)
  assert.equal(closeArgs.status, 'done')
  assert.equal(TASK_IDLE_TICK_LIMIT, 5)
}

testAwakeningManager()
testTaskManager()

console.log('\nAll index-refactor module tests passed.')
