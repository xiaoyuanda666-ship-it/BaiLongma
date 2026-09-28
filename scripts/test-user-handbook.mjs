import http from 'node:http'
import vm from 'node:vm'
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { DOC_TOPICS, buildDocPanelStateContext, setDocPanelState, buildDocRuntimeContext } from '../src/docs.js'
const root = path.resolve(import.meta.dirname, '..')
const assets = path.join(root, 'src/ui/brain-ui/guide-assets')
const output = path.join(root, '../outputs/handbook')
await fs.mkdir(assets, { recursive: true }); await fs.mkdir(output, { recursive: true })
const executorSource = await fs.readFile(path.join(root, 'src/capabilities/executor.js'), 'utf8')
const toolFunction = executorSource.slice(executorSource.indexOf('function execOpenDocPanel('), executorSource.indexOf('function execPersonCardMode('))
let toolState = { active: false, topicId: null }
const toolEvents = []
const runPanelTool = vm.runInNewContext(`(${toolFunction})`, {
  DOC_TOPICS,
  getDocPanelState: () => toolState,
  setDocPanelState: update => (toolState = { ...update, topicId: update.topicId || toolState.topicId }),
  emitEvent: (name, payload) => toolEvents.push({ name, payload }),
})
assert.equal(JSON.parse(runPanelTool({action:'open'})).topic, 'voice_config')
for (const topic of Object.keys(DOC_TOPICS)) {
  assert.equal(JSON.parse(runPanelTool({action:'open',topic})).topic, topic)
  assert.equal(toolEvents.at(-2).payload.topic, topic)
}
assert.equal(JSON.parse(runPanelTool({action:'close'})).state.active, false)
const requests = []
const server = http.createServer(async (req, res) => {
  requests.push(req.url)
  const json = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)) }
  if (req.url === '/docs') return json({ topics: Object.values(DOC_TOPICS) })
  if (req.url.startsWith('/docs/')) return json({ doc: DOC_TOPICS[req.url.slice(6)] })
  if (req.url === '/doc-panel-state') return json({ ok: true })
  if (req.url === '/') { res.setHeader('Content-Type','text/html'); return res.end('<html><head><link rel="stylesheet" href="/src/ui/brain-ui/styles.css"></head><body data-theme="midnight"><script type="module">import {renderBrainUiApp} from "/src/ui/brain-ui/app-shell.js"; renderBrainUiApp();</script></body></html>') }
  try {
    const file = path.resolve(root, '.' + req.url)
    if (!file.startsWith(root + path.sep)) throw Error('path')
    res.setHeader('Content-Type', ({'.js':'text/javascript','.css':'text/css','.png':'image/png'})[path.extname(file)] || 'text/plain')
    res.end(await fs.readFile(file))
  } catch { res.statusCode = 404; res.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 940 }, deviceScaleFactor: 1 })
  const errors = []; page.on('pageerror', e => errors.push(e.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.waitForSelector('#settings-overlay', { state: 'attached' })
  // Screenshots of production markup/CSS in an isolated, empty-account fixture.
  for (const [tab, name, anchor] of [['llm','model-settings'],['voice','voice-settings'],['voice','tts-settings','tts-provider-select'],['social','social-settings']]) {
    await page.evaluate(({tab, anchor}) => {
      document.querySelector('#settings-overlay').hidden = false
      document.querySelectorAll('.settings-tab,.settings-nav-item').forEach(el => el.classList.toggle('active', el.dataset.tab === tab))
      document.querySelectorAll('.settings-input').forEach(el => el.value = '')
      document.querySelector('#tts-provider-select').value = 'openai'
      document.querySelector('#tts-voice-select').innerHTML = '<option>alloy</option>'
      document.querySelector('#voice-config-status').textContent = '请选择识别服务，并在此填写自己的凭据。'
      const content = document.querySelector('.settings-content'); if (content) content.scrollTop = 0
      if (anchor) document.getElementById(anchor)?.scrollIntoView({ block: 'center' })
    }, {tab, anchor})
    await page.locator('.settings-modal').screenshot({ path: path.join(assets, name + '.png') })
  }
  await page.evaluate(async () => {
    document.querySelector('#settings-overlay').hidden = true
    window.docs = await import('/src/ui/brain-ui/doc.js')
    await window.docs.initDocPanel()
    window.docs.setDocPanelMode(true, {topicId:'voice_config'})
  })
  await page.getByText('先认识两种语音能力', {exact:true}).first().waitFor()
  for (const [width,height] of [[1440,960],[1024,768],[737,946],[390,740],[760,480]]) {
    await page.setViewportSize({width,height}); await page.waitForTimeout(450)
    const close = page.locator('#dp-close-btn'); const box = await close.boundingBox()
    assert(box && box.x >= 0 && box.x + box.width <= width && box.y + box.height <= height, `close visible at ${width}`)
    assert(await close.evaluate(el => { const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)) }), 'close receives pointer')
    assert(await page.locator('#dp-content').evaluate(el => el.clientHeight > 100 && el.scrollWidth <= el.clientWidth + 1))
    await page.locator('#doc-panel').screenshot({path:path.join(output,`handbook-${width}.png`)})
    await close.click(); assert.equal(await page.locator('#doc-panel').getAttribute('aria-hidden'), 'true')
    await page.evaluate(() => window.docs.setDocPanelMode(true))
  }
  await page.setViewportSize({width:1440,height:960})
  for (const topic of Object.keys(DOC_TOPICS)) {
    await page.locator(`[data-topic="${topic}"]`).click()
    await page.waitForFunction(title => document.querySelector('#dp-title').textContent === title, DOC_TOPICS[topic].title)
    for (const button of await page.locator('.dp-nav-item').all()) {
      await button.click()
      for (const img of await page.locator('.dp-figure img').all()) {
        await img.scrollIntoViewIfNeeded()
        await img.evaluate(el => el.decode())
      }
    }
  }
  await page.locator('#dp-close-btn').focus(); await page.keyboard.press('Escape')
  assert.equal(await page.locator('#doc-panel').getAttribute('aria-hidden'), 'true')
  assert(!requests.some(url => url.startsWith('/settings/')), 'handbook never reads/writes configuration')
  assert.equal(await page.locator('#doc-panel input, #doc-panel select').count(), 0)
  assert.deepEqual(errors, [])
  const rules = buildDocPanelStateContext('voice_asr')
  assert(!rules.includes('Before any text reply'))
  setDocPanelState({active:true, topicId:'model_config'})
  assert(buildDocRuntimeContext('语音识别').includes('选择你的对话模型'))
  assert(!buildDocRuntimeContext('语音识别').includes('用声音，表达你的想法'))
  console.log('PASS: all topics/images, no settings requests, close hit targets at 5 sizes, Escape, no page errors.')
} finally { await browser.close(); server.close() }
