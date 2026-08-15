// Run: node src/test-llm-responses.js

import assert from 'node:assert/strict'
import http from 'node:http'
import OpenAI from 'openai'
import {
  buildResponsesRequest,
  createResponsesEventAccumulator,
  responseStreamError,
  toResponsesInput,
  toResponsesTools,
} from './llm-responses.js'

const tools = toResponsesTools([{
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read one file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
}])
assert.deepEqual(tools, [{
  type: 'function',
  name: 'read_file',
  description: 'Read one file',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  strict: false,
}])

const request = buildResponsesRequest({
  provider: 'deepseek',
  model: 'deepseek-v4-pro',
  messages: [
    { role: 'system', content: 'System' },
    { role: 'user', content: 'Read a file' },
  ],
  toolSchemas: [{
    type: 'function',
    function: { name: 'read_file', parameters: { type: 'object', properties: {} } },
  }],
  maxTokens: 100,
  thinking: true,
  stream: true,
})
assert.equal(request.stream, true)
assert.equal(request.store, false)
assert.equal(request.max_output_tokens, 100)
assert.equal(request.reasoning.effort, 'high')
assert.equal(request.input[0].type, 'message')
assert.equal(request.tools[0].name, 'read_file')
assert.equal(request.tools[0].function, undefined)
assert.equal(request.include, undefined)

const openAIRequest = buildResponsesRequest({
  provider: 'openai',
  model: 'gpt-5',
  messages: [{ role: 'user', content: 'Think' }],
})
assert.deepEqual(openAIRequest.include, ['reasoning.encrypted_content'])
assert.deepEqual(openAIRequest.reasoning, { effort: 'high', summary: 'auto' })

const openAIWithoutThinking = buildResponsesRequest({
  provider: 'openai',
  model: 'gpt-5',
  messages: [{ role: 'user', content: 'Answer directly' }],
  thinking: false,
})
assert.deepEqual(openAIWithoutThinking.reasoning, { effort: 'none' })

assert.deepEqual(toResponsesInput([
  { role: 'assistant', phase: 'commentary', content: 'I will inspect it.' },
  { role: 'assistant', phase: 'final_answer', content: 'It is fixed.' },
]), [
  { type: 'message', role: 'assistant', phase: 'commentary', content: 'I will inspect it.' },
  { type: 'message', role: 'assistant', phase: 'final_answer', content: 'It is fixed.' },
])

const reasoningItem = {
  type: 'reasoning',
  id: 'rs_1',
  summary: [],
  content: [{ type: 'reasoning_text', text: 'Need the file.' }],
}
const functionItem = {
  type: 'function_call',
  id: 'fc_1',
  call_id: 'call_1',
  name: 'read_file',
  arguments: '{"path":"a.txt"}',
  status: 'completed',
}
const replay = toResponsesInput([
  reasoningItem,
  functionItem,
  { type: 'function_call_output', call_id: 'call_1', output: 'hello' },
])
assert.deepEqual(replay, [reasoningItem, functionItem, {
  type: 'function_call_output', call_id: 'call_1', output: 'hello',
}])

