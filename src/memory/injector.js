// Injector facade / orchestrator
//
// 对外继续保留历史 import 路径和扁平返回结构；内部按职责拆成三个注入器：
//   - Memory Injector：记忆、人物、画像、策略和自我历史
//   - Tool Injector：工具选择、ActionLog 和上一轮工具结果
//   - Information Injector：约束、预取数据和 UI/运行环境信息

import { extractKeywords } from './keywords.js'
import { parseMessageInput } from './injector/message-input.js'
import { runMemoryInjector } from '../injectors/memory-injector.js'
import { runToolInjector } from '../injectors/tool-injector.js'
import { runInformationInjector } from '../injectors/information-injector.js'

// —— 对外门面：保持 injector.js 作为统一入口，原有 import 路径不变 ——
export { extractKeywords }
export { selectContextMemories } from './injector-retrieval.js'
export { searchAdditionalMemories } from './injector-retrieval.js'
export {
  formatTemporalRecall,
  formatMemoriesForPrompt,
  formatPrefetchedItems,
  formatSceneManifest,
  formatAIVideoPanel,
  formatTaskKnowledge,
} from './injector-format.js'
export { formatActivePoliciesForPrompt } from './active-policies.js'
export { runMemoryInjector } from '../injectors/memory-injector.js'
export { runToolInjector, finalizeToolInjection } from '../injectors/tool-injector.js'
export {
  runInformationInjector,
  runRuntimeInformationInjector,
  commitInformationConsumption,
  buildSupplementalInformationContext,
} from '../injectors/information-injector.js'

export function mergeInjectorResults({ memory = {}, tool = {}, information = {} } = {}) {
  return {
    categories: { memory, tool, information },
    memories: memory.memories || [],
    activePolicies: memory.activePolicies || [],
    recallMemories: memory.recallMemories || [],
    conversationWindow: memory.conversationWindow || [],
    personMemory: memory.personMemory || null,
    userProfile: memory.userProfile || null,
    taskKnowledge: memory.taskKnowledge || [],
    temporalRecall: memory.temporalRecall || null,
    selfPerception: memory.selfPerception || null,
    selfSnapshot: memory.selfSnapshot || null,
    selfEvolution: memory.selfEvolution || '',
    tools: tool.tools || [],
    lastToolResult: tool.lastToolResult || null,
    actionLog: tool.actionLog || [],
    toolCallLimit: Number.isInteger(tool.toolCallLimit) ? tool.toolCallLimit : 0,
    constraints: information.constraints || [],
    prefetchedItems: information.prefetchedItems || [],
    uiSignalSummary: information.uiSignalSummary || '',
    uiSignalIds: information.uiSignalIds || [],
    directions: [
      ...(memory.directions || []),
      ...(tool.directions || []),
      ...(information.directions || []),
    ],
    // 历史字段，保留兼容。
    thought: null,
  }
}

export async function runInjector({ message, state, hint = '', currentChannel = '' }) {
  const parsed = parseMessageInput(String(message || ''))

  // 工具连续性会参与策略记忆与自我快照计算，所以工具注入器先产出 actionLog；
  // 之后记忆注入和轻量信息注入可以并行。
  const tool = await runToolInjector({
    messageBody: parsed.messageBody,
    isTickMessage: parsed.isTick,
    senderId: parsed.senderId,
    state,
    currentChannel,
  })
  const [memory, information] = await Promise.all([
    runMemoryInjector({
      messageBody: parsed.messageBody,
      isTickMessage: parsed.isTick,
      senderId: parsed.senderId,
      state,
      hint,
      actionLog: tool.actionLog,
    }),
    runInformationInjector(),
  ])

  return mergeInjectorResults({ memory, tool, information })
}
