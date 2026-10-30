import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { withProbeTimeout } from './model-probe.js'

// Exercise the real config + SDK path without real credentials or networking.
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-provider-detection-'))
process.env.BAILONGMA_USER_DIR = userDir
for (const key of ['DEEPSEEK_API_KEY', 'MINIMAX_API_KEY', 'OPENAI_API_KEY',
  'DASHSCOPE_API_KEY', 'MOONSHOT_API_KEY', 'ZHIPU_API_KEY', 'MIMO_API_KEY']) delete process.env[key]
const originalFetch = globalThis.fetch
const { prepareActivation, config } = await import('./config.js')
after(() => {
  globalThis.fetch = originalFetch
  fs.rmSync(userDir, { recursive: true, force: true })
})

const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
})
const success = () => response({ id: 'probe', output: [], choices: [{ message: { content: 'hello' } }] })
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const settle = () => new Promise(resolve => setImmediate(resolve))

test('probe deadline aborts the transport even if the client ignores cancellation', async () => {
  let requestSignal
  const gate = deferred()
  await assert.rejects(withProbeTimeout(signal => {
    requestSignal = signal
    return gate.promise
  }, 10, 'example'), /example timeout after 10ms/)
  assert.equal(requestSignal.aborted, true)
  gate.resolve('late response')
})

test('parent cancellation stops a running probe and never starts an already cancelled one', async () => {
  const controller = new AbortController()
  let requestSignal
  const gate = deferred()
  const pending = withProbeTimeout(signal => {
    requestSignal = signal
    return gate.promise
  }, 1000, 'example', controller.signal)
  await settle()
  controller.abort(new Error('superseded'))
  await assert.rejects(pending, /superseded/)
  assert.equal(requestSignal.aborted, true)
  gate.resolve()
  let calls = 0
  await assert.rejects(withProbeTimeout(() => { calls++ }, 1000, 'example', controller.signal), /superseded/)
  assert.equal(calls, 0)
})

test('a finished probe detaches its parent abort listener', async () => {
  const controller = new AbortController()
  let requestSignal
  assert.equal(await withProbeTimeout(signal => {
    requestSignal = signal
    return 'done'
  }, 1000, 'example', controller.signal), 'done')
  controller.abort(new Error('later'))
  assert.equal(requestSignal.aborted, false)
})

for (const apiFormat of ['responses', 'chat-completions']) {
  test(`auto-detection cancels losing ${apiFormat} probes without starting fallback requests`, { timeout: 3000 }, async () => {
    const started = deferred()
    const winner = deferred()
    const requests = []
    globalThis.fetch = async (url, options) => {
      const entry = { url: String(url), signal: options.signal }
      requests.push(entry)
      if (requests.length === 7) started.resolve()
      if (entry.url.includes('api.deepseek.com')) {
        await winner.promise
        return success()
      }
      return new Promise((_, reject) => {
        const abort = () => reject(new DOMException('Aborted', 'AbortError'))
        if (options.signal.aborted) abort()
        else options.signal.addEventListener('abort', abort, { once: true })
      })
    }
    const pending = prepareActivation({ provider: 'auto', apiKey: 'dummy-detection-key', apiFormat })
    await started.promise
    winner.resolve()
    const detected = await pending
    await settle()
    assert.equal(detected.provider, 'deepseek')
    assert.equal(detected.apiFormat, apiFormat)
    assert.equal(requests.length, 7, 'cancelled MiniMax/MiMo probes must not retry or try other models')
    assert(requests.filter(r => !r.url.includes('api.deepseek.com')).every(r => r.signal.aborted))
    assert(requests.every(r => r.url.endsWith(apiFormat === 'responses' ? '/responses' : '/chat/completions')))
    assert.equal(config.needsActivation, true, 'preparation does not write an active configuration')
  })
}

test('all rejected credentials fail deterministically without retries', { timeout: 3000 }, async () => {
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return response({ error: { message: 'invalid API key' } }, 401)
  }
  await assert.rejects(prepareActivation({ provider: 'auto', apiKey: 'dummy-invalid-key' }), error => {
    assert.match(error.message, /Could not identify the provider/)
    for (const provider of ['deepseek', 'minimax', 'openai', 'qwen', 'moonshot', 'zhipu', 'mimo']) {
      assert(error.message.includes(`${provider}:`))
    }
    return true
  })
  assert.equal(calls, 7)
})

for (const provider of ['deepseek', 'custom']) {
  test(`${provider} validation does not retry a failing server`, { timeout: 3000 }, async () => {
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      return response({ error: { message: 'service unavailable' } }, 500)
    }
    await assert.rejects(prepareActivation({
      provider, apiKey: 'dummy-probe-key', model: 'probe-model', baseURL: 'https://custom.invalid/v1',
    }), /service unavailable/)
    assert.equal(calls, 1)
  })
}

test('normal model fallback is retained when a probe has not been cancelled', async () => {
  const models = []
  globalThis.fetch = async (_url, options) => {
    models.push(JSON.parse(options.body).model)
    return models.length === 1
      ? response({ error: { message: 'model unavailable' } }, 404)
      : success()
  }
  const detected = await prepareActivation({ provider: 'mimo', apiKey: 'dummy-mimo-key', model: 'unavailable-model' })
  assert.equal(models.length, 2)
  assert.equal(models[0], 'unavailable-model')
  assert.equal(detected.model, models[1])
})
