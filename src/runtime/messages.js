import { normalizeChannel, isSystemSignalRow } from './channel.js'

function xmlAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function isCurrentMessageRow(row, currentMsg = null) {
  return !!currentMsg
    && row?.role === 'user'
    && row.from_id === currentMsg.fromId
    && row.timestamp === currentMsg.timestamp
    && row.content === currentMsg.content
}

function formatConversationMetadata({ conversationWindow = [], msg = null, expiredSet = new Set() } = {}) {
  const rows = (Array.isArray(conversationWindow) ? conversationWindow : []).filter(row => row?.content)
  if (rows.length === 0) return ''

  const currentRowIndex = rows.findIndex(row => isCurrentMessageRow(row, msg))
  let lastAssistantBeforeCurrent = -1
  if (currentRowIndex >= 0) {
    for (let i = currentRowIndex - 1; i >= 0; i--) {
      if (rows[i]?.role === 'jarvis') {
        lastAssistantBeforeCurrent = i
        break
      }
    }
  }

  const turns = []
  let prevChannel = ''
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const isSystemRow = isSystemSignalRow(row)
    const normalizedChannel = normalizeChannel(row.channel || '')
    const role = row.role === 'jarvis'
      ? 'assistant'
      : (isSystemRow ? 'system_signal' : 'user')
    const attrs = [
      `n="${i + 1}"`,
      `role="${role}"`,
    ]

    if (isCurrentMessageRow(row, msg)) attrs.push('current="true"')
    if (i === lastAssistantBeforeCurrent) attrs.push('salience="last_assistant_reply"')
    if (row.from_id) attrs.push(`from="${xmlAttr(row.from_id)}"`)
    if (row.to_id) attrs.push(`to="${xmlAttr(row.to_id)}"`)
    if (row.timestamp) attrs.push(`at="${xmlAttr(row.timestamp)}"`)
    if (normalizedChannel) attrs.push(`channel="${xmlAttr(normalizedChannel)}"`)
    if (!isSystemRow && prevChannel && normalizedChannel && prevChannel !== normalizedChannel) {
      attrs.push(`channel_switched_from="${xmlAttr(prevChannel)}"`)
    }
    if (row.focus_topic) attrs.push(`topic="${xmlAttr(row.focus_topic)}"`)
    if (row.open_question && expiredSet.has(row.id ?? -999)) attrs.push('expired_open_question="true"')

    turns.push(`  <turn ${attrs.join(' ')} />`)
    if (!isSystemRow && normalizedChannel) prevChannel = normalizedChannel
  }

  return `<conversation_metadata>
Use this block only for speaker attribution, time, channel, topic, and current-turn grounding. Do not quote, imitate, or expose these metadata tags in replies.
If a turn has salience="last_assistant_reply", the current user message most likely responds to that assistant output; ideas in that turn were said by you, not by the user.
If a turn has expired_open_question="true", that old assistant question is closed; do not answer it retroactively.
${turns.join('\n')}
</conversation_metadata>`
}

export function formatConversationMessage(row, currentMsg = null, prevChannel = '', currentTopic = '', expiredQuestion = false, prevTopic = '') {
  if (row.role === 'jarvis') {
    return {
      role: 'assistant',
      content: row.content || '',
    }
  }

  // Truncate timestamp to minute precision (drop seconds and timezone)
  const ts = row.timestamp ? row.timestamp.slice(0, 16).replace('T', ' ') : ''
  const rawChannel = row.channel || currentMsg?.channel || ''

  // 保留 currentMsg 回退语义：row.channel 为空时回退到 currentMsg?.channel（同 rawChannel）。
  const isSystemSignal = isSystemSignalRow(row, currentMsg?.channel)

  if (isSystemSignal) {
    const channelLabel = rawChannel ? ` · ${rawChannel}` : ''
    return {
      role: 'user',
      content: `[system signal · ${ts}${channelLabel}]\n${row.content || ''}\n(Respond with tools only. Do NOT call send_message.)`.trim(),
    }
  }

  return {
    role: 'user',
    content: row.content || '',
  }
}

export function formatTaskSteps(taskSteps = []) {
  if (!taskSteps?.length) return ''
  const statusIcon = { done: '✓', failed: '✗', skipped: '—', pending: '○' }
  const lines = taskSteps.map((s, i) => {
    const icon = statusIcon[s.status] || '○'
    const note = s.note ? ` (${s.note})` : ''
    return `  ${i + 1}. [${icon}] ${s.text}${note}`
  })
  const done = taskSteps.filter(s => s.status === 'done').length
  const total = taskSteps.length
  return `Task step progress (${done}/${total}):\n${lines.join('\n')}`
}

function buildTickSystemPrompt(systemPrompt, input) {
  return `[heartbeat tick - no new user message]
This is an internal L2 heartbeat tick, not a user turn. No user is speaking right now. Read the runtime context and conversation history normally; decide whether there is a real reason to act proactively, or stay silent.
Tick payload: ${input}

${systemPrompt}`
}

function buildIntentCheckContext() {
  return 'In <think>: (1) resolve every pronoun/ellipsis in the current user message ("继续/那个/这个呢/再来一个/换一个") against your last reply and the exchange just above, before reaching for older context; (2) list EVERY distinct request this one message carries — finish all of them this turn, not just the first; (3) name the WANT under the words — the outcome that ends their need — and answer that, not the literal grammar (a question is usually "do it"; a complaint is "fix it"; terse/urgent typing means lead with the result, no preamble).'
}

function hasPriorAssistantReply(rows, currentRowIndex) {
  if (currentRowIndex < 0) return false
  for (let i = currentRowIndex - 1; i >= 0; i--) {
    if (rows[i]?.role === 'jarvis') return true
  }
  return false
}

