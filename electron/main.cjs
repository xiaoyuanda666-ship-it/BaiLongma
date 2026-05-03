// Windows: 把控制台代码页切到 UTF-8，避免中文 stdout 显示为乱码
if (process.platform === 'win32') {
  try {
    require('child_process').execSync('chcp 65001', { stdio: 'ignore', windowsHide: true })
  } catch (_) {}
}

const { app, BrowserWindow, shell, dialog, Menu, ipcMain, globalShortcut } = require('electron')
const path = require('path')
const net = require('net')
const http = require('http')
const { pathToFileURL } = require('url')
const { autoUpdater } = require('electron-updater')

const IS_DEV = !app.isPackaged
const USER_DIR = app.getPath('userData')
const CODE_ROOT = app.getAppPath()
const RESOURCE_ROOT = CODE_ROOT
const BACKEND_ENTRY = path.join(CODE_ROOT, 'src', 'index.js')

let mainWindow = null
let backendPort = 0

function sendUpdaterStatus(payload = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('updater:status', {
    currentVersion: app.getVersion(),
    ...payload,
  })
}

async function bootstrapBackend(port) {
  process.env.BAILONGMA_USER_DIR ||= USER_DIR
  process.env.BAILONGMA_RESOURCES_DIR ||= RESOURCE_ROOT
  process.env.BAILONGMA_PORT = String(port)
  await import(pathToFileURL(BACKEND_ENTRY).href)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
  process.exit(0)
}

async function findFreePort(preferred = 3721) {
  for (const port of [preferred, 0]) {
    try {
      const actual = await new Promise((resolve, reject) => {
        const server = net.createServer()
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          const address = server.address()
          server.close(() => resolve(address.port))
        })
      })
      return actual
    } catch {}
  }
  throw new Error('Unable to find a free local port')
}

function waitForBackend(port, timeoutMs = 30000) {
  const startedAt = Date.now()
  const url = `http://127.0.0.1:${port}/activation-status`

  return new Promise((resolve, reject) => {
    const tick = () => {
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error('Backend startup timed out'))
        return
      }

      const req = http.get(url, res => {
        res.resume()
        resolve()
      })
      req.on('error', () => setTimeout(tick, 300))
      req.setTimeout(1500, () => {
        req.destroy()
        setTimeout(tick, 300)
      })
    }

    tick()
  })
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0b0e',
    title: 'Bailongma',
    icon: path.join(RESOURCE_ROOT, 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })

  // 授予麦克风权限（语音输入需要）
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') return callback(true)
    callback(false)
  })
  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'media') return true
    return false
  })

  // F12 打开开发者工具（调试用）
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      mainWindow.webContents.toggleDevTools()
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  await mainWindow.loadURL(`http://127.0.0.1:${backendPort}/`)
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    sendUpdaterStatus({ stage: 'checking', message: 'Checking for updates...' })
  })

  autoUpdater.on('update-available', info => {
    console.log('[updater] update available', info?.version)
    sendUpdaterStatus({
      stage: 'available',
      version: info?.version,
      message: `New version ${info?.version || ''} found, downloading...`.trim(),
    })
  })

  autoUpdater.on('download-progress', progress => {
    sendUpdaterStatus({
      stage: 'downloading',
      percent: Number(progress?.percent || 0),
      transferred: progress?.transferred || 0,
      total: progress?.total || 0,
      message: `Downloading update ${Math.round(Number(progress?.percent || 0))}%`,
    })
  })

  autoUpdater.on('update-downloaded', info => {
    sendUpdaterStatus({
      stage: 'downloaded',
      version: info?.version,
      message: `Version ${info?.version || ''} is ready to install`.trim(),
    })

    const result = dialog.showMessageBoxSync(mainWindow, {
      type: 'info',
      title: 'Update ready',
      message: `Bailongma ${info.version} has been downloaded. Restart now to install?`,
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    })

    if (result === 0) autoUpdater.quitAndInstall()
  })

  autoUpdater.on('update-not-available', info => {
    sendUpdaterStatus({
      stage: 'idle',
      version: info?.version || app.getVersion(),
      message: 'You already have the latest version',
    })
  })

  autoUpdater.on('error', err => {
    const message = err?.message || String(err || 'Update failed')
    console.warn('[updater] update failed', message)
    sendUpdaterStatus({
      stage: 'error',
      message,
    })
  })

  if (!IS_DEV) {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {})
  }
}

ipcMain.handle('app:get-version', () => app.getVersion())

ipcMain.handle('updater:check-for-updates', async () => {
  if (IS_DEV) {
    const message = 'Update checks are disabled in development mode'
    sendUpdaterStatus({ stage: 'dev', message })
    return { ok: false, skipped: true, reason: 'dev', message }
  }

  try {
    sendUpdaterStatus({ stage: 'checking', message: 'Checking for updates...' })
    const result = await autoUpdater.checkForUpdates()
    return {
      ok: true,
      updateInfo: result?.updateInfo || null,
    }
  } catch (error) {
    const message = error?.message || String(error || 'Update check failed')
    sendUpdaterStatus({ stage: 'error', message })
    return { ok: false, message }
  }
})

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll()
  if (process.platform !== 'darwin') app.quit()
})

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)

  try {
    backendPort = await findFreePort(3721)
    await bootstrapBackend(backendPort)
    await waitForBackend(backendPort)
  } catch (err) {
    dialog.showErrorBox('Startup failed', `Unable to start the Bailongma backend:\n${err.message}`)
    app.quit()
    return
  }

  await createWindow()
  setupAutoUpdater()

  // F11 切换全屏
  globalShortcut.register('F11', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.setFullScreen(!mainWindow.isFullScreen())
  })

  // 开发快捷键
  if (IS_DEV) {
    globalShortcut.register('F12', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.toggleDevTools()
    })
    globalShortcut.register('CommandOrControl+R', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.reload()
    })
  }
})
