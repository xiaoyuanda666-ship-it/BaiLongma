import { getDB } from '../db/connection.js'
import { logWarn } from '../runtime/error-logger.js'
import { isInformationShadowEnabled } from './shadow-publisher.js'
import { loadInformationDeliveryCandidates } from './context-candidates.js'
import { compileInformationContextFrame } from './context-frame.js'

function componentCharCounts(components = {}) {
  return Object.fromEntries(
    Object.entries(components || {})
      .map(([name, value]) => [name, String(value || '').length])
      .filter(([, chars]) => chars > 0),
  )
}

export function buildInformationContextAudit(frame, {
  legacyComponents = {},
  subscriberType = 'agent',
  subscriberId = 'agent:primary',
  mode = 'shadow',
} = {}) {
  const legacyCharsByComponent = componentCharCounts(legacyComponents)
  return {
    frameId: frame.id,
    mode,
    triggerEventId: frame.triggerEventId || '',
    subscriberType,
    subscriberId,
    ...frame.audit,
    legacyComponentCount: Object.keys(legacyCharsByComponent).length,
    legacyContextChars: Object.values(legacyCharsByComponent).reduce((sum, chars) => sum + chars, 0),
    legacyCharsByComponent,
  }
}

export function observeInformationContextShadow({
  triggerEventId = '',
  legacyComponents = {},
  subscriberType = 'agent',
  subscriberId = 'agent:primary',
  now = new Date(),
} = {}, {
  env = process.env,
  db = null,
} = {}) {
  if (!isInformationShadowEnabled(env)) return { enabled: false, observed: false }
  const normalizedTriggerId = String(triggerEventId || '').trim()
  if (!normalizedTriggerId) return { enabled: true, observed: false, skipped: 'missing_trigger_event' }
  try {
    const targetDb = db || getDB()
    const candidates = loadInformationDeliveryCandidates({
      eventId: normalizedTriggerId,
      subscriberType,
      subscriberId,
    }, { db: targetDb })
    const frame = compileInformationContextFrame({
      candidates,
      triggerEventId: normalizedTriggerId,
      now,
    })
    return {
      enabled: true,
      observed: true,
      frame,
      audit: buildInformationContextAudit(frame, { legacyComponents, subscriberType, subscriberId }),
    }
  } catch (error) {
    logWarn(error, {
      scope: 'information.context_shadow',
      operation: 'compile',
      metadata: { triggerEventId: normalizedTriggerId, subscriberId },
    })
    return { enabled: true, observed: false, error: error?.message || String(error) }
  }
}
