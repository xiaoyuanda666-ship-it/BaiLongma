// Run: node src/test-outbound-awareness.js
//
// Outbound communication is a fact the agent must see before it can make a
// further decision. This covers both a pre-batched duplicate tool call and the
// heartbeat context supplied to a later turn.

import assert from 'node:assert/strict'
import { callLLM } from './llm.js'
import { buildLLMMessages } from './runtime/messages.js'

const productionDeliverySuccess = JSON.stringify({ ok: true, delivered: true, message_sent: true })
const itemText = item => String(item?.content ?? item?.output ?? '')

const executed = []
let rounds = 0
let thirdRoundMessages = []

const result = await callLLM({
  systemPrompt: 'heartbeat test',
  message: 'TICK',
  tools: ['send_message'],
  toolContext: {
    outputContract: 'explicit_send_only',
    currentTargetId: 'ID:000001',
    tickContext: { id: 'test-tick-77', number: 77, startedAtMs: Date.now() },
  },
  mustReply: false,
  _executeToolForTest: async (name, args) => {
    executed.push({ name, args })
    return productionDeliverySuccess
  },
  _streamOnceForTest: async ({ messages }) => {
    rounds += 1
    if (rounds === 1) {
      return {
        content: '',
        reasoningContent: '',
        aborted: false,
        toolCalls: [
          { id: 'send-first', name: 'send_message', arguments: JSON.stringify({ target_id: 'ID:000001', content: 'First observation.' }) },
          { id: 'send-second', name: 'send_message', arguments: JSON.stringify({ target_id: 'ID:000001', content: 'Premature second observation.' }) },
        ],
      }
    }
    if (rounds === 2) {
      assert(messages.some(message => String(message.content || '').includes('TICK #77')), 'the next model step is told it is still the same outer TICK')
      return {
        content: '',
        reasoningContent: '',
        aborted: false,
        toolCalls: [{ id: 'send-after-result', name: 'send_message', arguments: JSON.stringify({ target_id: 'ID:000001', content: 'Still no new evidence.' }) }],
      }
    }
    thirdRoundMessages = messages
    return { content: '', reasoningContent: '', aborted: false, toolCalls: [] }
  },
})

assert.equal(executed.length, 1, 'only the first same-recipient send from a pre-batched response is executed')
assert.equal(executed[0].args.content, 'First observation.')
assert.equal(result.delivered, true, 'the first actual delivery remains recorded')

const toolResults = thirdRoundMessages
  .filter(message => message.type === 'function_call_output')
  .map(message => String(message.output))
assert(toolResults.some(result => result.includes('"message_sent":true')), 'the next model step sees the production-shaped structured delivery result')
assert(toolResults.some(result => result.includes('outbound_reconsideration_required')), 'the deferred second send is visible as a fresh-decision requirement')
assert(toolResults.some(result => result.includes('same_tick_no_new_evidence')), 'a later tool-loop round cannot impersonate a new heartbeat without new evidence')
assert(thirdRoundMessages.some(message => String(message.content || '').includes('Communication reality check:')), 'the next model step receives a salient delivered-message fact')
assert(thirdRoundMessages.some(message => String(message.content || '').includes('received and shown to the user')), 'a successful send is explicitly treated as visible to the user')
assert(thirdRoundMessages.some(message => String(message.content || '').includes('do not reinterpret silence as a missed or failed delivery')), 'user silence cannot be reinterpreted as delivery failure')

