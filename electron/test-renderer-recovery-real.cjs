'use strict'
// Isolated Electron renderer crash; never opens the backend or real user data.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { installRendererRecovery } = require('./renderer-recovery.cjs')
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-renderer-test-'))
app.setPath('userData', userData)
app.on('will-quit', () => fs.rmSync(userData, { recursive: true, force: true }))
const deadline = setTimeout(() => { console.error('Renderer recovery timed out'); app.exit(1) }, 20_000)
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } })
  const url = 'data:text/html,<body>recovery-ok</body>'
  let crashed = false
  installRendererRecovery(window, { reload: () => window.loadURL(url) })
  window.webContents.on('did-finish-load', async () => {
    if (!crashed) {
      crashed = true
      window.webContents.forcefullyCrashRenderer()
      return
    }
    try {
      assert.equal(await window.webContents.executeJavaScript('document.body.textContent'), 'recovery-ok')
      console.log('PASS: real crashed Electron renderer restored and executed JavaScript')
      clearTimeout(deadline)
      app.quit()
    } catch (error) { console.error(error); app.exit(1) }
  })
  await window.loadURL(url)
}).catch(error => { console.error(error); app.exit(1) })
