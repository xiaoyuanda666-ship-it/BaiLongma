import { createMergedAbortSignal, throwIfAborted } from '../capabilities/abort-utils.js'
import { recordUsage, shouldThrottle } from '../quota.js'
import { stringifyJsonForTransport } from '../runtime/json-unicode.js'

export function redactModelSecret(value, key = '') {
  const text = String(value || '')
  return (key ? text.split(key).join('[redacted]') : text)
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
}

export async function postModelJSON(connection, endpoint, body, { signal, fetchImpl = globalThis.fetch } = {}) {
  const merged = createMergedAbortSignal(signal, 60_000)
  try {
    throwIfAborted(signal)
    if (shouldThrottle()) throw new Error('模型调用配额接近上限，请稍后重试')
    const url = `${connection.baseURL.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`
    const response = await fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.apiKey}` },
      body: stringifyJsonForTransport(body),
      signal: merged.signal,
    })
    let data
    try { data = await response.json() } catch { throw new Error(`模型服务返回无效 JSON（HTTP ${response.status}）`) }
    if (!response.ok || data?.error) {
      throw new Error(`HTTP ${response.status}: ${data?.error?.message || data?.message || '模型服务请求失败'}`)
    }
    recordUsage(Number(data?.usage?.total_tokens) || 0)
    return data
  } catch (error) {
    throwIfAborted(signal)
    throw new Error(redactModelSecret(error.message, connection.apiKey).slice(0, 1000))
  } finally {
    merged.cleanup()
  }
}
