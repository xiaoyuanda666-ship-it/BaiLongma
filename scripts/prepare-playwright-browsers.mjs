#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const stagingRoot = path.join(projectRoot, 'build', 'playwright-browsers')

export function resolveMcpRuntime(root = projectRoot) {
  const rootRequire = createRequire(path.join(root, 'package.json'))
  const mcpPackagePath = rootRequire.resolve('@playwright/mcp/package.json')
  const mcpPackage = JSON.parse(readFileSync(mcpPackagePath, 'utf8'))
  const mcpRequire = createRequire(mcpPackagePath)
  const playwrightPackagePath = mcpRequire.resolve('playwright/package.json')
  const playwrightCorePackagePath = mcpRequire.resolve('playwright-core/package.json')
  const playwrightPackage = JSON.parse(readFileSync(playwrightPackagePath, 'utf8'))
  const playwrightCorePackage = JSON.parse(readFileSync(playwrightCorePackagePath, 'utf8'))
  const mcpBin = typeof mcpPackage.bin === 'string' ? mcpPackage.bin : mcpPackage.bin?.['playwright-mcp']
  const mcpCli = mcpBin && path.resolve(path.dirname(mcpPackagePath), mcpBin)

  if (!mcpCli || !existsSync(mcpCli)) {
    throw new Error(`@playwright/mcp ${mcpPackage.version || '(unknown)'} does not provide a usable playwright-mcp CLI`)
  }
  if (mcpPackage.dependencies?.playwright !== playwrightPackage.version) {
    throw new Error(`@playwright/mcp expects playwright ${mcpPackage.dependencies?.playwright}, resolved ${playwrightPackage.version}`)
  }
  if (mcpPackage.dependencies?.['playwright-core'] !== playwrightCorePackage.version) {
    throw new Error(`@playwright/mcp expects playwright-core ${mcpPackage.dependencies?.['playwright-core']}, resolved ${playwrightCorePackage.version}`)
  }
  if (playwrightPackage.dependencies?.['playwright-core'] !== playwrightCorePackage.version) {
    throw new Error(`playwright expects playwright-core ${playwrightPackage.dependencies?.['playwright-core']}, resolved ${playwrightCorePackage.version}`)
  }

  return {
    mcpCli,
    mcpPackage,
    mcpPackagePath,
    mcpRequire,
    playwrightPackage,
    playwrightPackagePath,
    playwrightCorePackage,
    playwrightCorePackagePath,
  }
}

export function resolveTargets(args = process.argv.slice(2), hostPlatform = process.platform) {
  const platformArg = args.find((arg) => arg.startsWith('--platform='))?.split('=', 2)[1]
  const platform = platformArg || hostPlatform
  const archs = args.filter((arg) => arg.startsWith('--arch=')).map((arg) => arg.split('=', 2)[1])

  if (platform === 'win32') {
    const requested = archs.length ? archs : ['x64']
    if (requested.some((arch) => arch !== 'x64')) throw new Error('Windows Playwright packaging currently supports x64 only')
    return requested.map((arch) => ({ platform, arch, builderKey: `win-${arch}`, hostOverride: 'win64' }))
  }
  if (platform === 'darwin') {
    const requested = archs.length ? archs : ['x64', 'arm64']
    if (requested.some((arch) => !['x64', 'arm64'].includes(arch))) throw new Error('macOS Playwright packaging supports x64 and arm64 only')
    return requested.map((arch) => ({
      platform,
      arch,
      builderKey: `mac-${arch}`,
      hostOverride: arch === 'arm64' ? 'mac15-arm64' : 'mac15',
    }))
  }
  if (platform === 'linux') {
    const requested = archs.length ? archs : ['x64']
    if (requested.some((arch) => arch !== 'x64')) throw new Error('Linux Playwright packaging currently supports x64 only')
    return requested.map((arch) => ({
      platform,
      arch,
      builderKey: `linux-${arch}`,
      hostOverride: 'ubuntu24.04-x64',
    }))
  }
  throw new Error(`Playwright browser staging is not configured for ${platform}`)
}

export function installTarget(target, runtime = resolveMcpRuntime()) {
  const destination = path.join(stagingRoot, target.builderKey)
  mkdirSync(destination, { recursive: true })
  if (target.platform === 'win32') return installWindowsTarget(target, destination, runtime)
  console.log(`[playwright] staging Chromium for Playwright MCP ${runtime.mcpPackage.version} (${target.platform}-${target.arch}) in ${destination}`)
  const result = spawnSync(process.execPath, [runtime.mcpCli, 'install-browser', 'chromium', '--no-shell', '--no-progress'], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: destination,
      PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: target.hostOverride,
    },
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Playwright Chromium install failed for ${target.builderKey} (exit ${result.status})`)
}

export function hasStagedBrowser(target, root = stagingRoot) {
  const destination = path.join(root, target.builderKey)
  if (!existsSync(destination)) return false
  const relative = target.platform === 'darwin'
    ? path.join(`chrome-mac-${target.arch}`, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
    : target.platform === 'linux'
      ? path.join('chrome-linux64', 'chrome')
      : path.join('chrome-win64', 'chrome.exe')
  return readdirSync(destination, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^chromium-\d+$/.test(entry.name))
    .some(entry => (
      existsSync(path.join(destination, entry.name, 'INSTALLATION_COMPLETE'))
      && existsSync(path.join(destination, entry.name, relative))
    ))
}

export function pruneStaleBrowsers(target, root = stagingRoot, runtime = resolveMcpRuntime()) {
  const destination = path.join(root, target.builderKey)
  mkdirSync(destination, { recursive: true })
  const descriptor = browserDescriptor(target, destination, runtime)
  const expectedDirectory = path.basename(descriptor.directory)
  const removed = []
  for (const entry of readdirSync(destination, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^chromium-\d+$/.test(entry.name) || entry.name === expectedDirectory) continue
    rmSync(path.join(destination, entry.name), { recursive: true, force: true })
    removed.push(entry.name)
  }
  return { descriptor, removed }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    timeout: 10 * 60_000,
    windowsHide: true,
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (exit ${result.status})`)
}

