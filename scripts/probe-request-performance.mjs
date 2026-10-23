// Run with ELECTRON_RUN_AS_NODE=1 using the project's Electron executable.
// Copies the database with SQLite backup; never starts the app, scheduler,
// connectors or real tools. --live-model opts into provider calls/billing.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const args = process.argv.slice(2)
const option = name => args[args.indexOf(name) + 1]
if (!args.includes('--source-dir') || !args.includes('--output')) {
  throw new Error('Required: --source-dir <user directory> --output <JSON file> [--live-model] [--runs 3]')
}
const source = path.resolve(option('--source-dir'))
const output = path.resolve(option('--output'))
const live = args.includes('--live-model')
const runs = Math.max(1, Math.min(20, Number(option('--runs')) || 3))
const useBrowser = args.includes('--browser')
const useHttp = args.includes('--http') || useBrowser
const varied = args.includes('--varied')
const controlEnabled = !args.includes('--no-control')
const warmEmbedding = args.includes('--warm-embedding')
const probeReasoningNone = args.includes('--probe-reasoning-none')
const maxOutputTokens = Math.max(128, Math.min(2048, Number(option('--max-output-tokens')) || 512))
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-performance-probe-'))
process.env.BAILONGMA_USER_DIR = isolated
process.env.BAILONGMA_PERFORMANCE_TRACE = '0'

