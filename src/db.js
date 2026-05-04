import Database from 'better-sqlite3'
import { paths } from './paths.js'

const DB_PATH = paths.dbFile

const CANONICAL_USER_ID = 'ID:000001'
const CANONICAL_AGENT_ENTITY = 'agent:jarvis'
const CANONICAL_USER_ROOT_MEM_ID = 'person_000001'
const CANONICAL_AGENT_ROOT_MEM_ID = 'agent_jarvis_identity'

const USER_ID_ALIASES = new Set(['000001', 'id:000001', 'yuanda', '1187048501994078249'])
const AGENT_ENTITY_ALIASES = new Set(['jarvis', 'agent_jarvis', 'agent:jarvis'])
const USER_ROOT_ALIASES = new Set([
  'contact_000001',
  'person_000001',
  'person_id000001_interaction',
  'person_yuanda_identity',
  'user_000001',
  'user_000001_identity',
  'user_000001_profile',
])
const AUTO_CANONICAL_IDENTITY_ROOTS = false

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
  // 迁移：新增 title / mem_id / links 字段
  try { db.exec(`ALTER TABLE memories ADD COLUMN title TEXT DEFAULT ''`) } catch {}
  try { db.exec(`ALTER TABLE memories ADD COLUMN mem_id TEXT`) } catch {}
  try { db.exec(`ALTER TABLE memories ADD COLUMN links TEXT DEFAULT '[]'`) } catch {}
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_mem_id ON memories(mem_id) WHERE mem_id IS NOT NULL`) } catch {}
  // 迁移：conversations 加 channel 列
  try { db.exec(`ALTER TABLE conversations ADD COLUMN channel TEXT DEFAULT ''`) } catch {}

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
      title       TEXT    DEFAULT '',
      mem_id      TEXT,
      entities    TEXT    DEFAULT '[]',
      concepts    TEXT    DEFAULT '[]',
      tags        TEXT    DEFAULT '[]',
      links       TEXT    DEFAULT '[]',
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS action_logs (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT    NOT NULL,
      tool      TEXT    NOT NULL,
      summary   TEXT    NOT NULL,
      detail    TEXT    NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_action_logs_timestamp ON action_logs(timestamp);
  `)
  try { db.exec(`ALTER TABLE action_logs ADD COLUMN status TEXT NOT NULL DEFAULT 'ok'`) } catch {}
  try { db.exec(`ALTER TABLE action_logs ADD COLUMN risk TEXT NOT NULL DEFAULT 'medium'`) } catch {}
  try { db.exec(`ALTER TABLE action_logs ADD COLUMN args_json TEXT NOT NULL DEFAULT '{}'`) } catch {}
  try { db.exec(`ALTER TABLE action_logs ADD COLUMN result_preview TEXT NOT NULL DEFAULT ''`) } catch {}
  try { db.exec(`ALTER TABLE action_logs ADD COLUMN error TEXT NOT NULL DEFAULT ''`) } catch {}
  try { db.exec(`ALTER TABLE action_logs ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0`) } catch {}
  try { db.exec(`ALTER TABLE action_logs ADD COLUMN source TEXT NOT NULL DEFAULT ''`) } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_action_logs_status ON action_logs(status)`) } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_action_logs_risk ON action_logs(risk)`) } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id           TEXT    NOT NULL,
      due_at            TEXT    NOT NULL,
      task              TEXT    NOT NULL,
      system_message    TEXT    NOT NULL,
      status            TEXT    NOT NULL DEFAULT 'pending',
      created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
      fired_at          TEXT,
      cancelled_at      TEXT,
      source            TEXT    DEFAULT '',
      recurrence_type   TEXT,
      recurrence_config TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_reminders_due_at ON reminders(status, due_at);
  `)
  // 迁移：老库补上周期提醒字段
  try { db.exec(`ALTER TABLE reminders ADD COLUMN recurrence_type TEXT`) } catch {}
  try { db.exec(`ALTER TABLE reminders ADD COLUMN recurrence_config TEXT`) } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS prefetch_tasks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      source      TEXT    NOT NULL UNIQUE,
      label       TEXT    NOT NULL,
      url         TEXT    NOT NULL,
      ttl_minutes INTEGER NOT NULL DEFAULT 60,
      tags        TEXT    DEFAULT '[]',
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_prefetch_tasks_enabled ON prefetch_tasks(enabled);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS prefetch_cache (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      source     TEXT    NOT NULL,
      content    TEXT    NOT NULL,
      fetched_at TEXT    NOT NULL,
      expires_at TEXT    NOT NULL,
      tags       TEXT    DEFAULT '[]',
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_prefetch_expires ON prefetch_cache(expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_prefetch_source ON prefetch_cache(source);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS ui_signals (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      type       TEXT    NOT NULL,
      target     TEXT,
      payload    TEXT    NOT NULL DEFAULT '{}',
      ts         INTEGER NOT NULL,
      consumed   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ui_signals_unconsumed ON ui_signals(consumed, ts);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS media_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      kind       TEXT    NOT NULL,
      url        TEXT    NOT NULL,
      title      TEXT    NOT NULL DEFAULT '',
      video_id   TEXT,
      platform   TEXT,
      played_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_media_history_played_at ON media_history(played_at);
  `)
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_media_history_url ON media_history(url)`) } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS music_library (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      title      TEXT    NOT NULL DEFAULT '',
      artist     TEXT    NOT NULL DEFAULT '',
      album      TEXT    NOT NULL DEFAULT '',
      file_path  TEXT    NOT NULL UNIQUE,
      duration   INTEGER NOT NULL DEFAULT 0,
      lrc        TEXT    NOT NULL DEFAULT '',
      cover      TEXT    NOT NULL DEFAULT '',
      source_url TEXT    NOT NULL DEFAULT '',
      added_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_music_title  ON music_library(title);
    CREATE INDEX IF NOT EXISTS idx_music_artist ON music_library(artist);
    CREATE INDEX IF NOT EXISTS idx_music_added  ON music_library(added_at);
  `)

  // 重建 FTS 索引（覆盖已有数据，确保历史记忆也被索引）
  db.exec(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`)
}

export function insertUISignal({ type, target = null, payload = {}, ts = Date.now() }) {
  return getDB().prepare(
    `INSERT INTO ui_signals (type, target, payload, ts) VALUES (?, ?, ?, ?)`
  ).run(type, target, JSON.stringify(payload || {}), ts).lastInsertRowid
}

export function getUnconsumedUISignals(windowMs = 60_000) {
  const since = Date.now() - windowMs
  return getDB().prepare(
    `SELECT id, type, target, payload, ts FROM ui_signals
     WHERE consumed = 0 AND ts >= ?
     ORDER BY ts ASC`
  ).all(since)
}

export function markUISignalsConsumed(ids = []) {
  if (!ids.length) return
  const placeholders = ids.map(() => '?').join(',')
  getDB().prepare(`UPDATE ui_signals SET consumed = 1 WHERE id IN (${placeholders})`).run(...ids)
}

export function normalizeConversationPartyId(id) {
  if (!id) return id
  const text = String(id).trim()
  if (!text) return text
  if (/^ID:\d+$/i.test(text)) return `ID:${text.replace(/^ID:/i, '')}`
  if (/^\d+$/.test(text)) return `ID:${text}`
  return text
}

function normalizeMemoryEntity(entity) {
  if (!entity) return null
  const normalizedParty = normalizeConversationPartyId(entity)
  if (normalizedParty !== entity) return normalizedParty

  const lower = String(entity).trim().toLowerCase()
  if (USER_ID_ALIASES.has(lower)) return CANONICAL_USER_ID
  if (AGENT_ENTITY_ALIASES.has(lower)) return CANONICAL_AGENT_ENTITY

  // 处理平台复合 ID（如 discord:channelId:userId）：提取最后一段检查别名
  const lastColon = lower.lastIndexOf(':')
  if (lastColon !== -1 && lower.indexOf(':') !== lastColon) {
    const lastSegment = lower.slice(lastColon + 1)
    if (lastSegment && USER_ID_ALIASES.has(lastSegment)) return CANONICAL_USER_ID
    if (lastSegment && AGENT_ENTITY_ALIASES.has(lastSegment)) return CANONICAL_AGENT_ENTITY
  }

  return String(entity).trim()
}

function canonicalRootMemIdForEntity(entityId) {
  if (entityId === CANONICAL_USER_ID) return CANONICAL_USER_ROOT_MEM_ID
  if (entityId === CANONICAL_AGENT_ENTITY) return CANONICAL_AGENT_ROOT_MEM_ID
  return null
}

function canonicalRootMetaForEntity(entityId) {
  if (entityId === CANONICAL_USER_ID) {
    return {
      memId: CANONICAL_USER_ROOT_MEM_ID,
      eventType: 'person',
      title: '用户 ID:000001 身份标识',
      content: '用户唯一身份为 ID:000001，别名 Yuanda。',
      tags: ['identity', 'user', 'alias:Yuanda'],
    }
  }
  if (entityId === CANONICAL_AGENT_ENTITY) {
    return {
      memId: CANONICAL_AGENT_ROOT_MEM_ID,
      eventType: 'object',
      title: 'Agent Jarvis 身份标识',
      content: 'Agent Jarvis 是当前运行中的本地 AI 助手实例。',
      tags: ['identity', 'agent', 'jarvis'],
    }
  }
  return null
}

function safeJsonArray(value) {
  if (Array.isArray(value)) return value
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function safeStringify(value) {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return '{}'
  }
}

function uniqueStrings(values) {
  return [...new Set((values || []).filter(Boolean).map(v => String(v).trim()).filter(Boolean))]
}

function inferIdentityEntities(memory) {
  const text = [
    memory.mem_id,
    memory.title,
    memory.content,
    memory.detail,
    ...(memory.tags || []),
    ...(memory.entities || []),
  ].filter(Boolean).join(' ')

  const entities = []
  const memId = String(memory.mem_id || '').toLowerCase()
  const title = String(memory.title || '')

  if (
    /(?:^|[^a-z0-9])(000001|yuanda)(?:[^a-z0-9]|$)|ID:\s*000001/i.test(text) ||
    /^user_|^person_/.test(memId) ||
    /用户/.test(title)
  ) {
    entities.push(CANONICAL_USER_ID)
  }
  if (
    /Jarvis|Agent_Jarvis|JARVIS/i.test(text) ||
    /jarvis|^agent_/.test(memId)
  ) {
    entities.push(CANONICAL_AGENT_ENTITY)
  }

  return uniqueStrings(entities)
}

function canonicalizeLinkedTarget(targetId) {
  if (!targetId) return targetId
  if (USER_ROOT_ALIASES.has(targetId)) return CANONICAL_USER_ROOT_MEM_ID
  return targetId
}

function normalizeMemoryLinks(links) {
  return safeJsonArray(links).map(link => ({
    ...link,
    target_id: canonicalizeLinkedTarget(link.target_id),
  }))
}

function choosePrimaryIdentityEntity(memory) {
  const entities = memory.entities || []
  if (!entities.length) return null

  const text = [memory.mem_id, memory.title, memory.content].filter(Boolean).join(' ')
  const hasUser = entities.includes(CANONICAL_USER_ID)
  const hasAgent = entities.includes(CANONICAL_AGENT_ENTITY)

  if (hasUser && !hasAgent) return CANONICAL_USER_ID
  if (hasAgent && !hasUser) return CANONICAL_AGENT_ENTITY
  if (hasUser && hasAgent) {
    if (/用户|ID:\s*000001|\b000001\b|\bYuanda\b/i.test(text)) return CANONICAL_USER_ID
    return CANONICAL_AGENT_ENTITY
  }
  return null
}

function isCanonicalRootMemory(memory) {
  return [CANONICAL_USER_ROOT_MEM_ID, CANONICAL_AGENT_ROOT_MEM_ID].includes(memory.mem_id)
}

function ensureCanonicalIdentityRoot(entityId) {
  if (!AUTO_CANONICAL_IDENTITY_ROOTS) return null

  const meta = canonicalRootMetaForEntity(entityId)
  if (!meta) return null

  const db = getDB()
  const existing = db.prepare(`
    SELECT id, entities, tags, links, title, content
    FROM memories
    WHERE mem_id = ?
    LIMIT 1
  `).get(meta.memId)

  if (existing) {
    const entities = uniqueStrings([...safeJsonArray(existing.entities), entityId])
    const tags = uniqueStrings([...safeJsonArray(existing.tags), ...meta.tags])
    const links = normalizeMemoryLinks(existing.links)
    db.prepare(`
      UPDATE memories
      SET event_type = ?, title = ?, content = ?, entities = ?, tags = ?, links = ?, timestamp = ?
      WHERE id = ?
    `).run(
      meta.eventType,
      existing.title || meta.title,
      existing.content || meta.content,
      JSON.stringify(entities),
      JSON.stringify(tags),
      JSON.stringify(links),
      new Date().toISOString(),
      existing.id
    )
    return existing.id
  }

  const result = db.prepare(`
    INSERT INTO memories (event_type, content, detail, title, mem_id, entities, concepts, tags, links, source_ref, timestamp, parent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    meta.eventType,
    meta.content,
    meta.content,
    meta.title,
    meta.memId,
    JSON.stringify([entityId]),
    JSON.stringify([]),
    JSON.stringify(meta.tags),
    JSON.stringify([]),
    'identity_normalizer',
    new Date().toISOString()
  )

  return result.lastInsertRowid
}

