export const TASK_IDLE_TICK_LIMIT = 5

export function createTaskManager({
  state,
  setConfig,
  getConfig,
  saveThreadState,
  openCommitment,
  closeCommitment,
  emitEvent,
  insertMemory,
  nowTimestamp,
} = {}) {
  function openTaskCommitment(description) {
    try {
      const commitment = openCommitment(state, { text: String(description || ''), tick: state.tickCounter || 0 })
      state.taskCommitmentId = commitment?.id || null
      setConfig('current_task_commitment_id', commitment?.id || '')
      saveThreadState(state.threadState)
    } catch (e) {
      console.log('[threads] openCommitment failed:', e?.message || e)
    }
  }

  function closeTaskCommitment(status = 'done') {
    try {
      const boundId = state.taskCommitmentId || getConfig('current_task_commitment_id') || null
      const closed = closeCommitment(state, {
        commitmentId: boundId,
        status,
      })
      state.taskCommitmentId = null
      setConfig('current_task_commitment_id', '')
      if (closed) saveThreadState(state.threadState)
    } catch (e) {
      console.log('[threads] closeCommitment failed:', e?.message || e)
    }
  }

  function autoCompleteTask(reason) {
    const clearedTask = state.task
    state.task = null
    state.lastTaskRefreshTick = -10
    state.taskSteps = []
    state.taskIdleTickCount = 0
    setConfig('current_task', '')
    setConfig('current_task_steps', '[]')
    closeTaskCommitment('done')
    console.log(`[task] Auto-cleared (${reason}): ${clearedTask}`)
    emitEvent('task_cleared', { task: clearedTask, summary: `Auto-cleared: ${reason}` })
    if (clearedTask) {
      insertMemory({
        event_type: 'task_complete',
        content: `Task auto-cleared: ${clearedTask.slice(0, 60)}`,
        detail: `Reason: ${reason}`,
        entities: [], concepts: [], tags: ['task_complete'],
        timestamp: nowTimestamp(),
      })
    }
  }

  function setTask(description, steps = []) {
    state.task = description
    state.lastTaskRefreshTick = -10
    state.taskSteps = steps.map(s => ({ text: s, status: 'pending', note: '' }))
    setConfig('current_task', description)
    setConfig('current_task_steps', JSON.stringify(state.taskSteps))
    openTaskCommitment(description)
    console.log(`[task] Started: ${description} (${steps.length} step(s))`)
    emitEvent('task_set', { task: description, steps })
  }

  function completeTask(summary) {
    const clearedTask = state.task
    state.task = null
    state.taskSteps = []
    state.taskIdleTickCount = 0
    setConfig('current_task', '')
    setConfig('current_task_steps', '[]')
    closeTaskCommitment('done')
    console.log(`[task] Completed: ${clearedTask}`)
    emitEvent('task_cleared', { task: clearedTask, summary })
    if (clearedTask) {
      insertMemory({
        event_type: 'task_complete',
        content: `Task completed: ${clearedTask.slice(0, 60)}${summary ? ' — ' + summary.slice(0, 60) : ''}`,
        detail: 'Task marked complete via the complete_task tool',
        entities: [], concepts: [], tags: ['task_complete'],
        timestamp: nowTimestamp(),
      })
    }
  }

  function updateTaskStep(idx, status, note) {
    if (!state.taskSteps[idx]) return { error: `Step ${idx + 1} does not exist (${state.taskSteps.length} total)` }
    state.taskSteps[idx] = { ...state.taskSteps[idx], status, note }
    setConfig('current_task_steps', JSON.stringify(state.taskSteps))
    const total = state.taskSteps.length
    const done = state.taskSteps.filter(s => s.status === 'done').length
    emitEvent('task_step_updated', { index: idx, status, note, progress: `${done}/${total}` })
    const terminal = ['done', 'failed', 'skipped']
    const allTerminal = total > 0 && state.taskSteps.every(s => terminal.includes(s.status))
    const nextIndex = state.taskSteps.findIndex(s => s.status === 'pending')
    const nextStep = nextIndex >= 0 ? state.taskSteps[nextIndex].text : null
    const anyFailed = state.taskSteps.some(s => s.status === 'failed')
    if (allTerminal) autoCompleteTask('all steps complete')
    return {
      total,
      done,
      progress: `${done}/${total}`,
      allTerminal,
      nextIndex: nextIndex >= 0 ? nextIndex : null,
      nextStep,
      anyFailed,
    }
  }

  function setTaskFromMarker(description) {
    state.task = description.trim()
    setConfig('current_task', state.task)
    openTaskCommitment(state.task)
    console.log(`[system] Task set: ${state.task}`)
    emitEvent('task_set', { task: state.task })
  }

  function clearTaskFromMarker() {
    const clearedTask = state.task
    console.log(`[system] Task completed: ${clearedTask}`)
    emitEvent('task_cleared', { task: clearedTask })
    state.task = null
    state.taskIdleTickCount = 0
    setConfig('current_task', '')
    closeTaskCommitment('done')
    if (clearedTask) {
      insertMemory({
        event_type: 'task_complete',
        content: `Task completed: ${clearedTask.slice(0, 60)}`,
        detail: 'Task marked complete via [CLEAR_TASK] — no further execution',
        entities: [], concepts: [], tags: ['task_complete'],
        timestamp: nowTimestamp(),
      })
    }
  }

  return {
    openTaskCommitment,
    closeTaskCommitment,
    autoCompleteTask,
    setTask,
    completeTask,
    updateTaskStep,
    setTaskFromMarker,
    clearTaskFromMarker,
  }
}
