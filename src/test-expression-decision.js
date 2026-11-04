import assert from 'node:assert/strict'
import { callLLM } from './llm.js'

const checkpoint = mode => ({ content: JSON.stringify({ response: { mode, reason: mode === 'direct' ? '用户询问 PUBG，需要回答' : '无需表达', text: '' }, summary: '简要解释 PUBG', expected: '用户收到介绍', observation: '无需检索', decision: 'finish' }) })
const base = {
  systemPrompt: 'Thinking and expression are separate.', message: '你知道什么是 PUBG 吗',
  tools: ['send_message'], mustReply: true, localReply: true,
  toolContext: { outputContract: 'explicit_send_only', currentTargetId: 'ID:000001', currentChannel: '语音识别' },
  onCognition() {},
}
const sent = []
let attempts = 0
const result = await callLLM({
  ...base,
  _streamOnceForTest: async ({ purpose, messages, toolSchemas }) => {
    if (purpose === 'cognition') {
      assert.match(messages.at(-1).content, /Even a simple factual answer requires this expression tool/)
      assert.match(messages.at(-1).content, /local voice conversation/)
      return checkpoint('direct')
    }
    attempts++
    if (attempts === 1) return { content: 'PRIVATE DRAFT: PUBG 是绝地求生', toolCalls: [] }
    if (attempts === 2) {
      assert.match(messages.at(-1).content, /no expression was delivered/)
      assert.match(messages.at(-1).content, /format="voice"/)
      assert.deepEqual(toolSchemas.map(s => s.function.name), ['send_message'])
      return { content: '', toolCalls: [{ id: 'answer', name: 'send_message', arguments: JSON.stringify({ target_id: 'ID:000001', format: 'text', content: 'PUBG 是《绝地求生》，一款大逃杀射击游戏。' }) }] }
    }
    return { content: '', toolCalls: [] }
  },
  _executeToolForTest: async (name, args) => { sent.push(args); return '{"ok":true,"delivered":true,"message_sent":true}' },
})
assert.equal(result.delivered, true)
assert.equal(sent.length, 1)
assert.equal(sent[0].format, 'text')
assert.ok(!sent[0].content.includes('PRIVATE'))
let privateRounds = 0
await assert.rejects(callLLM({
  ...base,
  _streamOnceForTest: async ({ purpose }) => {
    if (purpose === 'cognition') return checkpoint('direct')
    privateRounds++
    return { content: 'private text only', toolCalls: [] }
  },
  _executeToolForTest: async () => assert.fail('must not auto-deliver private draft'),
}), /表达未完成/)
assert.equal(privateRounds, 3, 'expression repair is bounded')
const silent = await callLLM({
  ...base,
  _streamOnceForTest: async ({ purpose }) => purpose === 'cognition' ? checkpoint('none') : { content: '', toolCalls: [] },
  _executeToolForTest: async () => assert.fail('intentional silence must remain silent'),
})
assert.equal(silent.delivered, false)
console.log('PASS direct decision requires explicit expression, bounded failures surface as errors, deliberate silence preserved')
