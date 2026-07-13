import { stripTemporalWords } from '../temporal-parser.js'

// 消息格式解析
// 格式：[ID:xxxxxx] 2026-04-13 10:00:00 [渠道] 内容
// 或：  TICK 2026-04-13-10:00:00
export function parseMessageInput(message) {
  if (/^TICK\s/i.test(message.trim())) {
    return { isTick: true, senderId: null, messageBody: '' }
  }
  const match = message.match(/^\[([^\]]+)\]\s*[\d\-T:+]+\s*\[[^\]]*\]\s*(.*)$/s)
  return {
    isTick: false,
    senderId: match ? match[1] : null,
    messageBody: match ? match[2].trim() : message,
  }
}

export function consumeInjectorStateHints(state) {
  const lastToolResult = state?.lastToolResult || null
  if (lastToolResult) state.lastToolResult = null

  const confidenceHint = state?.pendingConfidenceHint || null
  if (state && 'pendingConfidenceHint' in state) state.pendingConfidenceHint = null  // 消费即焚

  return {
    lastToolResult,
    confidenceHint,
    hasTask: !!state?.task,
    hasRecall: !!state?.prev_recall,
  }
}

export function stripThinkHint(hint = '') {
  return hint ? hint.replace(/<think>[\s\S]*?<\/think>/gi, '').slice(0, 800) : ''
}

export function buildMemoryFocusInput({
  messageBody = '',
  temporalRecall = null,
  task = '',
  hasTask = false,
  hintText = '',
  conversationWindow = [],
} = {}) {
  const conversationText = conversationWindow
    .map(item => item.content || '')
    .filter(Boolean)
    .join(' ')
    .slice(0, 4000)

  // messageBody 在送进 FTS5 关键词抽取前，先把"昨天/前天/今天"等时间词剥掉。
  // 时间窗口召回已经由 gatherTemporalRecall 接管。
  const focusBodyForKeywords = temporalRecall ? stripTemporalWords(messageBody) : messageBody
  const focusText = [
    focusBodyForKeywords,
    hasTask ? task : '',
    hintText,
  ].filter(Boolean).join(' ')

  return {
    conversationText,
    focusBodyForKeywords,
    focusText,
    hasHistory: !!conversationText,
  }
}
