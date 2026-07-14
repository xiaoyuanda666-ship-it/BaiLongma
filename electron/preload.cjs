const { contextBridge, ipcRenderer, webFrame } = require('electron')

contextBridge.exposeInMainWorld('jarvis', {
  platform: process.platform,
  isElectron: true,
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check-for-updates'),
  startDownload: () => ipcRenderer.invoke('updater:start-download'),
  quitAndInstall: () => ipcRenderer.invoke('updater:quit-and-install'),
  getLatestSystemScreenshot: (options) => ipcRenderer.invoke('system-screenshot:get-latest', options || {}),
  getStartupProgress: () => ipcRenderer.invoke('startup:get-progress'),
  onStartupProgress: (handler) => {
    if (typeof handler !== 'function') return () => {}
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('startup:progress', listener)
    return () => ipcRenderer.removeListener('startup:progress', listener)
  },
  getZoomFactor: () => webFrame.getZoomFactor(),
  setZoomFactor: (factor) => webFrame.setZoomFactor(factor),
  onUpdaterStatus: (handler) => {
    if (typeof handler !== 'function') return () => {}
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('updater:status', listener)
    return () => ipcRenderer.removeListener('updater:status', listener)
  },
  // 语音唤醒:命中「小白龙」由主进程经 wake:hit 通知本渲染层(唤醒会话编排见 voice-wake.js);
  // 悬浮球窗口由本渲染层经下列命令驱动(主进程转发给球窗)。
  wake: {
    onHit: (handler) => {
      if (typeof handler !== 'function') return () => {}
      const listener = () => handler()
      ipcRenderer.on('wake:hit', listener)
      return () => ipcRenderer.removeListener('wake:hit', listener)
    },
    orbEnter: () => ipcRenderer.send('wake:orb-enter'),
    orbFrame: (payload) => ipcRenderer.send('wake:orb-frame', payload),
    orbText: (payload) => ipcRenderer.send('wake:orb-text', payload),
    orbExit: () => ipcRenderer.send('wake:orb-exit'),
  },
})
