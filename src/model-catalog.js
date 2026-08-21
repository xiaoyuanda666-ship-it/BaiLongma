import crypto from 'crypto'

export const MODEL_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000
export const MODEL_CATALOG_TIMEOUT_MS = 10 * 1000

const catalogCache = new Map()

export function buildModelCatalogURL(baseURL) {
  const value = String(baseURL || '').trim()
  if (!value) throw new Error('Model catalog requires a Base URL')

  let url
  try {
    url = new URL(value.endsWith('/') ? value : `${value}/`)
  } catch {
    throw new Error('Model catalog Base URL is invalid')
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Model catalog Base URL must use http or https')
  }
  return new URL('models', url).toString()
}

function validateModelsURL(modelsURL) {
  let url
  try {
    url = new URL(String(modelsURL || '').trim())
  } catch {
    throw new Error('Provider model catalog URL is invalid')
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Provider model catalog URL must use http or https')
  }
  return url.toString()
}

function extractModelItems(payload) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.data)) return payload.data
  if (Array.isArray(payload?.models)) return payload.models
  if (Array.isArray(payload?.output?.models)) return payload.output.models
  if (Array.isArray(payload?.output?.permissions)) return payload.output.permissions
  if (Array.isArray(payload?.result?.data)) return payload.result.data
  if (Array.isArray(payload?.result?.models)) return payload.result.models
  return []
}

export function normalizeModelCatalog(payload) {
  const seen = new Set()
  const models = []
  for (const item of extractModelItems(payload)) {
    const id = String(
      typeof item === 'string' ? item : (item?.id || item?.model || item?.name || ''),
    ).trim()
    if (!id || id.length > 256 || seen.has(id)) continue
    seen.add(id)
    const label = String(typeof item === 'object' && item?.name ? item.name : id).trim() || id
    models.push({ id, label, deprecated: false, dynamic: true })
  }
  return models.sort((a, b) => a.id.localeCompare(b.id, undefined, {
    numeric: true,
    sensitivity: 'base',
  }))
}

export function mergeModelCatalog(dynamicModels, fallbackModels = [], currentModel = '') {
  const fallbackById = new Map(
    fallbackModels.filter(item => item?.id).map(item => [item.id, item]),
  )
  const models = dynamicModels.map(item => {
    const fallback = fallbackById.get(item.id)
    return fallback ? { ...item, ...fallback, dynamic: true } : item
  })
  const current = String(currentModel || '').trim()
  if (current && !models.some(item => item.id === current)) {
    const fallback = fallbackById.get(current)
    models.unshift(fallback
      ? { ...fallback, dynamic: false, current: true }
      : { id: current, label: `${current} (current)`, deprecated: false, custom: true, current: true })
  }
  return models
}

function cacheKey(provider, baseURL, apiKey) {
  const keyHash = crypto.createHash('sha256').update(String(apiKey || '')).digest('hex').slice(0, 16)
  return `${provider}|${baseURL}|${keyHash}`
}

function fallbackResult({ fallbackModels, currentModel, error }) {
  const models = mergeModelCatalog([], fallbackModels, currentModel)
  // mergeModelCatalog intentionally only keeps the selected model when the remote
  // list is empty. For a failed lookup, retain the complete bundled catalog.
  const completeFallback = fallbackModels.map(item => ({ ...item, dynamic: false }))
  const selected = String(currentModel || '').trim()
  if (selected && !completeFallback.some(item => item.id === selected)) {
    completeFallback.unshift(models[0])
  }
  return {
    models: completeFallback,
    source: 'fallback',
    fetchedAt: null,
    warning: error?.message || String(error || 'The provider model catalog is unavailable'),
  }
}

export async function fetchModelCatalog({
  baseURL,
  modelsURL,
  apiKey,
  authType = 'bearer',
  modelFilter,
  fetchImpl = globalThis.fetch,
  timeoutMs = MODEL_CATALOG_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable')
  const requestURLs = (Array.isArray(modelsURL) ? modelsURL : [modelsURL])
    .filter(Boolean)
    .map(validateModelsURL)
  if (!requestURLs.length) requestURLs.push(buildModelCatalogURL(baseURL))
  const headers = { Accept: 'application/json' }
  const normalizedKey = String(apiKey || '').trim()
  if (normalizedKey && normalizedKey.toLowerCase() !== 'none') {
    if (authType === 'api-key') headers['api-key'] = normalizedKey
    else headers.Authorization = `Bearer ${normalizedKey}`
  }

  const errors = []
  for (const requestURL of requestURLs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(requestURL, { method: 'GET', headers, signal: controller.signal })
      if (!response?.ok) {
        let detail = ''
        try {
          const body = await response.text()
          detail = body ? `: ${body.slice(0, 300)}` : ''
        } catch {}
        throw new Error(`HTTP ${response?.status || 'unknown'}${detail}`)
      }
      const payload = await response.json()
      const normalizedModels = normalizeModelCatalog(payload)
      const models = typeof modelFilter === 'function'
        ? normalizedModels.filter(modelFilter)
        : normalizedModels
      if (!models.length) throw new Error('Provider returned an empty or unsupported model catalog')
      return models
    } catch (err) {
      const reason = err?.name === 'AbortError'
        ? `timed out after ${timeoutMs}ms`
        : (err?.message || String(err))
      errors.push(`${new URL(requestURL).host}: ${reason}`)
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(`Model catalog request failed: ${errors.join(' | ')}`)
}

export async function resolveModelCatalog({
  provider,
  baseURL,
  modelsURL,
  apiKey,
  authType,
  modelFilter,
  fallbackModels = [],
  currentModel = '',
  forceRefresh = false,
  cacheTtlMs = MODEL_CATALOG_CACHE_TTL_MS,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  const normalizedProvider = String(provider || '').trim().toLowerCase()
  const normalizedBaseURL = String(baseURL || '').trim()
  const normalizedModelsURL = Array.isArray(modelsURL)
    ? modelsURL.map(item => String(item || '').trim()).filter(Boolean)
    : String(modelsURL || '').trim()
  const normalizedKey = String(apiKey || '').trim()
  const cacheLocation = Array.isArray(normalizedModelsURL)
    ? normalizedModelsURL.join('|')
    : normalizedModelsURL
  const key = cacheKey(normalizedProvider, cacheLocation || normalizedBaseURL, normalizedKey)
  const cached = catalogCache.get(key)
  const currentTime = now()

  if (!forceRefresh && cached && currentTime - cached.timestamp < cacheTtlMs) {
    return {
      models: mergeModelCatalog(cached.models, fallbackModels, currentModel),
      source: 'cache',
      fetchedAt: cached.fetchedAt,
      warning: '',
    }
  }

  try {
    const dynamicModels = await fetchModelCatalog({
      baseURL: normalizedBaseURL,
      modelsURL: normalizedModelsURL,
      apiKey: normalizedKey,
      authType,
      modelFilter,
      fetchImpl,
    })
    const fetchedAt = new Date(currentTime).toISOString()
    catalogCache.set(key, { models: dynamicModels, fetchedAt, timestamp: currentTime })
    return {
      models: mergeModelCatalog(dynamicModels, fallbackModels, currentModel),
      source: 'dynamic',
      fetchedAt,
      warning: '',
    }
  } catch (err) {
    if (cached) {
      return {
        models: mergeModelCatalog(cached.models, fallbackModels, currentModel),
        source: 'stale-cache',
        fetchedAt: cached.fetchedAt,
        warning: err?.message || String(err),
      }
    }
    return fallbackResult({ fallbackModels, currentModel, error: err })
  }
}

export function clearModelCatalogCache() {
  catalogCache.clear()
}
