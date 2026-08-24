import { logWarn } from '../runtime/error-logger.js'
import { buildInformationContextAudit } from './context-shadow.js'
import { ensureBuiltinProjectionInformationSources } from './projection-sources.js'
import { ensureBuiltinRuntimeInformationSources } from './runtime-sources.js'
import { collectInformationSources, compileInformationSourceFrame } from './source-collector.js'
import { informationSourceRegistry } from './source-registry.js'
import { buildInformationSourceCoverageAudit } from './source-audit.js'

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
        ...buildInformationSourceCoverageAudit(baseAudit, frame, collection),
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
