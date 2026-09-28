import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { register } from 'node:module'

// Enforce the absence of App dependencies in a fresh loader/module graph, not
// merely by avoiding startAPI calls after the UI has already been imported.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-headless-'))
process.env.BAILONGMA_USER_DIR = directory
process.env.BAILONGMA_RESOURCES_DIR = process.cwd()
const loader = `
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context)
  if (specifier === 'electron' || /\\/src\\/(?:app|api|ui)\\//.test(result.url)
    || /\\/src\\/(?:api|tui|events)\\.js$/.test(result.url)) {
    throw new Error('Headless Runtime attempted to load UI: ' + result.url)
  }
  return result
}`
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url)
let close
try {
  const db = await import('./db.js')
  close = db.closeDBForTest
  db.setConfig('current_task', 'restored without UI')
  const { createAgentRuntime, buildToolContext } = await import('./runtime/agent-host.js')
  const runtime = await createAgentRuntime({ prepareRuntime: async () => ({ startupSkills: [], geoResult: null }) })
  assert.equal(runtime.getStateSnapshot().task, 'restored without UI')
  assert.deepEqual(buildToolContext({ currentTargetId: 'headless-user' }).allowedTargetIds, ['headless-user'])
  const { emitEvent } = await import('./runtime/events.js')
  emitEvent('message_received', { input: 'headless event' })
  emitEvent('response', {})
  const history = db.getBrainUiEventHistory({ path: 'l1', limit: 10 })
  assert.equal(history.events.at(-2).data.input, 'headless event')
  console.log('PASS Runtime initializes and persists events with App imports forbidden')
} finally {
  close?.()
  fs.rmSync(directory, { recursive: true, force: true })
}
