import Database from 'better-sqlite3'
const db = new Database('./data/jarvis.db')

// 检查 getRecentMemories 的查询逻辑
const rows = db.prepare(`
  SELECT * FROM memories ORDER BY timestamp DESC LIMIT 6
`).all()

console.log('最新的 6 条记忆:')
rows.forEach(r => {
  console.log(`[${r.event_type}] ${r.content.slice(0, 60)}`)
})

db.close()