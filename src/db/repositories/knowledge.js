import { getDB } from '../connection.js'

const MAX_SEARCH_LIMIT = 100

function json(value, fallback = {}) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) } catch { return fallback }
  }
  return value == null ? fallback : value
}

function jsonString(value, fallback = {}) {
  try { return JSON.stringify(value == null ? fallback : value) } catch { return JSON.stringify(fallback) }
}

function string(value) {
  return value == null ? '' : String(value)
}

function positiveLimit(limit, fallback = 20) {
  const parsed = Number(limit)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(parsed)))
}

function slug(value) {
  const normalized = string(value).trim().toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || `region-${Date.now()}`
}

function hydrateRegion(row) {
  if (!row) return null
  return { ...row, metadata: json(row.metadata_json) }
}

function hydrateSource(row) {
  if (!row) return null
  return { ...row, metadata: json(row.metadata_json) }
}

function hydrateDocument(row) {
  if (!row) return null
  return { ...row, metadata: json(row.metadata_json) }
}

function hydrateChunk(row) {
  if (!row) return null
  return {
    ...row,
    // The retrieval/formatting layer intentionally accepts a transport-neutral
    // shape.  Keep the DB names too, but provide these aliases so context and
    // locator data are never lost on the automatic-injection path.
    text: row.text ?? row.chunk_text ?? '',
    context: row.context ?? row.context_text ?? '',
    locator: json(row.locator_json),
    citation_id: row.citation_id || `K:${row.document_id}:${row.chunk_id || row.id}`,
  }
}

/** Create or update a knowledge domain without touching the memory store. */
export function upsertKnowledgeRegion({ id, regionId, name, description = '', scope = '', owner = '', status = 'active', metadata = {} } = {}) {
  const db = getDB()
  const resolvedId = string(id || regionId).trim() || slug(name)
  const resolvedName = string(name).trim() || resolvedId
  db.prepare(`
    INSERT INTO knowledge_regions (id, name, description, scope, owner, status, metadata_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      scope = excluded.scope,
      owner = excluded.owner,
      status = excluded.status,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at
  `).run(resolvedId, resolvedName, string(description), string(scope), string(owner), string(status), jsonString(metadata))
  return getKnowledgeRegion(resolvedId)
}

export function getKnowledgeRegion(regionId) {
  return hydrateRegion(getDB().prepare(`SELECT * FROM knowledge_regions WHERE id = ?`).get(regionId))
}

export function listKnowledgeRegions({ includeInactive = false, limit = 100 } = {}) {
  const db = getDB()
  const rows = includeInactive
    ? db.prepare(`SELECT * FROM knowledge_regions ORDER BY updated_at DESC, name ASC LIMIT ?`).all(positiveLimit(limit, 100))
    : db.prepare(`SELECT * FROM knowledge_regions WHERE status = 'active' ORDER BY updated_at DESC, name ASC LIMIT ?`).all(positiveLimit(limit, 100))
  return rows.map(hydrateRegion)
}

export function getKnowledgeSource(sourceId) {
  return hydrateSource(getDB().prepare(`
    SELECT s.*, r.name AS region_name
    FROM knowledge_sources s
    JOIN knowledge_regions r ON r.id = s.region_id
    WHERE s.id = ?
  `).get(sourceId))
}

