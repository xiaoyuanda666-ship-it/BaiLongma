// Run: node src/test-runtime-messages.js

import {
  buildLLMMessages,
  buildRuntimeContextMessages,
  formatConversationMessage,
  formatTaskSteps,
} from './runtime/messages.js'

let failed = 0
function assert(cond, label) {
  if (!cond) {
    failed++
    process.exitCode = 1
    console.error(`FAIL: ${label}`)
  } else {
    console.log(`PASS: ${label}`)
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    failed++
    process.exitCode = 1
    console.error(`FAIL: ${label}`)
    console.error(`  expected: ${JSON.stringify(expected)}`)
    console.error(`  actual:   ${JSON.stringify(actual)}`)
  } else {
    console.log(`PASS: ${label}`)
  }
}

const currentMsg = {
  fromId: 'ID:000001',
  timestamp: '2026-05-25T10:02:13+08:00',
  content: '那现在呢？',
  channel: 'WECHAT_CLAWBOT',
}

const conversationWindow = [
  {
    role: 'user',
    from_id: 'ID:000001',
    timestamp: '2026-05-25T10:00:00+08:00',
    content: '先在本地看一下',
    channel: 'TUI',
  },
  {
    role: 'jarvis',
    from_id: 'jarvis',
    to_id: 'ID:000001',
    timestamp: '2026-05-25T10:01:00+08:00',
    content: '我看到了，随时为您效劳！',
    channel: 'TUI',
  },
  {
    role: 'user',
    from_id: 'ID:000001',
    timestamp: currentMsg.timestamp,
    content: currentMsg.content,
    channel: currentMsg.channel,
  },
]

const messages = buildLLMMessages({
  systemPrompt: 'SYSTEM_PROMPT',
  contextBlock: '<context>CTX</context>',
  conversationWindow,
  input: '[ID:000001] 2026-05-25T10:02:13+08:00 [WECHAT_CLAWBOT] 那现在呢？',
  msg: currentMsg,
  recentActions: [{ ts: '2026-05-25T02:01:30.000Z', summary: 'read_file(foo)' }],
  actionLog: [{ timestamp: '2026-05-25T02:01:40.000Z', tool: 'read_file', summary: 'read_file(foo)', detail: 'ok' }],
  lastToolResult: { name: 'read_file', args: { path: 'foo.txt' }, result: 'hello world' },
  taskSteps: [{ text: '检查文件', status: 'done', note: 'ok' }, { text: '回复用户', status: 'pending' }],
  batteryBlock: 'Battery: 80%',
})

assertEqual(messages[0].role, 'system', 'first message is system')
assertEqual(messages[0].content, 'SYSTEM_PROMPT', 'system content preserved')
assertEqual(messages[1].role, 'user', 'runtime context is injected after system')
assert(messages[1].content.includes('[runtime context]'), 'runtime context marker present')
assert(messages[1].content.includes('Battery: 80%'), 'runtime context includes battery')
assert(messages[1].content.includes('Task step progress (1/2)'), 'runtime context includes task progress')
assert(messages[1].content.includes('Recent assistant actions'), 'runtime context includes recent actions')
assert(messages[1].content.includes('Recent tool/action log'), 'runtime context includes action log')
assert(messages[1].content.includes('Previous tool result'), 'runtime context includes last tool result')
assert(messages[1].content.includes('<conversation_metadata>'), 'runtime context includes conversation metadata')
assert(messages[1].content.includes('<context>CTX</context>'), 'runtime context includes round-local context block')
assert(messages[1].content.includes('Current-turn intent check'), 'runtime context includes current-turn intent check')
assert(messages[1].content.includes('role="assistant"'), 'conversation metadata includes assistant role')
assert(messages[1].content.includes('salience="last_assistant_reply"'), 'conversation metadata marks the last assistant reply')
assert(messages[1].content.includes('channel_switched_from="TUI"'), 'conversation metadata marks channel switch')
assert(messages[1].content.includes('- 10:01 read_file(foo)'), 'UTC recent action time is rendered in local time')
assert(!messages[1].content.includes('- 02:01 read_file(foo)'), 'UTC recent action time is not rendered as raw UTC clock')

const historicalUser = messages.find(m => m.content.includes('先在本地看一下'))
assert(historicalUser && !historicalUser.content.includes('<context>CTX</context>'), 'historical user message is not prefixed with current context')

