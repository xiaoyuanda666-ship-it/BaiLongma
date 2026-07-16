import { getDB } from '../connection.js'
import { CANONICAL_USER_ID, normalizeConversationPartyId } from '../utils.js'

export function createReminder({ userId, dueAt, task, systemMessage, source = '', recurrenceType = null, recurrenceConfig = null }) {
  const db = getDB()
  const normalizedUserId = normalizeConversationPartyId(userId || CANONICAL_USER_ID)
  const configStr = recurrenceConfig ? JSON.stringify(recurrenceConfig) : null
  return db.prepare(`
    INSERT INTO reminders (user_id, due_at, task, system_message, status, source, recurrence_type, recurrence_config)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
  `).run(normalizedUserId, dueAt, task, systemMessage, source, recurrenceType, configStr)
}

export function findMergeableOneOffReminder(userId, dueAtIsoMinute) {
  const db = getDB()
  const normalizedUserId = normalizeConversationPartyId(userId || CANONICAL_USER_ID)
  return db.prepare(`
    SELECT * FROM reminders
    WHERE status = 'pending'
      AND recurrence_type IS NULL
      AND user_id = ?
      AND substr(due_at, 1, 16) = ?
    ORDER BY id ASC
    LIMIT 1
  `).get(normalizedUserId, dueAtIsoMinute) || null
}

export function appendReminderTask(id, additionalTask, newSystemMessage) {
  const db = getDB()
  const row = db.prepare(`SELECT task FROM reminders WHERE id = ?`).get(id)
  if (!row) return { changes: 0 }
  const mergedTask = `${row.task}; ${additionalTask}`
  return db.prepare(`
    UPDATE reminders
    SET task = ?, system_message = ?
    WHERE id = ? AND status = 'pending'
  `).run(mergedTask, newSystemMessage, id)
}

export function getDueReminders(now = new Date().toISOString(), limit = 20) {
  const db = getDB()
  return db.prepare(`
    SELECT * FROM reminders
    WHERE status = 'pending' AND due_at <= ?
    ORDER BY due_at ASC, id ASC
    LIMIT ?
  `).all(now, limit)
}

