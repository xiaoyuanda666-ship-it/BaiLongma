// A browser boundary for the isolated real-model performance probe. The page
// uses production chat.send(), markdown rendering and client timing records.
// The host supplies real /message and /events routes; no provider is mocked here.
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

export const performanceBrowserPath = '/__request-performance'

export const performanceBrowserHtml = String.raw`<!doctype html>
<html><head><meta charset="utf-8"><title>Request performance</title>
<style>
html,body{margin:0;background:#fff;color:#111;font:16px sans-serif}
#chat-area{width:700px;margin:20px}
#chat-history{height:470px}
#chat-messages{height:440px;overflow:auto}
.msg{margin:8px;padding:8px}.msg-body{display:block}.msg-label{display:block;font-weight:bold}
#msg-input{width:620px;height:44px}
</style></head><body>
<div id="chat-area"><div id="chat-history"><div id="chat-messages"></div></div>
<textarea id="msg-input"></textarea><button id="send-btn">Send</button>
<div id="slash-menu" hidden></div></div>
<script type="module">
import {initChat} from "/src/ui/brain-ui/chat.js";
import {getUiClientId,isUiClientTarget} from "/src/ui/brain-ui/api-client.js";
import {clientRequestPerformance,getClientRequestPerformance} from "/src/ui/brain-ui/request-performance.js";
const chat=initChat({
  apiBase:location.origin,historyPageSize:30,activationWarmupKey:"performance-probe",
  getAgentName:()=>"Assistant",defaultInputPlaceholder:()=>"Message"
});
const clientId=getUiClientId();
const states=new Map();
let activeId="";
let connected=false;
let filteredEvents=0;
let parseErrors=0;
let sseErrors=0;
// Keep the production app's protocol-marker filtering before chat rendering.
function cleanStreamText(raw){
  let text=String(raw||"").replace(/\[(?:RECALL:[\s\S]*?|SET_TASK:[\s\S]*?|CLEAR_TASK|UPDATE_PERSONA:[\s\S]*?)\]/g,"");
  const open=text.lastIndexOf("[");
  if(open>=0&&text.indexOf("]",open)===-1&&/^\[[A-Z_]*(:[\s\S]*)?$/.test(text.slice(open)))text=text.slice(0,open);
  return text;
}
function recordFor(data){
  if(!isUiClientTarget(data))return null;
  if(data.client_id&&data.client_id!==clientId)return null;
  clientRequestPerformance.correlate(data);
  const clientMessageId=data.client_message_id||data.clientMessageId;
  const requestId=data.request_id||data.requestId;
  const turnId=data.turn_id||data.turnId;
  return getClientRequestPerformance().find(record=>
    (clientMessageId&&record.clientMessageId===clientMessageId)||
    (requestId&&record.requestId===requestId)||
    (turnId&&record.turnId===turnId)
  )||null;
}
const source=new EventSource("/events?client_id="+encodeURIComponent(clientId));
source.onopen=()=>{connected=true};
source.onerror=()=>{sseErrors++};
source.onmessage=event=>{
  let message;
  try{message=JSON.parse(event.data)}catch{parseErrors++;return}
  const {type,data={}}=message;
  if(!["message_received","stream_start","stream_chunk","message"].includes(type))return;
  const record=recordFor(data);
  if(!record){filteredEvents++;return}
  const id=record.clientMessageId;
  if(type==="message_received"){
    if(chat.hasLiveJarvisMsg())chat.finalizeLiveJarvisMsg(null);
    activeId="";
    states.set(id,{raw:"",plainReply:false});
    return;
  }
  const state=states.get(id)||{raw:"",plainReply:false};
  states.set(id,state);
  if(type==="stream_start"){
    if(data.mode!=="text")return;
    state.plainReply=data.plainReply===true;
    if(!state.plainReply)return;
    if(activeId!==id){
      activeId=id;
      state.raw="";
      chat.beginLiveJarvisMsg({alert:false});
    }
    return;
  }
  if(type==="stream_chunk"){
    if(data.mode!=="text"||!state.plainReply||activeId!==id)return;
    if(!String(data.text||""))return;
    clientRequestPerformance.textReceived(data);
    state.raw+=String(data.text||"");
    const body=chat.updateLiveJarvisMsg(cleanStreamText(state.raw));
    clientRequestPerformance.textRendered(data,body);
    return;
  }
  if(type==="message"&&data.from==="consciousness"&&String(data.content||"").trim()){
    clientRequestPerformance.textReceived(data);
    const messageId=String(data.conversation_id||data.conversationId||"");
    if(activeId===id&&chat.hasLiveJarvisMsg()){
      chat.finalizeLiveJarvisMsg(data.content,{messageId,performance:data});
    }else{
      const bubble=chat.addMsg("jarvis",data.content,{messageId});
      clientRequestPerformance.textRendered(data,bubble?.querySelector(".msg-body"));
    }
    activeId="";
    state.plainReply=false;
  }
};
window.requestPerformanceBrowser={
  get ready(){return connected},
  clientId,
  async send(text){
    const known=new Set(getClientRequestPerformance().map(record=>record.clientMessageId));
    await chat.send({text,channel:"TUI"});
    return getClientRequestPerformance().find(record=>!known.has(record.clientMessageId))||null;
  },
  snapshots:getClientRequestPerformance,
  diagnostics:()=>({
    filteredEvents,parseErrors,sseErrors,connected,documentHidden:document.hidden,
    replyBodies:document.querySelectorAll(".msg-jarvis .msg-body").length,
    visibleReplyBodies:[...document.querySelectorAll(".msg-jarvis .msg-body")].filter(body=>{
      const box=body.getBoundingClientRect();
      return body.isConnected&&!!body.textContent?.trim()&&body.checkVisibility()
        &&box.width>0&&box.height>0&&box.top<innerHeight&&box.bottom>0;
    }).length
  }),
  close:()=>source.close()
};
</script></body></html>`

