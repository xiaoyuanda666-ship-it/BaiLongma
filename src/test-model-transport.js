// Run: node src/test-model-transport.js (fake SDK only; no network)
import assert from 'node:assert/strict'
import { createModelTransport } from './kernel/model-transport.js'
import { createModelConnection } from './runtime/model-connection.js'

const clients = []
const calls = []
let failure = null
const stream = { async *[Symbol.asyncIterator]() { yield { type: 'test.delta' } } }
const transport = createModelTransport({
  createClient(options) {
    const id = clients.push(options)
    const create = protocol => async (params, requestOptions) => {
      calls.push({ id, protocol, params, requestOptions })
      if (failure) throw failure
      return stream
    }
    return {
      responses: { create: create('responses') },
      chat: { completions: { create: create('chat-completions') } },
    }
  },
})
let settings = { provider: 'first', baseURL: 'https://first.invalid/v1', apiKey: '' }
const connection = createModelConnection({ readConfig: () => settings, transport })
const controller = new AbortController()
const params = { model: 'example', stream: true, input: [] }
const request = { protocol: 'responses', params, signal: controller.signal }
assert.equal(clients.length, 0, 'module/factory initialization must not instantiate SDK clients')
assert.throws(() => connection.openStream(request), /尚未激活/)
assert.equal(clients.length, 0)
settings.apiKey = 'key-one'
assert.equal(await connection.openStream(request), stream)
assert.equal(typeof clients[0].fetch, 'function')
const connectionOptions = ({ apiKey, baseURL }) => ({ apiKey, baseURL })
assert.deepEqual(clients.map(connectionOptions), [{ apiKey: 'key-one', baseURL: 'https://first.invalid/v1' }])
assert.equal(calls[0].params, params, 'request construction belongs to Runtime')
assert.equal(calls[0].requestOptions.signal, controller.signal)
await connection.openStream(request)
assert.equal(clients.length, 1, 'unchanged connection reuses SDK')
await connection.openStream({ ...request, protocol: 'chat-completions' })
assert.equal(calls.at(-1).protocol, 'chat-completions')
assert.equal(clients.length, 1, 'protocol selection alone does not recreate connection')
for (const change of [
  { apiKey: 'key-two' },
  { baseURL: 'https://second.invalid/v1' },
  { provider: 'second' },
]) {
  const before = clients.length
  settings = { ...settings, ...change }
  await connection.openStream(request)
  assert.equal(clients.length, before + 1, 'key, endpoint and provider changes invalidate SDK')
}
const turnConnection = Object.freeze({ ...settings })
settings = { provider: 'next-turn', baseURL: 'https://next.invalid/v1', apiKey: 'next-key' }
await connection.openStream({ ...request, connection: turnConnection })
assert.deepEqual(connectionOptions(clients.at(-1)), { apiKey: turnConnection.apiKey, baseURL: turnConnection.baseURL },
  'an existing tool chain keeps its endpoint and credential together after settings change')
await connection.openStream(request)
assert.deepEqual(connectionOptions(clients.at(-1)), { apiKey: settings.apiKey, baseURL: settings.baseURL },
  'a new request without a turn snapshot sees the latest settings')
settings.apiKey = ''
assert.throws(() => connection.openStream(request), /尚未激活/, 'revocation cannot use cached credentials')
assert.throws(() => connection.openStream({ ...request, connection: turnConnection }), /尚未激活/,
  'revocation also prevents requests from an existing turn snapshot')
settings.apiKey = 'key-two'
controller.abort()
failure = Object.assign(new Error('cancelled'), { name: 'AbortError' })
await assert.rejects(connection.openStream(request), error => error === failure)
assert.equal(calls.at(-1).requestOptions.signal.aborted, true)
failure = Object.assign(new Error('upstream unavailable'), { status: 503 })
await assert.rejects(connection.openStream(request), error => error === failure,
  'SDK errors must reach Runtime retry policy unchanged')
const beforeInvalid = calls.length
await assert.rejects(connection.openStream({ ...request, protocol: 'unknown' }), /Unsupported/)
assert.equal(calls.length, beforeInvalid)
assert.deepEqual(Object.keys(transport), ['openStream'], 'SDK clients are private')
console.log('model transport boundary tests passed')

// Exercise the real SDK's serialization, SSE parser and internal retry path,
// using an in-memory fetch. No credentials, payloads or network are logged.
const sdkConnection = { provider: 'test', baseURL: 'https://timing.invalid/v1', apiKey: 'never-sent' }
const encoder = new TextEncoder()
const sseResponse = chunks => new Response(new ReadableStream({
  async start(controller) {
    for (const chunk of chunks) {
      if (typeof chunk === 'function') {
        await chunk()
      } else {
        controller.enqueue(encoder.encode(chunk))
      }
    }
    controller.close()
  },
}), { headers: { 'content-type': 'text/event-stream' } })

