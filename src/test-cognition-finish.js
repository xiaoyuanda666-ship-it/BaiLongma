import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-cognition-finish-'))
process.env.BAILONGMA_USER_DIR = dir
process.env.BAILONGMA_RESOURCES_DIR = process.cwd()
const { callLLM } = await import('./llm.js')
const { closeDBForTest } = await import('./db.js')
const checkpoint = (mode, decision = 'finish') => ({ content: JSON.stringify({
  response: { mode, reason: mode === 'none' ? '无需再次表达' : '需要回复', text: '' },
  summary: '根据实际结果处理当前回合', expected: '完成后保持安静',
  observation: '以工具投递结果为准', decision,
}) })
const send = { id: 'reply', name: 'send_message', arguments: JSON.stringify({
  target_id: 'ID:000001', format: 'voice', content: '这是一次完整回复。',
}) }
const base = {
  systemPrompt: 'Only explicit tool expressions reach the user.', message: '你好',
  tools: ['send_message', 'read_file'], mustReply: true,
  toolContext: { outputContract: 'explicit_send_only', currentTargetId: 'ID:000001', currentChannel: '语音识别' },
  onCognition() {},
}

try {
  let executions = 0, sends = 0
  const reply = await callLLM({ ...base,
    _streamOnceForTest: async ({ purpose }) => {
      if (purpose === 'cognition') return checkpoint(sends ? 'none' : 'direct')
      executions++
      // Reproduce the provider repeating a send despite finish/none.
      return executions <= 2 ? { content: '', toolCalls: [send] } : { content: '', toolCalls: [] }
    },
    _executeToolForTest: async () => { sends++; return '{"ok":true,"delivered":true,"message_sent":true}' },
  })
  assert.equal(reply.delivered, true)
  assert.equal(executions, 3, 'the agent receives one reminder and chooses to stop on the next execution response')
  assert.equal(sends, 1, 'one voice answer must be sent exactly once')

  const silent = await callLLM({ ...base, message: 'TICK', mustReply: false,
    toolContext: { ...base.toolContext, tickContext: { id: 'quiet-tick', number: 1 } },
    _streamOnceForTest: async ({ purpose }) => {
      return purpose === 'cognition' ? checkpoint('none') : { content: '', toolCalls: [] }
    },
    _executeToolForTest: async () => assert.fail('quiet heartbeat must not send a closing message'),
  })
  assert.equal(silent.delivered, false)

  let steps = 0
  const calls = []
  await callLLM({ ...base,
    _streamOnceForTest: async ({ purpose }) => {
      if (purpose === 'cognition') return steps < 2 ? checkpoint('none', 'continue') : checkpoint(steps === 2 ? 'direct' : 'none')
      if (steps >= 3) return { content: '', toolCalls: [] }
      const toolCalls = steps++ < 2
        ? [{ id: `read-${steps}`, name: 'read_file', arguments: '{"path":"test.txt"}' }] : [send]
      return { content: '', toolCalls }
    },
    _executeToolForTest: async name => {
      calls.push(name)
      return name === 'send_message' ? '{"ok":true,"delivered":true,"message_sent":true}' : '{"ok":true,"content":"verified"}'
    },
  })
  assert.deepEqual(calls, ['read_file', 'read_file', 'send_message'], 'none/continue must preserve silent task work and the final reply')

  let attempts = 0
  await callLLM({ ...base,
    _streamOnceForTest: async ({ purpose }) => purpose === 'cognition'
      ? checkpoint(attempts < 2 ? 'direct' : 'none') : { content: '', toolCalls: attempts < 2 ? [send] : [] },
    _executeToolForTest: async () => ++attempts === 1
      ? '{"ok":false,"delivered":false,"error":"temporary speech failure"}'
      : '{"ok":true,"delivered":true,"message_sent":true}',
  })
  assert.equal(attempts, 2, 'a real failed delivery may recover before finish/none stops execution')
  const { classifyActionContract } = await import('./runtime/action-contract.js')
  let writes = 0
  await callLLM({ ...base, tools: ['write_file', 'send_message'],
    toolContext: { ...base.toolContext, actionContract: classifyActionContract('创建 hello.txt 文件') },
    _streamOnceForTest: async ({ purpose, toolSchemas }) => {
      if (purpose === 'cognition') return checkpoint('none')
      if (writes) return { content: '', toolCalls: [] }
      assert(toolSchemas.some(t => t.function.name === 'write_file'), 'unfinished required action stays available despite finish/none')
      return { content: '', toolCalls: [{ id: 'write', name: 'write_file', arguments: '{"path":"hello.txt","content":"hello"}' }] }
    },
    _executeToolForTest: async name => {
      assert.equal(name, 'write_file')
      writes++
      return '{"ok":true,"path":"hello.txt","bytes":5}'
    },
  })
  assert.equal(writes, 1, 'a premature finish decision cannot skip required work')
  console.log('PASS cognition completion: one reply, silent heartbeat, ongoing/required work, and failed-delivery recovery')
} finally {
  closeDBForTest()
  fs.rmSync(dir, { recursive: true, force: true })
}
