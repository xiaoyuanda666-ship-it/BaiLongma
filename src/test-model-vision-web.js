import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { test, after } from 'node:test'

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-vision-web-'))
process.env.BAILONGMA_USER_DIR = userDir
process.env.BAILONGMA_RESOURCES_DIR = process.cwd()
delete process.env.DEEPSEEK_API_KEY
delete process.env.OPENAI_API_KEY
const { config } = await import('./config.js')
const { paths } = await import('./paths.js')
const { persistChatMediaBuffer, persistDroppedChatResources } = {
  ...await import('./chat-media.js'), ...await import('./chat-resources.js'),
}
const { prepareImageMessages, resolveModelImage, MAX_MODEL_IMAGE_BYTES } = await import('./llm-images.js')
const { supportsImageInput } = await import('./model-capabilities.js')
const { buildResponsesRequest, toResponsesInput } = await import('./llm-responses.js')
const { buildChatCompletionsRequest } = await import('./llm-chat-completions.js')
const { formatConversationMessage } = await import('./runtime/messages.js')
const { execAnalyzeImage } = await import('./capabilities/tools/api-capability.js')
const { execModelWeb, searchModelWeb, fetchModelWeb, modelWebTools } = await import('./providers/model-web.js')
const { capabilityToolsFor, findCapabilitiesByQuery } = await import('./capabilities/capability-registry.js')
const { classifyActionContract, actionContractToolSucceeded, collectVerifiedWebResearchSources } = await import('./runtime/action-contract.js')
const { getToolSchemas } = await import('./capabilities/schemas.js')
const { evaluateToolPolicy } = await import('./capabilities/tool-policy.js')
const { __internals, callLLM } = await import('./llm.js')

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC', 'base64')
const dataURL = `data:image/png;base64,${png.toString('base64')}`
const requests = []
const server = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString())
  requests.push({ url: req.url, body, authorization: req.headers.authorization })
  res.setHeader('Content-Type', 'application/json')
  if (req.url.endsWith('/tools/search')) {
    if (body.query === 'error') {
      res.writeHead(401)
      res.end(JSON.stringify({ error: { message: 'bad key test-secret-key' } }))
    } else res.end(JSON.stringify({ results: body.query === 'empty' ? [] : [{
      title: 'Original article', url: 'https://example.com/article', summary: 'A sourced summary', date: '2026-10-26',
    }] }))
  } else if (req.url.endsWith('/tools/fetch')) {
    res.end(JSON.stringify({ title: 'Original article', content: '# Verified original\nActual article text.' }))
  } else if (body.tools?.[0]?.type === 'web_search') {
    res.end(JSON.stringify({ status: 'completed', output: [
      { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ url: 'https://example.com/article' }] } },
      { type: 'message', content: [{ type: 'output_text', text: 'A sourced answer.', annotations: [
        { type: 'url_citation', url: 'https://example.com/article', title: 'Original article' },
      ] }] },
    ] }))
  } else if (req.url.endsWith('/responses')) {
    res.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'A white pixel.' }] }] }))
  } else res.end(JSON.stringify({ choices: [{ message: { content: 'A white pixel.' }, finish_reason: 'stop' }] }))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const baseURL = `http://127.0.0.1:${server.address().port}`
const deepseek = { provider: 'deepseek', model: 'deepseek-flash', apiKey: 'test-secret-key', baseURL, apiFormat: 'chat-completions' }
after(async () => {
  await new Promise(resolve => server.close(resolve))
  fs.rmSync(userDir, { recursive: true, force: true })
})

test('uploaded and staged images reach both wire protocols without modifying stored history', () => {
  const media = persistChatMediaBuffer(png, { ext: '.png' })
  const [resource] = persistDroppedChatResources([{ name: 'screen.png', dataUrl: dataURL }])
  const staged = formatConversationMessage({ role: 'user', channel: 'RESOURCE', id: 1,
    resource_metadata: JSON.stringify([resource]) }, { pendingResources: [{ id: 1 }] })
  const messages = [{ role: 'system', content: 'Be accurate' }, staged,
    { role: 'assistant', content: `![previous](${media.url})` },
    { role: 'user', content: `Compare these images. ![image](${media.url})` }]
  const before = structuredClone(messages)
  const prepared = prepareImageMessages(messages, deepseek)
  assert.equal(prepared[1].content[1].image_url.url, dataURL)
  assert.equal(prepared[3].content[1].image_url.url, dataURL)
  assert.equal(typeof prepared[2].content, 'string')
  assert.deepEqual(messages, before)
  const chat = buildChatCompletionsRequest({ ...deepseek, messages: prepared })
  assert.equal(chat.messages[1].content[1].type, 'image_url')
  assert.equal(chat.messages[1]._image_refs, undefined)
  const responses = buildResponsesRequest({ ...deepseek, messages: prepared })
  assert.equal(responses.input[1].content[1].type, 'input_image')
  assert.equal(responses.input[1].content[1].image_url, dataURL)
  const actualRequest = __internals.buildLLMRequestParams({ messages, modelSettings: { ...deepseek, apiFormat: 'responses' } })
  assert.equal(actualRequest.input[3].content[1].image_url, dataURL)
  const replay = { type: 'function_call_output', call_id: 'call-1', output: 'result' }
  assert.deepEqual(toResponsesInput([replay])[0], replay)
  assert.equal(prepareImageMessages(messages, { ...deepseek, model: 'deepseek-v4-pro' }), messages)
  assert.equal(supportsImageInput({ model: 'o3-mini' }), false)
})

