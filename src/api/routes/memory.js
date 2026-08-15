import {
  getDB,
  getRecentExtractAudits,
  getRecentRecallAudits,
  getExtractAuditStats,
  getRecallAuditStats,
} from '../../db.js'
import { isRunning } from '../../control.js'
import { getQuotaStatus } from '../../quota.js'
import { getSelfEvolutionSnapshot } from '../../memory/self-evolution.js'
import { jsonResponse, safeJsonParse, readJsonBody } from '../utils.js'

function stripAssistantHistoryLabels(content) {
  return String(content || '')
    .trim()
    .replace(/^(?:\s*\[assistant(?:\s+to\s+[^\]\r\n]+)?(?:\s+\d{4}-\d{2}-\d{2}T[^\]\r\n]+)?\]\s*)+/giu, '')
    .trim()
}

async function handleMemories(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/memories') {
    const db = getDB()
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100)
    const search = url.searchParams.get('search')
    let rows
    if (search) {
      try {
        rows = db.prepare(`
          SELECT m.* FROM memories m
          JOIN memories_fts ON memories_fts.rowid = m.id
          WHERE memories_fts MATCH ? AND m.visibility = 1
          ORDER BY bm25(memories_fts), m.created_at DESC LIMIT ?
        `).all(search, limit)
      } catch {
        rows = db.prepare(`
          SELECT * FROM memories
          WHERE (
            title LIKE ? OR mem_id LIKE ? OR content LIKE ? OR detail LIKE ?
            OR entities LIKE ? OR concepts LIKE ? OR tags LIKE ?
          )
          AND visibility = 1
          ORDER BY created_at DESC LIMIT ?
        `).all(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, limit)
      }
    } else {
      rows = db.prepare('SELECT * FROM memories WHERE visibility = 1 ORDER BY created_at DESC LIMIT ?').all(limit)
    }
    jsonResponse(res, 200, rows)
    return true
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/memories/')) {
    const id = parseInt(url.pathname.split('/')[2])
    if (!id) {
      jsonResponse(res, 400, { error: 'invalid id' })
      return true
    }
    getDB().prepare('DELETE FROM memories WHERE id = ?').run(id)
    jsonResponse(res, 200, { ok: true })
    return true
  }

  if (req.method === 'PATCH' && url.pathname.startsWith('/memories/')) {
    const id = parseInt(url.pathname.split('/')[2])
    if (!id) {
      jsonResponse(res, 400, { error: 'invalid id' })
      return true
    }
    try {
      const { content, detail } = await readJsonBody(req)
      const db = getDB()
      if (content !== undefined) db.prepare('UPDATE memories SET content = ? WHERE id = ?').run(content, id)
      if (detail !== undefined) db.prepare('UPDATE memories SET detail = ? WHERE id = ?').run(detail, id)
      jsonResponse(res, 200, { ok: true })
    } catch (e) {
      jsonResponse(res, 400, { error: e.message })
    }
    return true
  }

  return false
}

export async function handleMemoryRoutes(req, res, url) {
  if (await handleMemories(req, res, url)) return true

  if (req.method === 'GET' && url.pathname === '/audit/recall') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 500)
    const rows = getRecentRecallAudits(limit).map(r => ({
      ...r,
      matched_mem_ids: safeJsonParse(r.matched_mem_ids, []),
      event_type_dist: safeJsonParse(r.event_type_dist, {}),
    }))
    jsonResponse(res, 200, rows)
    return true
  }

  if (req.method === 'GET' && url.pathname === '/audit/extract') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 500)
    const rows = getRecentExtractAudits(limit).map(r => ({
      ...r,
      extracted_mem_ids: safeJsonParse(r.extracted_mem_ids, []),
      event_type_dist: safeJsonParse(r.event_type_dist, {}),
      skipped: !!r.skipped,
    }))
    jsonResponse(res, 200, rows)
    return true
  }

  if (req.method === 'GET' && url.pathname === '/audit/stats') {
    const hours = Math.max(1, Math.min(parseInt(url.searchParams.get('hours') || '168'), 24 * 30))
    const sinceIso = new Date(Date.now() - hours * 3600_000).toISOString().replace('T', ' ').slice(0, 19)
    jsonResponse(res, 200, {
      windowHours: hours,
      sinceIso,
      recall: getRecallAuditStats({ sinceIso }) || {},
      extract: getExtractAuditStats({ sinceIso }) || {},
    })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/conversations') {
    const db = getDB()
    const requestedLimit = parseInt(url.searchParams.get('limit') || '60', 10)
    const limit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 60, 500))
    const requestedBeforeId = parseInt(url.searchParams.get('before_id') || '', 10)
    const beforeId = Number.isFinite(requestedBeforeId) && requestedBeforeId > 0
      ? requestedBeforeId
      : null
    const includeSystemSignals = url.searchParams.get('includeSystemSignals') === 'true'
    const rows = db.prepare(`
      SELECT id, role, from_id, to_id, content, timestamp, channel, external_party_id,
             focus_absorbed, focus_topic, open_question, resource_state, resource_metadata
      FROM conversations
      WHERE (? OR NOT (from_id = 'SYSTEM' AND channel = 'APP_SIGNAL'))
        ${beforeId ? 'AND id < ?' : ''}
      ORDER BY id DESC
      LIMIT ?
    `).all(...(
      beforeId
        ? [includeSystemSignals ? 1 : 0, beforeId, limit]
        : [includeSystemSignals ? 1 : 0, limit]
    ))
    jsonResponse(res, 200, rows.reverse().map(row => (
      row.role === 'jarvis'
        ? { ...row, content: stripAssistantHistoryLabels(row.content) }
        : row
    )))
    return true
  }

  if (req.method === 'GET' && url.pathname === '/status') {
    const { n } = getDB().prepare('SELECT COUNT(*) as n FROM memories').get()
    jsonResponse(res, 200, {
      ok: true,
      memory_count: n,
      running: isRunning(),
      self_evolution: getSelfEvolutionSnapshot({ maxRecent: 5 }),
    })
    return true
  }

  if (req.method === 'GET' && (url.pathname === '/self-evolution' || url.pathname === '/memory/self-evolution')) {
    const limit = Math.max(1, Math.min(parseInt(url.searchParams.get('limit') || '20'), 24))
    jsonResponse(res, 200, { ok: true, ...getSelfEvolutionSnapshot({ maxRecent: limit }) })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/quota') {
    jsonResponse(res, 200, getQuotaStatus())
    return true
  }

  return false
}
