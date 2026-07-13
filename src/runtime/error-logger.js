const MAX_STRING_LENGTH = 240
const MAX_METADATA_DEPTH = 3
const MAX_ARRAY_ITEMS = 20
const MAX_OBJECT_KEYS = 30

const SECRET_KEY_RE = /(api[_-]?key|token|secret|password|authorization|credential|private[_-]?key|access[_-]?key|refresh[_-]?token)/i
const PRIVATE_TEXT_KEY_RE = /(prompt|message|content|body|args?|arguments?|result|response|input|query|text|summary|detail)/i

const stats = {
  total: 0,
  byKey: {},
  lastErrorAt: null,
  lastMessage: null,
}

function keyFor(scope = 'runtime', operation = 'unknown') {
  return `${scope || 'runtime'}.${operation || 'unknown'}`
}

function normalizeSeverity(severity) {
  return severity === 'warn' || severity === 'warning' ? 'warn' : 'error'
}

function truncateString(value, max = MAX_STRING_LENGTH) {
  const str = String(value)
  if (str.length <= max) return str
  return `${str.slice(0, max)}... [truncated ${str.length - max} chars]`
}

function redactTextValue(value) {
  if (typeof value !== 'string') return value
  return `[redacted text: ${value.length} chars]`
}

export function sanitizeMetadata(metadata = {}, depth = 0) {
  if (metadata === null || metadata === undefined) return metadata
  if (depth >= MAX_METADATA_DEPTH) return '[truncated depth]'

  if (typeof metadata === 'string') return truncateString(metadata)
  if (typeof metadata === 'number' || typeof metadata === 'boolean') return metadata
  if (metadata instanceof Date) return metadata.toISOString()
  if (metadata instanceof Error) {
    return {
      name: metadata.name || 'Error',
      message: truncateString(metadata.message || ''),
    }
  }

  if (Array.isArray(metadata)) {
    const items = metadata.slice(0, MAX_ARRAY_ITEMS).map(item => sanitizeMetadata(item, depth + 1))
    if (metadata.length > MAX_ARRAY_ITEMS) items.push(`[truncated ${metadata.length - MAX_ARRAY_ITEMS} items]`)
    return items
  }

  if (typeof metadata !== 'object') return truncateString(String(metadata))

  const out = {}
  const entries = Object.entries(metadata).slice(0, MAX_OBJECT_KEYS)
  for (const [key, value] of entries) {
    if (SECRET_KEY_RE.test(key)) {
      out[key] = '[redacted]'
      continue
    }
    if (PRIVATE_TEXT_KEY_RE.test(key)) {
      out[key] = typeof value === 'string' ? redactTextValue(value) : '[redacted]'
      continue
    }
    out[key] = sanitizeMetadata(value, depth + 1)
  }
  const extra = Object.keys(metadata).length - entries.length
  if (extra > 0) out.__truncatedKeys = extra
  return out
}

function errorInfo(errorOrMessage) {
  if (errorOrMessage instanceof Error) {
    return {
      name: errorOrMessage.name || 'Error',
      message: truncateString(errorOrMessage.message || ''),
      stack: errorOrMessage.stack || `${errorOrMessage.name || 'Error'}: ${errorOrMessage.message || ''}`,
    }
  }
  const message = truncateString(String(errorOrMessage ?? 'Unknown error'))
  return {
    name: 'Error',
    message,
    stack: message,
  }
}

function record({ key, message }) {
  const now = new Date().toISOString()
  stats.total += 1
  stats.lastErrorAt = now
  stats.lastMessage = message
  const entry = stats.byKey[key] || { count: 0, lastErrorAt: null, lastMessage: null }
  entry.count += 1
  entry.lastErrorAt = now
  entry.lastMessage = message
  stats.byKey[key] = entry
}

export function logError(error, {
  scope = 'runtime',
  operation = 'unknown',
  severity = 'error',
  metadata = {},
} = {}) {
  const normalizedSeverity = normalizeSeverity(severity)
  const key = keyFor(scope, operation)
  const info = errorInfo(error)
  record({ key, message: info.message })

  const payload = {
    scope,
    operation,
    severity: normalizedSeverity,
    message: info.message,
    stack: info.stack,
    metadata: sanitizeMetadata(metadata),
  }

  const line = `[${normalizedSeverity}] ${key}: ${info.message}`
  const sink = normalizedSeverity === 'warn' ? console.warn : console.error
  sink(line)
  sink(payload)
  return payload
}

export function logWarn(errorOrMessage, options = {}) {
  return logError(errorOrMessage, { ...options, severity: 'warn' })
}

export function getErrorStats() {
  return {
    total: stats.total,
    byKey: Object.fromEntries(
      Object.entries(stats.byKey).map(([key, value]) => [key, { ...value }])
    ),
    lastErrorAt: stats.lastErrorAt,
    lastMessage: stats.lastMessage,
  }
}

export function resetErrorStatsForTest() {
  stats.total = 0
  stats.byKey = {}
  stats.lastErrorAt = null
  stats.lastMessage = null
}
