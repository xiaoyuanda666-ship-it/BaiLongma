// Upgrade once. Never infer an assistant's expression from the preceding user
// message: voice input may deliberately receive a text response (and vice versa).
export function migrateMessageFormats(db) {
  if (db.prepare('PRAGMA table_info(conversations)').all().some(column => column.name === 'message_format')) return
  db.transaction(() => {
    db.exec("ALTER TABLE conversations ADD COLUMN message_format TEXT NOT NULL DEFAULT ''")
    db.exec(`
      UPDATE conversations SET message_format = 'voice'
        WHERE upper(channel) IN ('VOICE', '语音识别', '语音对话', 'FOCUSBANNER');
      UPDATE conversations SET message_format = 'social'
        WHERE upper(channel) IN ('WECHAT', 'WECHAT_CLAWBOT', 'WECHAT_OFFICIAL', 'WECOM', 'DISCORD', 'FEISHU');
      UPDATE conversations SET message_format = 'text'
        WHERE role = 'user' AND message_format = '';
    `)
    // Recover older explicit expressions only with a successful receipt tied
    // to this exact conversation ID. Malformed/truncated audit entries are skipped.
    const update = db.prepare("UPDATE conversations SET message_format = ? WHERE id = ? AND role = 'jarvis' AND message_format = ''")
    for (const row of db.prepare("SELECT payload_json FROM brain_ui_events WHERE event_type = 'tool_call' ORDER BY id").all()) {
      let event, result
      try {
        event = JSON.parse(row.payload_json)
        result = typeof event.result === 'string' ? JSON.parse(event.result) : event.result
      } catch { continue }
      if (event.name !== 'send_message' || event.ok === false || result?.ok !== true || !Number.isInteger(result.conversation_id)) continue
      const format = result.format || event.args?.format
      if (['text', 'voice', 'social'].includes(format)) update.run(format, result.conversation_id)
    }
  })()
}
