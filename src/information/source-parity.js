import crypto from 'node:crypto'

function cleanText(value) {
  return String(value || '').trim()
}

function safeJsonArray(value) {
  if (Array.isArray(value)) return value
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]))
}

function stableJson(value) {
  return JSON.stringify(stableValue(value))
}

function hash(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex')
}

function sortedRecords(records = []) {
  return [...records].sort((left, right) => stableJson(left).localeCompare(stableJson(right)))
}

function envelopeFields(event = {}) {
  return {
    authorship: cleanText(event.authorship),
    semanticKind: cleanText(event.semanticKind),
    trust: cleanText(event.trust),
  }
}

function expectedConstraints(request = {}) {
  return (request.constraintsProjection || [])
    .filter(constraint => cleanText(constraint?.content))
    .map((constraint, index) => {
      const tags = safeJsonArray(constraint.tags).map(String)
      return {
        id: String(constraint.mem_id || constraint.id || `projection-${index + 1}`),
        content: cleanText(constraint.content),
        detail: cleanText(constraint.detail),
        dimension: tags.find(tag => tag.startsWith('dimension:'))?.slice('dimension:'.length) || '',
        tags,
        authorship: 'system',
        semanticKind: 'policy',
        trust: 'authoritative',
      }
    })
}

function actualConstraints(events = []) {
  return events
    .filter(event => event.topic === 'policy.behavioral_constraint')
    .map(event => ({
      id: cleanText(event.subject?.constraintId),
      content: cleanText(event.payload?.content),
      detail: cleanText(event.payload?.detail),
      dimension: cleanText(event.payload?.dimension),
      tags: safeJsonArray(event.payload?.tags).map(String),
      ...envelopeFields(event),
    }))
}

function expectedPrefetch(request = {}) {
  return (request.prefetchProjection || [])
    .filter(item => cleanText(item?.content))
    .map((item, index) => ({
      id: item.id == null ? '' : String(item.id),
      provider: cleanText(item.source) || `prefetch-${index + 1}`,
      content: cleanText(item.content),
      tags: safeJsonArray(item.tags).map(String),
      fetchedAt: cleanText(item.fetched_at),
      expiresAt: cleanText(item.expires_at),
      authorship: 'external',
      semanticKind: 'knowledge',
      trust: 'observed',
    }))
}

function actualPrefetch(events = []) {
  return events
    .filter(event => event.topic === 'knowledge.prefetched')
    .map(event => ({
      id: event.subject?.cacheId == null ? '' : String(event.subject.cacheId),
      provider: cleanText(event.payload?.provider),
      content: cleanText(event.payload?.content),
      tags: safeJsonArray(event.payload?.tags).map(String),
      fetchedAt: cleanText(event.payload?.fetchedAt),
      expiresAt: cleanText(event.payload?.expiresAt),
      ...envelopeFields(event),
    }))
}

function sceneRecord(surface = {}, event = null) {
  return {
    id: cleanText(surface.id),
    kind: cleanText(surface.kind),
    intent: cleanText(surface.intent) || 'inform',
    focus: surface.focus === true,
    authorship: event ? cleanText(event.authorship) : 'system',
    semanticKind: event ? cleanText(event.semanticKind) : 'ui_signal',
    trust: event ? cleanText(event.trust) : 'authoritative',
  }
}

function expectedScene(request = {}) {
  return (request.sceneProjection?.manifest || []).map(surface => sceneRecord(surface))
}

function actualScene(events = []) {
  return events
    .filter(event => event.topic === 'ui.scene_manifest')
    .flatMap(event => (event.payload?.surfaces || []).map(surface => sceneRecord(surface, event)))
}

const DOMAIN_PARITY = Object.freeze({
  constraints: { expected: expectedConstraints, actual: actualConstraints },
  prefetch: { expected: expectedPrefetch, actual: actualPrefetch },
  scene: { expected: expectedScene, actual: actualScene },
})

function eventsByDomain(frame = {}, collection = {}) {
  const domainsBySourceId = new Map((collection.results || []).map(result => (
    [result.source.id, result.source.domain]
  )))
  const byDomain = new Map()
  for (const item of frame.contextItems || []) {
    const event = item.event || {}
    const domain = domainsBySourceId.get(event.source?.id) || ''
    if (!domain) continue
    const events = byDomain.get(domain) || []
    events.push(event)
    byDomain.set(domain, events)
  }
  return byDomain
}

export function evaluateInformationSourceParity({
  domains = [],
  request = {},
  frame = {},
  collection = {},
} = {}) {
  const domainEvents = eventsByDomain(frame, collection)
  const byDomain = {}
  const passedDomains = []
  const failedDomains = []

  for (const domain of [...new Set(domains.map(value => cleanText(value).toLowerCase()).filter(Boolean))]) {
    const adapter = DOMAIN_PARITY[domain]
    if (!adapter) {
      byDomain[domain] = {
        passed: false,
        reason: 'missing_parity_adapter',
        expectedRecordCount: 0,
        actualRecordCount: 0,
        expectedHash: '',
        actualHash: '',
      }
      failedDomains.push(domain)
      continue
    }
    const expected = sortedRecords(adapter.expected(request))
    const actual = sortedRecords(adapter.actual(domainEvents.get(domain) || []))
    const expectedHash = hash(expected)
    const actualHash = hash(actual)
    const passed = expectedHash === actualHash
    byDomain[domain] = {
      passed,
      reason: passed ? 'semantic_match' : 'semantic_mismatch',
      expectedRecordCount: expected.length,
      actualRecordCount: actual.length,
      expectedHash,
      actualHash,
    }
    if (passed) passedDomains.push(domain)
    else failedDomains.push(domain)
  }

  return {
    passed: failedDomains.length === 0,
    passedDomains,
    failedDomains,
    byDomain,
    audit: {
      parityDomainCount: Object.keys(byDomain).length,
      parityPassedDomainCount: passedDomains.length,
      parityFailedDomainCount: failedDomains.length,
      parityByDomain: Object.fromEntries(Object.entries(byDomain).map(([domain, result]) => (
        [domain, result.passed ? 1 : 0]
      ))),
      parityExpectedRecordsByDomain: Object.fromEntries(Object.entries(byDomain).map(([domain, result]) => (
        [domain, result.expectedRecordCount]
      ))),
      parityActualRecordsByDomain: Object.fromEntries(Object.entries(byDomain).map(([domain, result]) => (
        [domain, result.actualRecordCount]
      ))),
    },
  }
}
