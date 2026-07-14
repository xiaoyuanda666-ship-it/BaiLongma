#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractFile, listPackage } from '@electron/asar'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const unpacked = path.join(root, 'dist', 'win-unpacked')
const exe = path.join(unpacked, 'Bailongma.exe')
const resources = path.join(unpacked, 'resources')
const appAsar = path.join(resources, 'app.asar')
const browsersDir = path.join(resources, 'playwright-browsers')
const timeoutMs = Number(process.env.PACKAGED_PLAYWRIGHT_SMOKE_TIMEOUT_MS || 120_000)

function dirSize(target) {
  let total = 0
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name)
    if (entry.isDirectory()) total += dirSize(child)
    else if (entry.isFile()) total += fs.statSync(child).size
  }
  return total
}

function requireFile(target, label) {
  assert.ok(fs.existsSync(target), `${label} is missing: ${target}`)
  assert.ok(fs.statSync(target).isFile(), `${label} is not a file: ${target}`)
}

requireFile(exe, 'packaged executable')
requireFile(appAsar, 'app.asar')
assert.ok(fs.statSync(appAsar).size > 0, 'app.asar is empty')
assert.ok(fs.existsSync(browsersDir), `packaged browser resource is missing: ${browsersDir}`)

const entries = new Set(listPackage(appAsar).map(entry => entry.replaceAll('\\', '/')))
for (const entry of [
  '/node_modules/playwright/package.json',
  '/node_modules/playwright/index.js',
  '/node_modules/playwright-core/package.json',
  '/node_modules/playwright-core/lib/server/browserType.js',
  '/node_modules/playwright-core/lib/server/registry/index.js',
  '/src/capabilities/tools/browser/manager.js',
  '/src/capabilities/tools/browser/runtime.js',
  '/electron/playwright-runtime.cjs',
]) {
  assert.ok(entries.has(entry), `required production entry is absent from app.asar: ${entry}`)
}

const browsersJson = JSON.parse(extractFile(appAsar, path.join('node_modules', 'playwright-core', 'browsers.json')).toString('utf8'))
const chromium = browsersJson.browsers.find(browser => browser.name === 'chromium')
assert.ok(chromium?.revision, 'playwright-core browsers.json has no Chromium revision')
const chromiumRoot = path.join(browsersDir, `chromium-${chromium.revision}`)
const chromiumExe = path.join(chromiumRoot, 'chrome-win64', 'chrome.exe')
requireFile(chromiumExe, `packaged Chromium revision ${chromium.revision}`)

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-packaged-playwright-'))
const userDir = path.join(tempRoot, 'user')
const probeFile = path.join(tempRoot, 'probe.mjs')
fs.mkdirSync(userDir, { recursive: true })

