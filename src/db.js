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
  try { db.exec(`ALTER TABLE memories ADD COLUMN salience INTEGER DEFAULT 3`) } catch {}
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_mem_id ON memories(mem_id) WHERE mem_id IS NOT NULL`) } catch {}
  // 迁移：visibility 软隐藏三件套（动态上下文记忆池：剔除=软隐藏，不硬删除）
  //   visibility  : 1=可见、0=软隐藏。所有读路径默认 WHERE visibility = 1。
  //   hidden_at   : 软隐藏时间戳（ISO 8601），便于回溯与第3步专注帧恢复路径。
  //   merged_into : 因 merge_memories 被隐藏时，记录 keep 的 mem_id，形成可追踪链路。
  // FTS5 索引不动：所有 SELECT 已 JOIN memories 过滤 visibility=1，无需 trigger 改动。
  // 已存在行 visibility 默认取 1（向后兼容，无需 backfill）。
  try { db.exec(`ALTER TABLE memories ADD COLUMN visibility INTEGER NOT NULL DEFAULT 1`) } catch {}
  try { db.exec(`ALTER TABLE memories ADD COLUMN hidden_at TEXT`) } catch {}
  try { db.exec(`ALTER TABLE memories ADD COLUMN merged_into TEXT`) } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_visibility ON memories(visibility)`) } catch {}
  // 迁移：conversations 加 channel 列
  try { db.exec(`ALTER TABLE conversations ADD COLUMN channel TEXT DEFAULT ''`) } catch {}
  // 迁移：conversations 加 external_party_id 列（保留外部渠道原始 ID，供回送投递）
  try { db.exec(`ALTER TABLE conversations ADD COLUMN external_party_id TEXT DEFAULT ''`) } catch {}

  // 迁移：FTS5 tokenizer 从默认 unicode61 升级到 trigram。
  // 默认 tokenizer 把中文整段当成一个 token（"咖啡偏好"被存为一个整体），
  // 搜 "咖啡" 完全不命中。trigram 把字符串切成 3 字符滑动窗口，对中文子串可搜。
  // 注意：trigram 要求查询至少 3 字符；2 字符查询走 LIKE fallback（见 searchMemories）。
  //
  // 数据安全性：只 DROP virtual 索引表 memories_fts 和 3 个 trigger；
  // memories 真数据表完全不动。下文 schema 重建 memories_fts + trigger，
  // 末尾 line ~280 的 rebuild 命令把 memories 全表重新索引化。
  // 整段 try-catch；失败时回到老行为（FTS5 中文召回不工作但程序不崩）。
  try {
    const ftsRow = db.prepare(`SELECT sql FROM sqlite_master WHERE name='memories_fts'`).get()
    const ftsSql = String(ftsRow?.sql || '')
    const needsFtsRebuild = ftsRow && (
      !/trigram/i.test(ftsSql)
      || !/\btitle\b/i.test(ftsSql)
      || !/\bmem_id\b/i.test(ftsSql)
    )
    if (needsFtsRebuild) {
      const memCountBefore = (() => { try { return db.prepare('SELECT COUNT(*) AS c FROM memories').get().c } catch { return -1 } })()
      console.log(`[DB migration] Upgrading memories_fts: trigram + title/mem_id searchable columns. memories rows=${memCountBefore}. memories table itself is NOT touched.`)
      db.exec(`
        DROP TRIGGER IF EXISTS memories_ai;
        DROP TRIGGER IF EXISTS memories_au;
        DROP TRIGGER IF EXISTS memories_ad;
        DROP TABLE IF EXISTS memories_fts;
      `)
      // memories 行数应该保持不变（DROP 只动 fts 虚拟表）
      const memCountAfter = (() => { try { return db.prepare('SELECT COUNT(*) AS c FROM memories').get().c } catch { return -1 } })()
      if (memCountBefore !== memCountAfter) {
        console.error(`[DB migration] WARN memories row count changed during drop: ${memCountBefore} → ${memCountAfter} (this should never happen, please report)`)
      } else {
        console.log(`[DB migration] DROP complete, memories rows preserved (${memCountAfter}). Schema will recreate memories_fts with trigram + rebuild index below.`)
      }
    }
  } catch (err) {
    console.warn('[DB migration] FTS5 tokenizer migration check failed:', err.message, '— program continues, FTS5 remains in previous state')
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      role        TEXT    NOT NULL,  -- 'user' | 'jarvis'
      from_id     TEXT    NOT NULL,  -- 发送者 ID
      to_id       TEXT,              -- 接收者 ID（jarvis 发出时有值）
      content     TEXT    NOT NULL,
      channel     TEXT    NOT NULL DEFAULT '',
      timestamp   TEXT    NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_conv_timestamp ON conversations(timestamp);
    CREATE INDEX IF NOT EXISTS idx_conv_from_id   ON conversations(from_id);
  `)
  try { db.exec(`ALTER TABLE conversations ADD COLUMN channel TEXT DEFAULT ''`) } catch {}
  try { db.exec(`ALTER TABLE conversations ADD COLUMN external_party_id TEXT DEFAULT ''`) } catch {}
  // 迁移：focus_absorbed 标记（动态上下文记忆池 3.5 「主线深化时剔除残留噪声」）。
  //   focus_absorbed=1 表示这条对话所属的专注帧已被压缩回填吸收（focus_conclusion 已写入仓库），
  //   下一轮主线注入对话窗口时默认 WHERE focus_absorbed=0 把它隐去。
  // 关键：absorbed != deleted。对话物理仍在 conversations 表，admin 端点 / 显式 includeAbsorbed=true
  //   仍可拿到；这跟 memories.visibility 是平行的「软隐藏」概念。
  // 已存在行默认 0（向后兼容，无需 backfill）。
  try { db.exec(`ALTER TABLE conversations ADD COLUMN focus_absorbed INTEGER NOT NULL DEFAULT 0`) } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_conv_focus_absorbed ON conversations(focus_absorbed)`) } catch {}

  // 迁移：P0-1 给每条对话打上"当时的焦点话题"标签。
  //   conversationWindow 注入 LLM 时，每条 user/jarvis 消息的 marker 里带上这个 topic，
  //   让模型在做代词消解时能看到话题边界（"那个/这个/现在"才不会跨段乱钩）。
  //   写入时机：insertConversation 自动读 db 内部 currentFocusTopic 变量；
  //   index.js 在 updateFocusFrame 之后 setCurrentFocusTopic(栈顶 topic)，
  //   并对本轮触发判定的 user 消息做一次 UPDATE 回填（push 时 focus 尚未算）。
  try { db.exec(`ALTER TABLE conversations ADD COLUMN focus_topic TEXT DEFAULT ''`) } catch {}

  // 迁移：P0-2 标记 agent 自己留下的"未答悬念"（follow-up question）。
  //   open_question=1 表示这条 jarvis 消息末尾留了一个非澄清型问号悬念。
  //   conversationWindow 渲染时：若该悬念在 N 轮内未被用户接茬 / 话题已切换，
  //   marker 末尾追加 "[expired follow-up — ignore]"，避免模糊代词被钩到这里。
  try { db.exec(`ALTER TABLE conversations ADD COLUMN open_question INTEGER NOT NULL DEFAULT 0`) } catch {}

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
      salience    INTEGER DEFAULT 3,
      source_ref  TEXT,
      timestamp   TEXT    NOT NULL,
      parent_id   INTEGER REFERENCES memories(id),
      embedding   BLOB,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_memories_timestamp  ON memories(timestamp);
    CREATE INDEX IF NOT EXISTS idx_memories_event_type ON memories(event_type);
    CREATE INDEX IF NOT EXISTS idx_memories_parent_id  ON memories(parent_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      title, mem_id, content, detail, entities, concepts, tags,
      content='memories', content_rowid='id',
      tokenize='trigram'
    );

    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, title, mem_id, content, detail, entities, concepts, tags)
      VALUES (new.id, new.title, new.mem_id, new.content, new.detail, new.entities, new.concepts, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, mem_id, content, detail, entities, concepts, tags)
      VALUES ('delete', old.id, old.title, old.mem_id, old.content, old.detail, old.entities, old.concepts, old.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, mem_id, content, detail, entities, concepts, tags)
      VALUES ('delete', old.id, old.title, old.mem_id, old.content, old.detail, old.entities, old.concepts, old.tags);
      INSERT INTO memories_fts(rowid, title, mem_id, content, detail, entities, concepts, tags)
      VALUES (new.id, new.title, new.mem_id, new.content, new.detail, new.entities, new.concepts, new.tags);
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

    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id                  TEXT PRIMARY KEY,
      summary                  TEXT NOT NULL DEFAULT '',
      roles_json               TEXT NOT NULL DEFAULT '[]',
      domains_json             TEXT NOT NULL DEFAULT '[]',
      expertise_json           TEXT NOT NULL DEFAULT '[]',
      projects_json            TEXT NOT NULL DEFAULT '[]',
      preferences_json         TEXT NOT NULL DEFAULT '[]',
      communication_style_json TEXT NOT NULL DEFAULT '[]',
      evidence_json            TEXT NOT NULL DEFAULT '[]',
      confidence               REAL NOT NULL DEFAULT 0,
      updated_at               TEXT NOT NULL
    );
  `)

  // 迁移：memories 表添加 embedding BLOB 列（向量语义召回用，与 FTS5 双路融合）。
  // 用 PRAGMA table_info 检查，保证幂等：已有 embedding 列时彻底 no-op。
  try {
    const cols = db.prepare(`PRAGMA table_info(memories)`).all()
    const hasEmbedding = cols.some(c => c.name === 'embedding')
    if (!hasEmbedding) {
      db.exec(`ALTER TABLE memories ADD COLUMN embedding BLOB`)
    }
  } catch {}

  // 迁移（兜底）：visibility / hidden_at / merged_into 三件套。
  // 上文 line ~51 已经尝试过这三个 ALTER，但顺序在 CREATE TABLE memories 之前——
  // 全新安装时 memories 表不存在，ALTER 会失败被吞掉，导致新建的 memories 表缺这三列，
  // 后续 insertMemory 里 `WHERE visibility = 1` 立刻崩。这里在 CREATE TABLE 之后再补一次，
  // 用 PRAGMA table_info 做幂等检查（与上面 embedding 同模式），不会重复加列。
  try {
    const cols = db.prepare(`PRAGMA table_info(memories)`).all()
    const have = new Set(cols.map(c => c.name))
    if (!have.has('visibility'))   db.exec(`ALTER TABLE memories ADD COLUMN visibility INTEGER NOT NULL DEFAULT 1`)
    if (!have.has('hidden_at'))    db.exec(`ALTER TABLE memories ADD COLUMN hidden_at TEXT`)
    if (!have.has('merged_into'))  db.exec(`ALTER TABLE memories ADD COLUMN merged_into TEXT`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_visibility ON memories(visibility)`)
  } catch (err) {
    // 这一步真的失败的话后续 SELECT visibility 会全崩——日志告警让用户知道
    console.error('[DB migration] critical: visibility column migration failed:', err.message)
  }

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

  // known_agents 表：记录启动时发现的本地 AI Agent
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
  // 老库迁移：补上文档字段
  try { db.exec(`ALTER TABLE known_agents ADD COLUMN docs_url TEXT`) } catch {}
  try { db.exec(`ALTER TABLE known_agents ADD COLUMN docs_search_query TEXT`) } catch {}

  // user_identities 表：渠道外部 ID → canonical 用户 ID 的绑定（多用户阶段使用，单用户阶段保留为空）
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_identities (
      canonical_id TEXT NOT NULL,
      channel      TEXT NOT NULL,
      external_id  TEXT NOT NULL,
      alias        TEXT DEFAULT '',
      bound_at     TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (channel, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_identity_canonical ON user_identities(canonical_id);
  `)

  // 一次性历史数据迁移：把外部前缀 ID 统一为 PRIMARY_USER_ID，原值搬到 external_party_id
  try {
    const flag = db.prepare(`SELECT value FROM config WHERE key = ?`).get('migration_canonical_user_v1')
    if (!flag) {
      const externalRows = db.prepare(`
        SELECT COUNT(*) AS c FROM conversations
        WHERE from_id LIKE 'wechat:%' OR from_id LIKE 'discord:%'
           OR from_id LIKE 'feishu:%' OR from_id LIKE 'wecom:%'
           OR to_id   LIKE 'wechat:%' OR to_id   LIKE 'discord:%'
           OR to_id   LIKE 'feishu:%' OR to_id   LIKE 'wecom:%'
      `).get()
      if (externalRows.c > 0) {
        console.log(`[DB migration] Canonicalizing ${externalRows.c} conversation row(s) with external-channel IDs → ID:000001`)
        db.exec(`
          UPDATE conversations
            SET external_party_id = CASE WHEN external_party_id = '' OR external_party_id IS NULL THEN from_id ELSE external_party_id END,
                from_id = 'ID:000001'
            WHERE from_id LIKE 'wechat:%' OR from_id LIKE 'discord:%'
               OR from_id LIKE 'feishu:%' OR from_id LIKE 'wecom:%';
          UPDATE conversations
            SET external_party_id = CASE WHEN external_party_id = '' OR external_party_id IS NULL THEN to_id ELSE external_party_id END,
                to_id = 'ID:000001'
            WHERE to_id LIKE 'wechat:%' OR to_id LIKE 'discord:%'
               OR to_id LIKE 'feishu:%' OR to_id LIKE 'wecom:%';
        `)
      }
      db.prepare(`INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))`)
        .run('migration_canonical_user_v1', new Date().toISOString())
    }
  } catch (err) {
    console.warn('[DB migration] canonical user migration failed:', err.message)
  }

  // focus_stack 表：动态上下文记忆池第 5c 步——持久化注意力焦点栈，让重启不丢栈。
  //   depth         : 栈深，主键。0=栈底，length-1=栈顶。
  //   topic         : JSON array of strings（主题关键词）。
  //   started_at    : 帧创建时间（ISO timestamp）。
  //   started_at_tick / last_seen_tick : 创建/最后命中的 tickCounter。
  //   hit_count     : 累计命中次数。
  //   conclusions   : JSON array，存放从被 pop 子帧回填的结论字符串。
  //   updated_at    : 行写入时间。
  // 写入策略：每次 saveFocusStack 都先 DELETE 全表再批量 INSERT，整栈原子替换。
  db.exec(`
    CREATE TABLE IF NOT EXISTS focus_stack (
      depth         INTEGER PRIMARY KEY,
      topic         TEXT    NOT NULL,
      started_at    TEXT    NOT NULL,
      started_at_tick INTEGER NOT NULL,
      last_seen_tick INTEGER NOT NULL,
      hit_count     INTEGER NOT NULL DEFAULT 1,
      conclusions   TEXT    NOT NULL DEFAULT '[]',
      updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `)

  // wechat-clawbot 上下文令牌持久化：
  //   wechat-ilink-client 库内部用一个内存 Map<from_user_id, context_token> 缓存每个用户的会话令牌，
  //   每次入站消息刷新一次，重启即丢——重启后想"主动"给该用户发消息会抛 No context_token。
  //   把这层映射持久化下来，启动时回填到 client.contextTokens，能让"老朋友"在重启后立即可达。
  //   服务端令牌仍可能过期，这只是个尽力而为的缓存，所以 executor 兜底文案保留。
  db.exec(`
    CREATE TABLE IF NOT EXISTS wechat_clawbot_tokens (
      from_user_id  TEXT    PRIMARY KEY,
      context_token TEXT    NOT NULL,
      updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `)

  // recall_audit / extract_audit：记忆系统观测层（Phase 0 of Memory-Optimization v0.1）
  //   recall_audit  : injector 每次召回写一行——给"召回到底命中了什么/漏了什么"留证据
  //   extract_audit : recognizer 每次抽取写一行——给"哪些 turn 没抽到记忆"留证据
  // 写入采用 best-effort（try/catch + console.warn），任何写失败都不能影响主流程
  db.exec(`
    CREATE TABLE IF NOT EXISTS recall_audit (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      turn_label      TEXT,
      from_id         TEXT,
      channel         TEXT,
      query_text      TEXT,
      matched_mem_ids TEXT    NOT NULL DEFAULT '[]',
      matched_count   INTEGER NOT NULL DEFAULT 0,
      chosen_count    INTEGER NOT NULL DEFAULT 0,
      event_type_dist TEXT    NOT NULL DEFAULT '{}',
      latency_ms      INTEGER,
      source          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_recall_audit_created_at ON recall_audit(created_at);
    CREATE INDEX IF NOT EXISTS idx_recall_audit_from_id    ON recall_audit(from_id);
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS extract_audit (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
      turn_label        TEXT,
      from_id           TEXT,
      channel           TEXT,
      turn_summary      TEXT,
      extracted_mem_ids TEXT    NOT NULL DEFAULT '[]',
      extracted_count   INTEGER NOT NULL DEFAULT 0,
      event_type_dist   TEXT    NOT NULL DEFAULT '{}',
      latency_ms        INTEGER,
      skipped           INTEGER NOT NULL DEFAULT 0,
      skip_reason       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_extract_audit_created_at ON extract_audit(created_at);
    CREATE INDEX IF NOT EXISTS idx_extract_audit_from_id    ON extract_audit(from_id);
  `)

  // 重建 FTS 索引（覆盖已有数据，确保历史记忆也被索引）
  db.exec(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`)
}

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

// 写入一条对话记录
// focus_topic / open_question 优先取调用方显式传入；未传时 focus_topic 读 currentFocusTopic。
export function insertConversation({
  role, from_id, to_id = null, content, timestamp,
  channel = '', external_party_id = '',
  focus_topic = null, open_question = 0,
}) {
  const db = getDB()
  const fromId = normalizeConversationPartyId(from_id)
  const toId = normalizeConversationPartyId(to_id)
  const topic = focus_topic == null ? currentFocusTopic : String(focus_topic || '')
  const info = db.prepare(`
    INSERT INTO conversations (role, from_id, to_id, content, timestamp, channel, external_party_id, focus_topic, open_question)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(role, fromId, toId, content, timestamp, channel || '', external_party_id || '', topic, open_question ? 1 : 0)
  return Number(info.lastInsertRowid) || 0
}

// P0-1：给本轮触发判定的 user 消息回填 focus_topic
//   pushMessage 时焦点栈还没算（要等收到消息才更新），用户消息写库时 focus_topic = ''。
//   index.js 在 updateFocusFrame 之后调用本函数，用 (from_id, timestamp) 定位该行回填。
//   注意：不加 focus_topic 必须为空的 WHERE 约束——只通过 from_id+timestamp 精确定位单行；
//   即使外部预填了别的值，本轮焦点判断的结果才是权威的。
export function updateUserMessageFocusTopic(fromId, timestamp, topic) {
  if (!fromId || !timestamp) return 0
  const db = getDB()
  const normalizedId = normalizeConversationPartyId(fromId)
  const t = Array.isArray(topic) ? topic.slice(0, 3).join(',') : String(topic || '')
  const info = db.prepare(`
    UPDATE conversations SET focus_topic = ?
    WHERE role = 'user' AND from_id = ? AND timestamp = ?
  `).run(t, normalizedId, timestamp)
  return info.changes || 0
}

// P0-2：把某条 jarvis 消息标记为留了未答悬念（open_question=1）
//   executor.js send_message 写完库立刻拿回 row id，按需 mark。
export function markConversationOpenQuestion(id, isOpen = true) {
  if (!id) return 0
  const db = getDB()
  const info = db.prepare(`UPDATE conversations SET open_question = ? WHERE id = ?`).run(isOpen ? 1 : 0, id)
  return info.changes || 0
}

// 查最近 withinMs 毫秒内 jarvis 发给 toId 的消息中，是否有 content 完全相同的一条。
// 命中返回 { id, content, timestamp, ageMs }，未命中返回 null。
// 用途：send_message 防重发——零用户消息状态下，模型常被旧 directions 反复驱动发同一句话。
// 防重发判定：在最近的 jarvis 出站里找一条与 content 逐字相同、且"用户尚未回应过"的消息。
//
// 旧逻辑只用 5 分钟时间窗（withinMs）卡——实测 deepseek 等模型重发节奏（如 5min4s / 14min）
// 恰好踩在窗口外，逐字重发照样漏过（典型：启动期"委托授权询问"被连发 3 次）。对一条用户
// 还没回应的主动消息，逐字重发不管隔多久都是骚扰，时间长短不该是豁免条件。
// 新逻辑以"该条之后用户有没有回过话"为分界：
//   - 没回过 → 不论间隔多久都判为重发并拒绝；
//   - 回过了 → 话题已翻篇，放行（仍保留 withinMs 作兜底下限：刚回过也不许 5 分钟内逐字重发）。
export function findRecentJarvisDuplicate(toId, content, withinMs = 300_000) {
  if (!toId || !content) return null
  const db = getDB()
  const normalizedId = normalizeConversationPartyId(toId)
  const target = String(content).trim()
  if (!target) return null

  // 该对象最近一条真实用户消息的时间戳，作为"用户是否已回应"的分界线。
  // SYSTEM 信号的 from_id 是 'SYSTEM'，不等于对象 id，天然被排除，不会被误当成用户回应。
  const lastUserRow = db.prepare(`
    SELECT timestamp FROM conversations
    WHERE role = 'user' AND from_id = ?
    ORDER BY id DESC LIMIT 1
  `).get(normalizedId)
  const lastUserTs = lastUserRow ? Date.parse(lastUserRow.timestamp) : NaN

  // 拉最近 20 条 jarvis 出站做内存比对，比 LIKE 全表扫稳。
  const rows = db.prepare(`
    SELECT id, content, timestamp FROM conversations
    WHERE role = 'jarvis' AND to_id = ?
    ORDER BY id DESC
    LIMIT 20
  `).all(normalizedId)
  const now = Date.now()
  for (const r of rows) {
    if (String(r.content || '').trim() !== target) continue
    const ts = Date.parse(r.timestamp)
    const ageMs = Number.isFinite(ts) ? now - ts : Infinity
    // 用户在这条逐字相同的消息之后回过话 → 话题已翻篇；除非仍在 withinMs 兜底窗内，否则放行。
    const userRepliedSince = Number.isFinite(lastUserTs) && Number.isFinite(ts) && lastUserTs > ts
    if (userRepliedSince && ageMs > withinMs) continue
    return { id: r.id, content: r.content, timestamp: r.timestamp, ageMs }
  }
  return null
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
  external_party_id, focus_absorbed, focus_topic, open_question
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

  const rows = db.prepare(`
    WITH scoped AS (
      SELECT
        ${CONVERSATION_COLUMNS},
        ROW_NUMBER() OVER (ORDER BY timestamp DESC, id DESC) AS recent_rank
      FROM conversations
      WHERE (from_id = ? OR to_id = ?)
      AND timestamp >= ?
    )
    SELECT ${CONVERSATION_COLUMNS}
    FROM scoped
    WHERE recent_rank <= ? OR focus_absorbed = 0
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
  `).all(normalizedId, normalizedId, cutoff, RECENT_RAW_CONTEXT_FLOOR, safeLimit)
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

  const rows = db.prepare(`
    WITH scoped AS (
      SELECT
        ${CONVERSATION_COLUMNS},
        ROW_NUMBER() OVER (ORDER BY timestamp DESC, id DESC) AS recent_rank
      FROM conversations
      WHERE timestamp >= ?
    )
    SELECT ${CONVERSATION_COLUMNS}
    FROM scoped
    WHERE recent_rank <= ? OR focus_absorbed = 0
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
  `).all(cutoff, RECENT_RAW_CONTEXT_FLOOR, safeLimit)
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

export function updateMemoryEmbedding(memId, embeddingBuffer) {
  if (!memId) return
  const db = getDB()
  // null 也允许写入（清除某条的 embedding）
  const value = embeddingBuffer == null ? null : embeddingBuffer
  try {
    db.prepare(`UPDATE memories SET embedding = ? WHERE mem_id = ?`).run(value, memId)
  } catch {
    // 静默忽略（schema 未迁移、磁盘只读、并发冲突等）— 不让 embedding 写入影响主流程
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

  // 上限保护：先 COUNT，超限直接返回。better-sqlite3 + WAL + 索引扫描，几 ms 就回。
  try {
    const countRow = db.prepare(`SELECT COUNT(*) AS c FROM memories WHERE embedding IS NOT NULL AND ${VISIBLE_CLAUSE}`).get()
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
    rows = db.prepare(`SELECT * FROM memories WHERE embedding IS NOT NULL AND ${VISIBLE_CLAUSE}`).all()
  } catch {
    // 老库 schema 未迁移 / embedding 列不存在
    return []
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
  const tokens = String(query || '').trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) return []
  // 每个词都要命中 title/artist/album 之一（per-token OR，token 之间 AND）：
  // 这样 "歌名 歌手" 能匹配到 title 只含歌名、artist 只含歌手的行，避免漏命中后白跑下载。
  const clauses = tokens.map(() => '(title LIKE ? OR artist LIKE ? OR album LIKE ?)')
  const params = []
  for (const t of tokens) { const like = `%${t}%`; params.push(like, like, like) }
  return db.prepare(`
    SELECT * FROM music_library
    WHERE ${clauses.join(' AND ')}
    ORDER BY added_at DESC LIMIT ?
  `).all(...params, limit)
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

// ============================================================
// focus_stack —— 动态上下文记忆池 5c 步：注意力焦点栈持久化
// ============================================================
//
// loadFocusStack: 启动时一次性读出整栈（按 depth ASC）；任何异常都返回 []，
//   不阻塞主流程。frame 形状与内存中的 state.focusStack[i] 完全一致：
//   { topic, startedAt, startedAtTick, lastSeenTick, hitCount, conclusions }
//
// saveFocusStack: 整栈原子替换。先 DELETE 再 INSERT，全部包在 transaction 里。
//   focus.js 只在内存里改 state.focusStack，所以 index.js 在每次 updateFocusFrame
//   返回非 noop 时主动调；focus-compress.js 也通过 onConclusionAttached 回调触发。
//   写库失败 console.warn 后吞掉——专注栈丢一次远比阻塞主对话轻。
const FOCUS_STACK_RESTORE_TTL_MS = 24 * 60 * 60 * 1000

export function loadFocusStack() {
  const db = getDB()
  try {
    const rows = db.prepare(`SELECT * FROM focus_stack ORDER BY depth ASC`).all()
    if (rows.length > 0) {
      const newest = rows
        .map(r => Date.parse(r.updated_at || r.started_at || ''))
        .filter(Number.isFinite)
        .sort((a, b) => b - a)[0]
      if (Number.isFinite(newest) && Date.now() - newest > FOCUS_STACK_RESTORE_TTL_MS) {
        db.prepare(`DELETE FROM focus_stack`).run()
        console.log('[focus-persist] dropped stale persisted focus_stack on startup')
        return []
      }
    }
    return rows.map(r => ({
      topic: JSON.parse(r.topic || '[]'),
      startedAt: r.started_at,
      startedAtTick: r.started_at_tick,
      lastSeenTick: r.last_seen_tick,
      hitCount: r.hit_count,
      conclusions: JSON.parse(r.conclusions || '[]'),
    }))
  } catch {
    return []
  }
}

export function saveFocusStack(stack) {
  const db = getDB()
  try {
    const tx = db.transaction((frames) => {
      db.prepare(`DELETE FROM focus_stack`).run()
      const insert = db.prepare(`
        INSERT INTO focus_stack (depth, topic, started_at, started_at_tick, last_seen_tick, hit_count, conclusions)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i]
        insert.run(
          i,
          JSON.stringify(f.topic || []),
          f.startedAt || new Date().toISOString(),
          f.startedAtTick || 0,
          f.lastSeenTick || 0,
          f.hitCount || 1,
          JSON.stringify(f.conclusions || [])
        )
      }
    })
    tx(stack || [])
  } catch (err) {
    console.warn('[focus-persist] saveFocusStack failed:', err.message)
  }
}

