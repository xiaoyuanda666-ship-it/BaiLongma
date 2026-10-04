// Real SDK + local SSE + production Agent loop. Only local tool execution is
// replaced; no provider credentials, billable requests or user data are used.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-protocol-loop-'))
process.env.BAILONGMA_USER_DIR = userDir
process.env.BAILONGMA_RESOURCES_DIR = process.cwd()
for (const key of ['DEEPSEEK_API_KEY', 'MINIMAX_API_KEY', 'OPENAI_API_KEY', 'DASHSCOPE_API_KEY',
  'MOONSHOT_API_KEY', 'ZHIPU_API_KEY', 'MIMO_API_KEY']) delete process.env[key]

const reasoning = { type: 'reasoning', id: 'rs_round', summary: [], encrypted_content: 'opaque-native-state' }
const calls = ['a.txt', 'b.txt'].map((file, index) => ({
  type: 'function_call', id: `fc_${index}`, call_id: `call_${index}`, name: 'read_file',
  arguments: JSON.stringify({ path: file }), status: 'completed',
}))
let scenario
const server = http.createServer(async (req, res) => {
  try {
    let body = ''
    for await (const chunk of req) body += chunk
    scenario.requests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(body) })
    if (scenario.mode === 'error') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Endpoint does not support this protocol' } }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const emit = event => res.write(`data: ${JSON.stringify(event)}\n\n`)
    const isChat = scenario.format === 'chat-completions'
    const toolRound = ['tools', 'malformed'].includes(scenario.mode) && scenario.requests.length === 1
    const text = scenario.mode === 'incomplete' ? 'Partial answer' : 'Both files say hello.'
    if (isChat) {
      const delta = value => emit({ choices: [{ index: 0, delta: value, finish_reason: null }] })
      if (toolRound || scenario.mode === 'eof' || scenario.mode === 'incomplete') {
        delta({ reasoning_content: 'Read both files.' })
        delta({ tool_calls: calls.map((call, index) => ({
          index, id: call.call_id, type: 'function', function: { name: call.name, arguments: '{"path":' },
        })) })
        for (const index of [1, 0]) {
          const tail = scenario.mode === 'malformed' && index === 0 ? '' : '}'
          delta({ tool_calls: [{ index, function: { arguments: `${JSON.stringify(index ? 'b.txt' : 'a.txt')}${tail}` } }] })
        }
      }
      if (!toolRound && scenario.mode !== 'eof') delta({ content: text })
      if (scenario.mode !== 'eof') emit({ choices: [{ index: 0, delta: {},
        finish_reason: scenario.mode === 'incomplete' ? 'length' : toolRound ? 'tool_calls' : 'stop' }] })
      emit({ choices: [], usage: { prompt_tokens: toolRound ? 5 : 1, completion_tokens: 2, total_tokens: toolRound ? 7 : 3 } })
      res.end('data: [DONE]\n\n')
    } else {
      if (toolRound) {
        for (const [output_index, item] of [reasoning, ...calls].entries()) {
          emit({ type: 'response.output_item.added', output_index, item })
        }
      } else {
        emit({ type: 'response.output_text.delta', item_id: 'msg_final', output_index: 0, delta: text })
      }
      const output = toolRound ? [reasoning, ...calls] : [{
        type: 'message', id: 'msg_final', role: 'assistant', phase: 'final_answer', status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      }]
      emit({ type: 'response.completed', response: { id: 'resp_loop', status: 'completed', output,
        usage: { input_tokens: toolRound ? 5 : 1, output_tokens: 2, total_tokens: toolRound ? 7 : 3 } } })
      res.end()
    }
  } catch (error) {
    scenario.error = error
    res.destroy(error)
  }
})

