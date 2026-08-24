import { createInformationItem, normalizeInformationTopic } from './envelope.js'

const SOURCE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,159}$/
const SOURCE_KINDS = new Set(['event', 'snapshot', 'query'])

function normalizeLegacyComponents(values = []) {
  return Object.freeze([...new Set((Array.isArray(values) ? values : [])
    .map(value => String(value || '').trim())
    .filter(Boolean))])
}

function normalizeSource(source = {}) {
  const id = String(source.id || '').trim()
  if (!SOURCE_ID_RE.test(id)) throw new Error('information source id is invalid')
  const kind = String(source.kind || '').trim().toLowerCase()
  if (!SOURCE_KINDS.has(kind)) throw new Error('information source kind must be event, snapshot, or query')
  const topics = Object.freeze([...new Set((Array.isArray(source.topics) ? source.topics : []).map(normalizeInformationTopic))])
  if (topics.length === 0) throw new Error('information source must declare at least one topic')
  if (kind !== 'event' && typeof source.collect !== 'function') {
    throw new Error(`information source "${id}" must define collect(request)`)
  }
  const rankValue = Number(source.rank)
  return Object.freeze({
    id,
    kind,
    topics,
    domain: String(source.domain || 'general').trim().toLowerCase(),
    description: String(source.description || '').trim(),
    legacyComponents: normalizeLegacyComponents(source.legacyComponents),
    sensitivity: String(source.sensitivity || 'normal').trim(),
    timeoutMs: Math.max(50, Math.min(30_000, Number(source.timeoutMs) || 2_000)),
    maxItems: Math.max(1, Math.min(100, Number(source.maxItems) || 20)),
    maxChars: Math.max(128, Math.min(100_000, Number(source.maxChars) || 4_000)),
    rank: Number.isFinite(rankValue) ? Math.max(0, Math.min(100, Math.round(rankValue))) : 50,
    match: typeof source.match === 'function' ? source.match : () => true,
    collect: typeof source.collect === 'function' ? source.collect : null,
    normalize: typeof source.normalize === 'function' ? source.normalize : null,
  })
}

export class InformationSourceRegistry {
  #sources = new Map()

  register(source) {
    const normalized = normalizeSource(source)
    if (this.#sources.has(normalized.id)) throw new Error(`information source "${normalized.id}" is already registered`)
    this.#sources.set(normalized.id, normalized)
    return normalized
  }

  get(id = '') {
    return this.#sources.get(String(id || '').trim()) || null
  }

  list() {
    return [...this.#sources.values()].map(({ collect, match, normalize, ...source }) => ({
      ...source,
      topics: [...source.topics],
      legacyComponents: [...source.legacyComponents],
    }))
  }

  matching(request = {}) {
    return [...this.#sources.values()].filter(source => {
      try { return source.match(request) === true } catch { return false }
    })
  }

  async collect(id, request = {}) {
    const source = this.get(id)
    if (!source) throw new Error(`unknown information source "${id}"`)
    if (source.kind === 'event') throw new Error(`event source "${id}" cannot be collected`)

    let timer
    let abortHandler = null
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`information source "${id}" timed out`)), source.timeoutMs)
    })
    const abort = request.signal
      ? new Promise((_, reject) => {
          abortHandler = () => {
            const error = new Error(String(request.signal.reason || 'information source collection aborted'))
            error.name = 'AbortError'
            reject(error)
          }
          if (request.signal.aborted) abortHandler()
          else request.signal.addEventListener('abort', abortHandler, { once: true })
        })
      : null
    try {
      const pending = [Promise.resolve().then(() => source.collect(request)), timeout]
      if (abort) pending.push(abort)
      const raw = await Promise.race(pending)
      const values = Array.isArray(raw) ? raw : (raw == null ? [] : [raw])
      const items = values.slice(0, source.maxItems).map((value, index) => {
        const normalized = source.normalize ? source.normalize(value, request) : value
        if (normalized && typeof normalized === 'object' && normalized.topic) {
          const topic = normalizeInformationTopic(normalized.topic)
          if (!source.topics.includes(topic)) {
            throw new Error(`information source "${id}" emitted undeclared topic "${topic}"`)
          }
          return createInformationItem({
            ...normalized,
            topic,
            source: { ...(normalized.source || {}), id: source.id, kind: source.kind },
          })
        }
        return createInformationItem({
          topic: source.topics[0],
          source: { id: source.id, kind: source.kind },
          semanticKind: 'system_fact',
          payload: { value: normalized, index },
          observedAt: request.now || new Date(),
        })
      })
      Object.defineProperty(items, 'sourceCollectionMeta', {
        enumerable: false,
        value: Object.freeze({
          rawItemCount: values.length,
          truncatedItemCount: Math.max(0, values.length - items.length),
        }),
      })
      return items
    } finally {
      clearTimeout(timer)
      if (abortHandler) request.signal?.removeEventListener('abort', abortHandler)
    }
  }
}

export const informationSourceRegistry = new InformationSourceRegistry()