// ───────── 记忆观测层（Memory-Optimization v0.1 Phase 0） ─────────
// 所有 audit 写入都是 best-effort：失败只记 warn，不抛出，不影响主流程。

export function insertRecallAudit({
  turn_label = null,
  from_id = null,
  channel = null,
  query_text = '',
  matched_mem_ids = [],
  chosen_count = 0,
  event_type_dist = {},
  latency_ms = null,
  source = null,
} = {}) {
  try {
    const ids = Array.isArray(matched_mem_ids) ? matched_mem_ids : []
    getDB().prepare(`
      INSERT INTO recall_audit (
        turn_label, from_id, channel, query_text,
        matched_mem_ids, matched_count, chosen_count,
        event_type_dist, latency_ms, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      turn_label,
      from_id,
      channel,
      (query_text || '').slice(0, 1000),
      JSON.stringify(ids),
      ids.length,
      chosen_count,
      JSON.stringify(event_type_dist || {}),
      latency_ms,
      source
    )
  } catch (err) {
    console.warn('[recall_audit] insert failed:', err.message)
  }
}

export function insertExtractAudit({
  turn_label = null,
  from_id = null,
  channel = null,
  turn_summary = '',
  extracted_mem_ids = [],
  event_type_dist = {},
  latency_ms = null,
  skipped = false,
  skip_reason = null,
} = {}) {
  try {
    const ids = Array.isArray(extracted_mem_ids) ? extracted_mem_ids : []
    getDB().prepare(`
      INSERT INTO extract_audit (
        turn_label, from_id, channel, turn_summary,
        extracted_mem_ids, extracted_count,
        event_type_dist, latency_ms, skipped, skip_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      turn_label,
      from_id,
      channel,
      (turn_summary || '').slice(0, 500),
      JSON.stringify(ids),
      ids.length,
      JSON.stringify(event_type_dist || {}),
      latency_ms,
      skipped ? 1 : 0,
      skip_reason
    )
  } catch (err) {
    console.warn('[extract_audit] insert failed:', err.message)
  }
}

export function getRecentRecallAudits(limit = 50) {
  try {
    return getDB().prepare(`SELECT * FROM recall_audit ORDER BY id DESC LIMIT ?`).all(limit)
  } catch (err) {
    console.warn('[recall_audit] read failed:', err.message)
    return []
  }
}

export function getRecentExtractAudits(limit = 50) {
  try {
    return getDB().prepare(`SELECT * FROM extract_audit ORDER BY id DESC LIMIT ?`).all(limit)
  } catch (err) {
    console.warn('[extract_audit] read failed:', err.message)
    return []
  }
}

export function getRecallAuditStats({ sinceIso = null } = {}) {
  try {
    const sinceClause = sinceIso ? 'WHERE created_at >= ?' : ''
    const args = sinceIso ? [sinceIso] : []
    return getDB().prepare(`
      SELECT
        COUNT(*) AS total,
        AVG(matched_count) AS avg_matched,
        AVG(chosen_count)  AS avg_chosen,
        AVG(latency_ms)    AS avg_latency_ms,
        MAX(latency_ms)    AS max_latency_ms,
        SUM(CASE WHEN matched_count = 0 THEN 1 ELSE 0 END) AS zero_match_count
      FROM recall_audit ${sinceClause}
    `).get(...args)
  } catch (err) {
    console.warn('[recall_audit] stats failed:', err.message)
    return null
  }
}

export function getExtractAuditStats({ sinceIso = null } = {}) {
  try {
    const sinceClause = sinceIso ? 'WHERE created_at >= ?' : ''
    const args = sinceIso ? [sinceIso] : []
    return getDB().prepare(`
      SELECT
        COUNT(*)            AS total,
        AVG(extracted_count) AS avg_extracted,
        AVG(latency_ms)      AS avg_latency_ms,
        SUM(skipped)         AS skipped_count
      FROM extract_audit ${sinceClause}
    `).get(...args)
  } catch (err) {
    console.warn('[extract_audit] stats failed:', err.message)
    return null
  }
}