const probeSource = String.raw`
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const appAsar = process.env.BAILONGMA_SMOKE_APP_ASAR
const resources = process.env.BAILONGMA_PACKAGED_RESOURCES
const userDir = process.env.BAILONGMA_USER_DIR
const expectedChromium = path.resolve(process.env.BAILONGMA_EXPECTED_CHROMIUM)
assert.ok(appAsar.includes('app.asar'), 'probe must import production code from app.asar')
assert.equal(path.resolve(process.env.PLAYWRIGHT_BROWSERS_PATH), path.join(resources, 'playwright-browsers'))
assert.ok(!process.env.NODE_PATH, 'NODE_PATH must be empty so repository dependencies cannot be borrowed')

const requireFromAsar = createRequire(path.join(appAsar, 'package.json'))
const playwrightEntry = requireFromAsar.resolve('playwright')
const playwrightCoreEntry = requireFromAsar.resolve('playwright-core')
assert.ok(playwrightEntry.includes('app.asar'), 'playwright resolved outside app.asar: ' + playwrightEntry)
assert.ok(playwrightCoreEntry.includes('app.asar'), 'playwright-core resolved outside app.asar: ' + playwrightCoreEntry)

const packagedRuntime = requireFromAsar('./electron/playwright-runtime.cjs')
packagedRuntime.configurePackagedPlaywright({
  isPackaged: true,
  resourcesPath: resources,
  platform: 'win32',
  arch: 'x64',
})
assert.equal(process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE, 'win64')
assert.equal(process.env.BAILONGMA_BUNDLED_PLAYWRIGHT, '1')

const managerUrl = pathToFileURL(path.join(appAsar, 'src', 'capabilities', 'tools', 'browser', 'index.js')).href
const runtimeUrl = pathToFileURL(path.join(appAsar, 'src', 'capabilities', 'tools', 'browser', 'runtime.js')).href
const [{ BrowserSessionManager }, { loadChromium }] = await Promise.all([import(managerUrl), import(runtimeUrl)])
const playwrightChromium = await loadChromium()
assert.ok(playwrightChromium, 'production Playwright module did not expose chromium')

const manager = new BrowserSessionManager({
  sandboxRoot: path.join(userDir, 'sandbox'),
  userDataRoot: userDir,
  operationTimeoutMs: 30_000,
})
let opened
let agentOpened
const inspectDiagnostics = inspect => ({
  url: inspect?.url,
  title: inspect?.title,
  textLength: inspect?.text_length,
  textSample: inspect?.text?.slice(0, 500),
  elementNames: inspect?.elements?.slice(0, 30).map(element => element.name),
})
const waitForInspect = async (sessionId, predicate, label, timeout = 25_000) => {
  const deadline = Date.now() + timeout
  let lastInspect
  let lastError
  while (Date.now() < deadline) {
    try {
      lastInspect = await manager.inspect({
        session_id: sessionId,
        max_chars: 20_000,
        max_elements: 200,
      })
      if (predicate(lastInspect)) return lastInspect
      lastError = null
    } catch (error) {
      lastError = error
    }
    await manager.act({ session_id: sessionId, action: 'wait', ms: 750 })
  }
  throw new Error([
    label + ' did not become inspectable within ' + timeout + 'ms',
    lastError && 'last inspect error: ' + (lastError.stack || lastError.message || String(lastError)),
    'last inspect: ' + JSON.stringify(inspectDiagnostics(lastInspect)),
  ].filter(Boolean).join('\n'))
}
try {
  opened = await manager.open({ url: 'about:blank', visible: false, timeout_ms: 20_000 })
  assert.equal(opened.ok, true)
  assert.equal(opened.url, 'about:blank')

  const inspect = await manager.inspect({ session_id: opened.session_id, screenshot: true })
  assert.equal(inspect.ok, true)
  assert.ok(inspect.screenshot_path?.startsWith('screenshots/'))
  assert.equal(path.isAbsolute(inspect.screenshot_path), false)
  const screenshot = path.resolve(userDir, 'sandbox', ...inspect.screenshot_path.split('/'))
  assert.ok(screenshot.startsWith(path.resolve(userDir, 'sandbox') + path.sep))
  assert.ok(fs.statSync(screenshot).size > 0, 'packaged screenshot is empty')

  const ps = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Select-Object -ExpandProperty ExecutablePath",
  ], { encoding: 'utf8', timeout: 15_000 })
  const browserPaths = ps.split(/\r?\n/).map(value => value.trim()).filter(Boolean).map(value => path.resolve(value))
  assert.ok(browserPaths.some(value => value.toLowerCase() === expectedChromium.toLowerCase()),
    'running Chromium is not the packaged executable; observed: ' + JSON.stringify(browserPaths))

  const closed = await manager.close({ session_id: opened.session_id })
  assert.equal(closed.closed, true)
  opened = null

  try {
    agentOpened = await manager.open({ url: 'https://agent.qq.com', visible: false, timeout_ms: 30_000 })
  } catch (error) {
    throw new Error('agent.qq.com could not be opened through the packaged production BrowserSessionManager: ' +
      (error.stack || error.message || String(error)))
  }
  assert.equal(agentOpened.ok, true)
  assert.match(agentOpened.url, /^https:\/\/agent\.qq\.com\/?(?:[?#].*)?$/)

  const targetText = '\u4e00\u952e\u63a5\u5165'
  const before = await waitForInspect(
    agentOpened.session_id,
    inspect => inspect.elements.some(element => element.name?.includes(targetText) && element.ref),
    'agent.qq.com one-click integration target',
  )
  const target = before.elements.find(element => element.name?.includes(targetText) && element.ref)
  assert.ok(target?.ref, 'agent.qq.com inspect did not return a ref for the one-click integration target')

  let clickResult
  try {
    // This must remain a ref-only production action. Do not add selectors,
    // coordinates, evaluation, uploads, or another click escape hatch here.
    clickResult = await manager.act({
      session_id: agentOpened.session_id,
      action: 'click',
      ref: target.ref,
      timeout_ms: 20_000,
    })
  } catch (error) {
    throw new Error([
      'packaged BrowserSessionManager failed to click the inspected one-click integration ref',
      'target: ' + JSON.stringify(target),
      'before: ' + JSON.stringify(inspectDiagnostics(before)),
      error.stack || error.message || String(error),
    ].join('\n'))
  }
  assert.equal(clickResult.ok, true)
  assert.equal(clickResult.action, 'click')

  const setupDocument = 'https://agent.qq.com/doc/cli-setup.md'
  const copyPromptText = '\u590d\u5236\u63d0\u793a\u8bcd'
  const expanded = await waitForInspect(
    agentOpened.session_id,
    inspect => (
      inspect.text_length > before.text_length &&
      inspect.text.includes(setupDocument) &&
      inspect.text.includes(copyPromptText)
    ),
    'agent.qq.com one-click integration expanded content',
  )
  const copyPrompt = expanded.elements.find(element => element.name?.includes(copyPromptText) && element.ref)
  const agentSmoke = {
    url: expanded.url,
    title: expanded.title,
    target: { ref: target.ref, role: target.role, tag: target.tag, name: target.name },
    before: inspectDiagnostics(before),
    expanded: inspectDiagnostics(expanded),
    setupDocumentPresent: expanded.text.includes(setupDocument),
    copyPromptPresent: expanded.text.includes(copyPromptText),
    copyPromptRef: copyPrompt?.ref || null,
    elementCountBefore: before.elements.length,
    elementCountExpanded: expanded.elements.length,
  }

  const agentClosed = await manager.close({ session_id: agentOpened.session_id })
  assert.equal(agentClosed.closed, true)
  agentOpened = null
  await manager.shutdown()
  console.log(JSON.stringify({
    ok: true,
    playwrightEntry,
    playwrightCoreEntry,
    chromiumExecutable: expectedChromium,
    screenshot,
    screenshotBytes: fs.statSync(screenshot).size,
    agentSmoke,
  }))
} finally {
  if (opened?.session_id) await manager.close({ session_id: opened.session_id }).catch(() => {})
  if (agentOpened?.session_id) await manager.close({ session_id: agentOpened.session_id }).catch(() => {})
  await manager.shutdown().catch(() => {})
}
`
fs.writeFileSync(probeFile, probeSource)

