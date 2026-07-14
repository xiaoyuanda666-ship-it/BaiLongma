import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-api-utf8-'))
process.env.JARVIS_USER_DIR = tmp
process.env.JARVIS_RESOURCES_DIR = process.cwd()
process.env.JARVIS_HOST = '127.0.0.1'

let server = null
let closeDBForTest = null

try {
  const { startAPI } = await import('./api.js')
  ;({ closeDBForTest } = await import('./db.js'))
  server = startAPI(0)
  await once(server, 'listening')

  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`
  const expected = `utf8_api_probe_${Date.now()} 中文保真测试：你好，Jarvis！`
  const body = JSON.stringify({
    from_id: 'ID:UTF8_API_TEST',
    channel: 'API_UTF8_TEST',
    content: expected,
  })

  const postRes = await fetch(`${baseUrl}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(body)),
    },
    body,
  })
  if (postRes.status !== 200) {
    throw new Error(`POST /message failed ${postRes.status}: ${await postRes.text()}`)
  }
  const postBody = await postRes.json()
  assert(postBody.conversation_id > 0, 'POST /message returns the inserted conversation_id')

  const rowsRes = await fetch(`${baseUrl}/conversations?limit=20`)
  if (rowsRes.status !== 200) {
    throw new Error(`GET /conversations failed ${rowsRes.status}: ${await rowsRes.text()}`)
  }
  const rows = await rowsRes.json()
  const row = rows.find(item => item.channel === 'API_UTF8_TEST')

  assert(row, 'posted UTF-8 message is present in /conversations')
  assert.equal(row.id, postBody.conversation_id, 'conversation_id matches the /conversations row id')
  assert.equal(row.content, expected, 'Chinese content round-trips through /message and /conversations')
  assert.equal(row.from_id, 'ID:UTF8_API_TEST')

  console.log('PASS api /message preserves UTF-8 Chinese content')
} finally {
  if (server) {
    await new Promise(resolve => server.close(resolve))
  }
  closeDBForTest?.()
  fs.rmSync(tmp, { recursive: true, force: true })
}

process.exit(process.exitCode || 0)
