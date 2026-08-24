import { buildSystemEnvironmentContext } from '../context/system-environment-context.js'
import { informationSourceRegistry } from './source-registry.js'

const initializedRegistries = new WeakSet()

function observedAt(request = {}) {
  const value = request.now instanceof Date ? request.now : new Date(request.now || Date.now())
  return Number.isFinite(value.getTime()) ? value : new Date()
}

function contextItem({ topic, semanticKind = 'system_fact', payload, request, sensitivity = 'private', trust = 'observed', subject = {} }) {
  const time = observedAt(request)
  return {
    topic,
    subject,
    authorship: 'system',
    semanticKind,
    payload,
    occurredAt: time,
    observedAt: time,
    priority: 50,
    sensitivity,
    trust,
  }
}

export function ensureBuiltinRuntimeInformationSources({ registry = informationSourceRegistry } = {}) {
  if (initializedRegistries.has(registry)) return []
  const registered = []

  registered.push(registry.register({
    id: 'runtime:clock',
    kind: 'snapshot',
    domain: 'runtime',
    topics: ['runtime.clock'],
    description: 'Authoritative local clock sampled for the current turn.',
    legacyComponents: ['currentTime'],
    sensitivity: 'normal',
    timeoutMs: 250,
    maxItems: 1,
    maxChars: 1_200,
    rank: 90,
    collect: request => {
      const time = observedAt(request)
      return contextItem({
        topic: 'runtime.clock',
        request,
        sensitivity: 'normal',
        trust: 'authoritative',
        payload: {
          localTimestamp: request.currentTime || time.toISOString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'system-local',
          weekday: new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(time),
        },
      })
    },
  }))

  registered.push(registry.register({
    id: 'runtime:existence',
    kind: 'snapshot',
    domain: 'runtime',
    topics: ['runtime.existence'],
    description: 'Current agent existence duration projected from the legacy runtime context.',
    legacyComponents: ['existence'],
    sensitivity: 'normal',
    timeoutMs: 250,
    maxItems: 1,
    maxChars: 1_200,
    rank: 88,
    match: request => !!String(request.existenceDesc || '').trim(),
    collect: request => contextItem({
      topic: 'runtime.existence',
      request,
      sensitivity: 'normal',
      trust: 'authoritative',
      payload: { description: String(request.existenceDesc || '').trim() },
    }),
  }))

  registered.push(registry.register({
    id: 'runtime:security',
    kind: 'snapshot',
    domain: 'runtime',
    topics: ['runtime.security'],
    description: 'Effective runtime sandbox settings for the current turn.',
    legacyComponents: ['security'],
    sensitivity: 'private',
    timeoutMs: 250,
    maxItems: 1,
    maxChars: 2_000,
    rank: 96,
    match: request => !!request.securityProjection,
    collect: request => contextItem({
      topic: 'runtime.security',
      request,
      trust: 'authoritative',
      payload: {
        fileSandboxEnabled: request.securityProjection?.fileSandbox !== false,
        execSandboxEnabled: request.securityProjection?.execSandbox !== false,
        changedAt: String(request.securityProjection?.updatedAt || ''),
      },
    }),
  }))

  registered.push(registry.register({
    id: 'runtime:channel',
    kind: 'snapshot',
    domain: 'runtime',
    topics: ['runtime.channel'],
    description: 'Incoming channel and channel-switch state for this turn.',
    legacyComponents: ['channel'],
    sensitivity: 'private',
    timeoutMs: 250,
    maxItems: 1,
    maxChars: 1_200,
    rank: 85,
    match: request => !!String(request.currentChannel || '').trim(),
    collect: request => contextItem({
      topic: 'runtime.channel',
      request,
      payload: {
        channel: String(request.currentChannel || ''),
        switched: request.channelSwitched === true,
      },
    }),
  }))

  registered.push(registry.register({
    id: 'environment:host-context',
    kind: 'snapshot',
    domain: 'environment',
    topics: ['environment.host_context'],
    description: 'On-demand host, desktop, software, location, or connector context.',
    legacyComponents: ['systemEnvironment'],
    sensitivity: 'private',
    timeoutMs: 1_000,
    maxItems: 1,
    maxChars: 18_000,
    rank: 70,
    collect: request => {
      const contextText = request.systemEnvironmentContext
        ?? buildSystemEnvironmentContext(request.message || '')
      if (!contextText) return null
      return contextItem({
        topic: 'environment.host_context',
        request,
        payload: { contextText },
      })
    },
  }))

  registered.push(registry.register({
    id: 'runtime:legacy-components',
    kind: 'snapshot',
    domain: 'runtime',
    topics: ['runtime.legacy_component'],
    description: 'Compatibility projection of existing runtime context components.',
    legacyComponents: [
      'presence',
      'runtime',
      'terminal',
      'browserDownloads',
      'uiSignals',
      'subscriptions',
      'aiVideoPanel',
    ],
    sensitivity: 'private',
    timeoutMs: 250,
    maxItems: 30,
    maxChars: 16_000,
    rank: 50,
    collect: request => Object.entries(request.runtimeComponents || {})
      .filter(([, value]) => String(value || '').trim())
      .map(([component, value]) => contextItem({
        topic: 'runtime.legacy_component',
        request,
        subject: { component },
        payload: { contextText: String(value) },
      })),
  }))

  initializedRegistries.add(registry)
  return registered
}
