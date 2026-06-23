import {
  getActiveConstraints,
  getTaskKnowledge,
  getPersonMemory,
  getMemoriesByEntity,
  getRecentConversation,
  getRecentConversationTimeline,
  getRecentActionLogs,
  getValidPrefetchCache,
  getUnconsumedUISignals,
  markUISignalsConsumed,
  getConfig,
  getUserProfile,
  insertRecallAudit,
  searchMemories,
} from '../db.js'
import { getActiveUICards } from '../events.js'
import { getInstalledToolNames } from '../capabilities/marketplace/index.js'
import { PRIMARY_USER_ID } from '../identity.js'
import { extractKeywords } from './keywords.js'
import { stripTemporalWords } from './temporal-parser.js'
import { selectTools } from './tool-router.js'
import { computeSelfPerception, computeSelfSnapshot } from './self-perception.js'
import { selectActivePolicies } from './active-policies.js'

// runInjector 内部用到的检索/选择/解析原语（已拆到 ./injector-retrieval.js）
import {
  parseMessageInput,
  searchRelevantMemories,
  deduplicateMemories,
  selectContextMemories,
  gatherTemporalRecall,
} from './injector-retrieval.js'
// runInjector 内部用到的渲染函数（已拆到 ./injector-format.js）
import { summarizeUISignals } from './injector-format.js'

// —— 对外门面：保持 injector.js 作为统一入口，原有 import 路径不变 ——
// 旧 import 路径兼容：focus.js / 其他模块也能从 injector 拿到 extractKeywords
export { extractKeywords }
export { selectContextMemories }
export { searchAdditionalMemories } from './injector-retrieval.js'
export {
  formatTemporalRecall,
  formatMemoriesForPrompt,
  formatPrefetchedItems,
  formatActiveUICards,
  formatSceneManifest,
  formatAIVideoPanel,
  formatTaskKnowledge,
} from './injector-format.js'
export { formatActivePoliciesForPrompt } from './active-policies.js'

const L2_CONTEXT_HOURS = 24 * 7

