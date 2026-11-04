import assert from 'node:assert/strict'
import { planCognitionRound } from './runtime/cognition-cycle.js'

const noResponse = { mode: 'none', reason: 'No extra response needed', text: '' }
const messages = [{ role: 'user', content: '读取文件并验证内容' }]
const events = []
const request = async ({ messages: input, toolSchemas, purpose, thinking, jsonOutput }) => {
  assert.deepEqual(toolSchemas, [])
  assert.equal(purpose, 'cognition')
  assert.equal(thinking, false)
  assert.equal(jsonOutput, true)
  assert.match(input.at(-1).content, /private chain-of-thought/)
  return { content: JSON.stringify({ response: noResponse, summary: '读取文件', expected: '获得内容', observation: '尚无工具结果', decision: 'continue' }) }
}
await planCognitionRound({ request, messages, toolSchemas: [{ function: { name: 'read_file' } }], round: 0, emit: e => events.push(e) })
assert.deepEqual(events.map(e => e.phase), ['planning', 'plan'])
assert.match(messages.at(-1).content, /读取文件/)
messages.push({ role: 'tool', content: 'file not found' })
await planCognitionRound({ request: async ({ messages: input }) => {
  assert.equal(input.at(-2).content, 'file not found')
  return { content: JSON.stringify({ response: noResponse, summary: '先列目录确认路径', expected: '找到文件', observation: '原路径不存在', decision: 'replan' }) }
}, messages, toolSchemas: [], round: 1, emit: e => events.push(e) })
assert.equal(events.at(-1).decision, 'replan')
assert.match(messages.at(-1).content, /先列目录/)
for (const result of [{ content: 'not json' }, { content: '{}'}, { content: '{}', incomplete: true }, { content: '{}', toolCalls: [{}] }]) {
  const before = messages.length
  await assert.rejects(planCognitionRound({ request: async () => result, messages, toolSchemas: [], round: 2, emit() {} }))
  assert.equal(messages.length, before)
}
await assert.rejects(planCognitionRound({ request: async () => ({ aborted: true }), messages, toolSchemas: [], round: 2, emit() {} }), { name: 'AbortError' })
console.log('PASS cognition planning, evidence comparison, replanning, invalid-output and abort guards')

