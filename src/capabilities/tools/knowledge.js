import * as db from '../../db.js'
import { canonicalizeSourceUri, chunkText, hashContent, normalizeKnowledgeText } from '../../knowledge/index.js'

function toolJson(payload) {
  return JSON.stringify(payload, null, 2)
}

function requireDbFunction(name) {
  const fn = db[name]
  if (typeof fn !== 'function') {
    throw new Error(`knowledge storage is unavailable: db.${name} has not been installed`)
  }
  return fn
}

function parseObject(value, fallback = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {}
  }
  return fallback
}

function normalizeLimit(value, fallback = 20, max = 100) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(Math.floor(parsed), max))
}

function regionIdFrom(args = {}) {
  return String(args.region_id || args.id || '').trim()
}

function mimeTypeFor(sourceType = '') {
  const type = String(sourceType).trim().toLowerCase()
  if (type === 'markdown' || type === 'md') return 'text/markdown'
  if (type === 'html') return 'text/html'
  if (type === 'json') return 'application/json'
  return 'text/plain'
}

function inlineSourceUri(regionId, title) {
  // Use title (rather than content) as the stable source identity, so a later
  // import of the same titled inline document becomes a new document version.
  return `inline:${encodeURIComponent(regionId)}:${hashContent(title).slice(0, 20)}`
}

// The DB contract is deliberately passed as one documented payload.  The
// repository owns IDs, versions, chunking, and source persistence; this tool
// surface only validates intent and never reads a local path on the model's
// behalf.
export async function execManageKnowledgeRegion(args = {}) {
  const action = String(args.action || '').trim().toLowerCase()
  const regionId = regionIdFrom(args)
  if (!action) return toolJson({ ok: false, tool: 'manage_knowledge_region', error: 'missing action' })

  try {
    if (action === 'list') {
      const regions = await requireDbFunction('listKnowledgeRegions')({
        includeInactive: !!args.include_disabled,
        limit: normalizeLimit(args.limit, 100, 500),
      })
      return toolJson({ ok: true, tool: 'manage_knowledge_region', action, regions })
    }

    if (action === 'get') {
      if (!regionId) return toolJson({ ok: false, tool: 'manage_knowledge_region', action, error: 'missing region_id' })
      const region = await requireDbFunction('getKnowledgeRegion')(regionId)
      return toolJson({ ok: !!region, tool: 'manage_knowledge_region', action, region: region || null })
    }

    if (!['create', 'update', 'disable'].includes(action)) {
      return toolJson({ ok: false, tool: 'manage_knowledge_region', error: `unsupported action: ${action}` })
    }
    if (action !== 'create' && !regionId) {
      return toolJson({ ok: false, tool: 'manage_knowledge_region', action, error: 'missing region_id' })
    }
    if (action === 'create' && !String(args.name || '').trim()) {
      return toolJson({ ok: false, tool: 'manage_knowledge_region', action, error: 'missing name' })
    }

    const existing = action !== 'create'
      ? await requireDbFunction('getKnowledgeRegion')(regionId)
      : null
    if (action !== 'create' && !existing) {
      return toolJson({ ok: false, tool: 'manage_knowledge_region', action, error: `region not found: ${regionId}` })
    }

    const payload = {
      ...(existing || {}),
      region_id: regionId || undefined,
      id: regionId || undefined,
      name: String(args.name || existing?.name || '').trim(),
      description: args.description !== undefined ? String(args.description || '') : (existing?.description || ''),
      scope: args.scope !== undefined ? String(args.scope || '') : (existing?.scope || null),
      status: action === 'disable' ? 'disabled' : (args.status || existing?.status || 'active'),
      metadata: args.metadata !== undefined ? parseObject(args.metadata) : parseObject(existing?.metadata),
    }
    const region = await requireDbFunction('upsertKnowledgeRegion')(payload)
    return toolJson({ ok: true, tool: 'manage_knowledge_region', action, region })
  } catch (err) {
    return toolJson({ ok: false, tool: 'manage_knowledge_region', action, error: err.message })
  }
}

export async function execImportKnowledge(args = {}) {
  const regionId = regionIdFrom(args)
  const title = String(args.title || '').trim()
  const content = typeof args.content === 'string' ? args.content : ''
  const uri = String(args.uri || '').trim()
  if (!regionId || !title) {
    return toolJson({ ok: false, tool: 'import_knowledge', error: 'missing region_id or title' })
  }
  if (!content.trim() && !uri) {
    return toolJson({ ok: false, tool: 'import_knowledge', error: 'provide content or uri' })
  }
  try {
    const sourceType = String(args.source_type || '').trim() || (uri ? 'url' : 'inline_text')
    const mimeType = mimeTypeFor(sourceType)
    const sourceUri = canonicalizeSourceUri(uri || inlineSourceUri(regionId, title))
    const normalizedContent = content ? normalizeKnowledgeText(content, mimeType) : ''
    const result = await requireDbFunction('ingestKnowledgeDocument')({
      regionId,
      sourceUri,
      sourceType,
      title,
      mimeType,
      contentHash: hashContent(normalizedContent || sourceUri),
      metadata: { document: parseObject(args.metadata) },
      chunks: chunkText(normalizedContent, { mimeType, sourceUri, title }),
    })
    return toolJson({ ok: true, tool: 'import_knowledge', region_id: regionId, result })
  } catch (err) {
    return toolJson({ ok: false, tool: 'import_knowledge', region_id: regionId, error: err.message })
  }
}

export async function execSearchKnowledge(args = {}) {
  const query = String(args.query || '').trim()
  if (!query) return toolJson({ ok: false, tool: 'search_knowledge', error: 'missing query' })
  try {
    const hits = await requireDbFunction('searchKnowledge')({
      query,
      regionIds: regionIdFrom(args) ? [regionIdFrom(args)] : [],
      limit: normalizeLimit(args.limit, 5, 20),
      includeInactive: !!args.include_disabled,
    })
    return toolJson({ ok: true, tool: 'search_knowledge', query, count: Array.isArray(hits) ? hits.length : undefined, hits })
  } catch (err) {
    return toolJson({ ok: false, tool: 'search_knowledge', query, error: err.message })
  }
}

export async function execInspectKnowledgeSource(args = {}) {
  const documentId = String(args.document_id || '').trim()
  const chunkId = String(args.chunk_id || '').trim()
  if (!documentId && !chunkId) {
    return toolJson({ ok: false, tool: 'inspect_knowledge_source', error: 'provide document_id or chunk_id' })
  }
  try {
    const value = chunkId
      ? await requireDbFunction('getKnowledgeChunk')(chunkId)
      : await requireDbFunction('getKnowledgeDocument')(documentId)
    const kind = chunkId ? 'chunk' : 'document'
    return toolJson({ ok: !!value, tool: 'inspect_knowledge_source', kind, [kind]: value || null })
  } catch (err) {
    return toolJson({ ok: false, tool: 'inspect_knowledge_source', error: err.message })
  }
}
