import { nowTimestamp } from '../../time.js'
import { createReminder, findMergeableOneOffReminder, appendReminderTask, listPendingReminders, getReminderById, cancelReminder, normalizeConversationPartyId } from '../../db.js'
import { emitEvent } from '../../events.js'
import { PRIMARY_USER_ID } from '../../identity.js'

function parseReminderDueAt(value) {
  if (!value || typeof value !== 'string') {
    throw new Error('due_at was not provided')
  }
  const dueAt = new Date(value.trim())
  if (Number.isNaN(dueAt.getTime())) {
    throw new Error('due_at must be a valid ISO 8601 absolute time, for example 2026-04-21T06:00:00+08:00')
  }
  return dueAt
}

function parseHourMinute(value, label = 'time') {
  const m = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!m) throw new Error(`${label} must use HH:MM format, for example 09:00`)
  const hour = Number(m[1]), minute = Number(m[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new Error(`${label} is outside the valid range`)
  return { hour, minute }
}

// 周期提醒：根据 type/config 计算下一次触发时间（晚于 fromDate）
export function calculateNextDueAt(type, config, fromDate = new Date()) {
  const now = fromDate
  const { hour, minute } = parseHourMinute(config.time, 'time')

  if (type === 'daily') {
    const next = new Date(now)
    next.setHours(hour, minute, 0, 0)
    if (next <= now) next.setDate(next.getDate() + 1)
    return next
  }
  if (type === 'weekly') {
    const targetWeekday = Number(config.weekday)
    if (!Number.isInteger(targetWeekday) || targetWeekday < 0 || targetWeekday > 6) {
      throw new Error('weekday must be an integer from 0 to 6 (0=Sunday)')
    }
    const next = new Date(now)
    next.setHours(hour, minute, 0, 0)
    let diff = (targetWeekday - now.getDay() + 7) % 7
    if (diff === 0 && next <= now) diff = 7
    next.setDate(next.getDate() + diff)
    return next
  }
  if (type === 'monthly') {
    const targetDay = Number(config.day_of_month)
    if (!Number.isInteger(targetDay) || targetDay < 1 || targetDay > 31) {
      throw new Error('day_of_month must be an integer from 1 to 31')
    }
    let year = now.getFullYear(), month = now.getMonth()
    for (let i = 0; i < 12; i++) {
      const lastDay = new Date(year, month + 1, 0).getDate()
      if (targetDay <= lastDay) {
        const next = new Date(year, month, targetDay, hour, minute, 0, 0)
        if (next > now) return next
      }
      month++
      if (month > 11) { month = 0; year++ }
    }
    throw new Error('Could not find the next matching month')
  }
  throw new Error(`Unknown recurrence kind: ${type}`)
}

function buildSystemMessage(targetId, taskText) {
  // Legacy storage field retained for database compatibility. Runtime
  // execution uses the structured L3 reminder-run payload instead of injecting
  // an English "I am the system" message into a user-role conversation turn.
  return JSON.stringify({
    type: 'reminder',
    target_id: targetId,
    task: taskText,
  })
}

function formatReminderRow(r) {
  const recurrence = r.recurrence_type
    ? `[${r.recurrence_type}] ${(() => {
        try {
          const c = JSON.parse(r.recurrence_config || '{}')
          if (r.recurrence_type === 'daily') return `每天 ${c.time}`
          if (r.recurrence_type === 'weekly') {
            const names = ['周日','周一','周二','周三','周四','周五','周六']
            return `每${names[c.weekday]} ${c.time}`
          }
          if (r.recurrence_type === 'monthly') return `每月 ${c.day_of_month} 号 ${c.time}`
          return JSON.stringify(c)
        } catch { return '' }
      })()}`
    : '[once]'
  return `#${r.id} ${recurrence} 下次 ${r.due_at} → ${r.user_id}：${r.task}`
}

export async function execManageReminder(args, context = {}) {
  const action = args.action || (args.due_at || args.kind ? 'create' : null)
  if (!action) return '错误：未提供 action（create/list/cancel）'

  if (action === 'list') {
    const rows = listPendingReminders(50)
    if (!rows.length) return '当前没有待触发的提醒。'
    return `共 ${rows.length} 条待触发提醒：\n` + rows.map(formatReminderRow).join('\n')
  }

  if (action === 'cancel') {
    const id = Number(args.id)
    if (!Number.isInteger(id) || id <= 0) return '错误：cancel 需要提供合法的提醒 id'
    const existing = getReminderById(id)
    if (!existing) return `错误：未找到提醒 #${id}`
    if (existing.status !== 'pending') return `错误：提醒 #${id} 当前状态为 ${existing.status}，无法取消`
    const result = cancelReminder(id)
    if (!result.changes) return `错误：取消提醒 #${id} 失败`
    emitEvent('reminder_cancelled', { id, user_id: existing.user_id, task: existing.task })
    return `提醒 #${id} 已取消（${existing.task}）`
  }

  if (action !== 'create') return `错误：未知 action "${action}"，仅支持 create/list/cancel`

  const { task } = args
  if (!task?.trim()) return '错误：未提供 task'
  const taskText = task.trim()
  const fallbackTargetId = context.visibleTargetIds?.[0] || context.allowedTargetIds?.[0] || PRIMARY_USER_ID
  const resolvedTargetId = normalizeConversationPartyId(args.target_id || fallbackTargetId)

  const kind = args.kind || 'once'

  if (kind === 'once') {
    const dueAt = parseReminderDueAt(args.due_at)
    if (dueAt.getTime() <= Date.now()) throw new Error('提醒时间必须晚于当前时间')
    const isoDueAt = dueAt.toISOString()
    const minuteKey = isoDueAt.slice(0, 16)

    const mergeTarget = findMergeableOneOffReminder(resolvedTargetId, minuteKey)
    if (mergeTarget) {
      const mergedTaskText = `${mergeTarget.task}; ${taskText}`
      const newSystemMessage = buildSystemMessage(resolvedTargetId, mergedTaskText)
      const r = appendReminderTask(mergeTarget.id, taskText, newSystemMessage)
      if (!r.changes) return `错误：合并提醒 #${mergeTarget.id} 失败`
      emitEvent('reminder_merged', { id: mergeTarget.id, user_id: resolvedTargetId, due_at: mergeTarget.due_at, task: mergedTaskText })
      return `已合并到现有提醒 #${mergeTarget.id}（同时间），合并后任务：${mergedTaskText}`
    }

    const result = createReminder({
      userId: resolvedTargetId,
      dueAt: isoDueAt,
      task: taskText,
      systemMessage: buildSystemMessage(resolvedTargetId, taskText),
      source: `tool:manage_reminder@${nowTimestamp()}`,
    })
    emitEvent('reminder_created', { id: Number(result.lastInsertRowid), user_id: resolvedTargetId, due_at: isoDueAt, task: taskText })
    return `提醒已创建：#${result.lastInsertRowid}，将在 ${isoDueAt} 触发，目标用户 ${resolvedTargetId}`
  }

  // 周期提醒
  const config = {}
  if (kind === 'daily') {
    config.time = args.time
  } else if (kind === 'weekly') {
    config.time = args.time
    config.weekday = args.weekday
  } else if (kind === 'monthly') {
    config.time = args.time
    config.day_of_month = args.day_of_month
  } else {
    throw new Error(`未知的 kind "${kind}"，支持 once/daily/weekly/monthly`)
  }

  const nextDate = calculateNextDueAt(kind, config)
  const isoDueAt = nextDate.toISOString()
  const result = createReminder({
    userId: resolvedTargetId,
    dueAt: isoDueAt,
    task: taskText,
    systemMessage: buildSystemMessage(resolvedTargetId, taskText),
    source: `tool:manage_reminder@${nowTimestamp()}`,
    recurrenceType: kind,
    recurrenceConfig: config,
  })
  emitEvent('reminder_created', { id: Number(result.lastInsertRowid), user_id: resolvedTargetId, due_at: isoDueAt, task: taskText, recurrence_type: kind, recurrence_config: config })
  return `周期提醒已创建：#${result.lastInsertRowid} (${kind})，下次触发 ${isoDueAt}，目标用户 ${resolvedTargetId}`
}


