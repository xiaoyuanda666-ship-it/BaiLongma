import assert from 'node:assert/strict'
import { executeExpression, expressionGuidance } from './runtime/expression.js'
const calls = []
const deps = {
  deliver: async (args, context) => {
    if (context.prepareSpeech) {
      const speech = await context.prepareSpeech()
      if (!speech?.segments?.length) return '{"ok":false,"delivered":false,"error":"speech_failed"}'
      context = { ...context, speechManifest: speech }
    }
    calls.push({ kind: 'text', args, context }); return '{"ok":true,"delivered":true}'
  },
  speak: async (args) => { calls.push({ kind: 'voice', args }); return { version: 1, id: 'test-speech', text: args.text, segments: [{ text: args.text, path: 'audio/test.mp3' }] } },
}
const context = { currentTargetId: 'ID:1', currentChannel: 'VOICE', voiceReply: true }
const send = args => executeExpression({ target_id: 'ID:1', content: '你好', ...args }, context, deps)
await send({ format: 'text' })
assert.equal(calls.at(-1).args.channel, 'TUI')
assert.equal(calls.at(-1).context.expressionVoice, false)
assert.equal(JSON.parse(await send({ format: 'voice' })).delivered, true)
assert.equal(calls.at(-1).context.speechManifest.id, 'test-speech')
assert.equal(calls.at(-1).args.content, '你好')
assert.deepEqual(calls.map(c => c.kind), ['text', 'voice', 'text'])
await send({ format: 'social', channel: 'WECHAT' })
assert.equal(calls.at(-1).args.channel, 'WECHAT')
for (const args of [{ format: 'social' }, { format: 'voice', channel: 'WECHAT' }, { format: 'voice', target_id: 'ID:2' }, { format: 'voice', media_path: '/tmp/test' }, { format: 'bad' }]) {
  const before = calls.length
  assert.equal(JSON.parse(await send(args)).ok, false)
  assert.equal(calls.length, before)
}
assert.equal(JSON.parse(await executeExpression({ target_id: 'ID:1', content: 'hello', format: 'voice' }, context, { ...deps, speak: async () => '语音合成失败：凭证缺失' })).delivered, false)
await send({ channel: 'WECHAT' })
assert.equal(calls.at(-1).args.channel, 'WECHAT')
console.log('PASS expression formats, routing, recipient validation and speech failure')

const { callLLM } = await import('./llm.js')
const executions = []
const result = await callLLM({
  systemPrompt: 'Private thinking', message: 'hello', tools: ['send_message'],
  mustReply: true, localReply: true,
  toolContext: { outputContract: 'explicit_send_only', currentTargetId: 'ID:1' },
  _streamOnceForTest: async () => ({ content: 'PRIVATE DRAFT', toolCalls: [] }),
  _executeToolForTest: async (name, args) => { executions.push({ name, args }); return '{"ok":true,"delivered":true}' },
})
assert.equal(result.delivered, false)
assert.equal(executions.length, 0, 'private prose must never be delivered by fallback')
console.log('PASS explicit expression contract never auto-delivers private prose')

const explicitCalls = []
let round = 0
const sent = await callLLM({
  systemPrompt: 'Express explicitly', message: 'hello', tools: ['send_message'], mustReply: true,
  toolContext: { outputContract: 'explicit_send_only', currentTargetId: 'ID:1' },
  _streamOnceForTest: async () => round++ === 0
    ? { content: 'PRIVATE PLAN', toolCalls: [{ id: 'expression', name: 'send_message', arguments: JSON.stringify({ target_id: 'ID:1', format: 'text', content: 'PUBLIC ANSWER' }) }] }
    : { content: '', toolCalls: [] },
  _executeToolForTest: async (name, args) => { explicitCalls.push(args); return '{"ok":true,"delivered":true,"message_sent":true}' },
})
assert.equal(sent.delivered, true)
assert.deepEqual(explicitCalls.map(c => c.content), ['PUBLIC ANSWER'])
console.log('PASS explicit tool expression delivers exactly once without leaking surrounding prose')

const workCalls = []
let workRound = 0
await callLLM({
  systemPrompt: 'Execute privately', message: 'search', tools: ['web_search', 'send_message'], mustReply: true,
  toolContext: { outputContract: 'explicit_send_only', currentTargetId: 'ID:1' },
  _streamOnceForTest: async () => workRound++ === 0
    ? { content: '', toolCalls: [{ id: 'search', name: 'web_search', arguments: '{"query":"test"}' }] }
    : { content: 'Private assessment; no expression needed.', toolCalls: [] },
  _executeToolForTest: async name => { workCalls.push(name); return '{"ok":true,"results":[]}' },
})
assert.deepEqual(workCalls, ['web_search'], 'slow work must not auto-send acknowledgements or closing text')
console.log('PASS execution without automatic acknowledgement or final expression')

for (const args of [
  { format: 'text', target_id: 'wechat:test' },
  { format: 'voice', target_id: 'wechat:test' },
  { format: 'social', channel: 'DISCORD', target_id: 'wechat:test' },
]) {
  const before = calls.length
  assert.equal(JSON.parse(await send(args)).ok, false)
  assert.equal(calls.length, before, 'conflicting expression recipient never reaches a transport')
}
let combinedRound = 0
const combinedCalls = []
await callLLM({
  systemPrompt: 'Choose voice and text', message: 'Provide a spoken summary and text details', tools: ['send_message'],
  toolContext: { outputContract: 'explicit_send_only', currentTargetId: 'ID:1', tickContext: { id: 'test-expression', number: 1 } },
  _streamOnceForTest: async () => combinedRound++ === 0 ? {
    content: '', toolCalls: ['voice', 'text'].map(format => ({ id: format, name: 'send_message', arguments: JSON.stringify({ target_id: 'ID:1', content: format === 'voice' ? '摘要' : '详细内容', format }) })),
  } : { content: '', toolCalls: [] },
  _executeToolForTest: async (name, args) => { combinedCalls.push(args.format); return '{"ok":true,"delivered":true,"message_sent":true}' },
})
assert.deepEqual(combinedCalls, ['voice', 'text'], 'one tick may explicitly choose both speech and chat for the same recipient')
console.log('PASS cross-channel recipient isolation and combined voice/text expression')

for (const currentChannel of ['voice', 'VOICE', '语音识别', '语音对话', 'FocusBanner']) {
  assert.match(expressionGuidance({ currentChannel }), /Prefer send_message with format="voice"/)
  assert.match(expressionGuidance({ currentChannel }), /asks for text, silence, or another channel/)
}
assert.match(expressionGuidance({ voiceReply: true }), /local voice conversation/)
assert.doesNotMatch(expressionGuidance({ currentChannel: 'TUI' }), /local voice conversation/)
assert.doesNotMatch(expressionGuidance({ currentChannel: 'WECHAT' }), /local voice conversation/)
console.log('PASS voice preference covers all voice entry points without forcing text/social output to audio')
