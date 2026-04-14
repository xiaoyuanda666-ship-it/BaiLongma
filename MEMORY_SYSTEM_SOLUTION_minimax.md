# Agent-Jarvis 记忆系统问题解决方案

> 针对架构问题的详细解决方案

**文档版本**：1.0  
**分析日期**：2026-04-14  
**分析师**：minimax

---

## 1. 问题回顾

上一份分析中识别了记忆系统的三个主要问题：

| 问题 | 严重程度 | 描述 |
|------|----------|------|
| 每次启动重建 FTS 索引 | 🔴 高 | 每次启动执行 `rebuild`，启动时间随记忆量增长 |
| 记忆去重逻辑过简单 | 🟡 中 | 仅用前 40 字匹配，可能丢失重要变体 |
| 记忆无过期机制 | 🔴 高 | 永久存储，长期运行后数据库膨胀 |

---

## 2. 解决方案

### 2.1 FTS 索引重建问题

#### 问题分析

当前代码 `src/db.js` 第 47 行：
```javascript
db.exec(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`)
```

**问题**：每次启动都执行 `rebuild`，当记忆量大时，这会成为启动瓶颈。

#### 方案设计

**方案 A：增量索引（推荐）**

FTS5 支持增量索引，不需要每次启动重建：

```javascript
// 修改 db.js - 移除启动时的 rebuild
// 用增量 populate 替代

function initSchema() {
  // ... 其他表创建 ...
  
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content, detail, entities, concepts, tags,
      content='memories', content_rowid='id'
    );
  `)

  // 检查是否需要初始化
  const indexEmpty = db.prepare(`
    SELECT COUNT(*) as cnt FROM memories_fts
  `).get()
  
  if (indexEmpty.cnt === 0) {
    // 首次启动时重建索引
    console.log('[DB] 首次启动，构建 FTS 索引...')
    db.exec(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`)
  }
}
```

**方案 B：异步后台索引**

如果需要支持增量构建，在非启动时执行：

```javascript
// 添加索引重建状态检查
function needsIndexRebuild() {
  const memCount = db.prepare('SELECT COUNT(*) as cnt FROM memories').get().cnt
  const ftsCount = db.prepare('SELECT COUNT(*) as cnt FROM memories_fts').get().cnt
  return memCount !== ftsCount
}

