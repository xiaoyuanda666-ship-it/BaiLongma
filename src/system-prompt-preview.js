import { buildSystemPrompt } from './prompt.js'
import { runInjector, formatMemoriesForPrompt, formatTaskKnowledge } from './memory/injector.js'
import { gatherContext, formatExtraContext } from './context/gatherer.js'
import { getConfig, getKnownEntities, getOrInitBirthTime } from './db.js'
import { formatTick, describeExistence } from './time.js'

function cloneStateSnapshot(stateSnapshot = {}) {
  return {
    action: stateSnapshot.action || null,
    task: stateSnapshot.task || null,
    prev_recall: stateSnapshot.prev_recall || null,
    lastToolResult: stateSnapshot.lastToolResult || null,
    sessionCounter: stateSnapshot.sessionCounter || 0,
    recentActions: Array.isArray(stateSnapshot.recentActions) ? [...stateSnapshot.recentActions] : [],
    thoughtStack: Array.isArray(stateSnapshot.thoughtStack) ? [...stateSnapshot.thoughtStack] : [],
  }
}

export async function buildHeartbeatSystemPromptPreview({
  stateSnapshot = {},
  message = formatTick(),
} = {}) {
  const workingState = cloneStateSnapshot(stateSnapshot)
  const injection = await runInjector({ message, state: workingState })
  const directions = [...(injection.directions || [])]
  const memoriesText = formatMemoriesForPrompt(injection.memories, injection.recallMemories)
  const directionsText = directions.join('\n')
  const taskKnowledgeText = formatTaskKnowledge(injection.taskKnowledge)

  let extraContextText = ''
  if (workingState.task) {
    const extraContext = await gatherContext({
      task: workingState.task,
      taskKnowledge: taskKnowledgeText,
      memories: memoriesText,
      message,
    })
    extraContextText = formatExtraContext(extraContext)
  }

  const persona = getConfig('persona') || ''
  const agentName = getConfig('agent_name') || 'Longma'
  const entities = getKnownEntities()
  const birthTime = getOrInitBirthTime()

  const systemPrompt = buildSystemPrompt({
    agentName,
    persona,
    memories: memoriesText,
    directions: directionsText,
    constraints: injection.constraints || [],
    conversationWindow: injection.conversationWindow || [],
    personMemory: injection.personMemory || null,
    thoughtStack: workingState.thoughtStack || [],
    entities,
    recentActions: workingState.recentActions || [],
    actionLog: injection.actionLog || [],
    hasActiveTask: !!workingState.task,
    task: workingState.task || null,
    taskKnowledge: taskKnowledgeText,
    extraContext: extraContextText,
    lastToolResult: injection.lastToolResult || null,
    existenceDesc: describeExistence(birthTime),
  })

  return {
    message,
    systemPrompt,
    injection: {
      directions,
      tools: injection.tools || [],
      constraints: injection.constraints || [],
      conversationWindow: injection.conversationWindow || [],
      personMemory: injection.personMemory || null,
      actionLog: injection.actionLog || [],
      lastToolResult: injection.lastToolResult || null,
      memories: injection.memories || [],
      recallMemories: injection.recallMemories || [],
      taskKnowledge: injection.taskKnowledge || [],
    },
    stateSnapshot: workingState,
    derived: {
      memoriesText,
      directionsText,
      taskKnowledgeText,
      extraContextText,
    },
  }
}
