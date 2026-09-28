// Activation UI is a client of this gate; Runtime itself knows only completion.
export function createActivationLifecycle({
  start,
  fallbackMs = 60_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logger = console,
}) {
  let pending = false
  let timer = null

  function release(reason = 'completed') {
    if (!pending) return
    pending = false
    if (timer !== null) clearTimer(timer)
    timer = null
    logger.log(`[system] Activation intro ${reason}; starting consciousness loop and startup self-check`)
    // Catch both synchronous port failures and asynchronous loop failures.
    Promise.resolve().then(() => start({ runImmediateTick: true }))
      .catch(err => logger.error('[system] Main loop failed to start:', err))
  }

  return {
    defer() {
      pending = true
      if (timer !== null) clearTimer(timer)
      timer = setTimer(() => release('fallback timeout'), fallbackMs)
      timer.unref?.()
    },
    release,
  }
}
