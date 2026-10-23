import { AsyncLocalStorage } from 'node:async_hooks'
import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import { performanceJournal } from '../composition/performance-services.js'

// Deliberately separate from the full-content turn trace: only timing, counts
// and query fingerprints belong here. Durations never subtract remote clocks.
const scope = new AsyncLocalStorage()
const recent = []
const MAX_TRACES = 80
const MAX_EVENTS = 1000
const MAX_SPANS = 500
const round = n => Math.round(n * 100) / 100
const safeNumbers = value => Object.fromEntries(Object.entries(value || {})
  .filter(([, v]) => typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))))

function persist(snapshot) {
  // Never perform synchronous filesystem work on the request's critical path.
  performanceJournal.append(snapshot, () => recent.filter(t => t.finished).map(t => t.snapshot()))
}

export function createPerformanceTrace(meta = {}) {
  const started = performance.now()
  const events = []
  const spans = []
  const queries = new Map()
  let queryCount = 0
  let queryMs = 0
  let queryMaxMs = 0
  let dropped = 0
  let ended = null
  let status = 'running'
  let attempt = 0
  const trace = {
    id: randomUUID(),
    startedAt: new Date().toISOString(),
    client: safeNumbers({
      clientPrepareMs: meta.clientPrepareMs,
      clientSerializeMs: meta.clientSerializeMs,
    }),
    channel: /^[a-z0-9_-]{1,40}$/i.test(meta.channel || '') ? meta.channel : 'unknown',
    get finished() { return ended !== null },
    nextAttempt() { return ++attempt },
    mark(name, metadata = {}) {
      if (ended !== null) return
      if (events.length >= MAX_EVENTS) { dropped++; return }
      events.push({ name, atMs: round(performance.now() - started), ...safeNumbers(metadata) })
    },
    span(name) {
      const at = performance.now()
      let done = false
      return () => {
        if (done || ended !== null) return
        done = true
        if (spans.length >= MAX_SPANS) { dropped++; return }
        spans.push({ name, atMs: round(at - started), durationMs: round(performance.now() - at) })
      }
    },
    recordQuery({ operation, fingerprint, durationMs, rows = 0 }) {
      if (ended !== null || !Number.isFinite(durationMs)) return
      queryCount++
      queryMs += durationMs
      queryMaxMs = Math.max(queryMaxMs, durationMs)
      const stage = scope.getStore()?.stage || 'unscoped'
      const key = `${stage}:${operation}:${fingerprint}`
      if (!queries.has(key) && queries.size >= 100) { dropped++; return }
      const item = queries.get(key) || { stage, operation, fingerprint, count: 0, totalMs: 0, maxMs: 0, rows: 0 }
      item.count++
      item.totalMs += durationMs
      item.maxMs = Math.max(item.maxMs, durationMs)
      item.rows += rows
      queries.set(key, item)
    },
    snapshot() {
      const first = name => events.find(e => e.name === name && e.auxiliary !== true)?.atMs ?? null
      const difference = (a, b) => a === null || b === null ? null : round(a - b)
      const dispatch = events.find(e => e.name === 'model.fetch.dispatch' && e.auxiliary !== true)
      const firstDelta = events.find(e => e.name === 'model.first_delta' && e.auxiliary !== true)
      const deltaDispatch = firstDelta
        ? events.find(e => e.name === 'model.fetch.dispatch' && e.modelAttempt === firstDelta.modelAttempt && e.fetchAttempt === firstDelta.fetchAttempt)
        : null
      return {
        version: 1, id: trace.id, startedAt: trace.startedAt, channel: trace.channel,
        client: trace.client, status, totalMs: round((ended ?? performance.now()) - started),
        summary: {
          ingressMs: difference(first('queue.enqueued'), first('request.received')),
          queueMs: difference(first('turn.started'), first('queue.enqueued')),
          prepareMs: difference(dispatch?.atMs ?? null, first('turn.started')),
          contextPrepareMs: difference(first('prepare.complete'), first('turn.started')),
          receivedToDispatchMs: difference(dispatch?.atMs ?? null, first('request.received')),
          dispatchToFirstDeltaMs: difference(firstDelta?.atMs ?? null, deltaDispatch?.atMs ?? null),
          firstDispatchToFirstDeltaMs: difference(firstDelta?.atMs ?? null, dispatch?.atMs ?? null),
          receivedToFirstDeltaMs: difference(firstDelta?.atMs ?? null, first('request.received')),
          receivedToFirstTextMs: difference(first('model.first_text'), first('request.received')),
          receivedToFirstTextBroadcastMs: difference(first('delivery.first_text'), first('request.received')),
          firstTextToBroadcastMs: difference(first('delivery.first_text'), first('model.first_text')),
          databaseMs: round(queryMs), databaseMaxMs: round(queryMaxMs), databaseOperations: queryCount,
        },
        events: events.map(e => ({ ...e })), spans: spans.map(s => ({ ...s })),
        queries: [...queries.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, 20)
          .map(q => ({ ...q, totalMs: round(q.totalMs), maxMs: round(q.maxMs) })),
        dropped,
      }
    },
    finish(result = {}) {
      if (ended !== null) return
      trace.mark('request.finished')
      ended = performance.now()
      status = ['ok', 'error', 'aborted', 'rejected', 'staged', 'superseded', 'watchdog'].includes(result.status)
        ? result.status
        : events.some(e => e.name === 'turn.error') ? 'error'
          : events.some(e => e.name === 'turn.aborted') ? 'aborted' : 'ok'
      const snapshot = trace.snapshot()
      if (process.env.BAILONGMA_PERFORMANCE_TRACE !== '0') {
        persist(snapshot)
        console.log(`[performance] ${JSON.stringify({ id: trace.id, status, totalMs: snapshot.totalMs, ...snapshot.summary })}`)
      }
    },
  }
  recent.push(trace)
  if (recent.length > MAX_TRACES) recent.shift()
  return trace
}

export function getPerformanceTrace() { return scope.getStore()?.trace || null }
export function getPerformanceStage() { return scope.getStore()?.stage || '' }
export function runWithPerformanceTrace(trace, fn, stage = 'ingress') { return scope.run({ trace, stage }, fn) }
export function markPerformance(name, metadata) { getPerformanceTrace()?.mark(name, metadata) }
export function measurePerformance(name, fn) {
  const trace = getPerformanceTrace()
  if (!trace || trace.finished) return fn()
  const end = trace.span(name)
  return scope.run({ trace, stage: name }, () => {
    try {
      const result = fn()
      if (result && typeof result.then === 'function') return Promise.resolve(result).finally(end)
      end()
      return result
    } catch (error) { end(); throw error }
  })
}
export function withoutPerformanceTrace(fn) { return scope.run({}, fn) }
export function getPerformanceTraces(limit = 80) {
  return recent.slice(-Math.max(1, Math.min(80, Number(limit) || 80))).reverse().map(t => t.snapshot())
}
export async function readPerformanceTraces(limit = 80) {
  const count = Math.max(1, Math.min(80, Number(limit) || 80))
  const live = getPerformanceTraces(80)
  const saved = await performanceJournal.readTail(80)
  return [...new Map([...saved, ...live].map(t => [t.id, t])).values()]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, count)
}
export function flushPerformanceTraces() { return performanceJournal.flush() }
