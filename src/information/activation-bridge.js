import { getDB } from '../db/connection.js'
import { enqueueMessage } from '../queue.js'
import { logWarn } from '../runtime/error-logger.js'
import { ensureBuiltinInformationRoutes, PRIMARY_INFORMATION_SUBSCRIBER } from './builtin-routes.js'
import { compileInformationContextFrame } from './context-frame.js'
import { loadInformationDeliveryCandidates } from './context-candidates.js'
import { publishInformationEvent } from './hub.js'
import {
  ackInformationDeliveries,
  leaseInformationDeliveries,
  listInformationDeliveries,
  nackInformationDeliveries,
  releaseExpiredInformationLeases,
} from './repositories/deliveries.js'
import { shadowPublishInformationEvent } from './shadow-publisher.js'

const ACTIVATION_DOMAINS = new Set(['ui', 'job', 'schedule'])
const QUEUE_METADATA_FIELDS = Object.freeze([
  'notificationTargetId',
  'notificationChannel',
  'notificationExternalPartyId',
  'notificationVoiceReply',
  'browserDownloadId',
  'browserDownloadState',
  'backgroundJobId',
  'backgroundJobEvent',
  'surface',
  'scheduledEventType',
  'reminderRunId',
  'reminderId',
  'reminderTargetId',
  'reminderTask',
  'reminderDueAt',
  'reminderAttempt',
  'deliveryPolicy',
])

function activationDomains(env = process.env) {
  return new Set(
    String(env.BAILONGMA_INFORMATION_ACTIVATION || '')
      .trim()
      .toLowerCase()
      .split(/[\s,;]+/)
      .filter(Boolean),
  )
}

function safeQueueMetadata(value = {}) {
  const metadata = {}
  for (const key of QUEUE_METADATA_FIELDS) {
    if (value[key] === undefined || value[key] === null || value[key] === '') continue
    metadata[key] = value[key]
  }
  return metadata
}

function activationHint(event = {}) {
  return JSON.stringify({
    topic: event.topic || '',
    subject: event.subject || {},
    payload: event.payload || {},
    occurred_at: event.occurredAt || '',
    source: event.source?.id || '',
  }).slice(0, 8_000)
}

function activationDomainFromEvent(event = {}) {
  return String(event.metadata?.activationDomain || '').trim().toLowerCase()
}

function hasInformationLease(entry = {}) {
  return (entry.informationActivation === true || entry.informationContextAttachment === true)
    && !!entry.informationLeaseId
}

function wakeCandidates(candidates = []) {
  return candidates.filter(candidate => (
    candidate.delivery?.state === 'pending'
    && candidate.route?.activation?.type === 'event'
    && candidate.route?.wake?.policy !== 'never'
  ))
}

function existingWakeState(candidates = []) {
  const relevant = candidates.filter(candidate => (
    candidate.route?.activation?.type === 'event'
    && candidate.route?.wake?.policy !== 'never'
  ))
  if (relevant.some(candidate => candidate.delivery?.state === 'leased')) return 'leased'
  if (relevant.some(candidate => candidate.delivery?.state === 'acked')) return 'acked'
  if (relevant.some(candidate => candidate.delivery?.state === 'dead_letter')) return 'dead_letter'
  return relevant.length > 0 ? 'pending' : 'no_wake_route'
}

function sameActivationScope(triggerEvent = {}, candidateEvent = {}) {
  const triggerDomain = activationDomainFromEvent(triggerEvent)
  if (!triggerDomain || activationDomainFromEvent(candidateEvent) !== triggerDomain) return false
  if (candidateEvent.metadata?.activation !== true) return false
  const triggerUserId = String(triggerEvent.subject?.userId || '').trim()
  const candidateUserId = String(candidateEvent.subject?.userId || '').trim()
  return !triggerUserId || !candidateUserId || triggerUserId === candidateUserId
}

function mergeDeliveryCandidates(...groups) {
  const merged = new Map()
  for (const candidate of groups.flat()) {
    const deliveryId = String(candidate?.delivery?.id || '').trim()
    if (!deliveryId || merged.has(deliveryId)) continue
    merged.set(deliveryId, candidate)
  }
  return [...merged.values()]
}

