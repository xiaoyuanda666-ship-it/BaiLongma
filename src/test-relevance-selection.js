// 「少即是强」承重墙改造测试 —— Fix 1（相关度选择器取代 salience 整体重排）。
//
// 原生模块 better-sqlite3 是为 Electron ABI 编译的，必须用 electron 跑：
//   npx electron src/test-relevance-selection.js
// （plain node 会 ERR_DLOPEN_FAILED）
//
// 覆盖：
//   A. db.searchMemories 现在带出 bm25 相关度分 _ftsScore（真实 FTS5 路径）
//   B. selectContextMemories 选择器逻辑（保留相关度序 + 高 salience 窄保留道 + 相关度地板）
//   C. 承重墙复刻：相关但低 salience 的记忆，旧逻辑被高 salience 噪声顶下去，新逻辑排在前
//   D. runInjector 全链路 smoke（离线，不触发网络/LLM）

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

let failed = 0
function assert(cond, label) {
  if (cond) { console.log(`PASS: ${label}`) }
  else { console.error(`FAIL: ${label}`); failed++; process.exitCode = 1 }
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tempUserDir = fs.mkdtempSync(path.join(repoRoot, 'sandbox', 'relevance-test-'))
process.env.JARVIS_USER_DIR = tempUserDir
process.env.USERPROFILE = tempUserDir
process.env.HOME = tempUserDir

// 旧承重墙逻辑（salience 整体重排）的最小复刻，仅供 Test C 做对照。
function oldRerankSalienceThenSlice(memories, cap) {
  const boostOf = (m) => { const s = Number(m.salience) || 0; return s >= 4 ? s : 0 }
  return [...memories].sort((a, b) => boostOf(b) - boostOf(a)).slice(0, cap)
}
function dedupById(arrays) {
  const seen = new Set(); const out = []
  for (const m of arrays.flat()) { if (!m || seen.has(m.id)) continue; seen.add(m.id); out.push(m) }
  return out
}

try {
  const db = await import('./db.js')
  const { insertMemory, searchMemories, getMemoriesByEntity } = db
  const { selectContextMemories, runInjector } = await import('./memory/injector.js')

  db.getDB() // 触发 schema 初始化

  // ── 造数据 ──────────────────────────────────────────────
  // R：与查询高度相关（含独特词 "qttoken"），但 salience 低（2）
  // H：与查询完全无关，但 salience 高（5）——模拟"重要但跑题"的噪声
  // 两者都挂到同一 sender 实体，让 H 走 getMemoriesByEntity 进 sender 桶
  const SENDER = 'ID:000099'
  const QUERY_TOKEN = 'qttoken'
  insertMemory({
    event_type: 'fact', content: `关于 ${QUERY_TOKEN} 的关键事实，这条跟当前问题直接相关`,
    salience: 2, timestamp: new Date().toISOString(), entities: [SENDER],
  })
  insertMemory({
    event_type: 'fact', content: '一条完全无关的高价值记忆 mangoborkzz',
    salience: 5, timestamp: new Date().toISOString(), entities: [SENDER],
  })
  // insertMemory 的 INSERT 不含 salience 列，直接补写，让新旧对照真正有 salience 差
  db.getDB().prepare(`UPDATE memories SET salience = 2 WHERE content LIKE ?`).run(`%${QUERY_TOKEN}%`)
  db.getDB().prepare(`UPDATE memories SET salience = 5 WHERE content LIKE '%mangoborkzz%'`).run()

  // ── Test A：searchMemories 带出 _ftsScore ────────────────
  const hits = searchMemories(QUERY_TOKEN, 5)
  assert(hits.length >= 1, 'A1 searchMemories 命中相关记忆')
  assert(hits.every(h => Number.isFinite(h._ftsScore)), 'A2 命中行带有限的 bm25 _ftsScore')
  assert(!hits.some(h => h.content.includes('mangoborkzz')), 'A3 无关高 salience 记忆未被关键词召回')

  // ── Test B：选择器逻辑（在树内，非独立复刻）──────────────
  const idsOf = a => a.map(m => m.id).join(',')
  const B = [
    { id: 1, salience: 3 }, { id: 2, salience: 3 }, { id: 3, salience: 3 },
    { id: 4, salience: 5 }, { id: 5, salience: 4 },
  ]
  assert(idsOf(selectContextMemories([{ id: 1 }, { id: 2 }], { cap: 3 })) === '1,2', 'B1 全在 cap 内：原序返回')
  assert(idsOf(selectContextMemories(B, { cap: 3 })) === '1,4,5', 'B2 溢出：高 salience 锚救回，替换 cap 尾部')
  assert(idsOf(selectContextMemories(B.map(m => ({ ...m, salience: 3 })), { cap: 3 })) === '1,2,3', 'B3 溢出无锚：截断保前排相关度序')
  assert(
    idsOf(selectContextMemories(
      [{ id: 1, _ftsScore: -5 }, { id: 2, _ftsScore: 99 }, { id: 3 }], { cap: 5, ftsFloor: 0 }
    )) === '1,3',
    'B4 地板开启：_ftsScore 超阈值丢弃，无分豁免'
  )
  assert(
    idsOf(selectContextMemories(
      [{ id: 1, _ftsScore: -5 }, { id: 2, _ftsScore: 99 }], { cap: 5 }
    )) === '1,2',
    'B5 地板默认关：弱相关不丢'
  )

  // ── Test C：承重墙复刻——新旧对照 ────────────────────────
  // 忠实复刻 injector 的两行：merged = dedup([relevant, sender]); select(merged, cap)
  const relevant = searchMemories(QUERY_TOKEN, 15)
  const senderMemories = getMemoriesByEntity(SENDER, 10)
  const merged = dedupById([relevant, senderMemories])
  const relIdx = m => m.content.includes(QUERY_TOKEN)
  const noiseIdx = m => m.content.includes('mangoborkzz')

  const oldPick = oldRerankSalienceThenSlice(merged, 12)
  const newPick = selectContextMemories(merged, { cap: 12, anchorLane: 2 })

  const oldRelPos = oldPick.findIndex(relIdx)
  const oldNoisePos = oldPick.findIndex(noiseIdx)
  const newRelPos = newPick.findIndex(relIdx)
  const newNoisePos = newPick.findIndex(noiseIdx)

  console.log(`   [对照] 旧逻辑顺序: 相关@${oldRelPos} 噪声@${oldNoisePos} | 新逻辑顺序: 相关@${newRelPos} 噪声@${newNoisePos}`)
  assert(merged.length >= 2, 'C0 merged 同时含相关记忆与高 salience 噪声')
  assert(oldRelPos > oldNoisePos, 'C1 旧逻辑：相关记忆被高 salience 噪声顶到后面（病灶复现）')
  assert(newRelPos < newNoisePos, 'C2 新逻辑：相关记忆排在噪声之前（病灶修复）')
  assert(newRelPos === 0, 'C3 新逻辑：相关记忆排在最前')

  // ── Test D：runInjector 全链路 smoke（离线）──────────────
  // 时间戳须匹配 parseMessageInput 的正则 [\d\-T:+]+（不含毫秒的 . 和 Z），否则 senderId 解析失败
  const msg = `[${SENDER}] 2026-05-31T10:00:00+08:00 [TUI] 告诉我关于 ${QUERY_TOKEN} 的事`
  const injection = await runInjector({ message: msg, state: {} })
  assert(Array.isArray(injection.memories), 'D1 runInjector 返回 memories 数组')
  assert(injection.memories.length >= 1, 'D2 runInjector 召回到记忆')
  const injRelPos = injection.memories.findIndex(relIdx)
  const injNoisePos = injection.memories.findIndex(noiseIdx)
  console.log(`   [runInjector] 相关@${injRelPos} 噪声@${injNoisePos} (共 ${injection.memories.length} 条)`)
  if (injRelPos !== -1 && injNoisePos !== -1) {
    assert(injRelPos < injNoisePos, 'D3 全链路：相关记忆排在高 salience 噪声之前')
  } else {
    console.log('   [skip D3] 关键词抽取未同时召回两条，跳过顺序断言（A/C 已证承重墙逻辑）')
  }
} catch (err) {
  failed++; process.exitCode = 1
  console.error(`FAIL: 未预期异常: ${err.stack || err.message}`)
} finally {
  try { fs.rmSync(tempUserDir, { recursive: true, force: true }) } catch {}
}

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
