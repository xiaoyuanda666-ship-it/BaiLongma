import { createMergedAbortSignal, throwIfAborted } from '../capabilities/abort-utils.js'
import { redactModelSecret } from '../providers/model-http.js'

// Search calls have their own request accounting; they do not consume chat RPM/TPM.
const usage = new Map()
export const getSearchUsage = () => Object.fromEntries(usage)
export async function postModelJSON(connection, endpoint, body, { signal, fetchImpl = globalThis.fetch } = {}) {
  const merged = createMergedAbortSignal(signal, 30_000)
  const id = connection.id || connection.provider
  const stats = usage.get(id) || { requests: 0, failures: 0, tokens: 0 }
  usage.set(id, stats)
  try {
    throwIfAborted(signal)
    stats.requests++
    const response = await fetchImpl(`${connection.baseURL.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`, {
      method: 'POST', redirect: 'error', signal: merged.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.apiKey}` },
      body: JSON.stringify(body),
    })
    let data
    try { data = await response.json() } catch {
      throw Object.assign(new Error(`搜索服务返回无效 JSON（HTTP ${response.status}）`), { retryable: merged.signal.aborted || [408, 429].includes(response.status) || response.status >= 500 })
    }
    const providerError = data?.error || data?.Response?.Error
    if (!response.ok || providerError) {
      const code = providerError?.Code || providerError?.code || ''
      throw Object.assign(new Error(`HTTP ${response.status}: ${providerError?.Message || providerError?.message || data?.message || code || '搜索失败'}`), {
        retryable: [408, 429].includes(response.status) || response.status >= 500 || /^(RequestLimitExceeded|InternalError)(\.|$)/.test(code),
      })
    }
    stats.tokens += Number(data?.usage?.total_tokens) || 0
    return data
  } catch (error) {
    stats.failures++
    throwIfAborted(signal)
    throw Object.assign(new Error(redactModelSecret(error.message, connection.apiKey).slice(0, 1000)), {
      retryable: error.retryable ?? (merged.signal.aborted || error instanceof TypeError),
    })
  } finally { merged.cleanup() }
}