function loadPendingActivationFrameCandidates(event, { db }) {
  return loadInformationDeliveryCandidates({
    subscriberType: PRIMARY_INFORMATION_SUBSCRIBER.type,
    subscriberId: PRIMARY_INFORMATION_SUBSCRIBER.id,
    state: 'pending',
    limit: 1_000,
  }, { db }).filter(candidate => (
    candidate.route?.activation?.type === 'event'
    && candidate.route?.wake?.policy === 'never'
    && sameActivationScope(event, candidate.event)
  ))
}

function createActivationEntry({ event, lease, candidates, queueMetadata = {} }) {
  const routeByDeliveryId = new Map(candidates.map(candidate => [candidate.delivery.id, candidate.route]))
  const policies = [...new Set(lease.deliveries.map(delivery => (
    routeByDeliveryId.get(delivery.id)?.delivery?.ack || 'after_model_accept'
  )))]
  const hint = activationHint(event)
  const priority = lease.deliveries.reduce((max, delivery) => Math.max(max, Number(delivery.priority) || 0), 0)
  const metadata = safeQueueMetadata(queueMetadata)
  const base = {
    raw: `[SYSTEM] ${event.observedAt || new Date().toISOString()} [INFORMATION] ${hint}`,
    fromId: 'SYSTEM',
    content: hint,
    timestamp: event.observedAt || new Date().toISOString(),
    conversationId: 0,
    channel: 'INFORMATION',
    priority,
    queueName: 'background',
    runtimeLane: 'information',
    informationActivation: true,
    informationActivationDomain: activationDomainFromEvent(event),
    informationEventId: event.id,
    informationLeaseId: lease.leaseId,
    informationDeliveryIds: lease.deliveries.map(delivery => delivery.id),
    informationAckPolicies: policies,
    ...metadata,
  }
  if (activationDomainFromEvent(event) !== 'schedule') return base

  const deliveryAttempt = lease.deliveries.reduce(
    (max, delivery) => Math.max(max, Number(delivery.attempts) || 0),
    0,
  )
  const reminderTask = String(metadata.reminderTask || event.payload?.task || '')
  return {
    ...base,
    raw: `[SYSTEM] ${event.observedAt || new Date().toISOString()} [REMINDER] ${reminderTask}`,
    content: reminderTask,
    channel: 'REMINDER',
    runtimeLane: 'l3',
    scheduledEventType: metadata.scheduledEventType || 'reminder',
    reminderAttempt: Math.max(Number(metadata.reminderAttempt) || 0, deliveryAttempt),
  }
}

function activatePersistedEvent({
  event,
  candidates,
  queueMetadata = {},
  db,
  enqueue,
  now,
}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { handled: false, activated: false, reason: 'no_matching_route', event, entry: null }
  }
  const pending = wakeCandidates(candidates)
  if (pending.length === 0) {
    const reason = existingWakeState(candidates)
    return {
      // A dead delivery no longer has a recoverable new-core path. Let the
      // source use its legacy fallback instead of silently swallowing a retry.
      handled: reason !== 'dead_letter',
      activated: false,
      reason,
      event,
      entry: null,
    }
  }

  // A waking event carries compatible accumulated deliveries into the same
  // immutable frame. In particular, passive UI observations stay wake=never
  // on their own but are consumed with the next active UI intent.
  const triggerDeliveryIds = new Set(pending.map(candidate => candidate.delivery.id))
  const companionCandidates = loadPendingActivationFrameCandidates(event, { db })
    .filter(candidate => !triggerDeliveryIds.has(candidate.delivery.id))
    .slice(0, Math.max(0, 100 - pending.length))
  const frameCandidates = mergeDeliveryCandidates(pending, companionCandidates)

  const lease = leaseInformationDeliveries({
    deliveryIds: frameCandidates.map(candidate => candidate.delivery.id),
    subscriberType: PRIMARY_INFORMATION_SUBSCRIBER.type,
    subscriberId: PRIMARY_INFORMATION_SUBSCRIBER.id,
    limit: frameCandidates.length,
    now,
  }, { db })
  if (lease.deliveries.length === 0) {
    return { handled: true, activated: false, reason: 'lease_race', event, entry: null }
  }

  const leasedIds = new Set(lease.deliveries.map(delivery => delivery.id))
  const leasedCandidates = frameCandidates.filter(candidate => leasedIds.has(candidate.delivery.id))
  const entry = createActivationEntry({ event, lease, candidates: leasedCandidates, queueMetadata })
  try {
    enqueue(entry, 'background')
    return { handled: true, activated: true, reason: 'enqueued', event, lease, entry }
  } catch (error) {
    nackInformationDeliveries({
      leaseId: lease.leaseId,
      deliveryIds: entry.informationDeliveryIds,
      error: `activation enqueue failed: ${error?.message || error}`,
      maxAttempts: 1,
    }, { db })
    throw error
  }
}

