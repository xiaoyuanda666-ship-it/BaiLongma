import crypto from 'node:crypto'
import { getDB } from '../db/connection.js'
import { logWarn } from '../runtime/error-logger.js'
import { ensureBuiltinInformationRoutes } from './builtin-routes.js'
import { publishInformationEvent } from './hub.js'

const SHADOW_TRUE_VALUES = new Set(['1', 'true', 'yes', 'on'])
const SYSTEM_CHANNELS = new Set(['APP_SIGNAL', 'REMINDER', 'SYSTEM'])

export function isInformationShadowEnabled(env = process.env) {
  return SHADOW_TRUE_VALUES.has(String(env.BAILONGMA_INFORMATION_SHADOW || '').trim().toLowerCase())
}

export function shadowPublishInformationEvent(input, {
  env = process.env,
  db = null,
} = {}) {
  if (!isInformationShadowEnabled(env)) return { enabled: false, created: false, deliveries: [] }
  try {
    const targetDb = db || getDB()
    ensureBuiltinInformationRoutes({ db: targetDb })
    const result = publishInformationEvent({
      ...input,
      metadata: { ...(input?.metadata || {}), shadow: true },
    }, { db: targetDb })
    return { enabled: true, ...result }
  } catch (error) {
    logWarn(error, {
      scope: 'information.shadow',
      operation: 'publish',
      metadata: {
        topic: input?.topic || '',
        sourceId: input?.source?.id || '',
      },
    })
    return { enabled: true, created: false, deliveries: [], error: error?.message || String(error) }
  }
}

export function shadowPublishInboundEntry(entry = {}, options = {}) {
  const channel = String(entry.channel || '').trim().toUpperCase()
  const fromId = String(entry.fromId || '').trim()
  if (!fromId || fromId.toUpperCase() === 'SYSTEM' || fromId.startsWith('UI:') || SYSTEM_CHANNELS.has(channel)) {
    return { enabled: isInformationShadowEnabled(options.env), skipped: true, created: false, deliveries: [] }
  }

  const isResource = channel === 'RESOURCE' || entry.resourceState === 'pending'
  const topic = isResource ? 'conversation.user_resource' : 'conversation.user_message'
  const conversationId = Number(entry.conversationId) || 0
  const clientMessageId = String(entry.clientMessageId || '').trim()
  const content = String(entry.content || '')
  const contentHash = crypto.createHash('sha256').update(content).digest('hex')
  const dedupeKey = clientMessageId
    ? `client:${clientMessageId}`
    : (conversationId ? `conversation:${conversationId}` : `content:${contentHash}`)

  return shadowPublishInformationEvent({
    topic,
    source: { id: `channel:${channel.toLowerCase() || 'unknown'}`, kind: 'event' },
    subject: {
      userId: fromId,
      channel,
      conversationId: conversationId || undefined,
    },
    authorship: 'user',
    semanticKind: 'user_input',
    payload: {
      channel,
      contentLength: content.length,
      contentHash,
      resourceState: entry.resourceState || '',
    },
    payloadRef: conversationId ? { table: 'conversations', id: conversationId } : {},
    occurredAt: entry.timestamp || new Date(),
    priority: Number(entry.priority) || (isResource ? 50 : 100),
    sensitivity: 'private',
    trust: 'authoritative',
    orderingKey: `conversation:${fromId}:${channel}`,
    dedupeKey,
    correlationId: clientMessageId || (conversationId ? `conversation:${conversationId}` : ''),
    metadata: { legacyQueue: entry.queueName || '' },
  }, options)
}
