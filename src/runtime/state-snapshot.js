// Explicit public projection: callers never receive the mutable agent state.
export function snapshotAgentState(state) {
  return structuredClone({
    action: state.action,
    task: state.task,
    taskSteps: state.taskSteps || [],
    prev_recall: state.prev_recall,
    lastToolResult: state.lastToolResult || null,
    sessionCounter: state.sessionCounter,
    recentActions: state.recentActions || [],
    thoughtStack: state.thoughtStack || [],
    startupSelfCheck: state.startupSelfCheck || null,
  })
}
