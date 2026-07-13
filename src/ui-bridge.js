import { insertActionLog, insertConversation } from './db.js'
import { emitEvent, emitUICommand, addActiveUICard, hasACUIClient } from './events.js'
import { dispatchSocialMessage } from './social/dispatch.js'
import { getForegroundThread, ensureThreadState } from './memory/threads.js'
import { detectOpenFollowupQuestion, autoSpeakForVoiceReply } from './capabilities/executor.js'
import { nowTimestamp } from './time.js'

export function deriveStackView(state) {
  const ts = ensureThreadState(state)
  const background = ts.threads
    .filter(t => t.id !== ts.foregroundId)
    .sort((a, b) => Date.parse(a.lastEventAt || 0) - Date.parse(b.lastEventAt || 0))
  const fg = getForegroundThread(state)
  return fg ? [...background, fg] : background
}

export function summarizeToolCall(t = {}) {
  const args = t.args || {}
  const status = t.ok === false ? ' failed' : ''
  if (t.name === 'send_message') return `send_message -> ${args.target_id || args.to || 'unknown'}${status}`
  if (t.name === 'fetch_url') return `fetch_url(${String(args.url || '').slice(0, 60)})${status}`
  if (t.name === 'write_file') return `write_file(${args.path || args.filename || args.file_path || '?'})${status}`
  if (t.name === 'read_file') {
    const pathArg = args.path || args.filename || args.file_path || '?'
    const rangeParts = []
    if (args.start_line !== undefined) rangeParts.push(`start=${args.start_line}`)
    if (args.end_line !== undefined) rangeParts.push(`end=${args.end_line}`)
    if (args.max_lines !== undefined) rangeParts.push(`max=${args.max_lines}`)
    const range = rangeParts.length ? ` ${rangeParts.join(' ')}` : ''
    return `read_file(${pathArg}${range})${status}`
  }
  if (t.name === 'exec_command') return `exec_command(${String(args.command || '').slice(0, 80)})${status}`
  if (t.name === 'install_software') return `install_software(${String(args.software || args.brew_name || args.url || '').slice(0, 80)})${status}`
  return `${t.name || 'tool'}${status}`
}

export function isVoiceChannel(channel) {
  return channel === 'voice' || channel === '语音识别' || channel === 'FocusBanner'
}

export function deliverFallbackReply(msg, content, timestamp = nowTimestamp()) {
  const channel = msg.channel || ''
  const externalPartyId = msg.externalPartyId || ''
  emitEvent('message', {
    from: 'consciousness',
    to: msg.fromId,
    content,
    timestamp,
    channel,
    external_party_id: externalPartyId,
  })
  if (externalPartyId) {
    dispatchSocialMessage(externalPartyId, content).catch(err => console.warn('[social] fallback send failed:', err.message))
  }
  insertConversation({
    role: 'jarvis',
    from_id: 'jarvis',
    to_id: msg.fromId,
    content,
    timestamp,
    channel,
    external_party_id: externalPartyId,
    open_question: detectOpenFollowupQuestion(content) ? 1 : 0,
  })
  try {
    insertActionLog({
      timestamp,
      tool: 'send_message',
      summary: `send_message -> ${msg.fromId} (fallback)`,
      detail: String(content).slice(0, 280),
      status: 'ok',
      risk: 'medium',
      args: { target_id: msg.fromId, content, channel },
      resultPreview: `消息已发送至 ${msg.fromId}${channel ? `（${channel}）` : ''} [fallback]`,
      durationMs: 0,
      source: 'fallback',
    })
  } catch (e) {
    console.warn('[fallback] insertActionLog failed:', e?.message || e)
  }
}

export function deliverDirectReply(msg, content, finishTurn) {
  const timestamp = nowTimestamp()
  if (isVoiceChannel(msg?.channel)) autoSpeakForVoiceReply(content)
  deliverFallbackReply(msg, content, timestamp)
  finishTurn?.(content)
}

export function formatQuickWeatherReply(cardProps) {
  if (!cardProps) return ''
  const city = cardProps.city || '当地'
  const temp = Number.isFinite(cardProps.temp) ? `${Math.round(cardProps.temp)}度` : ''
  const feel = Number.isFinite(cardProps.feel) ? `体感${Math.round(cardProps.feel)}` : ''
  const condition = cardProps.condition || cardProps.desc || ''
  const parts = [temp, feel, condition].filter(Boolean)
  return parts.length ? `${city}现在${parts.join('，')}。` : ''
}

export function mountWeatherCard(cardProps) {
  if (!cardProps || !hasACUIClient()) return null
  const id = `weathercard-${Date.now()}`
  emitUICommand({
    op: 'mount',
    id,
    component: 'WeatherCard',
    props: cardProps,
    hint: { placement: 'notification', enter: 'flash-in', exit: 'flash-out' },
  })
  addActiveUICard(id, { component: 'WeatherCard' })
  return id
}
