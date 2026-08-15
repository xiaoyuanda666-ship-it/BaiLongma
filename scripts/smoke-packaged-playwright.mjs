#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractFile, listPackage } from '@electron/asar'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(root, 'dist')

function packagedTarget(platform = process.platform, arch = process.arch) {
  if (platform === 'win32' && arch === 'x64') {
    const unpacked = path.join(distDir, 'win-unpacked')
    return {
      platform,
      arch,
      hostPlatform: 'win64',
      exe: path.join(unpacked, 'Bailongma.exe'),
      resources: path.join(unpacked, 'resources'),
      chromiumExecutableParts: ['chrome-win64', 'chrome.exe'],
      artifactPattern: /^Bailongma-Setup-.*\.exe$/i,
    }
  }
  if (platform === 'darwin' && ['x64', 'arm64'].includes(arch)) {
    const unpacked = path.join(distDir, arch === 'arm64' ? 'mac-arm64' : 'mac')
    const appBundle = path.join(unpacked, 'Bailongma.app')
    return {
      platform,
      arch,
      hostPlatform: arch === 'arm64' ? 'mac15-arm64' : 'mac15',
      exe: path.join(appBundle, 'Contents', 'MacOS', 'Bailongma'),
      resources: path.join(appBundle, 'Contents', 'Resources'),
      chromiumExecutableParts: [
        `chrome-mac-${arch}`,
        'Google Chrome for Testing.app',
        'Contents',
        'MacOS',
        'Google Chrome for Testing',
      ],
      artifactPattern: new RegExp(`^Bailongma-.*-mac-${arch}\\.dmg$`, 'i'),
    }
  }
  if (platform === 'linux' && arch === 'x64') {
    const unpacked = path.join(distDir, 'linux-unpacked')
    return {
      platform,
      arch,
      hostPlatform: 'ubuntu24.04-x64',
      exe: path.join(unpacked, 'bailongma'),
      resources: path.join(unpacked, 'resources'),
      chromiumExecutableParts: ['chrome-linux64', 'chrome'],
      artifactPattern: /^Bailongma-.*-linux-x64\.AppImage$/i,
    }
  }
  throw new Error(`packaged Playwright MCP smoke is not configured for ${platform}-${arch}`)
}

const target = packagedTarget()
const exe = target.exe
const resources = target.resources
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

function asarJson(relativePath) {
  return JSON.parse(extractFile(appAsar, relativePath).toString('utf8'))
}

requireFile(exe, 'packaged executable')
requireFile(appAsar, 'app.asar')
assert.ok(fs.statSync(appAsar).size > 0, 'app.asar is empty')
assert.ok(fs.existsSync(browsersDir), `packaged browser resource is missing: ${browsersDir}`)

const entries = new Set(listPackage(appAsar).map(entry => entry.replaceAll('\\', '/')))
for (const entry of [
  '/node_modules/@playwright/mcp/package.json',
  '/node_modules/@playwright/mcp/cli.js',
  '/node_modules/playwright/package.json',
  '/node_modules/playwright/index.js',
  '/node_modules/playwright-core/package.json',
  '/node_modules/playwright-core/lib/coreBundle.js',
  '/node_modules/playwright-core/lib/utilsBundle.js',
  '/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js',
  '/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js',
  '/electron/browser-embed-host.cjs',
  '/electron/playwright-runtime.cjs',
  '/src/mcp/embedded-playwright-connection.js',
  '/src/mcp/embedded-playwright-sidecar.js',
  '/src/mcp/playwright-cli-entry.cjs',
  '/src/mcp/playwright-official-navigation.cjs',
  '/src/mcp/playwright-page-guard.cjs',
  '/src/mcp/playwright-shared-profile.json',
]) {
  assert.ok(entries.has(entry), `required production entry is absent from app.asar: ${entry}`)
}

const sharedProfileConfig = asarJson(path.join('src', 'mcp', 'playwright-shared-profile.json'))
assert.ok(
  sharedProfileConfig?.browser?.launchOptions?.args?.includes('--restore-last-session'),
  'packaged shared-profile config must restore session cookies and tabs across display-mode handoffs',
)

const mcpPackage = asarJson(path.join('node_modules', '@playwright', 'mcp', 'package.json'))
const playwrightPackage = asarJson(path.join('node_modules', 'playwright', 'package.json'))
const playwrightCorePackage = asarJson(path.join('node_modules', 'playwright-core', 'package.json'))
assert.equal(mcpPackage.version, '0.0.78')
assert.equal(playwrightPackage.version, mcpPackage.dependencies.playwright)
assert.equal(playwrightCorePackage.version, mcpPackage.dependencies['playwright-core'])
assert.equal(playwrightPackage.dependencies['playwright-core'], playwrightCorePackage.version)

