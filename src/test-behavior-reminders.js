import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-behavior-reminders-'))
process.env.BAILONGMA_USER_DIR = dir
process.env.BAILONGMA_RESOURCES_DIR = process.cwd()
const { callLLM } = await import('./llm.js')
const { config } = await import('./config.js')
const { executeTool } = await import('./capabilities/executor.js')
const { executeExpression } = await import('./runtime/expression.js')
const { deliverMessage, recordOutboundFailure } = await import('./runtime/delivery.js')
const { closeDBForTest, getDB } = await import('./db.js')
const { createBehaviorReminderState, behaviorReminder, behaviorActionKey, observeBehaviorReminders } = await import('./runtime/behavior-reminders.js')
const { inferToolStatus } = await import('./capabilities/tool-audit.js')
const { getStatus, consumeTick } = await import('./ticker.js')
const parse = JSON.parse
const args = { target_id: 'ID:000001', format: 'voice', content: '已发送的完整答案。' }
const tool = (name, args, id = name) => ({ id, name, arguments: JSON.stringify(args) })
const empty = { content: '', toolCalls: [] }
const checkpoint = { content: JSON.stringify({ response: { mode: 'none', reason: '已完成，无需表达', text: '' }, summary: '结束本轮', expected: '无新增操作', observation: '依据之前结果', decision: 'finish' }) }

