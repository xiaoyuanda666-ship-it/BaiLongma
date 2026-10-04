import { randomUUID } from 'node:crypto'
import { normalizeLLMApiFormat } from '../llm-api-format.js'

function normalizeActivationDraft({ provider, apiKey, model, baseURL, apiFormat } = {}) {
  return {
    provider: String(provider || 'auto').trim().toLowerCase(),
    apiKey: String(apiKey || '').trim(),
    model: String(model || '').trim(),
    baseURL: String(baseURL || '').trim().replace(/\/+$/, ''),
    apiFormat: normalizeLLMApiFormat(apiFormat),
  }
}

// A prepared result is reusable only for the connection draft that was tested.
// Keep the draft private: it contains the key and is never returned to clients.
export function createPreparedActivationStore({ now = Date.now, ttlMs = 10 * 60 * 1000 } = {}) {
  let pending = null
  return {
    storePreparedActivation({ draft, info }) {
      pending = {
        token: randomUUID(),
        draft: normalizeActivationDraft({ ...draft, apiFormat: info.apiFormat ?? draft?.apiFormat }),
        info,
        expiresAt: now() + ttlMs,
      }
      return pending
    },
    getPreparedActivation(token, draft) {
      if (!pending) return null
      if (pending.expiresAt <= now()) {
        pending = null
        return null
      }
      if (!token || pending.token !== token) return null
      const current = normalizeActivationDraft({
        ...draft,
        apiFormat: draft?.apiFormat === undefined ? pending.draft.apiFormat : draft.apiFormat,
      })
      if (Object.keys(current).some(key => current[key] !== pending.draft[key])) return null
      return pending
    },
    clearPreparedActivation() {
      pending = null
    },
  }
}