export function buildRuntimeContextMessages({ contextBlock = '', recentActions = [], actionLog = [], lastToolResult = null, taskSteps = [], batteryBlock = '', conversationMetadata = '', intentCheck = '', role = 'user' } = {}) {
  const parts = []

  if (contextBlock) {
    parts.push(contextBlock)
  }

  if (batteryBlock) {
    parts.push(batteryBlock)
  }

  if (taskSteps?.length > 0) {
    parts.push(formatTaskSteps(taskSteps))
  }

  if (recentActions?.length > 0) {
    const lines = recentActions.map(item => `- ${item.ts?.slice(11, 16) || ''} ${item.summary || ''}`).join('\n')
    parts.push(`Recent assistant actions:\n${lines}\nAvoid immediately repeating the same action unless the current user message asks for it.`)
  }

  if (actionLog?.length > 0) {
    const lines = actionLog.slice(-10).map(item => {
      const time = item.timestamp?.slice(11, 16) || ''
      const detail = item.detail ? `\n  ${item.detail}` : ''
      return `- ${time} ${item.tool || ''} · ${item.summary || ''}${detail}`
    }).join('\n')
    parts.push(`Recent tool/action log:\n${lines}\nUse this as runtime context only. Do not repeat completed actions unless the current task requires it.`)
  }

  if (lastToolResult) {
    const argsSummary = Object.entries(lastToolResult.args || {})
      .map(([key, value]) => `${key}=${String(value).slice(0, 60)}`)
      .join(', ')
    const resultPreview = String(lastToolResult.result || '').slice(0, 500)
    parts.push(`Previous tool result:\n${lastToolResult.name}(${argsSummary}) ->\n${resultPreview}\nAbsorb this result before deciding the next step.`)
  }

  if (conversationMetadata) {
    parts.push(conversationMetadata)
  }

  if (intentCheck) {
    parts.push(`Current-turn intent check:\n${intentCheck}`)
  }

  if (parts.length === 0) return []
  return [{
    role,
    content: `[runtime context]\n${parts.join('\n\n')}`,
  }]
}

// P0-2：判断 conversationWindow 里某条 open_question 是否已"过期"。
//   过期条件：
//     1. 距今超过 N 条非 SYSTEM 消息且用户从未直接接茬这条问题
//   Topic tags are deliberately not used as a hard expiry signal. They are
//   heuristic bookkeeping and can be wrong on short/elliptical voice turns.
//   "直接接茬"的简化判定：紧跟这条 jarvis 行之后的下一条 user 消息长度 >= 6 字
//   且至少含 1 个中英文实词字符；极短回应（嗯/好/可以）不算接茬。
const EXPIRED_FOLLOWUP_DISTANCE = 4
function computeExpiredFollowupSet(rows, currentTopic) {
  const expired = new Set()
  if (!Array.isArray(rows)) return expired
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!row || row.role !== 'jarvis' || !row.open_question) continue
    // 1. 看紧跟的下一条 user 消息
    let nextUser = null
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[j]?.role === 'user' && (rows[j].from_id || '') !== 'SYSTEM') {
        nextUser = rows[j]; break
      }
    }
    const engaged = nextUser
      && typeof nextUser.content === 'string'
      && nextUser.content.replace(/\s+/g, '').length >= 6
    if (engaged) continue
    // 2. 距今 >= N 条对话
    const distance = rows.length - 1 - i
    const farEnough = distance >= EXPIRED_FOLLOWUP_DISTANCE
    if (farEnough) expired.add(row.id ?? i)
  }
  return expired
}

export function buildLLMMessages({ systemPrompt, contextBlock = '', conversationWindow = [], input, msg = null, recentActions = [], actionLog = [], lastToolResult = null, taskSteps = [], batteryBlock = '', currentTopic = '', isTick = false }) {
  const messages = [{
    role: 'system',
    content: isTick ? buildTickSystemPrompt(systemPrompt, input) : systemPrompt,
  }]

  const rows = Array.isArray(conversationWindow) ? conversationWindow : []

  // P0-2：先扫一遍找出所有"过期未答悬念"
  const expiredSet = computeExpiredFollowupSet(rows, currentTopic)
  const conversationMetadata = formatConversationMetadata({ conversationWindow: rows, msg, expiredSet })
  const currentRowIndex = rows.findIndex(row => isCurrentMessageRow(row, msg))
  const intentCheck = (!isTick && hasPriorAssistantReply(rows, currentRowIndex))
    ? buildIntentCheckContext()
    : ''
  messages.push(...buildRuntimeContextMessages({
    contextBlock,
    recentActions,
    actionLog,
    lastToolResult,
    taskSteps,
    batteryBlock,
    conversationMetadata,
    intentCheck,
    role: isTick ? 'system' : 'user',
  }))

  // Track the last user-role message representing the current turn. The message
  // content stays clean: round-local context lives in the [runtime context]
  // message above, before conversation history.
  let currentMessageIndex = -1

  for (const row of rows) {
    if (!row?.content) continue
    const isCurrent = isCurrentMessageRow(row, msg)
    const formatted = formatConversationMessage(row, msg)
    if (!formatted.content) continue
    messages.push(formatted)
    if (isCurrent) currentMessageIndex = messages.length - 1
  }

  const hasCurrentMessage = currentMessageIndex >= 0

  if (!hasCurrentMessage && !isTick) {
    // Non-tick callers without a current conversation row still need a clean user turn.
    // Tick turns carry their signal in the leading system prompt instead, so there is
    // deliberately no synthetic current user message for L2 heartbeats.
    messages.push({
      role: 'user',
      content: msg?.content || input,
    })
    currentMessageIndex = messages.length - 1
  }

  return messages
}