export function browserDescriptor(target, destination, runtime = resolveMcpRuntime()) {
  const previousPath = process.env.PLAYWRIGHT_BROWSERS_PATH
  const previousPlatform = process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE
  process.env.PLAYWRIGHT_BROWSERS_PATH = destination
  process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE = target.hostOverride
  try {
    // The MCP-pinned Playwright registry is the source of truth for the
    // revision, URLs, install directory and executable layout.
    const coreBundlePath = runtime.mcpRequire.resolve('playwright-core/lib/coreBundle')
    delete runtime.mcpRequire.cache[coreBundlePath]
    const coreBundle = runtime.mcpRequire('playwright-core/lib/coreBundle')
    const registry = coreBundle.registry?.registry || coreBundle.registry
    if (typeof registry?.findExecutable !== 'function') {
      throw new Error('MCP Playwright core bundle does not expose its browser registry')
    }
    return registry.findExecutable('chromium')
  } finally {
    if (previousPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH
    else process.env.PLAYWRIGHT_BROWSERS_PATH = previousPath
    if (previousPlatform === undefined) delete process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE
    else process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE = previousPlatform
  }
}

function installWindowsTarget(target, destination, runtime) {
  const descriptor = browserDescriptor(target, destination, runtime)
  if (!descriptor?.directory || !descriptor?.revision || !descriptor?.downloadURLs?.length) {
    throw new Error('Playwright registry did not provide a complete Chromium descriptor')
  }
  const executable = descriptor.executablePath()
  const marker = path.join(descriptor.directory, 'INSTALLATION_COMPLETE')
  if (existsSync(executable) && existsSync(marker)) {
    console.log(`[playwright] MCP Chromium ${descriptor.revision} already staged in ${descriptor.directory}`)
    return
  }

  // On some Windows hosts the Playwright Node downloader receives the full
  // Chrome-for-Testing response but waits indefinitely for the CDN connection
  // to close. curl honors Content-Length and gives the build a hard timeout.
  // The URL and destination still come from the installed Playwright version;
  // no global/user ms-playwright cache participates in this build.
  const temp = mkdtempSync(path.join(os.tmpdir(), 'bailongma-playwright-'))
  const archive = path.join(temp, `chromium-${descriptor.revision}.zip`)
  try {
    let downloaded = false
    let lastError
    for (const url of descriptor.downloadURLs) {
      console.log(`[playwright] downloading MCP Chromium ${descriptor.revision} from ${url}`)
      try {
        run('curl.exe', [
          '--fail', '--location', '--retry', '3', '--retry-delay', '2',
          '--connect-timeout', '30', '--max-time', '600',
          '--output', archive, url,
        ])
        downloaded = true
        break
      } catch (error) {
        lastError = error
      }
    }
    if (!downloaded) throw lastError || new Error('No Playwright Chromium download URL succeeded')
    run('tar.exe', ['-tf', archive], { stdio: 'ignore' })
    rmSync(descriptor.directory, { recursive: true, force: true })
    mkdirSync(descriptor.directory, { recursive: true })
    run('tar.exe', ['-xf', archive, '-C', descriptor.directory])
    if (!existsSync(executable)) throw new Error(`Chromium executable is absent after extraction: ${executable}`)
    writeFileSync(marker, '')
    console.log(`[playwright] staged MCP Chromium ${descriptor.revision} in ${descriptor.directory}`)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

export function main() {
  mkdirSync(stagingRoot, { recursive: true })
  let runtime
  for (const target of resolveTargets()) {
    runtime ||= resolveMcpRuntime()
    const { descriptor, removed } = pruneStaleBrowsers(target, stagingRoot, runtime)
    if (removed.length) {
      console.log(`[playwright] removed stale Chromium revisions for ${target.builderKey}: ${removed.join(', ')}`)
    }
    if (hasStagedBrowser(target)) {
      console.log(`[playwright] reusing staged bundled Chromium ${descriptor.revision} for ${target.builderKey}`)
      continue
    }
    installTarget(target, runtime)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main()
  } catch (error) {
    console.error(`[playwright] ${error.message}`)
    process.exitCode = 1
  }
}
