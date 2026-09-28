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
assert.deepEqual(clients, [{ apiKey: 'key-one', baseURL: 'https://first.invalid/v1' }])
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
settings.apiKey = ''
assert.throws(() => connection.openStream(request), /尚未激活/, 'revocation cannot use cached credentials')
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
