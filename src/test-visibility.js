// 动态上下文记忆池 · 第 2 步软隐藏机制自检
//
// 跑法：node src/test-visibility.js
// 前提：node 的 better-sqlite3 ABI 与本机匹配（用 electron 内置 node 跑则需要 electron）
//
// 本文件不动真实 DB——通过把 JARVIS_USER_DIR 环境变量指向临时目录来隔离，
// db.js 走 paths.dbFile = <USER_DIR>/data/jarvis.db，从而落到 temp。

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'

const tmp = mkdtempSync(join(tmpdir(), 'blm-visibility-'))
process.env.JARVIS_USER_DIR = tmp

const {
  getDB,
  insertMemory,
  hideMemoryByMemId,
  memoryExistsByMemId,
  getMemoryByMemId,
  searchMemories,
  getMemoriesByEntity,
  upsertEntity,
} = await import('./db.js')

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exitCode = 1
  } else {
    console.log(`PASS: ${msg}`)
  }
}

try {
  const db = getDB()  // 触发 schema 迁移（含 visibility 三件套）

  // schema check：visibility / hidden_at / merged_into 三列都在
  const cols = db.prepare(`PRAGMA table_info(memories)`).all().map(c => c.name)
  assert(cols.includes('visibility'), 'memories has visibility column')
  assert(cols.includes('hidden_at'), 'memories has hidden_at column')
  assert(cols.includes('merged_into'), 'memories has merged_into column')

  // 索引 check
  const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all().map(r => r.name)
  assert(idx.includes('idx_memories_visibility'), 'visibility index exists')

  // 准备 3 条记忆（普通 fact，不挂根 entity，避免 person/object root 路径）
  upsertEntity('test:visibility-probe', 'visibility test')

  const r1 = insertMemory({
    event_type: 'fact', content: '可见记忆一号 苹果在桌上',
    detail: 'apple1', mem_id: 'vis_test_1', entities: ['test:visibility-probe'],
    tags: [], timestamp: new Date().toISOString(),
  })
  const r2 = insertMemory({
    event_type: 'fact', content: '可见记忆二号 香蕉黄色的',
    detail: 'banana', mem_id: 'vis_test_2', entities: ['test:visibility-probe'],
    tags: [], timestamp: new Date().toISOString(),
  })
  const r3 = insertMemory({
    event_type: 'fact', content: '可见记忆三号 葡萄紫色的',
    detail: 'grape', mem_id: 'vis_test_3', entities: ['test:visibility-probe'],
    tags: [], timestamp: new Date().toISOString(),
  })
  assert(r1 && r2 && r3, 'inserted 3 memories')

  // 全部 visible 时：search 至少各能找到自己
  const hitAppleVisible = searchMemories('苹果在桌上', 10)
  assert(hitAppleVisible.some(r => r.mem_id === 'vis_test_1'), 'search finds vis_test_1 when visible')

  const entityHitsBefore = getMemoriesByEntity('test:visibility-probe', 50)
  const seenMemIds = new Set(entityHitsBefore.map(r => r.mem_id))
  assert(['vis_test_1', 'vis_test_2', 'vis_test_3'].every(m => seenMemIds.has(m)),
    'getMemoriesByEntity returns all 3 when visible')

  // 隐藏 vis_test_1
  const okHide = hideMemoryByMemId('vis_test_1', { mergedInto: 'vis_test_2' })
  assert(okHide, 'hideMemoryByMemId returns true')

  // 隐藏后：search 找不到 vis_test_1
  const hitAppleHidden = searchMemories('苹果在桌上', 10)
  assert(!hitAppleHidden.some(r => r.mem_id === 'vis_test_1'),
    'search does NOT find vis_test_1 after hide')

  // 隐藏后：getMemoriesByEntity 只返回剩余 2 条
  const entityHitsAfter = getMemoriesByEntity('test:visibility-probe', 50)
  const remaining = new Set(entityHitsAfter.map(r => r.mem_id))
  assert(!remaining.has('vis_test_1') && remaining.has('vis_test_2') && remaining.has('vis_test_3'),
    'getMemoriesByEntity skips hidden, returns the other 2')

  // 但 memoryExistsByMemId 故意不过滤隐藏，仍返回 true（防 UNIQUE 冲突）
  assert(memoryExistsByMemId('vis_test_1'), 'memoryExistsByMemId still true for hidden row')

  // getMemoryByMemId 也不过滤（merge 工具需要拿 drops 的当前状态）
  const hiddenRow = getMemoryByMemId('vis_test_1')
  assert(hiddenRow && hiddenRow.visibility === 0, 'getMemoryByMemId returns hidden row with visibility=0')
  assert(hiddenRow && hiddenRow.merged_into === 'vis_test_2', 'merged_into is recorded')
  assert(hiddenRow && hiddenRow.hidden_at, 'hidden_at timestamp is set')

  console.log('\n[test-visibility] done')
} finally {
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
}