export function isInformationActivationEnabled(domain, env = process.env) {
  const normalized = String(domain || '').trim().toLowerCase()
  if (!ACTIVATION_DOMAINS.has(normalized)) return false
  const enabled = activationDomains(env)
  return enabled.has('all') || enabled.has(normalized)
}

export function publishInformationEventForMigration(input, {
  domain,
  queueMetadata = {},
  env = process.env,
  db = null,
  enqueue = enqueueMessage,
  now = null,
} = {}) {
  const normalizedDomain = String(domain || '').trim().toLowerCase()
  if (!isInformationActivationEnabled(normalizedDomain, env)) {
    const shadow = shadowPublishInformationEvent(input, { env, db })
    return { mode: shadow.enabled ? 'shadow' : 'legacy', handled: false, activated: false, ...shadow }
  }

  let event = null
  try {
    const targetDb = db || getDB()
    ensureBuiltinInformationRoutes({ db: targetDb })
    const persisted = publishInformationEvent({
      ...input,
      dedupeKey: input?.dedupeKey
        ? `activation:${normalizedDomain}:${input.dedupeKey}`
        : input?.dedupeKey,
      metadata: {
        ...(input?.metadata || {}),
        activation: true,
        activationDomain: normalizedDomain,
        activationQueue: safeQueueMetadata(queueMetadata),
        ...(input?.dedupeKey ? { originalDedupeKey: String(input.dedupeKey) } : {}),
      },
    }, { db: targetDb })
    event = persisted.event
    const candidates = loadInformationDeliveryCandidates({
      eventId: event.id,
      subscriberType: PRIMARY_INFORMATION_SUBSCRIBER.type,
      subscriberId: PRIMARY_INFORMATION_SUBSCRIBER.id,
    }, { db: targetDb })
    const activation = activatePersistedEvent({
      event,
      candidates,
      queueMetadata,
      db: targetDb,
      enqueue,
      now: now || new Date(),
    })
    return { mode: 'activation', enabled: true, created: persisted.created, ...activation }
  } catch (error) {
    logWarn(error, {
      scope: 'information.activation',
      operation: 'publish_and_enqueue',
      metadata: { domain: normalizedDomain, topic: input?.topic || '', eventId: event?.id || '' },
    })
    return {
      mode: 'activation',
      enabled: true,
      handled: false,
      activated: false,
      event,
      error: error?.message || String(error),
    }
  }
}

export function compileInformationActivationFrame(entry = {}, {
  db = getDB(),
  now = new Date(),
} = {}) {
  if (!entry.informationActivation || !entry.informationEventId) return null
  const deliveryIds = Array.isArray(entry.informationDeliveryIds)
    ? entry.informationDeliveryIds.filter(Boolean)
    : []
  const candidates = loadInformationDeliveryCandidates({
    deliveryIds,
    eventId: deliveryIds.length > 0 ? '' : entry.informationEventId,
    subscriberType: PRIMARY_INFORMATION_SUBSCRIBER.type,
    subscriberId: PRIMARY_INFORMATION_SUBSCRIBER.id,
  }, { db })
  return compileInformationContextFrame({
    candidates,
    triggerEventId: entry.informationEventId,
    now,
  })
}

