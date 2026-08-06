// Bound optional startup work without leaving a losing timeout alive. A raw
// Promise.race keeps its timer scheduled after the real task settles, which
// later prints a false timeout warning and needlessly keeps Node's event loop
// referenced.
export function withStartupTimeout(promise, ms, label, { warn = console.warn } = {}) {
  return new Promise(resolve => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      warn(`${label} 超时 ${ms}ms,跳过(不阻塞启动)`)
      finish(null)
    }, ms)

    Promise.resolve(promise).then(
      value => finish(value),
      err => {
        warn(`${label} 失败(忽略):`, err?.message || err)
        finish(null)
      },
    )
  })
}