test('image validation rejects arbitrary auto-read paths, traversal, invalid bytes and oversized files', () => {
  const local = path.join(userDir, 'private.png')
  fs.writeFileSync(local, png)
  assert.throws(() => resolveModelImage(local), /analyze_image/)
  assert.equal(resolveModelImage(local, { allowLocalFiles: true }).url, dataURL)
  config.security.fileSandbox = true
  try {
    assert.throws(() => resolveModelImage(local, { allowLocalFiles: true }), /sandbox/)
    const uploaded = persistChatMediaBuffer(png, { ext: '.png' })
    assert.equal(resolveModelImage(uploaded.url).url, dataURL, 'chat uploads remain readable in sandbox mode')
  } finally { config.security.fileSandbox = false }
  assert.throws(() => resolveModelImage('/media/chat/%2e%2e%2fprivate.png'), /无效/)
  assert.throws(() => resolveModelImage('data:image/png;base64,YmFk'), /图片格式/)
  const huge = path.join(userDir, 'huge.png')
  fs.closeSync(fs.openSync(huge, 'w'))
  fs.truncateSync(huge, MAX_MODEL_IMAGE_BYTES + 1)
  assert.throws(() => resolveModelImage(huge, { allowLocalFiles: true }), /20MB/)
  const messages = Array.from({ length: 9 }, (_, n) => ({ role: 'user', content: `Image ${n} ![](${dataURL})` }))
  const prepared = prepareImageMessages(messages, deepseek)
  assert.equal(prepared.flatMap(item => item.content).filter(part => part.type === 'image_url').length, 8)
  assert.match(prepared[0].content[1].text, /未传入/)
})

test('DeepSeek Pro analyzes an uploaded image with the same key and Flash in either protocol', async () => {
  Object.assign(config, deepseek, { model: 'deepseek-v4-pro' })
  for (const apiFormat of ['chat-completions', 'responses']) {
    config.apiFormat = apiFormat
    const result = JSON.parse(await execAnalyzeImage({ image_url: dataURL, prompt: 'Describe the pixel' }))
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.model, 'deepseek-flash')
    assert.equal(result.result, 'A white pixel.')
    assert.equal(config.model, 'deepseek-v4-pro')
    assert.equal(requests.at(-1).authorization, 'Bearer test-secret-key')
    assert.equal(requests.at(-1).body.model, 'deepseek-flash')
    assert.equal(JSON.stringify(result).includes(config.apiKey), false)
  }
  const missingSlot = JSON.parse(await execAnalyzeImage({ image_url: dataURL, slot_id: 'vision.missing' }))
  assert.equal(missingSlot.ok, false, 'explicit missing slot must not silently use another provider')
})

test('DeepSeek search/fetch use official routes and only fetched content satisfies source verification', async () => {
  Object.assign(config, deepseek)
  const result = JSON.parse(await execModelWeb('model_web_search', { query: '最新资料', count: 3 }))
  assert.equal(result.ok, true)
  assert.equal(result.sources[0].url, 'https://example.com/article')
  assert.equal(requests.at(-1).url, '/v1/tools/search')
  assert.deepEqual(requests.at(-1).body, { query: '最新资料', count: 3, need_content: false })
  await searchModelWeb({ ...deepseek, baseURL: `${baseURL}/v1` }, { query: 'empty' })
  assert.equal(requests.at(-1).url, '/v1/tools/search')
  assert.equal((await searchModelWeb(deepseek, { query: 'empty' })).results.length, 0)
  const page = await fetchModelWeb(deepseek, { url: result.sources[0].url }, {
    hostnameResolver: async () => [{ address: '93.184.216.34' }],
  })
  const evidence = [{ name: 'model_web_search', result: JSON.stringify(result) }]
  assert.deepEqual(collectVerifiedWebResearchSources(evidence), [])
  evidence.push({ name: 'model_web_fetch', result: JSON.stringify({ ok: true, ...page }) })
  assert.equal(collectVerifiedWebResearchSources(evidence)[0].url, page.url)
  assert.equal(actionContractToolSucceeded(classifyActionContract('帮我联网搜索资料'), 'model_web_search', JSON.stringify(result)), true)
  const failed = JSON.parse(await execModelWeb('model_web_search', { query: 'error' }))
  assert.equal(failed.ok, false)
  assert.match(failed.error, /401/)
  assert.equal(JSON.stringify(failed).includes(config.apiKey), false)
  await assert.rejects(() => searchModelWeb(deepseek, { query: 'x'.repeat(129) }), /128/)
  await assert.rejects(() => fetchModelWeb(deepseek, { url: 'http://127.0.0.1/private' }), /Private/)
  await assert.rejects(() => fetchModelWeb(deepseek, { url: 'https://user:password@example.com' }), /credentials/)
})

