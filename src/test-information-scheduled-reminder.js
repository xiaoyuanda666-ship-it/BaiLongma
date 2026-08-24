import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-information-schedule-'))
process.env.BAILONGMA_USER_DIR = tempRoot
process.env.BAILONGMA_INFORMATION_ACTIVATION = 'schedule'

let closeDBForTest = () => {}
try {
  const dbModule = await import('./db.js')
  closeDBForTest = dbModule.closeDBForTest
  const { enqueueReminderRunForMigration } = await import('./information/reminder-activation.js')
  const {
    ackInformationActivation,
    nackInformationActivation,
  } = await import('./information/activation-bridge.js')
  const db = dbModule.getDB()

  const reminderInsert = dbModule.createReminder({
    userId: 'ID:000001',
    dueAt: '2020-01-01T00:00:00.000Z',
    task: '提醒用户喝水',
    systemMessage: '{"type":"reminder"}',
  })
  const reminder = dbModule.getReminderById(Number(reminderInsert.lastInsertRowid))
  const run = dbModule.materializeReminderRun({
    reminder,
    firedAt: '2020-01-01T00:00:01.000Z',
  })
  const firstClaim = dbModule.claimRunnableReminderRuns('2020-01-01T00:00:02.000Z', 1)[0]
  assert.equal(firstClaim.id, run.id)
  assert.equal(firstClaim.attempts, 1)

  const firstQueue = []
  const legacyCalls = []
  const first = enqueueReminderRunForMigration(firstClaim, {
    db,
    enqueue: entry => firstQueue.push(entry),
    pushMessageFn: (...args) => legacyCalls.push(args),
  })
  assert.equal(first.informationResult.activated, true)
  assert.equal(firstQueue.length, 1)
  assert.equal(legacyCalls.length, 0)
  assert.equal(firstQueue[0].runtimeLane, 'l3')
  assert.equal(firstQueue[0].reminderAttempt, 1)

  const retryAt = '2020-01-01T00:00:05.000Z'
  dbModule.retryReminderRun(run.id, 'provider unavailable', retryAt)
  const nacked = nackInformationActivation(firstQueue[0], 'provider unavailable', {
    db,
    retryAt,
    maxAttempts: 100,
  })
  assert.equal(nacked.pending, 1)
  assert.equal(dbModule.getReminderRunById(run.id).status, 'retry')

  const secondClaim = dbModule.claimRunnableReminderRuns(retryAt, 1)[0]
  assert.equal(secondClaim.attempts, 2)
  const secondQueue = []
  const second = enqueueReminderRunForMigration(secondClaim, {
    db,
    enqueue: entry => secondQueue.push(entry),
    pushMessageFn: (...args) => legacyCalls.push(args),
  })
  assert.equal(second.informationResult.created, false)
  assert.equal(second.informationResult.activated, true)
  assert.equal(secondQueue[0].reminderAttempt, 2)

  dbModule.completeReminderRun(run.id, '2020-01-01T00:00:06.000Z')
  assert.equal(ackInformationActivation(secondQueue[0], { db }), 1)
  assert.equal(dbModule.getReminderRunById(run.id).status, 'succeeded')
  assert.equal(
    dbModule.listInformationDeliveries({ eventId: second.informationResult.event.id }, { db })[0].state,
    'acked',
  )

  console.log('PASS scheduled reminder runs and InformationDelivery retry/ACK lifecycles stay aligned')
} finally {
  delete process.env.BAILONGMA_INFORMATION_ACTIVATION
  closeDBForTest()
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
