// Automatic Knowledge Cortex retrieval.  This is deliberately not part of
// memory/injector: document evidence has source/version provenance and a
// different retention lifecycle from autobiographical memories.

import {
  listKnowledgeRegions,
  searchKnowledge,
  recordKnowledgeRetrievalAudit,
} from '../db.js'
import {
  buildKnowledgeQuery,
  shouldRetrieveKnowledge,
  rerankEvidence,
  formatKnowledgeEvidence,
} from './index.js'

const DEFAULT_LIMIT = 6
const CANDIDATE_MULTIPLIER = 3

function boundedLimit(value, fallback = DEFAULT_LIMIT) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(20, Math.floor(parsed)))
}

/**
 * Retrieve a small, cited evidence packet for the current question.  Retrieval
 * is fail-open: a malformed source or unavailable DB must never block a chat
 * reply.  Callers get diagnostics for observability without exposing them in
 * the prompt.
 */
export async function runKnowledgeInjector({
  query = '',
  task = '',
  hint = '',
  limit = DEFAULT_LIMIT,
  maxChars = 6000,
  source = 'turn',
} = {}) {
  const startedAt = Date.now()
  const resolvedLimit = boundedLimit(limit)
  const plannedQuery = buildKnowledgeQuery({ query, task, hint })
  const base = {
    query: plannedQuery,
    regions: [],
    candidates: [],
    evidence: [],
    evidenceText: '',
    skipped: true,
    reason: '',
  }

  try {
    const regions = listKnowledgeRegions({ limit: 100 })
    const regionIds = regions.map(region => region.id).filter(Boolean)
    base.regions = regions
    if (!shouldRetrieveKnowledge({ query, task, hasActiveRegion: regionIds.length > 0 })) {
      base.reason = regionIds.length ? 'query_not_eligible' : 'no_active_region'
      return base
    }

    const candidates = searchKnowledge({
      query: plannedQuery,
      regionIds,
      limit: Math.max(resolvedLimit * CANDIDATE_MULTIPLIER, resolvedLimit),
    })
    const evidence = rerankEvidence(candidates, { query: plannedQuery, limit: resolvedLimit })
    const evidenceText = formatKnowledgeEvidence(evidence, { maxChars })
    const result = {
      ...base,
      candidates,
      evidence,
      evidenceText,
      skipped: false,
      reason: evidence.length ? 'retrieved' : 'no_match',
    }

    // Audit is best-effort only.  It records ids and latency rather than
    // duplicating source text, so it remains cheap even for large documents.
    try {
      recordKnowledgeRetrievalAudit({
        query: plannedQuery,
        regionIds,
        matchedChunkIds: candidates.map(item => item.chunk_id || item.id).filter(Boolean),
        selectedCitationIds: evidence.map(item => item.citation_id).filter(Boolean),
        latencyMs: Date.now() - startedAt,
        source,
        metadata: { reason: result.reason },
      })
    } catch {}
    return result
  } catch (error) {
    return { ...base, reason: 'unavailable', error: error?.message || String(error) }
  }
}
