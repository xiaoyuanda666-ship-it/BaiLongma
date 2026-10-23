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

// Compatibility boundary for push-style input. Conversation persistence stays
// authoritative and happens before this function. Information activation is
// now the default; explicit legacy mode falls back to the exact old queue entry.
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
  if (result.handled) {
    // A deduped, passive, or already-leased event may be handled without a new
    // queue entry. It has no current model turn to close this trace later.
    if (!result.entry) {
      entry.performanceTrace?.mark('ingress.activation_deferred')
      entry.performanceTrace?.finish({ status: 'staged' })
    }
    return result.entry || entry
  }
  return enqueueLegacyEntry(entry, { enqueue, db })
}

export function publishInboundResourceForMigration(entry = {}, {
  env = process.env,
  db = null,
} = {}) {
  const input = buildInboundInformationEvent(entry)
  if (input?.topic !== 'conversation.user_resource' || !entry.conversationId) {
    return { handled: false, activated: false, skipped: true }
  }
  return publishInformationEventForMigration(input, {
    domain: 'user',
    queueMetadata: entry,
    env,
    db,
    enqueue: () => {
      throw new Error('a staged user resource must never wake the Agent by itself')
    },
  })
}
