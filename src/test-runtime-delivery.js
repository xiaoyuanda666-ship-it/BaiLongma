import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-runtime-delivery-'))
process.env.BAILONGMA_USER_DIR = tmp
process.env.BAILONGMA_RESOURCES_DIR = process.cwd()
process.env.BAILONGMA_HOST = '127.0.0.1'

async function openEventStream(url) {
  const controller = new AbortController()
  const res = await fetch(url, { signal: controller.signal })
  assert.equal(res.status, 200, 'GET /events opens the SSE stream')

  const waiters = []
  const seen = []
  let buffer = ''

  function emit(evt) {
    seen.push(evt)
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i]
      if (waiter.type === evt.type) {
        clearTimeout(waiter.timer)
        waiters.splice(i, 1)
        waiter.resolve(evt)
      }
    }
  }

  const readLoop = (async () => {
    const decoder = new TextDecoder()
    const reader = res.body.getReader()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const data = frame
            .split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart())
            .join('\n')
          if (!data) continue
          try { emit(JSON.parse(data)) } catch {}
        }
      }
    } catch (err) {
      if (err?.name !== 'AbortError') throw err
    }
  })()

  return {
    waitFor(type, timeoutMs = 2000) {
      const existing = seen.find(evt => evt.type === type)
      if (existing) return Promise.resolve(existing)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex(waiter => waiter.resolve === resolve)
          if (idx !== -1) waiters.splice(idx, 1)
          reject(new Error(`Timed out waiting for SSE event: ${type}`))
        }, timeoutMs)
        waiters.push({ type, resolve, reject, timer })
      })
    },
    async close() {
      controller.abort()
      try { await readLoop } catch (err) {
        if (err?.name !== 'AbortError') throw err
      }
    },
  }
}

let server = null
let closeDBForTest = null
let events = null

try {
  const { startAPI } = await import('./api.js')
  const { executeTool } = await import('./capabilities/executor.js')
  const dbModule = await import('./db.js')
  closeDBForTest = dbModule.closeDBForTest

  server = startAPI(0)
  await once(server, 'listening')

  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`
  events = await openEventStream(`${baseUrl}/events`)
  await events.waitFor('connected')

  const blocked = await executeTool('send_message', {
    target_id: 'ID:000002',
    content: 'should not be delivered',
    channel: 'TUI',
  }, {
    source: 'test-runtime-delivery',
    autonomous: true,
    allowedTargetIds: ['ID:000001'],
  })
  assert.match(blocked, /自主心跳无权联系/)

  const content = `runtime_delivery_probe_${Date.now()} 中文出站保持一致`
  const result = await executeTool('send_message', {
    target_id: 'ID:000001',
    content,
    channel: 'TUI',
  }, {
    source: 'test-runtime-delivery',
    autonomous: true,
    allowedTargetIds: ['ID:000001'],
  })

  const success = JSON.parse(result)
  assert.equal(success.ok, true)
  assert.equal(success.delivered, true)
  assert.equal(success.message_sent, true)
  assert.equal(success.target_id, 'ID:000001')
  assert.equal(success.channel, 'TUI')

  const evt = await events.waitFor('message')
  assert.equal(evt.data.to, 'ID:000001')
  assert.equal(evt.data.content, content)
  assert.equal(evt.data.channel, 'TUI')
  assert.equal(evt.data.external_party_id, '')
  assert(evt.data.conversation_id > 0, 'SSE message includes the inserted conversation id')

  const row = dbModule.getDB().prepare(`
    SELECT id, role, from_id, to_id, content, channel, external_party_id, open_question
    FROM conversations
    WHERE id = ?
  `).get(evt.data.conversation_id)

  assert(row, 'send_message inserts a conversation row')
  assert.equal(row.role, 'jarvis')
  assert.equal(row.from_id, 'jarvis')
  assert.equal(row.to_id, 'ID:000001')
  assert.equal(row.content, content)
  assert.equal(row.channel, 'TUI')
  assert.equal(row.external_party_id, '')
  assert.equal(row.open_question, 0)
  assert.equal(
    dbModule.getDB().prepare('SELECT delivery_status FROM conversations WHERE id = ?').get(evt.data.conversation_id).delivery_status,
    'delivered',
    'local send is persisted as authoritative delivery evidence',
  )

  const duplicateResult = await executeTool('send_message', {
    target_id: 'ID:000001',
    content,
    channel: 'TUI',
  }, {
    source: 'test-runtime-delivery',
    autonomous: true,
    allowedTargetIds: ['ID:000001'],
  })
  const duplicate = JSON.parse(duplicateResult)
  assert.equal(duplicate.ok, true)
  assert.equal(duplicate.delivered, true)
  assert.equal(duplicate.message_sent, false)
  assert.equal(duplicate.skipped, 'already_delivered_unanswered')
  const duplicateRows = dbModule.getDB().prepare(`
    SELECT COUNT(*) AS count FROM conversations
    WHERE role = 'jarvis' AND to_id = ? AND content = ?
  `).get('ID:000001', content)
  assert.equal(duplicateRows.count, 1, 'atomic idempotency prevents duplicate DB/outbound side effects')

  dbModule.insertConversation({
    role: 'user',
    from_id: 'ID:000001',
    to_id: 'jarvis',
    content: 'Please answer again.',
    timestamp: new Date().toISOString(),
    channel: 'TUI',
  })
  assert.equal(dbModule.findUnansweredDeliveredOutbound({
    toId: 'ID:000001',
    content,
    channel: 'TUI',
    externalPartyId: '',
  }), null, 'a new user message clears the unanswered-delivery boundary')

  console.log('PASS runtime delivery send_message preserves DB and SSE behavior')
} finally {
  await events?.close()
  if (server) {
    await new Promise(resolve => server.close(resolve))
  }
  closeDBForTest?.()
  fs.rmSync(tmp, { recursive: true, force: true })
}

process.exit(process.exitCode || 0)