const textDeltas = []
const reasoningDeltas = []
const prepared = []
const accumulator = createResponsesEventAccumulator({
  onTextDelta: text => textDeltas.push(text),
  onReasoningDelta: text => reasoningDeltas.push(text),
  onFunctionCallStarted: call => prepared.push(call.name),
})
const events = [
  { type: 'response.created', sequence_number: 0 },
  { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [], content: [] } },
  { type: 'response.reasoning_text.delta', sequence_number: 2, output_index: 0, item_id: 'rs_1', content_index: 0, delta: 'Need ' },
  { type: 'response.reasoning_text.delta', sequence_number: 3, output_index: 0, item_id: 'rs_1', content_index: 0, delta: 'file.' },
  { type: 'response.output_item.added', sequence_number: 4, output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '' } },
  { type: 'response.function_call_arguments.delta', sequence_number: 5, output_index: 1, item_id: 'fc_1', delta: '{"path":' },
  { type: 'response.function_call_arguments.delta', sequence_number: 6, output_index: 1, item_id: 'fc_1', delta: '"a.txt"}' },
  { type: 'response.function_call_arguments.done', sequence_number: 7, output_index: 1, item_id: 'fc_1', name: 'read_file', arguments: '{"path":"a.txt"}' },
  { type: 'response.output_item.done', sequence_number: 8, output_index: 1, item: functionItem },
  {
    type: 'response.completed',
    sequence_number: 9,
    response: {
      status: 'completed',
      output: [reasoningItem, functionItem],
      usage: {
        input_tokens: 20,
        output_tokens: 8,
        input_tokens_details: { cached_tokens: 12 },
        output_tokens_details: { reasoning_tokens: 4 },
      },
    },
  },
]
for (const event of events) accumulator.consume(event)
const parsed = accumulator.result()
assert.equal(parsed.reasoningContent, 'Need file.')
assert.deepEqual(reasoningDeltas, ['Need ', 'file.'])
assert.deepEqual(textDeltas, [])
assert.deepEqual(prepared, ['read_file'])
assert.deepEqual(parsed.toolCalls.map(call => ({ id: call.id, name: call.name, arguments: call.arguments })), [{
  id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}',
}])
assert.equal(parsed.outputItems.length, 2)
assert.deepEqual(parsed.usage, {
  totalTokens: 28,
  inputTokens: 20,
  outputTokens: 8,
  cachedTokens: 12,
  reasoningTokens: 4,
})
assert.equal(responseStreamError(parsed), null)

const textAccumulator = createResponsesEventAccumulator()
textAccumulator.consume({ type: 'response.output_text.delta', sequence_number: 1, output_index: 0, item_id: 'msg_1', content_index: 0, delta: 'Hello' })
textAccumulator.consume({ type: 'response.output_text.done', sequence_number: 2, output_index: 0, item_id: 'msg_1', content_index: 0, text: 'Hello' })
textAccumulator.consume({
  type: 'response.completed',
  sequence_number: 3,
  response: {
    output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hello', annotations: [] }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  },
})
assert.equal(textAccumulator.result().content, 'Hello', 'done/final text is not appended after streamed deltas')

const phasedText = []
const phasedCommentary = []
const phaseAccumulator = createResponsesEventAccumulator({
  onTextDelta: text => phasedText.push(text),
  onCommentaryDelta: text => phasedCommentary.push(text),
})
phaseAccumulator.consume({
  type: 'response.output_item.added', sequence_number: 0, output_index: 0,
  item: { type: 'message', id: 'msg_commentary', role: 'assistant', phase: 'commentary', status: 'in_progress', content: [] },
})
phaseAccumulator.consume({
  type: 'response.output_text.delta', sequence_number: 1, output_index: 0,
  item_id: 'msg_commentary', content_index: 0, delta: 'I will inspect it.',
})
phaseAccumulator.consume({
  type: 'response.output_item.added', sequence_number: 2, output_index: 1,
  item: { type: 'message', id: 'msg_final', role: 'assistant', phase: 'final_answer', status: 'in_progress', content: [] },
})
phaseAccumulator.consume({
  type: 'response.output_text.delta', sequence_number: 3, output_index: 1,
  item_id: 'msg_final', content_index: 0, delta: 'It is fixed.',
})
phaseAccumulator.consume({
  type: 'response.completed', sequence_number: 4,
  response: {
    output: [
      { type: 'message', id: 'msg_commentary', role: 'assistant', phase: 'commentary', status: 'completed', content: [{ type: 'output_text', text: 'I will inspect it.' }] },
      { type: 'message', id: 'msg_final', role: 'assistant', phase: 'final_answer', status: 'completed', content: [{ type: 'output_text', text: 'It is fixed.' }] },
    ],
    usage: {},
  },
})
const phaseResult = phaseAccumulator.result()
assert.equal(phaseResult.commentaryContent, 'I will inspect it.')
assert.equal(phaseResult.content, 'It is fixed.')
assert.deepEqual(phasedCommentary, ['I will inspect it.'])
assert.deepEqual(phasedText, ['It is fixed.'])

// Some compatible providers omit summary deltas and expose the reasoning
// summary only on response.completed. It must remain separate even when a
// commentary message was already present in the same terminal output.
const terminalOnlySummaryAccumulator = createResponsesEventAccumulator()
terminalOnlySummaryAccumulator.consume({
  type: 'response.completed', sequence_number: 0,
  response: {
    output: [
      { type: 'reasoning', id: 'rs_terminal', summary: [{ type: 'summary_text', text: 'Checked the edge case.' }], content: [] },
      { type: 'message', id: 'msg_terminal_commentary', role: 'assistant', phase: 'commentary', status: 'completed', content: [{ type: 'output_text', text: 'I am checking the edge case.' }] },
      { type: 'message', id: 'msg_terminal_final', role: 'assistant', phase: 'final_answer', status: 'completed', content: [{ type: 'output_text', text: 'The edge case is handled.' }] },
    ],
    usage: {},
  },
})
const terminalOnlySummary = terminalOnlySummaryAccumulator.result()
assert.equal(terminalOnlySummary.reasoningContent, 'Checked the edge case.')
assert.equal(terminalOnlySummary.commentaryContent, 'I am checking the edge case.')
assert.equal(terminalOnlySummary.content, 'The edge case is handled.')

const refusalAccumulator = createResponsesEventAccumulator()
refusalAccumulator.consume({ type: 'response.refusal.delta', sequence_number: 1, output_index: 0, item_id: 'msg_refusal', content_index: 0, delta: 'I cannot help.' })
refusalAccumulator.consume({
  type: 'response.completed',
  sequence_number: 2,
  response: {
    output: [{ type: 'message', id: 'msg_refusal', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'I cannot help.' }] }],
    usage: {},
  },
})
assert.equal(refusalAccumulator.result().content, 'I cannot help.', 'refusal events remain visible response text')

