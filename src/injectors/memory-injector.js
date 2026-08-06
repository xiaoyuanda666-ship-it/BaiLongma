// Memory Injector
//
// 只负责“从持久经历里带回什么”：对话、人物、用户画像、相关记忆、
// 时间召回、主动 RECALL、策略记忆，以及由历史派生的自我感知。
// 工具 schema、工具连续性和实时 UI/环境信息不在这里处理。

import { getConfig } from '../db.js'
import { selectActivePolicies } from '../memory/active-policies.js'
import { computeSelfPerception, computeSelfSnapshot } from '../memory/self-perception.js'
import { formatSelfEvolutionForPrompt } from '../memory/self-evolution.js'
import {
  getParticipantMemoryContext,
  retrieveRelevantMemorySet,
  retrieveTaskKnowledge,
  retrieveTemporalRecall,
  retrieveRecallMemories,
  selectInjectorMemories,
} from '../memory/injector/memory-retrieval.js'
import {
  buildMemoryFocusInput,
  stripThinkHint,
} from '../memory/injector/message-input.js'
import { writeInjectorRecallAudit } from '../memory/injector/audit.js'

const SELF_EVOLUTION_CONTEXT_RE = /self[-\s]?evol|evolv|self[-\s]?improv|improve yourself|learn(?:ed|ing)?\s+(?:from|that|this)|lesson|policy|procedure|constraint|failure|feedback|\u81ea\u8fdb\u5316|\u8fdb\u5316|\u81ea\u5b66\u4e60|\u5b66\u5230\u4e86|\u6539\u8fdb|\u6559\u8bad|\u7ecf\u9a8c|\u89c4\u5219|\u7b56\u7565|\u53cd\u601d/i

function shouldInjectSelfEvolutionContext(messageBody = '', isTick = false) {
  if (isTick) return true
  return SELF_EVOLUTION_CONTEXT_RE.test(String(messageBody || ''))
}

function consumeConfidenceHint(state) {
  const confidenceHint = state?.pendingConfidenceHint || null
  if (state && 'pendingConfidenceHint' in state) state.pendingConfidenceHint = null
  return confidenceHint
}

export async function runMemoryInjector({
  messageBody = '',
  isTickMessage = false,
  senderId = null,
  state = null,
  hint = '',
  actionLog = [],
} = {}) {
  const injectorStartedAt = Date.now()
  const hasTask = !!state?.task
  const confidenceHint = consumeConfidenceHint(state)
  const participant = getParticipantMemoryContext({ senderId, isTickMessage })
  const temporalRecall = retrieveTemporalRecall({ isTickMessage, messageBody })
  const hintText = stripThinkHint(hint)
  const focus = buildMemoryFocusInput({
    messageBody,
    temporalRecall,
    task: state?.task || '',
    hasTask,
    hintText,
    conversationWindow: participant.conversationWindow,
  })

  const relevantMemories = await retrieveRelevantMemorySet({
    focusText: focus.focusText,
    conversationText: focus.conversationText,
    hasHistory: focus.hasHistory,
    hasHint: !!hint,
    confidenceHint,
  })
  const taskKnowledge = retrieveTaskKnowledge(hasTask)
  const recall = retrieveRecallMemories(state?.prev_recall)
  const memories = selectInjectorMemories({
    relevantMemories,
    senderMemories: participant.senderMemories,
    hasHistory: focus.hasHistory,
  })
  const activePolicies = focus.focusText
    ? selectActivePolicies({
        focusText: focus.focusText,
        messageBody,
        contextText: focus.conversationText,
        actionLog,
        baseMemories: memories,
      })
    : []

  const selfPerception = (!isTickMessage && senderId && messageBody)
    ? computeSelfPerception({
        conversationWindow: participant.conversationWindow,
        currentMsg: { content: messageBody, fromId: senderId },
      })
    : null

  const agentName = getConfig('agent_name') || '小白龙'
  const selfSnapshot = computeSelfSnapshot({
    conversationWindow: participant.conversationWindow,
    actionLog,
    agentName,
  })
  const selfEvolution = shouldInjectSelfEvolutionContext(messageBody, isTickMessage)
    ? formatSelfEvolutionForPrompt({ maxRecent: isTickMessage ? 3 : 5 })
    : ''

  writeInjectorRecallAudit({
    injectorStartedAt,
    isTickMessage,
    senderId,
    messageBody,
    memories,
    recallMemories: recall.recallMemories,
    activePolicies,
  })

  return {
    memories,
    activePolicies,
    recallMemories: recall.recallMemories,
    conversationWindow: participant.conversationWindow,
    personMemory: participant.personMemory,
    userProfile: participant.userProfile,
    directions: recall.directions,
    taskKnowledge,
    temporalRecall,
    selfPerception,
    selfSnapshot,
    selfEvolution,
  }
}
