import { insertBrainUiEvent } from './db.js'

// 内部事件总线：SSE 客户端管理 + 事件广播
const sseClients = new Set()

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

// 新客户端连上时需立即补发的"粘性"事件（如启动自检音效）
const stickyEvents = new Map()  // type → { data, ts }

export function setStickyEvent(type, data) {
  stickyEvents.set(type, { data, ts: new Date().toISOString() })
}

export function clearStickyEvent(type) {
  stickyEvents.delete(type)
}

// 发送所有待补发事件给指定 SSE 客户端（连接建立时调用）
export function flushStickyEvents(res) {
  for (const [type, { data, ts }] of stickyEvents) {
    try { res.write(`data: ${JSON.stringify({ type, data, ts })}\n\n`) } catch (_) {}
  }
}

export function addSSEClient(res) {
  sseClients.add(res)
}

export function removeSSEClient(res) {
  sseClients.delete(res)
}

export function emitEvent(type, data) {
  const ts = new Date().toISOString()
  persistBrainUiEvent(type, data, ts)
  if (sseClients.size === 0) return
  const payload = JSON.stringify({ type, data, ts })
  for (const res of sseClients) {
    try {
      res.write(`data: ${payload}\n\n`)
    } catch (_) {
      sseClients.delete(res)
    }
  }
}
