// 意识循环开关——让 API 层可以暂停/恢复循环，而不终止整个进程
let _running = true
let _scheduleNext = null

export function isRunning() { return _running }

// index.js 注册调度函数，供 startLoop 唤起
export function setScheduler(fn) { _scheduleNext = fn }

// 配置变化后重新计算下一次调度；不会中断当前正在执行的一轮。
export function refreshScheduler() {
  if (_scheduleNext) _scheduleNext()
}

export function stopLoop() {
  _running = false
  console.log('[控制] 意识循环已暂停')
}

export function startLoop() {
  if (_running) return
  _running = true
  console.log('[控制] 意识循环已恢复')
  if (_scheduleNext) _scheduleNext()
}