// 按语义 mem_id 读取单条记忆（用于 Agent 可自改的身份/人格类根记忆）
export function getMemoryByMemId(memId) {
  const db = getDB()
  return db.prepare('SELECT id, mem_id, event_type, title, content, detail FROM memories WHERE mem_id = ? LIMIT 1').get(memId) || null
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

// 解析语义 mem_id 字符串 → 真实整数 id
function resolveMemId(memId) {
  if (!memId) return null
  const db = getDB()
  const row = db.prepare(`SELECT id FROM memories WHERE mem_id = ? LIMIT 1`).get(memId)
  return row ? row.id : null
}

// 解析 parent_ref 语义字符串 → 真实 memory id（兼容旧格式 "type:identifier"）
// 格式："person:ID:000001"  → 找该 entity 最新的 person 根节点
//       "knowledge:X框架"   → FTS 搜索最近匹配的 knowledge 记录
function resolveParentRef(parentRef) {
  if (!parentRef) return null
  const db = getDB()
  const normalizedParentRef = canonicalizeLinkedTarget(parentRef)

  // 优先尝试按 mem_id 查找（新格式）
  const byMemId = db.prepare(`SELECT id FROM memories WHERE mem_id = ? LIMIT 1`).get(normalizedParentRef)
  if (byMemId) return byMemId.id

  // 旧格式：type:identifier
  const colonIdx = normalizedParentRef.indexOf(':')
  if (colonIdx === -1) return null

  const type = normalizedParentRef.slice(0, colonIdx).trim()
  const identifier = normalizedParentRef.slice(colonIdx + 1).trim()
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
// 支持旧格式（event_type/entities/detail 等）和新格式（type/id/title/links/parent_id 语义字符串）
export function insertMemory(memory) {
  const db = getDB()

  // 新格式适配：将 type → event_type，id → mem_id，parent_id（语义）→ parent_ref
  const normalizedMemory = { ...memory }
  if (memory.type && !memory.event_type) {
    normalizedMemory.event_type = memory.type
  }
  if (memory.id && !memory.mem_id) {
    normalizedMemory.mem_id = memory.id
  }
  // 新格式的 parent_id 是语义字符串，映射到 parent_ref 走旧解析流程
  if (memory.parent_id && typeof memory.parent_id === 'string' && !memory.parent_ref) {
    normalizedMemory.parent_ref = memory.parent_id
  }
  // 新格式无 detail 字段时，用 content 填充保持 NOT NULL 约束
  if (!normalizedMemory.detail) {
    normalizedMemory.detail = normalizedMemory.content || ''
  }

  normalizedMemory.entities = uniqueStrings([
    ...safeJsonArray(normalizedMemory.entities),
    ...inferIdentityEntities(normalizedMemory),
  ]).map(normalizeMemoryEntity)

  normalizedMemory.tags = uniqueStrings(safeJsonArray(normalizedMemory.tags))
  normalizedMemory.links = normalizeMemoryLinks(normalizedMemory.links)

  const m = normalizedMemory

  if (!m.parent_ref && !isCanonicalRootMemory(m)) {
    const primaryEntity = choosePrimaryIdentityEntity(m)
    const rootMemId = canonicalRootMemIdForEntity(primaryEntity)
    if (rootMemId) {
      ensureCanonicalIdentityRoot(primaryEntity)
      m.parent_ref = rootMemId

      const existingTargets = new Set(m.links.map(link => link.target_id))
      if (!existingTargets.has(rootMemId)) {
        m.links.push({ target_id: rootMemId, relation: 'child_of' })
      }
    }
  }

  // mem_id 去重：同 mem_id 已存在时直接更新
  if (m.mem_id) {
    const existing = db.prepare(`SELECT id FROM memories WHERE mem_id = ? LIMIT 1`).get(m.mem_id)
    if (existing) {
      db.prepare(`
        UPDATE memories SET content = ?, detail = ?, title = ?, entities = ?, tags = ?, links = ?, timestamp = ?
        WHERE id = ?
      `).run(
        m.content,
        m.detail,
        m.title || '',
        JSON.stringify(m.entities || []),
        JSON.stringify(m.tags || []),
        JSON.stringify(m.links || []),
        m.timestamp || new Date().toISOString(),
        existing.id
      )
      console.log(`[DB] 更新记忆节点：${m.mem_id}`)
      return { id: existing.id, updated: true }
    }
  }

  // person / object 根节点：按 entity ID upsert，避免重复根节点（旧格式兼容）
  if (['person', 'object'].includes(m.event_type) && !m.parent_ref) {
    const firstEntity = (m.entities || [])[0]
    if (firstEntity) {
      const existing = db.prepare(`
        SELECT id FROM memories
        WHERE event_type = ? AND entities LIKE ? AND parent_id IS NULL
        LIMIT 1
      `).get(m.event_type, `%${firstEntity}%`)
      if (existing) {
        db.prepare(`
          UPDATE memories SET content = ?, detail = ?, title = ?, entities = ?, concepts = ?, tags = ?, links = ?, timestamp = ?
          WHERE id = ?
        `).run(
          m.content,
          m.detail,
          m.title || '',
          JSON.stringify(m.entities || []),
          JSON.stringify(m.concepts || []),
          JSON.stringify(m.tags || []),
          JSON.stringify(m.links || []),
          m.timestamp || new Date().toISOString(),
          existing.id
        )
        console.log(`[DB] 更新根节点：${m.event_type} ${firstEntity}`)
        return { id: existing.id, updated: true }
      }
    }
  }

  // 解析 parent_ref → parent_id（整数）
  const parentId = m.parent_ref ? resolveParentRef(m.parent_ref) : null

  // 工具知识记忆去重：按 tool:标签匹配，同工具只保留最新（旧格式兼容）
  const memoryTags = m.tags || []
  const toolTag = Array.isArray(memoryTags) ? memoryTags.find(t => t.startsWith('tool:')) : null
  if (toolTag && m.event_type === 'knowledge') {
    const toolName = toolTag.replace('tool:', '')
    const existing = db.prepare(`
      SELECT id FROM memories
      WHERE event_type = 'knowledge'
      AND tags LIKE ?
      ORDER BY timestamp DESC LIMIT 1
    `).get(`%tool:${toolName}%`)
    if (existing) {
      db.prepare(`
        UPDATE memories SET content = ?, detail = ?, title = ?, concepts = ?, tags = ?, links = ?, timestamp = ?
        WHERE id = ?
      `).run(
        m.content, m.detail, m.title || '',
        JSON.stringify(m.concepts || []),
        JSON.stringify(m.tags || []),
        JSON.stringify(m.links || []),
        m.timestamp || new Date().toISOString(),
        existing.id
      )
      console.log(`[DB] 更新工具记忆：${toolName}`)
      return { id: existing.id, updated: true }
    }
  }

  // 普通记忆去重：同类型且 content 前40字相同则跳过
  const contentPrefix = (m.content || '').slice(0, 40)
  const dup = db.prepare(`
    SELECT id FROM memories WHERE event_type = ? AND content LIKE ? LIMIT 1
  `).get(m.event_type, `${contentPrefix}%`)
  if (dup) {
    console.log(`[DB] 跳过重复记忆：${contentPrefix}…`)
    return null
  }

  // URL 去重：同 URL 当天已有记录则跳过
  const urlTag = Array.isArray(memoryTags) ? memoryTags.find(t => t.startsWith('url:')) : null
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
    INSERT INTO memories (event_type, content, detail, title, mem_id, entities, concepts, tags, links, source_ref, timestamp, parent_id)
    VALUES (@event_type, @content, @detail, @title, @mem_id, @entities, @concepts, @tags, @links, @source_ref, @timestamp, @parent_id)
  `).run({
    event_type: m.event_type,
    content:    m.content,
    detail:     m.detail,
    title:      m.title || '',
    mem_id:     m.mem_id || null,
    entities:   JSON.stringify(m.entities || []),
    concepts:   JSON.stringify(m.concepts || []),
    tags:       JSON.stringify(m.tags || []),
    links:      JSON.stringify(m.links || []),
    source_ref: m.source_ref || null,
    timestamp:  m.timestamp || new Date().toISOString(),
    parent_id:  parentId,
  })
}

// 按 mem_id 做 PATCH 式 upsert：识别器走工具调用主动判重时使用。
// 与 insertMemory 区别：
//   - 必须有 mem_id
//   - 已存在 mem_id：只更新传入字段（PATCH 语义），未传字段保留
//   - 不存在：直接 INSERT，绕开 content 前 40 字 / URL 当日去重
//   - body_path 自动写入 tags 作为 body_path:xxx 标签
export function upsertMemoryByMemId(memory) {
  const db = getDB()
  if (!memory?.mem_id) throw new Error('upsertMemoryByMemId 需要 mem_id')

  const m = { ...memory }
  if (m.type && !m.event_type) m.event_type = m.type
  if (m.parent_mem_id && !m.parent_ref) m.parent_ref = m.parent_mem_id

  // body_path 写入 tags（避免新增列；formatMemoriesForPrompt 解析此 tag 显示）
  if (m.body_path) {
    const baseTags = safeJsonArray(m.tags)
    const filtered = baseTags.filter(t => !String(t).startsWith('body_path:'))
    m.tags = [...filtered, `body_path:${m.body_path}`]
  }

  if (m.entities !== undefined) {
    m.entities = uniqueStrings(safeJsonArray(m.entities)).map(normalizeMemoryEntity)
  }
  if (m.tags !== undefined) {
    m.tags = uniqueStrings(safeJsonArray(m.tags))
  }
  if (m.links !== undefined) {
    m.links = normalizeMemoryLinks(m.links)
  }

  const existing = db.prepare(`SELECT id FROM memories WHERE mem_id = ? LIMIT 1`).get(m.mem_id)

  if (existing) {
    const sets = []
    const params = { id: existing.id }

    if (m.event_type !== undefined) { sets.push('event_type = @event_type'); params.event_type = m.event_type }
    if (m.content !== undefined)    { sets.push('content = @content');       params.content = m.content }
    if (m.detail !== undefined)     { sets.push('detail = @detail');         params.detail = m.detail }
    if (m.title !== undefined)      { sets.push('title = @title');           params.title = m.title }
    if (m.entities !== undefined)   { sets.push('entities = @entities');     params.entities = JSON.stringify(m.entities) }
    if (m.concepts !== undefined)   { sets.push('concepts = @concepts');     params.concepts = JSON.stringify(m.concepts) }
    if (m.tags !== undefined)       { sets.push('tags = @tags');             params.tags = JSON.stringify(m.tags) }
    if (m.links !== undefined)      { sets.push('links = @links');           params.links = JSON.stringify(m.links) }
    if (m.source_ref !== undefined) { sets.push('source_ref = @source_ref'); params.source_ref = m.source_ref }
    if (m.parent_ref !== undefined) {
      sets.push('parent_id = @parent_id')
      params.parent_id = m.parent_ref ? resolveParentRef(m.parent_ref) : null
    }

    sets.push('timestamp = @timestamp')
    params.timestamp = m.timestamp || new Date().toISOString()

    db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = @id`).run(params)
    console.log(`[DB] PATCH 记忆：${m.mem_id}`)
    return { id: existing.id, mem_id: m.mem_id, updated: true }
  }

  if (!m.event_type) throw new Error('新建记忆需要 type')
  if (!m.title)      throw new Error('新建记忆需要 title')
  if (!m.content)    throw new Error('新建记忆需要 content')

  const parentId = m.parent_ref ? resolveParentRef(m.parent_ref) : null
  const result = db.prepare(`
    INSERT INTO memories (event_type, content, detail, title, mem_id, entities, concepts, tags, links, source_ref, timestamp, parent_id)
    VALUES (@event_type, @content, @detail, @title, @mem_id, @entities, @concepts, @tags, @links, @source_ref, @timestamp, @parent_id)
  `).run({
    event_type: m.event_type,
    content:    m.content,
    detail:     m.detail !== undefined ? m.detail : m.content,
    title:      m.title,
    mem_id:     m.mem_id,
    entities:   JSON.stringify(m.entities || []),
    concepts:   JSON.stringify(m.concepts || []),
    tags:       JSON.stringify(m.tags || []),
    links:      JSON.stringify(m.links || []),
    source_ref: m.source_ref || null,
    timestamp:  m.timestamp || new Date().toISOString(),
    parent_id:  parentId,
  })

  console.log(`[DB] INSERT 新记忆：${m.mem_id}`)
  return { id: result.lastInsertRowid, mem_id: m.mem_id, updated: false }
}

