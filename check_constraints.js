import Database from 'better-sqlite3'
const db = new Database('./data/jarvis.db')

// 检查 getActiveConstraints 的查询逻辑
const rows = db.prepare(`
  SELECT * FROM memories
  WHERE event_type = 'behavioral_constraint'
  ORDER BY timestamp DESC
`).all()

console.log('behavioral_constraint 数量:', rows.length)

// 检查 self_constraint
const selfRows = db.prepare(`
  SELECT * FROM memories
  WHERE event_type = 'self_constraint'
  ORDER BY timestamp DESC
`).all()

console.log('self_constraint 数量:', selfRows.length)
console.log('最新的 self_constraint:')
console.log(selfRows.slice(0, 3).map(r => ({ content: r.content, tags: r.tags })))

db.close()