const { callLLM } = await import('./llm.js')
const order = []
const seen = []
const checkpoints = [
  { response: noResponse, summary: '读取原路径', expected: '获得文件内容', observation: '尚未执行', decision: 'continue' },
  { response: noResponse, summary: '改用确认后的路径', expected: '获得文件内容', observation: '原路径不存在', decision: 'replan' },
  { response: noResponse, summary: '回答已验证的内容', expected: '用户收到结果', observation: '文件返回 hello', decision: 'finish' },
]
const answer = await callLLM({
  systemPrompt: 'Read the file.', message: 'Read report.txt', tools: ['read_file'],
  mustReply: true, localReply: true, toolContext: { currentTargetId: 'ID:test' },
  onCognition: e => { if (e.summary) { seen.push(e); order.push(e.decision) } },
  _streamOnceForTest: async ({ purpose, round, messages, toolSchemas }) => {
    if (purpose === 'cognition') {
      if (round > 0) assert.ok(messages.some(m => (m.output || m.content || '').includes(round === 1 ? 'not found' : 'hello')))
      return { content: JSON.stringify(checkpoints[round]) }
    }
    assert.match(messages.at(-1).content, new RegExp(checkpoints[round].summary))
    if (round === 2) {
      assert(toolSchemas.some(t => t.function.name === 'read_file'), 'checkpoint advice must not remove task tools')
      return { content: 'hello', toolCalls: [] }
    }
    return { content: '', toolCalls: [{ id: `call_${round}`, name: 'read_file', arguments: JSON.stringify({ path: round === 0 ? 'missing.txt' : 'report.txt' }) }] }
  },
  _executeToolForTest: async (name, args) => {
    if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
    order.push(args.path)
    return JSON.stringify(args.path === 'missing.txt' ? { ok: false, error: 'not found' } : { ok: true, content: 'hello' })
  },
})
assert.deepEqual(order, ['continue', 'missing.txt', 'replan', 'report.txt', 'finish'])
assert.equal(answer.content, 'hello')
assert.equal(seen.length, 3)
let executed = 0, executionRequests = 0
const reminderResults = []
await callLLM({
  systemPrompt: 'test', message: 'test', tools: ['read_file'], onCognition() {},
  onToolCall: (name, args, result) => reminderResults.push(JSON.parse(result)),
  _streamOnceForTest: async ({ purpose }) => purpose === 'cognition'
    ? { content: JSON.stringify({ ...checkpoints[2], decision: 'blocked' }) }
    : { content: '', toolCalls: ++executionRequests <= 2 ? [{ name: 'read_file', arguments: '{"path":"test.txt"}' }] : [] },
  _executeToolForTest: async () => { executed++; return '{"ok":true,"content":"verified"}' },
})
assert.equal(executed, 1, 'agent may reconsider a blocked checkpoint after one reminder')
assert.equal(reminderResults[0].advisory, true)
const { createEventHistory } = await import('./runtime/event-history.js')
const saved = []
const persist = createEventHistory({ insertBrainUiEvent: e => saved.push(e) })
persist('message_received', {}, '2026-11-02T00:00:00Z')
persist('cognition', seen[0], '2026-11-02T00:00:01Z')
assert.equal(saved.at(-1).path, 'l1')
assert.equal(saved.at(-1).eventType, 'cognition')
assert.equal(saved.at(-1).payload.summary, checkpoints[0].summary)
console.log('PASS complete plan → failed tool → replan → successful tool → assessment loop, terminal guard and event persistence')

// Communication is decided in the checkpoint and delivered before execution inference.
async function runResponseScenario({ mode = 'acknowledge', silentSignal = false, mustReply = true,
  failAck = false, cancelBeforeAck = false, background = false } = {}) {
  const steps = [], sends = [], callbacks = [], responseEvents = []
  const controller = new AbortController()
  const response = { mode, reason: mode === 'acknowledge' ? '查询需要等待，先说明将做什么' : '无需额外回应', text: mode === 'acknowledge' ? '我会先查询资料，再核对来源。' : '' }
  const output = await callLLM({
    systemPrompt: 'test', message: '查资料', tools: ['web_search'],
    mustReply, silentSignal, localReply: true, signal: controller.signal,
    toolContext: { currentTargetId: 'ID:test', ...(background ? { outputContract: 'explicit_send_only' } : {}) },
    onCognition(event) { responseEvents.push(event); if (cancelBeforeAck && event.phase === 'plan') controller.abort('cancelled') },
    onToolCall(name, args) { if (args.__ack) callbacks.push(name) },
    _streamOnceForTest: async ({ purpose, round, messages }) => {
      if (purpose === 'cognition') {
        steps.push(`plan:${round}`)
        if (round === 1 && !silentSignal && mustReply && !background && mode === 'acknowledge') {
          assert.match(messages.at(-1).content, /"alreadyResponded":true/)
        }
        return { content: JSON.stringify({ response, summary: '核对来源', expected: '找到资料', observation: '检查结果', decision: round === 0 ? 'continue' : 'finish' }) }
      }
      steps.push(`execute:${round}`)
      if (round === 0 && mode === 'acknowledge' && !silentSignal && mustReply && !background && !failAck) {
        assert.equal(sends.length, 1, 'ack must arrive before the second model request')
        assert.match(messages.at(-1).content, /already sent this acknowledgement/)
      }
      if (mode === 'direct') return { content: '直接回答', toolCalls: [] }
      return round === 0 ? { content: '', toolCalls: [{ id: 'search', name: 'web_search', arguments: '{"query":"AI"}' }] }
        : { content: silentSignal ? '' : '已核对来源，这是查询结果。', toolCalls: [] }
    },
    _executeToolForTest: async (name, args, context) => {
      if (name !== 'send_message') { steps.push('search'); return '{"ok":true,"results":[]}' }
      steps.push(`send:${context.source}`)
      sends.push({ ...args, source: context.source })
      if (failAck && sends.length === 1) return '{"ok":false,"delivered":false}'
      return '{"ok":true,"delivered":true,"message_sent":true}'
    },
  })
  return { steps, sends, callbacks, responseEvents, output }
}
const early = await runResponseScenario()
assert.deepEqual(early.steps, ['plan:0', 'send:ack', 'execute:0', 'search', 'plan:1', 'execute:1', 'send:fallback'])
assert.equal(early.sends.length, 2, 'one acknowledgement and one final answer; no slow-tool duplicate')
assert.equal(early.callbacks.length, 1, 'ack follows the existing UI/voice callback path')
assert.equal(early.output.delivered, true, 'ack must not suppress final-answer delivery')
assert.equal(early.responseEvents.find(event => event.phase === 'assessment').response.mode, 'none')
const direct = await runResponseScenario({ mode: 'direct' })
assert.equal(direct.sends.length, 1)
assert.equal(direct.sends[0].source, 'fallback')
assert.equal(direct.sends[0].content, '直接回答')
const silent = await runResponseScenario({ silentSignal: true })
assert.equal(silent.sends.length, 0)
const background = await runResponseScenario({ mustReply: false, background: true })
assert.equal(background.sends.length, 0)
const failed = await runResponseScenario({ failAck: true })
assert.equal(failed.sends.at(-1).source, 'fallback')
assert.equal(failed.output.delivered, true)
await assert.rejects(runResponseScenario({ cancelBeforeAck: true }), { name: 'AbortError' })
await assert.rejects(planCognitionRound({ request: async () => ({ content: JSON.stringify({ ...checkpoints[0], response: { mode: 'acknowledge', reason: 'need to wait', text: '' } }) }), messages: [], toolSchemas: [], round: 0, emit() {} }), /invalid response decision/)
console.log('PASS response planning: early delivery before execution inference, no duplicate ack, final answer, direct/silent/background paths, failure and cancellation')

