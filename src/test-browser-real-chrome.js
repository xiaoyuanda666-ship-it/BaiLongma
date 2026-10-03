import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-browser-test-'))
process.env.BAILONGMA_USER_DIR = scratch
const { browserSkillOptions, saveBrowserSkillSettings, browserBackend } = await import('./mcp/browser-backend.js')
const { BrowserSkillSession, getBrowserSkillStatus, controlBrowserTask, releaseBrowserSkillForContext, browserTasks, runBsk } = await import('./mcp/browserskill-client.js')
const { executeBrowserSkillTool } = await import('./mcp/browserskill-tools.js')
const chrome = id => ({instance_id:id, browser_name:'chrome', extension_version:'0.3.1', extension_protocol_version:'1.3'})
const status = browsers => ({daemon_version:'0.3.1', protocol_version:'1.3', browsers})
const runner = browsers => async args => args[0] === '--version' ? {version:'0.3.1'} : status(browsers)
function fixture() {
  const calls = []
  const session = new BrowserSkillSession({options:{browser:'one'}, run:async args => {
    calls.push(args)
    if (args[0] === 'session' && args[1] === 'request') return {state:args.includes('--prepare') ? 'prepared' : args.includes('--cancel') ? 'closed' : 'active',session:{session_id:'owned'}}
    if (args[0] === '--version') return {version:'0.3.1'}
    if (args[0] === 'status') return status([chrome('one')])
    if (args[0] === 'session') return args[1] === 'start' ? {session_id:'owned'} : {stopped:['owned']}
    if (args[0] === 'debug') return {activity:{state:'idle',wait_complete:true}}
    if (args[0] === 'tab') return {tabs:[{tab_id:1,scope:'agent',active:true,url:'https://example.com'}]}
    if (args[0] === 'observe') return {tab_id:1,text:'@e1 button Test'}
    return {tab_id:1}
  }})
  const context = {replyClientId:'test-ui', browserLeaseState:{}}
  const invoke = async (name,args={}) => JSON.parse(await executeBrowserSkillTool(name,args,context,{sessionFactory:()=>session}))
  return {session,context,invoke,calls}
}
test.after(() => fs.rmSync(scratch,{recursive:true,force:true}))
test('desktop PATH discovery, explicit CLI and persisted instance binding', () => {
  const dir=path.join(scratch,'bin');fs.mkdirSync(dir);const bin=path.join(dir,process.platform === 'win32' ? 'bsk.exe' : 'bsk');fs.writeFileSync(bin,'',{mode:0o700})
  assert.equal(browserSkillOptions({PATH:'',BSK_INSTALL_DIR:dir}).binary,bin)
  saveBrowserSkillSettings({browser:'one',binary:bin})
  assert.equal(browserSkillOptions({}).browser,'one')
  assert.equal(browserSkillOptions({BAILONGMA_BSK_PATH:'/explicit/bsk'}).binary,'/explicit/bsk')
  assert.equal(browserBackend({BAILONGMA_BROWSER_BACKEND:'embedded'}),'browserskill')
})
test('missing executable has actionable status; does not launch alternative',async () => {
  const s=await getBrowserSkillStatus({options:{binary:path.join(scratch,'missing')}})
  assert.equal(s.code,'BSK_NOT_INSTALLED');assert.equal(s.ready,false);assert.match(s.guide,/Tencent/)
})
test('multiple Chrome instances require selection and lost binding cannot switch', async () => {
  const browsers=[chrome('one'),chrome('two')]
  assert.equal((await getBrowserSkillStatus({run:runner(browsers),options:{}})).state,'browser_selection_required')
  assert.equal((await getBrowserSkillStatus({run:runner(browsers),options:{browser:'one'}})).ready,true)
  assert.equal((await getBrowserSkillStatus({run:runner([chrome('two')]),options:{browser:'one'}})).state,'browser_not_connected')
})
test('incompatible daemon/extension or CLI blocks start',async () => {
  const b=chrome('one');b.extension_protocol_version='1.2'
  const s=await getBrowserSkillStatus({run:runner([b]),options:{browser:'one'}})
  assert.equal(s.state,'version_mismatch');assert.equal(s.ready,false)
})
test('takeover blocks all Agent actions; resume requires fresh observation; turn retains page',async () => {
  const f=fixture()
  try {
    assert.equal((await f.invoke('browser_navigate',{url:'https://example.com'})).ok,true)
    await releaseBrowserSkillForContext(f.context);assert.equal(f.session.id,'owned')
    await controlBrowserTask('owned','takeover')
    assert.equal((await f.invoke('browser_navigate',{url:'https://example.com'})).code,'BSK_USER_CONTROL')
    await controlBrowserTask('owned','resume')
    assert.equal((await f.invoke('browser_click',{ref:'@e1'})).code,'BSK_FRESH_OBSERVATION_REQUIRED')
    await f.invoke('browser_snapshot')
    assert.equal((await f.invoke('browser_click',{ref:'@e1'})).ok,true)
  } finally {await f.session.stop()}
  assert.equal(browserTasks().length,0)
})
test('takeover waits for in-flight action and prevents next form field',async () => {
  const f=fixture();let release,entered
  const ready=new Promise(r=>{entered=r});const run=f.session.run
  f.session.run=async args=>{if(args[0]==='fill'){entered();await new Promise(r=>{release=r})}return run(args)}
  try {
    await f.invoke('browser_snapshot')
    const filling=f.invoke('browser_fill_form',{fields:[{ref:'@e1',value:'a'},{ref:'@e2',value:'b'}]})
    await ready;const takeover=controlBrowserTask('owned','takeover');release()
    assert.equal((await filling).ok,false);await takeover
    assert.equal(f.calls.filter(a=>a[0]==='fill').length,1)
  } finally {await f.session.stop()}
})
test('cancellation retains same page and background success cleans up',async () => {
  const f=fixture()
  await f.invoke('browser_snapshot');delete f.session.owner
  const controller=new AbortController();controller.abort();f.context.signal=controller.signal
  await releaseBrowserSkillForContext(f.context);assert.equal(f.session.id,'owned');assert.equal(f.session.humanControl,true)
  await f.session.stop()
  const g=fixture();delete g.context.replyClientId
  await g.invoke('browser_snapshot');await releaseBrowserSkillForContext(g.context);assert.equal(g.session.id,null)
})
test('unknown or unrelated tabs cannot be closed',async () => {
  const f=fixture()
  try {await f.invoke('browser_snapshot');assert.equal((await f.invoke('browser_tabs',{action:'close',tab_id:999})).ok,false);assert.equal(f.calls.some(a=>a[0]==='tab'&&a[1]==='close'),false)} finally {await f.session.stop()}
})
test('Electron and UI no longer instantiate webpage hosts; packaging omits browser engines',()=>{
  const root=new URL('../',import.meta.url)
  const main=fs.readFileSync(new URL('electron/main.cjs',root),'utf8')
  assert.doesNotMatch(main,/createBrowserEmbedHost|createBaiLongmaChromeManager|browser-embed:|remote-debugging-port/)
  assert.match(main,/BrowserWindow/)
  const ui=fs.readFileSync(new URL('src/ui/brain-ui/app.js',root),'utf8')
  assert.doesNotMatch(ui,/loadBrowserPreviewImage|showNativeBrowserWindow|browser-surface\/frame/)
  const pkg=JSON.parse(fs.readFileSync(new URL('package.json',root),'utf8'))
  assert.equal(pkg.dependencies['@playwright/mcp'],undefined)
  assert.equal(pkg.dependencies['chrome-devtools-mcp'],undefined)
  assert.equal(pkg.build.extraResources.some(r=>r.to==='playwright-browsers'),false)
})


