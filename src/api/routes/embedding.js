import { jsonResponse, readJsonBody } from '../utils.js'

export async function handleEmbeddingRoutes(req, res, url) {
  if (req.method === 'POST' && url.pathname === '/settings/embedding/test') {
    try {
      const { computeEmbedding, isEmbeddingConfigured } = await import('../../embedding.js')
      if (!isEmbeddingConfigured()) {
        jsonResponse(res, 200, { ok: false, error: 'embedding not configured - save provider/model/apiKey first' })
        return true
      }
      const t0 = Date.now()
      const buf = await computeEmbedding('embedding connectivity test')
      if (!buf) {
        jsonResponse(res, 200, { ok: false, error: 'computeEmbedding returned null - check apiKey / baseURL / model name; see server log if any' })
        return true
      }
      const elapsed = Date.now() - t0
      const dims = buf.byteLength / 4
      jsonResponse(res, 200, { ok: true, dims, elapsedMs: elapsed })
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/memory/embedding-backfill') {
    try {
      const { getBackfillStatus } = await import('../../memory/embedding-backfill.js')
      jsonResponse(res, 200, { ok: true, status: getBackfillStatus() })
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/memory/embedding-backfill') {
    try {
      const { runBackfill, getBackfillStatus } = await import('../../memory/embedding-backfill.js')
      const { isEmbeddingConfigured } = await import('../../embedding.js')
      if (!isEmbeddingConfigured()) {
        jsonResponse(res, 200, { ok: false, error: 'embedding not configured' })
        return true
      }
      const beforeStatus = getBackfillStatus()
      if (beforeStatus.running) {
        jsonResponse(res, 200, { ok: true, started: false, reason: 'already running', status: beforeStatus })
        return true
      }
      let force = false
      try {
        const body = await readJsonBody(req)
        force = !!body.force
      } catch (err) {
        if (err.statusCode === 413 || req.aborted) throw err
      }
      runBackfill({ batchSize: 20, throttleMs: 200, force }).catch(() => {})
      jsonResponse(res, 200, { ok: true, started: true, force, status: getBackfillStatus() })
    } catch (err) {
      jsonResponse(res, err.statusCode === 413 ? 413 : 500, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'DELETE' && url.pathname === '/memory/embedding-backfill') {
    try {
      const { cancelBackfill } = await import('../../memory/embedding-backfill.js')
      cancelBackfill()
      jsonResponse(res, 200, { ok: true, cancelled: true })
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message })
    }
    return true
  }

  return false
}
