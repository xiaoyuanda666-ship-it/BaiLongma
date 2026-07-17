import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-multi-client-'))
process.env.BAILONGMA_USER_DIR = tmp
process.env.BAILONGMA_RESOURCES_DIR = process.cwd()
process.env.BAILONGMA_HOST = '127.0.0.1'
delete process.env.BAILONGMA_ALLOW_LAN
delete process.env.BAILONGMA_TLS_CERT
delete process.env.BAILONGMA_TLS_KEY
delete process.env.BAILONGMA_TLS_PFX

let server = null
let closeDBForTest = null
const streams = []

async function openEventStream(url) {
  const response = await fetch(url)
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  async function nextEvent(expectedType) {
    while (true) {
      const boundary = buffer.indexOf('\n\n')
      if (boundary >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const dataLine = block.split('\n').find(line => line.startsWith('data: '))
        if (!dataLine) continue
        const event = JSON.parse(dataLine.slice(6))
        if (!expectedType || event.type === expectedType) return event
        continue
      }
      const { done, value } = await reader.read()
      if (done) throw new Error(`SSE ended before ${expectedType || 'next event'}`)
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    }
  }

  streams.push(reader)
  await nextEvent('connected')
  return { nextEvent, reader }
}

try {
  const { startAPI } = await import('./api.js')
  const { deliverMessage } = await import('./runtime/delivery.js')
  const { emitEvent } = await import('./events.js')
  const { popMessage } = await import('./queue.js')
  ;({ closeDBForTest } = await import('./db.js'))

  server = startAPI(0)
  await once(server, 'listening')
  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`
  const clientA = 'ui-test-client-a'
  const clientB = 'ui-test-client-b'
  const streamA = await openEventStream(`${baseUrl}/events?client_id=${clientA}`)
  const streamB = await openEventStream(`${baseUrl}/events?client_id=${clientB}`)

  const userText = `multi_client_user_${Date.now()}`
  const clientMessageId = `client-message-${Date.now()}`
  const postResponse = await fetch(`${baseUrl}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bailongma-Client-ID': clientA,
    },
    body: JSON.stringify({
      from_id: 'ID:000001',
      channel: '语音识别',
      content: userText,
      client_id: clientA,
      client_message_id: clientMessageId,
    }),
  })
  assert.equal(postResponse.status, 200)
  const posted = await postResponse.json()
  assert(posted.conversation_id > 0)

  const [inboundA, inboundB] = await Promise.all([
    streamA.nextEvent('message_in'),
    streamB.nextEvent('message_in'),
  ])
  for (const event of [inboundA, inboundB]) {
    assert.equal(event.data.content, userText)
    assert.equal(event.data.client_id, clientA)
    assert.equal(event.data.client_message_id, clientMessageId)
    assert.equal(event.data.conversation_id, posted.conversation_id)
  }
  const queuedVoiceMessage = popMessage()
  assert.equal(queuedVoiceMessage.clientId, clientA)
  assert.equal(queuedVoiceMessage.clientMessageId, clientMessageId)
  assert.equal(queuedVoiceMessage.channel, '语音识别')

  const replyText = `multi_client_reply_${Date.now()}`
  await deliverMessage({
    target_id: 'ID:000001',
    channel: 'TUI',
    content: replyText,
  }, {
    currentChannel: '语音识别',
    voiceReply: true,
    replyClientId: clientA,
    replyTurnId: 'turn-multi-client-test',
  })

  const [replyA, replyB] = await Promise.all([
    streamA.nextEvent('message'),
    streamB.nextEvent('message'),
  ])
  for (const event of [replyA, replyB]) {
    assert.equal(event.data.content, replyText)
    assert.equal(event.data.speak, true)
    assert.equal(event.data.target_client_id, clientA)
    assert.equal(event.data.turn_id, 'turn-multi-client-test')
  }

  await streamA.reader.cancel()
  emitEvent('voice_reconnect_probe', {
    target_client_id: clientA,
    turn_id: 'turn-after-reconnect',
  })
  const reconnectedA = await openEventStream(
    `${baseUrl}/events?client_id=${clientA}&last_event_id=${replyA.event_id}`,
  )
  const replayed = await reconnectedA.nextEvent('voice_reconnect_probe')
  assert.equal(replayed.data.target_client_id, clientA)
  assert.equal(replayed.data.turn_id, 'turn-after-reconnect')

  const rows = await fetch(`${baseUrl}/conversations?limit=10`).then(response => response.json())
  assert(rows.some(row => row.id === posted.conversation_id && row.content === userText))
  assert(rows.some(row => row.role === 'jarvis' && row.content === replyText))

  console.log('Multi-client chat sync and directed voice routing tests passed')
} finally {
  await Promise.all(streams.map(reader => reader.cancel().catch(() => {})))
  if (server) await new Promise(resolve => server.close(resolve))
  closeDBForTest?.()
  fs.rmSync(tmp, { recursive: true, force: true })
}
