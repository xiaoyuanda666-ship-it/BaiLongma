import { getDB } from '../connection.js'

const EVENT_LIMIT = 800
const PAYLOAD_LIMIT = 6000
const SENSITIVE_KEY_RE = /(?:api[_-]?key|apikey|access[_-]?key|secret|token|password|authorization|bearer)/i
const SECRET_VALUE_RE = /\b(?:sk|ak|rk|pk)-[A-Za-z0-9_\-.]{12,180}\b/g

function scrubValue(value, depth = 0) {
  if (typeof value === 'string') return value.replace(SECRET_VALUE_RE, '[redacted]').slice(0, 1500)
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value
  if (depth >= 4) return '[nested]'
  if (Array.isArray(value)) return value.slice(0, 20).map(item => scrubValue(item, depth + 1))
  if (typeof value !== 'object') return String(value).slice(0, 300)

  const out = {}
  for (const [key, item] of Object.entries(value).slice(0, 32)) {
    out[key] = SENSITIVE_KEY_RE.test(key) ? '[redacted]' : scrubValue(item, depth + 1)
  }
  return out
}

function serializePayload(payload) {
  const scrubbed = scrubValue(payload || {})
  let json = JSON.stringify(scrubbed)
  if (json.length <= PAYLOAD_LIMIT) return json

  const compact = {
    name: scrubbed?.name,
    ok: scrubbed?.ok,
    args: scrubValue(scrubbed?.args || {}, 3),
    result: String(scrubbed?.result || '').slice(0, 1800),
    error: String(scrubbed?.error || '').slice(0, 500),
    mode: scrubbed?.mode,
  }
  json = JSON.stringify(compact)
  return json.length <= PAYLOAD_LIMIT
    ? json
    : JSON.stringify({ name: compact.name, ok: compact.ok, result: compact.result.slice(0, 1000) })
}

export function insertBrainUiEvent({ timestamp, path = 'l2', eventType, payload = {} }) {
  const db = getDB()
  const ts = timestamp || new Date().toISOString()
  const normalizedPath = path === 'l1' || path === 'l3' ? path : 'l2'
  const type = String(eventType || '').slice(0, 80)
  if (!type) return 0

  const write = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO brain_ui_events (timestamp, path, event_type, payload_json)
      VALUES (?, ?, ?, ?)
    `).run(ts, normalizedPath, type, serializePayload(payload))

    if (normalizedPath === 'l2' && type === 'tick') {
      db.prepare(`
        INSERT INTO brain_ui_state (key, value, updated_at)
        VALUES ('heartbeat_count', '1', ?)
        ON CONFLICT(key) DO UPDATE SET
          value = CAST(CAST(brain_ui_state.value AS INTEGER) + 1 AS TEXT),
          updated_at = excluded.updated_at
      `).run(ts)
    }

    db.prepare(`
      DELETE FROM brain_ui_events
      WHERE id <= COALESCE((SELECT id FROM brain_ui_events ORDER BY id DESC LIMIT 1 OFFSET ?), 0)
    `).run(EVENT_LIMIT)
    return Number(info.lastInsertRowid) || 0
  })

  return write()
}

export function getBrainUiEventHistory({ path = 'l2', limit = 160 } = {}) {
  const db = getDB()
  const normalizedPath = path === 'all'
    ? 'all'
    : (path === 'l1' || path === 'l3' ? path : 'l2')
  const safeLimit = Math.max(1, Math.min(400, Number(limit) || 160))
  const rows = normalizedPath === 'all'
    ? db.prepare(`
        SELECT id, timestamp, path, event_type, payload_json
        FROM brain_ui_events
        ORDER BY id DESC
        LIMIT ?
      `).all(safeLimit).reverse()
    : db.prepare(`
        SELECT id, timestamp, path, event_type, payload_json
        FROM brain_ui_events
        WHERE path = ?
        ORDER BY id DESC
        LIMIT ?
      `).all(normalizedPath, safeLimit).reverse()

  const events = rows.map(row => {
    let data = {}
    try { data = JSON.parse(row.payload_json || '{}') } catch {}
    return { id: row.id, path: row.path, type: row.event_type, data, ts: row.timestamp }
  })
  const stateRow = db.prepare(`SELECT value FROM brain_ui_state WHERE key = 'heartbeat_count'`).get()
  const fallbackCount = db.prepare(`
    SELECT COUNT(*) AS count FROM brain_ui_events WHERE path = 'l2' AND event_type = 'tick'
  `).get()?.count || 0

  return {
    events,
    heartbeatCount: Math.max(0, Number(stateRow?.value ?? fallbackCount) || 0),
  }
}