// 批量按关键词搜索：每个关键词独立 FTS5 检索，返回 { mem_id, type, title, content_excerpt, matched_by[] }
// 同一 mem_id 在多个关键词命中时合并，matched_by 列出所有命中关键词
export function searchMemoriesByKeywords(keywords, { limitPerKeyword = 5, typeFilter = null } = {}) {
  if (!Array.isArray(keywords) || keywords.length === 0) return []
  const merged = new Map()  // mem_id (or 'row:'+id) → { row, matched_by:Set }

  for (const keyword of keywords) {
    if (!keyword) continue
    const hits = searchMemories(keyword, limitPerKeyword)
    for (const row of hits) {
      if (typeFilter && row.event_type !== typeFilter) continue
      const key = row.mem_id || `row:${row.id}`
      if (!merged.has(key)) merged.set(key, { row, matched_by: new Set() })
      merged.get(key).matched_by.add(keyword)
    }
  }

  return [...merged.values()].map(({ row, matched_by }) => {
    const tags = safeJsonArray(row.tags)
    const bodyPathTag = tags.find(t => String(t).startsWith('body_path:'))
    return {
      mem_id: row.mem_id || null,
      id: row.id,
      type: row.event_type,
      title: row.title || '',
      content_excerpt: (row.content || '').slice(0, 80),
      timestamp: row.timestamp,
      body_path: bodyPathTag ? String(bodyPathTag).replace('body_path:', '') : null,
      matched_by: [...matched_by],
    }
  })
}

