import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = path.join(__dirname, '../data/jarvis.db')

let db

export function getDB() {
  if (!db) {
    db = new Database(DB_PATH)
    db.pragma('journal_mode = WAL')
    initSchema()
  }
  return db
}

function initSchema() {
  // 迁移：添加 parent_id 字段（已存在时跳过）
  try { db.exec(`ALTER TABLE memories ADD COLUMN parent_id INTEGER REFERENCES memories(id)`) } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_parent_id ON memories(parent_id)`) } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      role        TEXT    NOT NULL,  -- 'user' | 'jarvis'
      from_id     TEXT    NOT NULL,  -- 发送者 ID
      to_id       TEXT,              -- 接收者 ID（jarvis 发出时有值）
      content     TEXT    NOT NULL,
      timestamp   TEXT    NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_conv_timestamp ON conversations(timestamp);
    CREATE INDEX IF NOT EXISTS idx_conv_from_id   ON conversations(from_id);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type  TEXT    NOT NULL,
      content     TEXT    NOT NULL,
      detail      TEXT    NOT NULL,
      entities    TEXT    DEFAULT '[]',
      concepts    TEXT    DEFAULT '[]',
      tags        TEXT    DEFAULT '[]',
      source_ref  TEXT,
      timestamp   TEXT    NOT NULL,
      parent_id   INTEGER REFERENCES memories(id),
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_memories_timestamp  ON memories(timestamp);
    CREATE INDEX IF NOT EXISTS idx_memories_event_type ON memories(event_type);
    CREATE INDEX IF NOT EXISTS idx_memories_parent_id  ON memories(parent_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content, detail, entities, concepts, tags,
      content='memories', content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, detail, entities, concepts, tags)
      VALUES (new.id, new.content, new.detail, new.entities, new.concepts, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, detail, entities, concepts, tags)
      VALUES ('delete', old.id, old.content, old.detail, old.entities, old.concepts, old.tags);
    END;

    CREATE TABLE IF NOT EXISTS config (
      key         TEXT    PRIMARY KEY,
      value       TEXT    NOT NULL,
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS entities (
      id          TEXT    PRIMARY KEY,
      label       TEXT,
      last_seen   TEXT    NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `)

  // 重建 FTS 索引（覆盖已有数据，确保历史记忆也被索引）
  db.exec(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`)
}

// 读取配置
export function getConfig(key) {
  const db = getDB()
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key)
  return row ? row.value : null
}

// 写入配置
export function setConfig(key, value) {
  const db = getDB()
  db.prepare(`
    INSERT INTO config (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value)
}

// 解析 parent_ref 语义字符串 → 真实 memory id
// 格式："person:ID:000001"  → 找该 entity 最新的 person 根节点
//       "knowledge:X框架"   → FTS 搜索最近匹配的 knowledge 记录
function resolveParentRef(parentRef) {
  if (!parentRef) return null
  const db = getDB()

  // 找第一个冒号分割 type 和 identifier
  const colonIdx = parentRef.indexOf(':')
  if (colonIdx === -1) return null

  const type = parentRef.slice(0, colonIdx).trim()
  const identifier = parentRef.slice(colonIdx + 1).trim()
  if (!type || !identifier) return null

  // person / object：identifier 是 entity ID，精确匹配根节点
  if (['person', 'object'].includes(type)) {
    const row = db.prepare(`
      SELECT id FROM memories
      WHERE event_type = ? AND entities LIKE ? AND parent_id IS NULL
      ORDER BY timestamp DESC LIMIT 1
    `).get(type, `%${identifier}%`)
    return row ? row.id : null
  }

  // 其他类型：identifier 是关键词，FTS 搜索最近匹配记录
  try {
    const row = db.prepare(`
      SELECT m.id FROM memories m
      JOIN memories_fts ON memories_fts.rowid = m.id
      WHERE m.event_type = ? AND memories_fts MATCH ?
      ORDER BY m.timestamp DESC LIMIT 1
    `).get(type, identifier)
    return row ? row.id : null
  } catch {
    const row = db.prepare(`
      SELECT id FROM memories
      WHERE event_type = ? AND content LIKE ?
      ORDER BY timestamp DESC LIMIT 1
    `).get(type, `%${identifier}%`)
    return row ? row.id : null
  }
}