export function markReminderFired(id, firedAt = new Date().toISOString()) {
  const db = getDB()
  return db.prepare(`
    UPDATE reminders
    SET status = 'fired', fired_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(firedAt, id)
}

export function advanceReminderDueAt(id, nextDueAtIso) {
  const db = getDB()
  return db.prepare(`
    UPDATE reminders
    SET due_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(nextDueAtIso, id)
}

export function cancelReminder(id, cancelledAt = new Date().toISOString()) {
  const db = getDB()
  return db.prepare(`
    UPDATE reminders
    SET status = 'cancelled', cancelled_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(cancelledAt, id)
}

export function listPendingReminders(limit = 50) {
  const db = getDB()
  return db.prepare(`
    SELECT * FROM reminders
    WHERE status = 'pending'
    ORDER BY due_at ASC, id ASC
    LIMIT ?
  `).all(limit)
}

export function getReminderById(id) {
  const db = getDB()
  return db.prepare(`SELECT * FROM reminders WHERE id = ?`).get(id) || null
}

export function getNextPendingReminder() {
  const db = getDB()
  return db.prepare(`
    SELECT * FROM reminders
    WHERE status = 'pending'
    ORDER BY due_at ASC, id ASC
    LIMIT 1
  `).get() || null
}

export function materializeReminderRun({ reminder, firedAt, nextDueAt = null }) {
  const db = getDB()
  const occurrenceDueAt = String(reminder?.due_at || '')
  if (!reminder?.id || !occurrenceDueAt) return null

  const materialize = db.transaction(() => {
    const inserted = db.prepare(`
      INSERT OR IGNORE INTO reminder_runs
        (reminder_id, user_id, task, due_at, status, available_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(
      reminder.id,
      normalizeConversationPartyId(reminder.user_id || CANONICAL_USER_ID),
      String(reminder.task || ''),
      occurrenceDueAt,
      occurrenceDueAt,
    )

    if (!inserted.changes) {
      return db.prepare(`
        SELECT * FROM reminder_runs WHERE reminder_id = ? AND due_at = ?
      `).get(reminder.id, occurrenceDueAt) || null
    }

    const reminderUpdate = nextDueAt
      ? db.prepare(`
          UPDATE reminders
          SET due_at = ?
          WHERE id = ? AND status = 'pending' AND due_at = ?
        `).run(nextDueAt, reminder.id, occurrenceDueAt)
      : db.prepare(`
          UPDATE reminders
          SET status = 'fired', fired_at = ?
          WHERE id = ? AND status = 'pending' AND due_at = ?
        `).run(firedAt, reminder.id, occurrenceDueAt)

    if (!reminderUpdate.changes) {
      throw new Error(`Reminder #${reminder.id} changed while materializing its L3 run`)
    }

    return db.prepare(`SELECT * FROM reminder_runs WHERE id = ?`).get(inserted.lastInsertRowid) || null
  })

  return materialize()
}

export function recoverInterruptedReminderRuns(now = new Date().toISOString()) {
  return getDB().prepare(`
    UPDATE reminder_runs
    SET status = 'retry',
        available_at = ?,
        claimed_at = NULL,
        last_error = CASE
          WHEN last_error = '' THEN 'runtime restarted before completion'
          ELSE last_error
        END
    WHERE status = 'running'
  `).run(now)
}

export function claimRunnableReminderRuns(now = new Date().toISOString(), limit = 20) {
  const db = getDB()
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20))
  const claim = db.transaction(() => {
    const rows = db.prepare(`
      SELECT *
      FROM reminder_runs
      WHERE status IN ('pending', 'retry') AND available_at <= ?
      ORDER BY available_at ASC, id ASC
      LIMIT ?
    `).all(now, safeLimit)

    const claimed = []
    const update = db.prepare(`
      UPDATE reminder_runs
      SET status = 'running',
          attempts = attempts + 1,
          claimed_at = ?,
          last_error = ''
      WHERE id = ? AND status IN ('pending', 'retry')
    `)
    const read = db.prepare(`SELECT * FROM reminder_runs WHERE id = ?`)
    for (const row of rows) {
      if (!update.run(now, row.id).changes) continue
      const current = read.get(row.id)
      if (current) claimed.push(current)
    }
    return claimed
  })
  return claim()
}

export function completeReminderRun(id, finishedAt = new Date().toISOString()) {
  return getDB().prepare(`
    UPDATE reminder_runs
    SET status = 'succeeded',
        finished_at = ?,
        claimed_at = NULL,
        last_error = ''
    WHERE id = ? AND status = 'running'
  `).run(finishedAt, id)
}

export function retryReminderRun(id, error, availableAt = new Date().toISOString()) {
  return getDB().prepare(`
    UPDATE reminder_runs
    SET status = 'retry',
        available_at = ?,
        claimed_at = NULL,
        last_error = ?
    WHERE id = ? AND status = 'running'
  `).run(availableAt, String(error || '').slice(0, 2000), id)
}

export function failReminderRun(id, error, finishedAt = new Date().toISOString()) {
  return getDB().prepare(`
    UPDATE reminder_runs
    SET status = 'failed',
        finished_at = ?,
        claimed_at = NULL,
        last_error = ?
    WHERE id = ? AND status = 'running'
  `).run(finishedAt, String(error || '').slice(0, 2000), id)
}

export function getReminderRunById(id) {
  return getDB().prepare(`SELECT * FROM reminder_runs WHERE id = ?`).get(id) || null
}

export function getNextPendingReminderRun() {
  return getDB().prepare(`
    SELECT * FROM reminder_runs
    WHERE status IN ('pending', 'retry')
    ORDER BY available_at ASC, id ASC
    LIMIT 1
  `).get() || null
}
