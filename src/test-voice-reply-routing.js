import assert from 'node:assert/strict'
import { createVoiceReplyCoordinator } from './ui/brain-ui/voice-reply-coordinator.js'

const clientA = 'ui-test-client-a'
const clientB = 'ui-test-client-b'
const turn = 'turn-voice-1'
const streamStart = {
  turn_id: turn,
  target_client_id: clientA,
  speak: true,
}

{
  const a = createVoiceReplyCoordinator(clientA)
  const b = createVoiceReplyCoordinator(clientB)
  assert.equal(a.streamStart(streamStart).startStreaming, true)
  assert.equal(b.streamStart(streamStart).startStreaming, false)
  assert.equal(
    b.finalMessage({ ...streamStart, conversation_id: 1 }, 'reply').reason,
    'target-mismatch',
  )
}

{
  const coordinator = createVoiceReplyCoordinator(clientA)
  coordinator.streamStart(streamStart)
  coordinator.streamFailed(streamStart, { reason: 'media-source-failed' })
  const decision = coordinator.finalMessage(
    { ...streamStart, conversation_id: 2 },
    '完整回复',
  )
  assert.equal(decision.action, 'play_full')
  assert.equal(decision.text, '完整回复')
  assert.equal(coordinator.markFallbackStarted(decision.turn), true)
  assert.equal(coordinator.markFallbackStarted(decision.turn), false)
}

{
  const coordinator = createVoiceReplyCoordinator(clientA)
  coordinator.streamStart(streamStart)
  const first = coordinator.finalMessage(
    { ...streamStart, conversation_id: 3 },
    '最终回复',
  )
  assert.equal(first.action, 'finalize_stream')
  const duplicate = coordinator.finalMessage(
    { ...streamStart, conversation_id: 3 },
    '最终回复',
  )
  assert.equal(duplicate.reason, 'duplicate-message')
}

{
  const coordinator = createVoiceReplyCoordinator(clientA)
  const decision = coordinator.finalMessage(
    { ...streamStart, turn_id: 'turn-after-reconnect', conversation_id: 4 },
    '重连后完整回复',
  )
  assert.equal(decision.action, 'play_full')
}

{
  const coordinator = createVoiceReplyCoordinator(clientA)
  const missingTarget = coordinator.finalMessage(
    { speak: true, turn_id: 'turn-missing-target', conversation_id: 5 },
    '不得广播播放',
  )
  assert.equal(missingTarget.reason, 'target-mismatch')
}

{
  const coordinator = createVoiceReplyCoordinator(clientA)
  coordinator.streamStart({ ...streamStart, turn_id: 'turn-partial' })
  coordinator.audioStarted({ ...streamStart, turn_id: 'turn-partial' })
  const final = coordinator.finalMessage(
    { ...streamStart, turn_id: 'turn-partial', conversation_id: 6 },
    '已经播放。尚未播放。',
  )
  assert.equal(final.action, 'finalize_stream')
  const failed = coordinator.streamFailed(
    { ...streamStart, turn_id: 'turn-partial' },
    { spokenPrefix: '已经播放。', reason: 'background-resume-failed' },
  )
  assert.equal(failed.action, 'play_remaining')
  assert.equal(failed.text, '尚未播放。')
}

// A tool acknowledgement must not consume playback permission for its result.
for (const streamingEnabled of [false, true]) {
  const coordinator = createVoiceReplyCoordinator(clientA)
  const ack = coordinator.finalMessage(
    { ...streamStart, conversation_id: 101 }, '我看一下～',
  )
  assert.equal(coordinator.markFallbackStarted(ack.turn), true)
  if (streamingEnabled) coordinator.streamStart(streamStart)
  const result = coordinator.finalMessage(
    { ...streamStart, conversation_id: 102 }, '通了，密钥没问题。',
  )
  assert.notEqual(result.turn, ack.turn)
  assert.equal(result.action, streamingEnabled ? 'finalize_stream' : 'play_full')
  if (!streamingEnabled) assert.equal(coordinator.markFallbackStarted(result.turn), true)
  assert.equal(coordinator.finalMessage(
    { ...streamStart, conversation_id: 102 }, '通了，密钥没问题。',
  ).reason, 'duplicate-message')
}

// A failed earlier stream must not remove characters from the next reply.
{
  const coordinator = createVoiceReplyCoordinator(clientA)
  coordinator.streamStart(streamStart)
  coordinator.streamFailed(streamStart, { spokenPrefix: '已经播放。' })
  const first = coordinator.finalMessage(
    { ...streamStart, conversation_id: 103 }, '已经播放。剩余内容。',
  )
  coordinator.markFallbackStarted(first.turn)
  const next = coordinator.finalMessage(
    { ...streamStart, conversation_id: 104 }, '新的完整结果。',
  )
  assert.equal(next.action, 'play_full')
  assert.equal(next.text, '新的完整结果。')
  assert.equal(coordinator.markFallbackStarted(next.turn), true)
}

console.log('Voice reply routing and fallback tests passed')