let tick = 0
const timings = []
const timedTransport = createModelTransport({
  now: () => tick,
  fetchImpl: async (_url, options) => {
    assert.equal(typeof options.body, 'string', 'dispatch follows SDK JSON serialization')
    assert.ok(!JSON.stringify(options.headers).includes('onTiming'), 'observer never enters HTTP metadata')
    tick = 18
    return sseResponse([
      ': heartbeat\n\n',
      async () => { tick = 25 },
      'data: {"type":"response.created"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
      'data: [DONE]\n\n',
    ])
  },
})
const timedConnection = createModelConnection({ readConfig: () => sdkConnection, transport: timedTransport })
const observedStream = await timedConnection.openStream({
  protocol: 'responses', params, onTiming: event => timings.push(event),
})
const observedEvents = []
for await (const event of observedStream) observedEvents.push(event)
assert.deepEqual(timings.map(event => event.event), ['dispatch', 'headers', 'first_event', 'end'])
assert.deepEqual(observedEvents.map(event => event.type), ['response.created', 'response.output_text.delta'])
assert.equal(timings[0].requestBytes, Buffer.byteLength(JSON.stringify(params)))
assert.equal(timings[0].attempt, 1)
assert.equal(timings[0].elapsedMs, 0)
assert.equal(timings[1].status, 200)
assert.equal(timings[2].elapsedMs, 25)
assert.equal(timings[2].attemptElapsedMs, 25)
assert.equal(timings.at(-1).completed, true)
assert.equal(timings.at(-1).aborted, false)
assert.ok(!JSON.stringify(timings).includes('never-sent'))
assert.ok(!JSON.stringify(timings).includes('hello'))

let attempts = 0
const retryTimings = []
const retryTransport = createModelTransport({
  fetchImpl: async () => {
    attempts++
    if (attempts === 1) {
      return new Response('{"error":{"message":"retry"}}', {
        status: 503, headers: { 'retry-after-ms': '1', 'content-type': 'application/json' },
      })
    }
    return sseResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n'])
  },
})
for await (const _event of await retryTransport.openStream({
  connection: sdkConnection,
  protocol: 'chat-completions',
  params: { model: 'test', stream: true, messages: [] },
  onTiming: event => retryTimings.push(event),
})) {}
assert.equal(attempts, 2, 'instrumentation must retain SDK retry behavior')
assert.deepEqual(retryTimings.filter(event => event.event === 'dispatch').map(event => event.attempt), [1, 2])
assert.deepEqual(retryTimings.filter(event => event.event === 'headers').map(event => event.status), [503, 200])
assert.equal(retryTimings.find(event => event.event === 'first_event').attempt, 2)
assert.ok(retryTimings.every((event, index) => !index || event.elapsedMs >= retryTimings[index - 1].elapsedMs),
  'one monotonic clock covers SDK backoff and retry attempts')

const concurrentTimings = { one: [], two: [] }
const concurrentTransport = createModelTransport({
  fetchImpl: async (_url, options) => {
    const model = JSON.parse(options.body).model
    await new Promise(resolve => setTimeout(resolve, model === 'one' ? 5 : 1))
    return sseResponse([`data: {"type":"response.output_text.delta","delta":"${model}"}\n\n`, 'data: [DONE]\n\n'])
  },
})
await Promise.all(Object.keys(concurrentTimings).map(async model => {
  const received = []
  for await (const event of await concurrentTransport.openStream({
    connection: sdkConnection, protocol: 'responses', params: { ...params, model },
    onTiming: event => concurrentTimings[model].push(event),
  })) received.push(event.delta)
  assert.deepEqual(received, [model])
}))
for (const events of Object.values(concurrentTimings)) {
  assert.deepEqual(events.map(event => event.event), ['dispatch', 'headers', 'first_event', 'end'])
  assert.ok(events.every(event => event.attempt === 1), 'concurrent requests keep distinct attempt counters')
}

for (const onTiming of [() => { throw Error('observer failed') }, async () => { throw Error('async observer failed') }]) {
  const received = []
  for await (const event of await concurrentTransport.openStream({
    connection: sdkConnection, protocol: 'responses', params: { ...params, model: 'one' }, onTiming,
  })) received.push(event)
  assert.equal(received.length, 1, 'observer failure cannot change model output')
}

const streamFailure = new Error('stream failure')
const failureTimings = []
const failingTransport = createModelTransport({
  createClient: () => ({
    responses: {
      create: async () => ({
        async *[Symbol.asyncIterator]() { yield { type: 'first' }; throw streamFailure },
      }),
    },
  }),
})
await assert.rejects(async () => {
  for await (const _event of await failingTransport.openStream({
    connection: sdkConnection, protocol: 'responses', params, onTiming: event => failureTimings.push(event),
  })) {}
}, error => error === streamFailure, 'iteration failures preserve error identity')
assert.deepEqual(failureTimings.map(event => event.event), ['first_event', 'error', 'end'])
assert.equal(failureTimings.at(-1).completed, false)
console.log('model transport timing tests passed')
