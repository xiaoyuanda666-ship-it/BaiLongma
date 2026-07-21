import { pushMessage } from '../../inbound-message.js'
import { emitEvent } from '../../events.js'
import { getAgentName } from '../agent.js'
import { appendInboundChatMediaMarkdown } from '../inbound-media.js'
import { jsonResponse, readJsonBody } from '../utils.js'

const INBOUND_MESSAGE_DEDUPE_TTL_MS = 10_000
const INBOUND_MESSAGE_FALLBACK_DEDUPE_MS = 1_500
const recentInboundMessages = new Map()

function pruneRecentInboundMessages(now = Date.now()) {
  for (const [key, entry] of recentInboundMessages) {
    if (!entry || now - entry.timestamp > INBOUND_MESSAGE_DEDUPE_TTL_MS) {
      recentInboundMessages.delete(key)
    }
  }
}

function normalizeClientMessageId(value = '') {
  const text = String(value || '').trim()
  return /^[a-zA-Z0-9._:-]{8,128}$/.test(text) ? text : ''
}

function normalizeUiClientId(value = '') {
  const text = String(value || '').trim()
  return /^[a-zA-Z0-9._:-]{8,160}$/.test(text) ? text : ''
}

function claimInboundMessage({ fromId, channel, content, clientMessageId }) {
  const now = Date.now()
  pruneRecentInboundMessages(now)
  const explicitId = normalizeClientMessageId(clientMessageId)
  const key = explicitId
    ? `id:${explicitId}`
    : `body:${JSON.stringify([fromId || '', channel || '', content || ''])}`
  const existing = recentInboundMessages.get(key)
  const ttl = explicitId ? INBOUND_MESSAGE_DEDUPE_TTL_MS : INBOUND_MESSAGE_FALLBACK_DEDUPE_MS
  if (existing && now - existing.timestamp <= ttl) return { claimed: false, key }
  recentInboundMessages.set(key, { timestamp: now })
  return { claimed: true, key }
}

export async function handleMessageRoutes(req, res, url) {
  if (req.method !== 'POST' || url.pathname !== '/message') return false

  let claim = null
  try {
    const body = await readJsonBody(req)
    const { from_id = 'ID:000001', content = '', channel = 'API' } = body
    const trimmed = String(content || '').trim()
    const enhanced = appendInboundChatMediaMarkdown(trimmed, body)
    const queuedContent = enhanced.content
    if (!queuedContent.trim()) {
      jsonResponse(res, 400, { error: 'content or image required' })
      return true
    }
    const clientMessageId = body.client_message_id ?? body.clientMessageId ?? ''
    const clientId = normalizeUiClientId(
      body.client_id
        ?? body.clientId
        ?? req.headers['x-bailongma-client-id']
        ?? '',
    )
    claim = claimInboundMessage({ fromId: from_id, channel, content: queuedContent, clientMessageId })
    if (!claim.claimed) {
      jsonResponse(res, 200, { ok: true, duplicate: true, agent_name: getAgentName() })
      return true
    }
    const strictEvaluation = body.strict_evaluation ?? body.strictEvaluation
      ?? (String(body.evaluation_mode || body.evaluationMode || '').toLowerCase() === 'strict' ? true : undefined)
    const forbiddenTools = body.forbidden_tools ?? body.forbiddenTools
    const meta = {}
    if (strictEvaluation !== undefined) meta.strictEvaluation = strictEvaluation
    if (Array.isArray(forbiddenTools)) meta.forbiddenTools = forbiddenTools
    if (enhanced.media.length) meta.attachments = enhanced.media
    if (clientId) meta.clientId = clientId
    if (clientMessageId) meta.clientMessageId = normalizeClientMessageId(clientMessageId)
    const queued = pushMessage(from_id, queuedContent, channel, meta)
    const conversationId = queued?.conversationId || 0
    if (String(channel || '').toLowerCase() === 'voice' || channel === '语音识别') {
      console.log(
        `[voice-route] inbound client=${clientId || 'missing'}`
        + ` client_message=${normalizeClientMessageId(clientMessageId) || 'missing'}`
        + ` conversation=${conversationId || 0} channel=${channel}`,
      )
    }
    emitEvent('message_in', {
      from_id,
      content: queuedContent,
      channel,
      timestamp: new Date().toISOString(),
      conversation_id: conversationId,
      client_id: clientId,
      client_message_id: normalizeClientMessageId(clientMessageId),
      attachments: enhanced.media,
    })
    jsonResponse(res, 200, {
      ok: true,
      agent_name: getAgentName(),
      conversation_id: conversationId,
      client_id: clientId,
      client_message_id: normalizeClientMessageId(clientMessageId),
      attachments: enhanced.media,
    })
  } catch (e) {
    if (claim?.claimed && claim.key) recentInboundMessages.delete(claim.key)
    jsonResponse(res, 400, { error: e.message })
  }
  return true
}
