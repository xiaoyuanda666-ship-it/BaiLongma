import { buildSystemPrompt, buildContextBlock, combinePromptForPreview } from './prompt.js'
import { runInjector, formatMemoriesForPrompt, formatActivePoliciesForPrompt, formatTaskKnowledge, formatTemporalRecall } from './memory/injector.js'
import { runRuntimeInjector } from './context/runtime-injector.js'
import { getConfig, getKnownEntities, getOrInitBirthTime } from './db.js'
import { getSecurity } from './config.js'
import { formatTick, describeExistence, nowTimestamp } from './time.js'
import { formatTerminalStreamContext } from './terminal-stream.js'
import { buildAutonomousTickDirections } from './runtime/tick-policy.js'

function cloneStateSnapshot(stateSnapshot = {}) {
  return {
    action: stateSnapshot.action || null,
    task: stateSnapshot.task || null,
    prev_recall: stateSnapshot.prev_recall || null,
    lastToolResult: stateSnapshot.lastToolResult || null,
    sessionCounter: stateSnapshot.sessionCounter || 0,
    recentActions: Array.isArray(stateSnapshot.recentActions) ? [...stateSnapshot.recentActions] : [],
    thoughtStack: Array.isArray(stateSnapshot.thoughtStack) ? [...stateSnapshot.thoughtStack] : [],
    startupSelfCheck: stateSnapshot.startupSelfCheck ? { ...stateSnapshot.startupSelfCheck } : null,
  }
}

export async function buildHeartbeatSystemPromptPreview({
  stateSnapshot = {},
  message = formatTick(),
} = {}) {
  const workingState = cloneStateSnapshot(stateSnapshot)
  const injection = await runInjector({ message, state: workingState })
  const directions = [...(injection.directions || [])]
  const awakeningRaw = getConfig('awakening_ticks_remaining')
  const awakeningTicks = awakeningRaw === null || awakeningRaw === undefined || awakeningRaw === ''
    ? 10
    : Math.max(0, parseInt(awakeningRaw, 10) || 0)
  directions.unshift(buildAutonomousTickDirections({
    startupSelfCheckActive: !!workingState.startupSelfCheck?.active,
    awakeningTicks,
  }))
  const memoriesText = formatMemoriesForPrompt(injection.memories, injection.recallMemories)
  const activePoliciesText = formatActivePoliciesForPrompt(injection.activePolicies)
  const directionsText = directions.join('\n')
  const taskKnowledgeText = formatTaskKnowledge(injection.taskKnowledge)
  const temporalRecallText = formatTemporalRecall(injection.temporalRecall)

  const runtimeInjection = await runRuntimeInjector({
    message,
    task: workingState.task,
    taskKnowledge: taskKnowledgeText,
    memories: memoriesText,
  })

  const persona = getConfig('persona') || ''
  const agentName = getConfig('agent_name') || '小白龙'
  const entities = getKnownEntities()
  const birthTime = getOrInitBirthTime()
  const terminalStreamContext = formatTerminalStreamContext()
  const extraContext = [runtimeInjection.contextText, terminalStreamContext].filter(Boolean).join('\n\n')

  const systemPromptStable = buildSystemPrompt({
    agentName,
    persona,
    birthTime,
    hasActiveTask: !!workingState.task,
    currentTaskText: workingState.task || '',
    recentActionsSummary: (workingState.recentActions || []).map(a => a?.summary || '').join(' | '),
    currentTools: injection.tools || [],
    isTick: true,
  })

  const contextBlock = buildContextBlock({
    memories: memoriesText,
    activePolicies: activePoliciesText,
    temporalRecall: temporalRecallText,
    directions: directionsText,
    constraints: injection.constraints || [],
    personMemory: injection.personMemory || null,
    userProfile: injection.userProfile || null,
    thoughtStack: workingState.thoughtStack || [],
    entities,
    hasActiveTask: !!workingState.task,
    task: workingState.task || null,
    taskKnowledge: taskKnowledgeText,
    extraContext,
    awakeningTicks,
    // Runtime info 也注入预览，让 UI 看到完整 context
    currentTime: nowTimestamp(),
    existenceDesc: describeExistence(birthTime),
    security: getSecurity(),
    selfSnapshot: injection.selfSnapshot || null,
    selfEvolution: injection.selfEvolution || '',
  })

  // For the preview UI (systemPrompt.html), surface a combined view so the
  // existing renderer keeps working — and also expose the split parts for
  // tools that want to inspect the new architecture directly.
  const combined = combinePromptForPreview(systemPromptStable, contextBlock)

  return {
    message,
    systemPrompt: combined,
    system: systemPromptStable,
    contextBlock,
    injection: {
      directions,
      tools: injection.tools || [],
      constraints: injection.constraints || [],
      conversationWindow: injection.conversationWindow || [],
      personMemory: injection.personMemory || null,
      userProfile: injection.userProfile || null,
      actionLog: injection.actionLog || [],
      lastToolResult: injection.lastToolResult || null,
      memories: injection.memories || [],
      activePolicies: injection.activePolicies || [],
      recallMemories: injection.recallMemories || [],
      taskKnowledge: injection.taskKnowledge || [],
      selfEvolution: injection.selfEvolution || '',
    },
    stateSnapshot: workingState,
    derived: {
      memoriesText,
      activePoliciesText,
      temporalRecallText,
      directionsText,
      taskKnowledgeText,
      extraContextText: runtimeInjection.taskExtraContextText,
      keywordContextText: runtimeInjection.keywordContextText,
      runtimeContextText: runtimeInjection.contextText,
      terminalStreamContextText: terminalStreamContext,
    },
  }
}
