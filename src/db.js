import { getDB, closeDBForTest } from './db/connection.js'
import { CANONICAL_USER_ID, normalizeConversationPartyId } from './db/utils.js'

export { getDB, closeDBForTest }
export { normalizeConversationPartyId }
export * from './db/repositories/reminders.js'
export * from './db/repositories/prefetch.js'
export * from './db/repositories/media-library.js'
export * from './db/repositories/audits.js'
export * from './db/repositories/thread-state.js'

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

export function upsertClawbotToken(fromUserId, contextToken) {
  if (!fromUserId || !contextToken) return
  getDB().prepare(
    `INSERT INTO wechat_clawbot_tokens (from_user_id, context_token, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(from_user_id) DO UPDATE SET
       context_token = excluded.context_token,
       updated_at    = excluded.updated_at`
  ).run(String(fromUserId), String(contextToken))
}

export function getAllClawbotTokens() {
  return getDB().prepare(
    `SELECT from_user_id, context_token FROM wechat_clawbot_tokens`
  ).all()
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

// LLM 可能传字符串/越界值，强制归一到 1-5
function clampSalience(value) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return 3
  return Math.max(1, Math.min(5, n))
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

// 按语义 mem_id 读取单条记忆（用于 Agent 可自改的身份/人格类根记忆 + 整合器）
// 返回完整 row（含 salience/entities/timestamp），整合器需要这些字段
export function getMemoryByMemId(memId) {
  const db = getDB()
  return db.prepare('SELECT * FROM memories WHERE mem_id = ? LIMIT 1').get(memId) || null
}

export function deleteMemoryByMemId(mem_id) {
  const db = getDB()
  if (!mem_id) throw new Error('deleteMemoryByMemId 需要 mem_id')
  const result = db.prepare(`DELETE FROM memories WHERE mem_id = ?`).run(mem_id)
  return result.changes > 0
}

// 软隐藏记忆（动态记忆池：剔除 = 看不见，不是删除）。
// 把行的 visibility 设为 0，hidden_at 落时间戳，mergedInto 可选记录合并去向。
// 读路径默认 WHERE visibility = 1，所以隐藏后 search / get* 等都自动过滤。
// 数据仍完整保留：FTS5 索引、embedding、links、parent 链全部不动，
// 第 3 步专注帧恢复机制可以靠 mem_id 反向 UPDATE visibility=1 复活。
export function hideMemoryByMemId(memId, { mergedInto = null, hiddenAt = null } = {}) {
  const db = getDB()
  if (!memId) throw new Error('hideMemoryByMemId 需要 mem_id')
  const ts = hiddenAt || new Date().toISOString()
  const result = db.prepare(`
    UPDATE memories
    SET visibility = 0, hidden_at = ?, merged_into = ?
    WHERE mem_id = ?
  `).run(ts, mergedInto || null, memId)
  return result.changes > 0
}

// 集中点：所有读路径共用的可见性谓词。
// 写成常量 + 拼接片段，确保改一处所有路径同步变。
// 注意：memoryExistsByMemId / getMemoryByMemId / mem_id 主键去重 SELECT 故意不用这个常量，
// 因为它们要看到隐藏行（避免 UNIQUE 冲突，且 merge 工具自己要能取 drops 的当前状态）。
const VISIBLE_CLAUSE = 'visibility = 1'

// 候选实体：fact/person 记忆数 ≥3 的 entity ID，按出现次数倒序
// 只统计 visible 行（否则已经被合并隐藏的记忆还会反复让同一 entity 被挑出来）
export function getCandidateEntitiesForConsolidation(limit = 10) {
  const db = getDB()
  const rows = db.prepare(`SELECT entities FROM memories WHERE event_type IN ('fact','person') AND ${VISIBLE_CLAUSE}`).all()
  const counts = new Map()
  for (const r of rows) {
    try {
      const arr = JSON.parse(r.entities || '[]')
      for (const e of arr) counts.set(e, (counts.get(e) || 0) + 1)
    } catch {}
  }
  return [...counts.entries()]
    .filter(([e, c]) => e && c >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([entity, count]) => ({ entity, count }))
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
  // 只看 visible 行：被隐藏的根概念上"暂时不在"，允许新写入复活该实体
  if (['person', 'object'].includes(m.event_type) && !m.parent_ref) {
    const firstEntity = (m.entities || [])[0]
    if (firstEntity) {
      const existing = db.prepare(`
        SELECT id FROM memories
        WHERE event_type = ? AND entities LIKE ? AND parent_id IS NULL AND ${VISIBLE_CLAUSE}
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
  // 只看 visible：被隐藏的工具知识让位给新记忆
  const memoryTags = m.tags || []
  const toolTag = Array.isArray(memoryTags) ? memoryTags.find(t => t.startsWith('tool:')) : null
  if (toolTag && m.event_type === 'knowledge') {
    const toolName = toolTag.replace('tool:', '')
    const existing = db.prepare(`
      SELECT id FROM memories
      WHERE event_type = 'knowledge'
      AND tags LIKE ?
      AND ${VISIBLE_CLAUSE}
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
  // 只看 visible：之前被合并隐藏的同义内容，让 LLM 重新插入为新记忆——
  // 隐藏 ≈ "概念上不再 load-bearing"，如果用户重新提起就该出现，下一轮 consolidator 自然合并
  const contentPrefix = (m.content || '').slice(0, 40)
  const dup = db.prepare(`
    SELECT id FROM memories WHERE event_type = ? AND content LIKE ? AND ${VISIBLE_CLAUSE} LIMIT 1
  `).get(m.event_type, `${contentPrefix}%`)
  if (dup) {
    console.log(`[DB] 跳过重复记忆：${contentPrefix}…`)
    return null
  }

  // URL 去重：同 URL 当天已有记录则跳过（同样只看 visible）
  const urlTag = Array.isArray(memoryTags) ? memoryTags.find(t => t.startsWith('url:')) : null
  if (urlTag) {
    const today = new Date().toISOString().slice(0, 10)
    const urlDup = db.prepare(`
      SELECT id FROM memories WHERE tags LIKE ? AND timestamp LIKE ? AND ${VISIBLE_CLAUSE} LIMIT 1
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

export function memoryExistsByMemId(mem_id) {
  const db = getDB()
  return !!db.prepare(`SELECT id FROM memories WHERE mem_id = ? LIMIT 1`).get(mem_id)
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
    if (m.salience !== undefined)   { sets.push('salience = @salience');     params.salience = clampSalience(m.salience) }
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
    INSERT INTO memories (event_type, content, detail, title, mem_id, entities, concepts, tags, links, source_ref, timestamp, salience, parent_id)
    VALUES (@event_type, @content, @detail, @title, @mem_id, @entities, @concepts, @tags, @links, @source_ref, @timestamp, @salience, @parent_id)
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
    salience:   clampSalience(m.salience),
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

// 按日期窗口拉记忆，给"听见昨天/前天"类的时间词触发的自动注入用。
// 跟 getMemoriesByTimeRange 的区别：
//   - 半开区间 [from, to)，避免跨日边界双重计入
//   - 支持 types / minSalience 过滤
//   - 默认按 salience desc, timestamp asc：先重要、再时间早晚
// 时区注意：from/to 用本地带偏移 ISO（同 nowTimestamp），memories.timestamp 也是。
// 用 strftime('%s', ...) 转 unixepoch 比较，避开字符串字典序在 '+08:00' / 'Z' 上的踩坑。
export function getMemoriesByDateRange(from, to, {
  types = null,
  minSalience = null,
  limit = 8,
  orderBy = 'COALESCE(salience, 3) DESC, timestamp ASC',
} = {}) {
  const db = getDB()
  const conditions = [
    `strftime('%s', timestamp) >= strftime('%s', ?)`,
    `strftime('%s', timestamp) <  strftime('%s', ?)`,
    VISIBLE_CLAUSE,
  ]
  const params = [from, to]
  if (Array.isArray(types) && types.length > 0) {
    conditions.push(`event_type IN (${types.map(() => '?').join(',')})`)
    params.push(...types)
  }
  if (minSalience != null) {
    conditions.push(`COALESCE(salience, 3) >= ?`)
    params.push(minSalience)
  }
  params.push(limit)
  return db.prepare(`
    SELECT * FROM memories
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${orderBy}
    LIMIT ?
  `).all(...params)
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
    AND ${VISIBLE_CLAUSE}
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
    AND ${VISIBLE_CLAUSE}
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(`%from:${entityId}%`, limit)
}

// ── 对话记录 ──

// P0-1：进程内当前焦点话题。index.js 在 updateFocusFrame 之后 set 一次；
// insertConversation 写库时自动读这个变量，给本轮所有新写入的对话打 focus_topic。
// 不写文件、不持久化——焦点栈本身已经持久化在 focus_stack 表，这里只是个写入时的"印章"。
let currentFocusTopic = ''
export function setCurrentFocusTopic(topic) {
  if (Array.isArray(topic)) {
    currentFocusTopic = topic.slice(0, 3).join(',')
  } else {
    currentFocusTopic = String(topic || '').slice(0, 60)
  }
}
export function getCurrentFocusTopic() { return currentFocusTopic }

// 线索模型：进程内当前线索 id（写时归属的"印章"，与 currentFocusTopic 平行）。
// index.js 在归属判定之后 set 一次；insertConversation 写库时自动盖章。
let currentThreadId = ''
export function setCurrentThreadId(threadId) {
  currentThreadId = String(threadId || '')
}
export function getCurrentThreadId() { return currentThreadId }

// 写入一条对话记录
// focus_topic / open_question 优先取调用方显式传入；未传时 focus_topic 读 currentFocusTopic。
export function insertConversation({
  role, from_id, to_id = null, content, timestamp,
  channel = '', external_party_id = '',
  focus_topic = null, open_question = 0, thread_id = null,
  delivery_status = '',
}) {
  const db = getDB()
  const fromId = normalizeConversationPartyId(from_id)
  const toId = normalizeConversationPartyId(to_id)
  const topic = focus_topic == null ? currentFocusTopic : String(focus_topic || '')
  const threadId = thread_id == null ? currentThreadId : String(thread_id || '')
  const info = db.prepare(`
    INSERT INTO conversations (role, from_id, to_id, content, timestamp, channel, external_party_id, focus_topic, open_question, thread_id, delivery_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(role, fromId, toId, content, timestamp, channel || '', external_party_id || '', topic, open_question ? 1 : 0, threadId, delivery_status || '')
  return Number(info.lastInsertRowid) || 0
}

export function updateConversationDeliveryStatus(id, status) {
  if (!id) return 0
  const normalized = ['pending', 'delivered', 'failed'].includes(String(status)) ? String(status) : ''
  const info = getDB().prepare(`UPDATE conversations SET delivery_status = ? WHERE id = ?`).run(normalized, id)
  return info.changes || 0
}

// Return an identical, successfully delivered outbound message when the user
// has not spoken since it was sent. This is the durable heartbeat idempotency
// boundary: process restarts and long tick intervals must not turn silence into
// a reason to send the same message again.
export function findUnansweredDeliveredOutbound({ toId, content, channel = '', externalPartyId = '' } = {}) {
  const normalizedId = normalizeConversationPartyId(toId)
  if (!normalizedId || !String(content || '').trim()) return null
  return getDB().prepare(`
    SELECT id, timestamp, channel, external_party_id
    FROM conversations
    WHERE role = 'jarvis'
      AND to_id = ?
      AND content = ?
      AND channel = ?
      AND external_party_id = ?
      AND delivery_status = 'delivered'
      AND id > COALESCE((
        SELECT MAX(id)
        FROM conversations
        WHERE role = 'user' AND from_id = ?
      ), 0)
    ORDER BY id DESC
    LIMIT 1
  `).get(normalizedId, String(content), String(channel || ''), String(externalPartyId || ''), normalizedId) || null
}

// P0-1：给本轮触发判定的 user 消息回填 focus_topic
//   pushMessage 时焦点栈还没算（要等收到消息才更新），用户消息写库时 focus_topic = ''。
//   index.js 在 updateFocusFrame 之后调用本函数，用 (from_id, timestamp) 定位该行回填。
//   注意：不加 focus_topic 必须为空的 WHERE 约束——只通过 from_id+timestamp 精确定位单行；
//   即使外部预填了别的值，本轮焦点判断的结果才是权威的。
export function updateUserMessageFocusTopic(fromId, timestamp, topic, threadId = null) {
  if (!fromId || !timestamp) return 0
  const db = getDB()
  const normalizedId = normalizeConversationPartyId(fromId)
  const t = Array.isArray(topic) ? topic.slice(0, 3).join(',') : String(topic || '')
  const info = threadId
    ? db.prepare(`
        UPDATE conversations SET focus_topic = ?, thread_id = ?
        WHERE role = 'user' AND from_id = ? AND timestamp = ?
      `).run(t, String(threadId), normalizedId, timestamp)
    : db.prepare(`
        UPDATE conversations SET focus_topic = ?
        WHERE role = 'user' AND from_id = ? AND timestamp = ?
      `).run(t, normalizedId, timestamp)
  return info.changes || 0
}

// 线索合并修正（分类器事后仲裁"其实是同一条线索"）：把 source 线索的对话过户给 target。
// 这是合并而非删除——行还在，只是归属修正。
export function reassignConversationsThread(sourceThreadId, targetThreadId) {
  if (!sourceThreadId || !targetThreadId) return 0
  try {
    const info = getDB().prepare(`
      UPDATE conversations SET thread_id = ? WHERE thread_id = ?
    `).run(String(targetThreadId), String(sourceThreadId))
    return info.changes || 0
  } catch {
    return 0
  }
}

// 增量摘要器取数：某线索自 sinceAt 以来的对话（写时归属，不按时间区间圈地）。
export function getConversationsForThread(threadId, { sinceAt = null, limit = 60 } = {}) {
  if (!threadId) return []
  const db = getDB()
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 60))
  try {
    const rows = sinceAt
      ? db.prepare(`
          SELECT ${CONVERSATION_COLUMNS} FROM conversations
          WHERE thread_id = ? AND strftime('%s', timestamp) >= strftime('%s', ?)
          ORDER BY timestamp DESC, id DESC LIMIT ?
        `).all(String(threadId), sinceAt, safeLimit)
      : db.prepare(`
          SELECT ${CONVERSATION_COLUMNS} FROM conversations
          WHERE thread_id = ?
          ORDER BY timestamp DESC, id DESC LIMIT ?
        `).all(String(threadId), safeLimit)
    return rows.reverse()
  } catch {
    return []
  }
}

// P0-2：把某条 jarvis 消息标记为留了未答悬念（open_question=1）
//   executor.js send_message 写完库立刻拿回 row id，按需 mark。
export function markConversationOpenQuestion(id, isOpen = true) {
  if (!id) return 0
  const db = getDB()
  const info = db.prepare(`UPDATE conversations SET open_question = ? WHERE id = ?`).run(isOpen ? 1 : 0, id)
  return info.changes || 0
}

// 将最近一条 jarvis 消息内容裁剪为已说出的部分（TTS 被打断时调用）
export function updateLastJarvisConversationContent(spokenContent) {
  const db = getDB()
  const row = db.prepare(`SELECT id FROM conversations WHERE role = 'jarvis' ORDER BY id DESC LIMIT 1`).get()
  if (!row) return false
  db.prepare(`UPDATE conversations SET content = ? WHERE id = ?`).run(spokenContent, row.id)
  return true
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
    AND ${VISIBLE_CLAUSE}
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
    AND ${VISIBLE_CLAUSE}
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
    AND ${VISIBLE_CLAUSE}
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
    AND ${VISIBLE_CLAUSE}
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
    AND ${VISIBLE_CLAUSE}
    ORDER BY COALESCE(salience, 3) DESC, timestamp DESC
    LIMIT ?
  `).all(`%${normalizedId}%`, root?.id || -1, `%${root?.mem_id || ''}%`, root?.id || -1, limit)
}

// 获取与某实体的近期对话记录（最近 limit 条，不超过 maxHours 小时）
// 动态上下文记忆池 3.5：默认 WHERE focus_absorbed=0，把已被压缩回填吸收的子帧对话隐去
//   （主线深化时的「剔除残留噪声」）。absorbed != deleted——对话物理仍在表里，
//   传 includeAbsorbed=true 即可拿全量（admin / 调试 / focus-compress 自身的回看）。
function safeJsonString(value, fallback = []) {
  try {
    return JSON.stringify(value ?? fallback)
  } catch {
    return JSON.stringify(fallback)
  }
}

export function getUserProfile(userId) {
  const db = getDB()
  const normalizedId = normalizeMemoryEntity(userId)
  const row = db.prepare(`SELECT * FROM user_profiles WHERE user_id = ?`).get(normalizedId)
  if (!row) return null
  const parse = (raw, fallback = []) => {
    try {
      const parsed = JSON.parse(raw || '')
      return Array.isArray(parsed) ? parsed : fallback
    } catch {
      return fallback
    }
  }
  return {
    user_id: row.user_id,
    summary: row.summary || '',
    roles: parse(row.roles_json),
    domains: parse(row.domains_json),
    expertise: parse(row.expertise_json),
    projects: parse(row.projects_json),
    preferences: parse(row.preferences_json),
    communication_style: parse(row.communication_style_json),
    evidence: parse(row.evidence_json),
    confidence: Number(row.confidence || 0),
    updated_at: row.updated_at,
  }
}

export function upsertUserProfile(profile = {}) {
  const db = getDB()
  if (!profile.user_id) throw new Error('upsertUserProfile requires user_id')
  const payload = {
    user_id: normalizeMemoryEntity(profile.user_id),
    summary: profile.summary || '',
    roles_json: safeJsonString(profile.roles),
    domains_json: safeJsonString(profile.domains),
    expertise_json: safeJsonString(profile.expertise),
    projects_json: safeJsonString(profile.projects),
    preferences_json: safeJsonString(profile.preferences),
    communication_style_json: safeJsonString(profile.communication_style),
    evidence_json: safeJsonString(profile.evidence),
    confidence: Math.max(0, Math.min(1, Number(profile.confidence || 0))),
    updated_at: profile.updated_at || new Date().toISOString(),
  }
  db.prepare(`
    INSERT INTO user_profiles (
      user_id, summary, roles_json, domains_json, expertise_json, projects_json,
      preferences_json, communication_style_json, evidence_json, confidence, updated_at
    )
    VALUES (
      @user_id, @summary, @roles_json, @domains_json, @expertise_json, @projects_json,
      @preferences_json, @communication_style_json, @evidence_json, @confidence, @updated_at
    )
    ON CONFLICT(user_id) DO UPDATE SET
      summary = excluded.summary,
      roles_json = excluded.roles_json,
      domains_json = excluded.domains_json,
      expertise_json = excluded.expertise_json,
      projects_json = excluded.projects_json,
      preferences_json = excluded.preferences_json,
      communication_style_json = excluded.communication_style_json,
      evidence_json = excluded.evidence_json,
      confidence = excluded.confidence,
      updated_at = excluded.updated_at
  `).run(payload)
  return getUserProfile(payload.user_id)
}

const RECENT_RAW_CONTEXT_FLOOR = 60
const CONVERSATION_COLUMNS = `
  id, role, from_id, to_id, content, channel, timestamp, created_at,
  external_party_id, focus_absorbed, focus_topic, open_question, thread_id, delivery_status
`

function normalizeConversationLimit(limit, fallback = 20) {
  const n = Number(limit)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

export function getRecentConversation(entityId, limit = 20, maxHours = 24, { includeAbsorbed = false } = {}) {
  const db = getDB()
  const normalizedId = normalizeConversationPartyId(entityId)
  const cutoff = new Date(Date.now() - maxHours * 3600 * 1000).toISOString()
  const safeLimit = normalizeConversationLimit(limit)
  if (includeAbsorbed) {
    const rows = db.prepare(`
      SELECT ${CONVERSATION_COLUMNS} FROM conversations
      WHERE (from_id = ? OR to_id = ?)
      AND timestamp >= ?
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    `).all(normalizedId, normalizedId, cutoff, safeLimit)
    return rows.reverse()
  }

  // 线索模型（DynamicMemoryPool.md 8.3 原语 4）：absorbed 棘轮退役。
  // 写端（markConversationsAbsorbed）已无人调用；读端也不再按 focus_absorbed 过滤——
  // 历史上被时间区间误标记的行不该永久隐藏（误丢的代价是失忆，不可恢复）。
  // "主线深化时不看子线索原文"由读时选择（thread_id + buildThreadView）天然完成。
  const rows = db.prepare(`
    SELECT ${CONVERSATION_COLUMNS} FROM conversations
    WHERE (from_id = ? OR to_id = ?)
    AND timestamp >= ?
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
  `).all(normalizedId, normalizedId, cutoff, safeLimit)
  return rows.reverse() // 按时间正序返回
}

// 获取全局近期对话时间线（用于 TICK/heartbeat 场景，无明确发送者时仍可注入最近聊天上下文）
// includeAbsorbed 语义同 getRecentConversation。
export function getRecentConversationTimeline(limit = 20, maxHours = 24, { includeAbsorbed = false } = {}) {
  const db = getDB()
  const cutoff = new Date(Date.now() - maxHours * 3600 * 1000).toISOString()
  const safeLimit = normalizeConversationLimit(limit)
  if (includeAbsorbed) {
    const rows = db.prepare(`
      SELECT ${CONVERSATION_COLUMNS} FROM conversations
      WHERE timestamp >= ?
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    `).all(cutoff, safeLimit)
    return rows.reverse()
  }

  // absorbed 棘轮退役（同 getRecentConversation 的说明）：不再按 focus_absorbed 过滤。
  const rows = db.prepare(`
    SELECT ${CONVERSATION_COLUMNS} FROM conversations
    WHERE timestamp >= ?
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
  `).all(cutoff, safeLimit)
  return rows.reverse()
}

// 把 [startedAt, endedAt) 区间内未被吸收的对话标记为 focus_absorbed=1。
// 动态上下文记忆池 3.5：仅在 focus-compress.js 真正成功写出 conclusion 后才调用——
// 如果 LLM 调用失败、conclusion 为空就不标记，否则对话被错误地永久隐藏。
// 返回受影响行数；任何错误一律吞掉返回 0（fire-and-forget 路径不能因为标记失败崩到主对话）。
export function markConversationsAbsorbed(startedAt, endedAt = null) {
  if (!startedAt) return 0
  const db = getDB()
  const end = endedAt || new Date().toISOString()
  // 时区注意：frame.startedAt 来自 new Date().toISOString() 是 UTC（"...Z"），
  // 而 conversations.timestamp 来自 nowTimestamp() 是本地带偏移（"...+08:00"）。
  // 直接字符串字典序比较会失败（"T17" vs "T09"），所以用 strftime('%s', ...) 转
  // unixepoch 比较——SQLite 能识别 'Z' 和 '+HH:MM' 两种时区格式。
  try {
    const result = db.prepare(`
      UPDATE conversations
      SET focus_absorbed = 1
      WHERE strftime('%s', timestamp) >= strftime('%s', ?)
      AND   strftime('%s', timestamp) <  strftime('%s', ?)
      AND focus_absorbed = 0
    `).run(startedAt, end)
    return result.changes
  } catch {
    return 0
  }
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
// 默认排除后台 housekeeping 人格（recognizer / consolidator）：它们不算主 Agent 的"自我历史"。
// 一旦混进 self-snapshot 的"工具习惯（近 10 次调用）"、tool-router 的 ActionLog 保活，
// 主 Agent 会(1)误以为自己最近在做识别/整理，把无关问题误读成"用户在问识别器"，
// (2)被把 skip_recognition / skip_consolidation 这类后台专属工具重新注入工具表，
//    于是在普通对话回完话后顺手补一个 skip_consolidation 当收尾（多余的"跳过整理"步骤）。
// 极少数审计/诊断场景需要看全部时，传 { includeHousekeeping: true }。
export function getRecentActionLogs(limit = 50, { includeHousekeeping = false, includeRecognizer = false } = {}) {
  const db = getDB()
  if (includeHousekeeping || includeRecognizer) {
    return db.prepare(`
      SELECT * FROM action_logs ORDER BY id DESC LIMIT ?
    `).all(limit).reverse()
  }
  return db.prepare(`
    SELECT * FROM action_logs
    WHERE source IS NULL OR source NOT IN ('recognizer', 'consolidator', 'reviewer')
    ORDER BY id DESC LIMIT ?
  `).all(limit).reverse()
}

// 找到同 user + 同 due_at（精确到分钟）且非周期的待触发提醒，用于合并
// 周期提醒触发后：保持 pending，推进 due_at 到下次发生时间
// 按关键词搜索记忆（FTS5 全文搜索，优先相关度排序）
// 注意：trigram tokenizer 需要查询至少 3 字符；< 3 字符（典型如 2 字中文 ngram）走 LIKE fallback。
// 软隐藏过滤：FTS5 索引保留全量内容，但 JOIN memories 后用 m.visibility=1 过滤；
// LIKE fallback 直接 WHERE 加 visibility=1。两条路径都不会返回隐藏行。
export function searchMemories(keyword, limit = 10) {
  const db = getDB()
  const kw = String(keyword || '')
  const likeFallback = () => db.prepare(`
    SELECT * FROM memories
    WHERE (
      title LIKE ? OR mem_id LIKE ? OR content LIKE ? OR detail LIKE ?
      OR entities LIKE ? OR concepts LIKE ? OR tags LIKE ?
    )
    AND ${VISIBLE_CLAUSE}
    ORDER BY COALESCE(salience, 3) DESC, timestamp DESC
    LIMIT ?
  `).all(`%${kw}%`, `%${kw}%`, `%${kw}%`, `%${kw}%`, `%${kw}%`, `%${kw}%`, `%${kw}%`, limit)

  // trigram tokenizer 对 < 3 字符的查询无法匹配，直接走 LIKE
  if (kw.length < 3) return likeFallback()

  try {
    // 带出 bm25 相关度分（_ftsScore，越小越相关）。供注入器"少即是强"选择器做
    // 相关度地板过滤用；LIKE 兜底路径无此分（_ftsScore 为 undefined，选择器自动豁免）。
    const hits = db.prepare(`
      SELECT m.*, bm25(memories_fts) AS _ftsScore FROM memories m
      JOIN memories_fts ON memories_fts.rowid = m.id
      WHERE memories_fts MATCH ? AND m.${VISIBLE_CLAUSE}
      ORDER BY bm25(memories_fts), m.timestamp DESC
      LIMIT ?
    `).all(kw, limit)
    if (hits.length > 0) return hits
    // FTS5 命中 0 时再 LIKE 兜底（数据未索引、特殊字符、tokenizer 边界等）
    return likeFallback()
  } catch {
    // FTS 语法错误时降级为 LIKE
    return likeFallback()
  }
}

// ── 向量语义召回（与 FTS5 字面召回并行的兜底路径）─────────────────────────
//
// 写入：识别器把命中的记忆通过 updateMemoryEmbedding 落 BLOB。
// 召回：注入器把 focusText 算 embedding，调 searchByEmbedding 拿 top-N。
//
// 数量级 < 50k 之前先用 JS 内存全表扫描，避免引入 sqlite-vec 扩展。

export function updateMemoryEmbedding(memId, embeddingBuffer, model = null) {
  if (!memId) return
  const db = getDB()
  // null 也允许写入（清除某条的 embedding）；同时清掉维度/来源
  const value = embeddingBuffer == null ? null : embeddingBuffer
  // 维度从 BLOB 字节长度反推（Float32 = 4 字节），与召回端的维度过滤对齐
  const dim = value && value.byteLength > 0 ? Math.floor(value.byteLength / 4) : null
  const modelTag = value && typeof model === 'string' && model ? model : null
  try {
    db.prepare(`UPDATE memories SET embedding = ?, embedding_dim = ?, embedding_model = ? WHERE mem_id = ?`)
      .run(value, dim, modelTag, memId)
  } catch {
    // 老库 embedding_dim/embedding_model 列还没迁移时，退回只写 embedding，保证不影响主流程
    try {
      db.prepare(`UPDATE memories SET embedding = ? WHERE mem_id = ?`).run(value, memId)
    } catch {
      // 静默忽略（schema 未迁移、磁盘只读、并发冲突等）— 不让 embedding 写入影响主流程
    }
  }
}

// cosine 相似度：两个 Buffer（都是 Float32Array 序列化字节）。
// 长度不一致或为空时返回 -1，让排序自然把它沉底。
function cosineSimilarity(aBuf, bBuf) {
  if (!aBuf || !bBuf) return -1
  if (aBuf.byteLength !== bBuf.byteLength) return -1
  if (aBuf.byteLength === 0 || aBuf.byteLength % 4 !== 0) return -1
  const a = new Float32Array(aBuf.buffer, aBuf.byteOffset, aBuf.byteLength / 4)
  const b = new Float32Array(bBuf.buffer, bBuf.byteOffset, bBuf.byteLength / 4)
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i]
    dot += x * y
    na  += x * x
    nb  += y * y
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom > 0 ? dot / denom : -1
}

// 全表扫描所有有 embedding 的 memories，返回 cosine 相似度 top-N。
// 输入 queryBuffer：Buffer，包裹 Float32Array。
// 返回：每条形如 {...memoryRow, _vecScore: number}。
//
// Wave 1 优化：scaling 防御 —— 行数超过 VEC_FULL_SCAN_LIMIT 时直接返回 []，
// 让上层走 FTS5 兜底。理由：纯 JS cosine 在 N×1024 维度下 N>5k 后单次
// 召回会到几百毫秒，把主路径同步阻塞拖到秒级。当前 DB 实测 0 行 embedding，
// 这条是预防 embedding-backfill 跑起来后突然变慢的"未来 bug"。
// 真要支持大表向量召回应接 sqlite-vec 扩展或外部 ANN，此处先保命。
const VEC_FULL_SCAN_LIMIT = 5000

export function searchByEmbedding(queryBuffer, limit = 20) {
  if (!queryBuffer || !(queryBuffer instanceof Buffer) || queryBuffer.byteLength === 0) return []
  const db = getDB()

  // 只比与 query 同维度的向量：切换嵌入模型后旧维度向量（如云端 1536/2048）既不参与
  // 召回、也不挤占 VEC_FULL_SCAN_LIMIT 名额。embedding_dim IS NULL 是迁移前写入的历史行，
  // 一并纳入候选，由 cosineSimilarity 的 byteLength 守卫兜底剔除真正不同维度的。
  const queryDim = Math.floor(queryBuffer.byteLength / 4)
  const DIM_CLAUSE = `(embedding_dim = ${queryDim} OR embedding_dim IS NULL)`

  // 上限保护：先 COUNT，超限直接返回。better-sqlite3 + WAL + 索引扫描，几 ms 就回。
  try {
    const countRow = db.prepare(`SELECT COUNT(*) AS c FROM memories WHERE embedding IS NOT NULL AND ${DIM_CLAUSE} AND ${VISIBLE_CLAUSE}`).get()
    if (countRow && countRow.c > VEC_FULL_SCAN_LIMIT) {
      // 静默跳过，不打 warn——这条会被 inject 链路每条消息都走一次，
      // 噪声日志反而干扰调试。需要时把这里改成节流日志。
      return []
    }
  } catch {
    // 老库 schema 未迁移：COUNT 失败 → 走原路径让 SELECT 自己决定 fallback
  }

  let rows
  try {
    // 软隐藏过滤：被隐藏的记忆即使有 embedding 也不参与召回
    rows = db.prepare(`SELECT * FROM memories WHERE embedding IS NOT NULL AND ${DIM_CLAUSE} AND ${VISIBLE_CLAUSE}`).all()
  } catch {
    // 老库 embedding_dim 列未迁移：退回不带维度过滤的原查询（cosine 守卫仍会剔除异维度）
    try {
      rows = db.prepare(`SELECT * FROM memories WHERE embedding IS NOT NULL AND ${VISIBLE_CLAUSE}`).all()
    } catch {
      return []
    }
  }
  if (!rows.length) return []

  const scored = []
  for (const row of rows) {
    const score = cosineSimilarity(queryBuffer, row.embedding)
    if (score <= -1) continue
    // 别把 BLOB 一路传到调用方（大、没用、JSON 序列化会出乱码）
    const { embedding: _drop, ...rest } = row
    scored.push({ ...rest, _vecScore: score })
  }
  scored.sort((a, b) => b._vecScore - a._vecScore)
  return scored.slice(0, Math.max(0, limit))
}
