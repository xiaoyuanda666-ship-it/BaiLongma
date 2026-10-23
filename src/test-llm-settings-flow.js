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
let rejectedEndpoint = null

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

  if (url === rejectedEndpoint) {
    return responseJson({ error: { message: 'Selected API protocol is unavailable' } }, 404)
  }
  if (url.endsWith('/responses')) {
    return responseJson(responsePayload(requestBody?.model || 'unknown-model'))
  }
  if (url.endsWith('/chat/completions')) {
    return responseJson({
      id: 'chatcmpl_settings_test',
      object: 'chat.completion',
      model: requestBody?.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
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
  assert.equal(activatedDeepSeek.apiFormat, 'responses')
  assert.equal(mod.config.apiFormat, 'responses')
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

  // Gateway support is explicitly selected, validated, and scoped to its saved
  // endpoint/model pair. Legacy custom profiles remain on server defaults.
  const customFile = path.join(tempUserDir, 'llm', 'custom.json')
  assert.equal(mod.config.reasoningControl, 'omit')
  assert.equal(requests.at(-1).body.reasoning, undefined)
  const optedIn = await mod.saveLLMSettings({ reasoningControl: 'effort' })
  assert.equal(optedIn.reasoningControl, 'effort')
  assert.deepEqual(requests.at(-1).body.reasoning, { effort: 'none' })
  assert.equal(mod.getActivationStatus().reasoningControl, 'effort')
  assert.equal(mod.getProviderSummaries().custom.reasoningControl, 'effort')
  assert.equal(JSON.parse(fs.readFileSync(customFile, 'utf8')).reasoningControl, 'effort')
  const customReload = await import(`./config.js?custom-reasoning-reload=${Date.now()}`)
  assert.equal(customReload.config.reasoningControl, 'effort')
  assert.equal(mod.switchProviderConfig({ provider: 'minimax' }).provider, 'minimax')
  assert.equal(mod.config.reasoningControl, 'omit')
  assert.equal(mod.switchProviderConfig({ provider: 'custom' }).reasoningControl, 'effort')
  await mod.saveLLMSettings({ provider: 'custom', apiKey: 'rotated-local-key' })
  assert.equal(mod.config.reasoningControl, 'effort', 'credential edits keep the selected capability')
  assert.deepEqual(requests.at(-1).body.reasoning, { effort: 'none' })

  // Unsupported opt-in and invalid values leave the prior saved profile intact.
  await mod.saveLLMSettings({ provider: 'custom', reasoningControl: 'omit' })
  const customBeforeFailure = fs.readFileSync(customFile, 'utf8')
  rejectedEndpoint = 'http://127.0.0.1:11434/v1/responses'
  await assert.rejects(mod.saveLLMSettings({ reasoningControl: 'effort' }), /connection failed/)
  assert.deepEqual(requests.at(-1).body.reasoning, { effort: 'none' })
  rejectedEndpoint = null
  assert.equal(mod.config.reasoningControl, 'omit')
  assert.equal(fs.readFileSync(customFile, 'utf8'), customBeforeFailure)
  const beforeInvalidCapability = requests.length
  for (const reasoningControl of [null, false, 'none', 'auto', '']) {
    await assert.rejects(mod.saveLLMSettings({ reasoningControl }), /Unsupported reasoning control/)
    await assert.rejects(mod.prepareActivation({ provider: 'custom', reasoningControl }), /Unsupported reasoning control/)
    assert.throws(() => mod.commitPreparedActivation({ provider: 'custom', reasoningControl }), /Unsupported reasoning control/)
  }
  assert.equal(requests.length, beforeInvalidCapability)

  await mod.saveLLMSettings({ reasoningControl: 'effort' })
  await mod.saveLLMSettings({ provider: 'custom', baseURL: 'http://127.0.0.1:11435/v1' })
  assert.equal(mod.config.reasoningControl, 'omit', 'endpoint changes do not inherit capability')
  assert.equal(requests.at(-1).body.reasoning, undefined)
  await mod.saveLLMSettings({ provider: 'custom', baseURL: 'http://127.0.0.1:11434/v1', reasoningControl: 'effort' })
  await mod.saveLLMSettings({ provider: 'custom', model: 'local-a' })
  assert.equal(mod.config.reasoningControl, 'omit', 'model changes do not inherit capability')
  assert.equal(requests.at(-1).body.reasoning, undefined)
  await mod.saveLLMSettings({ reasoningControl: 'effort' })
  assert.equal(mod.switchModel('local-b').reasoningControl, 'omit')
  await mod.saveLLMSettings({ reasoningControl: 'effort' })
  assert.equal(mod.switchProviderConfig({ provider: 'custom', model: 'local-a' }).reasoningControl, 'omit')
  await mod.saveLLMSettings({ provider: 'custom', model: 'local-b', reasoningControl: 'effort' })

  // A format-only update uses the current provider and its saved credentials.
  const customChat = await mod.saveLLMSettings({ apiFormat: 'chat-completions' })
  assert.equal(customChat.provider, 'custom')
  assert.equal(customChat.apiFormat, 'chat-completions')
  assert.equal(requests.at(-1).url, 'http://127.0.0.1:11434/v1/chat/completions')
  assert.equal(requests.at(-1).body.stream, false)
  assert(Array.isArray(requests.at(-1).body.messages))
  assert.equal(requests.at(-1).body.input, undefined)
  assert.equal(requests.at(-1).body.reasoning, undefined, 'Chat Completions never sends the Responses capability')
  assert.equal(mod.config.reasoningControl, 'effort', 'a saved Responses capability survives format changes')
  assert.equal(mod.getActivationStatus().apiFormat, 'chat-completions')
  assert.equal(mod.getProviderSummaries().custom.apiFormat, 'chat-completions')
  assert.equal(mod.switchModel('local-a').apiFormat, 'chat-completions')
  await mod.saveLLMSettings({ provider: 'custom', model: 'local-b' })
  assert.equal(requests.at(-1).url, 'http://127.0.0.1:11434/v1/chat/completions')
  assert.equal(JSON.parse(fs.readFileSync(path.join(tempUserDir, 'llm', 'custom.json'), 'utf8')).apiFormat, 'chat-completions')

  const deepSeekChat = await mod.saveLLMSettings({ provider: 'deepseek', apiFormat: 'chat-completions' })
  assert.equal(deepSeekChat.apiFormat, 'chat-completions')
  assert.equal(deepSeekChat.model, 'deepseek-v5-preview')
  assert.equal(requests.at(-1).url, 'https://api.deepseek.com/chat/completions')
  assert.equal(requests.at(-1).authorization, 'Bearer sk-deepseek-flow-test-key')
  assert.equal(mod.switchModel('deepseek-v4-pro').apiFormat, 'chat-completions')
  assert.equal(mod.getProviderSummaries().deepseek.apiFormat, 'chat-completions')

  // Failed protocol validation leaves both active memory and every saved file intact.
  const activeFile = path.join(tempUserDir, 'config.json')
  const deepSeekFile = path.join(tempUserDir, 'llm', 'deepseek.json')
  const beforeActive = fs.readFileSync(activeFile, 'utf8')
  const beforeProvider = fs.readFileSync(deepSeekFile, 'utf8')
  const beforeRuntime = { ...mod.config }
  rejectedEndpoint = 'https://api.deepseek.com/responses'
  await assert.rejects(mod.saveLLMSettings({ apiFormat: 'responses' }), /validation failed/)
  rejectedEndpoint = null
  assert.deepEqual(mod.config, beforeRuntime)
  assert.equal(fs.readFileSync(activeFile, 'utf8'), beforeActive)
  assert.equal(fs.readFileSync(deepSeekFile, 'utf8'), beforeProvider)

  // Invalid explicit formats never issue a probe or mutate saved configuration.
  const requestsBeforeInvalid = requests.length
  for (const apiFormat of ['auto', 'chat', '', null, 42]) {
    await assert.rejects(mod.saveLLMSettings({ apiFormat }), /Unsupported LLM API format/)
    await assert.rejects(mod.prepareActivation({ provider: 'custom', apiFormat }), /Unsupported LLM API format/)
    assert.throws(() => mod.commitPreparedActivation({ provider: 'deepseek', apiFormat }), /Unsupported LLM API format/)
  }
  assert.equal(requests.length, requestsBeforeInvalid)
  assert.equal(fs.readFileSync(deepSeekFile, 'utf8'), beforeProvider)

  assert.equal(mod.switchProviderConfig({ provider: 'minimax' }).apiFormat, 'responses')
  assert.equal(mod.switchProviderConfig({ provider: 'deepseek' }).apiFormat, 'chat-completions')
  assert.equal(mod.config.apiFormat, 'chat-completions')
  const reloaded = await import(`./config.js?llm-settings-reload=${Date.now()}`)
  assert.equal(reloaded.config.provider, 'deepseek')
  assert.equal(reloaded.config.apiFormat, 'chat-completions')
  assert.equal(reloaded.getProviderSummaries().custom.apiFormat, 'chat-completions')
  assert.equal(reloaded.getProviderSummaries().minimax.apiFormat, 'responses')
  assert.equal(JSON.parse(fs.readFileSync(activeFile, 'utf8')).apiFormat, undefined)

  // Activation carries the validated format through preparation and commit.
  const prepared = await mod.prepareActivation({
    provider: 'minimax',
    apiKey: 'sk-minimax-flow-test-key',
    model: 'MiniMax-M2.7',
    apiFormat: 'chat-completions',
  })
  assert.equal(prepared.apiFormat, 'chat-completions')
  assert.equal(mod.config.provider, 'deepseek')
  assert.equal(mod.getProviderSummaries().minimax.apiFormat, 'responses')
  const committed = mod.commitPreparedActivation(prepared)
  assert.equal(committed.apiFormat, 'chat-completions')
  assert.equal(mod.getProviderSummaries().minimax.apiFormat, 'chat-completions')

  const responseRequests = requests.filter(request => request.url.endsWith('/responses'))
  assert(responseRequests.length >= 4, 'new provider credentials and custom model changes are validated before saving')
  console.log('LLM settings flow tests passed')
} finally {
  globalThis.fetch = originalFetch
  fs.rmSync(tempUserDir, { recursive: true, force: true })
}
