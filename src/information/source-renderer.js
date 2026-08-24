import { logWarn } from '../runtime/error-logger.js'
import { buildInformationContextAudit } from './context-shadow.js'
import { ensureBuiltinProjectionInformationSources } from './projection-sources.js'
import { ensureBuiltinRuntimeInformationSources } from './runtime-sources.js'
import { collectInformationSources, compileInformationSourceFrame } from './source-collector.js'
import { informationSourceRegistry } from './source-registry.js'
import {
  buildInformationSourceCoverageAudit,
  fullySelectedInformationSourceIds,
} from './source-audit.js'

const RENDERABLE_DOMAINS = Object.freeze(['scene', 'prefetch'])
const RENDERABLE_DOMAIN_SET = new Set(RENDERABLE_DOMAINS)

function enabledDomains(env = process.env) {
  return new Set(String(env.BAILONGMA_INFORMATION_SOURCE_RENDER || '')
    .trim()
    .toLowerCase()
    .split(/[\s,;]+/)
    .filter(Boolean))
}

export function listInformationSourceRenderableDomains() {
  return [...RENDERABLE_DOMAINS]
}

export function isInformationSourceRenderEnabled(domain, env = process.env) {
  const normalized = String(domain || '').trim().toLowerCase()
  if (!RENDERABLE_DOMAIN_SET.has(normalized)) return false
  const enabled = enabledDomains(env)
  return enabled.has('all') || enabled.has(normalized)
}

export function applyInformationSourceRender({
  components = {},
  informationContextText = '',
} = {}, renderResult = {}) {
  const nextComponents = { ...(components || {}) }
  if (renderResult.rendered) {
    for (const component of renderResult.legacyComponentsToSuppress || []) {
      if (Object.hasOwn(nextComponents, component)) nextComponents[component] = ''
    }
  }
  return {
    components: nextComponents,
    legacyContextText: Object.values(nextComponents).filter(Boolean).join('\n\n'),
    informationContextText: [
      informationContextText,
      renderResult.rendered ? renderResult.contextText : '',
    ].filter(Boolean).join('\n\n'),
  }
}

export async function renderInformationSourceContext({
  request = {},
  legacyComponents = {},
  domains = RENDERABLE_DOMAINS,
  maxContextChars = 12_000,
} = {}, {
  env = process.env,
  registry = informationSourceRegistry,
} = {}) {
  const activeDomains = (Array.isArray(domains) ? domains : [])
    .map(domain => String(domain || '').trim().toLowerCase())
    .filter(domain => isInformationSourceRenderEnabled(domain, env))
  if (activeDomains.length === 0) {
    return {
      enabled: false,
      rendered: false,
      domains: [],
      legacyComponentsToSuppress: [],
      contextText: '',
    }
  }

  try {
    ensureBuiltinRuntimeInformationSources({ registry })
    ensureBuiltinProjectionInformationSources({ registry })
    const collection = await collectInformationSources({ registry, request, domains: activeDomains })
    const candidateFrame = compileInformationSourceFrame(collection, {
      now: request.now || new Date(),
      maxContextChars,
    })
    const fullySelectedSourceIds = fullySelectedInformationSourceIds(candidateFrame, collection)
    const frame = compileInformationSourceFrame({
      ...collection,
      candidates: collection.candidates.filter(candidate => (
        fullySelectedSourceIds.has(candidate.source.id)
      )),
    }, {
      now: request.now || new Date(),
      maxContextChars,
    })
    const baseAudit = buildInformationContextAudit(frame, {
      legacyComponents,
      mode: 'source_render',
    })
    const coverageAudit = buildInformationSourceCoverageAudit(baseAudit, frame, collection)
    const legacyComponentsToSuppress = Object.entries(coverageAudit.legacyCoverageByComponent || {})
      .filter(([, covered]) => covered === 1)
      .map(([component]) => component)
      .sort()
    return {
      enabled: true,
      rendered: frame.contextItems.length > 0,
      domains: activeDomains,
      legacyComponentsToSuppress,
      contextText: frame.contextText,
      collection,
      frame,
      audit: {
        ...baseAudit,
        ...collection.audit,
        ...coverageAudit,
        renderDomainCount: activeDomains.length,
        suppressedLegacyComponentCount: legacyComponentsToSuppress.length,
      },
    }
  } catch (error) {
    logWarn(error, {
      scope: 'information.source_renderer',
      operation: 'collect_compile_render',
      metadata: { domains: activeDomains.join(',') },
    })
    return {
      enabled: true,
      rendered: false,
      domains: activeDomains,
      legacyComponentsToSuppress: [],
      contextText: '',
      error: error?.message || String(error),
    }
  }
}
