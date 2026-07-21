import { getDB, getConfig, setConfig } from '../db.js'
import { detectAgents } from './detector.js'

const CONFIG_KEY_ASKED = 'agent_delegation_asked'
const CONFIG_KEY_ALLOWED = 'agent_delegation_allowed'

// 确保 known_agents 表存在（db.js initSchema 调用前的兜底，也可直接在 db.js 里加）
function ensureTable() {
  const db = getDB()
  db.exec(`
    CREATE TABLE IF NOT EXISTS known_agents (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      description       TEXT NOT NULL DEFAULT '',
      available         INTEGER NOT NULL DEFAULT 0,
      version           TEXT,
      invoke_type       TEXT,
      invoke_cmd        TEXT,
      invoke_args       TEXT NOT NULL DEFAULT '[]',
      notes             TEXT NOT NULL DEFAULT '',
      docs_url          TEXT,
      docs_search_query TEXT,
      detected_at       TEXT NOT NULL,
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
}

// 保存一批 Agent 探测结果到数据库
function saveAgents(agents) {
  const db = getDB()
  const stmt = db.prepare(`
    INSERT INTO known_agents (id, name, description, available, version, invoke_type, invoke_cmd, invoke_args, notes, docs_url, docs_search_query, detected_at, updated_at)
    VALUES (@id, @name, @description, @available, @version, @invoke_type, @invoke_cmd, @invoke_args, @notes, @docs_url, @docs_search_query, @detected_at, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name              = excluded.name,
      description       = excluded.description,
      available         = excluded.available,
      version           = excluded.version,
      invoke_type       = excluded.invoke_type,
      invoke_cmd        = excluded.invoke_cmd,
      invoke_args       = excluded.invoke_args,
      notes             = excluded.notes,
      docs_url          = excluded.docs_url,
      docs_search_query = excluded.docs_search_query,
      detected_at       = excluded.detected_at,
      updated_at        = datetime('now')
  `)
  const insertAll = db.transaction((list) => {
    for (const a of list) stmt.run({
      id:                a.id,
      name:              a.name,
      description:       a.description,
      available:         a.available ? 1 : 0,
      version:           a.version || null,
      invoke_type:       a.invokeType || null,
      invoke_cmd:        a.invokeCmd || null,
      invoke_args:       JSON.stringify(a.invokeArgs || []),
      notes:             a.notes || '',
      docs_url:          a.docsUrl || null,
      docs_search_query: a.docsSearchQuery || null,
      detected_at:       a.detectedAt || new Date().toISOString(),
    })
  })
  insertAll(agents)
}

// 读取所有可用 Agent
export function getAvailableAgents() {
  ensureTable()
  const db = getDB()
  return db.prepare(`
    SELECT * FROM known_agents WHERE available = 1 ORDER BY id ASC
  `).all().map(row => ({
    ...row,
    invokeArgs: JSON.parse(row.invoke_args || '[]'),
    available: !!row.available,
  }))
}

// 读取所有 Agent（含不可用）
export function getAllAgents() {
  ensureTable()
  const db = getDB()
  return db.prepare(`SELECT * FROM known_agents ORDER BY available DESC, id ASC`).all().map(row => ({
    ...row,
    invokeArgs: JSON.parse(row.invoke_args || '[]'),
    available: !!row.available,
  }))
}

// 按 id 获取单个 Agent
export function getAgentById(id) {
  ensureTable()
  const db = getDB()
  const row = db.prepare(`SELECT * FROM known_agents WHERE id = ?`).get(id)
  if (!row) return null
  return { ...row, invokeArgs: JSON.parse(row.invoke_args || '[]'), available: !!row.available }
}

// ── 委托权限管理 ─────────────────────────────────────────────────────────────

export function hasDelegationBeenAsked() {
  return getConfig(CONFIG_KEY_ASKED) === 'true'
}

export function isDelegationAllowed() {
  return getConfig(CONFIG_KEY_ALLOWED) === 'true'
}

export function markDelegationAsked() {
  setConfig(CONFIG_KEY_ASKED, 'true')
}

export function grantDelegation() {
  setConfig(CONFIG_KEY_ALLOWED, 'true')
}

export function revokeDelegation() {
  setConfig(CONFIG_KEY_ALLOWED, 'false')
}

// ── 启动入口：探测 + 落盘 ──────────────────────────────────────────────────

export async function collectAgents() {
  ensureTable()
  console.log('[Agents] 开始扫描本地 AI Agent...')
  try {
    const results = await detectAgents()
    saveAgents(results)
    const found = results.filter(a => a.available)
    console.log(`[Agents] 扫描完成：发现 ${found.length}/${results.length} 个可用 Agent`)
    return results
  } catch (err) {
    console.error('[Agents] 扫描失败：', err.message)
    return []
  }
}

// ── 生成用于系统提示词注入的文本块 ────────────────────────────────────────

export function buildAgentContextBlock() {
  if (!isDelegationAllowed()) return ''
  const agents = getAvailableAgents()
  if (!agents.length) return ''

  const lines = agents.map(a => {
    const invoke = a.invoke_type === 'cli'
      ? `exec_command("${a.invoke_cmd} ...")`
      : `web_read({ url: "${a.invoke_cmd}/..." })`
    return `- **${a.name}** (${a.id}): ${a.description}. Invoke: ${invoke}`
  })

  return `## AI Collaborators You Can Work With
You have been granted command authority. For complex tasks, you may invoke the following agents through the delegate_to_agent tool:
${lines.join('\n')}
Before invoking, tell the user what you intend to have whom do, and proceed only after confirmation.`
}

// ── 生成一次性的本地 Agent 发现上下文 ─────────────────────────────────────
//
// 这里只把环境事实交给主模型，不替它决定是否、何时向用户提起，也不强制发消息。
// 持久化键沿用历史上的 "asked" 命名，但现在表达的是"该发现已递给模型一次"。
export function buildDelegationDiscoveryContext() {
  if (hasDelegationBeenAsked()) return null
  const available = getAvailableAgents()
  if (!available.length) {
    // 无 agent 时也立即 mark，避免每个 Tick 重复扫描同一事实。
    markDelegationAsked()
    return null
  }

  // 注入后立即落盘，避免模型在后续 Tick 反复收到同一发现。
  markDelegationAsked()

  const names = available.map(a => a.name).join('、')
  return `[One-time environment discovery] The following local AI collaborators are available: ${names}. This is context, not a request to contact the user. Decide whether this capability matters to the current situation. Delegating work still requires persisted user authorization through grant_agent_delegation; discovery alone grants no authority.`
}

// Backward-compatible export for older callers. Semantics are now neutral discovery,
// not a forced "ask the user" direction.
export function buildDelegationAskDirections() {
  return buildDelegationDiscoveryContext()
}
