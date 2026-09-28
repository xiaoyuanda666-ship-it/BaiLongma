import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-event-services-'))
process.env.BAILONGMA_USER_DIR = directory
let close
try {
  const db = await import('./db.js')
  close = db.closeDBForTest
  const runtime = await import('./runtime/events.js')
  const legacy = await import('./events.js')
  const app = await import('./app/event-stream.js')
  assert.equal(runtime.emitEvent, legacy.emitEvent)
  assert.equal(app.addSSEClient, legacy.addSSEClient)
  const received = []
  const client = { write: chunk => received.push(chunk) }
  app.addSSEClient(client)
  runtime.emitEvent('message_received', { input: 'first' })
  legacy.emitEvent('response', { text: 'second' })
  app.removeSSEClient(client)
  assert.equal(received.length, 2)
  assert.equal(db.getBrainUiEventHistory({ path: 'l1', limit: 10 }).events.length, 2)
  const replay = []
  assert.equal(legacy.flushEventsSince({ write: value => replay.push(value) }, 1).replayed, 1)
  assert.equal(replay[0], received[1])
  runtime.setStickyEvent('ready', { active: true })
  const sticky = []
  app.flushStickyEvents({ write: value => sticky.push(value) })
  assert.equal(JSON.parse(sticky[0].slice(6)).data.active, true)
  legacy.clearStickyEvent('ready')
  app.flushStickyEvents({ write: value => sticky.push(value) })
  assert.equal(sticky.length, 1)
  console.log('PASS compatibility and layered event entries share one persisted stream')
} finally {
  close?.()
  fs.rmSync(directory, { recursive: true, force: true })
}
