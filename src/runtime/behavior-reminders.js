import { normalizeConversationPartyId } from '../db/utils.js'

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]),
  )
  return value
}

export function behaviorActionKey(tool, args = {}) {
  if (tool === 'send_message' || tool === 'express') {
    const channel = String(args.channel || 'AUTO').toUpperCase()
    return JSON.stringify(['send_message', canonical({
      ...args, target_id: normalizeConversationPartyId(args.target_id),
      content: String(args.content || '').trim(), format: args.format || 'legacy',
      channel: ['AUTO', 'TUI'].includes(channel) && ['text', 'voice'].includes(args.format) ? 'TUI' : channel,
    })])
  }
  return JSON.stringify([tool, canonical(args)])
}

export function createBehaviorReminderState() {
  return { reminders: new Map(), outcomes: new Map(), observedRound: -1 }
}

// Called only after the prior tool results have been added to model history,
// immediately before a NEW execution request. Another call in the same batch
// is not evidence that the agent has received the reminder.
export function observeBehaviorReminders(state, round) {
  state.observedRound = round
}

const unscopedStates = new WeakMap()
function stateFor(context) {
  if (context.behaviorReminders) return context.behaviorReminders
  if (!unscopedStates.has(context)) unscopedStates.set(context, createBehaviorReminderState())
  return unscopedStates.get(context)
}

export function behaviorReminder(context, { tool, args, reason, evidence = null }) {
  const state = stateFor(context)
  const key = context.behaviorActionKey || behaviorActionKey(tool, args)
  const previous = state.reminders.get(key)
  if (previous) {
    if (state.observedRound > previous.round) return null
    return previous.result
  }
  const result = JSON.stringify({
    ok: true, advisory: true, executed: false, status: 'not_executed',
    tool, skipped: 'behavior_reminder', delivered: false, message_sent: false,
    reason,
    evidence: evidence ?? state.outcomes.get(key) ?? null,
    guidance: 'This attempt was NOT executed. This is a one-time behavioral reminder, not an execution failure. Read the evidence, including any prior successful result. If the intended result already exists, no repeat is needed. If you still decide this action is necessary after receiving this result, request it again in your next execution response; behavioral guards will allow that decision without another reminder. Actual permissions, valid parameters, in-flight operations and resource limits still apply.',
  })
  state.reminders.set(key, { round: context.behaviorRound ?? state.observedRound, result })
  return result
}

export function isBehaviorReminder(result) {
  try { return JSON.parse(String(result)).advisory === true } catch { return false }
}

export function recordBehaviorOutcome(state, tool, args, result) {
  if (isBehaviorReminder(result)) return
  let value
  try { value = JSON.parse(String(result)) } catch { value = String(result).slice(0, 2000) }
  if (JSON.stringify(value).length > 8000) {
    value = { ok: value?.ok, delivered: value?.delivered, message_sent: value?.message_sent,
      conversation_id: value?.conversation_id, error: value?.error,
      preview: String(result).slice(0, 4000), truncated: true }
  }
  state.outcomes.set(behaviorActionKey(tool, args), { tool, args, result: value, recorded_at: new Date().toISOString() })
}
