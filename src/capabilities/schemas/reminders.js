// 提醒 / 预取类工具 schema：manage_reminder / manage_prefetch_task
export const remindersSchemas = {
  manage_reminder: {
    type: 'function',
    function: {
      name: 'manage_reminder',
      description: 'Manage reminders: create one-off/daily/weekly/monthly reminders, list them, or cancel them. When due, the system sends you a system message so you can continue execution. One-off reminders with the same target_id and minute are merged to avoid duplicate triggers. In a user-requested turn, confirm a newly created reminder in the reply. During an autonomous TICK, decide separately whether creating it and notifying anyone are appropriate; one does not force the other.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'list', 'cancel'],
            description: 'create creates a reminder; list lists pending reminders; cancel cancels by id.'
          },
          kind: {
            type: 'string',
            enum: ['once', 'daily', 'weekly', 'monthly'],
            description: 'For create only: once requires due_at; daily requires time; weekly requires time + weekday; monthly requires time + day_of_month. Defaults to once.'
          },
          task: {
            type: 'string',
            description: 'For create only: task to execute when the reminder fires.'
          },
          target_id: {
            type: 'string',
            description: 'For create only: final user ID served by this reminder, such as ID:000001. Should be an ID that appears in the conversation context of this prompt; if omitted, defaults to the current conversation target.'
          },
          due_at: {
            type: 'string',
            description: 'For kind=once only: trigger time as an absolute ISO 8601 timestamp, e.g. 2026-04-21T06:00:00+08:00.'
          },
          time: {
            type: 'string',
            description: 'For daily/weekly/monthly only: trigger time in local timezone, HH:MM format, e.g. 09:00.'
          },
          weekday: {
            type: 'integer',
            description: 'For kind=weekly only: weekday, 0=Sunday, 1=Monday, ..., 6=Saturday.',
            minimum: 0,
            maximum: 6
          },
          day_of_month: {
            type: 'integer',
            description: 'For kind=monthly only: day of month, 1-31. If a month lacks that day, such as the 31st, the reminder jumps to the next month that has it.',
            minimum: 1,
            maximum: 31
          },
          id: {
            type: 'integer',
            description: 'For cancel only: reminder id to cancel, obtained from list.'
          }
        },
        required: ['action']
      }
    }
  },

  manage_prefetch_task: {
    type: 'function',
    function: {
      name: 'manage_prefetch_task',
      description: 'Manage prefetch tasks. The system automatically fetches these URLs before each startup and injects them into context, so web_read is not needed again. Suitable for recurring information such as weather, news, and prices.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['add', 'remove', 'list'],
            description: 'add adds or updates a task; remove deletes a task; list shows all tasks.',
          },
          source: {
            type: 'string',
            description: 'Unique task identifier, recommended format like "weather:Beijing" or "news:36kr". Required for add/remove.',
          },
          label: {
            type: 'string',
            description: 'Display label, e.g. "Beijing weather". Required for add.',
          },
          url: {
            type: 'string',
            description: 'URL to prefetch. Required for add.',
          },
          ttl_minutes: {
            type: 'number',
            description: 'Cache TTL in minutes, default 60. Suggested: weather 60, news 30, calendar 720.',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tags such as ["weather", "Beijing"] for easier retrieval.',
          },
        },
        required: ['action'],
      },
    },
  },
}
