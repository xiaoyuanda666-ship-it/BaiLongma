'use strict'

// Recover only a renderer that has actually exited. A slow model request or a
// temporarily unresponsive renderer must not discard the user's draft.
function installRendererRecovery(window, {
  isQuitting = () => false,
  reload = () => window.webContents.reload(),
  onExhausted = () => {},
  log = console,
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  const contents = window.webContents
  let timer = null
  let disposed = false
  let attempts = []
  let exhaustionReported = false
  const alive = () => !disposed && !isQuitting() && !window.isDestroyed() && !contents.isDestroyed()
  const recover = () => {
    if (!alive() || timer !== null) return
    attempts = attempts.filter(time => now() - time < 60_000)
    if (attempts.length >= 3) {
      if (!exhaustionReported) {
        exhaustionReported = true
        log.error('[renderer] automatic recovery paused after repeated failures')
        Promise.resolve().then(() => { if (alive()) return onExhausted() })
          .catch(error => log.error('[renderer] recovery notification failed', error))
      }
      return
    }
    exhaustionReported = false
    attempts.push(now())
    timer = schedule(() => {
      timer = null
      if (!alive()) return
      log.warn('[renderer] reloading exited main-window renderer')
      Promise.resolve().then(() => { if (alive()) return reload() }).catch(error => {
        log.error('[renderer] recovery load failed', error)
        recover()
      })
    }, 1000)
  }
  const gone = (_event, details) => {
    log.error('[renderer] render-process-gone', details)
    recover()
  }
  const unresponsive = () => log.warn('[renderer] main window unresponsive')
  const responsive = () => log.info('[renderer] main window responsive')
  const dispose = () => {
    disposed = true
    if (timer !== null) cancel(timer)
    timer = null
    contents.removeListener('render-process-gone', gone)
    window.removeListener('unresponsive', unresponsive)
    window.removeListener('responsive', responsive)
    window.removeListener('closed', dispose)
  }
  contents.on('render-process-gone', gone)
  window.on('unresponsive', unresponsive)
  window.on('responsive', responsive)
  window.once('closed', dispose)
  return dispose
}

module.exports = { installRendererRecovery }
