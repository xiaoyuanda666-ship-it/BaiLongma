// A probe deadline cancels the underlying HTTP request as well as the wait.
// Racing the abort also bounds clients that do not promptly reject on cancel.
export async function withProbeTimeout(request, timeoutMs, label, signal) {
  if (signal?.aborted) throw signal.reason || new Error('Model probe cancelled')
  const controller = new AbortController()
  const onParentAbort = () => controller.abort(signal.reason || new Error('Model probe cancelled'))
  signal?.addEventListener('abort', onParentAbort, { once: true })
  let onAbort
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(controller.signal.reason)
    controller.signal.addEventListener('abort', onAbort, { once: true })
  })
  const timer = setTimeout(() => {
    controller.abort(new Error(`${label} timeout after ${timeoutMs}ms`))
  }, timeoutMs)
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted()
        return request(controller.signal)
      }),
      cancelled,
    ])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onParentAbort)
    controller.signal.removeEventListener('abort', onAbort)
  }
}