function upsertSource(db, { regionId, sourceUri, sourceType = 'file', displayName = '', metadata = {} }) {
  const existing = db.prepare(`SELECT * FROM knowledge_sources WHERE region_id = ? AND uri = ?`).get(regionId, sourceUri)
  if (existing) {
    db.prepare(`
      UPDATE knowledge_sources
      SET source_type = ?, display_name = ?, metadata_json = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(string(sourceType) || 'file', string(displayName), jsonString(metadata), existing.id)
    return db.prepare(`SELECT * FROM knowledge_sources WHERE id = ?`).get(existing.id)
  }
  const result = db.prepare(`
    INSERT INTO knowledge_sources (region_id, uri, source_type, display_name, metadata_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(regionId, sourceUri, string(sourceType) || 'file', string(displayName), jsonString(metadata))
  return db.prepare(`SELECT * FROM knowledge_sources WHERE id = ?`).get(result.lastInsertRowid)
}

function nextVersion(db, sourceId, requestedVersion) {
  const latest = db.prepare(`
    SELECT version FROM knowledge_documents WHERE source_id = ? ORDER BY version DESC LIMIT 1
  `).get(sourceId)
  const requested = Number(requestedVersion)
  if (Number.isInteger(requested) && requested > 0) return requested
  return Number(latest?.version || 0) + 1
}

function upsertDocumentForSource(db, { sourceId, title = '', mimeType = '', contentHash = '', version = null, metadata = {} }) {
  const hash = string(contentHash)
  const current = db.prepare(`
    SELECT * FROM knowledge_documents
    WHERE source_id = ? AND active = 1
    ORDER BY version DESC LIMIT 1
  `).get(sourceId)

  // Identical content stays on the same version.  This makes repeated syncs
  // idempotent and avoids turning a parser retry into a fake document update.
  if (current && current.content_hash === hash) {
    db.prepare(`
      UPDATE knowledge_documents
      SET title = ?, mime_type = ?, metadata_json = ?, updated_at = datetime('now'), active = 1
      WHERE id = ?
    `).run(string(title), string(mimeType), jsonString(metadata), current.id)
    return db.prepare(`SELECT * FROM knowledge_documents WHERE id = ?`).get(current.id)
  }

  db.prepare(`UPDATE knowledge_documents SET active = 0, updated_at = datetime('now') WHERE source_id = ? AND active = 1`).run(sourceId)
  db.prepare(`
    UPDATE knowledge_chunks
    SET active = 0, updated_at = datetime('now')
    WHERE document_id IN (SELECT id FROM knowledge_documents WHERE source_id = ?)
  `).run(sourceId)

  const targetVersion = nextVersion(db, sourceId, version)
  const result = db.prepare(`
    INSERT INTO knowledge_documents (source_id, title, mime_type, content_hash, version, active, metadata_json)
    VALUES (?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(source_id, version) DO UPDATE SET
      title = excluded.title,
      mime_type = excluded.mime_type,
      content_hash = excluded.content_hash,
      active = 1,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at
  `).run(sourceId, string(title), string(mimeType), hash, targetVersion, jsonString(metadata))

  const row = db.prepare(`
    SELECT * FROM knowledge_documents WHERE source_id = ? AND version = ?
  `).get(sourceId, targetVersion)
  // A caller may have supplied an already-used version.  In that case it is
  // deliberately the active replacement for that version, rather than an
  // ambiguous second row.
  return row || db.prepare(`SELECT * FROM knowledge_documents WHERE id = ?`).get(result.lastInsertRowid)
}

/** Upsert a document version when the caller already has a source id. */
export function upsertKnowledgeDocument({ sourceId, title = '', mimeType = '', contentHash = '', version = null, metadata = {} } = {}) {
  if (!sourceId) throw new Error('sourceId is required to upsert a knowledge document')
  const db = getDB()
  const run = db.transaction(() => hydrateDocument(upsertDocumentForSource(db, {
    sourceId, title, mimeType, contentHash, version, metadata,
  })))
  return run()
}

function normalizeChunk(chunk, ordinal) {
  const value = typeof chunk === 'string' ? { text: chunk } : (chunk || {})
  const chunkText = string(value.chunk_text ?? value.text ?? value.content).trim()
  if (!chunkText) return null
  const contextText = string(value.context_text ?? value.context ?? '')
  const locator = value.locator_json ?? value.locator ?? {}
  const embedding = Buffer.isBuffer(value.embedding) ? value.embedding : null
  return {
    ordinal: Number.isInteger(Number(value.ordinal)) ? Number(value.ordinal) : ordinal,
    chunkText,
    contextText,
    locatorJson: typeof locator === 'string' ? locator : jsonString(locator),
    contentHash: string(value.content_hash ?? value.contentHash),
    embedding,
    embeddingDim: Number.isInteger(Number(value.embedding_dim ?? value.embeddingDim)) ? Number(value.embedding_dim ?? value.embeddingDim) : null,
    embeddingModel: value.embedding_model ?? value.embeddingModel ?? null,
  }
}

function replaceChunksForDocument(db, documentId, chunks) {
  if (!Array.isArray(chunks)) throw new Error('chunks must be an array')
  db.prepare(`DELETE FROM knowledge_chunks WHERE document_id = ?`).run(documentId)
  const insert = db.prepare(`
    INSERT INTO knowledge_chunks
      (document_id, ordinal, chunk_text, context_text, locator_json, content_hash, active, embedding, embedding_dim, embedding_model)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `)
  const added = []
  const usedOrdinals = new Set()
  chunks.forEach((chunk, index) => {
    const normalized = normalizeChunk(chunk, index)
    if (!normalized) return
    while (usedOrdinals.has(normalized.ordinal)) normalized.ordinal += 1
    usedOrdinals.add(normalized.ordinal)
    const result = insert.run(
      documentId, normalized.ordinal, normalized.chunkText, normalized.contextText,
      normalized.locatorJson, normalized.contentHash, normalized.embedding,
      normalized.embeddingDim, normalized.embeddingModel,
    )
    added.push(result.lastInsertRowid)
  })
  return added.map(id => db.prepare(`SELECT * FROM knowledge_chunks WHERE id = ?`).get(id))
}

export function replaceKnowledgeDocumentChunks({ documentId, chunks = [] } = {}) {
  if (!documentId) throw new Error('documentId is required to replace knowledge chunks')
  const db = getDB()
  const run = db.transaction(() => replaceChunksForDocument(db, documentId, chunks).map(hydrateChunk))
  return run()
}

/**
 * The ingestion boundary used by parsers.  A source's prior version is kept
 * for provenance, but only the newest document/chunks are active and eligible
 * for retrieval.
 */
export function ingestKnowledgeDocument({
  regionId,
  sourceUri,
  sourceType = 'file',
  title = '',
  mimeType = '',
  contentHash = '',
  version = null,
  metadata = {},
  chunks,
} = {}) {
  if (!regionId) throw new Error('regionId is required to ingest knowledge')
  if (!sourceUri) throw new Error('sourceUri is required to ingest knowledge')
  const db = getDB()
  const run = db.transaction(() => {
    if (!db.prepare(`SELECT 1 FROM knowledge_regions WHERE id = ?`).get(regionId)) {
      throw new Error(`Unknown knowledge region: ${regionId}`)
    }
    const source = upsertSource(db, {
      regionId,
      sourceUri: string(sourceUri),
      sourceType,
      displayName: title,
      metadata: metadata?.source || {},
    })
    const document = upsertDocumentForSource(db, {
      sourceId: source.id,
      title,
      mimeType,
      contentHash,
      version,
      metadata: metadata?.document || metadata || {},
    })
    const storedChunks = Array.isArray(chunks)
      ? replaceChunksForDocument(db, document.id, chunks)
      : db.prepare(`SELECT * FROM knowledge_chunks WHERE document_id = ? AND active = 1 ORDER BY ordinal ASC`).all(document.id)
    return {
      source: hydrateSource(source),
      document: hydrateDocument(document),
      chunks: storedChunks.map(hydrateChunk),
    }
  })
  return run()
}

export function getKnowledgeDocument(documentId) {
  return hydrateDocument(getDB().prepare(`
    SELECT d.*, s.uri AS source_uri, s.region_id, r.name AS region_name
    FROM knowledge_documents d
    JOIN knowledge_sources s ON s.id = d.source_id
    JOIN knowledge_regions r ON r.id = s.region_id
    WHERE d.id = ?
  `).get(documentId))
}

export function listKnowledgeDocuments({ regionId = '', includeInactive = false, limit = 100 } = {}) {
  const db = getDB()
  const params = []
  const where = []
  if (!includeInactive) {
    where.push("d.active = 1", "r.status = 'active'")
  }
  if (string(regionId).trim()) {
    where.push('s.region_id = ?')
    params.push(string(regionId).trim())
  }
  params.push(positiveLimit(limit, 100))
  const rows = db.prepare(`
    SELECT d.*, s.uri AS source_uri, s.region_id, r.name AS region_name
    FROM knowledge_documents d
    JOIN knowledge_sources s ON s.id = d.source_id
    JOIN knowledge_regions r ON r.id = s.region_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY d.updated_at DESC, d.title ASC
    LIMIT ?
  `).all(...params)
  return rows.map(hydrateDocument)
}

export function getKnowledgeChunk(chunkId) {
  return hydrateChunk(getDB().prepare(`
    SELECT c.*, c.id AS chunk_id, d.title AS document_title, d.version AS document_version,
           d.mime_type, s.uri AS source_uri, s.region_id, r.name AS region_name
    FROM knowledge_chunks c
    JOIN knowledge_documents d ON d.id = c.document_id
    JOIN knowledge_sources s ON s.id = d.source_id
    JOIN knowledge_regions r ON r.id = s.region_id
    WHERE c.id = ?
  `).get(chunkId))
}

function regionFilter(regionIds, params, prefix = '') {
  const ids = [...new Set((regionIds || []).filter(Boolean).map(String))]
  if (!ids.length) return ''
  params.push(...ids)
  return ` AND s.region_id IN (${ids.map(() => '?').join(', ')})`
}

function resultRow(row, method, score = null) {
  return hydrateChunk({
    ...row,
    retrieval_method: method,
    score,
    citation_id: `K:${row.document_id}:${row.chunk_id}`,
  })
}

const ENGLISH_SEARCH_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'about', 'according', 'can', 'could', 'do', 'does',
  'for', 'from', 'how', 'in', 'is', 'it', 'of', 'on', 'please', 'the', 'to',
  'what', 'where', 'which', 'with', 'would', 'you', 'your',
])

// Structural question wording is common in Chinese queries but carries little
// retrieval value.  Keep content-bearing two-character terms for the LIKE
// fallback so "如何验证发布" can still match a source that says "发布验证".
const CJK_SEARCH_STOP_TERMS = new Set([
  '根据', '文档', '资料', '文件', '如何', '怎样', '怎么', '什么', '哪个',
  '这个', '那个', '一下', '请问', '关于', '相关', '里面', '其中', '可以',
])

function searchableTerms(queryText) {
  const english = (queryText.toLowerCase().match(/[a-z0-9_]{2,}/g) || [])
    .filter(term => !ENGLISH_SEARCH_STOP_WORDS.has(term))
  const cjk = []
  const cjkLike = []
  for (const run of queryText.match(/[\u3400-\u9fff]{2,}/g) || []) {
    // Chinese has no word separators.  Trigram alternatives make a natural
    // sentence such as "文档里如何验证发布" searchable without pretending the
    // entire sentence is one required token.  The lexical reranker still
    // prefers chunks that overlap more of the original query.
    if (run.length <= 3) cjk.push(run)
    else {
      for (let index = 0; index <= run.length - 3 && cjk.length < 24; index += 1) {
        cjk.push(run.slice(index, index + 3))
      }
    }
    // FTS5 trigram cannot search two CJK characters, but SQLite LIKE can.
    // These terms intentionally feed only the fallback, where alternatives
    // are ORed rather than requiring a natural-language sentence verbatim.
    for (let index = 0; index <= run.length - 2 && cjkLike.length < 32; index += 1) {
      const term = run.slice(index, index + 2)
      if (!CJK_SEARCH_STOP_TERMS.has(term)) cjkLike.push(term)
    }
  }
  return {
    english: [...new Set(english)].slice(0, 12),
    cjk: [...new Set(cjk)].slice(0, 24),
    cjkLike: [...new Set(cjkLike)].slice(0, 24),
  }
}

// Command manuals are a common knowledge-cortex workload.  A query such as
// "ls命令怎么用" contains both natural-language question wording and a tiny
// command token.  Trigram FTS cannot index that token, and a plain LIKE pass
// gives incidental mentions of `ls` (for example inside a chmod guide) the
// same weight as the actual ls.md document.  Resolve the document alias first
// and leave the hybrid search below to enrich it with related material.
function commandAliasTerms(terms = {}) {
  return (Array.isArray(terms.english) ? terms.english : [])
    .filter(term => /^[a-z][a-z0-9_.+-]{1,63}$/i.test(term))
    .slice(0, 6)
}

/**
 * Hybrid lexical search for the first knowledge-cortex release.  FTS is the
 * primary path; LIKE remains deliberately available for short CJK terms and
 * SQLite builds where the trigram tokenizer cannot satisfy a query.
 */
export function searchKnowledge({ query, regionIds = [], limit = 20, includeInactive = false } = {}) {
  const db = getDB()
  const queryText = string(query).trim()
  if (!queryText) return []
  const safeLimit = positiveLimit(limit)
  const results = []
  const seen = new Set()
  const select = `
    SELECT c.id AS chunk_id, c.document_id, c.ordinal, c.chunk_text, c.context_text, c.locator_json,
           d.title AS document_title, d.version AS document_version, d.mime_type,
           s.uri AS source_uri, s.region_id, r.name AS region_name`
  const base = `
    FROM knowledge_chunks c
    JOIN knowledge_documents d ON d.id = c.document_id
    JOIN knowledge_sources s ON s.id = d.source_id
    JOIN knowledge_regions r ON r.id = s.region_id
    WHERE c.active = 1 AND d.active = 1${includeInactive ? '' : " AND r.status = 'active'"}`

  // Quote individual tokens so punctuation is data, not FTS query syntax.
  // English content words remain conjunctive; CJK trigrams are alternatives
  // because a sentence has no reliable word boundaries.
  const terms = searchableTerms(queryText)
  if (!terms.english.length && !terms.cjk.length) terms.english.push(queryText)

  // Prefer a filename/title alias exact match before general lexical search.
  // Metadata carries the original filename on imports, while title matching
  // also supports documents that were added manually without filename data.
  for (const term of commandAliasTerms(terms)) {
    if (results.length >= safeLimit) break
    const normalized = term.toLowerCase()
    const filename = `%\"filename\":\"${normalized}.md\"%`
    const params = []
    const filter = regionFilter(regionIds, params)
    const rows = db.prepare(`
      ${select}
      ${base}${filter}
        AND (
          lower(d.title) = ?
          OR lower(d.title) LIKE ?
          OR lower(s.display_name) = ?
          OR lower(s.display_name) LIKE ?
          OR lower(d.metadata_json) LIKE ?
        )
      ORDER BY d.updated_at DESC, c.ordinal ASC
      LIMIT ?
    `).all(
      ...params,
      normalized,
      `${normalized} - %`,
      normalized,
      `${normalized}.md`,
      filename,
      safeLimit,
    )
    for (const row of rows) {
      if (seen.has(row.chunk_id)) continue
      seen.add(row.chunk_id)
      // A deliberately large score survives the later generic reranker.  It
      // represents a source identity match, not an inferred semantic score.
      results.push(resultRow(row, 'command_alias', 100))
      if (results.length >= safeLimit) break
    }
  }

  const quoteFts = term => `"${term.replaceAll('"', '""')}"`
  const englishFts = terms.english.map(quoteFts).join(' AND ')
  const cjkFts = terms.cjk.map(quoteFts).join(' OR ')
  const ftsQuery = englishFts && cjkFts
    ? `${englishFts} AND (${cjkFts})`
    : (englishFts || cjkFts)
  if (ftsQuery) {
    try {
      const params = []
      const filter = regionFilter(regionIds, params)
      const rows = db.prepare(`
        ${select}, bm25(knowledge_chunks_fts) AS fts_rank
        FROM knowledge_chunks_fts
        JOIN knowledge_chunks c ON c.id = knowledge_chunks_fts.rowid
        JOIN knowledge_documents d ON d.id = c.document_id
        JOIN knowledge_sources s ON s.id = d.source_id
        JOIN knowledge_regions r ON r.id = s.region_id
        WHERE knowledge_chunks_fts MATCH ?
          AND c.active = 1 AND d.active = 1${includeInactive ? '' : " AND r.status = 'active'"}${filter}
        ORDER BY fts_rank ASC, c.ordinal ASC
        LIMIT ?
      `).all(ftsQuery, ...params, safeLimit)
      for (const row of rows) {
        if (seen.has(row.chunk_id)) continue
        seen.add(row.chunk_id)
        results.push(resultRow(row, 'fts', -Number(row.fts_rank || 0)))
      }
    } catch {
      // LIKE below is sufficient for malformed input or a platform without a
      // compatible FTS5 tokenizer.  Search should never make a chat fail.
    }
  }

  if (results.length < safeLimit) {
    const params = []
    const filter = regionFilter(regionIds, params)
    const clause = () => `(c.chunk_text LIKE ? OR c.context_text LIKE ? OR d.title LIKE ?)`
    const englishClauses = terms.english.map(clause)
    const cjkClauses = (terms.cjkLike.length ? terms.cjkLike : terms.cjk).map(clause)
    const clauses = [
      ...englishClauses,
      ...(cjkClauses.length ? [`(${cjkClauses.join(' OR ')})`] : []),
    ]
    const likeParams = [...terms.english, ...(terms.cjkLike.length ? terms.cjkLike : terms.cjk)].flatMap(term => {
      const value = `%${term}%`
      return [value, value, value]
    })
    const rows = db.prepare(`
      ${select}
      ${base}${filter}
        AND ${clauses.join(' AND ')}
      ORDER BY d.updated_at DESC, c.ordinal ASC
      LIMIT ?
    `).all(...params, ...likeParams, safeLimit)
    for (const row of rows) {
      if (seen.has(row.chunk_id)) continue
      seen.add(row.chunk_id)
      results.push(resultRow(row, 'like', null))
      if (results.length >= safeLimit) break
    }
  }
  return results
}

export function recordKnowledgeRetrievalAudit({
  query = '',
  regionIds = [],
  matchedChunkIds = [],
  selectedCitationIds = [],
  latencyMs = null,
  source = '',
  metadata = {},
} = {}) {
  const db = getDB()
  const matched = [...new Set((matchedChunkIds || []).filter(Boolean).map(value => Number(value) || value))]
  const selected = [...new Set((selectedCitationIds || []).filter(Boolean).map(String))]
  const result = db.prepare(`
    INSERT INTO knowledge_retrieval_audit
      (query_text, region_ids_json, matched_chunk_ids, selected_citation_ids,
       matched_count, chosen_count, latency_ms, source, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    string(query), jsonString(regionIds, []), jsonString(matched, []), jsonString(selected, []),
    matched.length, selected.length, Number.isFinite(Number(latencyMs)) ? Number(latencyMs) : null,
    string(source), jsonString(metadata),
  )
  return db.prepare(`SELECT * FROM knowledge_retrieval_audit WHERE id = ?`).get(result.lastInsertRowid)
}
