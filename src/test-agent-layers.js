import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createEventJournal } from './kernel/event-journal.js'
import { createSQLiteStore } from './kernel/sqlite-store.js'
import { createRuntimeEventService } from './runtime/event-service.js'
import { createSSEEvents } from './app/sse-events.js'
import { inspectAgentLayers } from '../scripts/check-agent-layers.mjs'

const response = () => ({ chunks: [], write(chunk) { this.chunks.push(chunk) } })

test('journal bounds replay by count and time; subscription failures are isolated', () => {
  let now = 1000
  const journal = createEventJournal({ limit: 2, ttlMs: 100, now: () => now })
  let failedCalls = 0
  const seen = []
  journal.subscribe(() => { failedCalls++; throw Error('disconnected') })
  const unsubscribe = journal.subscribe(event => seen.push(event.id))
  journal.publish('one', {})
  journal.publish('two', {})
  journal.publish('three', {})
  assert.deepEqual(journal.since(0).map(e => e.id), [2, 3])
  assert.deepEqual(seen, [1, 2, 3])
  assert.equal(failedCalls, 1)
  unsubscribe()
  now += 101
  assert.deepEqual(journal.since(0), [])
  journal.publish('four', {})
  assert.deepEqual(seen, [1, 2, 3])
})

test('Runtime persists without UI; App reconnect preserves wire format and sticky events', () => {
  const rows = []
  const journal = createEventJournal()
  const runtime = createRuntimeEventService({ journal, insertBrainUiEvent: row => rows.push(row) })
  const app = createSSEEvents(journal)
  runtime.emitEvent('tick', {})
  runtime.emitEvent('message_received', { input: 'hello' })
  runtime.emitEvent('tool_call', { runtime_lane: 'background' })
  runtime.emitEvent('response', {})
  assert.deepEqual(rows.map(row => [row.path, row.eventType]), [
    ['l2', 'tick'], ['l2', 'processing_preempted'], ['l1', 'message_received'], ['l1', 'response'],
  ])
  const res = response()
  assert.equal(app.flushEventsSince(res, 1).replayed, 3)
  assert.match(res.chunks[0], /^id: 2\ndata: /)
  const event = JSON.parse(res.chunks[0].split('\n')[1].slice(6))
  assert.equal(event.event_id, 2)
  assert.equal(event.data.input, 'hello')
  runtime.setStickyEvent('ready', { ok: true })
  const sticky = response()
  app.flushStickyEvents(sticky)
  assert.equal(JSON.parse(sticky.chunks[0].slice(6)).type, 'ready')
  runtime.clearStickyEvent('ready')
  app.flushStickyEvents(sticky)
  assert.equal(sticky.chunks.length, 1)
  app.addSSEClient(res)
  app.addSSEClient(res)
  runtime.emitEvent('tick', {})
  assert.equal(res.chunks.length, 4)
  app.removeSSEClient(res)
  runtime.emitEvent('response', {})
  assert.equal(res.chunks.length, 4)
})

test('failed SSE clients do not block other clients or persistence', () => {
  const journal = createEventJournal()
  const rows = []
  const runtime = createRuntimeEventService({ journal, insertBrainUiEvent: row => rows.push(row) })
  const app = createSSEEvents(journal)
  let writes = 0
  app.addSSEClient({ write() { writes++; throw Error('closed') } })
  const healthy = response()
  app.addSSEClient(healthy)
  runtime.emitEvent('tick', {})
  runtime.emitEvent('response', {})
  assert.equal(writes, 1)
  assert.equal(healthy.chunks.length, 2)
  assert.equal(rows.length, 2)
})

test('SQLite connection closes failed initialization and can retry/reopen', () => {
  const connections = []
  class FakeDatabase {
    constructor(filename) { this.filename = filename; connections.push(this) }
    pragma(value) { assert.equal(value, 'journal_mode = WAL') }
    close() { this.closed = true }
  }
  let fail = true
  const store = createSQLiteStore({ filename: ':memory:', DatabaseImpl: FakeDatabase,
    initialize() { if (fail) throw Error('migration failed') },
  })
  assert.throws(store.getDB, /migration failed/)
  assert.equal(connections[0].closed, true)
  fail = false
  const first = store.getDB()
  assert.equal(store.getDB(), first)
  store.close()
  store.close()
  assert.equal(first.closed, true)
  assert.notEqual(store.getDB(), first)
  store.close()
})

test('compatibility queue and control imports share Runtime state', async () => {
  const oldQueue = await import('./queue.js')
  const queue = await import('./runtime/queue.js')
  const oldControl = await import('./control.js')
  const control = await import('./runtime/control.js')
  assert.equal(oldQueue.enqueueMessage, queue.enqueueMessage)
  assert.equal(oldControl.stopLoop, control.stopLoop)
  const entry = { fromId: 'test', queueName: 'user' }
  oldQueue.enqueueMessage(entry)
  assert.equal(queue.popMessage(), entry)
})

test('migrated modules enforce dependency boundaries and remain in the single App package', () => {
  const { errors } = inspectAgentLayers()
  assert.deepEqual(errors, [])
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.main, 'electron/main.cjs')
  for (const patterns of [pkg.build.files, pkg.build.win.files]) {
    assert.ok(patterns.includes('src/**/*'), 'all layers must be bundled in the existing App')
    assert.ok(!patterns.some(pattern => /^!src\/(kernel|runtime|app)(\/|$)/.test(pattern)))
  }
})
