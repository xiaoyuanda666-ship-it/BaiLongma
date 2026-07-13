// Focused tests for pure helpers extracted from memory/injector.js.
//
// Run: node src/test-injector-modules.js

import assert from 'node:assert/strict'
import {
  parseMessageInput,
  consumeInjectorStateHints,
  stripThinkHint,
  buildMemoryFocusInput,
} from './memory/injector/message-input.js'
import { buildMemorySearchPlan } from './memory/injector/search-plan.js'

function testMessageInputParsing() {
  assert.deepEqual(parseMessageInput('TICK 2026-06-21-10:00:00'), {
    isTick: true,
    senderId: null,
    messageBody: '',
  })

  assert.deepEqual(
    parseMessageInput('[ID:000001] 2026-06-21T10:00:00+08:00 [TUI] 昨天我修了 qttoken bug'),
    {
      isTick: false,
      senderId: 'ID:000001',
      messageBody: '昨天我修了 qttoken bug',
    }
  )

  assert.deepEqual(parseMessageInput('裸消息也应该保留正文'), {
    isTick: false,
    senderId: null,
    messageBody: '裸消息也应该保留正文',
  })
}

function testStateHintConsumption() {
  const state = {
    task: '整理 injector',
    prev_recall: '昨天的修复',
    lastToolResult: { name: 'read_file', result: 'ok' },
    pendingConfidenceHint: 'low',
  }

  const hints = consumeInjectorStateHints(state)
  assert.equal(hints.lastToolResult.name, 'read_file')
  assert.equal(hints.confidenceHint, 'low')
  assert.equal(hints.hasTask, true)
  assert.equal(hints.hasRecall, true)
  assert.equal(state.lastToolResult, null)
  assert.equal(state.pendingConfidenceHint, null)
}

function testFocusInput() {
  assert.equal(stripThinkHint('<think>private</think>visible'), 'visible')

  const focus = buildMemoryFocusInput({
    messageBody: '昨天我修了 qttoken bug，今天继续',
    temporalRecall: [{ label: '昨天' }],
    hasTask: true,
    task: '重构 injector',
    hintText: 'memory pool',
    conversationWindow: [
      { content: '历史 A' },
      { content: '' },
      { content: '历史 B' },
    ],
  })

  assert.equal(focus.conversationText, '历史 A 历史 B')
  assert.equal(focus.hasHistory, true)
  assert.match(focus.focusText, /qttoken bug/)
  assert.match(focus.focusText, /重构 injector/)
  assert.match(focus.focusText, /memory pool/)
  assert.equal(focus.focusText.includes('昨天'), false)
  assert.equal(focus.focusText.includes('今天'), false)
}

function testSearchPlan() {
  assert.deepEqual(buildMemorySearchPlan({ hasHistory: false, hasHint: false }), {
    focusLimit: 8,
    contextLimit: 0,
    focusKeywords: 8,
    contextKeywords: 0,
    perKeyword: 5,
  })

  assert.deepEqual(buildMemorySearchPlan({ hasHistory: false, hasHint: true, confidenceHint: 'low' }), {
    focusLimit: 18,
    contextLimit: 0,
    focusKeywords: 15,
    contextKeywords: 0,
    perKeyword: 5,
  })

  assert.deepEqual(buildMemorySearchPlan({ hasHistory: true, confidenceHint: 'high' }), {
    focusLimit: 11,
    contextLimit: 7,
    focusKeywords: 7,
    contextKeywords: 10,
    perKeyword: 5,
  })
}

testMessageInputParsing()
testStateHintConsumption()
testFocusInput()
testSearchPlan()

console.log('\nAll injector module tests passed.')
