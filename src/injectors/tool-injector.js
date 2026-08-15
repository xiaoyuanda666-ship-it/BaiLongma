// Tool Injector
//
// 只负责“这一轮能用什么工具，以及上一次工具执行到了哪里”：按意图选择工具、
// 注入最近 ActionLog、消费上一轮工具结果，并生成与工具工作流直接相关的方向提示。

import { getRecentActionLogs } from '../db.js'
import { isExternalChannel, isVoiceChannel } from '../identity.js'
import { getContextWindowConfig } from '../config.js'
import { getInstalledToolNames } from '../capabilities/marketplace/index.js'
import { selectTools } from '../memory/tool-router.js'
import { formatToolPromptHintsForSchemas } from '../memory/active-policies.js'
import { getToolSchemas } from '../capabilities/schemas.js'
import { filterStrictEvaluationTools } from '../runtime/strict-evaluation.js'
import {
  filterSendMessageForLocalReply,
  turnNeedsExternalSendMessage,
} from '../runtime/local-reply-tools.js'

const API_KEY_RE = /\b(?:sk|ak|rk|pk|ark)-[A-Za-z0-9_\-.]{12,180}\b/i
const API_DOCS_RE = /https?:\/\/|api|docs?|platform|capability|endpoint|base[-_\s]?url|model|auth|\u6587\u6863|\u63a5\u53e3|\u914d\u7f6e|\u80fd\u529b/i
const API_CONFIG_CONFIRM_RE = /^(?:yes|yep|ok|okay|sure|do it|go ahead|\u662f|\u662f\u7684|\u53ef\u4ee5|\u597d|\u597d\u7684|\u5bf9|\u884c|\u914d\u7f6e|\u914d\u4e0a|\u8bbe\u7f6e|\u8bbe\u6210)$/i

export async function selectInjectorTools({
  messageBody = '',
  isTick = false,
  senderId = null,
  hasTask = false,
  hasRecall = false,
  actionLog = [],
  startupSelfCheckActive = false,
  isVoiceTurn = false,
  localVisualTurn = true,
} = {}) {
  const { listCapabilities } = await import('../providers/registry.js')
  return selectTools({
    messageBody,
    isTick,
    senderId,
    hasTask,
    hasRecall,
    mmCaps: listCapabilities(),
    recentActionLog: actionLog,
    installedToolNames: getInstalledToolNames(),
    startupSelfCheckActive,
    isVoiceTurn,
    localVisualTurn,
  })
}

function hasRecentApiCapabilitySetupNeed(actionLog = []) {
  if (!Array.isArray(actionLog)) return false
  return actionLog.some(entry => {
    const tool = String(entry?.tool || '')
    if (tool !== 'analyze_image' && tool !== 'manage_api_capability') return false
    const text = `${entry?.status || ''} ${entry?.error || ''} ${entry?.result_preview || ''} ${entry?.args_json || ''}`
    return /not_configured|slot_not_found|credential_not_configured|api_key required|configure|capability/i.test(text)
  })
}

function consumeLastToolResult(state, toolCallLimit) {
  const lastToolResult = toolCallLimit > 0 ? (state?.lastToolResult || null) : null
  if (state && Object.prototype.hasOwnProperty.call(state, 'lastToolResult')) {
    state.lastToolResult = null
  }
  return lastToolResult
}

