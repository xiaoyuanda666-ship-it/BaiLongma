// Run: node src/test-llm-responses-loop.js

import assert from 'node:assert/strict'
import { callLLM } from './llm.js'

const reasoningItem = {
  type: 'reasoning',
  id: 'rs_native_1',
  summary: [],
  encrypted_content: 'opaque-provider-state',
}
const functionItem = {
  type: 'function_call',
  id: 'fc_native_1',
  call_id: 'call_native_1',
  name: 'read_file',
  arguments: '{"path":"report.txt"}',
  status: 'completed',
}

const executions = []
let rounds = 0
const result = await callLLM({
  systemPrompt: 'Read the file and answer.',
  message: 'What does report.txt say?',
  tools: ['read_file'],
  mustReply: true,
  localReply: true,
  toolContext: { currentTargetId: 'ID:test' },
  _executeToolForTest: async (name, args) => {
    executions.push({ name, args })
    if (name === 'read_file') return JSON.stringify({ ok: true, content: 'hello' })
    if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
    throw new Error(`unexpected tool: ${name}`)
  },
  _streamOnceForTest: async ({ messages }) => {
    rounds += 1
    if (rounds === 1) {
      return {
        content: '',
        reasoningContent: '',
        toolCalls: [{ id: 'call_native_1', itemId: 'fc_native_1', name: 'read_file', arguments: functionItem.arguments }],
        outputItems: [reasoningItem, functionItem],
        aborted: false,
      }
    }

    assert.deepEqual(messages.find(item => item.id === reasoningItem.id), reasoningItem,
      'the exact reasoning Item is replayed on the next stateless request')
    assert.deepEqual(messages.find(item => item.id === functionItem.id), functionItem,
      'the exact function_call Item is replayed on the next stateless request')
    assert.deepEqual(messages.find(item => item.type === 'function_call_output'), {
      type: 'function_call_output',
      call_id: 'call_native_1',
      output: JSON.stringify({ ok: true, content: 'hello' }),
    }, 'tool output is linked with call_id')
    assert.equal(messages.some(item => item.role === 'tool' || Array.isArray(item.tool_calls)), false,
      'the agent loop no longer constructs Chat Completions tool messages')

    return {
      content: 'The file says hello.',
      reasoningContent: '',
      toolCalls: [],
      outputItems: [{
        type: 'message',
        id: 'msg_native_2',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'The file says hello.', annotations: [] }],
      }],
      aborted: false,
    }
  },
})

assert.equal(rounds, 2)
assert.deepEqual(executions.map(entry => entry.name), ['read_file', 'send_message'])
assert.equal(result.content, 'The file says hello.')
assert.equal(result.delivered, true)

console.log('PASS Responses API agent loop replays native Items and call_id-linked tool output')
