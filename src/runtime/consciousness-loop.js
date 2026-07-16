const MAX_TIMER_DELAY_MS = 2_147_000_000

export function createConsciousnessLoop({
  runTurn,
  runTurnWatchdogMs,
  getCurrentExecution,
  getCurrentAbortController,
  clearCurrentExecution,
  emitEvent,
  enqueueDueReminders,
  hasMessages,
  popMessage,
  hasUserMessages,
  getQueueSnapshot,
  formatTick,
  consumeTickerTick,
  decrementAwakeningTick,
  isStartupSelfCheckActive,
  isHeartbeatEnabled,
  isRunning,
  setScheduler,
  setInterruptCallback,
  isRateLimited,
  getTickInterval,
  getBaseTickInterval,
  getCustomIntervalMs,
  getTickerStatus,
  getAwakeningTicks,
  isTaskActive,
  getNextPendingReminder,
  getQuotaStatus,
  startConsolidationLoop,
  ensureStartupSelfCheckState,
  setStickyEvent,
  startupSelfCheckVersion,
  priorities,
}) {
  let processing = false
  let lastTickAborted = false
  let currentTimer = null  // timer for the next pending tick; can be cleared by pushMessage to run immediately
  let loopStarted = false

  function markLastTickAborted() {
    lastTickAborted = true
  }

  function shouldPreemptFor(entry) {
    const currentExecution = getCurrentExecution()
    if (!entry || !processing || !currentExecution) return true
    const incomingPriority = entry.priority || priorities.background
    if (incomingPriority > currentExecution.priority) return true

    // Allow preemption between concurrent user messages.
    // If the current execution is stuck in a tool call, a new user message can still interrupt immediately.
    if (incomingPriority >= priorities.user && currentExecution.priority >= priorities.user) return true

    return false
  }

  // 把 runTurn 用 watchdog 包一层：超时 → 强 abort + reject，让 onTick 的 finally 能跑、
  // processing 清掉。runTurn 内部那个永远不 resolve 的 promise 留在后台，最终被 GC。
  async function runTurnWithWatchdog(input, label, msg) {
    let timer = null
    const watchdog = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const currentExecution = getCurrentExecution()
        const stuckLabel = currentExecution?.label || label
        const elapsedS = currentExecution ? Math.round((Date.now() - currentExecution.startedAt) / 1000) : null
        console.error(`[watchdog] runTurn 卡死 ${runTurnWatchdogMs / 1000}s 未返回 (label=${stuckLabel}, elapsed=${elapsedS}s)，强制 abort`)
        try { getCurrentAbortController()?.abort?.('watchdog timeout') } catch {}
        // 立即清掉全局 execution 引用，避免后续 message 进来还 abort 同一个 controller
        clearCurrentExecution()
        try { emitEvent('error', { label: 'watchdog', error: `runTurn stuck > ${runTurnWatchdogMs / 1000}s` }) } catch {}
        const err = new Error('runTurn watchdog timeout')
        err.name = 'WatchdogTimeoutError'
        reject(err)
      }, runTurnWatchdogMs)
    })
    try {
      await Promise.race([runTurn(input, label, msg), watchdog])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function onTick() {
    if (processing) return
    processing = true
    lastTickAborted = false
    let autoTick = false
    let tickerRevisionAtStart = null

    try {
      enqueueDueReminders()
      if (hasMessages()) {
        const msg = popMessage()
        const lane = msg.runtimeLane === 'l3'
          ? 'L3'
          : (msg.queueName === 'background' ? 'BG' : 'L1')
        await runTurnWithWatchdog(msg.raw, `${lane} message from ${msg.fromId}`, msg)
      } else {
        // 防御性边界：即使某个旧 timer、测试入口或外部调用直接触发 onTick，
        // 关闭心跳后也不能漏跑一轮自主 L2。首次启动自检是唯一例外。
        if (!isHeartbeatEnabled() && !isStartupSelfCheckActive()) return
        autoTick = true
        tickerRevisionAtStart = getTickerStatus()?.revision ?? null
        const tick = formatTick()
        await runTurnWithWatchdog(tick, 'L2 TICK', null)
      }
    } catch (err) {
      // runTurn 抛错（含 watchdog 超时和 runTurn 内部 LLM 之后未捕获的异常）必须吞掉，
      // 否则会冒泡到 setTimeout 回调外层，绕过 scheduleNextTick → 主循环停摆。
      if (err?.name === 'WatchdogTimeoutError') {
        lastTickAborted = true
      } else {
        // A failed autonomous turn did not consume a meaningful heartbeat.
        // Preserve cadence/awakening state so the next Tick can retry or make
        // a different judgment with the error visible in logs.
        if (autoTick) lastTickAborted = true
        console.error('[onTick] runTurn 抛出未处理异常:', err?.stack || err?.message || err)
      }
    } finally {
      processing = false
      // Cadence TTL and awakening state describe autonomous heartbeats, not
      // user/background messages that happen to share this scheduler entry.
      // A cadence created during this Tick starts governing the *next* Tick;
      // do not immediately spend one of its requested TTL rounds.
      const tickerWasReconfigured = autoTick
        && tickerRevisionAtStart !== null
        && getTickerStatus()?.revision !== tickerRevisionAtStart
      if (autoTick && !lastTickAborted && !tickerWasReconfigured) consumeTickerTick()
      // When interrupted by the user, retry the same awakening moment on the
      // next heartbeat. There is no runtime-driven exploration index anymore;
      // deciding what the awakening moment means belongs to the model.
      if (autoTick && !lastTickAborted) {
        decrementAwakeningTick()
      }
    }
  }

  // Schedule priority (high to low):
  //   1. Messages pending → 0
  //   2. 429 rate-limited → quota's 10-minute interval
  //   3. L2 custom cadence (ttl > 0) → L2-specified value
  //   4. Task active → 30s
  //   5. Idle → config.tickInterval
  function scheduleNextTick() {
    if (!isRunning()) return
    if (currentTimer) { clearTimeout(currentTimer); currentTimer = null }

    enqueueDueReminders()

    const hasPending = hasMessages()
    const hasPendingUser = hasUserMessages()
    const queueSnapshot = getQueueSnapshot()
    const rateLimited = isRateLimited()
    const customMs = getCustomIntervalMs()
    const taskActive = isTaskActive()
    const nextReminder = getNextPendingReminder()
    const baseTickInterval = getBaseTickInterval()
    const heartbeatEnabled = isHeartbeatEnabled()

    let interval = null
    let label
    if (hasPendingUser) {
      interval = 0
      label = 'immediate (user message pending)'
    } else if (hasPending) {
      interval = 0
      label = 'immediate (background message pending)'
    } else if (!heartbeatEnabled) {
      label = 'heartbeat disabled'
    } else if (rateLimited) {
      interval = getTickInterval(baseTickInterval)
      label = `rate-limited (${interval / 1000}s)`
    } else if (customMs !== null) {
      const ticker = getTickerStatus()
      interval = customMs
      label = `L2 custom ${interval / 1000}s (${ticker.ttl} tick(s) remaining${ticker.reason ? ' · ' + ticker.reason : ''})`
    } else if (getAwakeningTicks() > 0) {
      const awTicks = getAwakeningTicks()
      interval = 10000
      label = `awakening 10s (${awTicks} tick(s) remaining)`
    } else if (taskActive) {
      interval = 30000
      label = 'task mode 30s'
    } else {
      interval = baseTickInterval
      label = `${interval / 1000}s`
    }

    if (nextReminder) {
      const dueInMs = Math.max(0, new Date(nextReminder.due_at).getTime() - Date.now())
      if (interval === null || dueInMs < interval) {
        // Node 的 setTimeout 超过约 24.8 天会溢出并几乎立即触发。心跳关闭时，
        // 下一个提醒可能是唯一计时源，因此分段睡眠并在醒来后重新计算。
        interval = Math.min(dueInMs, MAX_TIMER_DELAY_MS)
        label = dueInMs > MAX_TIMER_DELAY_MS
          ? `heartbeat disabled; reminder rescan in ${Math.ceil(interval / 1000)}s`
          : `reminder fires in ${Math.ceil(dueInMs / 1000)}s`
      }
    }

    const quota = getQuotaStatus()
    console.log(`[quota] ${quota.rpmUsed} RPM | ${quota.tpmUsed} TPM | ratio ${quota.ratio} | queue U:${queueSnapshot.user} B:${queueSnapshot.background} | next tick ${label}`)
    emitEvent('quota', { ...quota, nextTickMs: interval, heartbeatEnabled, ticker: getTickerStatus(), queue: queueSnapshot })
    if (interval === null) return
    currentTimer = setTimeout(async () => {
      currentTimer = null
      // try/finally 兜底：即使 onTick 抛错（理论上 onTick 自己已 catch，watchdog 也吞了
      // 异常），也保证 scheduleNextTick 总被调用，主循环不会因为单轮异常永久停摆。
      try {
        await onTick()
      } catch (err) {
        console.error('[scheduleNextTick] onTick threw:', err?.stack || err?.message || err)
      } finally {
        scheduleNextTick()
      }
    }, interval)
  }

  // Called when a new message arrives: clear the pending timer and run the next tick immediately.
  // If currently processing, rely on the abort mechanism to finish quickly; scheduleNextTick will use interval=0 to resume.
  function triggerImmediateTick() {
    if (processing) return  // rely on abort + the post-finish scheduleNextTick to continue
    if (!isRunning()) return
    if (currentTimer) { clearTimeout(currentTimer); currentTimer = null }
    // 异步启动一轮，不等结果
    ;(async () => {
      try {
        await onTick()
      } catch (err) {
        console.error('[triggerImmediateTick] onTick threw:', err?.stack || err?.message || err)
      } finally {
        scheduleNextTick()
      }
    })()
  }

  async function startConsciousnessLoop({ runImmediateTick = true } = {}) {
    if (loopStarted) return
    loopStarted = true

    startConsolidationLoop()

    // Register the scheduler so the control layer (stop/start) can wake it up
    setScheduler(scheduleNextTick)

    // Register interrupt callback: when a new message arrives, interrupt the current LLM call and trigger the next tick immediately (don't wait for the timer)
    setInterruptCallback((entry) => {
      const currentAbortController = getCurrentAbortController()
      if (currentAbortController && shouldPreemptFor(entry)) {
        console.log(`[system] Higher-priority message arrived — interrupting current processing: ${entry.fromId} (${entry.queueName})`)
        emitEvent('processing_preempted', {
          by: entry.fromId,
          queueName: entry.queueName,
          priority: entry.priority,
          current: getCurrentExecution(),
        })
        currentAbortController.abort('higher-priority-message')
      }
      triggerImmediateTick()
    })

    // Initialize self-check state before the first tick so the first tick can run self-check
    ensureStartupSelfCheckState()
    if (isStartupSelfCheckActive()) {
      console.log('[system] Startup self-check starting')
      const selfCheckPayload = { version: startupSelfCheckVersion }
      setStickyEvent('startup_self_check_started', selfCheckPayload)
      emitEvent('startup_self_check_started', selfCheckPayload)
    }

    // Whether to fire an immediate L2 TICK is up to the caller; initial activation uses it to trigger self-check.
    if (runImmediateTick && (isHeartbeatEnabled() || isStartupSelfCheckActive() || hasMessages())) {
      await onTick()
    }
    scheduleNextTick()
  }

  return {
    isProcessing: () => processing,
    markLastTickAborted,
    onTick,
    scheduleNextTick,
    triggerImmediateTick,
    start: startConsciousnessLoop,
  }
}
