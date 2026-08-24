import { enqueueMessage, removeSupersededUserMessages } from '../queue.js'
import {
  publishInformationEventForMigration,
  supersedeInformationActivation,
} from './activation-bridge.js'
import {
  buildInboundInformationEvent,
  shadowPublishInboundEntry,
} from './shadow-publisher.js'

function isPersistedUserMessage(entry = {}, input = null) {
  return input?.topic === 'conversation.user_message'
    && entry.queueName === 'user'
    && Number(entry.conversationId) > 0
    && String(entry.content || '').trim().length > 0
}

function enqueueLegacyEntry(entry, { enqueue, db }) {
  return enqueue(entry, entry.queueName, {
    onSuperseded: superseded => supersedeInformationActivation(
      superseded,
      db ? { db, retryAt: new Date() } : { retryAt: new Date() },
    ),
  })
}

// Compatibility boundary for the final push-style input migration. Conversation
// persistence remains authoritative and happens before this function. With the
// user flag off, this publishes only the existing optional shadow event and
// enqueues the exact legacy entry. Persist-only RESOURCE rows never call here.
export function enqueueInboundMessageForMigration(entry = {}, {
  env = process.env,
  db = null,
  enqueue = enqueueMessage,
} = {}) {
  const input = buildInboundInformationEvent(entry)
  if (entry.queueName === 'user' && enqueue === enqueueMessage) {
    // Release passive companions before publishing the replacement so the new
    // user event can lease them into its own immutable ContextFrame. The old
    // trigger itself is ACKed because its persisted conversation row remains
    // visible as history, matching the legacy supersession behavior.
    removeSupersededUserMessages(entry, {
      onSuperseded: superseded => supersedeInformationActivation(
        superseded,
        db ? { db, retryAt: new Date() } : { retryAt: new Date() },
      ),
    })
  }
  if (!isPersistedUserMessage(entry, input)) {
    const shadow = shadowPublishInboundEntry(entry, { env, db })
    if (shadow.event?.id) entry.informationEventId = shadow.event.id
    return enqueueLegacyEntry(entry, { enqueue, db })
  }

  const result = publishInformationEventForMigration(input, {
    domain: 'user',
    queueMetadata: entry,
    env,
    db,
    enqueue,
  })
  if (result.event?.id) entry.informationEventId = result.event.id
  if (result.handled) return result.entry || entry
  return enqueueLegacyEntry(entry, { enqueue, db })
}
