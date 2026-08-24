import { compileInformationContextFrame } from './context-frame.js'
import { informationSourceRegistry } from './source-registry.js'

function requestedSet(values = []) {
  return new Set((Array.isArray(values) ? values : [])
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean))
}

function sourceCandidate(item, source) {
  return {
    event: item,
    route: {
      id: `pull:${source.id}`,
      context: {
        semanticKind: item.semanticKind,
        maxChars: source.maxChars,
        rank: source.rank,
      },
    },
    source: {
      id: source.id,
      domain: source.domain,
      kind: source.kind,
    },
  }
}

export async function collectInformationSources({
  registry = informationSourceRegistry,
  request = {},
  sourceIds = [],
  domains = [],
} = {}) {
  const ids = requestedSet(sourceIds)
  const requestedDomains = requestedSet(domains)
  const sources = registry.matching(request).filter(source => (
    source.kind !== 'event'
    && (ids.size === 0 || ids.has(source.id.toLowerCase()))
    && (requestedDomains.size === 0 || requestedDomains.has(source.domain))
  ))

  const results = await Promise.all(sources.map(async source => {
    const startedAt = Date.now()
    try {
      const items = await registry.collect(source.id, request)
      for (const item of items) {
        if (item.authorship === 'user' || item.semanticKind === 'user_input') {
          throw new Error(`pull source "${source.id}" cannot emit user input`)
        }
      }
      return {
        source,
        ok: true,
        items,
        latencyMs: Date.now() - startedAt,
        error: '',
      }
    } catch (error) {
      return {
        source,
        ok: false,
        items: [],
        latencyMs: Date.now() - startedAt,
        error: String(error?.message || error).slice(0, 500),
      }
    }
  }))

  const candidates = results.flatMap(result => (
    result.items.map(item => sourceCandidate(item, result.source))
  ))
  return {
    request,
    results,
    candidates,
    items: candidates.map(candidate => candidate.event),
    audit: {
      sourceCount: results.length,
      succeededSourceCount: results.filter(result => result.ok).length,
      failedSourceCount: results.filter(result => !result.ok).length,
      itemCount: candidates.length,
      sourceItemsById: Object.fromEntries(results.map(result => [result.source.id, result.items.length])),
      sourceLatencyMsById: Object.fromEntries(results.map(result => [result.source.id, result.latencyMs])),
      sourceErrorsById: Object.fromEntries(
        results.filter(result => !result.ok).map(result => [result.source.id, result.error]),
      ),
    },
  }
}

export function compileInformationSourceFrame(collection = {}, {
  now = collection.request?.now || new Date(),
  maxContextChars = 24_000,
} = {}) {
  return compileInformationContextFrame({
    candidates: collection.candidates || [],
    now,
    maxContextChars,
  })
}