const browsersJson = asarJson(path.join('node_modules', 'playwright-core', 'browsers.json'))
const chromium = browsersJson.browsers.find(browser => browser.name === 'chromium')
assert.ok(chromium?.revision, 'MCP playwright-core browsers.json has no Chromium revision')
const chromiumRoot = path.join(browsersDir, `chromium-${chromium.revision}`)
const chromiumExe = path.join(chromiumRoot, ...target.chromiumExecutableParts)
const packagedChromiumRevisions = fs.readdirSync(browsersDir, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && /^chromium-\d+$/.test(entry.name))
  .map(entry => entry.name)
  .sort()
assert.deepEqual(packagedChromiumRevisions, [`chromium-${chromium.revision}`],
  'package must contain exactly the MCP-pinned Chromium revision')
requireFile(chromiumExe, `packaged MCP Chromium revision ${chromium.revision}`)

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-packaged-playwright-mcp-'))
const userDir = path.join(tempRoot, 'user')
const probeFile = path.join(tempRoot, 'probe.mjs')
fs.mkdirSync(userDir, { recursive: true })

const probeSource = String.raw`
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const appAsar = process.env.BAILONGMA_SMOKE_APP_ASAR
const resources = process.env.BAILONGMA_PACKAGED_RESOURCES
const userDir = process.env.BAILONGMA_USER_DIR
const expectedChromium = path.resolve(process.env.BAILONGMA_EXPECTED_CHROMIUM)
const targetPlatform = process.env.BAILONGMA_SMOKE_PLATFORM
const targetArch = process.env.BAILONGMA_SMOKE_ARCH
const expectedHostPlatform = process.env.BAILONGMA_SMOKE_HOST_PLATFORM
assert.ok(appAsar.includes('app.asar'), 'probe must import production code from app.asar')
assert.equal(path.resolve(process.env.PLAYWRIGHT_BROWSERS_PATH), path.join(resources, 'playwright-browsers'))
assert.ok(!process.env.NODE_PATH, 'NODE_PATH must be empty so repository dependencies cannot be borrowed')

const requireFromAsar = createRequire(path.join(appAsar, 'package.json'))
const mcpPackagePath = requireFromAsar.resolve('@playwright/mcp/package.json')
const playwrightEntry = requireFromAsar.resolve('playwright')
const playwrightCoreEntry = requireFromAsar.resolve('playwright-core')
const sdkClientEntry = requireFromAsar.resolve('@modelcontextprotocol/sdk/client/index.js')
const sdkStdioEntry = requireFromAsar.resolve('@modelcontextprotocol/sdk/client/stdio.js')
const pageGuardEntry = requireFromAsar.resolve('./src/mcp/playwright-page-guard.cjs')
for (const [name, entry] of Object.entries({ mcpPackagePath, playwrightEntry, playwrightCoreEntry, sdkClientEntry, sdkStdioEntry, pageGuardEntry })) {
  assert.ok(entry.includes('app.asar'), name + ' resolved outside app.asar: ' + entry)
}
const mcpPackage = requireFromAsar('@playwright/mcp/package.json')
const mcpCli = requireFromAsar.resolve('./src/mcp/playwright-cli-entry.cjs')
assert.ok(fs.statSync(mcpCli).isFile(), 'packaged Playwright MCP CLI is missing: ' + mcpCli)

const packagedRuntime = requireFromAsar('./electron/playwright-runtime.cjs')
packagedRuntime.configurePackagedPlaywright({
  isPackaged: true,
  resourcesPath: resources,
  platform: targetPlatform,
  arch: targetArch,
})
assert.equal(process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE, expectedHostPlatform)
assert.equal(process.env.BAILONGMA_BUNDLED_PLAYWRIGHT, '1')

const [{ Client }, { StdioClientTransport }] = await Promise.all([
  import(pathToFileURL(sdkClientEntry).href),
  import(pathToFileURL(sdkStdioEntry).href),
])
const outputDir = path.join(userDir, 'mcp-output')
fs.mkdirSync(outputDir, { recursive: true })

const pageServer = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end("<!doctype html><title>Packaged MCP smoke</title><button onclick=\"document.querySelector('#status').textContent='MCP packaging works'\">Expand</button><p id=\"status\">Waiting</p>")
})
await new Promise((resolve, reject) => {
  pageServer.once('error', reject)
  pageServer.listen(0, '127.0.0.1', resolve)
})
const address = pageServer.address()
const pageUrl = 'http://127.0.0.1:' + address.port + '/'

const childEnv = Object.fromEntries(Object.entries({
  ...process.env,
  ELECTRON_RUN_AS_NODE: '1',
  PLAYWRIGHT_BROWSERS_PATH: path.join(resources, 'playwright-browsers'),
  PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: expectedHostPlatform,
  BAILONGMA_BROWSER_PRIVATE_NETWORK: '1',
}).filter(([, value]) => typeof value === 'string'))
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    mcpCli,
    '--browser', 'chromium',
    '--headless',
    '--isolated',
    '--block-service-workers',
    '--image-responses', 'omit',
    '--init-page', pageGuardEntry,
    '--snapshot-mode', 'full',
    '--output-dir', outputDir,
    '--output-mode', 'stdout',
  ],
  cwd: outputDir,
  env: childEnv,
  stderr: 'pipe',
})
let mcpStderr = ''
transport.stderr?.setEncoding?.('utf8')
transport.stderr?.on?.('data', chunk => { mcpStderr += chunk })
const client = new Client({ name: 'bailongma-packaged-smoke', version: '1.0.0' })
const textResult = result => (result.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n')
const call = (name, args = {}) => client.callTool(
  { name, arguments: args },
  undefined,
  { timeout: 30_000 },
)
const automaticSnapshot = result => {
  const responseText = textResult(result)
  const linked = responseText.match(/\[Snapshot\]\(([^)\r\n]+)\)/)?.[1]
  assert.ok(linked, 'Playwright action result did not include an automatic snapshot artifact link:\n' + responseText)
  const rawPath = decodeURI(linked)
  const candidates = path.isAbsolute(rawPath)
    ? [path.normalize(rawPath)]
    : [path.resolve(outputDir, rawPath), ...(path.sep === '/' && rawPath.includes('/') ? [path.normalize('/' + rawPath)] : [])]
  const realOutputDir = fs.realpathSync(outputDir)
  const snapshotPath = candidates.find(candidate => {
    try {
      const realCandidate = fs.realpathSync(candidate)
      const relative = path.relative(realOutputDir, realCandidate)
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    } catch { return false }
  })
  assert.ok(snapshotPath, 'automatic snapshot could not be resolved inside output directory: ' + rawPath)
  const relative = path.relative(outputDir, snapshotPath)
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative),
    'automatic snapshot escaped the configured output directory: ' + snapshotPath)
  assert.ok(/^page-[A-Za-z0-9_.:-]+\.ya?ml$/i.test(path.basename(snapshotPath)),
    'automatic snapshot filename is unexpected: ' + snapshotPath)
  return {
    path: snapshotPath,
    text: fs.readFileSync(snapshotPath, 'utf8'),
  }
}

let connected = false
try {
  await client.connect(transport)
  connected = true
  const listed = await client.listTools()
  const toolNames = new Set((listed.tools || []).map(tool => tool.name))
  for (const name of ['browser_navigate', 'browser_navigate_back', 'browser_navigate_forward', 'browser_reload', 'browser_snapshot', 'browser_click', 'browser_take_screenshot', 'browser_close']) {
    assert.ok(toolNames.has(name), 'packaged MCP omitted required tool: ' + name)
  }

  const navigated = await call('browser_navigate', { url: pageUrl })
  assert.notEqual(navigated.isError, true, textResult(navigated))
  assert.match(textResult(navigated), /Page Title: Packaged MCP smoke/)
  const initialSnapshot = automaticSnapshot(navigated)
  const initialText = initialSnapshot.text
  assert.match(initialText, /Expand/)
  const target = initialText.match(/button "Expand"[^\n]*\[ref=([^\]\s]+)\]/)?.[1]
  assert.ok(target, 'automatic navigation snapshot did not expose a target for the Expand button:\n' + initialText)

  let browserProcessDiagnostics
  if (targetPlatform === 'win32') {
    const ps = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Select-Object -ExpandProperty ExecutablePath",
    ], { encoding: 'utf8', timeout: 15_000 })
    const browserPaths = ps.split(/\r?\n/).map(value => value.trim()).filter(Boolean).map(value => path.resolve(value))
    assert.ok(browserPaths.some(value => value.toLowerCase() === expectedChromium.toLowerCase()),
      'running Chromium is not the packaged executable; observed: ' + JSON.stringify(browserPaths))
    browserProcessDiagnostics = browserPaths
  } else {
    const ps = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 15_000 })
    const browserProcesses = ps.split(/\r?\n/).map(value => value.trim()).filter(value => value.includes(expectedChromium))
    assert.ok(browserProcesses.length > 0,
      'running Chromium is not the packaged executable; expected command containing: ' + expectedChromium)
    browserProcessDiagnostics = browserProcesses
  }

  const clicked = await call('browser_click', { element: 'Expand button', target })
  assert.notEqual(clicked.isError, true, textResult(clicked))
  const changedSnapshot = automaticSnapshot(clicked)
  const snapshotText = changedSnapshot.text
  assert.match(snapshotText, /MCP packaging works/)

  const secondNavigation = await call('browser_navigate', { url: pageUrl + '?history=second' })
  assert.notEqual(secondNavigation.isError, true, textResult(secondNavigation))
  const backed = await call('browser_navigate_back')
  assert.notEqual(backed.isError, true, textResult(backed))
  const forwarded = await call('browser_navigate_forward')
  assert.notEqual(forwarded.isError, true, textResult(forwarded))
  assert.match(textResult(forwarded), /history=second/)
  const reloaded = await call('browser_reload')
  assert.notEqual(reloaded.isError, true, textResult(reloaded))
  assert.match(textResult(reloaded), /history=second/)

  const screenshot = await call('browser_take_screenshot', { filename: 'mcp-smoke.png' })
  assert.notEqual(screenshot.isError, true, textResult(screenshot))
  const screenshotPath = path.join(outputDir, 'mcp-smoke.png')
  assert.ok(fs.statSync(screenshotPath).size > 0, 'packaged MCP screenshot is empty')

  const closed = await call('browser_close')
  assert.notEqual(closed.isError, true, textResult(closed))
  console.log(JSON.stringify({
    ok: true,
    mcpVersion: mcpPackage.version,
    mcpCli,
    playwrightEntry,
    playwrightCoreEntry,
    chromiumExecutable: expectedChromium,
    browserProcesses: browserProcessDiagnostics,
    toolCount: toolNames.size,
    snapshotTarget: target,
    automaticSnapshots: [initialSnapshot.path, changedSnapshot.path],
    screenshot: screenshotPath,
    screenshotBytes: fs.statSync(screenshotPath).size,
    mcpStderr: mcpStderr.trim(),
  }))
} finally {
  if (connected) await client.close().catch(() => {})
  await new Promise(resolve => pageServer.close(resolve))
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
      PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: target.hostPlatform,
      BAILONGMA_USER_DIR: userDir,
      BAILONGMA_PACKAGED_RESOURCES: resources,
      BAILONGMA_SMOKE_APP_ASAR: appAsar,
      BAILONGMA_EXPECTED_CHROMIUM: chromiumExe,
      BAILONGMA_SMOKE_PLATFORM: target.platform,
      BAILONGMA_SMOKE_ARCH: target.arch,
      BAILONGMA_SMOKE_HOST_PLATFORM: target.hostPlatform,
      // A bogus cache makes accidental reliance on a user's browser cache fail.
      LOCALAPPDATA: path.join(tempRoot, 'empty-local-app-data'),
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
      timedOut ? `packaged Playwright MCP probe timed out after ${timeoutMs}ms` : `packaged Playwright MCP probe exited ${result.code} (${result.signal || 'no signal'})`,
      stdout && `stdout:\n${stdout.trim()}`,
      stderr && `stderr:\n${stderr.trim()}`,
    ].filter(Boolean).join('\n'))
  }
  const payloadLine = stdout.trim().split(/\r?\n/).findLast(line => line.trim().startsWith('{'))
  assert.ok(payloadLine, `packaged probe emitted no JSON result:\n${stdout}`)
  return JSON.parse(payloadLine)
}

function packagedChromiumPids() {
  if (target.platform === 'darwin') {
    const result = spawnSync('ps', ['-axo', 'pid=,command='], {
      encoding: 'utf8',
      timeout: 15_000,
    })
    if (result.error) throw result.error
    if (result.status !== 0) {
      throw new Error(`failed to inspect packaged Chromium processes: ${result.stderr || `exit ${result.status}`}`)
    }
    return result.stdout.split(/\r?\n/).map(line => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/)
      return match && match[2].includes(chromiumRoot) ? Number(match[1]) : null
    }).filter(Number.isInteger)
  }
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
    if (target.platform === 'win32') {
      spawnSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      try { process.kill(pid, 'SIGKILL') } catch {}
    }
  }
  throw new Error(`packaged Chromium processes remained after MCP probe exit and were killed: ${pids.join(', ')}`)
}

try {
  let probe
  try {
    probe = await runProbe()
  } finally {
    await assertPackagedChromiumExited()
  }
  const artifacts = fs.readdirSync(distDir)
    .filter(name => target.artifactPattern.test(name))
    .map(name => ({ name, bytes: fs.statSync(path.join(distDir, name)).size }))
  assert.ok(artifacts.length > 0, `${target.platform}-${target.arch} installer artifact is missing from dist`)
  console.log(JSON.stringify({
    ok: true,
    platform: target.platform,
    arch: target.arch,
    appAsarBytes: fs.statSync(appAsar).size,
    packagedBrowserBytes: dirSize(browsersDir),
    mcpVersion: mcpPackage.version,
    playwrightVersion: playwrightPackage.version,
    chromiumRevision: chromium.revision,
    chromiumExecutable: chromiumExe,
    artifacts,
    probe,
  }, null, 2))
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