const incompleteAccumulator = createResponsesEventAccumulator()
incompleteAccumulator.consume({
  type: 'response.incomplete',
  sequence_number: 0,
  response: { output: [], incomplete_details: { reason: 'max_output_tokens' } },
})
assert.match(responseStreamError(incompleteAccumulator.result()).message, /max_output_tokens/)

// Exercise the installed SDK against a local SSE endpoint. This proves that
// the production call shape reaches /v1/responses and that typed events are
// yielded without relying on a billable provider call.
let capturedSdkRequest = null
const server = http.createServer(async (req, res) => {
  let rawBody = ''
  for await (const chunk of req) rawBody += chunk
  capturedSdkRequest = { method: req.method, url: req.url, body: JSON.parse(rawBody) }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const textEvent = {
    type: 'response.output_text.delta', sequence_number: 0, output_index: 0,
    item_id: 'msg_sdk', content_index: 0, delta: 'SDK OK', logprobs: [],
  }
  const completedEvent = {
    type: 'response.completed', sequence_number: 1,
    response: {
      id: 'resp_sdk', object: 'response', status: 'completed', output: [],
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    },
  }
  res.write(`event: ${textEvent.type}\ndata: ${JSON.stringify(textEvent)}\n\n`)
  res.end(`event: ${completedEvent.type}\ndata: ${JSON.stringify(completedEvent)}\n\n`)
})
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
try {
  const address = server.address()
  const sdk = new OpenAI({
    apiKey: 'local-test-key',
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    maxRetries: 0,
  })
  const sdkStream = await sdk.responses.create({
    model: 'test-model',
    input: [{ role: 'user', content: 'hello' }],
    stream: true,
    store: false,
  })
  const sdkEvents = []
  for await (const event of sdkStream) sdkEvents.push(event)
  assert.equal(capturedSdkRequest.method, 'POST')
  assert.equal(capturedSdkRequest.url, '/v1/responses')
  assert.equal(capturedSdkRequest.body.input[0].content, 'hello')
  assert.deepEqual(sdkEvents.map(event => event.type), ['response.output_text.delta', 'response.completed'])
} finally {
  await new Promise(resolve => server.close(resolve))
}

console.log('PASS Responses API request, typed stream, tool Items, usage, and terminal states')