// 查询最近 N 条记忆
export function getRecentMemories(limit = 10) {
  const db = getDB()
  return db.prepare(`
    SELECT * FROM memories ORDER BY timestamp DESC LIMIT ?
  `).all(limit)
}

export function getMemoryCount() {
  const db = getDB()
  return db.prepare('SELECT COUNT(*) AS c FROM memories').get().c
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
  const normalizedId = normalizeConversationPartyId(id)
  db.prepare(`
    INSERT INTO entities (id, label, last_seen)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET last_seen = datetime('now'), label = COALESCE(excluded.label, label)
  `).run(normalizedId, label)
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
export function insertConversation({ role, from_id, to_id = null, content, timestamp, channel = '' }) {
  const db = getDB()
  const fromId = normalizeConversationPartyId(from_id)
  const toId = normalizeConversationPartyId(to_id)
  db.prepare(`
    INSERT INTO conversations (role, from_id, to_id, content, timestamp, channel)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(role, fromId, toId, content, timestamp, channel || '')
}

// 获取某个对话对象的最近 N 条消息（用户消息 + Jarvis 回复，按时序）
// anchor: 锚点消息 id，null 表示最新；offset: 向上偏移（用于窗口上移）
export function getConversationWindow(entityId, userCount = 5, anchorId = null, offsetUp = 0) {
  const db = getDB()
  const normalizedId = normalizeConversationPartyId(entityId)

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
    `).all(normalizedId, normalizedId, anchor.timestamp, userCount + offsetUp)
  } else {
    userRows = db.prepare(`
      SELECT * FROM conversations
      WHERE (from_id = ? OR to_id = ?)
      AND role = 'user'
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(normalizedId, normalizedId, userCount + offsetUp)
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
  `).all(normalizedId, normalizedId, minTs, maxTs)
}

// 搜索对话记录（关键词），返回匹配行及其上下文（前后各 N 条）
export function searchConversations(entityId, keyword, context = 5) {
  const db = getDB()
  const normalizedId = normalizeConversationPartyId(entityId)
  const matches = db.prepare(`
    SELECT * FROM conversations
    WHERE (from_id = ? OR to_id = ?)
    AND content LIKE ?
    ORDER BY timestamp DESC
    LIMIT 10
  `).all(normalizedId, normalizedId, `%${keyword}%`)

  if (!matches.length) return []

  // 取第一个匹配的上下文窗口
  const anchor = matches[0]
  return db.prepare(`
    SELECT * FROM conversations
    WHERE (from_id = ? OR to_id = ?)
    AND ABS(CAST((julianday(timestamp) - julianday(?)) * 86400 AS INTEGER)) < ${context * 30}
    ORDER BY timestamp ASC
    LIMIT ?
  `).all(normalizedId, normalizedId, anchor.timestamp, context * 2 + 1)
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
  const normalizedId = normalizeMemoryEntity(entityId)
  const rootMemId = canonicalRootMemIdForEntity(normalizedId)
  return db.prepare(`
    SELECT * FROM memories
    WHERE event_type IN ('person', 'object')
    AND entities LIKE ?
    AND parent_id IS NULL
    ORDER BY CASE WHEN mem_id = ? THEN 0 ELSE 1 END, timestamp DESC
    LIMIT 1
  `).get(`%${normalizedId}%`, rootMemId || '')
}

// 获取某实体相关的所有记忆（非根节点本身，按时间倒序）
export function getMemoriesByEntity(entityId, limit = 10) {
  const db = getDB()
  const normalizedId = normalizeMemoryEntity(entityId)
  const root = getPersonMemory(normalizedId)
  return db.prepare(`
    SELECT * FROM memories
    WHERE (
      entities LIKE ?
      OR parent_id = ?
      OR links LIKE ?
    )
    AND id != ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(`%${normalizedId}%`, root?.id || -1, `%${root?.mem_id || ''}%`, root?.id || -1, limit)
}

// 获取与某实体的近期对话记录（最近 limit 条，不超过 maxHours 小时）
export function getRecentConversation(entityId, limit = 20, maxHours = 24) {
  const db = getDB()
  const normalizedId = normalizeConversationPartyId(entityId)
  const cutoff = new Date(Date.now() - maxHours * 3600 * 1000).toISOString()
  const rows = db.prepare(`
    SELECT * FROM conversations
    WHERE (from_id = ? OR to_id = ?)
    AND timestamp >= ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(normalizedId, normalizedId, cutoff, limit)
  return rows.reverse() // 按时间正序返回
}

// 获取全局近期对话时间线（用于 TICK/heartbeat 场景，无明确发送者时仍可注入最近聊天上下文）
export function getRecentConversationTimeline(limit = 20, maxHours = 24) {
  const db = getDB()
  const cutoff = new Date(Date.now() - maxHours * 3600 * 1000).toISOString()
  const rows = db.prepare(`
    SELECT * FROM conversations
    WHERE timestamp >= ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(cutoff, limit)
  return rows.reverse()
}

// 获取最近 N 小时内有过双向对话的所有他者 ID（按最近对话时间倒序）
// 用于 TICK 场景给 send_message 提供"熟人"白名单，让意识体可主动联系已建立过连接的对象
export function getRecentConversationPartners(maxHours = 24, limit = 20) {
  const db = getDB()
  const cutoff = new Date(Date.now() - maxHours * 3600 * 1000).toISOString()
  const rows = db.prepare(`
    SELECT party, MAX(timestamp) AS last_ts FROM (
      SELECT from_id AS party, timestamp FROM conversations
        WHERE timestamp >= ? AND from_id IS NOT NULL AND from_id <> 'jarvis'
      UNION ALL
      SELECT to_id AS party, timestamp FROM conversations
        WHERE timestamp >= ? AND to_id   IS NOT NULL AND to_id   <> 'jarvis'
    )
    WHERE party IS NOT NULL AND party <> ''
    GROUP BY party
    ORDER BY last_ts DESC
    LIMIT ?
  `).all(cutoff, cutoff, limit)
  return rows.map(r => normalizeConversationPartyId(r.party)).filter(Boolean)
}

// 写入一条行动日志
export function insertActionLog({
  timestamp,
  tool,
  summary,
  detail = '',
  status = 'ok',
  risk = 'medium',
  args = null,
  argsJson = null,
  resultPreview = '',
  error = '',
  durationMs = 0,
  source = '',
}) {
  const db = getDB()
  const serializedArgs = argsJson ?? safeStringify(args ?? {})
  db.prepare(`
    INSERT INTO action_logs (
      timestamp, tool, summary, detail,
      status, risk, args_json, result_preview, error, duration_ms, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    timestamp,
    tool,
    summary,
    String(detail).slice(0, 300),
    status,
    risk,
    String(serializedArgs || '{}').slice(0, 2000),
    String(resultPreview || '').slice(0, 500),
    String(error || '').slice(0, 500),
    Number(durationMs) || 0,
    String(source || '').slice(0, 120)
  )
}

// 获取最近 N 条行动日志（时间正序）
export function getRecentActionLogs(limit = 50) {
  const db = getDB()
  return db.prepare(`
    SELECT * FROM action_logs ORDER BY id DESC LIMIT ?
  `).all(limit).reverse()
}

export function createReminder({ userId, dueAt, task, systemMessage, source = '', recurrenceType = null, recurrenceConfig = null }) {
  const db = getDB()
  const normalizedUserId = normalizeConversationPartyId(userId || CANONICAL_USER_ID)
  const configStr = recurrenceConfig ? JSON.stringify(recurrenceConfig) : null
  return db.prepare(`
    INSERT INTO reminders (user_id, due_at, task, system_message, status, source, recurrence_type, recurrence_config)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
  `).run(normalizedUserId, dueAt, task, systemMessage, source, recurrenceType, configStr)
}

// 找到同 user + 同 due_at（精确到分钟）且非周期的待触发提醒，用于合并
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

// 周期提醒触发后：保持 pending，推进 due_at 到下次发生时间
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

// ── 预热缓存 ──────────────────────────────────────────────────────────────

export function savePrefetchCache(source, content, ttlMinutes, tags = []) {
  const db = getDB()
  const now = new Date()
  const fetched_at = now.toISOString()
  const expires_at = new Date(now.getTime() + ttlMinutes * 60 * 1000).toISOString()
  db.prepare(`
    INSERT INTO prefetch_cache (source, content, fetched_at, expires_at, tags)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source) DO UPDATE SET
      content    = excluded.content,
      fetched_at = excluded.fetched_at,
      expires_at = excluded.expires_at,
      tags       = excluded.tags
  `).run(source, content, fetched_at, expires_at, JSON.stringify(tags))
}

export function getValidPrefetchCache() {
  const db = getDB()
  const now = new Date().toISOString()
  return db.prepare(`
    SELECT * FROM prefetch_cache
    WHERE expires_at > ?
    ORDER BY fetched_at DESC
  `).all(now)
}

export function clearExpiredPrefetchCache() {
  const db = getDB()
  const now = new Date().toISOString()
  db.prepare(`DELETE FROM prefetch_cache WHERE expires_at <= ?`).run(now)
}

// ── 预热任务管理 ──────────────────────────────────────────────────────────

export function upsertPrefetchTask({ source, label, url, ttlMinutes = 60, tags = [] }) {
  const db = getDB()
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO prefetch_tasks (source, label, url, ttl_minutes, tags, enabled, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(source) DO UPDATE SET
      label       = excluded.label,
      url         = excluded.url,
      ttl_minutes = excluded.ttl_minutes,
      tags        = excluded.tags,
      enabled     = 1,
      updated_at  = excluded.updated_at
  `).run(source, label, url, ttlMinutes, JSON.stringify(tags), now)
}

export function removePrefetchTask(source) {
  const db = getDB()
  const result = db.prepare(`DELETE FROM prefetch_tasks WHERE source = ?`).run(source)
  return result.changes > 0
}

export function listPrefetchTasks() {
  const db = getDB()
  return db.prepare(`SELECT * FROM prefetch_tasks ORDER BY created_at ASC`).all()
}

export function getEnabledPrefetchTasks() {
  const db = getDB()
  return db.prepare(`SELECT * FROM prefetch_tasks WHERE enabled = 1 ORDER BY created_at ASC`).all()
}

// ── 媒体播放历史 ──────────────────────────────────────────────────────────────

export function upsertMediaHistory({ kind, url, title = '', videoId = null, platform = null }) {
  const db = getDB()
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO media_history (kind, url, title, video_id, platform, played_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET
      title     = excluded.title,
      played_at = excluded.played_at
  `).run(kind, url, title, videoId || null, platform || null, now)
}

export function getMediaHistory(limit = 30) {
  const db = getDB()
  return db.prepare(`
    SELECT * FROM media_history ORDER BY played_at DESC LIMIT ?
  `).all(limit)
}

// ── Music Library ────────────────────────────────────────────────────────────

export function upsertMusicTrack({ title = '', artist = '', album = '', filePath, duration = 0, lrc = '', cover = '', sourceUrl = '' }) {
  const db = getDB()
  db.prepare(`
    INSERT INTO music_library (title, artist, album, file_path, duration, lrc, cover, source_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      title      = excluded.title,
      artist     = excluded.artist,
      album      = excluded.album,
      duration   = excluded.duration,
      lrc        = CASE WHEN excluded.lrc != '' THEN excluded.lrc ELSE lrc END,
      cover      = CASE WHEN excluded.cover != '' THEN excluded.cover ELSE cover END,
      source_url = CASE WHEN excluded.source_url != '' THEN excluded.source_url ELSE source_url END
  `).run(title, artist, album, filePath, duration, lrc, cover, sourceUrl)
  return db.prepare(`SELECT * FROM music_library WHERE file_path = ?`).get(filePath)
}

export function getMusicTrack(id) {
  return getDB().prepare(`SELECT * FROM music_library WHERE id = ?`).get(id)
}

export function searchMusicLibrary(query, limit = 20) {
  const db = getDB()
  const q = `%${query}%`
  return db.prepare(`
    SELECT * FROM music_library
    WHERE title LIKE ? OR artist LIKE ? OR album LIKE ?
    ORDER BY added_at DESC LIMIT ?
  `).all(q, q, q, limit)
}

export function listMusicLibrary(limit = 50) {
  return getDB().prepare(`SELECT * FROM music_library ORDER BY added_at DESC LIMIT ?`).all(limit)
}

export function updateMusicLrc(id, lrc) {
  getDB().prepare(`UPDATE music_library SET lrc = ? WHERE id = ?`).run(lrc, id)
}

export function deleteMusicTrack(id) {
  getDB().prepare(`DELETE FROM music_library WHERE id = ?`).run(id)
}
