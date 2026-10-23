import assert from 'node:assert/strict'
import { createAssistantReplyStreamSanitizer } from './runtime/markers.js'

// Every split includes partial-prefix cases such as "当"+"前" and "I"+" will".
// Once a legitimate sentence completes it must appear before stream flush.
for (const sentence of [
  '当前系统状态正常。',
  '我需要你提供一个文件。',
  'I will help you with that.',
  '用户画像可以从三个维度看：偏好、场景、限制。',
]) {
  for (let split = 0; split <= sentence.length; split++) {
    const stream = createAssistantReplyStreamSanitizer()
    const first = stream.push(sentence.slice(0, split))
    if (split < sentence.length) assert.equal(first, '', `premature prefix release: ${sentence}, split ${split}`)
    const second = stream.push(sentence.slice(split))
    assert.equal(first + second, sentence, `sentence must not wait for end: ${sentence}, split ${split}`)
    assert.equal(stream.flush(), '', 'early release is never emitted twice')
  }
}

// Hidden analysis, including its punctuation, remains private at every chunk
// split. The final answer is the first emitted text, even with a broad prefix.
for (const [hidden, reply] of [
  ['用户可能是在问当前情况。\n让我检查一下上下文。\n', '当前系统状态正常。'],
  ['The user probably asked about context.\nI should check the history.\n', 'I will help you with that.'],
]) {
  const stream = createAssistantReplyStreamSanitizer()
  for (const character of hidden) assert.equal(stream.push(character), '', 'internal sentence punctuation is not permission to flush')
  let emitted = ''
  for (const character of reply) emitted += stream.push(character)
  assert.equal(emitted, reply)
  assert.equal(stream.flush(), '')
}

const incompleteAfterHidden = createAssistantReplyStreamSanitizer()
assert.equal(incompleteAfterHidden.push('用户问天气。\n当'), '', 'a newline must not expose a partial internal prefix')
assert.equal(incompleteAfterHidden.push('前应该是在问最近的天气。'), '', 'completed internal sentence remains hidden')
assert.equal(incompleteAfterHidden.push('\n实际情况需要依据最新观测。'), '实际情况需要依据最新观测。')
assert.equal(incompleteAfterHidden.flush(), '')

const internalOnly = createAssistantReplyStreamSanitizer()
assert.equal(internalOnly.push('用户可能是在问当前情况。'), '')
assert.equal(internalOnly.flush(), '', 'an internal-only stream stays hidden through completion')

const decimal = createAssistantReplyStreamSanitizer()
assert.equal(decimal.push('I will use version 1.'), '', 'a split decimal is not a sentence boundary')
assert.equal(decimal.push('23 to process the file'), '')
assert.equal(decimal.push('.'), 'I will use version 1.23 to process the file.')
assert.equal(decimal.flush(), '')

const ellipsis = createAssistantReplyStreamSanitizer()
assert.equal(ellipsis.push('当前...'), '', 'an ellipsis is not a complete sentence')
assert.equal(ellipsis.push('状态正常。'), '当前...状态正常。')

const noPunctuation = createAssistantReplyStreamSanitizer()
assert.equal(noPunctuation.push('我需要你提供一个文件'), '')
assert.equal(noPunctuation.flush(), '我需要你提供一个文件', 'unpunctuated text still has the existing end-of-stream fallback')

const ordinary = createAssistantReplyStreamSanitizer()
assert.equal(ordinary.push('你好'), '你好', 'ordinary unambiguous text remains immediate')
assert.equal(ordinary.push('，已经收到。'), '，已经收到。')
assert.equal(ordinary.flush(), '')

console.log('PASS legitimate complete sentences stream early while split internal prefixes and preludes remain hidden')
