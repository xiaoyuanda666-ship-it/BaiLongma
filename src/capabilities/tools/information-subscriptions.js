import {
  listInformationSubscriptions,
  removeInformationSubscription,
  setInformationSubscriptionEnabled,
  upsertInformationSubscription,
} from '../../db.js'
import { PRIMARY_USER_ID } from '../../identity.js'
import {
  getInformationProvider,
  listInformationProviders,
} from '../../injectors/information-providers.js'
import { PRIMARY_AGENT_SUBSCRIBER_ID } from '../../injectors/information-subscription-engine.js'

function toolJson(value) {
  return JSON.stringify(value, null, 2)
}

function resolveSubscriber(args = {}, context = {}) {
  const requested = String(args.subscriber || 'auto').trim().toLowerCase()
  const subscriberType = requested === 'agent'
    ? 'agent'
    : requested === 'user'
      ? 'user'
      : context.autonomous
        ? 'agent'
        : 'user'
  if (context.autonomous && subscriberType === 'user') {
    throw new Error('an autonomous turn may manage only the Agent\'s own subscriptions')
  }
  return {
    subscriberType,
    subscriberId: subscriberType === 'agent'
      ? PRIMARY_AGENT_SUBSCRIBER_ID
      : String(context.currentTargetId || PRIMARY_USER_ID),
  }
}

function summarize(subscription) {
  const provider = getInformationProvider(subscription.providerId)
  return {
    provider_id: subscription.providerId,
    provider_label: provider?.label || subscription.providerId,
    category: provider?.category || 'unknown',
    subscriber: subscription.subscriberType,
    mode: subscription.mode,
    interval_minutes: subscription.intervalMs ? subscription.intervalMs / 60_000 : null,
    match_keywords: subscription.matchKeywords,
    reason: subscription.reason,
    instruction: subscription.instruction,
    enabled: subscription.enabled,
    last_delivered_at: subscription.lastDeliveredAt,
  }
}

export function execManageInformationSubscription(args = {}, context = {}) {
  const action = String(args.action || 'list').trim().toLowerCase()
  try {
    if (action === 'providers') {
      return toolJson({
        ok: true,
        action,
        providers: listInformationProviders().map(provider => ({
          id: provider.id,
          label: provider.label,
          description: provider.description,
          category: provider.category,
          sensitivity: provider.sensitivity,
          system_default_mode: provider.defaultMode,
        })),
        scheduled_semantics: 'A scheduled subscription is injected on the first Agent turn after its interval elapses; it does not create a turn by itself.',
      })
    }

    const owner = resolveSubscriber(args, context)
    if (action === 'list') {
      const subscriptions = listInformationSubscriptions(owner)
      return toolJson({ ok: true, action, ...owner, subscriptions: subscriptions.map(summarize) })
    }

    const providerId = String(args.provider_id || '').trim()
    if (!providerId) throw new Error('provider_id is required')
    const provider = getInformationProvider(providerId)
    if (!provider) throw new Error(`unknown information provider "${providerId}"; use action="providers" to inspect the catalog`)

    if (action === 'subscribe') {
      const mode = String(args.mode || 'default').trim().toLowerCase()
      const intervalMs = mode === 'scheduled'
        ? Math.round(Number(args.interval_minutes ?? 60) * 60_000)
        : null
      const subscription = upsertInformationSubscription({
        providerId,
        ...owner,
        mode,
        intervalMs,
        matchKeywords: args.match_keywords,
        reason: args.reason,
        instruction: args.instruction,
        enabled: true,
      })
      return toolJson({
        ok: true,
        action,
        subscription: summarize(subscription),
        scheduled_semantics: mode === 'scheduled'
          ? 'This will inject on the first Agent turn after the interval elapses; it will not wake the Agent or send a message by itself.'
          : undefined,
      })
    }

    if (action === 'unsubscribe') {
      const removed = removeInformationSubscription({ providerId, ...owner })
      return toolJson({
        ok: removed,
        action,
        provider_id: providerId,
        removed,
        system_default_mode: provider.defaultMode,
        note: provider.defaultMode !== 'disabled'
          ? `The custom subscription was removed. The provider's built-in ${provider.defaultMode} policy remains active.`
          : undefined,
      })
    }

    if (action === 'enable' || action === 'disable') {
      const changed = setInformationSubscriptionEnabled({
        providerId,
        ...owner,
        enabled: action === 'enable',
      })
      return toolJson({ ok: changed, action, provider_id: providerId, changed })
    }

    throw new Error(`unknown action "${action}"`)
  } catch (err) {
    return toolJson({ ok: false, action, error: err.message })
  }
}
