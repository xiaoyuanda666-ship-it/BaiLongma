import { getDB } from '../db/connection.js'
import { upsertInformationRoute } from './repositories/routes.js'

export const PRIMARY_INFORMATION_SUBSCRIBER = Object.freeze({ type: 'agent', id: 'agent:primary' })

const BUILTIN_ROUTES = Object.freeze([
  {
    id: 'route_system_user_message_primary',
    subscriber: PRIMARY_INFORMATION_SUBSCRIBER,
    topicPattern: 'conversation.user_message',
    activation: { type: 'event' },
    sampling: { strategy: 'all' },
    wake: { policy: 'always', priority: 100 },
    delivery: { policy: 'immediate_turn', ack: 'after_model_accept' },
    context: { semanticKind: 'user_input', maxChars: 50_000, rank: 100 },
    createdBy: { type: 'system', id: 'information-core' },
    reason: 'Every user-authored message must reach the primary Agent.',
  },
  {
    id: 'route_system_user_resource_primary',
    subscriber: PRIMARY_INFORMATION_SUBSCRIBER,
    topicPattern: 'conversation.user_resource',
    activation: { type: 'event' },
    sampling: { strategy: 'all' },
    wake: { policy: 'never', priority: 50 },
    delivery: { policy: 'accumulate', ack: 'after_model_accept' },
    context: { semanticKind: 'user_input', maxChars: 20_000, rank: 80 },
    createdBy: { type: 'system', id: 'information-core' },
    reason: 'Staged resources accompany the next user instruction without waking the Agent.',
  },
  {
    id: 'route_system_ui_intent_primary',
    subscriber: PRIMARY_INFORMATION_SUBSCRIBER,
    topicPattern: 'ui.intent.**',
    activation: { type: 'event' },
    sampling: { strategy: 'all' },
    wake: { policy: 'if_idle', priority: 60 },
    delivery: { policy: 'next_turn', ack: 'after_model_accept' },
    context: { semanticKind: 'ui_signal', maxChars: 4_000, rank: 60 },
    createdBy: { type: 'system', id: 'information-core' },
    reason: 'Important UI intents should be visible without being misattributed to the user voice channel.',
  },
  {
    id: 'route_system_ui_observation_primary',
    subscriber: PRIMARY_INFORMATION_SUBSCRIBER,
    topicPattern: 'ui.observation.**',
    activation: { type: 'event' },
    sampling: { strategy: 'window', windowMs: 60_000 },
    wake: { policy: 'never', priority: 30 },
    delivery: { policy: 'accumulate', ack: 'after_model_accept' },
    context: { semanticKind: 'ui_signal', maxChars: 3_000, rank: 30 },
    createdBy: { type: 'system', id: 'information-core' },
    reason: 'Passive UI behavior may enrich a later turn but must not wake the Agent by itself.',
  },
  {
    id: 'route_system_schedule_due_primary',
    subscriber: PRIMARY_INFORMATION_SUBSCRIBER,
    topicPattern: 'schedule.due',
    activation: { type: 'event' },
    sampling: { strategy: 'all' },
    wake: { policy: 'always', priority: 70 },
    delivery: { policy: 'immediate_turn', ack: 'after_turn' },
    context: { semanticKind: 'runtime_event', maxChars: 8_000, rank: 90 },
    createdBy: { type: 'system', id: 'information-core' },
    reason: 'A durable due event must be handled by a scheduled Agent turn.',
  },
  {
    id: 'route_system_job_state_primary',
    subscriber: PRIMARY_INFORMATION_SUBSCRIBER,
    topicPattern: 'job.state_changed',
    activation: { type: 'event' },
    sampling: { strategy: 'delta' },
    wake: { policy: 'if_idle', priority: 40 },
    delivery: { policy: 'next_turn', ack: 'after_model_accept' },
    context: { semanticKind: 'runtime_event', maxChars: 6_000, rank: 50 },
    createdBy: { type: 'system', id: 'information-core' },
    reason: 'Consequential background job changes should reach the Agent through a typed event.',
  },
])

const initializedDatabases = new WeakSet()

export function ensureBuiltinInformationRoutes({ db = getDB() } = {}) {
  if (initializedDatabases.has(db)) return []
  const routes = BUILTIN_ROUTES.map(route => upsertInformationRoute(route, { db }))
  initializedDatabases.add(db)
  return routes
}

export function listBuiltinInformationRouteDefinitions() {
  return BUILTIN_ROUTES.map(route => JSON.parse(JSON.stringify(route)))
}
