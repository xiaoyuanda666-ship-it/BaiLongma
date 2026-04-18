import Database from 'better-sqlite3'

const db = new Database('D:/claude/jarvis/data/jarvis.db')

const USER_ID = 'ID:000001'
const AGENT_ID = 'agent:jarvis'
const USER_ROOT_MEM_ID = 'person_000001'
const AGENT_ROOT_MEM_ID = 'agent_jarvis_identity'

const userRootAliases = new Set([
  'contact_000001',
  'person_000001',
  'person_id000001_interaction',
  'person_yuanda_identity',
  'user_000001',
  'user_000001_identity',
  'user_000001_profile',
])

function parseJsonArray(value) {
  if (Array.isArray(value)) return value
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function uniq(values) {
  return [...new Set((values || []).filter(Boolean).map(v => String(v).trim()).filter(Boolean))]
}

function normalizePartyId(id) {
  if (!id) return id
  const text = String(id).trim()
  if (/^ID:\d+$/i.test(text)) return `ID:${text.replace(/^ID:/i, '')}`
  if (/^\d+$/.test(text)) return `ID:${text}`
  return text
}

function ensureRoot(memId, eventType, title, content, entity, tags) {
  const existing = db.prepare(`
    SELECT id, entities, tags, title, content
    FROM memories
    WHERE mem_id = ?
    LIMIT 1
  `).get(memId)

  if (existing) {
    db.prepare(`
      UPDATE memories
      SET event_type = ?, title = ?, content = ?, detail = ?, entities = ?, tags = ?, timestamp = ?
      WHERE id = ?
    `).run(
      eventType,
      existing.title || title,
      existing.content || content,
      existing.content || content,
      JSON.stringify(uniq([...parseJsonArray(existing.entities), entity])),
      JSON.stringify(uniq([...parseJsonArray(existing.tags), ...tags])),
      new Date().toISOString(),
      existing.id
    )
    return Number(existing.id)
  }

  const result = db.prepare(`
    INSERT INTO memories (event_type, content, detail, title, mem_id, entities, concepts, tags, links, source_ref, timestamp, parent_id)
    VALUES (?, ?, ?, ?, ?, ?, '[]', ?, '[]', 'identity_migration', ?, NULL)
  `).run(
    eventType,
    content,
    content,
    title,
    memId,
    JSON.stringify([entity]),
    JSON.stringify(tags),
    new Date().toISOString()
  )

  return Number(result.lastInsertRowid)
}

function inferUser(memory) {
  const text = [memory.mem_id, memory.title, memory.content, memory.detail].filter(Boolean).join(' ')
  const memId = String(memory.mem_id || '').toLowerCase()
  const title = String(memory.title || '')
  return (
    /(?:^|[^a-z0-9])(000001|yuanda)(?:[^a-z0-9]|$)|ID:\s*000001/i.test(text) ||
    /^user_|^person_/.test(memId) ||
    /用户/.test(title)
  )
}

function inferAgent(memory) {
  const text = [memory.mem_id, memory.title, memory.content, memory.detail].filter(Boolean).join(' ')
  const memId = String(memory.mem_id || '').toLowerCase()
  return /Jarvis|Agent_Jarvis|JARVIS/i.test(text) || /jarvis|^agent_/.test(memId)
}

function chooseParent(memory, hasUser, hasAgent) {
  if (memory.mem_id === USER_ROOT_MEM_ID || memory.mem_id === AGENT_ROOT_MEM_ID) return null

  const text = [memory.mem_id, memory.title, memory.content].filter(Boolean).join(' ')

  if (hasUser && !hasAgent) return USER_ROOT_MEM_ID
  if (hasAgent && !hasUser) return AGENT_ROOT_MEM_ID
  if (hasUser && hasAgent) {
    if (/用户|ID:\s*000001|\b000001\b|\bYuanda\b/i.test(text)) return USER_ROOT_MEM_ID
    return AGENT_ROOT_MEM_ID
  }
  return null
}

function mergeLinks(rawLinks, additions) {
  const merged = [...parseJsonArray(rawLinks)]
  const seen = new Set(merged.map(link => `${link.target_id}:${link.relation}`))
  for (const link of additions) {
    const key = `${link.target_id}:${link.relation}`
    if (!seen.has(key)) {
      seen.add(key)
      merged.push(link)
    }
  }
  return merged
}

function updateMemory(memory, userRootId, agentRootId) {
  const hasUser = inferUser(memory)
  const hasAgent = inferAgent(memory)

  if (!hasUser && !hasAgent) return false

  const entities = uniq([
    ...parseJsonArray(memory.entities),
    ...(hasUser ? [USER_ID] : []),
    ...(hasAgent ? [AGENT_ID] : []),
  ])

  const parentMemId = chooseParent(memory, hasUser, hasAgent)
  let parentId = memory.parent_id
  const linkAdds = []

  if (parentMemId === USER_ROOT_MEM_ID && memory.id !== userRootId) {
    parentId = userRootId
    linkAdds.push({ target_id: USER_ROOT_MEM_ID, relation: 'child_of' })
    if (hasAgent) linkAdds.push({ target_id: AGENT_ROOT_MEM_ID, relation: 'related_to' })
  } else if (parentMemId === AGENT_ROOT_MEM_ID && memory.id !== agentRootId) {
    parentId = agentRootId
    linkAdds.push({ target_id: AGENT_ROOT_MEM_ID, relation: 'child_of' })
    if (hasUser) linkAdds.push({ target_id: USER_ROOT_MEM_ID, relation: 'related_to' })
  } else {
    if (hasUser && memory.mem_id !== USER_ROOT_MEM_ID) linkAdds.push({ target_id: USER_ROOT_MEM_ID, relation: 'related_to' })
    if (hasAgent && memory.mem_id !== AGENT_ROOT_MEM_ID) linkAdds.push({ target_id: AGENT_ROOT_MEM_ID, relation: 'related_to' })
  }

  const links = mergeLinks(memory.links, linkAdds).map(link => ({
    ...link,
    target_id: userRootAliases.has(link.target_id) ? USER_ROOT_MEM_ID : link.target_id,
  }))
  const dedupedLinks = []
  const seenLinks = new Set()
  for (const link of links) {
    const key = `${link.target_id}:${link.relation}`
    if (!seenLinks.has(key)) {
      seenLinks.add(key)
      dedupedLinks.push(link)
    }
  }

  db.prepare(`
    UPDATE memories
    SET entities = ?, parent_id = ?, links = ?, timestamp = ?
    WHERE id = ?
  `).run(
    JSON.stringify(entities),
    parentId || null,
    JSON.stringify(dedupedLinks),
    memory.timestamp,
    memory.id
  )

  return true
}

function main() {
  const now = new Date().toISOString()

  db.prepare(`UPDATE conversations SET from_id = ? WHERE from_id = '000001'`).run(USER_ID)
  db.prepare(`UPDATE conversations SET to_id = ? WHERE to_id = '000001'`).run(USER_ID)

  db.prepare(`UPDATE entities SET id = ? WHERE id = '000001'`).run(USER_ID)

  const userRootId = ensureRoot(
    USER_ROOT_MEM_ID,
    'person',
    '用户 ID:000001 身份标识',
    '用户唯一身份为 ID:000001，别名 Yuanda。',
    USER_ID,
    ['identity', 'user', 'alias:Yuanda']
  )

  const agentRootId = ensureRoot(
    AGENT_ROOT_MEM_ID,
    'object',
    'Agent Jarvis 身份标识',
    'Agent Jarvis 是当前运行中的本地 AI 助手实例。',
    AGENT_ID,
    ['identity', 'agent', 'jarvis']
  )

  const rows = db.prepare(`
    SELECT id, mem_id, event_type, title, content, detail, entities, tags, parent_id, links, timestamp
    FROM memories
    ORDER BY id ASC
  `).all()

  let updated = 0
  for (const row of rows) {
    if (updateMemory(row, userRootId, agentRootId)) updated++
  }

  const normalizeUserRootLinks = db.prepare(`
    UPDATE memories
    SET links = REPLACE(links, ?, ?)
    WHERE links LIKE ?
  `)

  for (const alias of userRootAliases) {
    if (alias === USER_ROOT_MEM_ID) continue
    normalizeUserRootLinks.run(alias, USER_ROOT_MEM_ID, `%${alias}%`)
  }

  db.prepare(`
    UPDATE memories
    SET entities = ?, tags = ?, timestamp = ?
    WHERE id = ?
  `).run(JSON.stringify([USER_ID]), JSON.stringify(['identity', 'user', 'alias:Yuanda']), now, userRootId)

  db.prepare(`
    UPDATE memories
    SET entities = ?, tags = ?, timestamp = ?
    WHERE id = ?
  `).run(JSON.stringify([AGENT_ID]), JSON.stringify(['identity', 'agent', 'jarvis']), now, agentRootId)

  console.log(JSON.stringify({
    ok: true,
    updated_memories: updated,
    user_root_id: userRootId,
    agent_root_id: agentRootId,
  }, null, 2))
}

main()
