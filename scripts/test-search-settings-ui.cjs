// Run with Electron (not ELECTRON_RUN_AS_NODE). Isolated UI fixture; no real credentials or provider calls.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const assert = require('node:assert/strict')
const project = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-search-ui-'))
app.setPath('userData', temp)
let state = { connections: [{ id: 'llm-deepseek', name: 'DeepSeek（复用模型凭证）', adapter: 'deepseek', enabled: true, credentialSource: 'llm', llmProvider: 'deepseek', configured: true }],
  defaultProvider: 'auto', rules: [], fallback: { enabled: false, providers: [] }, adapters: [
    { id: 'deepseek', name: 'DeepSeek', baseURL: 'https://api.deepseek.com', model: '' },
    { id: 'tencent-yuanbao', name: '腾讯元宝', baseURL: 'https://api.wsa.cloud.tencent.com', model: '' },
  ] }
let writes = 0
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/src/ui/brain-ui/styles.css"><script type="module">
import { renderBrainUiApp } from '/src/ui/brain-ui/app-shell.js';
import { initSearchSettings } from '/src/ui/brain-ui/search-settings.js';
renderBrainUiApp(); document.querySelector('#settings-overlay').hidden=false;
document.querySelectorAll('.settings-tab,.settings-nav-item').forEach(e=>e.classList.toggle('active',e.dataset.tab==='search'));
window.searchSettings=initSearchSettings(); await window.searchSettings.load(); window.ready=true;
</script>`
const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/settings/search')) {
    let body = ''; for await (const chunk of req) body += chunk
    if (req.method === 'POST' && req.url === '/settings/search') {
      state = JSON.parse(body); writes++
      state.connections = state.connections.map(({ apiKey, ...item }) => ({ ...item, configured: !!apiKey || item.configured }))
    }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(req.url.endsWith('/test') ? { ok: true, resultCount: 1 } : { ok: true, search: state })); return
  }
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(html); return }
  const file = path.resolve(project, '.' + req.url.split('?')[0])
  if (!file.startsWith(project + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream')
  fs.createReadStream(file).pipe(res)
})
let win
async function waitFor(expression) {
  const start = Date.now()
  while (!await win.webContents.executeJavaScript(expression)) {
    if (Date.now() - start > 5000) throw new Error(`Timed out: ${expression}`)
    await new Promise(resolve => setTimeout(resolve, 30))
  }
}
;(async () => {
  await app.whenReady(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  win = new BrowserWindow({ show: false, width: 1160, height: 1000, webPreferences: { contextIsolation: true, nodeIntegration: false } })
  await win.loadURL(`http://127.0.0.1:${server.address().port}`); await waitFor('window.ready === true')
  await win.webContents.executeJavaScript(`document.querySelector('[data-add]').click();
    const row=document.querySelectorAll('[data-id]')[1];
    const key=row.querySelector('[data-field="apiKey"]'); key.value='ui-test-key'; key.dispatchEvent(new Event('input',{bubbles:true}));
    const name=row.querySelector('[data-field="name"]'); name.value='<img src=x onerror=alert(1)>'; name.dispatchEvent(new Event('input',{bubbles:true}));
    const def=document.querySelector('[data-default]'); def.value=row.dataset.id; def.dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('[data-add-rule]').click();
    document.querySelector('[data-save]').click();`)
  await waitFor(`document.querySelector('[data-feedback]').textContent === '已保存'`)
  assert.equal(writes, 1)
  assert.equal(state.connections.length, 2)
  assert.equal(state.defaultProvider, state.connections[1].id)
  assert.equal(state.rules.length, 1)
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-field="apiKey"]').value`), '')
  assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#search-settings-root img').length`), 0)
  await win.webContents.executeJavaScript(`document.querySelectorAll('[data-test]')[1].click()`)
  await waitFor(`document.querySelector('[data-feedback]').textContent.includes('连接正常')`)
  await win.reload(); await waitFor('window.ready === true')
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-default]').value`), state.defaultProvider)
  const screenshot = process.env.BAILONGMA_SEARCH_UI_SCREENSHOT
  if (screenshot) fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG())
  console.log('PASS search settings UI: add, credentials, default, rules, save, test, reload and HTML escaping')
})().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => {
  win?.destroy(); server.close(); fs.rmSync(temp, { recursive: true, force: true }); app.exit(process.exitCode || 0)
})