// hint：一层思考器的输出文本，用于扩展 L2 的记忆检索范围
export async function runInjector({ message, state, hint = '' }) {
  const injectorStartedAt = Date.now()
  const lastToolResult = state?.lastToolResult || null
  if (lastToolResult) state.lastToolResult = null

  const confidenceHint = state?.pendingConfidenceHint || null
  if (state && 'pendingConfidenceHint' in state) state.pendingConfidenceHint = null  // 消费即焚

  const { isTick: isTickMessage, senderId, messageBody } = parseMessageInput(message)
  const hasTask = !!state?.task

  const constraints = getActiveConstraints()

  let personMemory = null
  let userProfile = null
  let conversationWindow = []
  let senderMemories = []

  if (senderId) {
    personMemory = getPersonMemory(senderId)
    userProfile = getUserProfile(senderId)
    conversationWindow = getRecentConversation(senderId, 20, 24)
    senderMemories = getMemoriesByEntity(senderId, 10)
  } else if (message && /^TICK\s/i.test(message.trim())) {
    personMemory = getPersonMemory(PRIMARY_USER_ID)
    userProfile = getUserProfile(PRIMARY_USER_ID)
    conversationWindow = getRecentConversationTimeline(40, L2_CONTEXT_HOURS)
    senderMemories = getMemoriesByEntity(PRIMARY_USER_ID, 10)
  }

  // 时间词触发的轮廓注入：除 TICK 心跳外都跑。
  // 用 isTick 而不是 senderId 判断——这样外部渠道未带 [ID:...] 前缀的裸消息也能触发；
  // agent 自言自语不走 runInjector，不必担心循环放大。
  const temporalRecall = isTickMessage ? null : gatherTemporalRecall(messageBody)

  const hintText = hint ? hint.replace(/<think>[\s\S]*?<\/think>/gi, '').slice(0, 800) : ''
  const conversationText = conversationWindow
    .map(item => item.content || '')
    .filter(Boolean)
    .join(' ')
    .slice(0, 4000)

  // messageBody 在送进 FTS5 关键词抽取前，先把"昨天/前天/今天"等时间词剥掉。
  // 否则跨边界 ngram（如"昨天我"）会进入字面搜索，召回所有 content 含"昨天我"的旧记忆，
  // 跟用户真正的"昨天"完全无关。时间窗口召回已经被 gatherTemporalRecall 接管。
  const focusBodyForKeywords = temporalRecall ? stripTemporalWords(messageBody) : messageBody

  const focusText = [
    focusBodyForKeywords,
    hasTask ? state.task : '',
    hintText,
  ].filter(Boolean).join(' ')

  const hasHistory = !!conversationText
  const CONF_MULT = { low: 1.5, medium: 1.0, high: 0.7 }
  const mult = CONF_MULT[confidenceHint] || 1.0
  const scale = (n) => Math.max(1, Math.round(n * mult))

  const baseFocusLimit     = hasHistory ? 15 : (hint ? 12 : 8)
  const baseContextLimit   = hasHistory ? 10 : 0
  const baseFocusKeywords  = hasHistory ? 10 : (hint ? 10 : 8)
  const baseContextKeywords = hasHistory ? 14 : 0

  const focusLimit      = scale(baseFocusLimit)
  const contextLimit    = baseContextLimit === 0 ? 0 : scale(baseContextLimit)   // 0 不放大（hasHistory=false 时 context 路径整体关掉）
  const focusKeywords   = scale(baseFocusKeywords)
  const contextKeywords = baseContextKeywords === 0 ? 0 : scale(baseContextKeywords)
  const relevantMemories = focusText
    ? await searchRelevantMemories({
        focusText,
        contextText: conversationText,
        focusLimit,
        contextLimit,
        focusKeywords,
        contextKeywords,
        perKeyword: 5,
      })
    : []

  const taskKnowledge = hasTask ? getTaskKnowledge(20) : []
  const recallMemories = []
  const directions = []

  if (state?.prev_recall) {
    const query = state.prev_recall
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
  }

  // 召回上限：有对话历史时放宽到 30，否则 12。
  // 不再按"消息是否 trivial"的正则判定收紧——浅层模式不该替模型决定要不要省召回，
  // 复合意图（如"还有多少电？顺便分析下昨天的 bug"）下这种收紧会误杀需要 reasoning 的部分。
  // 该注入的 context 照常注入，由模型自己决定怎么用。
  const mergeCap = hasHistory ? 30 : 12
  const merged = deduplicateMemories([relevantMemories, senderMemories])
  // 「少即是强」：保留 merged 的相关度序，只给高 salience 锚留窄保留道；
  // 不再用 rerankByImportance 按 salience 整体重排（详见 selectContextMemories 注释）。
  const memories = selectContextMemories(merged, { cap: mergeCap, anchorLane: 2 })
  const actionLog = getRecentActionLogs(10)
  const activePolicies = focusText
    ? selectActivePolicies({
        focusText,
        messageBody,
        contextText: conversationText,
        actionLog,
        baseMemories: memories,
      })
    : []

  // —— 按需注入工具（动态上下文记忆池第 4 步）——
  // 之前把 ~35 个工具全量注入，每轮 6-9K token 大头在这。改成按意图分组：
  // tool-router.js 看消息正文 + 上下文标志 + ActionLog 保活 + Fallback 安全网。
  const prefetchedItems = getValidPrefetchCache()

  const uiSignals = getUnconsumedUISignals(60_000)
  const uiSignalSummary = summarizeUISignals(uiSignals)
  if (uiSignals.length) markUISignalsConsumed(uiSignals.map(s => s.id))

  const activeUICards = getActiveUICards()

  const { listCapabilities } = await import('../providers/registry.js')
  const mmCaps = listCapabilities()
  const installedNames = getInstalledToolNames()
  const isTick = !senderId && /^TICK\s/i.test(message?.trim())

  const tools = selectTools({
    messageBody,
    isTick,
    senderId,
    hasTask,
    hasRecall: !!state?.prev_recall,
    mmCaps,
    recentActionLog: actionLog,
    installedToolNames: installedNames,
    startupSelfCheckActive: !!state?.startupSelfCheck?.active,
    // fastUserPath 留作未来扩展——目前从 state 上拿不到，selectTools 接受未传即 false
  })

  // 自我感知层：对当前 user 消息与近期 jarvis 输出做镜像/风格/循环检测。
  // 只在非 TICK、有 senderId 且有对话历史时跑——TICK 心跳本身就不是用户输入，不会触发镜像。
  // 返回 null 时下游 buildContextBlock 不会渲染 <self-perception> 段。
  const selfPerception = (!isTickMessage && senderId && messageBody)
    ? computeSelfPerception({
        conversationWindow,
        currentMsg: { content: messageBody, fromId: senderId },
      })
    : null

  // 自我快照：常驻的"你刚才是怎样的你"。不分 L1/L2 / 不分 TICK，只要有 jarvis 历史就出。
  // 注入器拿 agent_name 用作身份锚的开头（"你是 小白龙。..."）。
  const agentName = getConfig('agent_name') || '小白龙'
  const selfSnapshot = computeSelfSnapshot({ conversationWindow, actionLog, agentName })

  // Memory-Optimization v0.1 Phase 0：记录这一轮召回的"命中了什么/漏了什么"。
  // 写入 best-effort；任何失败都吞掉，绝不影响主流程。
  // chosen_count = 经过 rerank + topK 截断后真正进 prompt 的条数（含 recall hits）；
  // matched_mem_ids 取真正进 prompt 的那批，便于后续核对"prompt 里到底带了哪些记忆"。
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
  } catch {}

  return {
    memories,
    activePolicies,
    recallMemories,
    conversationWindow,
    personMemory,
    userProfile,
    directions,
    constraints,
    thought: null,
    taskKnowledge,
    tools: [...new Set(tools)],
    lastToolResult,
    actionLog,
    prefetchedItems,
    uiSignalSummary,
    activeUICards,
    temporalRecall,
    selfPerception,
    selfSnapshot,
  }
}