test('lost session creation response is inspected without repeating start',async()=>{
  const f=fixture();const run=f.session.run;let starts=0
  f.session.run=async args=>{if(args[0]==='session'&&args[1]==='start'){starts++;throw Object.assign(new Error('lost reply'),{code:'BSK_TIMEOUT'})}return run(args)}
  try {assert.equal((await f.invoke('browser_snapshot')).ok,true);assert.equal(starts,1);assert.equal(f.session.id,'owned')}finally{await f.session.stop()}
})

test('simultaneous takeover and resume cannot race ownership',async()=>{
  const f=fixture();const run=f.session.run;let release,entered
  const ready=new Promise(r=>{entered=r})
  f.session.run=async args=>{if(args[0]==='debug'){entered();await new Promise(r=>{release=r})}return run(args)}
  try {
    await f.invoke('browser_snapshot');const taking=controlBrowserTask('owned','takeover');await ready
    await assert.rejects(controlBrowserTask('owned','resume'),{code:'BSK_CONTROL_PENDING'})
    release();await taking;assert.equal(f.session.humanControl,true)
  }finally{await f.session.stop()}
})
test('closing prevents subsequent fields while awaiting accepted input',async()=>{
  const f=fixture();const run=f.session.run;let release,entered
  const ready=new Promise(r=>{entered=r})
  f.session.run=async args=>{if(args[0]==='fill'){entered();await new Promise(r=>{release=r})}return run(args)}
  await f.invoke('browser_snapshot')
  const fill=f.invoke('browser_fill_form',{fields:[{ref:'@e1',value:'a'},{ref:'@e2',value:'b'}]})
  await ready;const closing=f.session.stop();release();assert.equal((await fill).ok,false);await closing
  assert.equal(f.calls.filter(a=>a[0]==='fill').length,1);assert.equal(f.session.id,null)
})