const currentUser = messages.find(m => m.role === 'user' && m.content === currentMsg.content)
assert(currentUser, 'current user message is identified')
assertEqual(currentUser.content, currentMsg.content, 'current user message stays exactly the user text')
assertEqual(messages[messages.length - 1].content, currentMsg.content, 'final message is the clean current user message')
assert(!currentUser.content.includes('[current user message'), 'current user message keeps metadata out of visible content')
assert(!currentUser.content.includes('channel switch:'), 'current user message does not inline channel switch metadata')
assert(!currentUser.content.includes('intent check'), 'current user message does not inline intent check')

const assistant = messages.find(m => m.role === 'assistant')
// The assistant line immediately preceding the current user message is the "last reply";
// salience now lives in conversation_metadata, not in the assistant text itself.
assert(assistant.content.includes('我看到了，随时为您效劳！'), 'assistant history content preserved verbatim')
assert(!assistant.content.includes('your last reply'), 'assistant text does not carry salience marker inline')
assert(!assistant.content.includes('[you · '), 'assistant text does not carry the old in-band speaker heading')
assertEqual(assistant.content, '我看到了，随时为您效劳！', 'assistant history content is exactly the original text')

const fallbackMessages = buildLLMMessages({
  systemPrompt: 'SYS',
  contextBlock: '<context>TICK</context>',
  conversationWindow: [],
  input: 'TICK 2026-05-25-10:03:00',
})
assertEqual(fallbackMessages.length, 3, 'fallback path has system + runtime context + one user message')
assert(fallbackMessages[1].content.startsWith('[runtime context]'), 'fallback runtime context is injected before user message')
assert(fallbackMessages[1].content.includes('<context>TICK</context>'), 'fallback runtime context gets context block')
assertEqual(fallbackMessages[2].content, 'TICK 2026-05-25-10:03:00', 'fallback user message keeps input clean')
assert(!fallbackMessages[2].content.includes('[heartbeat tick'), 'fallback without isTick stays unmarked (non-tick callers unaffected)')

const tickMessages = buildLLMMessages({
  systemPrompt: 'SYS',
  contextBlock: '<context>TICK</context>',
  conversationWindow: [],
  input: 'TICK 2026-05-25-10:03:00',
  isTick: true,
})
assertEqual(tickMessages.length, 2, 'tick path has system + runtime context only')
assert(tickMessages[0].content.startsWith('[heartbeat tick - no new user message]'), 'tick marker is prepended to system prompt')
assert(tickMessages[0].content.includes('not a user turn'), 'tick system prompt says this is not a user turn')
assert(tickMessages[0].content.includes('TICK 2026-05-25-10:03:00'), 'tick system prompt preserves the tick payload')
assert(tickMessages[0].content.endsWith('SYS'), 'original system prompt follows the tick marker')
assertEqual(tickMessages[1].role, 'system', 'tick runtime context uses system role')
assert(tickMessages[1].content.startsWith('[runtime context]'), 'tick runtime context is injected before user message')
assert(tickMessages[1].content.includes('<context>TICK</context>'), 'tick runtime context gets context block')
assert(!tickMessages.some((m, i) => i > 0 && m.content.includes('TICK 2026-05-25-10:03:00')), 'tick payload is not injected as a synthetic user message')
assert(!tickMessages.some(m => m.role === 'user'), 'tick without history has no user-role message')

const tickHistoryMessages = buildLLMMessages({
  systemPrompt: 'SYS',
  conversationWindow: [
    {
      role: 'user',
      from_id: 'ID:000001',
      timestamp: '2026-05-25T10:00:00+08:00',
      content: 'hello',
    },
    {
      role: 'jarvis',
      from_id: 'jarvis',
      to_id: 'ID:000001',
      timestamp: '2026-05-25T10:01:00+08:00',
      content: 'hi back',
    },
  ],
  input: 'TICK 2026-05-25-10:03:00',
  isTick: true,
})
assertEqual(tickHistoryMessages[tickHistoryMessages.length - 1].role, 'assistant', 'tick with history can end on the assistant history row')
assertEqual(tickHistoryMessages[tickHistoryMessages.length - 1].content, 'hi back', 'tick does not append a current user message after assistant history')

const continuityMessages = buildLLMMessages({
  systemPrompt: 'SYS',
  conversationWindow: [{
    role: 'jarvis',
    to_id: 'ID:000001',
    timestamp: '2026-05-25T10:01:00+08:00',
    content: 'The report is already sent.',
  }],
  recentActions: [{ ts: '2026-05-25T10:01:00+08:00', summary: 'sent report to ID:000001' }],
  actionLog: [{ timestamp: '2026-05-25T10:01:00+08:00', tool: 'send_message', summary: 'report delivered' }],
  input: 'TICK 2026-05-25-10:03:00',
  isTick: true,
})
const continuityContext = continuityMessages.find(message => String(message.content || '').includes('Heartbeat continuity check'))?.content || ''
assert(continuityContext.includes('freshest evidence'), 'Tick prioritizes recent conversation and execution evidence')
assert(continuityContext.includes('do not repeat it'), 'Tick continuity check blocks already-completed work')
assert(continuityContext.includes('Time passing by itself is not new evidence'), 'Tick does not treat elapsed time as a retry trigger')

