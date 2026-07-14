#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const stagingRoot = path.join(projectRoot, 'build', 'playwright-browsers')
const require = createRequire(import.meta.url)

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
  throw new Error(`Playwright browser staging is not configured for ${platform}`)
}

export function installTarget(target) {
  const destination = path.join(stagingRoot, target.builderKey)
  mkdirSync(destination, { recursive: true })
  if (target.platform === 'win32') return installWindowsTarget(target, destination)
  const cli = path.join(projectRoot, 'node_modules', 'playwright', 'cli.js')
  console.log(`[playwright] staging Chromium for ${target.platform}-${target.arch} in ${destination}`)
  const result = spawnSync(process.execPath, [cli, 'install', 'chromium', '--no-shell'], {
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

function windowsDescriptor(target, destination) {
  const previousPath = process.env.PLAYWRIGHT_BROWSERS_PATH
  const previousPlatform = process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE
  process.env.PLAYWRIGHT_BROWSERS_PATH = destination
  process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE = target.hostOverride
  try {
    // Use Playwright's own registry as the source of truth for the browser
    // revision, URLs, install directory and executable layout.
    const { registry } = require(path.join(projectRoot, 'node_modules', 'playwright-core', 'lib', 'server', 'registry', 'index.js'))
    return registry.findExecutable('chromium')
  } finally {
    if (previousPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH
    else process.env.PLAYWRIGHT_BROWSERS_PATH = previousPath
    if (previousPlatform === undefined) delete process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE
    else process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE = previousPlatform
  }
}

function installWindowsTarget(target, destination) {
  const descriptor = windowsDescriptor(target, destination)
  if (!descriptor?.directory || !descriptor?.revision || !descriptor?.downloadURLs?.length) {
    throw new Error('Playwright registry did not provide a complete Chromium descriptor')
  }
  const executable = descriptor.executablePath()
  const marker = path.join(descriptor.directory, 'INSTALLATION_COMPLETE')
  if (existsSync(executable) && existsSync(marker)) {
    console.log(`[playwright] Chromium ${descriptor.revision} already staged in ${descriptor.directory}`)
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
      console.log(`[playwright] downloading Chromium ${descriptor.revision} from ${url}`)
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
    console.log(`[playwright] staged Chromium ${descriptor.revision} in ${descriptor.directory}`)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

export function main() {
  mkdirSync(stagingRoot, { recursive: true })
  for (const target of resolveTargets()) installTarget(target)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main()
  } catch (error) {
    console.error(`[playwright] ${error.message}`)
    process.exitCode = 1
  }
}