try {
  const ledger = createBehaviorReminderState()
  const ctx = { behaviorReminders: ledger, behaviorRound: 0 }
  observeBehaviorReminders(ledger, 0)
  const first = behaviorReminder(ctx, { tool: 'send_message', args, reason: 'already sent', evidence: { delivered: true } })
  assert.equal(parse(first).executed, false)
  assert.equal(inferToolStatus(first), 'reminded')
  assert.equal(behaviorReminder(ctx, { tool: 'send_message', args, reason: 'another layer' }), first)
  observeBehaviorReminders(ledger, 1)
  assert.equal(behaviorReminder({ ...ctx, behaviorRound: 1 }, { tool: 'send_message', args, reason: 'another layer' }), null)
  assert(behaviorReminder({ ...ctx, behaviorRound: 1 }, { tool: 'send_message', args: { ...args, target_id: 'ID:000002' }, reason: 'other recipient' }))
  assert.equal(behaviorActionKey('send_message', args), behaviorActionKey('express', { content: args.content, format: args.format, target_id: args.target_id, channel: 'TUI' }))

  for (const apiFormat of ['responses', 'chat-completions']) {
    config.apiFormat = apiFormat
    let step = 0, spoken = 0
    const results = []
    const turnId = `reminder-${apiFormat}`
    const result = await callLLM({
      systemPrompt: 'Test one-time feedback.', message: '你好', mustReply: true, tools: ['send_message'],
      toolContext: { outputContract: 'explicit_send_only', currentTargetId: args.target_id, replyTurnId: turnId },
      onToolCall: (name, args, result) => results.push(parse(result)),
      _streamOnceForTest: async ({ messages }) => {
        step++
        if (step === 1) return { content: '', toolCalls: [tool('send_message', args)] }
        if (step === 2) {
          assert(messages.some(m => String(m.content || m.output || '').includes('"delivered":true')), 'the agent sees actual delivery success')
          return { content: '', toolCalls: [tool('send_message', args, 'duplicate-1'), tool('send_message', args, 'duplicate-2')] }
        }
        if (step === 3 || step === 4) {
          assert(JSON.stringify(messages).includes('behavior_reminder'), 'reminder is in actual protocol history before retry')
          return { content: '', toolCalls: [tool('send_message', args)] }
        }
        return empty
      },
      _executeToolForTest: (name, args, context) => executeExpression(args, context, {
        deliver: deliverMessage,
        speak: async () => { spoken++; return { id: `${turnId}-${spoken}`, segments: [{ path: 'audio/test.mp3' }] } },
      }),
    })
    assert.equal(result.delivered, true)
    assert.equal(spoken, 3, 'initial send plus two informed retries; no synthesis for either call in the blocked batch')
    assert.equal(results.filter(r => r.message_sent).length, 3)
    const reminders = results.filter(r => r.advisory)
    assert.equal(reminders.length, 2, 'same preplanned batch cannot acknowledge its own reminder')
    assert.deepEqual(reminders[0], reminders[1], 'one reminder reused, not multiple escalating failures')
    assert.equal(reminders[0].evidence.previous_action.result.delivered, true)
    console.log(`PASS ${apiFormat}: success evidence, reminder history, same-batch isolation, informed retries through real delivery and voice`)
  }

  let executions = 0, step = 0
  await callLLM({ systemPrompt: 'Test failure recovery.', message: 'inspect', tools: ['read_file'],
    _streamOnceForTest: async () => ++step <= 5 ? { content: '', toolCalls: [tool('read_file', { path: 'missing.txt' })] } : empty,
    _executeToolForTest: async () => { executions++; return '{"ok":false,"error":"ENOENT"}' },
  })
  assert.equal(executions, 4, 'repeated failures remind once, then real retries reach the tool')

  let checkpointCalls = 0, realCalls = 0
  await callLLM({ systemPrompt: 'Test checkpoint advice.', message: 'TICK', tools: ['read_file'], onCognition() {},
    toolContext: { outputContract: 'explicit_send_only' },
    _streamOnceForTest: async ({ purpose }) => {
      if (purpose === 'cognition') return checkpoint
      return ++checkpointCalls <= 2 ? { content: '', toolCalls: [tool('read_file', { path: 'test.txt' })] } : empty
    },
    _executeToolForTest: async () => { realCalls++; return '{"ok":true,"content":"data"}' },
  })
  assert.equal(realCalls, 1, 'finish/none is one reminder, not forced termination or removed tools')

  let budgetRequests = 0, budgetExecutions = 0
  const budgetResults = []
  await callLLM({ systemPrompt: 'Test resource limit.', message: 'inspect', tools: ['read_file'],
    toolLoopLimits: { maxTotalCalls: 2 },
    onToolCall: (name, args, result) => budgetResults.push(parse(result)),
    _streamOnceForTest: async () => ++budgetRequests <= 4
      ? { content: '', toolCalls: [tool('read_file', { path: 'test.txt' })] } : empty,
    _executeToolForTest: async () => { budgetExecutions++; return '{"ok":true,"content":"data"}' },
  })
  assert.equal(budgetExecutions, 2)
  assert.equal(budgetResults.filter(r => r.error === 'tool_budget_exhausted').length, 2, 'resource bounds do not become one-time advice')

  const state = createBehaviorReminderState()
  const context = { behaviorReminders: state, behaviorRound: 0, replyTurnId: 'direct-delivery' }
  const textArgs = { ...args, format: 'text', content: 'Direct transport test' }
  observeBehaviorReminders(state, 0)
  assert.equal(parse(await deliverMessage(textArgs, context)).message_sent, true)
  const duplicate = parse(await deliverMessage(textArgs, context))
  assert.equal(duplicate.advisory, true)
  assert.equal(duplicate.evidence.delivered, true)
  observeBehaviorReminders(state, 1)
  context.behaviorRound = 1
  assert.equal(parse(await deliverMessage(textArgs, context)).message_sent, true)

  const pendingState = createBehaviorReminderState()
  let release
  const pendingContext = { behaviorReminders: pendingState, behaviorRound: 0, replyTurnId: 'in-flight',
    prepareSpeech: () => new Promise(resolve => { release = resolve }) }
  const pending = deliverMessage({ ...args, content: 'in-flight probe' }, pendingContext)
  await Promise.resolve()
  observeBehaviorReminders(pendingState, 10)
  assert.equal(parse(await deliverMessage({ ...args, content: 'in-flight probe' }, pendingContext)).error, 'outbound_in_flight')
  release({ segments: [{ path: 'audio/test.mp3' }] })
  await pending

  const failedArgs = { ...textArgs, content: 'previous failure probe' }
  recordOutboundFailure({ toId: failedArgs.target_id, channel: 'TUI', externalTargetId: '', content: failedArgs.content, reason: 'temporary transport outage' })
  const failures = createBehaviorReminderState()
  const failCtx = { behaviorReminders: failures, behaviorRound: 0, replyTurnId: 'failure-recovery' }
  observeBehaviorReminders(failures, 0)
  assert.equal(parse(await deliverMessage(failedArgs, failCtx)).advisory, true)
  observeBehaviorReminders(failures, 1)
  assert.equal(parse(await deliverMessage(failedArgs, { ...failCtx, behaviorRound: 1 })).message_sent, true)

  const tickState = createBehaviorReminderState()
  const tickCtx = { behaviorReminders: tickState, behaviorRound: 0 }
  const tickArgs = { seconds: 123, ttl: 5, reason: 'test' }
  await executeTool('set_tick_interval', tickArgs, tickCtx)
  consumeTick()
  assert.equal(parse(await executeTool('set_tick_interval', tickArgs, tickCtx)).advisory, true)
  assert.equal(getStatus().ttl, 4)
  observeBehaviorReminders(tickState, 1)
  await executeTool('set_tick_interval', tickArgs, { ...tickCtx, behaviorRound: 1 })
  assert.equal(getStatus().ttl, 5, 'informed repetition can intentionally renew the interval')

  const memoryState = createBehaviorReminderState()
  const memoryContext = { behaviorReminders: memoryState, behaviorRound: 0, selfPerception: { mirror: { exact: true } } }
  const memoryArgs = { memories: [{ mem_id: 'fact_reminder_test', type: 'fact', title: 'test', content: 'a verified preference' }] }
  assert.equal(parse(await executeTool('upsert_memory', memoryArgs, memoryContext)).advisory, true)
  observeBehaviorReminders(memoryState, 1)
  assert.equal(parse(await executeTool('upsert_memory', memoryArgs, { ...memoryContext, behaviorRound: 1 })).ok, true)
  assert.equal(getDB().prepare("SELECT count(*) AS n FROM memories WHERE mem_id='fact_reminder_test'").get().n, 1)
  console.log('PASS non-message retries, checkpoint advice, transport evidence, in-flight lock, failure recovery, interval renewal and memory reminders')
} finally {
  closeDBForTest()
  fs.rmSync(dir, { recursive: true, force: true })
}