export function leaseAccumulatedInformationContext({
  env = process.env,
  db = null,
  userId = '',
  domains = [],
  now = new Date(),
  limit = 50,
} = {}) {
  const requestedDomains = new Set(
    (Array.isArray(domains) && domains.length > 0 ? domains : [...ACTIVATION_DOMAINS])
      .map(domain => String(domain || '').trim().toLowerCase())
      .filter(domain => isInformationActivationEnabled(domain, env)),
  )
  if (requestedDomains.size === 0) return null
  const targetDb = db || getDB()
  const normalizedUserId = String(userId || '').trim()
  const safeLimit = Math.max(1, Math.min(100, Math.round(Number(limit) || 50)))
  const candidates = loadInformationDeliveryCandidates({
    subscriberType: PRIMARY_INFORMATION_SUBSCRIBER.type,
    subscriberId: PRIMARY_INFORMATION_SUBSCRIBER.id,
    state: 'pending',
    limit: 1_000,
  }, { db: targetDb }).filter(candidate => {
    const candidateUserId = String(candidate.event?.subject?.userId || '').trim()
    return candidate.event?.metadata?.activation === true
      && requestedDomains.has(activationDomainFromEvent(candidate.event))
      && candidate.route?.activation?.type === 'event'
      && candidate.route?.wake?.policy === 'never'
      && (!normalizedUserId || !candidateUserId || candidateUserId === normalizedUserId)
  }).slice(0, safeLimit)
  if (candidates.length === 0) return null

  const lease = leaseInformationDeliveries({
    deliveryIds: candidates.map(candidate => candidate.delivery.id),
    subscriberType: PRIMARY_INFORMATION_SUBSCRIBER.type,
    subscriberId: PRIMARY_INFORMATION_SUBSCRIBER.id,
    limit: candidates.length,
    now,
  }, { db: targetDb })
  if (lease.deliveries.length === 0) return null
  const leasedCandidates = loadInformationDeliveryCandidates({
    deliveryIds: lease.deliveries.map(delivery => delivery.id),
    subscriberType: PRIMARY_INFORMATION_SUBSCRIBER.type,
    subscriberId: PRIMARY_INFORMATION_SUBSCRIBER.id,
  }, { db: targetDb })
  const entry = {
    informationContextAttachment: true,
    informationLeaseId: lease.leaseId,
    informationDeliveryIds: lease.deliveries.map(delivery => delivery.id),
    informationEventIds: leasedCandidates.map(candidate => candidate.event.id),
  }
  let frame
  try {
    frame = compileInformationContextFrame({ candidates: leasedCandidates, now })
  } catch (error) {
    nackInformationDeliveries({
      leaseId: lease.leaseId,
      deliveryIds: entry.informationDeliveryIds,
      error: `context attachment compilation failed: ${error?.message || error}`,
      retryAt: now,
      maxAttempts: 100,
    }, { db: targetDb })
    throw error
  }
  if (frame.contextItems.length === 0 && !frame.userInputs.current && frame.userInputs.additional.length === 0) {
    ackInformationDeliveries({
      leaseId: lease.leaseId,
      deliveryIds: entry.informationDeliveryIds,
    }, { db: targetDb })
    return null
  }
  return { entry, frame, candidates: leasedCandidates }
}

export function ackInformationLease(entry = {}, { db = getDB() } = {}) {
  if (!hasInformationLease(entry)) return 0
  return ackInformationDeliveries({
    leaseId: entry.informationLeaseId,
    deliveryIds: entry.informationDeliveryIds || [],
  }, { db })
}

export const ackInformationActivation = ackInformationLease

export function deadLetterInformationActivation(entry = {}, error = '', { db = getDB() } = {}) {
  if (!hasInformationLease(entry)) return { pending: 0, deadLetter: 0, total: 0 }
  return nackInformationDeliveries({
    leaseId: entry.informationLeaseId,
    deliveryIds: entry.informationDeliveryIds || [],
    error: error || 'information activation failed',
    maxAttempts: 1,
  }, { db })
}