test('OpenAI search requires a completed search call and retains citation URLs', async () => {
  Object.assign(config, deepseek, { provider: 'openai', model: 'gpt-5.5', baseURL: `${baseURL}/v1` })
  const result = JSON.parse(await execModelWeb('model_web_search', { query: 'current research' }))
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(result.sources, [{ url: 'https://example.com/article', title: 'Original article' }])
  assert.equal(requests.at(-1).body.tool_choice, 'required')
  assert.equal(requests.at(-1).body.tools[0].type, 'web_search')
  assert.equal(requests.at(-1).body.store, false)
  await assert.rejects(() => searchModelWeb(config, { query: 'research' }, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'completed', output: [] }) }),
  }), /未完成实际联网搜索/)
})

test('agent research loop searches, fetches and delivers a verified source without browser navigation', async () => {
  Object.assign(config, deepseek, { model: 'deepseek-v4-pro', apiFormat: 'responses' })
  const executions = []
  let rounds = 0
  const result = await callLLM({
    systemPrompt: 'Search and verify one original source, then answer with a link.',
    message: '帮我联网搜索资料，并核验一个来源。',
    tools: ['model_web_search', 'model_web_fetch'], mustReply: true, localReply: true,
    toolContext: { currentTargetId: 'ID:test', actionContract: {
      id: 'web_research', label: '联网检索并核验原文来源', minimumVerifiedSources: 1,
      requiredTools: ['model_web_search', 'model_web_fetch', 'browser_navigate'],
    } },
    _streamOnceForTest: async ({ messages, toolSchemas }) => {
      rounds++
      assert.ok(toolSchemas.some(schema => schema.function.name === 'model_web_search'))
      if (rounds === 3) {
        assert.ok(messages.some(item => item.type === 'function_call_output' && item.output.includes('Verified original')))
        return { content: '已核验：[Original article](https://example.com/article)', toolCalls: [], aborted: false }
      }
      assert.ok(rounds < 3, 'native evidence must not cause an extra browser-required round')
      const name = rounds === 1 ? 'model_web_search' : 'model_web_fetch'
      const args = rounds === 1 ? { query: 'research' } : { url: 'https://example.com/article' }
      const id = `call_${rounds}`
      return { content: '', aborted: false, toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
        outputItems: [{ type: 'function_call', call_id: id, id: `fc_${rounds}`, name, arguments: JSON.stringify(args) }] }
    },
    _executeToolForTest: async (name, args, context) => {
      executions.push(name)
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true })
      return execModelWeb(name, args, { ...context, hostnameResolver: async () => [{ address: '93.184.216.34' }] })
    },
  })
  assert.equal(result.delivered, true)
  assert.equal(rounds, 3)
  assert.deepEqual(executions, ['model_web_search', 'model_web_fetch', 'send_message'])
})

test('native tools are discoverable, gated by configuration, cancellable and respect blocked tools', async () => {
  Object.assign(config, deepseek)
  const ctx = { text: '搜索最新资料', rawText: '搜索最新资料', isTick: false }
  const tools = capabilityToolsFor(ctx)
  assert.ok(tools.includes('model_web_search'))
  assert.ok(tools.includes('model_web_fetch'))
  assert.equal(getToolSchemas(modelWebTools()).length, 2)
  assert.ok(findCapabilitiesByQuery('model_web_search').some(item => item.tools.includes('model_web_search')))
  config.security.blockedTools = ['model_web_search']
  assert.equal(evaluateToolPolicy('model_web_search', {}).allowed, false)
  config.security.blockedTools = []
  const controller = new AbortController()
  controller.abort()
  const count = requests.length
  await assert.rejects(() => execModelWeb('model_web_search', { query: 'test' }, { signal: controller.signal }), { name: 'AbortError' })
  assert.equal(requests.length, count)
  Object.assign(config, { provider: 'custom', apiKey: null, baseURL: null })
  assert.deepEqual(modelWebTools(), [])
  assert.equal(JSON.parse(await execModelWeb('model_web_search', { query: 'test' })).error, 'not_configured')
  assert.ok(capabilityToolsFor(ctx).includes('browser_navigate'))
})
