// Pure protocol tests; no credentials, database, SDK, or network required.
import assert from 'node:assert/strict'
import { getLLMProtocol } from './llm-protocol.js'

const chat = getLLMProtocol('chat-completions')
const responses = getLLMProtocol('responses')
assert.equal(getLLMProtocol().id, 'responses')
assert.throws(() => getLLMProtocol('unknown'), /Unsupported/)

const tool = {
  type: 'function',
  function: {
    name: 'read_file', description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
}
const request = chat.buildRequest({
  provider: 'custom', model: 'example', messages: [{ role: 'user', content: 'Read it' }],
  toolSchemas: [tool], temperature: 0.2, topP: 0.8, maxTokens: 128, thinking: true,
})
assert.deepEqual(request, {
  model: 'example', messages: [{ role: 'user', content: 'Read it' }], stream: true,
  temperature: 0.2, top_p: 0.8, max_tokens: 128, tools: [tool], tool_choice: 'auto',
})
request.tools[0].function.name = 'mutated'
assert.equal(tool.function.name, 'read_file', 'wire requests must not mutate shared tool schemas')
const openAI = chat.buildRequest({ provider: 'openai', model: 'gpt-5', maxTokens: 64, omitSampling: true, temperature: 1, topP: 1 })
assert.equal(openAI.max_completion_tokens, 64)
assert.deepEqual(openAI.stream_options, { include_usage: true })
assert.equal(openAI.max_tokens, undefined)
assert.equal(openAI.store, false)
assert.equal(openAI.temperature, undefined)
assert.equal(openAI.top_p, undefined)
for (const field of ['input', 'include', 'reasoning', 'reasoning_effort', 'max_output_tokens']) {
  assert.equal(openAI[field], undefined, `${field} must not leak from Responses or speculative model profiles`)
}
assert.equal(chat.buildRequest({ provider: 'openai', model: 'example', stream: false }).stream_options, undefined)
assert.equal(chat.buildRequest({ provider: 'openai', model: 'example', stream: false }).store, false)

const callbacks = { text: [], reasoning: [], started: [], arguments: [] }
const accumulator = chat.createAccumulator({
  onTextDelta: text => callbacks.text.push(text),
  onReasoningDelta: text => callbacks.reasoning.push(text),
  onFunctionCallStarted: call => callbacks.started.push(call),
  onFunctionArgumentsDelta: call => callbacks.arguments.push(call),
}, { provider: 'custom', model: 'deepseek-via-gateway' })
const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] })
accumulator.consume(chunk({ role: 'assistant', content: null, reasoning_content: '' }))
accumulator.consume(chunk({ reasoning_content: 'Need files. ' }))
accumulator.consume(chunk({ content: 'I will read ' }))
accumulator.consume(chunk({ content: 'both.' }))
accumulator.consume(chunk({ tool_calls: [
  { index: 1, id: 'call_', type: 'function', function: { name: 'read_', arguments: '{"path":' } },
  { index: 0, id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a' } },
] }))
accumulator.consume(chunk({ tool_calls: [
  { index: 0, function: { arguments: '.txt"}' } },
  { index: 1, id: 'b', function: { name: 'file', arguments: '"b.txt"}' } },
] }))
assert.equal(accumulator.result().status, 'pending', 'tool deltas alone never authorize tool execution')
assert.match(chat.streamError(accumulator.result()).message, /without a terminal/)
accumulator.consume(chunk({}, 'tool_calls'))
accumulator.consume({ choices: [], usage: {
  prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
  prompt_tokens_details: { cached_tokens: 70 }, completion_tokens_details: { reasoning_tokens: 5 },
} })
const parsed = accumulator.result()
assert.equal(parsed.status, 'completed')
assert.equal(chat.streamError(parsed), null)
assert.equal(parsed.content, 'I will read both.')
assert.equal(parsed.reasoningContent, 'Need files. ')
assert.deepEqual(parsed.toolCalls.map(({ id, name, arguments: args }) => ({ id, name, args })), [
  { id: 'call_a', name: 'read_file', args: '{"path":"a.txt"}' },
  { id: 'call_b', name: 'read_file', args: '{"path":"b.txt"}' },
])
assert.deepEqual(parsed.usage, { totalTokens: 120, inputTokens: 100, outputTokens: 20, cachedTokens: 70, reasoningTokens: 5 })
assert.deepEqual(callbacks.text, ['I will read ', 'both.'])
assert.deepEqual(callbacks.reasoning, ['Need files. '])
assert.equal(callbacks.started.length, 2)
assert.equal(callbacks.arguments.length, 4)
assert.equal(callbacks.arguments[0].itemId, callbacks.arguments[3].itemId, 'argument preview keys survive fragmented IDs')
assert.equal(callbacks.arguments[0].arguments, '{"path":', 'callback snapshots must not change when later chunks arrive')

const standardCallbacks = { starts: [], previews: [] }
const standardTool = chat.createAccumulator({
  onFunctionCallStarted: call => standardCallbacks.starts.push(call),
  onFunctionArgumentsDelta: call => standardCallbacks.previews.push(call),
})
standardTool.consume(chunk({ tool_calls: [{ index: 0, id: 'call_write', type: 'function' }] }))
assert.equal(standardCallbacks.starts.length, 0, 'an ID-only delta does not announce an unknown tool')
standardTool.consume(chunk({ tool_calls: [{ index: 0, function: { name: 'write_file', arguments: '' } }] }))
for (const argumentsFragment of ['{"path":"a.txt",', '"content":"hello', '"}']) {
  standardTool.consume(chunk({ tool_calls: [{ index: 0, function: { arguments: argumentsFragment } }] }))
}
standardTool.consume(chunk({}, 'tool_calls'))
assert.equal(standardCallbacks.starts.length, 1, 'announce each tool exactly once')
assert.equal(standardCallbacks.starts[0].name, 'write_file')
assert.equal(standardCallbacks.previews.length, 3, 'each nonempty argument fragment updates the preview')
assert.equal(new Set(standardCallbacks.previews.map(call => call.itemId)).size, 1)
assert.equal(standardCallbacks.previews.at(-1).arguments, '{"path":"a.txt","content":"hello"}')
assert.equal(standardTool.result().status, 'completed')

const history = chat.toHistoryEntries(parsed)
assert.deepEqual(history, [{
  role: 'assistant', content: 'I will read both.', reasoning_content: 'Need files. ',
  tool_calls: [
    { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
    { id: 'call_b', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.txt"}' } },
  ],
}])
const toolResults = chat.toToolResultEntries([{ id: 'call_a', result: 'A' }, { id: 'call_b', result: 'B' }])
assert.deepEqual(toolResults, [
  { role: 'tool', tool_call_id: 'call_a', content: 'A' },
  { role: 'tool', tool_call_id: 'call_b', content: 'B' },
])
const nextRequest = chat.buildRequest({ provider: 'custom', model: 'deepseek-via-gateway', messages: [
  { role: 'system', content: 'Be helpful' }, ...history, ...toolResults,
] })
assert.deepEqual(nextRequest.messages.slice(1), [...history, ...toolResults], 'second round preserves assistant/tool pairing and server-supplied reasoning')
history[0].tool_calls[0].function.name = 'mutated'
assert.equal(chat.toHistoryEntries(parsed)[0].tool_calls[0].function.name, 'read_file')
assert.equal(accumulator.result().toolCalls[0].name, 'read_file')
assert.throws(() => chat.buildRequest({ messages: [{ type: 'function_call', id: 'fc_1' }] }), /Cannot replay Responses/)
assert.throws(() => chat.buildRequest({ messages: [{ role: 'tool', content: 'Missing ID' }] }), /tool_call_id/)
assert.throws(() => chat.toHistoryEntries({ replay: { protocol: 'responses', entries: [] } }), /protocol mismatch/)
assert.throws(() => responses.toHistoryEntries(parsed), /protocol mismatch/)

for (const finishReason of ['length', 'content_filter']) {
  const truncated = chat.createAccumulator()
  truncated.consume(chunk({ content: 'Partial', tool_calls: [
    { index: 0, id: 'call_truncated', type: 'function', function: { name: 'write_file', arguments: '{"path":"' } },
  ] }, finishReason))
  const partial = truncated.result()
  assert.equal(partial.status, 'incomplete')
  assert.match(chat.streamError(partial).message, new RegExp(finishReason))
  assert.equal(chat.streamError(partial).hadContent, true)
}
const unfinished = chat.createAccumulator()
unfinished.consume(chunk({ tool_calls: [
  { index: 0, id: 'call_partial', type: 'function', function: { name: 'write_file', arguments: '{"path":' } },
] }))
assert.equal(unfinished.result().status, 'pending')
assert.equal(chat.streamError(unfinished.result()).code, 'ECHATCOMPLETIONSSTREAM')
assert.equal(chat.streamError(unfinished.result()).hadContent, true, 'partial tools disable blind request retries')
assert.equal(chat.streamError(chat.createAccumulator().result()).hadContent, false)

// Some gateways report a successful finish even with malformed argument JSON.
// Reject the whole tool round so runtime cannot substitute {} and execute an
// unintended default action. Valid empty objects remain valid no-arg calls.
for (const args of ['', ' ', '{"path":', '{bad}', 'null', '[]', '[{"path":"a"}]', 'true', '42', '"text"']) {
  const malformed = chat.createAccumulator()
  malformed.consume(chunk({ tool_calls: [
    { index: 0, id: 'call_valid', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
    { index: 1, id: 'call_invalid', type: 'function', function: { name: 'write_file', arguments: args } },
  ] }, 'tool_calls'))
  assert.equal(malformed.result().status, 'failed', `must not execute argument string ${JSON.stringify(args)}`)
  assert.match(chat.streamError(malformed.result()).message, /valid JSON object/)
  assert.equal(chat.streamError(malformed.result()).hadContent, true, 'do not retry a malformed tool round silently')
}
for (const args of ['{}', ' {"path":"a.txt"} ', '{"nested":{"list":[1,null,true]}}']) {
  const valid = chat.createAccumulator()
  valid.consume(chunk({ tool_calls: [
    { index: 0, id: 'call_valid', type: 'function', function: { name: 'read_file', arguments: args } },
  ] }, 'tool_calls'))
  assert.equal(valid.result().status, 'completed')
  assert.equal(chat.streamError(valid.result()), null)
}

for (const delta of [
  { tool_calls: [{ index: 0, type: 'function', function: { name: 'write_file', arguments: '{}' } }] },
  { tool_calls: [{ index: 0, id: 'call_no_name', type: 'function', function: { arguments: '{}' } }] },
  { tool_calls: [{ id: 'call_no_index', type: 'function', function: { name: 'write_file', arguments: '{}' } }] },
  { tool_calls: [{ index: 0, id: 'call_custom', type: 'custom', function: { name: 'write_file', arguments: '{}' } }] },
  {},
]) {
  const invalid = chat.createAccumulator()
  invalid.consume(chunk(delta, 'tool_calls'))
  assert.equal(invalid.result().status, 'failed')
  assert.ok(chat.streamError(invalid.result()))
}
const failed = chat.createAccumulator()
failed.consume({ error: { code: 'upstream_error', message: 'Provider unavailable' } })
assert.equal(failed.result().status, 'failed')
assert.equal(chat.streamError(failed.result()).code, 'upstream_error')

const refusal = chat.createAccumulator()
refusal.consume(chunk({ refusal: 'Cannot help.' }, 'stop'))
assert.equal(refusal.result().content, 'Cannot help.')
assert.equal(refusal.result().status, 'completed')
assert.equal(refusal.result().replay.entries[0].reasoning_content, undefined, 'never invent reasoning fields')
const emptyReasoning = chat.createAccumulator()
emptyReasoning.consume(chunk({ reasoning_content: '', content: 'Done' }, 'stop'))
assert.equal(emptyReasoning.result().replay.entries[0].reasoning_content, '')
const textOnly = chat.createAccumulator()
textOnly.consume({ choices: [{ index: 1, delta: { content: 'Ignore another candidate' }, finish_reason: 'stop' }] })
assert.equal(textOnly.result().status, 'pending')
textOnly.consume(chunk({ content: 'Done' }, 'stop'))
assert.deepEqual(textOnly.result().replay.entries, [{ role: 'assistant', content: 'Done' }])

// The Responses wrapper retains protocol-native encrypted and phase state.
const responseItems = [
  { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque', summary: [] },
  { type: 'message', id: 'msg_1', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Reading' }] },
  { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' },
]
const responseAccumulator = responses.createAccumulator()
responseAccumulator.consume({ type: 'response.completed', response: { output: responseItems } })
const responseParsed = responseAccumulator.result()
assert.equal(responseParsed.status, 'completed')
assert.deepEqual(responses.toHistoryEntries(responseParsed), responseItems)
assert.deepEqual(responses.toHistoryEntries({ outputItems: responseItems }), responseItems, 'older injected round results remain compatible')
const responseReplay = responses.toHistoryEntries(responseParsed)
responseReplay[0].encrypted_content = 'mutated'
assert.equal(responseAccumulator.result().outputItems[0].encrypted_content, 'opaque')
assert.deepEqual(responses.toToolResultEntries([{ id: 'call_1', result: 'A' }]), [{ type: 'function_call_output', call_id: 'call_1', output: 'A' }])
assert.equal(responses.createAccumulator().result().status, 'pending')
assert.ok(responses.streamError(responses.createAccumulator().result()))

console.log('PASS Chat Completions requests, interleaved tools, native replay, reasoning, usage, and terminal states')
