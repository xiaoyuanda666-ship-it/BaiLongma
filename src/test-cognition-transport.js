// Exercise the real SDK, request builders, SSE parsing and checkpoint retry.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-cognition-transport-'))
process.env.BAILONGMA_USER_DIR = userDir
process.env.BAILONGMA_RESOURCES_DIR = process.cwd()
for (const key of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY']) delete process.env[key]
const checkpoint = { response: { mode: 'direct', reason: 'Ready to answer', text: '' },
  summary: 'Report the literal [CLEAR_TASK] marker', expected: 'User sees the result',
  observation: 'No tool needed', decision: 'finish' }
let format, requests
const server = http.createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  requests.push(JSON.parse(body))
  const first = requests.length === 1
  const text = requests.length === 2 ? JSON.stringify(checkpoint) : 'Verified answer.'
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const emit = event => res.write(`data: ${JSON.stringify(event)}\n\n`)
  if (format === 'responses') {
    const output = first ? [{ type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'PRIVATE_SENTINEL' }] }]
      : [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }]
    emit({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output } })
    res.end()
  } else {
    emit({ choices: [{ index: 0, delta: first ? { reasoning_content: 'PRIVATE_SENTINEL' } : { content: text }, finish_reason: null }] })
    emit({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    res.end('data: [DONE]\n\n')
  }
})
let closeDBForTest
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { config } = await import('./config.js')
  const { callLLM, __internals } = await import('./llm.js')
  ;({ closeDBForTest } = await import('./db.js'))
  for (format of ['responses', 'chat-completions']) {
    Object.assign(config, { provider: 'deepseek', apiFormat: format, model: 'deepseek-flash',
      apiKey: 'test-only', baseURL: `http://127.0.0.1:${server.address().port}/v1`, needsActivation: false })
    requests = []
    const events = [], streams = []
    const result = await callLLM({ systemPrompt: 'Answer briefly.', message: 'Report the result.',
      tools: ['read_file'], thinking: false, mustReply: true, localReply: true,
      toolContext: { currentTargetId: 'ID:test' }, onCognition: e => events.push(e), onStream: e => streams.push(e),
      _executeToolForTest: async name => { assert.equal(name, 'send_message'); return '{"ok":true,"delivered":true}' },
    })
    assert.equal(result.delivered, true)
    assert.equal(requests.length, 3)
    assert.deepEqual(events.map(e => e.phase), ['planning', 'plan'])
    assert.equal(events[1].summary, checkpoint.summary, 'JSON bypasses prose marker stripping')
    assert(!JSON.stringify(streams).includes('PRIVATE_SENTINEL'))
    assert(!JSON.stringify(requests).includes('PRIVATE_SENTINEL'))
    for (const body of requests.slice(0, 2)) {
      if (format === 'responses') {
        assert.deepEqual(body.reasoning, { effort: 'none' })
        assert.deepEqual(body.text, { format: { type: 'json_object' } })
      } else {
        assert.deepEqual(body.thinking, { type: 'disabled' })
        assert.deepEqual(body.response_format, { type: 'json_object' })
      }
    }
    assert.equal(requests[2].text, undefined)
    assert.equal(requests[2].response_format, undefined)
    const custom = __internals.buildLLMRequestParams({ messages: [], jsonOutput: true, thinking: false,
      modelSettings: { provider: 'custom', apiFormat: format, model: 'test', reasoningControl: 'omit' } })
    assert.equal(custom.text, undefined)
    assert.equal(custom.response_format, undefined)
  }
  console.log('PASS cognition SDK transport: both protocols disable thinking, request JSON, recover empty output, preserve JSON and isolate execution')
} finally {
  closeDBForTest?.()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  fs.rmSync(userDir, { recursive: true, force: true })
}
