// Run with the app's SQLite ABI:
// ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron src/test-request-performance.js
// All SDK traffic stays on a local SSE server with synthetic content.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-request-performance-'))
process.env.BAILONGMA_USER_DIR = userDir
process.env.BAILONGMA_RESOURCES_DIR = process.cwd()
process.env.BAILONGMA_PERFORMANCE_TRACE = '0'
for (const key of ['DEEPSEEK_API_KEY', 'MINIMAX_API_KEY', 'OPENAI_API_KEY', 'DASHSCOPE_API_KEY',
  'MOONSHOT_API_KEY', 'ZHIPU_API_KEY', 'MIMO_API_KEY']) delete process.env[key]

const {
  createPerformanceTrace, runWithPerformanceTrace, getPerformanceTrace,
  markPerformance, measurePerformance, withoutPerformanceTrace, flushPerformanceTraces,
} = await import('./runtime/performance-trace.js')

const event = (trace, name) => trace.events.find(item => item.name === name)
const allEvents = (trace, name) => trace.events.filter(item => item.name === name)
const metricDifference = (trace, to, from) => {
  const end = event(trace, to)
  const start = event(trace, from)
  assert.ok(end, `missing ${to}`)
  assert.ok(start, `missing ${from}`)
  return Math.round((end.atMs - start.atMs) * 100) / 100
}

// Async context and query stage attribution must survive overlapping promises.
const concurrent = ['one', 'two'].map(channel => createPerformanceTrace({ channel }))
await Promise.all(concurrent.map((trace, index) => runWithPerformanceTrace(trace, () =>
  measurePerformance(`prepare.${index}`, async () => {
    await delay(index ? 1 : 5)
    assert.equal(getPerformanceTrace(), trace)
    markPerformance('unit.ready', { index, content: 'SECRET_METADATA', authorization: 'SECRET_KEY' })
    trace.recordQuery({ operation: 'get', fingerprint: 'SELECT ?', durationMs: index + 1, rows: 1 })
    await withoutPerformanceTrace(async () => {
      await delay(1)
      assert.equal(getPerformanceTrace(), null)
      markPerformance('must.not.appear')
    })
  }),
)))
for (const [index, trace] of concurrent.entries()) {
  const snapshot = trace.snapshot()
  assert.equal(event(snapshot, 'unit.ready').index, index)
  assert.equal(event(snapshot, 'must.not.appear'), undefined)
  assert.equal(snapshot.queries[0].stage, `prepare.${index}`)
  assert.equal(snapshot.summary.databaseOperations, 1)
  assert.equal(snapshot.summary.databaseMs, index + 1)
  assert.equal(snapshot.spans.length, 1)
  assert.ok(!JSON.stringify(snapshot).includes('SECRET'))
}
assert.equal(getPerformanceTrace(), null)
const unitFailure = new Error('synthetic preparation failure')
await runWithPerformanceTrace(concurrent[0], async () => {
  assert.throws(() => measurePerformance('sync.failure', () => { throw unitFailure }), error => error === unitFailure)
  await assert.rejects(measurePerformance('async.failure', async () => { throw unitFailure }), error => error === unitFailure)
})
assert.ok(concurrent[0].snapshot().spans.some(span => span.name === 'sync.failure'))
assert.ok(concurrent[0].snapshot().spans.some(span => span.name === 'async.failure'))

const finished = createPerformanceTrace({ channel: 'late' })
let lateWork
runWithPerformanceTrace(finished, () => {
  markPerformance('before.finish')
  lateWork = delay(5).then(() => {
    markPerformance('late.background')
    finished.recordQuery({ operation: 'all', fingerprint: 'SELECT ?', durationMs: 999, rows: 100 })
  })
})
finished.finish({ status: 'aborted' })
const finishedSnapshot = finished.snapshot()
await lateWork
finished.finish({ status: 'ok' })
assert.deepEqual(finished.snapshot(), finishedSnapshot, 'late background work and repeated finish cannot mutate a finalized trace')
assert.equal(finishedSnapshot.status, 'aborted')
const bounded = createPerformanceTrace({ channel: 'bounded' })
for (let index = 0; index < 1200; index++) bounded.mark('bounded.event', { index })
assert.equal(bounded.snapshot().events.length, 1000)
assert.ok(bounded.snapshot().dropped >= 200)
const empty = createPerformanceTrace().snapshot()
assert.equal(empty.summary.dispatchToFirstDeltaMs, null, 'missing measurements are null, never a fabricated zero')

