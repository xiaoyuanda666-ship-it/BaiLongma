// Stable executable entry for Electron and scripts/start.mjs.
// The composition root is the only layer that wires Runtime to App transports.
import { createAgentRuntime } from './runtime/agent-host.js'
import { startApplication } from './app/interfaces.js'

export { buildToolContext } from './runtime/agent-host.js'

function reportStartupProgress(id, status, detail, message) {
  try {
    const reporter = globalThis.bailongmaStartupProgress
    if (typeof reporter === 'function') reporter({ id, status, detail, message })
  } catch {}
}

const runtime = await createAgentRuntime({ reportStartupProgress })
await startApplication({ runtime, reportStartupProgress })