// 后台异步重建
function rebuildIndexAsync() {
  if (!needsIndexRebuild()) return
  
  setImmediate(() => {
    console.log('[DB] 后台重建 FTS 索引...')
    db.exec(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`)
    console.log('[DB] FTS 索引重建完成')
  })
}
```

#### 实施建议

| 方案 | 优点 | 缺点 | 适用场景 |
|------|------|------|----------|
| 方案 A | 简单直接 | 首次启动仍需等待 | 小规模记忆 |
| 方案 B | 不阻塞启动 | 需要异步逻辑 | 大规模记忆 |

**推荐实现**：先检查索引是否为空，为空时才执行重建。

---

### 2.2 记忆去重逻辑优化

#### 问题分析

当前代码 `src/db.js` 第 95-120 行：
```javascript
const contentPrefix = (memory.content || '').slice(0, 40)
const dup = db.prepare(`
  SELECT id FROM memories WHERE event_type = ? AND content LIKE ? LIMIT 1
`).get(memory.event_type, `${contentPrefix}%`)
```

**问题**：使用字面前 40 字符匹配，语义不同但开头相似的记忆会被错误去重。

#### 方案设计

**方案 A：多字段复合去重**

保留原有的字段级检查，同时添加语义检查：

```javascript
// 增强去重逻辑
function shouldSkipDuplicate(memory) {
  const db = getDB()
  
  // 1. 完全匹配检查（现有逻辑）
  if (memory.content === memory.detail) return true
  
  // 2. 同类型 + 相同 entities + 相同 concepts
  const sameType = db.prepare(`
    SELECT id FROM memories 
    WHERE event_type = ? 
    AND entities = ? 
    AND concepts = ?
    LIMIT 1
  `).get(
    memory.event_type,
    memory.entities,
    memory.concepts
  )
  if (sameType) return true
  
  // 3. 短内容直接跳过（已有逻辑）
  const contentPrefix = (memory.content || '').slice(0, 40)
  const dup = db.prepare(`
    SELECT id FROM memories WHERE event_type = ? AND content LIKE ? LIMIT 1
  `).get(memory.event_type, `${contentPrefix}%`)
  
  return !!dup
}
```

**方案 B：基于时间窗口的去重**

保留同时间段内的重复，但允许不同时间段的变体：

```javascript
// 时间窗口去重（1小时内同内容只保留一条）
function shouldSkipDuplicateWithTimeWindow(memory) {
  const db = getDB()
  const oneHourAgo = new Date(Date.now() - 3600000).toISOString()
  
  // 检查 1 小时内是否有相似内容
  const recent = db.prepare(`
    SELECT id, timestamp FROM memories 
    WHERE event_type = ? 
    AND content LIKE ?
    AND timestamp > ?
    LIMIT 1
  `).get(memory.event_type, `${memory.content.slice(0, 40)}%`, oneHourAgo)
  
  if (recent) {
    console.log(`[DB] 1小时内有相似记忆，跳过`)
    return true
  }
  return false
}
```

**方案 C：重要性级别去重（推荐）**

根据事件类型决定去重策略：

```javascript
// 按类型决定是否去重
const DUPLICATION_CHECK = {
  // 需要严格去重
  strict: ['person', 'object', 'knowledge'],
  // 时间窗口去重
  window: ['opinion_received', 'experience'],
  // 不去重（每次都要记录）
  none: ['event', 'concept', 'self_constraint', 'other_constraint'],
}

function shouldCheckDuplication(eventType) {
  if (DUPLICATION_CHECK.strict.includes(eventType)) {
    return 'strict'
  }
  if (DUPLICATION_CHECK.window.includes(eventType)) {
    return 'window'
  }
  return 'none'
}

function insertMemoryWithSmartDedup(memory) {
  const checkMode = shouldCheckDuplication(memory.event_type)
  
  if (checkMode === 'none') {
    return insertMemory(memory)  // 直接插入
  }
  
  if (checkMode === 'strict') {
    return insertMemoryWithStrictDedup(memory)
  }
  
  if (checkMode === 'window') {
    return insertMemoryWithTimeWindowDedup(memory)
  }
  
  return insertMemory(memory)
}
```

#### 实施建议

| 方案 | 复杂度 | 效果 | 推荐 |
|------|----------|------|------|
| 方案 A | 低 | 一般 | ⭐ |
| 方案 B | 中 | 较好 | ⭐⭐ |
| 方案 C | 中 | 好 | ⭐⭐⭐ |

**推荐实现**：方案 C，按事件类型决定去重策略。

---

### 2.3 记忆过期与归档机制

#### 问题分析

当前系统没有记忆过期机制，记忆永久存储。长期运行后：
- 记忆数量持续增长
- 搜索性能下降
- 存储成本增加

#### 方案设计

**方案 A：基于 TTL 的过期**

为不同类型的记忆设置不同的 TTL：

```javascript
// 添加 TTL 配置
const MEMORY_TTL = {
  // 永久存储
  permanent: ['person', 'object', 'self_constraint', 'other_constraint'],
  
  // 30 天过期
  short: ['opinion_received', 'event'],
  
  // 90 天过期
  medium: ['experience', 'concept'],
  
  // 180 天过期
  long: ['knowledge'],
}

// 获取 TTL（毫秒）
function getMemoryTTL(eventType) {
  if (MEMORY_TTL.permanent.includes(eventType)) {
    return Infinity
  }
  if (MEMORY_TTL.short.includes(eventType)) {
    return 30 * 24 * 60 * 60 * 1000
  }
  if (MEMORY_TTL.medium.includes(eventType)) {
    return 90 * 24 * 60 * 60 * 1000
  }
  if (MEMORY_TTL.long.includes(eventType)) {
    return 180 * 24 * 60 * 60 * 1000
  }
  return 90 * 24 * 60 * 60 * 1000  // 默认 90 天
}

// 过期清理任务（可在每次 TICK 时调用）
function cleanupExpiredMemories() {
  const db = getDB()
  let deleted = 0
  
  for (const [eventType, ttl] of Object.entries(MEMORY_TTL)) {
    if (ttl === Infinity) continue
    
    const cutoff = new Date(Date.now() - ttl).toISOString()
    const result = db.prepare(`
      DELETE FROM memories 
      WHERE event_type = ? AND timestamp < ?
    `).run(eventType, cutoff)
    
    deleted += result.changes
  }
  
  if (deleted > 0) {
    console.log(`[DB] 清理过期记忆 ${deleted} 条`)
  }
  
  return deleted
}
```

**方案 B：基于访问频率的过期**

长时间未访问的记忆可以被归档或删除：

```javascript
// 添加 last_accessed 字段
db.exec(`
  ALTER TABLE memories ADD COLUMN last_accessed TEXT
`)

// 更新访问时间（搜索时）
function searchMemories(keyword, limit = 10) {
  const results = // ... 现有搜索逻辑 ...
  
  // 更新访问时间
  const now = new Date().toISOString()
  for (const r of results) {
    db.prepare(`UPDATE memories SET last_accessed = ? WHERE id = ?`).run(now, r.id)
  }
  
  return results
}

// 归档长期未访问的记忆
function archiveInactiveMemories(days = 180) {
  const db = getDB()
  const cutoff = new Date(Date.now() - days * 24 * 3600000).toISOString()
  
  // 移动到归档表（创建归档表）
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories_archive AS SELECT * FROM memories WHERE 1=0
  `)
  
  // 移动长期未访问且非永久的记忆
  const permanentTypes = MEMORY_TTL.permanent.join("','")
  const result = db.prepare(`
    INSERT INTO memories_archive 
    SELECT * FROM memories 
    WHERE event_type NOT IN ('${permanentTypes}')
    AND (last_accessed IS NULL OR last_accessed < ?)
  `).run(cutoff)
  
  // 从主表删除
  db.prepare(`
    DELETE FROM memories 
    WHERE event_type NOT IN ('${permanentTypes}')
    AND (last_accessed IS NULL OR last_accessed < ?)
  `).run(cutoff)
  
  return result.changes
}
```

**方案 C：基于记忆重要性的动态过期（推荐）**

使用类似 LRU 的机制，保留最重要的记忆：

```javascript
// 重要性评分
function calculateMemoryScore(memory) {
  const MAX_MEMORIES = 10000  // 最大记忆数量
  
  let score = 0
  
  // 永久类型加分
  if (MEMORY_TTL.permanent.includes(memory.event_type)) {
    score += 100
  }
  
  // 新记忆加分
  const age = Date.now() - new Date(memory.timestamp).getTime()
  score += Math.max(0, 30 - age / (24 * 3600000))  // 越新分数越高
  
  // 有 detail 的记忆加分
  if (memory.detail && memory.detail.length > 20) {
    score += 10
  }
  
  return score
}

// 自动清理低分记忆（当超过 MAX_MEMORIES 时）
function cleanupLowScoreMemories() {
  const db = getDB()
  const count = db.prepare('SELECT COUNT(*) as cnt FROM memories').get().cnt
  
  if (count < MAX_MEMORIES) return 0
  
  // 获取所有记忆及其分数
  const all = db.prepare('SELECT * FROM memories ORDER BY timestamp DESC').all()
  
  // 保留永久类型的记忆
  const permanentIds = new Set()
  for (const m of all) {
    if (MEMORY_TTL.permanent.includes(m.event_type)) {
      permanentIds.add(m.id)
    }
  }
  
  // 删除最低分的非永久记忆，直到降到 MAX_MEMORIES 以下
  let toDelete = count - MAX_MEMORIES
  const deletable = all
    .filter(m => !permanentIds.has(m.id))
    .sort((a, b) => calculateMemoryScore(a) - calculateMemoryScore(b))
    .slice(0, toDelete)
  
  for (const m of deletable) {
    db.prepare('DELETE FROM memories WHERE id = ?').run(m.id)
  }
  
  console.log(`[DB] 清理低分记忆 ${deletable.length} 条`)
  return deletable.length
}
```

#### 实施建议

| 方案 | 复杂度 | 效果 | 推荐 |
|------|----------|------|------|
| 基于 TTL | 低 | 一般 | ⭐⭐ |
| 访问频率 | 中 | 较好 | ⭐⭐⭐ |
| 重要性评分 | 中 | 好 | ⭐⭐⭐⭐ |

**推荐实现**：方案 C + 方案 A 结合
- 永久类型使用 TTL = Infinity
- 其他类根重要性评分自动清理

---

## 3. 完整实施方案

### 3.1 修改文件清单

| 文件 | 修改内容 |
|------|----------|
| `src/db.js` | 添加索引检查、改进去重逻辑、添加过期清理 |
| `src/index.js` | 定期调用过期清理 |

### 3.2 核心代码修改

```javascript
// src/db.js 新增内容

// TTL 配置
const MEMORY_TTL = {
  permanent: ['person', 'object', 'self_constraint', 'other_constraint'],
  short: ['opinion_received', 'event'],        // 30 天
  medium: ['experience', 'concept'],           // 90 天
  long: ['knowledge'],                         // 180 天
}

// 智能去重
function shouldSkipDuplicate(memory, db) {
  // 1. 不同类型不需要检查
  if (!DUPLICATION_CHECK[memory.event_type]) return false
  
  const mode = DUPLICATION_CHECK[memory.event_type]
  
  if (mode === 'none') return false
  
  if (mode === 'strict') {
    // 严格匹配：同类型 + 相同 entities + 相同 concepts
    const existing = db.prepare(`
      SELECT id FROM memories 
      WHERE event_type = ? AND entities = ? AND concepts = ?
    `).get(memory.event_type, memory.entities, memory.concepts)
    return !!existing
  }
  
  if (mode === 'window') {
    // 时间窗口：1小时内不重复
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString()
    const existing = db.prepare(`
      SELECT id FROM memories 
      WHERE event_type = ? AND content LIKE ? AND timestamp > ?
    `).get(
      memory.event_type, 
      `${memory.content.slice(0, 40)}%`,
      oneHourAgo
    )
    return !!existing
  }
  
  return false
}

// 过期清理
function cleanupExpiredMemories() {
  const db = getDB()
  let deleted = 0
  
  for (const [eventType, days] of Object.entries(TTL_DAYS)) {
    if (days === Infinity) continue
    
    const cutoff = new Date(Date.now() - days * 24 * 3600000).toISOString()
    const result = db.prepare(`
      DELETE FROM memories 
      WHERE event_type = ? AND timestamp < ?
    `).run(eventType, cutoff)
    
    deleted += result.changes
  }
  
  return deleted
}
```

### 3.3 调度修改

```javascript
// src/index.js - 在 onTick 中添加清理调度

let cleanupCounter = 0

async function onTick() {
  // ... 现有逻辑 ...
  
  // 每 100 次 TICK 执行一次清理（约 30 分钟）
  cleanupCounter++
  if (cleanupCounter >= 100) {
    cleanupCounter = 0
    const deleted = cleanupExpiredMemories()
    if (deleted > 0) {
      console.log(`[系统] 清理过期记忆 ${deleted} 条`)
    }
  }
}
```

---

## 4. 实施计划

### 4.1 第一阶段：快速修复

| 任务 | 工作量 | 影响 |
|------|----------|------|
| 修复 FTS 索引检查 | 0.5h | 启动速度 |
| 添加智能去重 | 1h | 记忆质量 |
| 总计 | 1.5h | |

### 4.2 第二阶段：完善功能

| 任务 | 工作量 | 影响 |
|------|----------|------|
| 实现 TTL 过期 | 1h | 长期稳定性 |
| 添加过期清理调度 | 0.5h | 长期稳定性 |
| 总计 | 1.5h | |

### 4.3 第三阶段：优化（可选）

| 任务 | 工作量 | 影响 |
|------|----------|------|
| 重要性评分清理 | 2h | 记忆质量 |
| 访问频率追踪 | 1h | 搜索性能 |
| 总计 | 3h | |

---

## 5. 总结

针对记忆系统问题，提供以下解决方案：

1. **FTS 索引**：添加检查，空索引时才重建
2. **去重逻辑**：按事件类型采用不同策略
   - 永久类型（person/object）：严格去重
   - 经验类型：时间窗口去重
   - 其他类型：不去重
3. **过期机制**：按类型设置 TTL + 自动清理

通过这三个改进，可以显著提升系统的长期稳定性和记忆质量。