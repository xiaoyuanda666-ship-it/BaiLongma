import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-chat-resources-'))
process.env.BAILONGMA_USER_DIR = tempRoot
process.env.BAILONGMA_RESOURCES_DIR = process.cwd()
process.env.BAILONGMA_HOST = '127.0.0.1'

let server = null
let closeDBForTest = null

try {
  const { startAPI } = await import('./api.js')
  const dbModule = await import('./db.js')
  const queueModule = await import('./queue.js')
  const { formatConversationMessage } = await import('./runtime/messages.js')
  const {
    buildPendingResourceInjectorContext,
    mergePendingResourcesIntoConversationWindow,
  } = await import('./chat-resources.js')
  closeDBForTest = dbModule.closeDBForTest
  while (queueModule.popMessage()) {}

  server = startAPI(0)
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const stageResponse = await fetch(`${baseUrl}/message/resources`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from_id: 'ID:000001',
      client_id: 'ui-resource-test-client',
      client_message_id: 'resource-test-message-001',
      resources: [
        {
          name: '说明.txt',
          mime: 'text/plain',
          data_url: `data:text/plain;base64,${Buffer.from('hello staged resource', 'utf8').toString('base64')}`,
        },
        {
          name: 'pixel.png',
          mime: 'image/png',
          data_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        },
      ],
    }),
  })
  const staged = await stageResponse.json()
  assert.equal(stageResponse.status, 200, staged.error || 'resource staging failed')
  assert(staged.conversation_id > 0)
  assert.equal(staged.resource_state, 'pending')
  assert.equal(staged.resources.length, 2)
  assert.equal(queueModule.getQueueSnapshot().user, 0, 'dropping resources must not enqueue an Agent turn')

  const db = dbModule.getDB()
  const resourceRow = db.prepare(`
    SELECT * FROM conversations WHERE id = ?
  `).get(staged.conversation_id)
  assert.equal(resourceRow.role, 'user')
  assert.equal(resourceRow.channel, 'RESOURCE')
  assert.equal(resourceRow.resource_state, 'pending')
  const metadata = JSON.parse(resourceRow.resource_metadata)
  assert.equal(metadata.length, 2)
  for (const resource of metadata) {
    assert(resource.path.startsWith('chat-uploads/'))
    assert(fs.existsSync(path.join(tempRoot, 'sandbox', resource.path)))
  }

  const heartbeatTimeline = dbModule.getRecentConversationTimeline(20, 24)
  assert.equal(
    heartbeatTimeline.some(row => row.channel === 'RESOURCE'),
    false,
    'heartbeat history must not see staged resource-only records',
  )

  const downloaded = await fetch(`${baseUrl}${metadata[0].url}`)
  assert.equal(downloaded.status, 200)
  assert.equal(await downloaded.text(), 'hello staged resource')

  const directPrompt = formatConversationMessage(resourceRow, {
    pendingResources: [resourceRow],
  })
  assert.match(directPrompt.content, /current user message is their follow-up instruction/i)
  assert.match(directPrompt.content, /sandbox_path="chat-uploads\//)
  assert.match(buildPendingResourceInjectorContext([resourceRow]), /analyze image content/i)

  const forcedWindow = mergePendingResourcesIntoConversationWindow([
    { id: staged.conversation_id + 1, role: 'user', content: '看看这些内容' },
  ], [resourceRow])
  assert.deepEqual(forcedWindow.map(row => row.id), [staged.conversation_id, staged.conversation_id + 1])

  const instructionResponse = await fetch(`${baseUrl}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from_id: 'ID:000001',
      channel: 'VOICE',
      client_id: 'ui-resource-test-client',
      client_message_id: 'resource-test-instruction-001',
      content: '看看这些内容并告诉我重点',
    }),
  })
  assert.equal(instructionResponse.status, 200)
  const instruction = await instructionResponse.json()
  assert(instruction.conversation_id > staged.conversation_id)
  assert.equal(queueModule.getQueueSnapshot().user, 1, 'the later voice/text instruction starts the Agent turn')

  const queued = queueModule.popMessage()
  assert.equal(queued.content, '看看这些内容并告诉我重点')
  assert.equal(queued.channel, 'VOICE')
  assert.equal(queued.pendingResources.length, 1)
  assert.equal(queued.pendingResources[0].id, staged.conversation_id)
  assert.equal(dbModule.getPendingConversationResources('ID:000001').length, 0)
  assert.equal(
    db.prepare('SELECT resource_state FROM conversations WHERE id = ?').get(staged.conversation_id).resource_state,
    'consumed',
  )

  const historyResponse = await fetch(`${baseUrl}/conversations?limit=10`)
  const history = await historyResponse.json()
  const historyResource = history.find(row => row.id === staged.conversation_id)
  assert.equal(historyResource.resource_state, 'consumed')
  assert.equal(JSON.parse(historyResource.resource_metadata).length, 2)

  console.log('PASS dropped chat resources persist without processing and join the next text/voice turn')
} finally {
  if (server) await new Promise(resolve => server.close(resolve))
  closeDBForTest?.()
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

process.exit(process.exitCode || 0)