const SECRET_PROMPT = 'PRIVATE_PROMPT_NEVER_IN_PERFORMANCE'
const SECRET_REASONING = 'PRIVATE_REASONING_NEVER_IN_PERFORMANCE'
const SECRET_TEXT = 'PRIVATE_OUTPUT_NEVER_IN_PERFORMANCE'
const SECRET_TOOL_RESULT = 'PRIVATE_TOOL_RESULT_NEVER_IN_PERFORMANCE'
let scenario
const server = http.createServer(async (req, res) => {
  const current = scenario
  try {
    let body = ''
    for await (const chunk of req) body += chunk
    current.requests.push(JSON.parse(body))
    const requestIndex = current.requests.length
    const failedAttempts = current.mode === 'sdk-retry' ? 1 : current.mode === 'application-retry' ? 3 : 0
    if (requestIndex <= failedAttempts || current.mode === 'error') {
      res.writeHead(current.mode === 'error' ? 404 : 503, {
        'Content-Type': 'application/json', 'retry-after-ms': '30',
      })
      res.end(JSON.stringify({ error: { message: current.mode === 'error' ? 'unsupported endpoint' : 'temporarily unavailable' } }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.flushHeaders()
    const emit = value => res.write(`data: ${JSON.stringify(value)}\n\n`)
    const chat = current.format === 'chat-completions'
    const emitChat = delta => emit({ choices: [{ index: 0, delta, finish_reason: null }] })
    res.write(': transport heartbeat\n\n')
    if (chat) emitChat({ role: 'assistant', content: '' })
    else emit({ type: 'response.created', response: { id: 'test', status: 'in_progress', output: [] } })
    // A role/lifecycle event is deliberately well before any model output.
    await delay(35)
    if (res.destroyed) return
    const toolRound = current.mode === 'tool' && requestIndex === 1
    if (toolRound) {
      if (chat) {
        // Arguments can arrive before the tool name; this is still model output.
        emitChat({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { arguments: '{"path":' } }] })
        await delay(25)
        emitChat({ tool_calls: [{ index: 0, function: { name: 'read_file', arguments: '"test.txt"}' } }] })
        emit({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      } else {
        emit({ type: 'response.output_item.added', output_index: 0,
          item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: '', arguments: '' } })
        emit({ type: 'response.function_call_arguments.delta', item_id: 'fc_a', output_index: 0, delta: '{"path":' })
        await delay(25)
        emit({ type: 'response.function_call_arguments.done', item_id: 'fc_a', output_index: 0,
          name: 'read_file', arguments: '{"path":"test.txt"}' })
        emit({ type: 'response.completed', response: { status: 'completed', output: [
          { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'read_file', arguments: '{"path":"test.txt"}' },
        ] } })
      }
    } else {
      if (chat) emitChat({ reasoning_content: SECRET_REASONING })
      else emit({ type: 'response.reasoning_summary_text.delta', delta: SECRET_REASONING })
      await delay(25)
      if (res.destroyed) return
      if (chat) {
        emitChat({ content: SECRET_TEXT })
        emit({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 73, completion_tokens: 9, total_tokens: 82 } })
      } else {
        emit({ type: 'response.output_text.delta', item_id: 'msg_a', output_index: 0, delta: SECRET_TEXT })
        emit({ type: 'response.completed', response: { status: 'completed',
          output: [{ type: 'message', id: 'msg_a', role: 'assistant', content: [{ type: 'output_text', text: SECRET_TEXT }] }],
          usage: { input_tokens: 73, output_tokens: 9, total_tokens: 82 } } })
      }
    }
    res.end(chat ? 'data: [DONE]\n\n' : '')
  } catch (error) {
    current.error = error
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
  const { config } = await import('./config.js')
  const { callLLM } = await import('./llm.js')
  ;({ closeDBForTest } = await import('./db.js'))
  const run = async (format, mode = 'text') => {
    Object.assign(config, {
      provider: 'custom', apiFormat: format, model: 'local-performance-test',
      baseURL, apiKey: 'PRIVATE_TEST_KEY', needsActivation: false,
    })
    scenario = { format, mode, requests: [] }
    const trace = createPerformanceTrace({ channel: 'test', clientPrepareMs: 4, clientSerializeMs: 1 })
    const controller = new AbortController()
    let result
    let failure
    await runWithPerformanceTrace(trace, async () => {
      trace.mark('request.received')
      await delay(3)
      trace.mark('queue.enqueued')
      await delay(4)
      trace.mark('turn.started')
      try {
        if (mode === 'auxiliary') {
          await measurePerformance('prepare.memory_refresh', () => callLLM({
            systemPrompt: SECRET_PROMPT, message: 'Evaluate a synthetic memory.',
            tools: [], localReply: true, mustReply: false,
          }))
          trace.mark('prepare.complete')
        }
        result = await callLLM({
          systemPrompt: SECRET_PROMPT, message: 'Return synthetic test output.',
          tools: mode === 'tool' ? ['read_file'] : [], localReply: true, mustReply: false,
          signal: controller.signal,
          onStream: value => {
            if (mode === 'abort' && value.event === 'chunk') controller.abort()
          },
          _executeToolForTest: async name => {
            assert.equal(name, 'read_file')
            await delay(5)
            return JSON.stringify({ ok: true, content: SECRET_TOOL_RESULT })
          },
        })
      } catch (error) { failure = error }
      trace.finish({ status: failure ? 'error' : result?.aborted ? 'aborted' : 'ok' })
    })
    assert.ifError(scenario.error)
    const snapshot = trace.snapshot()
    const json = JSON.stringify(snapshot)
    for (const secret of [SECRET_PROMPT, SECRET_REASONING, SECRET_TEXT, SECRET_TOOL_RESULT, 'PRIVATE_TEST_KEY']) {
      assert.ok(!json.includes(secret), `performance trace leaked ${secret}`)
    }
    assert.ok(event(snapshot, 'model.fetch.dispatch').requestBytes > 0)
    assert.equal(snapshot.summary.queueMs, metricDifference(snapshot, 'turn.started', 'queue.enqueued'))
    const mainDispatch = snapshot.events.find(value => value.name === 'model.fetch.dispatch' && value.auxiliary !== true)
    assert.equal(snapshot.summary.prepareMs,
      Math.round((mainDispatch.atMs - event(snapshot, 'turn.started').atMs) * 100) / 100)
    return { snapshot, result, failure, requests: scenario.requests }
  }

  for (const format of ['responses', 'chat-completions']) {
    const { snapshot, result, failure, requests } = await run(format)
    assert.ifError(failure)
    assert.equal(result.content, SECRET_TEXT)
    assert.equal(requests.length, 1)
    assert.equal(snapshot.status, 'ok')
    assert.ok(metricDifference(snapshot, 'model.first_delta', 'model.fetch.first_event') >= 15,
      'metadata/empty role and heartbeats must not be counted as first token')
    assert.ok(metricDifference(snapshot, 'model.first_text', 'model.first_reasoning') >= 15,
      'first reasoning and first visible answer must be distinguished')
    assert.equal(snapshot.summary.dispatchToFirstDeltaMs,
      metricDifference(snapshot, 'model.first_delta', 'model.fetch.dispatch'))
    assert.equal(event(snapshot, 'model.first_delta').modelAttempt, 1)
    assert.equal(event(snapshot, 'model.first_delta').fetchAttempt, 1)
    assert.equal(event(snapshot, 'model.usage').inputTokens, 73)
    assert.equal(event(snapshot, 'model.usage').outputTokens, 9)
    assert.equal(event(snapshot, 'model.usage').usageAvailable, true)

    const tools = await run(format, 'tool')
    assert.ifError(tools.failure)
    assert.equal(tools.requests.length, 2)
    assert.ok(event(tools.snapshot, 'model.first_delta').atMs <= event(tools.snapshot, 'model.first_tool').atMs)
    assert.equal(event(tools.snapshot, 'model.first_tool').modelAttempt, 1)
    assert.equal(event(tools.snapshot, 'model.first_text').modelAttempt, 2)
    assert.deepEqual(allEvents(tools.snapshot, 'model.usage').map(value => value.usageAvailable), [false, true],
      'absent provider usage must not masquerade as a real zero-token measurement')
    assert.deepEqual(allEvents(tools.snapshot, 'model.fetch.dispatch').map(value => value.fetchAttempt), [1, 1])
    assert.ok(metricDifference(tools.snapshot, 'model.first_tool', 'model.fetch.first_event') >= 15)

    const sdkRetry = await run(format, 'sdk-retry')
    assert.ifError(sdkRetry.failure)
    assert.equal(sdkRetry.requests.length, 2)
    assert.deepEqual(allEvents(sdkRetry.snapshot, 'model.fetch.dispatch')
      .map(value => [value.modelAttempt, value.fetchAttempt]), [[1, 1], [1, 2]])
    const successfulDispatch = allEvents(sdkRetry.snapshot, 'model.fetch.dispatch')[1]
    assert.equal(sdkRetry.snapshot.summary.dispatchToFirstDeltaMs,
      Math.round((event(sdkRetry.snapshot, 'model.first_delta').atMs - successfulDispatch.atMs) * 100) / 100)
    assert.ok(sdkRetry.snapshot.summary.firstDispatchToFirstDeltaMs - sdkRetry.snapshot.summary.dispatchToFirstDeltaMs >= 20)

    const failed = await run(format, 'error')
    assert.match(failed.failure?.message, /unsupported endpoint/)
    assert.equal(failed.snapshot.status, 'error')
    assert.equal(failed.snapshot.summary.dispatchToFirstDeltaMs, null)
    assert.ok(event(failed.snapshot, 'model.attempt.error'))

    const aborted = await run(format, 'abort')
    assert.ifError(aborted.failure)
    assert.equal(aborted.result.aborted, true)
    assert.equal(aborted.snapshot.status, 'aborted')
    assert.equal(event(aborted.snapshot, 'model.first_text'), undefined)
    assert.ok(event(aborted.snapshot, 'model.first_reasoning'))
  }

  const applicationRetry = await run('chat-completions', 'application-retry')
  assert.ifError(applicationRetry.failure)
  assert.equal(applicationRetry.requests.length, 4)
  assert.deepEqual(allEvents(applicationRetry.snapshot, 'model.fetch.dispatch')
    .map(value => [value.modelAttempt, value.fetchAttempt]), [[1, 1], [1, 2], [1, 3], [2, 1]])
  assert.equal(event(applicationRetry.snapshot, 'model.first_delta').modelAttempt, 2)
  assert.equal(event(applicationRetry.snapshot, 'model.retry').delayMs, 800)
  assert.ok(applicationRetry.snapshot.spans.some(span => span.name === 'model.retry_backoff' && span.durationMs >= 750))
  assert.ok(applicationRetry.snapshot.summary.firstDispatchToFirstDeltaMs - applicationRetry.snapshot.summary.dispatchToFirstDeltaMs >= 800)

  const auxiliary = await run('responses', 'auxiliary')
  assert.ifError(auxiliary.failure)
  assert.equal(auxiliary.requests.length, 2)
  const dispatches = allEvents(auxiliary.snapshot, 'model.fetch.dispatch')
  const deltas = allEvents(auxiliary.snapshot, 'model.first_delta')
  assert.deepEqual(dispatches.map(value => value.auxiliary), [true, false])
  assert.deepEqual(deltas.map(value => value.auxiliary), [true, false])
  assert.deepEqual(dispatches.map(value => value.modelAttempt), [1, 2])
  const receivedAt = event(auxiliary.snapshot, 'request.received').atMs
  assert.equal(auxiliary.snapshot.summary.receivedToDispatchMs, Math.round((dispatches[1].atMs - receivedAt) * 100) / 100,
    'preparation evaluator dispatch must not replace the primary model dispatch')
  assert.equal(auxiliary.snapshot.summary.receivedToFirstDeltaMs, Math.round((deltas[1].atMs - receivedAt) * 100) / 100,
    'preparation evaluator output must not count as the user reply first delta')
  assert.equal(auxiliary.snapshot.summary.dispatchToFirstDeltaMs,
    Math.round((deltas[1].atMs - dispatches[1].atMs) * 100) / 100)
  assert.equal(auxiliary.snapshot.summary.receivedToFirstTextMs,
    Math.round((allEvents(auxiliary.snapshot, 'model.first_text')[1].atMs - receivedAt) * 100) / 100)
  assert.ok(auxiliary.snapshot.spans.some(span => span.name === 'prepare.memory_refresh' && span.durationMs >= 35))
  assert.ok(auxiliary.snapshot.summary.prepareMs >= 35, 'auxiliary LLM latency remains part of preparation')
  console.log('PASS request performance scopes, privacy, lifecycle, SDK SSE TTFT, tools, SDK/application retries, auxiliary isolation, usage, abort and errors')
} finally {
  await flushPerformanceTraces()
  closeDBForTest?.()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  fs.rmSync(userDir, { recursive: true, force: true })
}
