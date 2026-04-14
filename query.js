import Database from 'better-sqlite3'
const db = new Database('./data/jarvis.db')
const rows = db.prepare("SELECT id, event_type, content, tags FROM memories WHERE content LIKE '%守夜%'").all()
console.log(JSON.stringify(rows, null, 2))
db.close()