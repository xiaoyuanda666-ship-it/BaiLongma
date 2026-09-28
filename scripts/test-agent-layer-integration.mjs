import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { projectRoot } from './check-agent-layers.mjs'

// Use the project's Electron ABI for better-sqlite3 and isolate every case from
// user data and from other tests. No rebuild or native binary mutation required.
const require = createRequire(import.meta.url)
const electron = require('electron')
const tests = [
  'src/test-runtime-host.js',
  'src/test-runtime-headless.js',
  'src/test-event-service-integration.js',
  'src/test-brain-ui-events.js',
  'src/test-db-schema-module.js',
  'src/test-inbound-message.js',
  'src/test-runtime-delivery.js',
  'src/test-filesystem-edit.js',
  'src/test-read-file-range.js',
  'src/test-write-file-preview.js',
  'src/test-consciousness-loop.js',
  'src/test-runtime-messages.js',
  'src/test-llm-responses.js',
  'src/test-llm-responses-loop.js',
  'src/test-activation-intro-gate.js',
  'src/test-startup-hardening.js',
  'src/test-index-refactor-modules.js',
  'src/test-background-job-manager.js',
  'src/test-browser-download-events.js',
  'scripts/test-start.mjs',
]
let failures = 0
for (const filename of tests) {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-layer-regression-'))
  try {
    const result = spawnSync(electron, [filename], {
      cwd: projectRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', BAILONGMA_USER_DIR: userDir, BAILONGMA_RESOURCES_DIR: projectRoot },
      encoding: 'utf8', timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
    })
    if (result.error || result.status !== 0) {
      failures++
      console.error(`FAIL ${filename}: ${result.error?.message || `exit ${result.status}, signal ${result.signal || 'none'}`}`)
      console.error(result.stdout, result.stderr)
    } else console.log(`PASS ${filename}`)
  } finally { fs.rmSync(userDir, { recursive: true, force: true }) }
}
console.log(`Agent layer integration: ${tests.length - failures}/${tests.length} scripts passed`)
if (failures) process.exitCode = 1
