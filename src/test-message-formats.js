import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { migrateMessageFormats } from './db/message-formats.js'
import { messageModalityLabel } from './ui/brain-ui/message-format.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-message-formats-'))
const filename = path.join(tmp, 'history.db')
let db = new Database(filename)
try {
  db.exec(`CREATE TABLE conversations(id INTEGER PRIMARY KEY, role TEXT, channel TEXT);
    CREATE TABLE brain_ui_events(id INTEGER PRIMARY KEY, event_type TEXT, payload_json TEXT);
    INSERT INTO conversations VALUES (1,'user','语音识别'), (2,'jarvis','TUI'),
      (3,'jarvis','TUI'), (4,'user','TUI'), (5,'jarvis','WECHAT'), (6,'jarvis','TUI');`)
  const insert = db.prepare("INSERT INTO brain_ui_events(event_type,payload_json) VALUES ('tool_call', ?)")
  insert.run(JSON.stringify({name:'send_message',args:{format:'voice'},result:JSON.stringify({ok:true,conversation_id:2})}))
  insert.run(JSON.stringify({name:'send_message',args:{format:'voice'},result:{ok:false,conversation_id:3}}))
  insert.run(JSON.stringify({name:'send_message',args:{format:'text'},result:{ok:true,conversation_id:6}}))
  insert.run('{truncated')
  migrateMessageFormats(db)
  db.close()
  db = new Database(filename)
  migrateMessageFormats(db) // Restart is idempotent, including unknown legacy rows.
  assert.deepEqual(db.prepare('SELECT message_format FROM conversations ORDER BY id').all().map(r=>r.message_format), ['voice','voice','','text','social','text'])
  for (const row of db.prepare('SELECT * FROM conversations').all()) {
    const label = messageModalityLabel({role:row.role,channel:row.channel,messageFormat:row.message_format,source:'history'})
    assert.equal(label, {1:'语音对话',2:'语音回复',3:'',4:'文字消息',5:'WeChat',6:'文字回复'}[row.id])
    if (row.message_format) assert.equal(label, messageModalityLabel({role:row.role,channel:row.channel,messageFormat:row.message_format}))
  }
  assert.equal(messageModalityLabel({role:'jarvis',channel:'VOICE',messageFormat:'text'}),'文字回复')
  assert.equal(messageModalityLabel({role:'user',channel:'FocusBanner'}),'语音对话')
  console.log('Message format migration, restart and labels passed')
} finally {
  db.close()
  fs.rmSync(tmp,{recursive:true,force:true})
}
