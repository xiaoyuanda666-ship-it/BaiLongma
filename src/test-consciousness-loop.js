// Run: node src/test-consciousness-loop.js

import { createConsciousnessLoop } from './runtime/consciousness-loop.js'
import { getStatus as getTickerStatus, reset as resetTicker, setCustomInterval } from './ticker.js'

let failed = 0
function assert(condition, label) {
  if (condition) {
    console.log(`PASS: ${label}`)
    return
  }
  failed++
  process.exitCode = 1
  console.error(`FAIL: ${label}`)
}

function makeHarness({ queuedMessage = false, run = async () => {}, getTickerRevision = () => 0 } = {}) {
  let consumed = 0
  let awakened = 0
  let loop = null
  const runTurn = async (...args) => run({ args, loop })

  loop = createConsciousnessLoop({
    runTurn,
    runTurnWatchdogMs: 1000,
    getCurrentExecution: () => null,
    getCurrentAbortController: () => null,
    clearCurrentExecution: () => {},
    emitEvent: () => {},
    enqueueDueReminders: () => {},
    hasMessages: () => queuedMessage,
    popMessage: () => ({ raw: 'hello', fromId: 'ID:000001', queueName: 'user' }),
    hasUserMessages: () => queuedMessage,
    getQueueSnapshot: () => ({ user: queuedMessage ? 1 : 0, background: 0 }),
    formatTick: () => 'TICK 2026-07-10T12:00:00+08:00 | Friday noon',
    consumeTickerTick: () => { consumed++ },
    decrementAwakeningTick: () => { awakened++ },
    isStartupSelfCheckActive: () => false,
    isRunning: () => false,
    setScheduler: () => {},
    setInterruptCallback: () => {},
    isRateLimited: () => false,
    getTickInterval: n => n,
    getBaseTickInterval: () => 1200000,
    getCustomIntervalMs: () => null,
    getTickerStatus: () => ({ active: false, ttl: 0, revision: getTickerRevision() }),
    getAwakeningTicks: () => 0,
    isTaskActive: () => false,
    getNextPendingReminder: () => null,
    getQuotaStatus: () => ({ rpmUsed: 0, tpmUsed: 0, ratio: 0 }),
    startConsolidationLoop: () => {},
    ensureStartupSelfCheckState: () => {},
    setStickyEvent: () => {},
    startupSelfCheckVersion: 'test',
    priorities: { tick: 10, background: 50, user: 100 },
  })

  return {
    loop,
    counts: () => ({ consumed, awakened }),
  }
}

{
  let tickerRevision = 0
  const h = makeHarness({
    getTickerRevision: () => tickerRevision,
    run: async () => { tickerRevision++ },
  })
  await h.loop.onTick()
  assert(h.counts().consumed === 0, 'cadence configured during a Tick keeps its full TTL for future heartbeats')
  assert(h.counts().awakened === 1, 'cadence reconfiguration does not suppress successful awakening accounting')
}

{
  resetTicker()
  const revisionBefore = getTickerStatus().revision
  setCustomInterval({ seconds: 15, ttl: 1, reason: 'test' })
  const configured = getTickerStatus()
  assert(configured.ttl === 1, 'ticker stores the full requested TTL')
  assert(configured.revision > revisionBefore, 'new cadence increments ticker revision')
  setCustomInterval({ seconds: 15, ttl: 9, reason: 'duplicate' })
  assert(getTickerStatus().revision === configured.revision, 'idempotent cadence calls do not look like reconfiguration')
  resetTicker()
}

{
  resetTicker()
  const upperBound = setCustomInterval({ seconds: 36000, ttl: 100, reason: 'upper-bound test' })
  assert(upperBound.seconds === 36000 && upperBound.ttl === 100, 'ticker accepts the new maximum interval and TTL')
  assert(getTickerStatus().seconds === 36000 && getTickerStatus().ttl === 100, 'ticker stores the new maximum interval and TTL')
  resetTicker()

  const lowerBound = setCustomInterval({ seconds: -1, ttl: 0, reason: 'lower-bound test' })
  assert(lowerBound.seconds === 0 && lowerBound.ttl === 1, 'ticker clamps seconds and TTL to their new lower bounds')
  resetTicker()
}

{
  const h = makeHarness()
  await h.loop.onTick()
  assert(h.counts().consumed === 1, 'successful autonomous Tick consumes one cadence TTL')
  assert(h.counts().awakened === 1, 'successful autonomous Tick consumes one awakening heartbeat')
}

{
  const h = makeHarness({ queuedMessage: true })
  await h.loop.onTick()
  assert(h.counts().consumed === 0, 'user/background message does not consume Tick cadence TTL')
  assert(h.counts().awakened === 0, 'user/background message does not consume awakening heartbeat')
}

{
  const h = makeHarness({ run: async ({ loop }) => loop.markLastTickAborted() })
  await h.loop.onTick()
  assert(h.counts().consumed === 0, 'aborted autonomous Tick preserves cadence TTL')
  assert(h.counts().awakened === 0, 'aborted autonomous Tick preserves awakening state')
}

{
  const h = makeHarness({ run: async () => { throw new Error('provider failed') } })
  const originalError = console.error
  console.error = () => {}
  try {
    await h.loop.onTick()
  } finally {
    console.error = originalError
  }
  assert(h.counts().consumed === 0, 'failed autonomous Tick preserves cadence TTL')
  assert(h.counts().awakened === 0, 'failed autonomous Tick preserves awakening state')
}

if (failed === 0) console.log('\nAll consciousness-loop Tick accounting checks passed.')
