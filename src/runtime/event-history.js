// Runtime owns conversation-lane attribution; persistence is an injected port.
export function createEventHistory({ insertBrainUiEvent }) {
  const BRAIN_UI_HISTORY_TYPES = new Set([
    'message_received',
    'tick',
    'scheduled_task',
    'scheduled_task_completed',
    'scheduled_task_retry',
    'scheduled_task_failed',
    'stream_start',
    'stream_end',
    'tool_preparing',
    'tool_executing',
    'tool_call',
    'response',
    'processing_preempted',
    'llm_retry',
    'message_requeued',
    'message_dropped',
    'error',
    'protocol_violation',
  ])
  let activeBrainUiPath = null

  function persistBrainUiEvent(type, data, ts) {
    // Independent background-task browser activity is visible live and is also
    // persisted in the action audit log. It must not be attached to whichever
    // L1/L2/L3 conversation happened to be active when the concurrent event
    // arrived.
    if (data?.runtime_lane === 'background') return
    if (type === 'message_received') {
      if (activeBrainUiPath === 'l2' || activeBrainUiPath === 'l3') {
        try {
          insertBrainUiEvent({
            timestamp: ts,
            path: activeBrainUiPath,
            eventType: 'processing_preempted',
            payload: {
              reason: activeBrainUiPath === 'l3'
                ? '收到用户消息，定时任务让路'
                : '收到用户消息，心跳让路',
            },
          })
        } catch (err) {
          console.warn('[brain-ui-history] preemption persist failed:', err?.message || err)
        }
      }
      activeBrainUiPath = 'l1'
      try {
        insertBrainUiEvent({ timestamp: ts, path: 'l1', eventType: type, payload: data })
      } catch (err) {
        console.warn('[brain-ui-history] L1 start persist failed:', err?.message || err)
      }
      return
    }
    if (type === 'tick') activeBrainUiPath = 'l2'
    if (type === 'scheduled_task') activeBrainUiPath = 'l3'
    const eventPath = activeBrainUiPath
    const shouldPersist = (eventPath === 'l1' || eventPath === 'l2' || eventPath === 'l3') && BRAIN_UI_HISTORY_TYPES.has(type)

    if (shouldPersist) {
      try {
        insertBrainUiEvent({ timestamp: ts, path: eventPath, eventType: type, payload: data })
      } catch (err) {
        // 观测历史是 best-effort；写库失败绝不能阻断意识循环或 SSE。
        console.warn('[brain-ui-history] persist failed:', err?.message || err)
      }
    }

    if (type === 'response' || type === 'processing_preempted' || type === 'message_dropped' || type === 'protocol_violation') {
      activeBrainUiPath = null
    }
  }


  return persistBrainUiEvent
}
