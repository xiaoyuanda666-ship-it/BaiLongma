import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildModelCatalogURL,
  clearModelCatalogCache,
  fetchModelCatalog,
  mergeModelCatalog,
  normalizeModelCatalog,
  resolveModelCatalog,
} from './model-catalog.js'

test('buildModelCatalogURL preserves provider API prefixes', () => {
  assert.equal(buildModelCatalogURL('https://api.example.com/v1'), 'https://api.example.com/v1/models')
  assert.equal(buildModelCatalogURL('https://api.deepseek.com'), 'https://api.deepseek.com/models')
  assert.throws(() => buildModelCatalogURL('file:///tmp/api'), /http or https/)
})

test('normalizeModelCatalog accepts common response shapes and de-duplicates IDs', () => {
  const models = normalizeModelCatalog({
    data: [{ id: 'model-10' }, { id: 'model-2' }, { id: 'model-2' }, { name: 'model-1' }, {}],
  })
  assert.deepEqual(models.map(item => item.id), ['model-1', 'model-2', 'model-10'])
  assert(models.every(item => item.dynamic === true))

  const qwenModels = normalizeModelCatalog({
    output: { models: [{ model: 'qwen-future', name: 'Qwen Future' }] },
  })
  assert.deepEqual(qwenModels[0], {
    id: 'qwen-future',
    label: 'Qwen Future',
    deprecated: false,
    dynamic: true,
  })

  const authorizedQwenModels = normalizeModelCatalog({
    output: { permissions: [{ model: 'qwen-authorized', name: 'Qwen Authorized' }] },
  })
  assert.equal(authorizedQwenModels[0].id, 'qwen-authorized')
})

test('mergeModelCatalog keeps bundled metadata and the selected model', () => {
  const merged = mergeModelCatalog(
    [{ id: 'new-model', label: 'new-model', deprecated: false, dynamic: true }],
    [{ id: 'old-model', label: 'Old model label', deprecated: true }],
    'old-model',
  )
  assert.equal(merged[0].id, 'old-model')
  assert.equal(merged[0].label, 'Old model label')
  assert.equal(merged[1].id, 'new-model')
})

test('fetchModelCatalog sends bearer auth without exposing it in the URL', async () => {
  let request
  const models = await fetchModelCatalog({
    baseURL: 'https://api.example.com/v1',
    apiKey: 'secret-key',
    fetchImpl: async (url, options) => {
      request = { url, options }
      return { ok: true, json: async () => ({ data: [{ id: 'chat-model' }] }) }
    },
  })
  assert.equal(request.url, 'https://api.example.com/v1/models')
  assert.equal(request.options.headers.Authorization, 'Bearer secret-key')
  assert(!request.url.includes('secret-key'))
  assert.equal(models[0].id, 'chat-model')
})

test('fetchModelCatalog supports provider-specific model catalog URLs', async () => {
  let requestedURL = ''
  await fetchModelCatalog({
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    modelsURL: 'https://dashscope.aliyuncs.com/api/v1/models/permissions?name=qwen',
    apiKey: 'qwen-key',
    fetchImpl: async url => {
      requestedURL = url
      return { ok: true, json: async () => ({ output: { permissions: [{ model: 'qwen-new' }] } }) }
    },
  })
  assert.equal(
    requestedURL,
    'https://dashscope.aliyuncs.com/api/v1/models/permissions?name=qwen',
  )
})

test('fetchModelCatalog supports provider-specific auth headers', async () => {
  let headers
  await fetchModelCatalog({
    baseURL: 'https://api.xiaomimimo.com/v1',
    apiKey: 'mimo-key',
    authType: 'api-key',
    fetchImpl: async (_url, options) => {
      headers = options.headers
      return { ok: true, json: async () => ({ data: [{ id: 'mimo-v2.5-pro' }] }) }
    },
  })
  assert.equal(headers['api-key'], 'mimo-key')
  assert.equal(headers.Authorization, undefined)
})

