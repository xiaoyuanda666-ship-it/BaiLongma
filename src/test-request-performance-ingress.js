import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-ingress-timing-'))
process.env.BAILONGMA_USER_DIR = tempRoot
process.env.BAILONGMA_RESOURCES_DIR = process.cwd()
process.env.BAILONGMA_HOST = '127.0.0.1'
process.env.BAILONGMA_PERFORMANCE_TRACE = '0'

let server
let closeDBForTest
let setInterruptCallback
try {
  const { startAPI } = await import('./api.js')
  const dbModule = await import('./db.js')
  const queue = await import('./queue.js')
  const { getPerformanceTraces } = await import('./runtime/performance-trace.js')
  closeDBForTest = dbModule.closeDBForTest
  setInterruptCallback = queue.setInterruptCallback
  while (queue.popMessage()) {}
  let callbackEntry
  setInterruptCallback(entry => {
    callbackEntry = entry
    assert(entry.performanceTrace, 'Information activation preserves the live trace')
    assert(entry.performanceTrace.snapshot().events.some(event => event.name === 'queue.enqueued'),
      'queue timing is recorded before the synchronous scheduler callback')
  })
  server = startAPI(0)
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const post = (body, headers = {}, route = '/message') => fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const input = {
    from_id: 'ID:PERFORMANCE_INGRESS',
    content: 'private-content-must-not-be-in-performance-data',
    channel: 'API_PERFORMANCE',
    client_message_id: 'performance-message-001',
  }
  const response = await post(input, {
    'X-Bailongma-Client-Prepare-Ms': '12.5',
    'X-Bailongma-Client-Serialize-Ms': '1.25',
  })
  assert.equal(response.status, 200)
  const accepted = await response.json()
  const queued = queue.popMessage()
  assert.equal(queued, callbackEntry)
  assert.equal(accepted.request_id, queued.performanceTrace.id)
  assert.equal(response.headers.get('x-bailongma-request-id'), accepted.request_id)
  let snapshot = queued.performanceTrace.snapshot()
  assert.deepEqual(snapshot.client, { clientPrepareMs: 12.5, clientSerializeMs: 1.25 })
  assert.equal(snapshot.channel, 'API_PERFORMANCE')
  assert.equal(snapshot.status, 'running', 'HTTP acknowledgement does not finish a model turn')
  assert(snapshot.summary.ingressMs >= 0)
  assert.equal(snapshot.summary.dispatchToFirstDeltaMs, null, 'acceptance is not a model delta')
  for (const name of ['ingress.read_body', 'ingress.media', 'ingress.pending_resources', 'ingress.persist', 'ingress.information_activation']) {
    assert(snapshot.spans.some(span => span.name === name && span.durationMs >= 0), name)
  }
  assert(!JSON.stringify(snapshot).includes(input.content), 'performance data excludes message content')
  const storedEvent = dbModule.getDB().prepare('SELECT metadata_json FROM information_events WHERE id = ?')
    .get(queued.informationEventId)
  assert(storedEvent, 'the default Information Core activation path is covered')
  assert(!storedEvent.metadata_json.includes('performanceTrace'), 'the live trace is not persisted in activation metadata')
  queued.performanceTrace.finish()

  const duplicateResponse = await post(input)
  const duplicate = await duplicateResponse.json()
  assert.equal(duplicate.duplicate, true)
  assert.equal(queue.popMessage(), null)
  snapshot = getPerformanceTraces().find(trace => trace.id === duplicate.request_id)
  assert.equal(snapshot.status, 'rejected')
  assert(snapshot.events.some(event => event.name === 'request.duplicate'))

  const invalidResponse = await post({ content: '' }, {
    'X-Bailongma-Client-Prepare-Ms': '-4',
    'X-Bailongma-Client-Serialize-Ms': 'Infinity',
  })
  assert.equal(invalidResponse.status, 400)
  const invalid = await invalidResponse.json()
  snapshot = getPerformanceTraces().find(trace => trace.id === invalid.request_id)
  assert.equal(snapshot.status, 'rejected')
  assert.deepEqual(snapshot.client, {})

  const resourceResponse = await post({
    from_id: input.from_id,
    client_message_id: 'performance-resource-001',
    resources: [{ name: 'sample.txt', mime: 'text/plain', data_url: 'data:text/plain;base64,aGVsbG8=' }],
  }, {}, '/message/resources')
  assert.equal(resourceResponse.status, 200)
  const resource = await resourceResponse.json()
  snapshot = getPerformanceTraces().find(trace => trace.id === resource.request_id)
  assert.equal(snapshot.status, 'staged', 'staged resources finish without a model turn')
  assert.equal(snapshot.summary.ingressMs, null)
  assert.equal(queue.popMessage(), null)

  const first = await post({ ...input, client_message_id: 'performance-message-002' }).then(res => res.json())
  await post({ ...input, client_message_id: 'performance-message-003' })
  snapshot = getPerformanceTraces().find(trace => trace.id === first.request_id)
  assert.equal(snapshot.status, 'superseded')
  queue.popMessage()?.performanceTrace.finish()

  console.log('PASS request timing survives Information Core activation, correlates client/server, and closes non-turn requests')
} finally {
  setInterruptCallback?.(null)
  if (server) {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
  closeDBForTest?.()
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
process.exit(process.exitCode || 0)
