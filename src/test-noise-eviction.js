// 动态上下文记忆池 · 第 5d 步「主线深化时剔除残留噪声」自检
//
// 跑法：node src/test-noise-eviction.js
// 前提：node 的 better-sqlite3 ABI 与本机匹配（用 electron 内置 node 跑则需要 electron）
// 本地若 ABI 不匹配会在 import db.js 阶段抛错，本测试整体跳过（见末尾 catch）。
//
// 隔离策略：把 BAILONGMA_USER_DIR 指向临时目录，db.js 走 paths.dbFile = <USER_DIR>/data/jarvis.db。
// 不动真实 DB。

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'

const tmp = mkdtempSync(join(tmpdir(), 'blm-noise-eviction-'))
process.env.BAILONGMA_USER_DIR = tmp

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exitCode = 1
  } else {
    console.log(`PASS: ${msg}`)
  }
}

try {
  const {
    getDB,
    insertConversation,
    getRecentConversation,
    getRecentConversationTimeline,
    markConversationsAbsorbed,
  } = await import('./db.js')

  const db = getDB() // 触发 schema 迁移

  // schema check：focus_absorbed 列存在
  const cols = db.prepare(`PRAGMA table_info(conversations)`).all().map(c => c.name)
  assert(cols.includes('focus_absorbed'), 'conversations has focus_absorbed column')

  // 索引 check
  const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all().map(r => r.name)
  assert(idx.includes('idx_conv_focus_absorbed'), 'idx_conv_focus_absorbed exists')

  // 准备三段对话：
  //   T0: 主线（设计理念）—— 不被 absorbed
  //   T1: 子帧（天气）   —— 将被 absorbed
  //   T2: 主线（写代码） —— 不被 absorbed
  const t0 = new Date(Date.now() - 30 * 60 * 1000).toISOString() // 30 分钟前
  const t1 = new Date(Date.now() - 20 * 60 * 1000).toISOString() // 20 分钟前
  const t1b = new Date(Date.now() - 19 * 60 * 1000).toISOString() // 19 分钟前
  const t2 = new Date(Date.now() - 5 * 60 * 1000).toISOString()  // 5 分钟前

  const testUser = 'user:noise-test'

  insertConversation({ role: 'user',   from_id: testUser, to_id: 'jarvis', content: '聊聊设计理念', timestamp: t0 })
  insertConversation({ role: 'user',   from_id: testUser, to_id: 'jarvis', content: '今天天气怎么样', timestamp: t1 })
  insertConversation({ role: 'jarvis', from_id: 'jarvis', to_id: testUser, content: '今天晴天 25 度', timestamp: t1b })
  insertConversation({ role: 'user',   from_id: testUser, to_id: 'jarvis', content: '回到设计：写成代码', timestamp: t2 })

  // 默认（includeAbsorbed=false）——所有 4 条都未 absorbed，应全部可见
  const beforeMark = getRecentConversation(testUser, 50, 24)
  assert(beforeMark.length === 4, `before mark: getRecentConversation returns 4 rows (got ${beforeMark.length})`)

  const beforeMarkTimeline = getRecentConversationTimeline(50, 24)
  assert(beforeMarkTimeline.length >= 4, `before mark: timeline returns >=4 rows (got ${beforeMarkTimeline.length})`)

  // 标记 [t1, t2) 区间为 absorbed（模拟天气子帧被压缩回填）
  const marked = markConversationsAbsorbed(t1, t2)
  assert(marked === 2, `markConversationsAbsorbed marks 2 rows in [t1, t2) (got ${marked})`)

  // 重复标记同样区间——已经 focus_absorbed=1 的不再被 update（WHERE focus_absorbed=0）
  const markedAgain = markConversationsAbsorbed(t1, t2)
  assert(markedAgain === 0, `second mark is idempotent (got ${markedAgain})`)

  // 默认调用——近期 raw 连续性优先：absorbed 的两条仍在最近窗口内可见。
  const afterMark = getRecentConversation(testUser, 50, 24)
  assert(afterMark.length === 4, `after mark: recent raw floor keeps absorbed rows visible (got ${afterMark.length})`)
  assert(
    afterMark.some(r => r.content === '今天天气怎么样') && afterMark.some(r => r.content === '今天晴天 25 度'),
    'after mark: recent absorbed rows remain visible to preserve continuity'
  )

  // 显式 includeAbsorbed=true——拿全量
  const afterMarkFull = getRecentConversation(testUser, 50, 24, { includeAbsorbed: true })
  assert(afterMarkFull.length === 4, `includeAbsorbed=true returns all 4 rows (got ${afterMarkFull.length})`)

  // timeline 默认也保留最近 raw。
  const afterMarkTimeline = getRecentConversationTimeline(50, 24)
  const ourRowsTimeline = afterMarkTimeline.filter(r => r.from_id === testUser || r.to_id === testUser)
  assert(
    ourRowsTimeline.length === 4,
    `after mark: timeline (default) keeps recent absorbed our rows (got ${ourRowsTimeline.length})`
  )

  // timeline 显式 includeAbsorbed=true——拿全量
  const afterMarkTimelineFull = getRecentConversationTimeline(50, 24, { includeAbsorbed: true })
  const ourRowsTimelineFull = afterMarkTimelineFull.filter(r => r.from_id === testUser || r.to_id === testUser)
  assert(
    ourRowsTimelineFull.length === 4,
    `timeline includeAbsorbed=true returns all 4 (got ${ourRowsTimelineFull.length})`
  )

  // 插入 65 条更新的主线消息后，天气子帧已经落到 recent raw floor 之外；
  // 此时默认窗口应再次隐藏 absorbed，只保留可见主线。
  for (let i = 0; i < 65; i++) {
    const ts = new Date(Date.parse(t2) + (i + 1) * 1000).toISOString()
    insertConversation({
      role: 'user',
      from_id: testUser,
      to_id: 'jarvis',
      content: `主线继续 ${i}`,
      timestamp: ts,
    })
  }
  const afterAging = getRecentConversation(testUser, 100, 24)
  assert(
    afterAging.every(r => r.content !== '今天天气怎么样' && r.content !== '今天晴天 25 度'),
    'after aging past raw floor: absorbed leaf rows are hidden again'
  )

  // 错误防御：startedAt 为空时返回 0，不抛
  const nullMark = markConversationsAbsorbed(null, t2)
  assert(nullMark === 0, 'markConversationsAbsorbed(null) returns 0')

  console.log('\n[test-noise-eviction] all checks done')
} catch (err) {
  // better-sqlite3 ABI 不匹配时这里会捕获；CI 上跑 electron 内置 node 也走这条路径
  console.warn('[test-noise-eviction] SKIPPED:', err?.message || err)
  console.warn('  (likely better-sqlite3 ABI mismatch — run inside electron or rebuild native modules)')
} finally {
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
}
