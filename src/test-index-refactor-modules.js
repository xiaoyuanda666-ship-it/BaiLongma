// Focused tests for stateful managers extracted from index.js.
//
// Run: node src/test-index-refactor-modules.js

import assert from 'node:assert/strict'
import { createAwakeningManager, STARTUP_SELF_CHECK_VERSION } from './awakening.js'
import { createTaskManager } from './task-manager.js'

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
  const state = { startupSelfCheck: null }
  const events = []
  const memories = []
  const clearedStickyEvents = []
  const manager = createAwakeningManager({
    state,
    getConfig: cfg.getConfig,
    setConfig: cfg.setConfig,
    nowTimestamp: () => '2026-06-21T00:00:00.000Z',
    buildDelegationAskDirections: () => 'delegate permissions?',
    insertMemory: (memory) => memories.push(memory),
    clearStickyEvent: (name) => clearedStickyEvents.push(name),
    emitEvent: (type, data) => events.push({ type, data }),
  })

  assert.equal(manager.version, STARTUP_SELF_CHECK_VERSION)
  assert.equal(STARTUP_SELF_CHECK_VERSION, 'v3')
  assert.equal(manager.getAwakeningTicks(), 10)
  manager.decrementAwakeningTick()
  assert.equal(cfg.store.get('awakening_ticks_remaining'), '9')
  assert.match(manager.buildAwakeningExplorationDirections(), /Exploration \(1\/2\)/)

  cfg.setConfig('awakening_exploration_index', '2')
  assert.equal(manager.buildAwakeningExplorationDirections(), 'delegate permissions?')

  const first = manager.ensureStartupSelfCheckState()
  assert.equal(first.version, STARTUP_SELF_CHECK_VERSION)
  assert.equal(first.status, 'running')
  assert.equal(first.active, true)
  assert.equal(first.attempts, 1)
  assert.equal(state.startupSelfCheck, first)
  assert.match(manager.buildStartupSelfCheckDirections(first), /ui_set/)

  const completed = manager.completeStartupSelfCheck({
    summary: 'all checks passed',
    results: { filesystem: 'ok' },
  })
  assert.equal(completed.status, 'completed')
  assert.equal(state.startupSelfCheck.active, false)
  assert.equal(JSON.parse(cfg.store.get('l2_startup_self_check')).version, STARTUP_SELF_CHECK_VERSION)
  assert.equal(memories.at(-1).mem_id, `system_l2_startup_self_check_${STARTUP_SELF_CHECK_VERSION}`)
  assert.equal(clearedStickyEvents.at(-1), 'startup_self_check_started')
  assert.equal(events.at(-1).type, 'startup_self_check_completed')

  const restored = manager.ensureStartupSelfCheckState()
  assert.equal(restored.active, false)
  assert.equal(restored.status, 'completed')
}

function testTaskManager() {
  const cfg = makeConfigStore()
  const state = {
    task: null,
    taskSteps: [],
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
  assert.equal(saveCount, 1)
  assert.equal(events.at(-1).type, 'task_set')

  const firstStep = manager.updateTaskStep(0, 'done', 'moved')
  assert.equal(firstStep.progress, '1/2')
  assert.equal(firstStep.allTerminal, false)
  assert.equal(firstStep.nextIndex, 1)

  const finalStep = manager.updateTaskStep(1, 'done', 'moved')
  assert.equal(finalStep.allTerminal, true)
  assert.equal(state.task, 'Refactor index.js', 'terminal steps must not implicitly complete the task')
  assert.equal(state.taskSteps.length, 2)

  manager.completeTask('manager extraction complete')
  assert.equal(state.task, null)
  assert.equal(state.taskSteps.length, 0)
  assert.equal(cfg.store.get('current_task'), '')
  assert.equal(cfg.store.get('current_task_steps'), '[]')
  assert.deepEqual(closeArgs, { commitmentId: 'commit-7', status: 'done' })
  assert.equal(memories.at(-1).event_type, 'task_complete')
  assert.equal(events.at(-1).type, 'task_cleared')

  manager.setTaskFromMarker(' marker task ')
  assert.equal(state.task, 'marker task')
  assert.deepEqual(state.taskSteps, [])
  manager.clearTaskFromMarker()
  assert.equal(state.task, null)
  assert.deepEqual(state.taskSteps, [])
  assert.equal(closeArgs.status, 'done')
}

testAwakeningManager()
testTaskManager()

console.log('\nAll index-refactor module tests passed.')
