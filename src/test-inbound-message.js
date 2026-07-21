import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-inbound-message-'))
process.env.BAILONGMA_USER_DIR = tmp
process.env.BAILONGMA_RESOURCES_DIR = process.cwd()

let closeDBForTest = null

function drainQueue(popMessage) {
  while (popMessage()) {}
}

try {
  const { pushMessage } = await import('./inbound-message.js')
  const { popMessage, hasMessages, getQueueSnapshot, setInterruptCallback } = await import('./queue.js')
  const dbModule = await import('./db.js')
  const db = dbModule.getDB()
  closeDBForTest = dbModule.closeDBForTest

  drainQueue(popMessage)

  const interrupted = []
  setInterruptCallback(entry => interrupted.push(entry))

  const external = pushMessage('wechat:clawbot:user-1', 'external hello', 'WECHAT_CLAWBOT')
  assert.equal(external.fromId, 'ID:000001')
  assert.equal(external.externalPartyId, 'wechat:clawbot:user-1')
  assert.equal(external.channel, 'WECHAT_CLAWBOT')
  assert.equal(external.queueName, 'user')
  assert(external.conversationId > 0, 'inbound user messages are persisted on arrival')
  assert.equal(getQueueSnapshot().user, 1)
  assert.equal(interrupted.length, 1)
  assert.equal(interrupted[0], external)

  const externalRow = db.prepare(`
    SELECT role, from_id, to_id, content, channel, external_party_id, focus_topic, thread_id
    FROM conversations
    WHERE id = ?
  `).get(external.conversationId)
  assert(externalRow, 'persisted inbound row exists')
  assert.equal(externalRow.role, 'user')
  assert.equal(externalRow.from_id, 'ID:000001')
  assert.equal(externalRow.to_id, 'jarvis')
  assert.equal(externalRow.content, 'external hello')
  assert.equal(externalRow.channel, 'WECHAT_CLAWBOT')
  assert.equal(externalRow.external_party_id, 'wechat:clawbot:user-1')
  assert.equal(externalRow.focus_topic, '')
  assert.equal(externalRow.thread_id, '')
  assert.equal(popMessage(), external)

  const beforePersistFalse = db.prepare('SELECT COUNT(*) AS c FROM conversations').get().c
  const transient = pushMessage('SYSTEM', 'transient signal', 'APP_SIGNAL', {
    queue: 'background',
    persist: false,
    silent: true,
  })
  assert.equal(transient.conversationId, 0)
  assert.equal(transient.queueName, 'background')
  assert.equal(getQueueSnapshot().background, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM conversations').get().c, beforePersistFalse)
  assert.equal(popMessage(), transient)

  const scheduled = pushMessage('SYSTEM', '提醒用户喝水', 'REMINDER', {
    queue: 'background',
    persist: false,
    runtimeLane: 'l3',
    reminderRunId: 9,
    reminderTargetId: 'ID:000001',
    reminderTask: '提醒用户喝水',
  })
  assert.equal(scheduled.conversationId, 0)
  assert.equal(scheduled.queueName, 'background')
  assert.equal(scheduled.runtimeLane, 'l3')
  assert.equal(scheduled.reminderRunId, 9)
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM conversations').get().c, beforePersistFalse)
  assert.equal(popMessage(), scheduled)

  const first = pushMessage('ID:123456', 'first pending', 'TUI')
  const second = pushMessage('ID:123456', 'second pending', 'TUI')
  assert(first.conversationId > 0)
  assert(second.conversationId > 0)
  assert.equal(getQueueSnapshot().user, 1, 'new same-user same-channel user message supersedes pending one')
  assert.equal(popMessage(), second)
  assert.equal(hasMessages(), false)

  setInterruptCallback(null)
  console.log('PASS inbound message service preserves queue and persistence semantics')
} finally {
  closeDBForTest?.()
  fs.rmSync(tmp, { recursive: true, force: true })
}

process.exit(process.exitCode || 0)
