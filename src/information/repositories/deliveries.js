import crypto from 'node:crypto'
import { getDB } from '../../db/connection.js'

function mapDeliveryRow(row) {
  if (!row) return null
  return {
    id: row.id,
    eventId: row.event_id,
    routeId: row.route_id,
    subscriber: { type: row.subscriber_type, id: row.subscriber_id },
    state: row.state,
    priority: row.priority,
    availableAt: row.available_at,
    leaseId: row.lease_id || null,
    leaseExpiresAt: row.lease_expires_at || null,
    attempts: row.attempts,
    lastError: row.last_error || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ackedAt: row.acked_at || null,
  }
}

function boundedIso(value, fallback = new Date()) {
  const date = value instanceof Date ? value : new Date(value || fallback)
  if (!Number.isFinite(date.getTime())) throw new Error('invalid delivery timestamp')
  return date.toISOString()
}

function idFilter(ids = []) {
  const unique = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))]
  return {
    unique,
    sql: unique.length ? ` AND id IN (${unique.map(() => '?').join(',')})` : '',
  }
}

export function getInformationDelivery(id, { db = getDB() } = {}) {
  return mapDeliveryRow(db.prepare(`SELECT * FROM information_deliveries WHERE id = ?`).get(String(id || '')))
}

export function createInformationDelivery({ event, route, availableAt = null } = {}, { db = getDB() } = {}) {
  if (!event?.id) throw new Error('delivery event is required')
  if (!route?.id || !route?.subscriber?.id) throw new Error('delivery route is required')
  const id = `delivery_${crypto.randomUUID()}`
  const priority = Math.max(
    0,
    Math.min(100, Math.round(Math.max(Number(event.priority) || 0, Number(route.wake?.priority) || 0))),
  )
  const result = db.prepare(`
    INSERT OR IGNORE INTO information_deliveries (
      id, event_id, route_id, subscriber_type, subscriber_id,
      state, priority, available_at, attempts, last_error
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, 0, '')
  `).run(
    id,
    event.id,
    route.id,
    route.subscriber.type,
    route.subscriber.id,
    priority,
    boundedIso(availableAt),
  )
  const row = result.changes > 0
    ? db.prepare(`SELECT * FROM information_deliveries WHERE id = ?`).get(id)
    : db.prepare(`
        SELECT * FROM information_deliveries
        WHERE event_id = ? AND route_id = ? AND subscriber_type = ? AND subscriber_id = ?
      `).get(event.id, route.id, route.subscriber.type, route.subscriber.id)
  return { created: result.changes > 0, delivery: mapDeliveryRow(row) }
}

export function releaseExpiredInformationLeases(now = new Date().toISOString(), { db = getDB() } = {}) {
  return db.prepare(`
    UPDATE information_deliveries
    SET state = 'pending', lease_id = NULL, lease_expires_at = NULL,
        available_at = ?, updated_at = datetime('now'),
        last_error = CASE WHEN last_error = '' THEN 'lease expired' ELSE last_error END
    WHERE state = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
  `).run(now, now).changes
}

export function listInformationDeliveries({
  deliveryIds = [],
  eventId = '',
  routeId = '',
  subscriberType = '',
  subscriberId = '',
  state = '',
  limit = 100,
} = {}, { db = getDB() } = {}) {
  const clauses = []
  const args = []
  const deliveryFilter = idFilter(deliveryIds)
  if (deliveryFilter.unique.length > 0) {
    clauses.push(`id IN (${deliveryFilter.unique.map(() => '?').join(',')})`)
    args.push(...deliveryFilter.unique)
  }
  if (eventId) clauses.push('event_id = ?'), args.push(String(eventId))
  if (routeId) clauses.push('route_id = ?'), args.push(String(routeId))
  if (subscriberType) clauses.push('subscriber_type = ?'), args.push(String(subscriberType))
  if (subscriberId) clauses.push('subscriber_id = ?'), args.push(String(subscriberId))
  if (state) clauses.push('state = ?'), args.push(String(state))
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const safeLimit = Math.max(1, Math.min(1_000, Math.round(Number(limit) || 100)))
  return db.prepare(`
    SELECT * FROM information_deliveries ${where}
    ORDER BY priority DESC, available_at ASC, created_at ASC
    LIMIT ?
  `).all(...args, safeLimit).map(mapDeliveryRow)
}

