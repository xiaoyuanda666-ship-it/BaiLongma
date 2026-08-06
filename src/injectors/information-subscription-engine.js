import {
  listRelevantInformationSubscriptions,
  markInformationSubscriptionsDelivered,
} from '../db.js'
import { logWarn } from '../runtime/error-logger.js'
import {
  collectInformationProvider,
  getInformationProvider,
  informationProviderMatches,
  listInformationProviders,
} from './information-providers.js'

export const PRIMARY_AGENT_SUBSCRIBER_ID = 'agent:primary'
const MAX_PROVIDERS_PER_TURN = 8

function scheduledSubscriptionIsDue(subscription, nowMs) {
  if (!subscription.intervalMs) return false
  const rawAnchor = subscription.lastDeliveredAt || subscription.createdAt || ''
  // SQLite datetime('now') is UTC but omits the timezone suffix. Normalize it
  // explicitly so scheduled cadence is not shifted by the machine timezone.
  const normalizedAnchor = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(rawAnchor)
    ? `${rawAnchor.replace(' ', 'T')}Z`
    : rawAnchor
  const anchor = Date.parse(normalizedAnchor)
  // Legacy/in-memory rows without a creation timestamp remain immediately due.
  return !Number.isFinite(anchor) || nowMs - anchor >= subscription.intervalMs
}

export function informationSubscriptionMatchesTurn(subscription, provider, context = {}) {
  if (!subscription?.enabled || !provider) return false
  if (subscription.mode === 'default') return true
  if (subscription.mode === 'scheduled') {
    return scheduledSubscriptionIsDue(subscription, Number(context.nowMs) || Date.now())
  }
  if (subscription.mode === 'on_demand') {
    return informationProviderMatches(provider, context, subscription.matchKeywords)
  }
  return false
}

function relevantSubscriptions({ userId = '', agentId = PRIMARY_AGENT_SUBSCRIBER_ID } = {}) {
  return listRelevantInformationSubscriptions({ userId, agentId })
}

function addActivation(map, providerId, activation) {
  if (!map.has(providerId)) map.set(providerId, [])
  map.get(providerId).push(activation)
}

export function planInformationInjection({
  message = '',
  userId = '',
  agentId = PRIMARY_AGENT_SUBSCRIBER_ID,
  isTick = false,
  nowMs = Date.now(),
  subscriptions = null,
} = {}) {
  const context = { message: String(message || ''), userId, agentId, isTick, nowMs }
  const activations = new Map()

  for (const providerInfo of listInformationProviders()) {
    const provider = getInformationProvider(providerInfo.id)
    if (!provider) continue
    if (provider.defaultMode === 'default') {
      addActivation(activations, provider.id, { source: 'system_default', mode: 'default' })
    } else if (provider.defaultMode === 'on_demand' && informationProviderMatches(provider, context)) {
      addActivation(activations, provider.id, { source: 'system_default', mode: 'on_demand' })
    }
  }

  const activeSubscriptions = Array.isArray(subscriptions)
    ? subscriptions
    : relevantSubscriptions({ userId, agentId })
  for (const subscription of activeSubscriptions) {
    const provider = getInformationProvider(subscription.providerId)
    if (!informationSubscriptionMatchesTurn(subscription, provider, context)) continue
    addActivation(activations, provider.id, {
      source: 'subscription',
      subscriptionId: subscription.id,
      subscriberType: subscription.subscriberType,
      mode: subscription.mode,
      instruction: subscription.instruction || '',
    })
  }

  return [...activations.entries()].slice(0, MAX_PROVIDERS_PER_TURN).map(([providerId, reasons]) => ({
    providerId,
    reasons,
  }))
}

function formatProviderContext(provider, contextText, reasons) {
  const modes = [...new Set(reasons.map(reason => reason.mode))].join(',')
  const intents = reasons
    .filter(reason => reason.source === 'subscription' && reason.instruction)
    .map(reason => ({
      subscriberType: reason.subscriberType,
      instruction: String(reason.instruction)
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/[<>]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 1_500),
    }))
  const intentBlock = intents.length > 0
    ? `\n<subscription-intents>\n${intents.map(intent => `- owner=${intent.subscriberType}: ${intent.instruction}`).join('\n')}\n</subscription-intents>\nThese are durable user/Agent preferences, not fresh sensor facts. Apply judgment before notifying; do not claim an action or condition that the snapshot does not support.`
    : ''
  return `<information-source id="${provider.id}" category="${provider.category}" modes="${modes}">
${contextText}
${intentBlock}
</information-source>`
}

export async function resolveInformationSubscriptions(options = {}) {
  const plan = planInformationInjection(options)
  const context = {
    message: String(options.message || ''),
    userId: options.userId || '',
    agentId: options.agentId || PRIMARY_AGENT_SUBSCRIBER_ID,
    isTick: options.isTick === true,
    nowMs: Number(options.nowMs) || Date.now(),
    signal: options.signal || null,
  }
  const entries = (await Promise.all(plan.map(async item => {
    const provider = getInformationProvider(item.providerId)
    if (!provider) return null
    try {
      const contextText = await collectInformationProvider(provider, context)
      if (!contextText) return null
      return {
        providerId: provider.id,
        category: provider.category,
        sensitivity: provider.sensitivity,
        reasons: item.reasons,
        scheduledSubscriptionIds: item.reasons
          .filter(reason => reason.source === 'subscription' && reason.mode === 'scheduled')
          .map(reason => reason.subscriptionId),
        contextText: formatProviderContext(provider, contextText, item.reasons),
      }
    } catch (err) {
      logWarn(err, {
        scope: 'information.subscription',
        operation: 'collect_provider',
        metadata: { providerId: provider.id },
      })
      return null
    }
  }))).filter(Boolean)

  return {
    entries,
    providerIds: entries.map(entry => entry.providerId),
    scheduledSubscriptionIds: [...new Set(entries.flatMap(entry => entry.scheduledSubscriptionIds))],
    contextText: entries.map(entry => entry.contextText).join('\n\n'),
  }
}

export function commitScheduledInformationDeliveries(ids = [], deliveredAt = new Date().toISOString()) {
  try {
    return markInformationSubscriptionsDelivered(ids, deliveredAt)
  } catch (err) {
    logWarn(err, {
      scope: 'information.subscription',
      operation: 'commit_delivery',
      metadata: { subscriptionCount: Array.isArray(ids) ? ids.length : 0 },
    })
    return 0
  }
}