let closeDBForTest
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`
  const nextURL = `http://127.0.0.1:${server.address().port}/changed/v1`
  const { config } = await import('./config.js')
  const { callLLM } = await import('./llm.js')
  const { getWindowUsage } = await import('./quota.js')
  ;({ closeDBForTest } = await import('./db.js'))
  const configure = format => Object.assign(config, {
    provider: 'custom', apiFormat: format, model: 'local-test', baseURL, apiKey: 'local-test-key', needsActivation: false,
  })
  const common = { systemPrompt: 'Read files and answer.', message: 'Read a.txt and b.txt.',
    tools: ['read_file'], localReply: true, toolContext: { currentTargetId: 'ID:test' } }

  for (const format of ['responses', 'chat-completions']) {
    configure(format)
    scenario = { format, mode: 'tools', requests: [] }
    const executed = []
    const uiEvents = []
    const nextFormat = format === 'responses' ? 'chat-completions' : 'responses'
    const tokensBefore = getWindowUsage().tokens
    const result = await callLLM({ ...common, mustReply: true,
      onStream: event => uiEvents.push(event),
      _executeToolForTest: async (name, args) => {
        executed.push({ name, args })
        if (name === 'read_file') {
          // Simulate a settings save between tool rounds. The in-flight chain
          // must not mix credentials, model, endpoint or replay formats.
          Object.assign(config, { apiFormat: nextFormat, model: 'next-model', baseURL: nextURL, apiKey: 'next-key' })
          return JSON.stringify({ ok: true, content: 'hello', path: args.path })
        }
        assert.equal(name, 'send_message')
        return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      },
    })
    assert.ifError(scenario.error)
    assert.equal(result.content, 'Both files say hello.')
    assert.equal(result.delivered, true)
    assert.equal(scenario.requests.length, 2, 'the production tool loop performs exactly two model rounds')
    assert.deepEqual(executed.filter(item => item.name === 'read_file').map(item => item.args.path).sort(), ['a.txt', 'b.txt'])
    assert.equal(getWindowUsage().tokens - tokensBefore, 10, 'usage from both protocols is recorded')
    assert(uiEvents.some(event => event.event === 'tool_preparing'))
    for (const request of scenario.requests) {
      assert.equal(request.url, format === 'responses' ? '/v1/responses' : '/v1/chat/completions')
      assert.equal(request.authorization, 'Bearer local-test-key')
      assert.equal(request.body.model, 'local-test')
    }
    const replay = scenario.requests[1].body
    if (format === 'responses') {
      assert.equal(replay.messages, undefined)
      assert.deepEqual(replay.input.find(item => item.id === reasoning.id), reasoning)
      for (const call of calls) {
        assert.deepEqual(replay.input.find(item => item.id === call.id), call)
        assert(replay.input.some(item => item.type === 'function_call_output' && item.call_id === call.call_id))
      }
    } else {
      assert.equal(replay.input, undefined)
      const assistant = replay.messages.find(item => item.tool_calls)
      assert.equal(assistant.reasoning_content, 'Read both files.')
      assert.deepEqual(assistant.tool_calls.map(call => call.id), calls.map(call => call.call_id))
      for (const call of calls) {
        assert(replay.messages.some(item => item.role === 'tool' && item.tool_call_id === call.call_id))
      }
      assert.equal(replay.messages.some(item => item.type === 'function_call_output'), false)
    }
    // The next user turn uses the updated settings.
    scenario = { format: nextFormat, mode: 'text', requests: [] }
    const next = await callLLM({ ...common, tools: [], mustReply: false })
    assert.equal(next.content, 'Both files say hello.')
    assert.equal(scenario.requests[0].url, nextFormat === 'responses' ? '/changed/v1/responses' : '/changed/v1/chat/completions')
    assert.equal(scenario.requests[0].authorization, 'Bearer next-key')
    assert.equal(scenario.requests[0].body.model, 'next-model')
  }

  for (const mode of ['incomplete', 'eof', 'error', 'abort', 'malformed']) {
    configure('chat-completions')
    scenario = { format: 'chat-completions', mode, requests: [] }
    const controller = new AbortController()
    const executed = []
    const run = callLLM({ ...common, mustReply: false, signal: controller.signal,
      onStream: event => { if (mode === 'abort' && event.event === 'chunk') controller.abort() },
      _executeToolForTest: async name => { executed.push(name); return '{}' },
    })
    if (['eof', 'error', 'malformed'].includes(mode)) {
      await assert.rejects(run, mode === 'error' ? /does not support/ : mode === 'malformed' ? /arguments|JSON/i : /terminal|finish|ended/i)
    } else {
      const result = await run
      if (mode === 'incomplete') assert.equal(result.content, 'Partial answer')
      if (mode === 'abort') assert.equal(result.aborted, true)
    }
    assert.deepEqual(executed, [], `${mode} never executes tool requests`)
    assert.equal(scenario.requests.length, 1, `${mode} never switches protocols or retries partial output`)
  }
  console.log('PASS dual-protocol SDK Agent loops, native replay, connection snapshots, usage, truncation and abort')
} finally {
  closeDBForTest?.()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  fs.rmSync(userDir, { recursive: true, force: true })
}
