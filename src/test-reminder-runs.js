import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-reminder-runs-'))
process.env.BAILONGMA_USER_DIR = tmp
process.env.BAILONGMA_RESOURCES_DIR = process.cwd()

let closeDBForTest = null

try {
  const dbModule = await import('./db.js')
  closeDBForTest = dbModule.closeDBForTest
  const db = dbModule.getDB()

  const onceDueAt = '2026-07-16T08:00:00.000Z'
  const once = dbModule.createReminder({
    userId: 'ID:000001',
    dueAt: onceDueAt,
    task: '提醒用户喝水',
    systemMessage: '{"type":"reminder"}',
  })
  const onceReminder = dbModule.getReminderById(Number(once.lastInsertRowid))
  const firstRun = dbModule.materializeReminderRun({
    reminder: onceReminder,
    firedAt: '2026-07-16T08:00:01.000Z',
  })

  assert(firstRun?.id > 0)
  assert.equal(firstRun.status, 'pending')
  assert.equal(firstRun.task, '提醒用户喝水')
  assert.equal(dbModule.getReminderById(onceReminder.id).status, 'fired')

  const claimedOnce = dbModule.claimRunnableReminderRuns('2026-07-16T08:00:02.000Z', 10)
  assert.equal(claimedOnce.length, 1)
  assert.equal(claimedOnce[0].status, 'running')
  assert.equal(claimedOnce[0].attempts, 1)

  dbModule.retryReminderRun(firstRun.id, 'provider unavailable', '2026-07-16T08:00:05.000Z')
  assert.equal(dbModule.claimRunnableReminderRuns('2026-07-16T08:00:04.000Z', 10).length, 0)
  const retryClaim = dbModule.claimRunnableReminderRuns('2026-07-16T08:00:05.000Z', 10)
  assert.equal(retryClaim.length, 1)
  assert.equal(retryClaim[0].attempts, 2)
  dbModule.completeReminderRun(firstRun.id, '2026-07-16T08:00:06.000Z')
  assert.equal(dbModule.getReminderRunById(firstRun.id).status, 'succeeded')

  const recurringDueAt = '2026-07-16T09:00:00.000Z'
  const recurring = dbModule.createReminder({
    userId: 'ID:000001',
    dueAt: recurringDueAt,
    task: '发送日报',
    systemMessage: '{"type":"reminder"}',
    recurrenceType: 'daily',
    recurrenceConfig: { time: '17:00' },
  })
  const recurringReminder = dbModule.getReminderById(Number(recurring.lastInsertRowid))
  const recurringRun = dbModule.materializeReminderRun({
    reminder: recurringReminder,
    firedAt: '2026-07-16T09:00:01.000Z',
    nextDueAt: '2026-07-17T09:00:00.000Z',
  })

  assert(recurringRun?.id > 0)
  const advancedReminder = dbModule.getReminderById(recurringReminder.id)
  assert.equal(advancedReminder.status, 'pending')
  assert.equal(advancedReminder.due_at, '2026-07-17T09:00:00.000Z')

  const claimedRecurring = dbModule.claimRunnableReminderRuns('2026-07-16T09:00:02.000Z', 10)
  assert.equal(claimedRecurring.length, 1)
  assert.equal(claimedRecurring[0].id, recurringRun.id)
  const recovered = dbModule.recoverInterruptedReminderRuns('2026-07-16T09:00:03.000Z')
  assert.equal(recovered.changes, 1)
  assert.equal(dbModule.getReminderRunById(recurringRun.id).status, 'retry')

  const runCount = db.prepare('SELECT COUNT(*) AS count FROM reminder_runs').get().count
  assert.equal(runCount, 2)
  console.log('PASS reminder occurrences persist as recoverable L3 runs with retry and recurrence semantics')
} finally {
  closeDBForTest?.()
  fs.rmSync(tmp, { recursive: true, force: true })
}
