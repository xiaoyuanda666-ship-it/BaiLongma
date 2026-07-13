// Run: node src/test-error-logger.js

import assert from 'node:assert/strict'
import {
  getErrorStats,
  logError,
  logWarn,
  resetErrorStatsForTest,
  sanitizeMetadata,
} from './runtime/error-logger.js'

function captureConsole(fn) {
  const originalError = console.error
  const originalWarn = console.warn
  const calls = { error: [], warn: [] }
  console.error = (...args) => calls.error.push(args)
  console.warn = (...args) => calls.warn.push(args)
  try {
    return { result: fn(), calls }
  } finally {
    console.error = originalError
    console.warn = originalWarn
  }
}

function testRedactionAndTruncation() {
  const clean = sanitizeMetadata({
    apiKey: 'sk-secret',
    access_token: 'tok',
    prompt: '用户正文'.repeat(100),
    safeCount: 3,
    nested: {
      content: 'private body',
      label: 'safe label',
    },
  })

  assert.equal(clean.apiKey, '[redacted]')
  assert.equal(clean.access_token, '[redacted]')
  assert.match(clean.prompt, /^\[redacted text:/)
  assert.equal(clean.safeCount, 3)
  assert.match(clean.nested.content, /^\[redacted text:/)
  assert.equal(clean.nested.label, 'safe label')

  const long = sanitizeMetadata({ label: 'x'.repeat(400) })
  assert(long.label.length < 280)
  assert.match(long.label, /truncated/)
}

function testCountingAndConsoleOutput() {
  resetErrorStatsForTest()

  const { result: payload, calls } = captureConsole(() => {
    logError(new Error('db failed'), {
      scope: 'memory.injector',
      operation: 'recall_audit',
      metadata: { chosenCount: 2 },
    })
    return logWarn('embedding timeout', {
      scope: 'memory.injector',
      operation: 'vector_recall',
      metadata: { focusText: 'private query' },
    })
  })

  const stats = getErrorStats()
  assert.equal(stats.total, 2)
  assert.equal(stats.byKey['memory.injector.recall_audit'].count, 1)
  assert.equal(stats.byKey['memory.injector.vector_recall'].count, 1)
  assert.equal(stats.lastMessage, 'embedding timeout')

  assert.equal(calls.error.length, 2)
  assert.equal(calls.warn.length, 2)
  assert.match(calls.error[0][0], /^\[error\] memory\.injector\.recall_audit: db failed/)
  assert.match(calls.error[1][0].stack, /Error: db failed/)
  assert.equal(payload.severity, 'warn')
  assert.equal(payload.metadata.focusText, '[redacted text: 13 chars]')
}

testRedactionAndTruncation()
testCountingAndConsoleOutput()

console.log('\nAll error logger tests passed.')
