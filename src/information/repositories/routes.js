import { getDB } from '../../db/connection.js'
import { createInformationRoute } from '../route-model.js'

function parseObject(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function mapRouteRow(row) {
  if (!row) return null
  return {
    id: row.id,
    subscriber: { type: row.subscriber_type, id: row.subscriber_id },
    topicPattern: row.topic_pattern,
    scope: parseObject(row.scope_json),
    filter: parseObject(row.filter_json),
    activation: parseObject(row.activation_json),
    sampling: parseObject(row.sampling_json),
    wake: parseObject(row.wake_json),
    delivery: parseObject(row.delivery_json),
    context: parseObject(row.context_json),
    reason: row.reason || '',
    createdBy: parseObject(row.created_by_json),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function getInformationRoute(id, { db = getDB() } = {}) {
  return mapRouteRow(db.prepare(`SELECT * FROM information_routes WHERE id = ?`).get(String(id || '')))
}

export function upsertInformationRoute(input, { db = getDB() } = {}) {
  const route = createInformationRoute(input)
  db.prepare(`
    INSERT INTO information_routes (
      id, subscriber_type, subscriber_id, topic_pattern, scope_json, filter_json,
      activation_json, sampling_json, wake_json, delivery_json, context_json,
      reason, created_by_json, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      subscriber_type = excluded.subscriber_type,
      subscriber_id = excluded.subscriber_id,
      topic_pattern = excluded.topic_pattern,
      scope_json = excluded.scope_json,
      filter_json = excluded.filter_json,
      activation_json = excluded.activation_json,
      sampling_json = excluded.sampling_json,
      wake_json = excluded.wake_json,
      delivery_json = excluded.delivery_json,
      context_json = excluded.context_json,
      reason = excluded.reason,
      created_by_json = excluded.created_by_json,
      enabled = excluded.enabled,
      updated_at = datetime('now')
  `).run(
    route.id,
    route.subscriber.type,
    route.subscriber.id,
    route.topicPattern,
    JSON.stringify(route.scope),
    JSON.stringify(route.filter),
    JSON.stringify(route.activation),
    JSON.stringify(route.sampling),
    JSON.stringify(route.wake),
    JSON.stringify(route.delivery),
    JSON.stringify(route.context),
    route.reason,
    JSON.stringify(route.createdBy),
    route.enabled ? 1 : 0,
  )
  return getInformationRoute(route.id, { db })
}

export function listInformationRoutes({
  subscriberType = '',
  subscriberId = '',
  enabledOnly = false,
} = {}, { db = getDB() } = {}) {
  const clauses = []
  const args = []
  if (subscriberType) clauses.push('subscriber_type = ?'), args.push(String(subscriberType))
  if (subscriberId) clauses.push('subscriber_id = ?'), args.push(String(subscriberId))
  if (enabledOnly) clauses.push('enabled = 1')
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  return db.prepare(`
    SELECT * FROM information_routes ${where}
    ORDER BY created_at ASC, id ASC
  `).all(...args).map(mapRouteRow)
}

export function setInformationRouteEnabled(id, enabled, { db = getDB() } = {}) {
  return db.prepare(`
    UPDATE information_routes SET enabled = ?, updated_at = datetime('now') WHERE id = ?
  `).run(enabled ? 1 : 0, String(id || '')).changes > 0
}

export function removeInformationRoute(id, { db = getDB() } = {}) {
  return db.prepare(`DELETE FROM information_routes WHERE id = ?`).run(String(id || '')).changes > 0
}
