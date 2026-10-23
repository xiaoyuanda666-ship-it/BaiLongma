import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

// Run with the project's Electron Node runtime when better-sqlite3 is built
// against Electron. All database/config writes stay in this temporary directory.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-embedding-latency-'))
process.env.BAILONGMA_USER_DIR = directory
fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({
  embedding: { model: 'test-never-download-a-model', timeoutMs: 1500 },
}))

const { getDB, closeDBForTest } = await import('./db.js')
const { runMemoryInjector } = await import('./injectors/memory-injector.js')
const { createPerformanceTrace, runWithPerformanceTrace } = await import('./runtime/performance-trace.js')
const { getEmbeddingTimeoutMs } = await import('./embedding.js')
try {
  getDB().prepare(`INSERT INTO memories(event_type,content,detail,title,mem_id,timestamp)
    VALUES(?,?,?,?,?,?)`).run('fact', 'performance fixture', 'lexical recall survives a cold model', 'performance', 'latency_fixture', new Date().toISOString())
  const trace = createPerformanceTrace({ channel: 'test' })
  const started = performance.now()
  const result = await runWithPerformanceTrace(trace, () => runMemoryInjector({
    messageBody: 'performance',
    fastUserPath: true,
  }))
  const elapsedMs = performance.now() - started
  assert(result.memories.some(memory => memory.mem_id === 'latency_fixture'), 'cold realtime requests retain lexical memory retrieval')
  const embedding = trace.snapshot().events.find(event => event.name === 'embedding.result')
  assert(embedding, 'the fast-path option reaches the semantic retrieval boundary')
  assert.equal(embedding.fastUserPath, true)
  assert.equal(embedding.budgetMs, 120)
  assert.equal(embedding.available, false)
  assert.equal(embedding.timedOut, false, 'cold realtime lookup does not start model loading or wait for a timeout')
  assert.equal(getEmbeddingTimeoutMs(), 1500, 'background retrieval keeps its full configured budget')
  console.log(`Cold realtime memory retrieval preserved lexical results in ${elapsedMs.toFixed(1)} ms`)
} finally {
  closeDBForTest()
  fs.rmSync(directory, { recursive: true, force: true })
}
