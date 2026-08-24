import { nowTimestamp } from './time.js'
import { normalizeConversationPartyId, upsertEntity, insertConversation } from './db.js'
import { resolveCanonicalUserId } from './identity.js'
import { enqueueMessage } from './queue.js'
import { shadowPublishInboundEntry } from './information/shadow-publisher.js'
import {
  enqueueInboundMessageForMigration,
  publishInboundResourceForMigration,
} from './information/user-message-activation.js'

const PRIORITY = {
  user: 100,
  background: 50,
}

function resolvePriority(fromId, channel, meta = {}) {
  if (typeof meta.priority === 'number') return meta.priority
  if (meta.queue === 'background') return PRIORITY.background
  if (channel === 'REMINDER' || channel === 'SYSTEM' || normalizeConversationPartyId(fromId) === 'SYSTEM') {
    return PRIORITY.background
  }
  return PRIORITY.user
}

function resolveQueueName(priority, meta = {}) {
  if (meta.queue === 'background') return 'background'
  return priority >= PRIORITY.user ? 'user' : 'background'
}

// 只持久化到聊天历史，不进入 Agent 队列。资源拖入使用这个边界：历史记录
// 立即出现，但只有后续文字/语音消息调用 pushMessage 才会启动一个 turn。
function persistInboundEntry(rawFromId, content, channel = 'TUI', meta = {}, { publishShadow = true } = {}) {
  const normalizedRaw = normalizeConversationPartyId(rawFromId)
  const canonicalId = resolveCanonicalUserId({ rawFromId: normalizedRaw, channel })
  const externalPartyId = canonicalId !== normalizedRaw ? normalizedRaw : ''
  const timestamp = nowTimestamp()
  const priority = resolvePriority(canonicalId, channel, meta)
  const queueName = resolveQueueName(priority, meta)
  upsertEntity(canonicalId)

  // Persist on arrival so interrupted turns still keep the user message in
  // conversation history for the next context window.
  const conversationId = meta.persist !== false ? insertConversation({
    role: 'user',
    from_id: canonicalId,
    to_id: 'jarvis',
    content,
    timestamp,
    channel: channel || '',
    external_party_id: externalPartyId,
    focus_topic: '',
    thread_id: '',
    resource_state: meta.resourceState || meta.resource_state || '',
    resource_metadata: meta.resourceMetadata || meta.resource_metadata || '',
  }) : 0

  const entry = {
    raw: `[${canonicalId}${externalPartyId ? ` via ${externalPartyId}` : ''}] ${timestamp} [${channel}] ${content}`,
    fromId: canonicalId,
    externalPartyId,
    content,
    timestamp,
    conversationId,
    channel,
    priority,
    queueName,
    ...meta,
  }

  // Persist-only resources enter Information Core as wake=never deliveries.
  // Other persist-only rows retain the optional shadow behavior; queued user
  // messages are published exactly once by enqueueInboundMessageForMigration.
  if (publishShadow) {
    const information = (channel === 'RESOURCE' || entry.resourceState === 'pending')
      ? publishInboundResourceForMigration(entry)
      : shadowPublishInboundEntry(entry)
    if (information.event?.id) entry.informationEventId = information.event.id
  }

  return entry
}

export function persistInboundMessage(rawFromId, content, channel = 'TUI', meta = {}) {
  return persistInboundEntry(rawFromId, content, channel, meta)
}

export function pushMessage(rawFromId, content, channel = 'TUI', meta = {}) {
  // The migration adapter owns the single information publication for queued
  // messages, avoiding a shadow + activation double write when user mode is on.
  const entry = persistInboundEntry(rawFromId, content, channel, meta, { publishShadow: false })
  return enqueueInboundMessageForMigration(entry, { enqueue: enqueueMessage })
}
