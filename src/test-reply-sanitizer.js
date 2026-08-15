import assert from 'node:assert/strict'
import {
  sanitizeAssistantReplyForDelivery,
  createAssistantReplyStreamSanitizer,
} from './runtime/markers.js'

const incident = [
  '用户刚从"智谱官网"话题切到"三元里"话题，问"现在是什么情况"。',
  '结合上下文，他们可能是在问当前的整体状态。',
  '让我想想最可能的意图。',
  '灯板离线了，当前颜色卡在白色，没有设备连着。',
].join('\n')

assert.equal(
  sanitizeAssistantReplyForDelivery(incident),
  '灯板离线了，当前颜色卡在白色，没有设备连着。',
  'loose internal analysis prelude is stripped',
)

assert.equal(
  sanitizeAssistantReplyForDelivery('<think>hidden chain</think>\n可以，已经处理好了。[RECALL: test]'),
  '可以，已经处理好了。',
  'tagged thinking and protocol markers are stripped',
)

assert.equal(
  sanitizeAssistantReplyForDelivery('用户画像可以从三个维度看：偏好、场景、限制。'),
  '用户画像可以从三个维度看：偏好、场景、限制。',
  'normal content that begins with 用户 is preserved',
)

assert.equal(
  sanitizeAssistantReplyForDelivery('已打开第二个结果。已打开第二个结果。'),
  '已打开第二个结果。',
  'adjacent duplicate sentences are collapsed in final replies',
)

assert.equal(
  sanitizeAssistantReplyForDelivery('第一项成功。\n第一项成功。\n第二项成功。'),
  '第一项成功。\n第二项成功。',
  'adjacent duplicate reply lines are collapsed',
)

assert.equal(
  sanitizeAssistantReplyForDelivery('第一项成功。第二项成功。第一项成功。'),
  '第一项成功。第二项成功。第一项成功。',
  'non-adjacent repeated sentences remain intact',
)

const stream = createAssistantReplyStreamSanitizer()
assert.equal(stream.push('用户刚从"智谱官网"话题'), '', 'stream holds possible internal prefix')
assert.equal(stream.push('切到"三元里"话题。\n'), '', 'stream drops confirmed internal line')
assert.equal(stream.push('让我查一下灯的状态。\n'), '', 'stream drops follow-on self talk')
assert.equal(
  stream.push('灯板离线了，当前颜色卡在白色。'),
  '灯板离线了，当前颜色卡在白色。',
  'stream emits first real answer',
)
assert.equal(stream.flush(), '', 'stream has no trailing buffered text')

console.log('test-reply-sanitizer passed')