test('fetchModelCatalog falls back between regional catalog URLs', async () => {
  const requestedURLs = []
  const models = await fetchModelCatalog({
    modelsURL: [
      'https://api.minimaxi.com/v1/models',
      'https://api.minimax.io/v1/models',
    ],
    apiKey: 'global-minimax-key',
    fetchImpl: async url => {
      requestedURLs.push(url)
      if (url.includes('minimaxi.com')) {
        return { ok: false, status: 401, text: async () => 'invalid regional key' }
      }
      return { ok: true, json: async () => ({ data: [{ id: 'MiniMax-M2.7' }] }) }
    },
  })
  assert.deepEqual(requestedURLs, [
    'https://api.minimaxi.com/v1/models',
    'https://api.minimax.io/v1/models',
  ])
  assert.equal(models[0].id, 'MiniMax-M2.7')
})

test('fetchModelCatalog can exclude known non-chat modalities without a text-model allowlist', async () => {
  const models = await fetchModelCatalog({
    baseURL: 'https://api.xiaomimimo.com/v1',
    apiKey: 'mimo-key',
    modelFilter: model => !/(?:^|[-_.])(?:asr|tts)(?:[-_.]|$)/i.test(model.id),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: 'mimo-v2.5-pro' },
          { id: 'mimo-v2.5' },
          { id: 'mimo-v2.5-asr' },
          { id: 'mimo-v2.5-tts' },
          { id: 'mimo-v2.5-tts-voiceclone' },
          { id: 'mimo-v3-future' },
        ],
      }),
    }),
  })
  assert.deepEqual(models.map(model => model.id), [
    'mimo-v2.5',
    'mimo-v2.5-pro',
    'mimo-v3-future',
  ])
})

test('resolveModelCatalog caches successful lookups and falls back safely', async () => {
  clearModelCatalogCache()
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return { ok: true, json: async () => ({ data: [{ id: 'remote-model' }] }) }
  }
  const args = {
    provider: 'example',
    baseURL: 'https://api.example.com/v1',
    apiKey: 'key-a',
    fallbackModels: [{ id: 'fallback-model', label: 'Fallback', deprecated: false }],
    currentModel: 'remote-model',
    fetchImpl,
    now: () => 1_000,
  }
  const first = await resolveModelCatalog(args)
  const second = await resolveModelCatalog(args)
  assert.equal(first.source, 'dynamic')
  assert.equal(second.source, 'cache')
  assert.equal(calls, 1)

  clearModelCatalogCache()
  const fallback = await resolveModelCatalog({
    ...args,
    currentModel: 'custom-selected-model',
    fetchImpl: async () => { throw new Error('offline') },
  })
  assert.equal(fallback.source, 'fallback')
  assert.deepEqual(fallback.models.map(item => item.id), ['custom-selected-model', 'fallback-model'])
  assert.match(fallback.warning, /offline/)
})

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

const catalogResponse = ids => ({ ok: true, json: async () => ({ data: ids.map(id => ({ id })) }) })

test('concurrent catalog readers and refreshes share a request but keep their own selected model and filter', async () => {
  clearModelCatalogCache()
  const gate = deferred()
  let calls = 0
  const args = {
    provider: 'example', baseURL: 'https://example.invalid/v1', apiKey: 'key-a',
    fetchImpl: async () => { calls++; return gate.promise },
  }
  const first = resolveModelCatalog({ ...args, currentModel: 'selected-a', modelFilter: m => m.id !== 'tts' })
  const second = resolveModelCatalog({ ...args, currentModel: 'selected-b', forceRefresh: true })
  assert.equal(calls, 1)
  gate.resolve(catalogResponse(['chat', 'tts']))
  const [a, b] = await Promise.all([first, second])
  assert.deepEqual(a.models.map(m => m.id), ['selected-a', 'chat'])
  assert.deepEqual(b.models.map(m => m.id), ['selected-b', 'chat', 'tts'])
  const cached = await resolveModelCatalog({ ...args, modelFilter: m => m.id === 'tts' })
  assert.equal(cached.source, 'cache')
  assert.deepEqual(cached.models.map(m => m.id), ['tts'])
  assert.equal(calls, 1)
})