function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } else {
    try { process.kill(-pid, 'SIGKILL') } catch {}
    try { process.kill(pid, 'SIGKILL') } catch {}
  }
}

async function runProbe() {
  const child = spawn(exe, [probeFile], {
    cwd: tempRoot,
    detached: process.platform !== 'win32',
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_PATH: '',
      PLAYWRIGHT_BROWSERS_PATH: browsersDir,
      PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: 'win64',
      BAILONGMA_USER_DIR: userDir,
      BAILONGMA_RESOURCES_DIR: appAsar,
      BAILONGMA_PACKAGED_RESOURCES: resources,
      BAILONGMA_SMOKE_APP_ASAR: appAsar,
      BAILONGMA_EXPECTED_CHROMIUM: chromiumExe,
      // A bogus cache makes accidental reliance on a user's ms-playwright
      // cache fail loudly even if Playwright's explicit path handling regresses.
      LOCALAPPDATA: path.join(tempRoot, 'empty-local-app-data'),
      HOME: path.join(tempRoot, 'empty-home'),
      USERPROFILE: path.join(tempRoot, 'empty-profile'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    killTree(child.pid)
  }, timeoutMs)
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  }).finally(() => clearTimeout(timer))
  if (timedOut || result.code !== 0) {
    killTree(child.pid)
    throw new Error([
      timedOut ? `packaged Playwright probe timed out after ${timeoutMs}ms` : `packaged Playwright probe exited ${result.code} (${result.signal || 'no signal'})`,
      stdout && `stdout:\n${stdout.trim()}`,
      stderr && `stderr:\n${stderr.trim()}`,
    ].filter(Boolean).join('\n'))
  }
  const payloadLine = stdout.trim().split(/\r?\n/).findLast(line => line.trim().startsWith('{'))
  assert.ok(payloadLine, `packaged probe emitted no JSON result:\n${stdout}`)
  return JSON.parse(payloadLine)
}

function packagedChromiumPids() {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    "$expected=[IO.Path]::GetFullPath($env:BAILONGMA_EXPECTED_CHROMIUM); Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -ieq $expected } | Select-Object -ExpandProperty ProcessId",
  ], {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
    env: { ...process.env, BAILONGMA_EXPECTED_CHROMIUM: chromiumExe },
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`failed to inspect packaged Chromium processes: ${result.stderr || `exit ${result.status}`}`)
  }
  return result.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean).map(Number).filter(Number.isInteger)
}

async function assertPackagedChromiumExited(timeout = 5_000) {
  const deadline = Date.now() + timeout
  let pids = packagedChromiumPids()
  while (pids.length && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 250))
    pids = packagedChromiumPids()
  }
  if (!pids.length) return
  for (const pid of pids) {
    spawnSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  }
  throw new Error(`packaged Chromium processes remained after probe exit and were killed: ${pids.join(', ')}`)
}

try {
  let probe
  try {
    probe = await runProbe()
  } finally {
    // Check from the parent after Bailongma.exe has exited. A detached browser
    // could outlive an apparently successful in-child manager shutdown.
    await assertPackagedChromiumExited()
  }
  const installers = fs.readdirSync(path.join(root, 'dist'))
    .filter(name => /^Bailongma-Setup-.*\.exe$/i.test(name))
    .map(name => ({ name, bytes: fs.statSync(path.join(root, 'dist', name)).size }))
  assert.ok(installers.length > 0, 'Windows installer is missing from dist')
  console.log(JSON.stringify({
    ok: true,
    appAsarBytes: fs.statSync(appAsar).size,
    packagedBrowserBytes: dirSize(browsersDir),
    chromiumRevision: chromium.revision,
    chromiumExecutable: chromiumExe,
    installers,
    probe,
  }, null, 2))
} finally {
  // The probe's isolated data is deliberately retained only for the duration
  // of this verification and must never leak into the repository or user data.
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
