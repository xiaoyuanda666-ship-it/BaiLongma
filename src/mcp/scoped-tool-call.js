import { createMergedAbortSignal } from '../capabilities/abort-utils.js'
import { browserStep } from './browser-operation.js'

export async function callToolWithScopedSignal(client, request, { timeout, signal, browserOperation } = {}) {
  // The MCP SDK may retain an abort listener until its complete timeout path
  // settles. Never hand a turn-long shared signal directly to dozens of tool
  // calls; give each call a scoped child and detach it immediately afterward.
  const scoped = createMergedAbortSignal(signal, timeout)
  try {
    return await browserStep({ signal: scoped?.signal, browserOperation }, request.name, () => client.callTool(
      request,
      undefined,
      { timeout, ...(scoped?.signal ? { signal: scoped.signal } : {}) },
    ))
  } finally {
    scoped?.cleanup()
  }
}
