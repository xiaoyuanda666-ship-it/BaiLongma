import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tempUserDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-llm-settings-flow-'))
process.env.BAILONGMA_USER_DIR = tempUserDir

for (const key of [
  'DEEPSEEK_API_KEY',
  'MINIMAX_API_KEY',
  'OPENAI_API_KEY',
  'DASHSCOPE_API_KEY',
  'MOONSHOT_API_KEY',
  'ZHIPU_API_KEY',
  'MIMO_API_KEY',
]) delete process.env[key]

const originalFetch = globalThis.fetch
const requests = []

function responseJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function responsePayload(model) {
  return {
    id: `resp_${model}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model,
    output: [],
    usage: {
      input_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 2,
    },
  }
}

globalThis.fetch = async (input, init = {}) => {
  const url = String(typeof input === 'string' || input instanceof URL ? input : input?.url)
  const headers = new Headers(init?.headers || (typeof input === 'object' ? input?.headers : undefined))
  const method = String(init?.method || (typeof input === 'object' ? input?.method : '') || 'GET').toUpperCase()
  let requestBody = null
  try {
    const rawBody = init?.body || (typeof input === 'object' ? await input.clone?.().text?.() : '')
    requestBody = rawBody ? JSON.parse(String(rawBody)) : null
  } catch {}
  requests.push({
    url,
    method,
    authorization: headers.get('authorization') || '',
    apiKeyHeader: headers.get('api-key') || '',
    body: requestBody,
  })

  if (url.endsWith('/responses')) {
    return responseJson(responsePayload(requestBody?.model || 'unknown-model'))
  }
  if (url === 'https://api.deepseek.com/models') {
    return responseJson({ data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v5-preview' }] })
  }
  if (url === 'https://api.minimaxi.com/v1/models') {
    return responseJson({ data: [{ id: 'MiniMax-M2.7' }, { id: 'MiniMax-M3' }] })
  }
  if (url === 'https://api.xiaomimimo.com/v1/models') {
    return responseJson({
      data: [
        { id: 'mimo-v2.5-pro' },
        { id: 'mimo-v3-preview' },
        { id: 'mimo-v2.5-asr' },
        { id: 'mimo-v2.5-tts' },
      ],
    })
  }
  if (url.startsWith('https://dashscope.aliyuncs.com/api/v1/models/permissions?')) {
    return responseJson({
      output: {
        permissions: [
          { model: 'qwen3.8-max', name: 'Qwen 3.8 Max' },
          { model: 'qwen-future-text', name: 'Qwen Future Text' },
        ],
      },
    })
  }
  if (url === 'http://127.0.0.1:11434/v1/models') {
    return responseJson({ data: [{ id: 'local-a' }, { id: 'local-b' }] })
  }
  return responseJson({ error: { message: `Unexpected test URL: ${url}` } }, 404)
}

try {
  const mod = await import(`./config.js?llm-settings-flow=${Date.now()}`)

  const activatedDeepSeek = await mod.saveLLMSettings({
    provider: 'deepseek',
    apiKey: 'sk-deepseek-flow-test-key',
    model: 'deepseek-v4-pro',
  })
  assert.equal(activatedDeepSeek.provider, 'deepseek')
  assert.equal(activatedDeepSeek.model, 'deepseek-v4-pro')
  assert.equal(mod.config.needsActivation, false)
  assert.equal(mod.config.apiKey, 'sk-deepseek-flow-test-key')
  assert.equal(JSON.parse(fs.readFileSync(path.join(tempUserDir, 'config.json'), 'utf8')).provider, 'deepseek')
  assert.equal(JSON.parse(fs.readFileSync(path.join(tempUserDir, 'llm', 'deepseek.json'), 'utf8')).model, 'deepseek-v4-pro')

  const deepSeekCatalog = await mod.getProviderModels({ provider: 'deepseek', forceRefresh: true })
  assert.equal(deepSeekCatalog.source, 'dynamic')
  assert(deepSeekCatalog.models.some(model => model.id === 'deepseek-v5-preview'))
  const deepSeekCatalogRequest = requests.find(request => request.url === 'https://api.deepseek.com/models')
  assert.equal(deepSeekCatalogRequest?.authorization, 'Bearer sk-deepseek-flow-test-key')

  const switchedDeepSeek = await mod.saveLLMSettings({
    provider: 'deepseek',
    model: 'deepseek-v5-preview',
  })
  assert.equal(switchedDeepSeek.model, 'deepseek-v5-preview')
  assert.equal(mod.config.apiKey, 'sk-deepseek-flow-test-key')
  assert.equal(JSON.parse(fs.readFileSync(path.join(tempUserDir, 'llm', 'deepseek.json'), 'utf8')).model, 'deepseek-v5-preview')

  await mod.saveLLMSettings({
    provider: 'minimax',
    apiKey: 'sk-minimax-flow-test-key',
    model: 'MiniMax-M2.7',
  })
  const minimaxCatalog = await mod.getProviderModels({ provider: 'minimax', forceRefresh: true })
  assert(minimaxCatalog.models.some(model => model.id === 'MiniMax-M3'))
  assert(requests.some(request => request.url === 'https://api.minimaxi.com/v1/models'))

  const restoredDeepSeek = await mod.saveLLMSettings({ provider: 'deepseek' })
  assert.equal(restoredDeepSeek.model, 'deepseek-v5-preview')
  assert.equal(mod.config.provider, 'deepseek')
  assert.equal(mod.config.apiKey, 'sk-deepseek-flow-test-key')

  const mimoCatalog = await mod.getProviderModels({
    provider: 'mimo',
    apiKey: 'sk-mimo-flow-test-key',
    forceRefresh: true,
  })
  assert.deepEqual(mimoCatalog.models.map(model => model.id), [
    'mimo-v2.5-pro',
    'mimo-v3-preview',
  ])
  assert.equal(
    requests.find(request => request.url === 'https://api.xiaomimimo.com/v1/models')?.apiKeyHeader,
    'sk-mimo-flow-test-key',
  )

  const qwenWithoutKey = await mod.getProviderModels({ provider: 'qwen' })
  assert.equal(qwenWithoutKey.source, 'requires-key')
  assert.equal(qwenWithoutKey.warning, '')

  const qwenCatalog = await mod.getProviderModels({
    provider: 'qwen',
    apiKey: 'sk-qwen-flow-test-key',
    forceRefresh: true,
  })
  assert.equal(qwenCatalog.source, 'dynamic')
  assert(qwenCatalog.models.some(model => model.id === 'qwen3.8-max'))
  assert(qwenCatalog.models.some(model => model.id === 'qwen-future-text'))
  assert(qwenCatalog.models.some(model => model.id === 'qwen-turbo' && model.current === true))

  const zhipuCatalog = await mod.getProviderModels({
    provider: 'zhipu',
    apiKey: 'sk-zhipu-flow-test-key',
    forceRefresh: true,
  })
  assert.equal(zhipuCatalog.source, 'unsupported')
  assert(zhipuCatalog.models.some(model => model.id === 'glm-5.1'))
  assert.equal(
    requests.some(request => request.url === 'https://open.bigmodel.cn/api/paas/v4/models'),
    false,
  )
  assert.equal(mod.getProviderSummaries().zhipu.modelCatalogSupported, false)

  await mod.saveLLMSettings({
    provider: 'custom',
    apiKey: 'none',
    model: 'local-a',
    baseURL: 'http://127.0.0.1:11434/v1',
  })
  const customCatalog = await mod.getProviderModels({ provider: 'custom', forceRefresh: true })
  assert.deepEqual(customCatalog.models.map(model => model.id), ['local-a', 'local-b'])
  const switchedCustom = await mod.saveLLMSettings({ provider: 'custom', model: 'local-b' })
  assert.equal(switchedCustom.model, 'local-b')
  assert.equal(mod.config.baseURL, 'http://127.0.0.1:11434/v1')
  assert.equal(JSON.parse(fs.readFileSync(path.join(tempUserDir, 'llm', 'custom.json'), 'utf8')).model, 'local-b')

  const responseRequests = requests.filter(request => request.url.endsWith('/responses'))
  assert(responseRequests.length >= 4, 'new provider credentials and custom model changes are validated before saving')
  console.log('LLM settings flow tests passed')
} finally {
  globalThis.fetch = originalFetch
  fs.rmSync(tempUserDir, { recursive: true, force: true })
}