test('catalog requests are isolated by credential, endpoint and auth type', async () => {
  clearModelCatalogCache()
  const gate = deferred()
  let calls = 0
  const args = {
    provider: 'example', baseURL: 'https://example.invalid/v1', apiKey: 'key-a',
    fetchImpl: async () => { calls++; return gate.promise },
  }
  const pending = [
    resolveModelCatalog(args),
    resolveModelCatalog({ ...args, apiKey: 'key-b' }),
    resolveModelCatalog({ ...args, authType: 'api-key' }),
    resolveModelCatalog({ ...args, baseURL: 'https://other.invalid/v1' }),
  ]
  assert.equal(calls, 4)
  gate.resolve(catalogResponse(['chat']))
  await Promise.all(pending)
})

test('a shared failure preserves each reader fallback and allows a subsequent retry', async () => {
  clearModelCatalogCache()
  const gate = deferred()
  let calls = 0
  const args = {
    provider: 'example', baseURL: 'https://example.invalid/v1',
    fetchImpl: async () => { calls++; await gate.promise; throw new Error('offline') },
  }
  const pending = ['a', 'b'].map(id => resolveModelCatalog({
    ...args, currentModel: id, fallbackModels: [{ id: `bundled-${id}` }],
  }))
  gate.resolve()
  const results = await Promise.all(pending)
  assert.equal(calls, 1)
  results.forEach((result, index) => {
    const id = ['a', 'b'][index]
    assert.equal(result.source, 'fallback')
    assert.deepEqual(result.models.map(m => m.id), [id, `bundled-${id}`])
  })
  const retry = await resolveModelCatalog({ ...args, fetchImpl: async () => catalogResponse(['recovered']) })
  assert.equal(retry.source, 'dynamic')
  assert.equal(retry.models[0].id, 'recovered')
})

test('cache age starts when a lookup finishes and failed refreshes preserve the previous catalog', async () => {
  clearModelCatalogCache()
  let time = 1000
  let calls = 0
  const args = {
    provider: 'example', baseURL: 'https://example.invalid/v1', now: () => time, cacheTtlMs: 100,
    fetchImpl: async () => { calls++; time = 2000; return catalogResponse(['chat']) },
  }
  const first = await resolveModelCatalog(args)
  assert.equal(first.fetchedAt, new Date(2000).toISOString())
  time = 2050
  assert.equal((await resolveModelCatalog(args)).source, 'cache')
  assert.equal(calls, 1)
  time = 2200
  const stale = await resolveModelCatalog({ ...args, fetchImpl: async () => { throw new Error('offline') } })
  assert.equal(stale.source, 'stale-cache')
  assert.equal(stale.fetchedAt, first.fetchedAt)
  assert.equal(stale.models[0].id, 'chat')
})

test('clearing the cache during a lookup prevents a late result from replacing new data', async () => {
  clearModelCatalogCache()
  const oldGate = deferred()
  const newGate = deferred()
  const args = { provider: 'example', baseURL: 'https://example.invalid/v1' }
  const old = resolveModelCatalog({ ...args, fetchImpl: () => oldGate.promise })
  clearModelCatalogCache()
  const fresh = resolveModelCatalog({ ...args, fetchImpl: () => newGate.promise })
  oldGate.resolve(catalogResponse(['old']))
  await old
  const joined = resolveModelCatalog({ ...args, fetchImpl: () => { throw new Error('must join fresh request') } })
  newGate.resolve(catalogResponse(['fresh']))
  assert.equal((await fresh).models[0].id, 'fresh')
  assert.equal((await joined).source, 'dynamic')
  const cached = await resolveModelCatalog(args)
  assert.equal(cached.source, 'cache')
  assert.equal(cached.models[0].id, 'fresh')
})

test('an empty filtered view uses bundled fallback without poisoning the shared catalog', async () => {
  clearModelCatalogCache()
  const args = {
    provider: 'example', baseURL: 'https://example.invalid/v1',
    fetchImpl: async () => catalogResponse(['tts']),
  }
  const filtered = await resolveModelCatalog({ ...args, modelFilter: () => false, fallbackModels: [{ id: 'chat' }] })
  assert.equal(filtered.source, 'fallback')
  assert.equal(filtered.models[0].id, 'chat')
  assert.equal((await resolveModelCatalog(args)).models[0].id, 'tts')
})
