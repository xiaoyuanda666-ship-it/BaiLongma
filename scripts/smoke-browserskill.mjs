// Opt-in real browser smoke. Uses a dedicated Agent Window; never borrows user tabs.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'bailongma-bsk-smoke-'))
process.env.BAILONGMA_USER_DIR = scratch
process.env.BAILONGMA_BROWSER_BACKEND = 'browserskill'
const { executeBuiltInChromeTool, getMcpToolSchema } = await import('../src/mcp/client-manager.js')
const { stopBrowserSkillForContext, getBrowserSkillStatus, controlBrowserTask, runBsk } = await import('../src/mcp/browserskill-client.js')
const context = { browserLeaseState: { lease: null } }
const { handleBrowserPreviewRoutes } = await import('../src/api/routes/browser-preview.js')
const server = http.createServer(async (req,res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname.startsWith('/browser-backend')) {
    await handleBrowserPreviewRoutes(req,res,url,{requireLocalOrToken:()=>true});return
  }
  if (['/browser-tasks.js','/api-client.js'].includes(url.pathname)) {
    res.setHeader('Content-Type','text/javascript');res.end(await fs.readFile(new URL(`../src/ui/brain-ui${url.pathname}`,import.meta.url)));return
  }
  res.setHeader('Content-Type','text/html')
  if (url.pathname === '/panel') {
    res.end(`<body><script type="module">import {initBrowserTasks} from '/browser-tasks.js'; document.body.innerHTML='<h1>Isolated Browser Task Panel</h1>';initBrowserTasks();</script></body>`);return
  }
  res.end(`<!doctype html><title>BaiLongma isolated test</title><label>Test input <input id="field"></label><button onclick="document.getElementById('result').textContent='Saved: '+document.getElementById('field').value">Save test</button><p id="result">Not saved</p><div style="height:1600px">Scroll test</div>`)
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const invoke = async (name,args={}) => {
  const result=JSON.parse(await executeBuiltInChromeTool(name,args,context));assert.equal(result.ok,true,JSON.stringify(result));return result
}
let ownedId

try {
  const status = await getBrowserSkillStatus()
  assert.equal(status.ready, true, JSON.stringify(status))
  assert.match(getMcpToolSchema('browser_snapshot').function.description, /BrowserSkill/)
  const navigation = JSON.parse(await executeBuiltInChromeTool('browser_navigate', { url: 'https://example.com/' }, context))
  assert.equal(navigation.ok, true, JSON.stringify(navigation))
  assert.match(navigation.content[0].text, /Example Domain/)
  const tabs = JSON.parse(await executeBuiltInChromeTool('browser_tabs', { action: 'list' }, context))
  assert.equal(tabs.ok, true, JSON.stringify(tabs))
  assert.ok(tabs.structured_content.tabs.every(tab => tab.scope === 'agent'))
  const screenshot = JSON.parse(await executeBuiltInChromeTool('browser_take_screenshot', {}, context))
  assert.equal(screenshot.ok, true, JSON.stringify(screenshot))
  const bytes = await fs.readFile(screenshot.screenshot.image_path)
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  ownedId = navigation.session_id
  let page = await invoke('browser_navigate',{url:`http://127.0.0.1:${server.address().port}/`})
  const field = page.content[0].text.split('\n').find(line=>/@e\d+ textbox/i.test(line))?.match(/@e\d+/)?.[0]
  assert.ok(field, page.content[0].text)
  page = await invoke('browser_type',{ref:field,text:'isolated smoke',replace:true})
  const save = page.content[0].text.split('\n').find(line=>/Save test/.test(line))?.match(/@e\d+/)?.[0]
  assert.ok(save,page.content[0].text)
  page = await invoke('browser_click',{ref:save})
  assert.match(page.content[0].text,/Saved: isolated smoke/)
  await invoke('browser_scroll',{delta_y:300})
  await controlBrowserTask(ownedId,'takeover')
  const denied = JSON.parse(await executeBuiltInChromeTool('browser_reload',{},context))
  assert.equal(denied.code,'BSK_USER_CONTROL')
  await controlBrowserTask(ownedId,'resume')
  assert.equal(JSON.parse(await executeBuiltInChromeTool('browser_click',{ref:save},context)).code,'BSK_FRESH_OBSERVATION_REQUIRED')
  await invoke('browser_snapshot')
  page = await invoke('browser_navigate',{url:`http://127.0.0.1:${server.address().port}/panel`})
  const summary = page.content[0].text.split('\n').find(line=>/Chrome 浏览器任务/.test(line) && /@e\d+/.test(line))?.match(/@e\d+/)?.[0]
  assert.ok(summary,page.content[0].text)
  await invoke('browser_click',{ref:summary})
  page = await invoke('browser_snapshot')
  assert.match(page.content[0].text,/连接状态|ready/)
  assert.match(page.content[0].text,/接管 \/ 取消任务/)
  console.log('PASS: real Chrome renders task-only UI with status API and actionable controls')
  const created = await invoke('browser_tabs',{action:'create'})
  const tabId = created.structured_content.tab_id
  assert.ok(tabId)
  await invoke('browser_tabs',{action:'close',tab_id:tabId})
  console.log('PASS: local test form input/click, wheel, takeover blocks Agent, resume requires fresh refs, owned tab create/close')
  console.log('PASS: public browser tools → BrowserSkill → Chrome: navigation, observation, task-owned tabs, PNG screenshot')
} finally {
  await stopBrowserSkillForContext(context)
  server.closeAllConnections()
  server.close()
  const remaining = await runBsk(['session','list'],{autoStart:false})
  assert.equal(JSON.stringify(remaining).includes(ownedId || 'never-created-session'),false)
  await fs.rm(scratch, { recursive: true, force: true })
}
console.log('PASS: task session stopped and smoke artifacts removed')