export function leaseInformationDeliveries({
  deliveryIds = [],
  subscriberType = 'agent',
  subscriberId,
  limit = 20,
  leaseMs = 60_000,
  now = new Date(),
} = {}, { db = getDB() } = {}) {
  const normalizedSubscriberId = String(subscriberId || '').trim()
  if (!normalizedSubscriberId) throw new Error('subscriberId is required to lease deliveries')
  const nowIso = boundedIso(now)
  const safeLeaseMs = Math.max(1_000, Math.min(30 * 60_000, Math.round(Number(leaseMs) || 60_000)))
  const leaseExpiresAt = new Date(new Date(nowIso).getTime() + safeLeaseMs).toISOString()
  const safeLimit = Math.max(1, Math.min(100, Math.round(Number(limit) || 20)))
  const leaseId = `lease_${crypto.randomUUID()}`
  const deliveryFilter = idFilter(deliveryIds)

  const lease = db.transaction(() => {
    releaseExpiredInformationLeases(nowIso, { db })
    const rows = db.prepare(`
      SELECT * FROM information_deliveries
      WHERE state = 'pending' AND available_at <= ?
        AND subscriber_type = ? AND subscriber_id = ?
        ${deliveryFilter.sql}
      ORDER BY priority DESC, available_at ASC, created_at ASC
      LIMIT ?
    `).all(nowIso, String(subscriberType || 'agent'), normalizedSubscriberId, ...deliveryFilter.unique, safeLimit)
    if (rows.length === 0) return []
    const selectedIds = rows.map(row => row.id)
    db.prepare(`
      UPDATE information_deliveries
      SET state = 'leased', lease_id = ?, lease_expires_at = ?,
          attempts = attempts + 1, updated_at = datetime('now')
      WHERE state = 'pending' AND id IN (${selectedIds.map(() => '?').join(',')})
    `).run(leaseId, leaseExpiresAt, ...selectedIds)
    return db.prepare(`
      SELECT * FROM information_deliveries WHERE lease_id = ? ORDER BY priority DESC, created_at ASC
    `).all(leaseId).map(mapDeliveryRow)
  })

  const deliveries = lease()
  return { leaseId: deliveries.length ? leaseId : null, leaseExpiresAt: deliveries.length ? leaseExpiresAt : null, deliveries }
}

export function ackInformationDeliveries({ leaseId, deliveryIds = [], ackedAt = new Date() } = {}, { db = getDB() } = {}) {
  const normalizedLeaseId = String(leaseId || '').trim()
  if (!normalizedLeaseId) throw new Error('leaseId is required to ACK deliveries')
  const ids = idFilter(deliveryIds)
  return db.prepare(`
    UPDATE information_deliveries
    SET state = 'acked', acked_at = ?, lease_id = NULL, lease_expires_at = NULL,
        updated_at = datetime('now'), last_error = ''
    WHERE state = 'leased' AND lease_id = ?${ids.sql}
  `).run(boundedIso(ackedAt), normalizedLeaseId, ...ids.unique).changes
}

export function nackInformationDeliveries({
  leaseId,
  deliveryIds = [],
  error = '',
  retryAt = new Date(),
  maxAttempts = 5,
} = {}, { db = getDB() } = {}) {
  const normalizedLeaseId = String(leaseId || '').trim()
  if (!normalizedLeaseId) throw new Error('leaseId is required to NACK deliveries')
  const ids = idFilter(deliveryIds)
  const safeMaxAttempts = Math.max(1, Math.min(100, Math.round(Number(maxAttempts) || 5)))
  const retryAtIso = boundedIso(retryAt)
  const errorText = String(error || 'delivery NACK').trim().slice(0, 1_000)

  const nack = db.transaction(() => {
    const rows = db.prepare(`
      SELECT * FROM information_deliveries
      WHERE state = 'leased' AND lease_id = ?${ids.sql}
    `).all(normalizedLeaseId, ...ids.unique)
    let pending = 0
    let deadLetter = 0
    const markPending = db.prepare(`
      UPDATE information_deliveries
      SET state = 'pending', available_at = ?, lease_id = NULL, lease_expires_at = NULL,
          last_error = ?, updated_at = datetime('now')
      WHERE id = ? AND state = 'leased'
    `)
    const markDead = db.prepare(`
      UPDATE information_deliveries
      SET state = 'dead_letter', lease_id = NULL, lease_expires_at = NULL,
          last_error = ?, updated_at = datetime('now')
      WHERE id = ? AND state = 'leased'
    `)
    for (const row of rows) {
      if (row.attempts >= safeMaxAttempts) {
        deadLetter += markDead.run(errorText, row.id).changes
      } else {
        pending += markPending.run(retryAtIso, errorText, row.id).changes
      }
    }
    return { pending, deadLetter, total: pending + deadLetter }
  })
  return nack()
}
