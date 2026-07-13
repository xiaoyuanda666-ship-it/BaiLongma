import { insertRecallAudit } from '../../db.js'
import { logWarn } from '../../runtime/error-logger.js'

export function writeInjectorRecallAudit({
  injectorStartedAt,
  isTickMessage = false,
  senderId = null,
  messageBody = '',
  memories = [],
  recallMemories = [],
  activePolicies = [],
} = {}) {
  // Memory-Optimization v0.1 Phase 0：记录这一轮召回的"命中了什么/漏了什么"。
  // 写入 best-effort；任何失败都吞掉，绝不影响主流程。
  try {
    const chosenIds = [
      ...memories.map(m => m.mem_id || m.id),
      ...recallMemories.map(m => m.mem_id || m.id),
      ...activePolicies.map(m => m.mem_id || m.id),
    ]
    const dist = {}
    for (const m of memories) {
      const et = m.event_type || 'unknown'
      dist[et] = (dist[et] || 0) + 1
    }
    insertRecallAudit({
      turn_label: isTickMessage ? 'L2_TICK' : (senderId ? `L1_msg_from_${senderId}` : 'unknown'),
      from_id: senderId,
      channel: null,
      query_text: messageBody || (isTickMessage ? '[TICK]' : ''),
      matched_mem_ids: chosenIds,
      chosen_count: chosenIds.length,
      event_type_dist: dist,
      latency_ms: Date.now() - injectorStartedAt,
      source: 'runInjector',
    })
  } catch (err) {
    logWarn(err, {
      scope: 'memory.injector',
      operation: 'write_recall_audit',
      metadata: {
        isTickMessage,
        hasSenderId: !!senderId,
        memoryCount: memories.length,
        recallCount: recallMemories.length,
        activePolicyCount: activePolicies.length,
      },
    })
  }
}
