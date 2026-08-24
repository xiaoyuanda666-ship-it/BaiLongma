import { logWarn } from '../runtime/error-logger.js'
import { buildInformationContextAudit } from './context-shadow.js'
import { ensureBuiltinProjectionInformationSources } from './projection-sources.js'
import { ensureBuiltinRuntimeInformationSources } from './runtime-sources.js'
import { collectInformationSources, compileInformationSourceFrame } from './source-collector.js'
import { informationSourceRegistry } from './source-registry.js'

function enabledDomains(env = process.env) {
  return new Set(String(env.BAILONGMA_INFORMATION_SOURCE_SHADOW || '')
    .trim()
    .toLowerCase()
    .split(/[\s,;]+/)
    .filter(Boolean))
}

export function isInformationSourceShadowEnabled(domain, env = process.env) {
  const normalized = String(domain || '').trim().toLowerCase()
  if (!normalized) return false
  const enabled = enabledDomains(env)
  return enabled.has('all') || enabled.has(normalized)
}

function countSelectedItemsByDomain(frame, collection) {
  const domainsBySourceId = new Map((collection.results || []).map(result => (
    [result.source.id, result.source.domain]
  )))
  const counts = {}
  for (const item of frame.contextItems || []) {
    const domain = domainsBySourceId.get(item.event?.source?.id) || 'general'
    counts[domain] = (counts[domain] || 0) + 1
  }
  return counts
}

function buildLegacyCoverageAudit(baseAudit, frame, collection) {
  const selectedItemCountsBySource = {}
  for (const item of frame.contextItems || []) {
    const sourceId = String(item.event?.source?.id || '').trim()
    if (sourceId) selectedItemCountsBySource[sourceId] = (selectedItemCountsBySource[sourceId] || 0) + 1
  }
  const coveredComponents = new Set((collection.results || [])
    .filter(result => (
      result.ok
      && result.items.length > 0
      && selectedItemCountsBySource[result.source.id] === result.items.length
    ))
    .flatMap(result => result.source.legacyComponents || []))
  const legacyEntries = Object.entries(baseAudit.legacyCharsByComponent || {})
  const legacyCoverageByComponent = Object.fromEntries(legacyEntries.map(([name]) => (
    [name, coveredComponents.has(name) ? 1 : 0]
  )))
  const legacyCoveredChars = legacyEntries.reduce((sum, [name, chars]) => (
    sum + (coveredComponents.has(name) ? chars : 0)
  ), 0)
  const legacyContextChars = Number(baseAudit.legacyContextChars) || 0
  return {
    sourceItemsByDomain: collection.audit.sourceItemsByDomain || {},
    selectedSourceItemsByDomain: countSelectedItemsByDomain(frame, collection),
    legacyCoveredComponentCount: Object.values(legacyCoverageByComponent).filter(Boolean).length,
    legacyUncoveredComponentCount: Object.values(legacyCoverageByComponent).filter(value => !value).length,
    legacyCoveredChars,
    legacyUncoveredChars: Math.max(0, legacyContextChars - legacyCoveredChars),
    legacyCoveragePermille: legacyContextChars > 0
      ? Math.round((legacyCoveredChars * 1_000) / legacyContextChars)
      : 1_000,
    sourceToLegacyCharRatioPermille: legacyContextChars > 0
      ? Math.round((Number(frame.audit?.contextChars || 0) * 1_000) / legacyContextChars)
      : 0,
    legacyCoverageByComponent,
  }
}

export async function observeInformationSourceShadow({
  request = {},
  legacyComponents = {},
  domains = ['runtime', 'environment'],
  maxContextChars = 24_000,
} = {}, {
  env = process.env,
  registry = informationSourceRegistry,
} = {}) {
  const activeDomains = (Array.isArray(domains) ? domains : [])
    .map(domain => String(domain || '').trim().toLowerCase())
    .filter(domain => isInformationSourceShadowEnabled(domain, env))
  if (activeDomains.length === 0) return { enabled: false, observed: false }

  try {
    ensureBuiltinRuntimeInformationSources({ registry })
    ensureBuiltinProjectionInformationSources({ registry })
    const collection = await collectInformationSources({ registry, request, domains: activeDomains })
    const frame = compileInformationSourceFrame(collection, {
      now: request.now || new Date(),
      maxContextChars,
    })
    const baseAudit = buildInformationContextAudit(frame, {
      legacyComponents,
      mode: 'source_shadow',
    })
    return {
      enabled: true,
      observed: true,
      collection,
      frame,
      audit: {
        ...baseAudit,
        ...collection.audit,
        ...buildLegacyCoverageAudit(baseAudit, frame, collection),
      },
    }
  } catch (error) {
    logWarn(error, {
      scope: 'information.source_shadow',
      operation: 'collect_and_compile',
      metadata: { domains: activeDomains.join(',') },
    })
    return { enabled: true, observed: false, error: error?.message || String(error) }
  }
}
