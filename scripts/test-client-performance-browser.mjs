// Real Chromium + production chat rendering, with synthetic local HTTP/SSE.
// This validates measurement plumbing; these delays are not model benchmarks.
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('../', import.meta.url))
const clients = new Set()
let sequence = 0
const emit = (type, data) => {
  for (const client of clients) client.write(`data: ${JSON.stringify({ type, data })}\n\n`)
}
const pageSource = `<!doctype html><meta charset="utf-8">
<style>#chat-area{width:600px}#chat-history{height:400px}#chat-messages{height:350px;overflow:auto}
.msg{margin:8px;padding:8px}.msg-body{display:block}</style>
<div id="chat-area"><div id="chat-history"><div id="chat-messages"></div></div>
<textarea id="msg-input"></textarea><button id="send-btn">Send</button>
<div id="slash-menu" hidden></div></div>
<script type="module">
import {initChat} from "/src/ui/brain-ui/chat.js";
import {clientRequestPerformance, getClientRequestPerformance} from "/src/ui/brain-ui/request-performance.js";
const chat=initChat({apiBase:location.origin,historyPageSize:30,activationWarmupKey:"test",
getAgentName:()=>"Test",defaultInputPlaceholder:()=>"Message"});
let raw="";
const source=new EventSource("/events");
source.onmessage=event=>{
 const {type,data}=JSON.parse(event.data);
 if(type==="message_received")clientRequestPerformance.correlate(data);
 if(type==="stream_start"&&data.mode==="text"){
  raw="";clientRequestPerformance.correlate(data);chat.beginLiveJarvisMsg({alert:false});
 }
 if(type==="stream_chunk"&&data.mode==="text"){
  clientRequestPerformance.textReceived(data);
  raw+=data.text;const body=chat.updateLiveJarvisMsg(raw);
  clientRequestPerformance.textRendered(data,body);
 }
 if(type==="message")chat.finalizeLiveJarvisMsg(data.content,{messageId:String(data.conversation_id),performance:data});
};
window.harness={chat,snapshots:getClientRequestPerformance};
</script>`
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(pageSource); return
    }
    if (req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders()
      clients.add(res); req.on('close', () => clients.delete(res)); return
    }
    if (req.url === '/message') {
      let text = ''
      for await (const chunk of req) text += chunk
      const body = JSON.parse(text)
      const id = ++sequence
      const metadata = { request_id: `request-${id}`, client_message_id: body.client_message_id, turn_id: `turn-${id}` }
      emit('message_received', metadata)
      emit('stream_start', { ...metadata, mode: 'think' })
      emit('stream_chunk', { ...metadata, mode: 'think', text: 'SYNTHETIC_PRIVATE_REASONING' })
      await delay(60)
      if (body.content !== 'reasoning-only') {
        emit('stream_start', { ...metadata, mode: 'text', plainReply: true })
        emit('stream_chunk', { ...metadata, mode: 'text', text: '真实回复' })
        // Replace the short-lived stream DOM before the next rendering frame.
        emit('message', { ...metadata, content: '真实回复', conversation_id: id })
      }
      await delay(100)
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Bailongma-Request-ID': metadata.request_id })
      res.end(JSON.stringify({ ok: true, ...metadata, conversation_id: id }))
      return
    }
    const filename = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname)
    if (!filename.startsWith(root) || !filename.endsWith('.js')) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'Content-Type': 'text/javascript' })
    res.end(await fs.readFile(filename))
  } catch { res.writeHead(500); res.end() }
})
let browser
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.waitForFunction(() => Boolean(window.harness))
  await page.waitForFunction(() => document.readyState === 'complete')
  while (!clients.size) await delay(5)
  await page.evaluate(() => window.harness.chat.send({ text: 'first-visible-test' }))
  await page.waitForFunction(() => window.harness.snapshots()[0]?.sendToFirstTextFrameOpportunityMs != null)
  const first = await page.evaluate(() => window.harness.snapshots()[0])
  assert.equal(first.requestId, 'request-1')
  assert.equal(first.turnId, 'turn-1')
  assert.ok(first.sendToFirstTextDomMs < first.sendToAcceptedHeadersMs, 'real SSE DOM output can precede POST acknowledgement')
  assert.ok(first.sendToFirstTextFrameOpportunityMs >= first.sendToFirstTextDomMs)
  assert.equal(await page.locator('.msg-jarvis .msg-body').textContent(), '真实回复')
  await page.evaluate(() => window.harness.chat.send({ text: 'reasoning-only' }))
  const snapshots = await page.evaluate(() => window.harness.snapshots())
  assert.equal(snapshots[1].sendToFirstTextDomMs, null, 'reasoning does not count as visible chat reply')
  assert.equal(snapshots[1].sendToFirstTextFrameOpportunityMs, null)
  assert.ok(!JSON.stringify(snapshots).includes('PRIVATE_REASONING'))
  assert.deepEqual(errors, [])
  console.log('PASS Chromium chat send/DOM/frame measurement, SSE-before-ack, short finalization and reasoning exclusion')
  console.log(JSON.stringify({ syntheticTiming: first }))
} finally {
  await browser?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