const evidenceExecuted = []
let evidenceRounds = 0
await callLLM({
  systemPrompt: 'heartbeat test',
  message: 'TICK',
  tools: ['send_message', 'read_file'],
  toolContext: {
    outputContract: 'explicit_send_only',
    currentTargetId: 'ID:000001',
    tickContext: { id: 'test-tick-78', number: 78, startedAtMs: Date.now() },
  },
  mustReply: false,
  _executeToolForTest: async (name, args) => {
    evidenceExecuted.push({ name, args })
    return name === 'read_file' ? 'new file evidence retrieved' : productionDeliverySuccess
  },
  _streamOnceForTest: async () => {
    evidenceRounds += 1
    const call = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) })
    if (evidenceRounds === 1) return { content: '', reasoningContent: '', aborted: false, toolCalls: [call('evidence-send-1', 'send_message', { target_id: 'ID:000001', content: 'Initial status.' })] }
    if (evidenceRounds === 2) return { content: '', reasoningContent: '', aborted: false, toolCalls: [call('evidence-read', 'read_file', { path: 'new-evidence.txt' })] }
    if (evidenceRounds === 3) return { content: '', reasoningContent: '', aborted: false, toolCalls: [call('evidence-send-2', 'send_message', { target_id: 'ID:000001', content: 'Status changed after evidence.' })] }
    return { content: '', reasoningContent: '', aborted: false, toolCalls: [] }
  },
})
assert.deepEqual(evidenceExecuted.map(item => item.name), ['send_message', 'read_file', 'send_message'], 'new evidence after a delivery permits a later same-TICK message')

const dynamicExecuted = []
let dynamicRounds = 0
await callLLM({
  systemPrompt: 'complete the requested file read',
  message: '读取 report.txt 并告诉我内容',
  tools: ['send_message', 'find_tool'],
  toolContext: { outputContract: 'explicit_send_only', currentTargetId: 'ID:000001' },
  mustReply: true,
  localReply: false,
  _executeToolForTest: async (name, args) => {
    dynamicExecuted.push({ name, args })
    if (name === 'send_message') return productionDeliverySuccess
    if (name === 'find_tool') return JSON.stringify({ ok: true, loaded: ['read_file'] })
    if (name === 'read_file') return JSON.stringify({ ok: true, path: 'report.txt', content: 'verified contents' })
    return JSON.stringify({ ok: false, error: `unexpected tool: ${name}` })
  },
  _streamOnceForTest: async ({ messages, toolSchemas }) => {
    dynamicRounds += 1
    const call = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) })
    if (dynamicRounds === 1) {
      return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [
          call('dynamic-progress', 'send_message', { target_id: 'ID:000001', content: '我先看看。' }),
          call('dynamic-find', 'find_tool', { query: '读取文件' }),
        ],
      }
    }
    if (dynamicRounds === 2) {
      assert(toolSchemas.some(schema => schema.function.name === 'read_file'), 'find_tool loads read_file for the next model round')
      assert(messages.some(entry => itemText(entry).includes('"message_sent":true')), 'the next round retains the structured progress-delivery fact')
      return { content: '', reasoningContent: '', aborted: false, toolCalls: [call('dynamic-read', 'read_file', { path: 'report.txt' })] }
    }
    if (dynamicRounds === 3) {
      assert(messages.some(entry => itemText(entry).includes('verified contents')), 'the final-result round receives the dynamically loaded tool evidence')
      return { content: '', reasoningContent: '', aborted: false, toolCalls: [call('dynamic-final', 'send_message', { target_id: 'ID:000001', content: 'report.txt 内容是 verified contents。' })] }
    }
    return { content: '', reasoningContent: '', aborted: false, toolCalls: [] }
  },
})
assert.deepEqual(dynamicExecuted.map(item => item.name), ['send_message', 'find_tool', 'read_file', 'send_message'], 'structured progress delivery does not truncate find_tool -> read_file -> final delivery')
assert.equal(dynamicRounds, 4, 'ordinary final send gets one fresh decision round instead of being inferred terminal')