const scheduledMessages = buildLLMMessages({
  systemPrompt: 'SYS',
  contextBlock: '<context>L3</context>',
  conversationWindow: [{
    role: 'user',
    from_id: 'SYSTEM',
    timestamp: '2026-05-25T10:02:00+08:00',
    content: 'legacy reminder wrapper',
    channel: 'REMINDER',
  }],
  input: '到时间了，提醒用户喝水',
  msg: {
    scheduledEventType: 'reminder',
    reminderRunId: 12,
    reminderId: 7,
    reminderTargetId: 'ID:000001',
    reminderDueAt: '2026-05-25T10:03:00+08:00',
    reminderAttempt: 1,
    reminderTask: '提醒用户喝水',
    deliveryPolicy: 'notify',
  },
  runtimeLane: 'l3',
})
assertEqual(scheduledMessages.length, 2, 'L3 path has system + runtime context only')
assert(scheduledMessages[0].content.startsWith('[L3 scheduled task - no new user message]'), 'L3 marker is prepended to system prompt')
assert(scheduledMessages[0].content.includes('"task": "提醒用户喝水"'), 'L3 prompt carries the structured task payload')
assert(scheduledMessages[0].content.includes('exactly one useful send_message'), 'L3 prompt requires verified notification delivery')
assertEqual(scheduledMessages[1].role, 'system', 'L3 runtime context uses system role')
assert(!scheduledMessages.some(message => message.role === 'user'), 'L3 does not synthesize a user message')
assert(!scheduledMessages.some(message => message.content.includes('legacy reminder wrapper')), 'L3 excludes legacy system-signal history')

const systemSignal = formatConversationMessage({
  role: 'user',
  from_id: 'SYSTEM',
  timestamp: '2026-05-25T10:04:00+08:00',
  content: 'Reminder fired',
  channel: 'REMINDER',
})
assertEqual(systemSignal.role, 'user', 'system signal is represented as user message')
assert(systemSignal.content.includes('[system signal'), 'system signal marker present')
assert(systemSignal.content.includes('Do NOT call send_message'), 'system signal forbids send_message')

assertEqual(
  formatTaskSteps([{ text: 'A', status: 'done' }, { text: 'B', status: 'failed', note: 'nope' }]),
  'Task step progress (1/2):\n  1. [✓] A\n  2. [✗] B (nope)',
  'formatTaskSteps renders done count and notes',
)

assertEqual(buildRuntimeContextMessages({}).length, 0, 'empty runtime context emits no messages')

const topicMessages = buildLLMMessages({
  systemPrompt: 'SYS',
  conversationWindow: [
    {
      role: 'user',
      from_id: 'ID:000001',
      timestamp: '2026-06-25T10:00:00+08:00',
      content: '智谱官网现在怎么样',
      focus_topic: '智谱官网',
    },
    {
      role: 'jarvis',
      from_id: 'jarvis',
      to_id: 'ID:000001',
      timestamp: '2026-06-25T10:01:00+08:00',
      content: '我看一下。',
      focus_topic: '智谱官网',
      open_question: 1,
    },
    {
      role: 'user',
      from_id: 'ID:000001',
      timestamp: '2026-06-25T10:02:00+08:00',
      content: '现在是什么情况',
      focus_topic: '三元里',
    },
  ],
  input: '[ID:000001] 2026-06-25T10:02:00+08:00 [voice] 现在是什么情况',
  msg: {
    fromId: 'ID:000001',
    timestamp: '2026-06-25T10:02:00+08:00',
    content: '现在是什么情况',
    channel: 'voice',
  },
  currentTopic: '三元里',
})
const topicJoined = topicMessages.map(m => m.content || '').join('\n')
assert(!topicJoined.includes('topic switch from'), 'topic labels do not assert a topic switch fact')
assert(!topicJoined.includes('expired follow-up'), 'topic mismatch alone does not expire a follow-up')

if (failed === 0) {
  console.log('\nAll runtime message checks complete.')
} else {
  console.log(`\n${failed} runtime message check(s) failed.`)
}
