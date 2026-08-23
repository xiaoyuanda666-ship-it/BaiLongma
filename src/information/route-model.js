import crypto from 'node:crypto'
import { isInformationSemanticKind } from './envelope.js'

const SUBSCRIBER_TYPES = new Set(['agent', 'user', 'service'])
const ACTIVATION_TYPES = new Set(['event', 'turn_start', 'interval', 'manual'])
const SAMPLING_STRATEGIES = new Set(['all', 'latest', 'window', 'query', 'delta'])
const WAKE_POLICIES = new Set(['always', 'if_idle', 'never'])
const DELIVERY_POLICIES = new Set(['immediate_turn', 'next_turn', 'accumulate'])
const ACK_POLICIES = new Set(['after_model_accept', 'after_turn', 'manual'])
const TOPIC_PATTERN_RE = /^[a-z][a-z0-9_-]*(?:\.(?:[a-z0-9_-]+|\*|\*\*))*$/

function text(value, maxChars = 500) {
  return String(value ?? '').trim().slice(0, maxChars)
}

function object(value, label) {
  if (value == null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    throw new Error(`${label} must be JSON serializable`)
  }
}

function oneOf(value, allowed, fallback, label) {
  const normalized = text(value || fallback, 80).toLowerCase()
  if (!allowed.has(normalized)) throw new Error(`${label} must be one of: ${[...allowed].join(', ')}`)
  return normalized
}

function normalizeTopicPattern(value) {
  const pattern = text(value, 160).toLowerCase()
  if (!pattern || !TOPIC_PATTERN_RE.test(pattern)) {
    throw new Error('topicPattern must be a dot-separated topic with optional * or ** segments')
  }
  const segments = pattern.split('.')
  const deepWildcard = segments.indexOf('**')
  if (deepWildcard >= 0 && deepWildcard !== segments.length - 1) {
    throw new Error('** is supported only as the final topic segment')
  }
  return pattern
}

export function createInformationRoute(input = {}) {
  const id = text(input.id || `route_${crypto.randomUUID()}`, 128)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9:._-]{7,127}$/.test(id)) {
    throw new Error('information route id must be 8-128 safe identifier characters')
  }
  const subscriber = object(input.subscriber, 'subscriber')
  const subscriberType = oneOf(subscriber.type, SUBSCRIBER_TYPES, 'agent', 'subscriber.type')
  const subscriberId = text(subscriber.id, 160)
  if (!subscriberId) throw new Error('subscriber.id is required')

  const activationInput = object(input.activation, 'activation')
  const samplingInput = object(input.sampling, 'sampling')
  const wakeInput = object(input.wake, 'wake')
  const deliveryInput = object(input.delivery, 'delivery')
  const contextInput = object(input.context, 'context')
  const activationType = oneOf(activationInput.type, ACTIVATION_TYPES, 'event', 'activation.type')

  const intervalNumber = Number(activationInput.intervalMs)
  const intervalMs = activationType === 'interval'
    ? Math.max(60_000, Math.min(365 * 24 * 60 * 60 * 1000, Math.round(intervalNumber)))
    : null
  if (activationType === 'interval' && (!Number.isFinite(intervalNumber) || intervalNumber <= 0)) {
    throw new Error('interval activation requires a positive intervalMs')
  }

  const wakePriority = Number(wakeInput.priority)
  const maxChars = Number(contextInput.maxChars)
  const rank = Number(contextInput.rank)
  const semanticKind = text(contextInput.semanticKind || 'runtime_event', 80).toLowerCase()
  if (!isInformationSemanticKind(semanticKind)) throw new Error('context.semanticKind is invalid')

  return Object.freeze({
    id,
    subscriber: Object.freeze({ type: subscriberType, id: subscriberId }),
    topicPattern: normalizeTopicPattern(input.topicPattern),
    scope: Object.freeze(object(input.scope, 'scope')),
    filter: Object.freeze(object(input.filter, 'filter')),
    activation: Object.freeze({
      ...activationInput,
      type: activationType,
      intervalMs,
    }),
    sampling: Object.freeze({
      ...samplingInput,
      strategy: oneOf(samplingInput.strategy, SAMPLING_STRATEGIES, 'all', 'sampling.strategy'),
    }),
    wake: Object.freeze({
      ...wakeInput,
      policy: oneOf(wakeInput.policy, WAKE_POLICIES, 'never', 'wake.policy'),
      priority: Number.isFinite(wakePriority) ? Math.max(0, Math.min(100, Math.round(wakePriority))) : 50,
    }),
    delivery: Object.freeze({
      ...deliveryInput,
      policy: oneOf(deliveryInput.policy, DELIVERY_POLICIES, 'next_turn', 'delivery.policy'),
      ack: oneOf(deliveryInput.ack, ACK_POLICIES, 'after_model_accept', 'delivery.ack'),
    }),
    context: Object.freeze({
      ...contextInput,
      semanticKind,
      maxChars: Number.isFinite(maxChars) ? Math.max(128, Math.min(100_000, Math.round(maxChars))) : 4_000,
      rank: Number.isFinite(rank) ? Math.max(0, Math.min(100, Math.round(rank))) : 50,
    }),
    enabled: input.enabled !== false,
    createdBy: Object.freeze(object(input.createdBy, 'createdBy')),
    reason: text(input.reason, 500),
  })
}