const actionExecuted = []
let actionRounds = 0
await callLLM({
  systemPrompt: 'complete the requested write',
  message: '创建 result.txt',
  tools: ['send_message', 'write_file'],
  toolContext: { outputContract: 'explicit_send_only', currentTargetId: 'ID:000001' },
  mustReply: true,
  localReply: false,
  _executeToolForTest: async (name, args) => {
    actionExecuted.push({ name, args })
    if (name === 'send_message') return productionDeliverySuccess
    if (name === 'write_file') return JSON.stringify({ ok: true, path: 'result.txt', bytes: 4 })
    return JSON.stringify({ ok: false, error: `unexpected tool: ${name}` })
  },
  _streamOnceForTest: async ({ messages }) => {
    actionRounds += 1
    const call = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) })
    if (actionRounds === 1) {
      return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [
          call('action-progress', 'send_message', { target_id: 'ID:000001', content: '我现在创建文件。' }),
          call('action-write', 'write_file', { path: 'result.txt', content: 'done' }),
        ],
      }
    }
    if (actionRounds === 2) {
      assert(messages.some(entry => itemText(entry).includes('"bytes":4')), 'the action result reaches final-result processing after an earlier progress message')
      return { content: '', reasoningContent: '', aborted: false, toolCalls: [call('action-final', 'send_message', { target_id: 'ID:000001', content: 'result.txt 已创建（4 bytes）。' })] }
    }
    return { content: '', reasoningContent: '', aborted: false, toolCalls: [] }
  },
})
assert.deepEqual(actionExecuted.map(item => item.name), ['send_message', 'write_file', 'send_message'], 'a progress send in the same batch neither skips the action nor its final result handling')

let terminalRounds = 0
const terminalResult = await callLLM({
  systemPrompt: 'show capabilities',
  message: '你能做什么',
  tools: ['capability_demo'],
  toolContext: { currentTargetId: 'ID:000001' },
  mustReply: true,
  localReply: true,
  _executeToolForTest: async name => JSON.stringify({
    ok: true,
    tool: name,
    delivered: true,
    message_sent: true,
    terminal_delivery: true,
  }),
  _streamOnceForTest: async () => {
    terminalRounds += 1
    return {
      content: '', reasoningContent: '', aborted: false,
      toolCalls: [{ id: 'terminal-demo', name: 'capability_demo', arguments: '{}' }],
    }
  },
})
assert.equal(terminalRounds, 1, 'explicit terminal_delivery ends capability_demo without another model round')
assert.equal(terminalResult.delivered, true)

let finalSendRounds = 0
const finalSendMessages = []
await callLLM({
  systemPrompt: 'answer once',
  message: '1+1?',
  tools: ['send_message'],
  toolContext: { outputContract: 'explicit_send_only', currentTargetId: 'ID:000001' },
  mustReply: true,
  localReply: false,
  _executeToolForTest: async (name, args) => {
    assert.equal(name, 'send_message')
    finalSendMessages.push(args.content)
    return productionDeliverySuccess
  },
  _streamOnceForTest: async ({ messages }) => {
    finalSendRounds += 1
    if (finalSendRounds === 1) {
      return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'ordinary-final', name: 'send_message', arguments: JSON.stringify({ target_id: 'ID:000001', content: '2' }) }],
      }
    }
    assert(messages.some(entry => String(entry.content || '').includes('If the delivered message was the complete final answer, end the round silently.')))
    assert(messages.some(entry => String(entry.content || '').includes('continue now with an available action tool or find_tool')), 'post-send guidance says a promised action must continue')
    return { content: '', reasoningContent: '', aborted: false, toolCalls: [] }
  },
})
assert.equal(finalSendRounds, 2, 'ordinary delivery is reconsidered once instead of treated as terminal delivery')
assert.deepEqual(finalSendMessages, ['2'], 'an ordinary final send_message is not delivered twice')

let silentRounds = 0
let silentExecutions = 0
const silentResult = await callLLM({
  systemPrompt: 'silent signal',
  message: 'APP_SIGNAL',
  tools: ['send_message'],
  toolContext: { currentTargetId: 'ID:000001' },
  mustReply: false,
  silentSignal: true,
  _executeToolForTest: async () => {
    silentExecutions += 1
    return productionDeliverySuccess
  },
  _streamOnceForTest: async () => {
    silentRounds += 1
    if (silentRounds === 1) {
      return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'silent-send', name: 'send_message', arguments: JSON.stringify({ target_id: 'ID:000001', content: '不应发送' }) }],
      }
    }
    return { content: '', reasoningContent: '', aborted: false, toolCalls: [] }
  },
})
assert.equal(silentExecutions, 0, 'silent signals still suppress the real send_message executor')
assert.equal(silentResult.delivered, false)

