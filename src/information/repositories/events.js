import { getDB } from '../../db/connection.js'
import { createInformationItem } from '../envelope.js'

function parseObject(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function mapEventRow(row) {
  if (!row) return null
  return {
    id: row.id,
    topic: row.topic,
    schemaVersion: row.schema_version,
    source: { id: row.source_id, kind: row.source_kind },
    subject: parseObject(row.subject_json),
    authorship: row.authorship,
    semanticKind: row.semantic_kind,
    payload: parseObject(row.payload_json),
    payloadRef: parseObject(row.payload_ref_json),
    occurredAt: row.occurred_at,
    observedAt: row.observed_at,
    expiresAt: row.expires_at || null,
    priority: row.priority,
    sensitivity: row.sensitivity,
    trust: row.trust,
    orderingKey: row.ordering_key || '',
    dedupeKey: row.dedupe_key || '',
    correlationId: row.correlation_id || '',
    causationId: row.causation_id || '',
    traceId: row.trace_id || '',
    metadata: parseObject(row.metadata_json),
    createdAt: row.created_at,
  }
}

export function getInformationEvent(id, { db = getDB() } = {}) {
  return mapEventRow(db.prepare(`SELECT * FROM information_events WHERE id = ?`).get(String(id || '')))
}

export function insertInformationEvent(input, { db = getDB() } = {}) {
  const item = createInformationItem(input)
  const result = db.prepare(`
    INSERT OR IGNORE INTO information_events (
      id, topic, schema_version, source_id, source_kind, subject_json,
      authorship, semantic_kind, payload_json, payload_ref_json,
      occurred_at, observed_at, expires_at, priority, sensitivity, trust,
      ordering_key, dedupe_key, correlation_id, causation_id, trace_id, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.id,
    item.topic,
    item.schemaVersion,
    item.source.id,
    item.source.kind,
    JSON.stringify(item.subject),
    item.authorship,
    item.semanticKind,
    JSON.stringify(item.payload),
    JSON.stringify(item.payloadRef),
    item.occurredAt,
    item.observedAt,
    item.expiresAt,
    item.priority,
    item.sensitivity,
    item.trust,
    item.orderingKey,
    item.dedupeKey,
    item.correlationId,
    item.causationId,
    item.traceId,
    JSON.stringify(item.metadata),
  )

  if (result.changes > 0) return { created: true, event: getInformationEvent(item.id, { db }) }

  const existing = item.dedupeKey
    ? mapEventRow(db.prepare(`
        SELECT * FROM information_events WHERE source_id = ? AND dedupe_key = ?
      `).get(item.source.id, item.dedupeKey))
    : getInformationEvent(item.id, { db })
  if (!existing) throw new Error('information event insert was ignored without an existing row')
  return { created: false, event: existing }
}

export function listInformationEvents({
  topic = '',
  sourceId = '',
  includeExpired = false,
  limit = 100,
} = {}, { db = getDB() } = {}) {
  const clauses = []
  const args = []
  if (topic) {
    clauses.push('topic = ?')
    args.push(String(topic))
  }
  if (sourceId) {
    clauses.push('source_id = ?')
    args.push(String(sourceId))
  }
  if (!includeExpired) {
    clauses.push(`(expires_at IS NULL OR expires_at > ?)`)
    args.push(new Date().toISOString())
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const safeLimit = Math.max(1, Math.min(1_000, Math.round(Number(limit) || 100)))
  return db.prepare(`
    SELECT * FROM information_events ${where}
    ORDER BY occurred_at DESC, created_at DESC
    LIMIT ?
  `).all(...args, safeLimit).map(mapEventRow)
}

export function deleteExpiredInformationEvents(now = new Date().toISOString(), { db = getDB() } = {}) {
  const cleanup = db.transaction(() => {
    const deliveries = db.prepare(`
      DELETE FROM information_deliveries
      WHERE state IN ('acked', 'dead_letter')
        AND event_id IN (
          SELECT id FROM information_events
          WHERE expires_at IS NOT NULL AND expires_at <= ?
        )
    `).run(now).changes
    const events = db.prepare(`
      DELETE FROM information_events
      WHERE expires_at IS NOT NULL AND expires_at <= ?
        AND id NOT IN (SELECT event_id FROM information_deliveries)
    `).run(now).changes
    return { events, deliveries }
  })
  return cleanup()
}
