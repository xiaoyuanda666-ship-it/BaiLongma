import {
  getPersonMemory,
  getMemoriesByEntity,
  getRecentConversation,
  getRecentConversationTimeline,
  getTaskKnowledge,
  getUserProfile,
  searchMemories,
} from '../../db.js'
import { PRIMARY_USER_ID } from '../../identity.js'
import { extractKeywords } from '../keywords.js'
import {
  searchRelevantMemories,
  deduplicateMemories,
  selectContextMemories,
  gatherTemporalRecall,
} from '../injector-retrieval.js'
import { buildMemorySearchPlan } from './search-plan.js'

const L2_CONTEXT_HOURS = 24 * 7

export function getParticipantMemoryContext({ senderId = null, isTickMessage = false } = {}) {
  if (senderId) {
    return {
      personMemory: getPersonMemory(senderId),
      userProfile: getUserProfile(senderId),
      conversationWindow: getRecentConversation(senderId, 20, 24),
      senderMemories: getMemoriesByEntity(senderId, 10),
    }
  }

  if (isTickMessage) {
    return {
      personMemory: getPersonMemory(PRIMARY_USER_ID),
      userProfile: getUserProfile(PRIMARY_USER_ID),
      conversationWindow: getRecentConversationTimeline(40, L2_CONTEXT_HOURS),
      senderMemories: getMemoriesByEntity(PRIMARY_USER_ID, 10),
    }
  }

  return {
    personMemory: null,
    userProfile: null,
    conversationWindow: [],
    senderMemories: [],
  }
}

export async function retrieveRelevantMemorySet({
  focusText = '',
  conversationText = '',
  hasHistory = false,
  hasHint = false,
  confidenceHint = null,
} = {}) {
  if (!focusText) return []
  const plan = buildMemorySearchPlan({ hasHistory, hasHint, confidenceHint })
  return searchRelevantMemories({
    focusText,
    contextText: conversationText,
    ...plan,
  })
}

export function retrieveTaskKnowledge(hasTask) {
  return hasTask ? getTaskKnowledge(20) : []
}

export function retrieveTemporalRecall({ isTickMessage = false, messageBody = '' } = {}) {
  // 时间词触发的轮廓注入：除 TICK 心跳外都跑。
  // 用 isTick 而不是 senderId 判断——裸消息也能触发；agent 自言自语不走 runInjector。
  return isTickMessage ? null : gatherTemporalRecall(messageBody)
}

export function retrieveRecallMemories(prevRecall) {
  const recallMemories = []
  const directions = []

  if (!prevRecall) return { recallMemories, directions }

  const query = prevRecall
  console.log(`[注入器] 处理 RECALL: ${query}`)

  let hits = searchMemories(query, 5)

  if (hits.length === 0) {
    const keywords = extractKeywords(query)
    const seen = new Set()
    for (const keyword of keywords) {
      for (const memory of searchMemories(keyword, 3)) {
        if (!seen.has(memory.id)) {
          seen.add(memory.id)
          hits.push(memory)
        }
      }
      if (hits.length >= 5) break
    }
  }

  if (hits.length > 0) {
    recallMemories.push(...hits)
    directions.push(`You proactively requested memory recall for "${query}" in the previous moment. Relevant details have been injected.`)
  } else {
    directions.push(`You proactively requested memory recall for "${query}", but no related memory was found.`)
  }

  return { recallMemories, directions }
}

export function selectInjectorMemories({ relevantMemories = [], senderMemories = [], hasHistory = false } = {}) {
  // 召回上限：有对话历史时放宽到 30，否则 12。
  const mergeCap = hasHistory ? 30 : 12
  const merged = deduplicateMemories([relevantMemories, senderMemories])
  // 「少即是强」：保留 merged 的相关度序，只给高 salience 锚留窄保留道。
  return selectContextMemories(merged, { cap: mergeCap, anchorLane: 2 })
}