let closerRounds = 0
const closerMessages = []
await callLLM({
  systemPrompt: 'answer once without a separate closer',
  message: '给我完整答案',
  tools: ['send_message'],
  toolContext: { currentTargetId: 'ID:000001' },
  mustReply: true,
  localReply: false,
  _executeToolForTest: async (name, args) => {
    closerMessages.push(args.content)
    return productionDeliverySuccess
  },
  _streamOnceForTest: async () => {
    closerRounds += 1
    if (closerRounds === 1) {
      return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'closer-main', name: 'send_message', arguments: JSON.stringify({ target_id: 'ID:000001', content: '这是完整答案，包含已经验证过的全部结果。' }) }],
      }
    }
    if (closerRounds === 2) {
      return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'closer-extra', name: 'send_message', arguments: JSON.stringify({ target_id: 'ID:000001', content: '希望对你有帮助' }) }],
      }
    }
    return { content: '', reasoningContent: '', aborted: false, toolCalls: [] }
  },
})
assert.deepEqual(closerMessages, ['这是完整答案，包含已经验证过的全部结果。'], 'closer dedup still prevents a second outbound message')

let mediaRounds = 0
const mediaMessages = []
await callLLM({
  systemPrompt: 'play media quietly',
  message: '播放音乐',
  tools: ['media_mode', 'send_message'],
  toolContext: { currentTargetId: 'ID:000001' },
  mustReply: true,
  localReply: false,
  _executeToolForTest: async (name, args) => {
    if (name === 'send_message') mediaMessages.push(args.content)
    return name === 'send_message' ? productionDeliverySuccess : JSON.stringify({ ok: true, mode: 'music', action: 'play' })
  },
  _streamOnceForTest: async () => {
    mediaRounds += 1
    if (mediaRounds === 1) {
      return { content: '', reasoningContent: '', aborted: false, toolCalls: [{ id: 'media-play', name: 'media_mode', arguments: JSON.stringify({ mode: 'music', action: 'play' }) }] }
    }
    if (mediaRounds === 2) {
      return { content: '', reasoningContent: '', aborted: false, toolCalls: [{ id: 'media-close', name: 'send_message', arguments: JSON.stringify({ target_id: 'ID:000001', content: '播放中' }) }] }
    }
    return { content: '', reasoningContent: '', aborted: false, toolCalls: [] }
  },
})
assert.deepEqual(mediaMessages, ['🎵'], 'media completion still uses the single emoji closer')

const heartbeatMessages = buildLLMMessages({
  systemPrompt: 'heartbeat test',
  input: 'TICK',
  isTick: true,
  conversationWindow: [{
    role: 'jarvis',
    to_id: 'ID:000001',
    content: 'First observation.',
    timestamp: '2026-07-11T01:28:10+08:00',
  }],
})
const heartbeatContext = heartbeatMessages.find(message => String(message.content || '').includes('Recent verified outbound messages'))?.content || ''
assert(heartbeatContext.includes('First observation.'), 'later heartbeats receive the actual recent outbound content')
assert(heartbeatContext.includes('otherwise silence is the complete action'), 'later heartbeats receive the context-based communication criterion')
assert(heartbeatContext.includes('the last conversational move is yours'), 'an unanswered outbound message is explicitly identified as a human pause')
assert(heartbeatContext.includes('treat the message as received and shown to the user'), 'later heartbeats treat successful delivery as visible to the user')
assert(heartbeatContext.includes('No reply means only that the user has not responded'), 'later heartbeats distinguish no reply from failed delivery')

const repliedHeartbeatMessages = buildLLMMessages({
  systemPrompt: 'heartbeat test',
  input: 'TICK',
  isTick: true,
  conversationWindow: [
    { role: 'jarvis', to_id: 'ID:000001', content: 'First observation.', timestamp: '2026-07-11T01:28:10+08:00' },
    { role: 'user', from_id: 'ID:000001', content: 'I saw it.', timestamp: '2026-07-11T01:29:10+08:00' },
  ],
})
const repliedHeartbeatContext = repliedHeartbeatMessages.find(message => String(message.content || '').includes('Recent verified outbound messages'))?.content || ''
assert(!repliedHeartbeatContext.includes('the last conversational move is yours'), 'a real user reply clears the unanswered-message pause cue')

console.log('PASS outbound awareness keeps sent messages visible before another communication decision')