const originalConsole = { log: console.log, warn: console.warn, error: console.error }
let suppressedLogCount = 0
for (const name of Object.keys(originalConsole)) console[name] = () => { suppressedLogCount++ }
let closeDB
let server
let stopEvents
let eventsPump
let browserDriver
const report = {
  measuredAt: new Date().toISOString(), liveModel: live, runs, maxOutputTokens,
  useHttp, useBrowser, varied, controlEnabled, warmEmbedding, probeReasoningNone,
  networkRestricted: true, deliverySuppressed: true,
  note: 'Full-context aborted status after a completed model stream is intentional: delivery to real users/tools is suppressed. App startup and busy-queue contention are excluded. --http measures loopback POST through real message/event routes to the first sanitized plain-reply SSE text, not browser paint. Blocked external preparation may understate real latency.',
  samples: [], blockedNetworkRequests: 0, blockedForegroundNetworkRequests: 0, blockedDetachedNetworkRequests: 0,
  blockedNetworkStages: {},
}
try {
  fs.mkdirSync(path.join(isolated, 'data'), { recursive: true })
  const db = new Database(path.join(source, 'data/jarvis.db'), { readonly: true, fileMustExist: true })
  try { await db.backup(path.join(isolated, 'data/jarvis.db')) } finally { db.close() }
  for (const name of ['config.json', 'llm', 'skills', 'voice', 'data/system-info.json',
    'data/geo-weather.json', 'data/installed-software.json', 'data/desktop-shortcuts.json',
    'data/trending.json', 'data/turn-traces.jsonl']) {
    if (fs.existsSync(path.join(source, name))) fs.cpSync(path.join(source, name), path.join(isolated, name), { recursive: true })
  }
  // Existing local embedding cache is read in place, never downloaded by this probe.
  if (fs.existsSync(path.join(source, 'data/models'))) {
    fs.symlinkSync(path.join(source, 'data/models'), path.join(isolated, 'data/models'), 'dir')
  }
  const { config } = await import('../src/config.js')
  const timing = await import('../src/runtime/performance-trace.js')
  const { getDB, closeDBForTest } = await import('../src/db.js')
  closeDB = closeDBForTest
  const { createAgentRuntime } = await import('../src/runtime/agent-host.js')
  const { callLLM } = await import('../src/llm.js')
  const { pushMessage } = await import('../src/inbound-message.js')
  const { popMessage } = await import('../src/queue.js')
  // Permit only the selected model endpoint during the explicit probe call,
  // and never detached thread classifiers, web tools or background fetches.
  const endpoint = new URL(config.baseURL)
  const originalFetch = globalThis.fetch
  let modelPhase = false
  globalThis.fetch = (...fetchArgs) => {
    const url = new URL(typeof fetchArgs[0] === 'string' || fetchArgs[0] instanceof URL ? fetchArgs[0] : fetchArgs[0].url)
    if (live && modelPhase && timing.getPerformanceTrace() && url.origin === endpoint.origin) {
      // Explicit diagnostic-only capability experiment. This never changes
      // production configuration or infers support from a model's name.
      if (probeReasoningNone) {
        if (config.apiFormat !== 'responses' || typeof fetchArgs[1]?.body !== 'string') {
          throw new Error('Reasoning capability probe requires a JSON Responses request')
        }
        const body = JSON.parse(fetchArgs[1].body)
        body.reasoning = { effort: 'none' }
        fetchArgs[1] = { ...fetchArgs[1], body: JSON.stringify(body) }
      }
      return originalFetch(...fetchArgs)
    }
    report.blockedNetworkRequests++
    const stage = timing.getPerformanceStage() || 'detached'
    report.blockedNetworkStages[stage] = (report.blockedNetworkStages[stage] || 0) + 1
    if (timing.getPerformanceTrace()) report.blockedForegroundNetworkRequests++
    else report.blockedDetachedNetworkRequests++
    return Promise.reject(new Error('Diagnostic probe disabled background/external network'))
  }
  report.provider = config.provider
  report.model = config.model
  report.apiFormat = config.apiFormat
  report.thinking = config.thinking === true
  report.reasoningControl = config.reasoningControl
  if (warmEmbedding) {
    const { getEmbeddingCredentials } = await import('../src/config.js')
    const { warmupLocalEmbedding } = await import('../src/embedding-local.js')
    report.embeddingWarmed = await warmupLocalEmbedding(getEmbeddingCredentials()?.model)
  }
  let runTurn
  let activeSample
  const invokeModel = async input => {
    if (!live) return { content: '', aborted: true, delivered: false }
    modelPhase = true
    try {
      const result = await callLLM({
        ...input, mustReply: false, silentSignal: true, localReply: true, maxTokens: maxOutputTokens,
        toolLoopLimits: { maxRounds: 1 },
        onToolCall: undefined,
        _executeToolForTest: async () => JSON.stringify({ ok: false, diagnostic: true }),
      })
      return { ...result, aborted: true, delivered: false }
    } finally { modelPhase = false }
  }
  await createAgentRuntime({
    prepareRuntime: async () => ({ startupSkills: [], geoResult: null }),
    createLoop(options) {
      runTurn = options.runTurn
      return { markLastTickAborted() {}, start() {} }
    },
    async callModel(input) {
      activeSample.context = {
        systemChars: input.systemPrompt.length, messageChars: JSON.stringify(input.messages).length,
        messageCount: input.messages.length, toolCount: input.tools.length,
      }
      return invokeModel(input)
    },
  })
  const sseSamples = new Map()
  let baseUrl
  if (useHttp) {
    const { handleMessageRoutes } = await import('../src/api/routes/message.js')
    const { handleEventRoutes } = await import('../src/api/routes/events.js')
    const browserModule = useBrowser ? await import('./request-performance-browser.mjs') : null
    server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1')
        if (await handleMessageRoutes(req, res, url)) return
        if (await handleEventRoutes(req, res, url)) return
        if (browserModule && await browserModule.handlePerformanceBrowserAsset(req, res, {
          root: fileURLToPath(new URL('../', import.meta.url)),
        })) return
        res.writeHead(404).end()
      } catch { res.writeHead(500).end() }
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    baseUrl = `http://127.0.0.1:${server.address().port}`
    if (useBrowser) {
      browserDriver = await browserModule.createPerformanceBrowser()
      await browserDriver.start(baseUrl)
    } else {
      stopEvents = new AbortController()
      const response = await originalFetch(`${baseUrl}/events?client_id=diagnostic-client`, { signal: stopEvents.signal })
      eventsPump = (async () => {
      const decoder = new TextDecoder()
      let pending = ''
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true })
        let end
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const packet = pending.slice(0, end)
          pending = pending.slice(end + 2)
          const line = packet.split('\n').find(value => value.startsWith('data: '))
          if (!line) continue
          const event = JSON.parse(line.slice(6))
          const sample = sseSamples.get(event.data?.client_message_id)
          if (!sample) continue
          if (event.type === 'stream_start') sample.plainReply = event.data.plainReply === true
          if (event.type === 'stream_chunk' && sample.plainReply
            && event.data.mode === 'text' && String(event.data.text || '').trim()
            && sample.metrics.sendToFirstTextSseMs == null) {
            sample.metrics.sendToFirstTextSseMs = Math.round((performance.now() - sample.startedAt) * 100) / 100
            sample.metrics.requestId = event.data.request_id
          }
        }
      }
      })().catch(error => { if (!stopEvents.signal.aborted) throw error })
    }
  }
  const messages = varied ? [
    '你好，请只回复“收到”。',
    '用一句话解释什么是缓存。',
    '请用一句话鼓励我今天把任务做好。',
    '用一句话解释什么是延迟。',
    '一加一等于几？请简短回答。',
  ] : ['你好，请只回复“收到”。']
  // Harmless messages; --varied avoids measuring only an identical query cache.
  // No user content, keys, endpoint URLs or model output goes into the report.
  for (let i = 0; i < runs; i++) {
    activeSample = { kind: 'full_context', run: i + 1 }
    const message = messages[i % messages.length]
    let trace
    let clientSample
    let browserSent
    if (useBrowser) {
      browserSent = await browserDriver.send(message)
    } else if (useHttp) {
      const clientMessageId = `diagnostic-message-${i + 1}`
      clientSample = { startedAt: performance.now(), metrics: {} }
      sseSamples.set(clientMessageId, clientSample)
      const response = await originalFetch(`${baseUrl}/message`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from_id: 'ID:000001', content: message, channel: 'TUI',
          client_id: 'diagnostic-client', client_message_id: clientMessageId }),
      })
      clientSample.metrics.sendToAcceptedHeadersMs = Math.round((performance.now() - clientSample.startedAt) * 100) / 100
      if (!response.ok || !(await response.json()).ok) throw new Error('Diagnostic HTTP message rejected')
    } else {
      trace = timing.createPerformanceTrace({ channel: 'diagnostic' })
      trace.mark('request.received')
      pushMessage('ID:000001', message, 'TUI', { performanceTrace: trace })
    }
    const entry = popMessage()
    if (!entry) throw new Error('Diagnostic message was not queued')
    trace = entry.performanceTrace
    await runTurn(entry.raw, 'diagnostic', entry)
    activeSample.trace = trace.snapshot()
    if (browserSent) {
      activeSample.client = await browserDriver.snapshot(browserSent.clientMessageId)
      if (activeSample.client?.requestId !== trace.id) throw new Error('Browser trace correlation mismatch')
    }
    if (clientSample) {
      // Let the socket consume already-broadcast packets. Missing text remains
      // null (tool-only/reasoning-only output is not a successful first word).
      for (let n = 0; n < 20 && clientSample.metrics.sendToFirstTextSseMs == null; n++) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      activeSample.client = { sendToFirstTextSseMs: null, ...clientSample.metrics }
      if (activeSample.client.requestId && activeSample.client.requestId !== trace.id) throw new Error('SSE trace correlation mismatch')
    }
    report.samples.push(activeSample)
    if (live && controlEnabled) {
      const control = timing.createPerformanceTrace({ channel: 'diagnostic' })
      control.mark('request.received')
      control.mark('queue.enqueued')
      control.mark('turn.started')
      try {
        await timing.runWithPerformanceTrace(control, () => invokeModel({
          systemPrompt: 'You are a helpful assistant.', message,
          tools: [], thinking: config.thinking === true,
        }))
      } catch (error) {
        control.finish({ status: 'error' })
        throw error
      } finally {
        control.finish()
        report.samples.push({ kind: 'short_control', run: i + 1, trace: control.snapshot() })
      }
    }
  }
  report.databaseRows = Object.fromEntries(['memories', 'conversations', 'memory_embeddings', 'knowledge_chunks']
    .flatMap(table => { try { return [[table, getDB().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]] } catch { return [] } }))
  report.suppressedLogCount = suppressedLogCount
  if (browserDriver) report.browser = await browserDriver.diagnostics()
} catch (error) {
  // Avoid serializing provider errors/headers that may contain private values.
  report.error = { name: error.name, status: Number(error.status) || null }
  process.exitCode = 1
} finally {
  try {
    try { await browserDriver?.close() } catch { report.cleanupError = true; process.exitCode = 1 }
    stopEvents?.abort()
    try { await eventsPump } catch { report.cleanupError = true; process.exitCode = 1 }
    if (server) {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
    try { closeDB?.() } catch { report.cleanupError = true; process.exitCode = 1 }
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, JSON.stringify(report, null, 2))
  } finally {
    fs.rmSync(isolated, { recursive: true, force: true })
    Object.assign(console, originalConsole)
  }
}
console.log(JSON.stringify({ output, liveModel: live, samples: report.samples.length, error: report.error || null }))
// Let ONNX native workers shut down naturally (forced process.exit can race
// their destructors). No scheduler or persistent app service was started.
