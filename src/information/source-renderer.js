import { logWarn } from '../runtime/error-logger.js'
import { buildInformationContextAudit } from './context-shadow.js'
import { ensureBuiltinProjectionInformationSources } from './projection-sources.js'
import { ensureBuiltinRuntimeInformationSources } from './runtime-sources.js'
import { collectInformationSources, compileInformationSourceFrame } from './source-collector.js'
import { informationSourceRegistry } from './source-registry.js'
import { configuredInformationDomains } from './mode.js'
import {
  buildInformationSourceCoverageAudit,
  fullySelectedInformationSourceIds,
} from './source-audit.js'
import { evaluateInformationSourceParity } from './source-parity.js'

const RENDERABLE_DOMAINS = Object.freeze([
  'runtime',
  'environment',
  'memory',
  'knowledge',
  'task',
  'constraints',
  'prefetch',
  'scene',
  'identity',
  'self',
  'capability',
])
const RENDERABLE_DOMAIN_SET = new Set(RENDERABLE_DOMAINS)

function enabledDomains(env = process.env) {
  return configuredInformationDomains({
    env,
    key: 'BAILONGMA_INFORMATION_SOURCE_RENDER',
    defaults: RENDERABLE_DOMAINS,
  })
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
  contextArgs = {},
  informationContextText = '',
} = {}, renderResult = {}) {
  const nextComponents = { ...(components || {}) }
  const nextContextArgs = { ...(contextArgs || {}) }
  if (renderResult.rendered) {
    for (const component of renderResult.legacyComponentsToSuppress || []) {
      if (Object.hasOwn(nextComponents, component)) nextComponents[component] = ''
      if (component === 'currentTime') nextContextArgs.currentTime = ''
      if (component === 'existence') nextContextArgs.existenceDesc = ''
      if (component === 'security') nextContextArgs.includeSecurityStatus = false
      if (component === 'systemEnvironment') nextContextArgs.systemEnv = ''
      if (component === 'channel') {
        nextContextArgs.currentChannel = ''
        nextContextArgs.channelSwitched = false
      }
      if (component === 'memories') nextContextArgs.memories = ''
      if (component === 'activePolicies') nextContextArgs.activePolicies = ''
      if (component === 'constraints') nextContextArgs.constraints = []
      if (component === 'knowledgeEvidence') nextContextArgs.knowledgeEvidence = ''
      if (component === 'task') nextContextArgs.includeTaskState = false
      if (component === 'personMemory') nextContextArgs.includePersonMemoryContext = false
      if (component === 'userProfile') nextContextArgs.userProfile = null
      if (component === 'selfSnapshot') nextContextArgs.selfSnapshot = null
      if (component === 'selfPerception') nextContextArgs.selfPerception = null
      if (component === 'selfEvolution') nextContextArgs.selfEvolution = ''
    }
  }
  const legacyContextText = Object.values(nextComponents).filter(Boolean).join('\n\n')
  if (Object.hasOwn(nextContextArgs, 'extraContext')) nextContextArgs.extraContext = legacyContextText
  return {
    components: nextComponents,
    contextArgs: nextContextArgs,
    legacyContextText,
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
  maxContextChars = 64_000,
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
    const completenessFrame = compileInformationSourceFrame({
      ...collection,
      candidates: collection.candidates.filter(candidate => (
        fullySelectedSourceIds.has(candidate.source.id)
      )),
    }, {
      now: request.now || new Date(),
      maxContextChars,
    })
    const parity = evaluateInformationSourceParity({
      domains: activeDomains,
      request,
      frame: completenessFrame,
      collection,
    })
    const parityPassedDomains = new Set(parity.passedDomains)
    const frame = compileInformationSourceFrame({
      ...collection,
      candidates: collection.candidates.filter(candidate => (
        fullySelectedSourceIds.has(candidate.source.id)
        && parityPassedDomains.has(candidate.source.domain)
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
      parity,
      audit: {
        ...baseAudit,
        ...collection.audit,
        ...coverageAudit,
        ...parity.audit,
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