// 写入一条记忆（写入前检查去重）
export function insertMemory(memory) {
  const db = getDB()

  // person / object 根节点：按 entity ID upsert，避免重复根节点
  if (['person', 'object'].includes(memory.event_type) && !memory.parent_ref) {
    const firstEntity = (memory.entities || [])[0]
    if (firstEntity) {
      const existing = db.prepare(`
        SELECT id FROM memories
        WHERE event_type = ? AND entities LIKE ? AND parent_id IS NULL
        LIMIT 1
      `).get(memory.event_type, `%${firstEntity}%`)
      if (existing) {
        db.prepare(`
          UPDATE memories SET content = ?, detail = ?, concepts = ?, tags = ?, timestamp = ?
          WHERE id = ?
        `).run(
          memory.content,
          memory.detail,
          JSON.stringify(memory.concepts || []),
          JSON.stringify(memory.tags || []),
          memory.timestamp || new Date().toISOString(),
          existing.id
        )
        console.log(`[DB] 更新根节点：${memory.event_type} ${firstEntity}`)
        return { id: existing.id, updated: true }
      }
    }
  }

  // 解析 parent_ref → parent_id
  const parentId = memory.parent_ref ? resolveParentRef(memory.parent_ref) : null

  // 工具知识记忆去重：按 tool:标签匹配，同工具只保留最新
  const memoryTags = memory.tags || []
  const toolTag = Array.isArray(memoryTags) ? memoryTags.find(t => t.startsWith('tool:')) : null
  if (toolTag && memory.event_type === 'knowledge') {
    const toolName = toolTag.replace('tool:', '')
    const existing = db.prepare(`
      SELECT id FROM memories
      WHERE event_type = 'knowledge'
      AND tags LIKE ?
      ORDER BY timestamp DESC LIMIT 1
    `).get(`%tool:${toolName}%`)
    if (existing) {
      db.prepare(`
        UPDATE memories SET content = ?, detail = ?, concepts = ?, tags = ?, timestamp = ?
        WHERE id = ?
      `).run(
        memory.content,
        memory.detail,
        JSON.stringify(memory.concepts || []),
        JSON.stringify(memory.tags || []),
        memory.timestamp || new Date().toISOString(),
        existing.id
      )
      console.log(`[DB] 更新工具记忆：${toolName}`)
      return { id: existing.id, updated: true }
    }
  }

  // 普通记忆去重：同类型且 content 前40字相同则跳过
  const contentPrefix = (memory.content || '').slice(0, 40)
  const dup = db.prepare(`
    SELECT id FROM memories WHERE event_type = ? AND content LIKE ? LIMIT 1
  `).get(memory.event_type, `${contentPrefix}%`)
  if (dup) {
    console.log(`[DB] 跳过重复记忆：${contentPrefix}…`)
    return null
  }

  // URL 去重：同 URL 当天已有记录则跳过
  const tags = memory.tags || []
  const urlTag = Array.isArray(tags) ? tags.find(t => t.startsWith('url:')) : null
  if (urlTag) {
    const today = new Date().toISOString().slice(0, 10)
    const urlDup = db.prepare(`
      SELECT id FROM memories WHERE tags LIKE ? AND timestamp LIKE ? LIMIT 1
    `).get(`%${urlTag}%`, `${today}%`)
    if (urlDup) {
      console.log(`[DB] 跳过当日重复 URL 记忆：${urlTag}`)
      return null
    }
  }

  return db.prepare(`
    INSERT INTO memories (event_type, content, detail, entities, concepts, tags, source_ref, timestamp, parent_id)
    VALUES (@event_type, @content, @detail, @entities, @concepts, @tags, @source_ref, @timestamp, @parent_id)
  `).run({
    event_type: memory.event_type,
    content:    memory.content,
    detail:     memory.detail,
    entities:   JSON.stringify(memory.entities || []),
    concepts:   JSON.stringify(memory.concepts || []),
    tags:       JSON.stringify(memory.tags || []),
    source_ref: memory.source_ref || null,
    timestamp:  memory.timestamp || new Date().toISOString(),
    parent_id:  parentId,
  })
}

