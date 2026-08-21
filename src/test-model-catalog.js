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
