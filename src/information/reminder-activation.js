import { pushMessage } from '../inbound-message.js'
import { publishInformationEventForMigration } from './activation-bridge.js'

function reminderQueueMetadata(run = {}) {
  return {
    queue: 'background',
    persist: false,
    runtimeLane: 'l3',
    scheduledEventType: 'reminder',
    reminderRunId: run.id,
    reminderId: run.reminder_id,
    reminderTargetId: run.user_id,
    reminderTask: run.task,
    reminderDueAt: run.due_at,
    reminderAttempt: run.attempts,
    deliveryPolicy: 'notify',
  }
}
export function enqueueReminderRunForMigration(run, {
  env = process.env,
  db = null,
  enqueue = null,
  pushMessageFn = pushMessage,
} = {}) {
  if (!run?.id || !run?.reminder_id) throw new Error('a persisted reminder run is required')
  const queueMetadata = reminderQueueMetadata(run)
  const bridgeOptions = { domain: 'schedule', queueMetadata, env }
  if (db) bridgeOptions.db = db
  if (enqueue) bridgeOptions.enqueue = enqueue

  const informationResult = publishInformationEventForMigration({
    topic: 'schedule.due',
    source: { id: 'scheduler:reminders', kind: 'event' },
    subject: { userId: run.user_id, reminderId: run.reminder_id, runId: run.id },
    authorship: 'system',
    semanticKind: 'runtime_event',
    payload: {
      reminderId: run.reminder_id,
      runId: run.id,
      dueAt: run.due_at,
      attempt: run.attempts,
      deliveryPolicy: 'notify',
      task: run.task,
    },
    payloadRef: { table: 'reminder_runs', id: run.id },
    occurredAt: run.due_at || new Date(),
    priority: 70,
    sensitivity: 'private',
    trust: 'authoritative',
    orderingKey: `reminder:${run.reminder_id}`,
    dedupeKey: `reminder-run:${run.id}`,
    correlationId: `reminder:${run.reminder_id}`,
    metadata: { runtimeLane: 'l3' },
  }, bridgeOptions)

  const queued = informationResult.handled
    ? null
    : pushMessageFn('SYSTEM', run.task, 'REMINDER', queueMetadata)
  if (queued && informationResult.event?.id) queued.informationEventId = informationResult.event.id
  return { informationResult, queued, queueMetadata }
}
