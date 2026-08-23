import crypto from 'node:crypto'

export const INFORMATION_SOURCE_KINDS = Object.freeze(['event', 'snapshot', 'query'])
export const INFORMATION_AUTHORSHIP = Object.freeze(['user', 'agent', 'system', 'external'])
export const INFORMATION_SEMANTIC_KINDS = Object.freeze([
  'user_input',
  'system_fact',
  'memory',
  'knowledge',
  'policy',
  'task_state',
  'ui_signal',
  'runtime_event',
])
export const INFORMATION_SENSITIVITY = Object.freeze(['public', 'normal', 'private', 'restricted'])
export const INFORMATION_TRUST = Object.freeze(['authoritative', 'verified', 'observed', 'untrusted'])

const SOURCE_KINDS = new Set(INFORMATION_SOURCE_KINDS)
const AUTHORSHIP = new Set(INFORMATION_AUTHORSHIP)
const SEMANTIC_KINDS = new Set(INFORMATION_SEMANTIC_KINDS)
const SENSITIVITY = new Set(INFORMATION_SENSITIVITY)
const TRUST = new Set(INFORMATION_TRUST)
const TOPIC_RE = /^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)*$/
const SOURCE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,159}$/

function boundedString(value, maxChars = 500, fallback = '') {
  const text = String(value ?? fallback).trim()
  return text.slice(0, maxChars)
}

function requiredString(value, label, maxChars) {
  const text = boundedString(value, maxChars)
  if (!text) throw new Error(`${label} is required`)
  return text
}

function enumValue(value, allowed, fallback, label) {
  const normalized = boundedString(value || fallback, 80).toLowerCase()
  if (!allowed.has(normalized)) {
    throw new Error(`${label} must be one of: ${[...allowed].join(', ')}`)
  }
  return normalized
}

function jsonObject(value, label) {
  if (value == null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    throw new Error(`${label} must be JSON serializable`)
  }
}

function isoTimestamp(value, fallback, label) {
  const raw = value == null || value === '' ? fallback : value
  const date = raw instanceof Date ? raw : new Date(raw)
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} must be a valid timestamp`)
  return date.toISOString()
}

export function normalizeInformationTopic(value) {
  const topic = requiredString(value, 'topic', 160).toLowerCase()
  if (!TOPIC_RE.test(topic)) {
    throw new Error('topic must be dot-separated lowercase identifiers')
  }
  return topic
}

export function isInformationSemanticKind(value) {
  return SEMANTIC_KINDS.has(String(value || '').trim().toLowerCase())
}

export function createInformationItem(input = {}, {
  id = '',
  now = new Date(),
} = {}) {
  const observedAt = isoTimestamp(input.observedAt, now, 'observedAt')
  const source = jsonObject(input.source, 'source')
  const sourceId = requiredString(source.id, 'source.id', 160)
  if (!SOURCE_ID_RE.test(sourceId)) {
    throw new Error('source.id contains unsupported characters')
  }

  const eventId = boundedString(id || input.id || `info_${crypto.randomUUID()}`, 128)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9:._-]{7,127}$/.test(eventId)) {
    throw new Error('information item id must be 8-128 safe identifier characters')
  }

  const expiresAt = input.expiresAt == null || input.expiresAt === ''
    ? null
    : isoTimestamp(input.expiresAt, null, 'expiresAt')

  const priorityNumber = Number(input.priority)
  const priority = Number.isFinite(priorityNumber)
    ? Math.max(0, Math.min(100, Math.round(priorityNumber)))
    : 50

  return Object.freeze({
    id: eventId,
    topic: normalizeInformationTopic(input.topic),
    schemaVersion: Math.max(1, Math.min(1_000, Math.round(Number(input.schemaVersion) || 1))),
    source: Object.freeze({
      ...source,
      id: sourceId,
      kind: enumValue(source.kind, SOURCE_KINDS, 'event', 'source.kind'),
    }),
    subject: Object.freeze(jsonObject(input.subject, 'subject')),
    authorship: enumValue(input.authorship, AUTHORSHIP, 'system', 'authorship'),
    semanticKind: enumValue(input.semanticKind, SEMANTIC_KINDS, 'runtime_event', 'semanticKind'),
    payload: Object.freeze(jsonObject(input.payload, 'payload')),
    payloadRef: Object.freeze(jsonObject(input.payloadRef, 'payloadRef')),
    occurredAt: isoTimestamp(input.occurredAt, observedAt, 'occurredAt'),
    observedAt,
    expiresAt,
    priority,
    sensitivity: enumValue(input.sensitivity, SENSITIVITY, 'normal', 'sensitivity'),
    trust: enumValue(input.trust, TRUST, 'observed', 'trust'),
    orderingKey: boundedString(input.orderingKey, 240),
    dedupeKey: boundedString(input.dedupeKey, 240),
    correlationId: boundedString(input.correlationId, 160),
    causationId: boundedString(input.causationId, 160),
    traceId: boundedString(input.traceId, 160),
    metadata: Object.freeze(jsonObject(input.metadata, 'metadata')),
  })
}
