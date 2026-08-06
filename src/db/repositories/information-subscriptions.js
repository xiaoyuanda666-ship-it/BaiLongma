import crypto from 'node:crypto'
import { getDB } from '../connection.js'

const VALID_MODES = new Set(['default', 'on_demand', 'scheduled'])
const VALID_SUBSCRIBERS = new Set(['user', 'agent'])
const MIN_INTERVAL_MS = 60_000
const MAX_INTERVAL_MS = 365 * 24 * 60 * 60 * 1000

function safeJsonArray(value) {
  if (Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(String(value || '[]'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function mapRow(row) {
  if (!row) return null
  return {
    id: row.id,
    providerId: row.provider_id,
    subscriberType: row.subscriber_type,
    subscriberId: row.subscriber_id,
    mode: row.mode,
    intervalMs: row.interval_ms,
    matchKeywords: safeJsonArray(row.match_json),
    reason: row.reason || '',
    instruction: row.instruction || '',
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastDeliveredAt: row.last_delivered_at || null,
  }
}

export function normalizeInformationSubscription(input = {}) {
  const providerId = String(input.providerId || '').trim()
  const subscriberType = String(input.subscriberType || '').trim().toLowerCase()
  const subscriberId = String(input.subscriberId || '').trim()
  const mode = String(input.mode || 'default').trim().toLowerCase()
  if (!providerId) throw new Error('providerId is required')
  if (!VALID_SUBSCRIBERS.has(subscriberType)) throw new Error('subscriberType must be user or agent')
  if (!subscriberId) throw new Error('subscriberId is required')
  if (!VALID_MODES.has(mode)) throw new Error('mode must be default, on_demand, or scheduled')

  let intervalMs = null
  if (mode === 'scheduled') {
    intervalMs = Math.round(Number(input.intervalMs))
    if (!Number.isFinite(intervalMs)) throw new Error('scheduled subscriptions require intervalMs')
    intervalMs = Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, intervalMs))
  }

  const matchKeywords = Array.isArray(input.matchKeywords)
    ? [...new Set(input.matchKeywords.map(value => String(value || '').trim()).filter(Boolean))].slice(0, 20)
    : []
  return {
    id: String(input.id || crypto.randomUUID()),
    providerId,
    subscriberType,
    subscriberId,
    mode,
    intervalMs,
    matchKeywords,
    reason: String(input.reason || '').trim().slice(0, 500),
    instruction: String(input.instruction || '').trim().slice(0, 1_500),
    enabled: input.enabled !== false,
  }
}

export function upsertInformationSubscription(input = {}) {
  const subscription = normalizeInformationSubscription(input)
  const existingCount = getDB().prepare(
    `SELECT COUNT(*) AS count FROM information_subscriptions
     WHERE subscriber_type = ? AND subscriber_id = ?`,
  ).get(subscription.subscriberType, subscription.subscriberId)?.count || 0
  const exists = getDB().prepare(
    `SELECT id FROM information_subscriptions
     WHERE provider_id = ? AND subscriber_type = ? AND subscriber_id = ?`,
  ).get(subscription.providerId, subscription.subscriberType, subscription.subscriberId)
  if (!exists && existingCount >= 20) throw new Error('a subscriber may have at most 20 information subscriptions')

  getDB().prepare(`
    INSERT INTO information_subscriptions (
      id, provider_id, subscriber_type, subscriber_id, mode, interval_ms,
      match_json, reason, instruction, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(provider_id, subscriber_type, subscriber_id) DO UPDATE SET
      mode = excluded.mode,
      interval_ms = excluded.interval_ms,
      match_json = excluded.match_json,
      reason = excluded.reason,
      instruction = excluded.instruction,
      enabled = excluded.enabled,
      last_delivered_at = CASE
        WHEN information_subscriptions.mode = 'scheduled' AND excluded.mode = 'scheduled'
          THEN information_subscriptions.last_delivered_at
        ELSE NULL
      END,
      updated_at = datetime('now')
  `).run(
    subscription.id,
    subscription.providerId,
    subscription.subscriberType,
    subscription.subscriberId,
    subscription.mode,
    subscription.intervalMs,
    JSON.stringify(subscription.matchKeywords),
    subscription.reason,
    subscription.instruction,
    subscription.enabled ? 1 : 0,
  )
  return getInformationSubscription({
    providerId: subscription.providerId,
    subscriberType: subscription.subscriberType,
    subscriberId: subscription.subscriberId,
  })
}

export function getInformationSubscription({ providerId, subscriberType, subscriberId } = {}) {
  return mapRow(getDB().prepare(`
    SELECT * FROM information_subscriptions
    WHERE provider_id = ? AND subscriber_type = ? AND subscriber_id = ?
  `).get(providerId, subscriberType, subscriberId))
}

export function listInformationSubscriptions({ subscriberType = '', subscriberId = '', enabledOnly = false } = {}) {
  const clauses = []
  const params = []
  if (subscriberType) {
    clauses.push('subscriber_type = ?')
    params.push(subscriberType)
  }
  if (subscriberId) {
    clauses.push('subscriber_id = ?')
    params.push(subscriberId)
  }
  if (enabledOnly) clauses.push('enabled = 1')
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  return getDB().prepare(`
    SELECT * FROM information_subscriptions ${where}
    ORDER BY subscriber_type, subscriber_id, provider_id
  `).all(...params).map(mapRow)
}

export function listRelevantInformationSubscriptions({ userId = '', agentId = '' } = {}) {
  const branches = []
  const params = []
  if (agentId) {
    branches.push(`(subscriber_type = 'agent' AND subscriber_id = ?)`)
    params.push(agentId)
  }
  if (userId) {
    branches.push(`(subscriber_type = 'user' AND subscriber_id = ?)`)
    params.push(userId)
  }
  if (branches.length === 0) return []
  return getDB().prepare(`
    SELECT * FROM information_subscriptions
    WHERE enabled = 1 AND (${branches.join(' OR ')})
    ORDER BY provider_id, subscriber_type
  `).all(...params).map(mapRow)
}

export function removeInformationSubscription({ providerId, subscriberType, subscriberId } = {}) {
  return getDB().prepare(`
    DELETE FROM information_subscriptions
    WHERE provider_id = ? AND subscriber_type = ? AND subscriber_id = ?
  `).run(providerId, subscriberType, subscriberId).changes > 0
}

export function setInformationSubscriptionEnabled({ providerId, subscriberType, subscriberId, enabled } = {}) {
  const result = getDB().prepare(`
    UPDATE information_subscriptions
    SET enabled = ?, updated_at = datetime('now')
    WHERE provider_id = ? AND subscriber_type = ? AND subscriber_id = ?
  `).run(enabled ? 1 : 0, providerId, subscriberType, subscriberId)
  return result.changes > 0
}

export function markInformationSubscriptionsDelivered(ids = [], deliveredAt = new Date().toISOString()) {
  const uniqueIds = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean))]
  if (uniqueIds.length === 0) return 0
  const placeholders = uniqueIds.map(() => '?').join(',')
  return getDB().prepare(`
    UPDATE information_subscriptions
    SET last_delivered_at = ?, updated_at = datetime('now')
    WHERE id IN (${placeholders}) AND mode = 'scheduled' AND enabled = 1
  `).run(deliveredAt, ...uniqueIds).changes
}