// Reproduce malformed checkpoints both before work and after a tool result.
for (const failureRound of [0, 1]) {
  const steps = [], sent = [], lifecycle = []
  const result = await callLLM({
    systemPrompt: 'test', message: '读取文件', tools: ['read_file'], mustReply: true,
    localReply: true, toolContext: { currentTargetId: 'ID:test' },
    onCognition: event => { lifecycle.push(event.phase); if (event.phase === 'unavailable') assert.equal(event.reason, 'invalid_json') },
    _streamOnceForTest: async ({ purpose, round, messages }) => {
      if (purpose === 'cognition') {
        steps.push(`plan:${round}`)
        return { content: round === failureRound ? 'not JSON, never execute this text' : JSON.stringify(checkpoints[0]) }
      }
      assert.equal(messages.some(m => String(m.content).includes('never execute this text')), false)
      steps.push(`execute:${round}`)
      return round === 0
        ? { toolCalls: [{ id: 'read', name: 'read_file', arguments: '{"path":"report.txt"}' }] }
        : { content: '文件内容已核对。', toolCalls: [] }
    },
    _executeToolForTest: async (name, args) => {
      if (name === 'send_message') {
        sent.push(args.content)
        return '{"ok":true,"delivered":true}'
      }
      return '{"ok":true,"content":"hello"}'
    },
  })
  assert.equal(result.delivered, true)
  assert.deepEqual(sent, ['文件内容已核对。'])
  assert.equal(lifecycle.filter(phase => phase === 'unavailable').length, 1)
  if (failureRound === 0) assert.deepEqual(steps, ['plan:0', 'plan:0', 'execute:0', 'execute:1'])
}

