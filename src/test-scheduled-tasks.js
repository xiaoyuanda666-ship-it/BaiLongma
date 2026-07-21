import assert from 'node:assert/strict'
import { hasVerifiedScheduledDelivery } from './runtime/scheduled-tasks.js'

const targetId = 'ID:000001'

assert.equal(hasVerifiedScheduledDelivery([], targetId), false)
assert.equal(hasVerifiedScheduledDelivery([{
  name: 'capability_demo',
  args: {},
  result: '{"ok":true,"delivered":true,"message_sent":true}',
  ok: true,
}], targetId), false)
assert.equal(hasVerifiedScheduledDelivery([{
  name: 'send_message',
  args: { target_id: targetId, content: '我查一下' },
  result: '{"ok":true,"delivered":true,"message_sent":true,"target_id":"ID:000001"}',
  ok: true,
  ack: true,
}], targetId), false)
assert.equal(hasVerifiedScheduledDelivery([{
  name: 'send_message',
  args: { target_id: 'ID:000002', content: '提醒内容' },
  result: '{"ok":true,"delivered":true,"message_sent":true,"target_id":"ID:000002"}',
  ok: true,
}], targetId), false)
assert.equal(hasVerifiedScheduledDelivery([{
  name: 'send_message',
  args: { target_id: targetId, content: '提醒内容' },
  result: '{"ok":false,"delivered":false,"target_id":"ID:000001"}',
  ok: false,
}], targetId), false)
assert.equal(hasVerifiedScheduledDelivery([{
  name: 'send_message',
  args: { target_id: targetId, content: '提醒内容' },
  result: '{"ok":true,"delivered":true,"message_sent":false,"target_id":"ID:000001","skipped":"already_delivered_unanswered"}',
  ok: true,
}], targetId), true)
assert.equal(hasVerifiedScheduledDelivery([{
  name: 'send_message',
  args: { target_id: targetId, content: '提醒内容' },
  result: '{"ok":true,"delivered":true,"message_sent":true,"target_id":"ID:000001"}',
  ok: true,
}], targetId), true)

console.log('PASS scheduled L3 completion requires a verified non-ack delivery to the intended target')