export function nackInformationLease(entry = {}, error = '', {
  db = getDB(),
  retryAt = new Date(),
  maxAttempts = 5,
} = {}) {
  if (!hasInformationLease(entry)) {
    return { pending: 0, deadLetter: 0, total: 0 }
  }
  return nackInformationDeliveries({
    leaseId: entry.informationLeaseId,
    deliveryIds: entry.informationDeliveryIds || [],
    error: error || 'information activation NACK',
    retryAt,
    maxAttempts,
  }, { db })
}

export const nackInformationActivation = nackInformationLease

export function resumePendingInformationActivations({
  env = process.env,
  db = null,
  enqueue = enqueueMessage,
  now = new Date(),
  limit = 50,
} = {}) {
  if (![...ACTIVATION_DOMAINS].some(domain => isInformationActivationEnabled(domain, env))) return []
  const targetDb = db || getDB()
  releaseExpiredInformationLeases(now instanceof Date ? now.toISOString() : now, { db: targetDb })
  const deliveries = listInformationDeliveries({
    subscriberType: PRIMARY_INFORMATION_SUBSCRIBER.type,
    subscriberId: PRIMARY_INFORMATION_SUBSCRIBER.id,
    state: 'pending',
    limit,
  }, { db: targetDb })
  const candidates = loadInformationDeliveryCandidates({
    deliveryIds: deliveries.map(delivery => delivery.id),
    subscriberType: PRIMARY_INFORMATION_SUBSCRIBER.type,
    subscriberId: PRIMARY_INFORMATION_SUBSCRIBER.id,
    state: 'pending',
    limit,
  }, { db: targetDb })
  const byEvent = new Map()
  for (const candidate of candidates) {
    const domain = activationDomainFromEvent(candidate.event)
    if (!isInformationActivationEnabled(domain, env)) continue
    if (!byEvent.has(candidate.event.id)) byEvent.set(candidate.event.id, [])
    byEvent.get(candidate.event.id).push(candidate)
  }

  const results = []
  for (const eventCandidates of byEvent.values()) {
    const event = eventCandidates[0].event
    try {
      results.push(activatePersistedEvent({
        event,
        candidates: eventCandidates,
        queueMetadata: event.metadata?.activationQueue || {},
        db: targetDb,
        enqueue,
        now,
      }))
    } catch (error) {
      logWarn(error, {
        scope: 'information.activation',
        operation: 'resume_pending',
        metadata: { eventId: event.id, domain: activationDomainFromEvent(event) },
      })
    }
  }
  return results
}

export function getNextInformationActivation({
  env = process.env,
  db = null,
} = {}) {
  if (![...ACTIVATION_DOMAINS].some(domain => isInformationActivationEnabled(domain, env))) return null
  const targetDb = db || getDB()
  const candidates = [
    ...loadInformationDeliveryCandidates({
      subscriberType: PRIMARY_INFORMATION_SUBSCRIBER.type,
      subscriberId: PRIMARY_INFORMATION_SUBSCRIBER.id,
      state: 'pending',
      limit: 1_000,
    }, { db: targetDb }),
    ...loadInformationDeliveryCandidates({
      subscriberType: PRIMARY_INFORMATION_SUBSCRIBER.type,
      subscriberId: PRIMARY_INFORMATION_SUBSCRIBER.id,
      state: 'leased',
      limit: 1_000,
    }, { db: targetDb }),
  ].filter(candidate => (
    candidate.event?.metadata?.activation === true
    && candidate.route?.activation?.type === 'event'
    && candidate.route?.wake?.policy !== 'never'
    && isInformationActivationEnabled(activationDomainFromEvent(candidate.event), env)
  ))

  const due = candidates
    .map(candidate => ({
      candidate,
      dueAt: candidate.delivery.state === 'leased'
        ? candidate.delivery.leaseExpiresAt
        : candidate.delivery.availableAt,
    }))
    .filter(item => Number.isFinite(Date.parse(item.dueAt || '')))
    .sort((left, right) => Date.parse(left.dueAt) - Date.parse(right.dueAt))[0]
  if (!due) return null
  return {
    dueAt: due.dueAt,
    eventId: due.candidate.event.id,
    domain: activationDomainFromEvent(due.candidate.event),
    state: due.candidate.delivery.state,
  }
}
