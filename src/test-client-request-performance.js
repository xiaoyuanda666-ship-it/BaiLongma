import assert from 'node:assert/strict'
import { createClientRequestPerformance } from './ui/brain-ui/request-performance.js'

let time = 0
let visible = true
const frames = []
const reported = []
const timing = createClientRequestPerformance({
  now: () => time, frame: callback => frames.push(callback),
  isVisible: element => visible && element.isConnected,
  report: value => reported.push(value), limit: 2,
})
const first = { client_message_id: 'client-1' }
timing.begin('client-1', 0)
time = 8
timing.dispatched(first)
time = 90
timing.correlate({ ...first, request_id: 'request-1', turn_id: 'turn-1' })
time = 100
timing.textReceived({ request_id: 'request-1' })
timing.textRendered(first, { textContent: '', isConnected: true })
assert.equal(timing.snapshots()[0].sendToFirstTextDomMs, null, 'empty placeholders are never first visible text')
const body = { textContent: 'PRIVATE_CONTENT', isConnected: true }
time = 110
timing.textRendered({ turn_id: 'turn-1' }, body)
assert.equal(timing.snapshots()[0].sendToFirstTextDomMs, 110)
assert.equal(timing.snapshots()[0].sendToFirstTextFrameOpportunityMs, null, 'DOM insertion is not proof of paint')
time = 115
timing.accepted({ ...first, request_id: 'request-1' })
assert.equal(timing.snapshots()[0].sendToAcceptedHeadersMs, 115, 'SSE may arrive before POST acknowledgement')
frames.shift()()
time = 130
frames.shift()()
assert.equal(timing.snapshots()[0].sendToFirstTextFrameOpportunityMs, 130)
assert.equal(timing.snapshots()[0].receivedToDomMs, 10)
assert.equal(timing.snapshots()[0].domToFrameOpportunityMs, 20)
assert.ok(!JSON.stringify(timing.snapshots()).includes('PRIVATE_CONTENT'))
assert.ok(!JSON.stringify(reported).includes('PRIVATE_CONTENT'))

time = 200
timing.begin('client-2', time)
timing.correlate({ client_message_id: 'client-2', request_id: 'request-2', turn_id: 'turn-2' })
timing.textReceived({ request_id: 'unknown' })
assert.equal(timing.snapshots()[1].sendToFirstTextReceivedMs, null, 'another client/replayed event cannot steal a request')
time = 250
timing.textReceived({ request_id: 'request-2' })
visible = false
timing.textRendered({ request_id: 'request-2' }, body)
frames.shift()()
frames.shift()()
assert.equal(timing.snapshots()[1].sendToFirstTextFrameOpportunityMs, null, 'hidden rendering is not counted as a visible frame')
visible = true
time = 270
timing.textRendered({ turn_id: 'turn-2' }, body)
frames.shift()()
time = 290
frames.shift()()
assert.equal(timing.snapshots()[1].sendToFirstTextFrameOpportunityMs, 90)

timing.begin('client-3', 300)
assert.equal(timing.snapshots().length, 2, 'client records are bounded')
timing.textReceived({ request_id: 'request-1' })
assert.equal(timing.snapshots().find(value => value.clientMessageId === 'client-3').sendToFirstTextReceivedMs, null)
timing.failed({ client_message_id: 'client-3' })
timing.textRendered({ client_message_id: 'client-3' }, body)
assert.equal(timing.snapshots().find(value => value.clientMessageId === 'client-3').sendToFirstTextDomMs, null)
const external = timing.snapshots()
external[0].sendToFirstTextDomMs = -1
assert.notEqual(timing.snapshots()[0].sendToFirstTextDomMs, -1, 'snapshot inspection cannot mutate records')
console.log('PASS client request correlation, first real DOM text, frame opportunity, races, privacy and bounds')
