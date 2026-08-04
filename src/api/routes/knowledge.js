import * as db from '../../db.js'
import { jsonResponse, readJsonBody } from '../utils.js'
import { execImportKnowledge } from '../../capabilities/tools/knowledge.js'

function getDbFunction(name) {
  const fn = db[name]
  if (typeof fn !== 'function') throw new Error(`knowledge storage is unavailable: db.${name} has not been installed`)
  return fn
}

function parseLimit(value, fallback, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(parsed, maximum))
}

function optionalBoolean(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim())
}

function routeId(pathname, prefix) {
  const raw = pathname.slice(prefix.length)
  if (!raw || raw.includes('/')) return ''
  try { return decodeURIComponent(raw) } catch { return '' }
}

function jsonError(res, status, error) {
  jsonResponse(res, status, { ok: false, error })
}

export async function handleKnowledgeRoutes(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/knowledge/regions') {
    try {
      const regions = await getDbFunction('listKnowledgeRegions')({
        includeInactive: optionalBoolean(url.searchParams.get('include_inactive')),
        limit: parseLimit(url.searchParams.get('limit'), 100, 500),
      })
      jsonResponse(res, 200, { ok: true, regions })
    } catch (err) {
      jsonError(res, 503, err.message)
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/knowledge/regions') {
    try {
      const body = await readJsonBody(req, { maxBytes: 256 * 1024 })
      const regionId = String(body.region_id || body.id || '').trim()
      const existing = regionId ? await getDbFunction('getKnowledgeRegion')(regionId) : null
      const name = String(body.name || existing?.name || '').trim()
      if (!name) {
        jsonError(res, 400, 'missing name')
        return true
      }
      const region = await getDbFunction('upsertKnowledgeRegion')({
        ...(existing || {}),
        ...body,
        id: regionId || undefined,
        regionId: regionId || undefined,
        name,
      })
      jsonResponse(res, 200, { ok: true, region })
    } catch (err) {
      jsonError(res, err.statusCode || 400, err.message)
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/knowledge/search') {
    const query = String(url.searchParams.get('q') || url.searchParams.get('query') || '').trim()
    if (!query) {
      jsonError(res, 400, 'missing q or query')
      return true
    }
    try {
      const regionId = String(url.searchParams.get('region_id') || '').trim() || null
      const hits = await getDbFunction('searchKnowledge')({
        query,
        regionIds: regionId ? [regionId] : [],
        limit: parseLimit(url.searchParams.get('limit'), 5, 20),
        includeInactive: optionalBoolean(url.searchParams.get('include_inactive')),
      })
      jsonResponse(res, 200, { ok: true, query, count: Array.isArray(hits) ? hits.length : undefined, hits })
    } catch (err) {
      jsonError(res, 503, err.message)
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/knowledge/documents') {
    try {
      const documents = await getDbFunction('listKnowledgeDocuments')({
        regionId: String(url.searchParams.get('region_id') || '').trim(),
        includeInactive: optionalBoolean(url.searchParams.get('include_inactive')),
        limit: parseLimit(url.searchParams.get('limit'), 100, 500),
      })
      jsonResponse(res, 200, { ok: true, documents })
    } catch (err) {
      jsonError(res, 503, err.message)
    }
    return true
  }

  // This mirrors the model-facing import tool so a future uploader can submit
  // already-extracted text without granting the API arbitrary local-file read
  // access.  URI-only submissions retain provenance but intentionally do not
  // fetch remote or local content on the caller's behalf.
  if (req.method === 'POST' && url.pathname === '/knowledge/documents') {
    try {
      const body = await readJsonBody(req, { maxBytes: 12 * 1024 * 1024 })
      const result = JSON.parse(await execImportKnowledge(body))
      jsonResponse(res, result.ok ? 200 : 400, result)
    } catch (err) {
      jsonError(res, err.statusCode || 400, err.message)
    }
    return true
  }

  if (req.method === 'GET' && url.pathname.startsWith('/knowledge/documents/')) {
    const id = routeId(url.pathname, '/knowledge/documents/')
    if (!id) {
      jsonError(res, 400, 'invalid document id')
      return true
    }
    try {
      const document = await getDbFunction('getKnowledgeDocument')(id)
      if (!document) jsonError(res, 404, 'knowledge document not found')
      else jsonResponse(res, 200, { ok: true, document })
    } catch (err) {
      jsonError(res, 503, err.message)
    }
    return true
  }

  if (req.method === 'GET' && url.pathname.startsWith('/knowledge/chunks/')) {
    const id = routeId(url.pathname, '/knowledge/chunks/')
    if (!id) {
      jsonError(res, 400, 'invalid chunk id')
      return true
    }
    try {
      const chunk = await getDbFunction('getKnowledgeChunk')(id)
      if (!chunk) jsonError(res, 404, 'knowledge chunk not found')
      else jsonResponse(res, 200, { ok: true, chunk })
    } catch (err) {
      jsonError(res, 503, err.message)
    }
    return true
  }

  return false
}