export async function runToolInjector({
  messageBody = '',
  isTickMessage = false,
  senderId = null,
  state = null,
  currentChannel = '',
} = {}) {
  const contextWindow = getContextWindowConfig()
  const lastToolResult = consumeLastToolResult(state, contextWindow.toolCallLimit)
  const actionLog = contextWindow.toolCallLimit > 0
    ? getRecentActionLogs(contextWindow.toolCallLimit)
    : []
  const directions = []

  if (API_KEY_RE.test(messageBody) && API_DOCS_RE.test(messageBody)) {
    directions.push('The current user message includes API documentation/config context plus an API key. Treat it as intent to configure an API-backed capability. Prefer manage_api_capability(action="configure" or action="save_doc") in this turn; for OpenAI-compatible vision APIs, do not build an ad-hoc tool or run raw scripts.')
  } else if (API_CONFIG_CONFIRM_RE.test(messageBody.trim().toLowerCase()) && hasRecentApiCapabilitySetupNeed(actionLog)) {
    directions.push('The user is confirming your immediately previous offer to configure an API capability after a not_configured or missing-credential result. Call manage_api_capability to configure the capability slot using the provider/docs/model/key already in recent context; do not switch to tool factory or an ad-hoc script.')
  }

  const tools = await selectInjectorTools({
    messageBody,
    isTick: isTickMessage,
    senderId,
    hasTask: !!state?.task,
    hasRecall: !!state?.prev_recall,
    actionLog,
    startupSelfCheckActive: !!state?.startupSelfCheck?.active,
    isVoiceTurn: isVoiceChannel(currentChannel),
    localVisualTurn: !currentChannel || !isExternalChannel(currentChannel),
  })

  return {
    tools: [...new Set(tools)],
    directions,
    lastToolResult,
    actionLog,
    toolCallLimit: contextWindow.toolCallLimit,
  }
}

// 把初选工具收敛成“模型这一轮真正可见的工具”。所有后置规则（send_message、
// 本地回复、语音、严格评估、Action Contract、schema 可用性）统一在这里完成，
// 避免调用方把工具注入器的初选结果误当成最终 inventory。
export function finalizeToolInjection({
  initialTools = [],
  silentSignal = false,
  strictEvaluation = null,
  localReply = false,
  input = '',
  voiceTurn = false,
  actionContract = null,
  activePolicies = [],
} = {}) {
  let turnTools = Array.isArray(initialTools) ? initialTools.filter(Boolean) : []
  if (silentSignal) {
    turnTools = []
  } else if (!turnTools.includes('send_message')) {
    turnTools = ['send_message', ...turnTools]
  }
  turnTools = filterStrictEvaluationTools(turnTools, strictEvaluation)
  turnTools = filterSendMessageForLocalReply(turnTools, { localReply, silentSignal, input })

  if (voiceTurn && !silentSignal && !turnNeedsExternalSendMessage(input)) {
    turnTools = turnTools.filter(name => name !== 'send_message')
  }
  if (localReply && turnTools.includes('capability_demo')) {
    turnTools = turnTools.filter(name => name !== 'send_message')
  }

  const requiredTools = actionContract?.requiredTools || []
  for (const name of requiredTools) {
    if (name && !turnTools.includes(name)) turnTools.push(name)
  }
  // Screenshot capture cannot be delivered through local plain text. Keep the
  // real media-bearing send tool visible even on TUI/voice turns so the model
  // can complete the capture-and-delivery contract itself.
  if (actionContract?.id === 'browser_screenshot' && !silentSignal && !turnTools.includes('send_message')) {
    turnTools.push('send_message')
  }
  // High-confidence, standalone browser commands use a deliberately narrow
  // inventory. This removes find_tool and unrelated fallback surfaces after
  // the runtime has already resolved the exact current-page action.
  if (actionContract?.restrictTools === true) {
    const allowed = new Set([...requiredTools, 'send_message'])
    turnTools = turnTools.filter(name => allowed.has(name))
  }
  const resolvedActionContract = requiredTools.length > 0
    ? { ...actionContract, requiredTools: [...requiredTools] }
    : null

  const toolPromptHints = formatToolPromptHintsForSchemas(activePolicies, turnTools)
  const modelToolNames = getToolSchemas(turnTools, { toolPromptHints })
    .map(schema => schema?.function?.name)
    .filter(Boolean)
  const modelToolSet = new Set(modelToolNames)

  return {
    turnTools,
    toolPromptHints,
    modelToolNames,
    unavailableTools: turnTools.filter(name => !modelToolSet.has(name)),
    actionContract: resolvedActionContract,
    capabilityDemoTurn: localReply && turnTools.includes('capability_demo'),
  }
}
