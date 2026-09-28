import { createAbortError, throwIfAborted } from '../capabilities/abort-utils.js'

// Bound the caller even when a bridge or MCP implementation ignores cancellation.
// The abandoned promise remains observed, including any late rejection.
export async function browserStep(context, stage, operation) {
  const signal = context.signal
  throwIfAborted(signal)
  if (context.browserOperation) context.browserOperation.stage = stage
  let onAbort
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        throwIfAborted(signal)
        return operation()
      }),
      new Promise((_, reject) => {
        onAbort = () => reject(createAbortError(signal.reason || 'Aborted'))
        signal?.addEventListener('abort', onAbort, { once: true })
        if (signal?.aborted) onAbort()
      }),
    ])
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}