// 查询最近 N 条记忆
export function getRecentMemories(limit = 10) {
  const db = getDB()
  return db.prepare(`
    SELECT * FROM memories ORDER BY timestamp DESC LIMIT ?
  `).all(limit)
}

// 查询某时间段内的记忆
export function getMemoriesByTimeRange(from, to, limit = 20) {
  const db = getDB()
  return db.prepare(`
    SELECT * FROM memories
    WHERE timestamp >= ? AND timestamp <= ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(from, to, limit)
}

// 清除所有记忆和配置（测试用，谨慎使用）
export function resetAll() {
  const db = getDB()
  db.prepare('DELETE FROM memories').run()
  db.prepare('DELETE FROM config').run()
  db.prepare('DELETE FROM entities').run()
}

// 注册/更新一个已知实体
export function upsertEntity(id, label = null) {
  const db = getDB()
  db.prepare(`
    INSERT INTO entities (id, label, last_seen)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET last_seen = datetime('now'), label = COALESCE(excluded.label, label)
  `).run(id, label)
}

// 获取所有已知实体
export function getKnownEntities() {
  const db = getDB()
  return db.prepare('SELECT * FROM entities ORDER BY last_seen DESC').all()
}

// 查询意识体对某 ID 表达过的观点（opinion_expressed）
export function getOpinionsByTarget(entityId, limit = 5) {
  const db = getDB()
  return db.prepare(`
    SELECT * FROM memories
    WHERE event_type = 'opinion_expressed'
    AND tags LIKE ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(`%target:${entityId}%`, limit)
}

// 查询某 ID 说过的印象深刻的话（impressive_statement，score >= 3 已在写入时过滤）
export function getImpressiveBySource(entityId, limit = 5) {
  const db = getDB()
  return db.prepare(`
    SELECT * FROM memories
    WHERE event_type = 'impressive_statement'
    AND tags LIKE ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(`%from:${entityId}%`, limit)
}

// ── 对话记录 ──

// 写入一条对话记录
export function insertConversation({ role, from_id, to_id = null, content, timestamp }) {
  const db = getDB()
  db.prepare(`
    INSERT INTO conversations (role, from_id, to_id, content, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `).run(role, from_id, to_id, content, timestamp)
}

// 获取某个对话对象的最近 N 条消息（用户消息 + Jarvis 回复，按时序）
// anchor: 锚点消息 id，null 表示最新；offset: 向上偏移（用于窗口上移）
export function getConversationWindow(entityId, userCount = 5, anchorId = null, offsetUp = 0) {
  const db = getDB()

  // 找到最近 userCount 条用户消息的时间范围
  let userRows
  if (anchorId) {
    const anchor = db.prepare('SELECT timestamp FROM conversations WHERE id = ?').get(anchorId)
    userRows = db.prepare(`
      SELECT * FROM conversations
      WHERE (from_id = ? OR to_id = ?)
      AND role = 'user'
      AND timestamp <= ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(entityId, entityId, anchor.timestamp, userCount + offsetUp)
  } else {
    userRows = db.prepare(`
      SELECT * FROM conversations
      WHERE (from_id = ? OR to_id = ?)
      AND role = 'user'
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(entityId, entityId, userCount + offsetUp)
  }

  if (!userRows.length) return []

  // 取这些用户消息的时间范围
  const timestamps = userRows.map(r => r.timestamp)
  const minTs = timestamps[timestamps.length - 1]
  const maxTs = timestamps[0]

  // 取该时间范围内所有消息（包含 Jarvis 回复），按时序排列
  return db.prepare(`
    SELECT * FROM conversations
    WHERE (from_id = ? OR to_id = ?)
    AND timestamp >= ? AND timestamp <= ?
    ORDER BY timestamp ASC
  `).all(entityId, entityId, minTs, maxTs)
}

// 搜索对话记录（关键词），返回匹配行及其上下文（前后各 N 条）
export function searchConversations(entityId, keyword, context = 5) {
  const db = getDB()
  const matches = db.prepare(`
    SELECT * FROM conversations
    WHERE (from_id = ? OR to_id = ?)
    AND content LIKE ?
    ORDER BY timestamp DESC
    LIMIT 10
  `).all(entityId, entityId, `%${keyword}%`)

  if (!matches.length) return []

  // 取第一个匹配的上下文窗口
  const anchor = matches[0]
  return db.prepare(`
    SELECT * FROM conversations
    WHERE (from_id = ? OR to_id = ?)
    AND ABS(CAST((julianday(timestamp) - julianday(?)) * 86400 AS INTEGER)) < ${context * 30}
    ORDER BY timestamp ASC
    LIMIT ?
  `).all(entityId, entityId, anchor.timestamp, context * 2 + 1)
}

// 获取或初始化首次启动时间（持久化，重启不丢失）
export function getOrInitBirthTime() {
  const db = getDB()
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get('birth_time')
  if (row) return row.value
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO config (key, value, updated_at) VALUES ('birth_time', ?, datetime('now'))`).run(now)
  return now
}

// 获取所有激活的行为约束（同维度只保留最新一条）
export function getActiveConstraints() {
  const db = getDB()
  const rows = db.prepare(`
    SELECT * FROM memories
    WHERE event_type = 'behavioral_constraint'
    ORDER BY timestamp DESC
  `).all()

  // 同维度去重，保留最新（rows 已按 timestamp DESC 排序）
  const seen = new Set()
  return rows.filter(row => {
    const tags = JSON.parse(row.tags || '[]')
    const dimTag = tags.find(t => t.startsWith('dimension:'))
    const dim = dimTag ? dimTag : `_id_${row.id}` // 无维度标签则每条独立
    if (seen.has(dim)) return false
    seen.add(dim)
    return true
  })
}

// 获取任务知识条目（task_knowledge 类型，带完整 detail）
export function getTaskKnowledge(limit = 30) {
  const db = getDB()
  return db.prepare(`
    SELECT * FROM memories
    WHERE event_type = 'task_knowledge'
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(limit)
}

// 获取工具使用记忆（kind:tool_usage 标签）
export function getToolMemories(limit = 20) {
  const db = getDB()
  return db.prepare(`
    SELECT * FROM memories
    WHERE event_type = 'knowledge'
    AND tags LIKE '%kind:tool_usage%'
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(limit)
}

// 获取某实体的 person/object 根节点记忆
export function getPersonMemory(entityId) {
  const db = getDB()
  return db.prepare(`
    SELECT * FROM memories
    WHERE event_type IN ('person', 'object')
    AND entities LIKE ?
    AND parent_id IS NULL
    ORDER BY timestamp DESC LIMIT 1
  `).get(`%${entityId}%`)
}

// 获取某实体相关的所有记忆（非根节点本身，按时间倒序）
export function getMemoriesByEntity(entityId, limit = 10) {
  const db = getDB()
  return db.prepare(`
    SELECT * FROM memories
    WHERE entities LIKE ?
    AND event_type NOT IN ('person', 'object')
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(`%${entityId}%`, limit)
}

// 获取与某实体的近期对话记录（最近 limit 条，不超过 maxHours 小时）
export function getRecentConversation(entityId, limit = 20, maxHours = 24) {
  const db = getDB()
  const cutoff = new Date(Date.now() - maxHours * 3600 * 1000).toISOString()
  const rows = db.prepare(`
    SELECT * FROM conversations
    WHERE (from_id = ? OR to_id = ?)
    AND timestamp >= ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(entityId, entityId, cutoff, limit)
  return rows.reverse() // 按时间正序返回
}

// 按关键词搜索记忆（FTS5 全文搜索，优先相关度排序）
export function searchMemories(keyword, limit = 10) {
  const db = getDB()
  try {
    // FTS5 搜索：用 bm25 相关度排序
    return db.prepare(`
      SELECT m.* FROM memories m
      JOIN memories_fts ON memories_fts.rowid = m.id
      WHERE memories_fts MATCH ?
      ORDER BY bm25(memories_fts), m.timestamp DESC
      LIMIT ?
    `).all(keyword, limit)
  } catch {
    // FTS 语法错误时降级为 LIKE（如用户输入了特殊字符）
    return db.prepare(`
      SELECT * FROM memories
      WHERE content LIKE ? OR detail LIKE ? OR concepts LIKE ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, limit)
  }
}
