import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

// Use the same native SQLite ABI as the desktop app, without rebuilding it.
const root = fileURLToPath(new URL('../', import.meta.url))
const electron = createRequire(import.meta.url)('electron')
const tests = [
  'src/test-llm-responses.js',
  'src/test-llm-responses-loop.js',
  'src/test-llm-chat-completions.js',
  'src/test-llm-protocol-loop.js',
  'src/test-model-transport.js',
  'src/test-llm-settings-flow.js',
  'src/test-config-upgrade.js',
  'src/test-api-format-ui.js',
  'src/test-runtime-messages.js',
  'src/test-tool-discovery-retry.js',
  'src/test-write-file-preview.js',
  'src/test-i18n.js',
  'scripts/check-agent-layers.mjs',
]
let failures = 0
for (const filename of tests) {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-protocol-regression-'))
  try {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', BAILONGMA_USER_DIR: userDir, BAILONGMA_RESOURCES_DIR: root }
    for (const key of ['DEEPSEEK_API_KEY', 'MINIMAX_API_KEY', 'OPENAI_API_KEY', 'DASHSCOPE_API_KEY',
      'MOONSHOT_API_KEY', 'ZHIPU_API_KEY', 'MIMO_API_KEY']) delete env[key]
    const result = spawnSync(electron, [filename], {
      cwd: root, env, encoding: 'utf8', timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
    })
    if (result.error || result.status !== 0) {
      failures++
      console.error(`FAIL ${filename}: ${result.error?.message || `exit ${result.status}`}`)
      console.error(result.stdout, result.stderr)
    } else console.log(`PASS ${filename}`)
  } finally {
    fs.rmSync(userDir, { recursive: true, force: true })
  }
}
console.log(`LLM protocol regression: ${tests.length - failures}/${tests.length} scripts passed`)
if (failures) process.exitCode = 1
