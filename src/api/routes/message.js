import { persistInboundMessage, pushMessage } from '../../inbound-message.js'
import { getPendingConversationResources, markConversationResourcesConsumed } from '../../db.js'
import { emitEvent } from '../../events.js'
import { getAgentName } from '../agent.js'
import { appendInboundChatMediaMarkdown } from '../inbound-media.js'
import {
  buildChatResourceDisplayContent,
  CHAT_RESOURCE_CHANNEL,
  MAX_CHAT_RESOURCE_TOTAL_BYTES,
  persistDroppedChatResources,
} from '../../chat-resources.js'
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
  if (req.method !== 'POST') return false

  if (url.pathname === '/message/resources') {
    let resourceClaim = null
    try {
      // Base64 adds roughly one third; leave room for JSON fields while retaining a
      // strict total decoded-resource limit in persistDroppedChatResources.
      const body = await readJsonBody(req, { maxBytes: Math.ceil(MAX_CHAT_RESOURCE_TOTAL_BYTES * 1.45) })
      const fromId = body.from_id || body.fromId || 'ID:000001'
      const clientMessageId = body.client_message_id ?? body.clientMessageId ?? ''
      const clientId = normalizeUiClientId(
        body.client_id
          ?? body.clientId
          ?? req.headers['x-bailongma-client-id']
          ?? '',
      )
      const resources = persistDroppedChatResources(body.resources)
      const content = buildChatResourceDisplayContent(resources)
      resourceClaim = claimInboundMessage({
        fromId,
        channel: CHAT_RESOURCE_CHANNEL,
        content,
        clientMessageId,
      })
      if (!resourceClaim.claimed) {
        jsonResponse(res, 200, { ok: true, duplicate: true, agent_name: getAgentName() })
        return true
      }

      const staged = persistInboundMessage(fromId, content, CHAT_RESOURCE_CHANNEL, {
        clientId,
        clientMessageId: normalizeClientMessageId(clientMessageId),
        resourceState: 'pending',
        resourceMetadata: resources,
      })
      emitEvent('message_in', {
        from_id: staged.fromId,
        content,
        channel: CHAT_RESOURCE_CHANNEL,
        timestamp: staged.timestamp,
        conversation_id: staged.conversationId,
        client_id: clientId,
        client_message_id: normalizeClientMessageId(clientMessageId),
        resource_state: 'pending',
        resources,
      })
      jsonResponse(res, 200, {
        ok: true,
        agent_name: getAgentName(),
        conversation_id: staged.conversationId,
        client_id: clientId,
        client_message_id: normalizeClientMessageId(clientMessageId),
        resource_state: 'pending',
        content,
        resources,
      })
    } catch (error) {
      if (resourceClaim?.claimed && resourceClaim.key) recentInboundMessages.delete(resourceClaim.key)
      jsonResponse(res, error?.statusCode || 400, { error: error?.message || 'failed to stage resources' })
    }
    return true
  }

  if (url.pathname !== '/message') return false

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
    // 资源消息本身从不入队。只有这条真实文字/语音消息到达时才消费它们，
    // 并把权威资源行附在 queue entry 上，保证本轮工具选择和提示能拿到路径。
    const pendingResources = getPendingConversationResources(from_id)
    if (pendingResources.length) meta.pendingResources = pendingResources
    const queued = pushMessage(from_id, queuedContent, channel, meta)
    if (pendingResources.length) {
      markConversationResourcesConsumed(pendingResources.map(row => row.id))
      emitEvent('resources_consumed', {
        conversation_ids: pendingResources.map(row => row.id),
        instruction_conversation_id: queued?.conversationId || 0,
        client_id: clientId,
      })
    }
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