// Null JSON, timeouts and real cancellation have distinct outcomes.
const { CognitionUnavailableError } = await import('./runtime/cognition-cycle.js')
await assert.rejects(planCognitionRound({ request: async () => ({ content: 'null' }), messages: [], toolSchemas: [], round: 0, emit() {} }), CognitionUnavailableError)
let timedSignal
const timeoutMessages = []
await assert.rejects(planCognitionRound({
  request: ({ signal }) => { timedSignal = signal; return new Promise(() => {}) },
  messages: timeoutMessages, toolSchemas: [], round: 0, emit() {}, timeoutMs: 10,
}), CognitionUnavailableError)
assert.equal(timedSignal.aborted, true)
assert.deepEqual(timeoutMessages, [])
const interrupted = new AbortController()
await assert.rejects(planCognitionRound({
  request: () => { interrupted.abort('new user input'); return new Promise(() => {}) },
  messages: [], toolSchemas: [], round: 0, emit() {}, signal: interrupted.signal,
}), { name: 'AbortError' })
const providerError = new Error('HTTP 401')
await assert.rejects(callLLM({
  systemPrompt: 'test', message: 'test', tools: ['read_file'], onCognition() {},
  _streamOnceForTest: async () => { throw providerError },
}), error => error === providerError)
console.log('PASS malformed checkpoints degrade once, preserve delivery, time out, and still honor cancellation/provider failures')

// A reasoning-only checkpoint can recover without exposing or replaying reasoning.
for (const first of [
  { content: '', reasoningContent: 'PRIVATE_SENTINEL' },
  { content: 'bad JSON PRIVATE_SENTINEL' },
  { content: JSON.stringify({ ...checkpoints[0], response: { mode: 'direct', reason: 'answer' } }) },
]) {
  const history = [{ role: 'user', content: '读取文件' }]
  const lifecycle = []
  const signals = []
  let attempts = 0
  await planCognitionRound({ messages: history, toolSchemas: [], round: 0,
    emit: event => lifecycle.push(event),
    request: async params => {
      signals.push(params.signal)
      assert(!JSON.stringify(params.messages).includes('PRIVATE_SENTINEL'))
      return ++attempts === 1 ? first : { content: JSON.stringify(checkpoints[0]) }
    },
  })
  assert.equal(attempts, 2)
  assert.equal(signals[0], signals[1], 'repair shares the original deadline')
  assert.equal(history.length, 2)
  assert.deepEqual(lifecycle.map(event => event.phase), ['planning', 'plan'])
  assert(!JSON.stringify(history).includes('PRIVATE_SENTINEL'))
}
let emptyAttempts = 0
await assert.rejects(planCognitionRound({ messages: [], toolSchemas: [], round: 0, emit() {},
  request: async () => { emptyAttempts++; return { content: '', reasoningContent: 'PRIVATE_SENTINEL' } },
}), error => {
  assert.equal(error.code, 'empty_output')
  assert.equal(error.diagnostics.attempts, 2)
  assert.equal(error.diagnostics.contentChars, 0)
  assert(error.diagnostics.reasoningChars > 0)
  assert(!JSON.stringify(error).includes('PRIVATE_SENTINEL'))
  return true
})
assert.equal(emptyAttempts, 2)
let retryAttempts = 0
await assert.rejects(planCognitionRound({ messages: [], toolSchemas: [], round: 0, emit() {}, timeoutMs: 20,
  request: async () => ++retryAttempts === 1 ? { content: '' } : new Promise(() => {}),
}), error => error.code === 'timeout' && error.diagnostics.attempts === 2)
const retryAbort = new AbortController()
let cancelAttempts = 0
await assert.rejects(planCognitionRound({ messages: [], toolSchemas: [], round: 0, emit() {}, signal: retryAbort.signal,
  request: async () => {
    if (++cancelAttempts === 1) return { content: '' }
    retryAbort.abort('cancel repair')
    return new Promise(() => {})
  },
}), { name: 'AbortError' })
console.log('PASS reasoning-only/schema repair, bounded retries, shared deadline, diagnostics privacy and repair cancellation')
