import assert from 'node:assert/strict'
import { createContinuousPolicy } from './ui/brain-ui/voice-continuous.js'

globalThis.localStorage = {
  getItem(key) {
    if (key === 'jarvis-voice-silence-ms') return '800'
    return null
  },
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function createCore() {
  let text = ''
  let sent = 0
  return {
    core: {
      pttHolding: false,
      micActive: true,
      suspendedByMedia: false,
      ttsStartTime: 0,
      getText: () => text,
      setText: value => { text = value },
      setStatus: () => {},
      sendRecognizedVoiceText: () => { sent++ },
    },
    get sent() { return sent },
  }
}

{
  const harness = createCore()
  const policy = createContinuousPolicy(harness.core, { getAutoSend: () => true })

  harness.core.setText('你好')
  policy.onTranscript()

  await wait(350)
  policy.onFrame(0.08)
  harness.core.setText('你好')
  policy.onTranscript()
  policy.onFrame(0.08)

  await wait(550)
  assert.equal(harness.sent, 1, 'noise and duplicate transcripts must not reset auto-send timing')
}

{
  const harness = createCore()
  const policy = createContinuousPolicy(harness.core, { getAutoSend: () => true })

  harness.core.setText('你好')
  policy.onTranscript()

  await wait(500)
  harness.core.setText('你好，Jarvis')
  policy.onTranscript()

  await wait(450)
  assert.equal(harness.sent, 0, 'new transcript text should reset auto-send timing')

  await wait(450)
  assert.equal(harness.sent, 1, 'auto-send should fire after the latest transcript text stops changing')
}

console.log('All voice continuous tests passed.')
