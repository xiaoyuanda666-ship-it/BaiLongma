export function initializeSchema(db) {
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
  // Persist the actual delivery outcome. Conversation rows are written before
  // external dispatch so they can be rendered immediately; therefore their
  // existence alone is not proof that the recipient received the message.
  try { db.exec(`ALTER TABLE conversations ADD COLUMN delivery_status TEXT NOT NULL DEFAULT ''`) } catch {}

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
      delivery_status TEXT NOT NULL DEFAULT '',
      timestamp   TEXT    NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_conv_timestamp ON conversations(timestamp);
    CREATE INDEX IF NOT EXISTS idx_conv_from_id   ON conversations(from_id);
  `)
  try { db.exec(`ALTER TABLE conversations ADD COLUMN channel TEXT DEFAULT ''`) } catch {}
  try { db.exec(`ALTER TABLE conversations ADD COLUMN external_party_id TEXT DEFAULT ''`) } catch {}
  try { db.exec(`ALTER TABLE conversations ADD COLUMN delivery_status TEXT NOT NULL DEFAULT ''`) } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_conv_delivery_status ON conversations(delivery_status)`) } catch {}
  // A local TUI row is created and broadcast as one synchronous operation, so
  // historical local assistant rows are safe to backfill as delivered. Do not
  // infer this for external channels: older rows were also retained on failed
  // external dispatches and therefore are not authoritative receipts.
  try {
    db.exec(`
      UPDATE conversations
      SET delivery_status = 'delivered'
      WHERE role = 'jarvis'
        AND channel = 'TUI'
        AND delivery_status = ''
    `)
  } catch {}
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

  // 迁移：线索模型（DynamicMemoryPool.md 第 8 章）——写时归属。
  //   每条对话在写入时由行动者声明归属到哪条线索（thread_id）。这是"episode 是因果链
  //   不是时间段"的落地：减法（读时选择）按 thread_id 算，不再按时间区间圈地。
  //   focus_topic 列保留（话题边界标注仍有用），thread_id 是归属、focus_topic 是标注。
  try { db.exec(`ALTER TABLE conversations ADD COLUMN thread_id TEXT DEFAULT ''`) } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_conv_thread_id ON conversations(thread_id)`) } catch {}

  // 迁移：P0-2 标记 agent 自己留下的"未答悬念"（follow-up question）。
  //   open_question=1 表示这条 jarvis 消息末尾留了一个非澄清型问号悬念。
  //   conversationWindow 渲染时：若该悬念在 N 轮内未被用户接茬 / 话题已切换，
  //   在 conversation_metadata 中标记 expired_open_question，避免模糊代词被钩到这里。
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
    const have = new Set(cols.map(c => c.name))
    if (!have.has('embedding')) db.exec(`ALTER TABLE memories ADD COLUMN embedding BLOB`)
    // embedding_dim：向量维度（=BLOB 字节数/4）。切换嵌入模型后维度会变（如云端 1536/2048 →
    // 本地 bge-large 1024），召回时只比同维度向量，避免旧维度向量静默失效或拖累。
    // embedding_model：来源模型名，便于排查 / 决定哪些行需要 force 重算。
    if (!have.has('embedding_dim'))   db.exec(`ALTER TABLE memories ADD COLUMN embedding_dim INTEGER`)
    if (!have.has('embedding_model')) db.exec(`ALTER TABLE memories ADD COLUMN embedding_model TEXT`)
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

  // Brain UI 观测历史：只保存经过裁剪/脱敏的 L2 展示事件，让动态端口或应用重启后
  // 仍能恢复心跳、最近思考与工具轨迹。事件表有界，累计心跳数单独保存在 state 表。
  db.exec(`
    CREATE TABLE IF NOT EXISTS brain_ui_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp    TEXT    NOT NULL,
      path         TEXT    NOT NULL DEFAULT 'l2',
      event_type   TEXT    NOT NULL,
      payload_json TEXT    NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_brain_ui_events_path_id ON brain_ui_events(path, id);

    CREATE TABLE IF NOT EXISTS brain_ui_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)

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

  // L3 scheduled-task executions are persisted separately from reminder
  // definitions. A reminder occurrence is materialized here before it enters
  // the in-memory queue, so a process crash cannot lose an already-fired job.
  db.exec(`
    CREATE TABLE IF NOT EXISTS reminder_runs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      reminder_id  INTEGER NOT NULL REFERENCES reminders(id),
      user_id      TEXT    NOT NULL,
      task         TEXT    NOT NULL,
      due_at       TEXT    NOT NULL,
      status       TEXT    NOT NULL DEFAULT 'pending',
      attempts     INTEGER NOT NULL DEFAULT 0,
      available_at TEXT    NOT NULL,
      claimed_at   TEXT,
      finished_at  TEXT,
      last_error   TEXT    NOT NULL DEFAULT '',
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(reminder_id, due_at)
    );
    CREATE INDEX IF NOT EXISTS idx_reminder_runs_runnable
      ON reminder_runs(status, available_at, id);
  `)

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

  // threads / commitments 表：线索模型（DynamicMemoryPool.md 第 8 章）持久化。
  //   threads     : 线索全集。status='open'|'closed'；closed 仍在仓库可召回——线索数据只增不删，
  //                 "遗忘"只发生在读时（threadTemperature 不选它），不发生在写时。
  //   commitments : 承诺注册表。"好的我去做"= 单 Agent 版 spawn 时刻；开放承诺钉住线索温度，
  //                 是指代性问询（"干得咋样"）的解析锚点。
  //   thread_state: 单行 KV，存 foregroundId（前台指针）。
  // 写入策略：saveThreadState 整态原子替换（transaction 内 DELETE+INSERT），与 focus_stack 同款。
  // focus_stack 表只读保留：首启 threads 为空时一次性迁移，之后不再写。
  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      id              TEXT PRIMARY KEY,
      topic           TEXT NOT NULL DEFAULT '[]',
      signature       TEXT NOT NULL DEFAULT '[]',
      label           TEXT NOT NULL DEFAULT '',
      summary         TEXT NOT NULL DEFAULT '',
      conclusions     TEXT NOT NULL DEFAULT '[]',
      status          TEXT NOT NULL DEFAULT 'open',
      created_at      TEXT NOT NULL,
      last_event_at   TEXT NOT NULL,
      last_event_tick INTEGER NOT NULL DEFAULT 0,
      hit_count       INTEGER NOT NULL DEFAULT 1,
      last_summary_at TEXT NOT NULL DEFAULT '',
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS commitments (
      id          TEXT PRIMARY KEY,
      thread_id   TEXT NOT NULL,
      text        TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'open',
      channel     TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL,
      closed_at   TEXT
    );
    CREATE TABLE IF NOT EXISTS thread_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_commitments_status ON commitments(status);
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