// Route only this diagnostic page and production browser module assets. The
// caller retains ownership of the HTTP server and message/event route handlers.
export async function handlePerformanceBrowserAsset(req, res, { root } = {}) {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname
  if (req.method !== 'GET') return false
  if (pathname === performanceBrowserPath) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(performanceBrowserHtml)
    return true
  }
  if (!pathname.startsWith('/src/ui/brain-ui/') || !pathname.endsWith('.js')) return false
  const assetRoot = path.resolve(root, 'src/ui/brain-ui')
  const filename = path.resolve(root, '.' + pathname)
  if (!filename.startsWith(assetRoot + path.sep)) {
    res.writeHead(404).end()
    return true
  }
  try {
    const source = await fs.readFile(filename)
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(source)
  } catch {
    res.writeHead(404).end()
  }
  return true
}

export async function createPerformanceBrowser({ headless = true, timeoutMs = 30_000 } = {}) {
  let browser
  let page
  let allowedOrigin
  let pageErrors = 0
  let blockedExternalRequests = 0
  const requirePage = () => {
    if (!page) throw new Error('Performance browser has not started')
    return page
  }
  return {
    async start(url) {
      if (browser) throw new Error('Performance browser already started')
      const destination = new URL(url)
      allowedOrigin = destination.origin
      if (destination.pathname === '/' || !destination.pathname) destination.pathname = performanceBrowserPath
      browser = await chromium.launch({ headless })
      page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
      page.setDefaultTimeout(timeoutMs)
      page.on('pageerror', () => { pageErrors++ })
      await page.route('**/*', route => {
        if (new URL(route.request().url()).origin === allowedOrigin) return route.continue()
        blockedExternalRequests++
        return route.abort()
      })
      await page.goto(destination.toString(), { waitUntil: 'load' })
      await page.waitForFunction(() => window.requestPerformanceBrowser?.ready === true)
      return { clientId: await page.evaluate(() => window.requestPerformanceBrowser.clientId) }
    },
    async send(message) {
      const snapshot = await requirePage().evaluate(
        text => window.requestPerformanceBrowser.send(text),
        String(message),
      )
      if (!snapshot || snapshot.failed || snapshot.sendToAcceptedHeadersMs == null) {
        throw new Error('Production chat did not accept the diagnostic message')
      }
      return snapshot
    },
    async snapshot(clientMessageId, { waitMs = 100 } = {}) {
      // Called after runTurn: allow at most 100 ms for already-arrived SSE and
      // the production double-rAF visibility check. A missing token stays null.
      return requirePage().evaluate(async ({ clientMessageId, waitMs }) => {
        const until = performance.now() + waitMs
        let snapshot
        do {
          snapshot = window.requestPerformanceBrowser.snapshots()
            .find(record => record.clientMessageId === clientMessageId) || null
          if (!snapshot || snapshot.failed || snapshot.sendToFirstTextFrameOpportunityMs != null) break
          const remaining = until - performance.now()
          if (remaining <= 0) break
          await new Promise(resolve => setTimeout(resolve, Math.min(10, remaining)))
        } while (performance.now() <= until)
        return snapshot
      }, { clientMessageId, waitMs: Math.max(0, Math.min(100, Number(waitMs) || 0)) })
    },
    async snapshots() {
      return requirePage().evaluate(() => window.requestPerformanceBrowser.snapshots())
    },
    async diagnostics() {
      const client = page
        ? await page.evaluate(() => window.requestPerformanceBrowser?.diagnostics() || {})
        : {}
      return { pageErrors, blockedExternalRequests, ...client }
    },
    async close() {
      try {
        if (page && !page.isClosed()) await page.evaluate(() => window.requestPerformanceBrowser?.close())
      } finally {
        await browser?.close()
        page = null
        browser = null
      }
    },
  }
}
