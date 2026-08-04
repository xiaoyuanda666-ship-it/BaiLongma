#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  browserDescriptor,
  resolveMcpRuntime,
  resolveTargets,
} from './prepare-playwright-browsers.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
const mainSource = readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8')
const macBuildSource = readFileSync(path.join(root, 'scripts', 'build-mac.mjs'), 'utf8')
const gitignore = readFileSync(path.join(root, '.gitignore'), 'utf8')
const require = createRequire(import.meta.url)
const packagedRuntime = require('../electron/playwright-runtime.cjs')
const mcpRuntime = resolveMcpRuntime(root)

assert.equal(pkg.devDependencies.electron, lock.packages['node_modules/electron'].version,
  'Electron must be pinned exactly so native modules are rebuilt for the installed ABI')
for (const name of ['build', 'build:win', 'build:linux', 'publish']) {
  assert.match(pkg.scripts[name], new RegExp(`-v ${pkg.devDependencies.electron.replaceAll('.', '\\.')}(?:\\s|$)`),
    `${name} must rebuild native modules for the pinned Electron version`)
}
assert.equal(pkg.dependencies['@playwright/mcp'], '0.0.78')
assert.equal(pkg.dependencies.playwright, undefined, 'Playwright must be versioned through @playwright/mcp')
assert.equal(pkg.dependencies['playwright-core'], undefined, 'playwright-core must be versioned through @playwright/mcp')
assert.equal(lock.packages[''].dependencies['@playwright/mcp'], pkg.dependencies['@playwright/mcp'])
assert.equal(lock.packages['node_modules/@playwright/mcp'].version, pkg.dependencies['@playwright/mcp'])
assert.equal(mcpRuntime.mcpPackage.version, pkg.dependencies['@playwright/mcp'])
assert.equal(mcpRuntime.playwrightPackage.version, mcpRuntime.mcpPackage.dependencies.playwright)
assert.equal(mcpRuntime.playwrightCorePackage.version, mcpRuntime.mcpPackage.dependencies['playwright-core'])
assert.equal(mcpRuntime.playwrightPackage.dependencies['playwright-core'], mcpRuntime.playwrightCorePackage.version)
assert.equal(path.basename(mcpRuntime.mcpCli), 'cli.js')

const versionResult = spawnSync(process.execPath, [mcpRuntime.mcpCli, '--version'], {
  cwd: root,
  encoding: 'utf8',
})
assert.equal(versionResult.status, 0, versionResult.stderr)
assert.equal(versionResult.stdout.trim(), `Version ${mcpRuntime.mcpPackage.version}`)

assert.deepEqual(pkg.build.extraResources, [
  {
    from: 'build/playwright-browsers/${os}-${arch}',
    to: 'playwright-browsers',
    filter: ['**/*'],
  },
  {
    from: 'build/node-runtime/${os}-${arch}',
    to: 'node-runtime',
    filter: ['**/*'],
  },
])
for (const name of ['build', 'build:win', 'publish']) {
  const script = pkg.scripts[name]
  assert.ok(script.indexOf('prebuild-clean.mjs') < script.indexOf('prepare-playwright-browsers.mjs'), `${name} must clean before staging`)
  assert.ok(script.indexOf('prepare-playwright-browsers.mjs') < script.indexOf('electron-builder'), `${name} must stage before electron-builder`)
}
assert.ok(macBuildSource.indexOf('prebuild-clean.mjs') < macBuildSource.indexOf('prepare-playwright-browsers.mjs'))
assert.ok(macBuildSource.indexOf('prepare-playwright-browsers.mjs') < macBuildSource.indexOf('electron-builder'))
assert.match(mainSource, /createBrowserEmbedHost/)
assert.match(mainSource, /remote-debugging-port/)
assert.match(gitignore, /^build\/playwright-browsers\/$/m)

assert.deepEqual(resolveTargets([], 'win32').map(target => target.builderKey), ['win-x64'])
assert.deepEqual(resolveTargets([], 'darwin').map(target => target.builderKey), ['mac-x64', 'mac-arm64'])
assert.deepEqual(resolveTargets([], 'linux').map(target => target.builderKey), ['linux-x64'])
assert.throws(() => resolveTargets(['--arch=arm64'], 'win32'), /Windows Playwright packaging currently supports x64 only/)
assert.throws(() => resolveTargets(['--arch=arm64'], 'linux'), /Linux Playwright packaging currently supports x64 only/)

const descriptors = [
  ...resolveTargets([], 'darwin'),
  ...resolveTargets([], 'win32'),
  ...resolveTargets([], 'linux'),
].map(target => ({
  target,
  descriptor: browserDescriptor(
    target,
    path.join(root, 'fake-staging', target.builderKey),
    mcpRuntime,
  ),
}))
const revisions = new Set(descriptors.map(({ descriptor }) => descriptor.revision))
assert.equal(revisions.size, 1, 'all packaged targets must use the MCP-pinned Chromium revision')
for (const { target, descriptor } of descriptors) {
  assert.match(descriptor.directory, new RegExp(`fake-staging[/\\\\]${target.builderKey}[/\\\\]chromium-${descriptor.revision}$`))
  assert.ok(descriptor.downloadURLs.length > 0, `${target.builderKey} has no browser download URL`)
  assert.ok(descriptor.downloadURLs.every(url => url.includes(descriptor.browserVersion)), `${target.builderKey} URL does not match its browser version`)
}
assert.match(descriptors.find(({ target }) => target.builderKey === 'mac-x64').descriptor.executablePath(), /chrome-mac-x64/)
assert.match(descriptors.find(({ target }) => target.builderKey === 'mac-arm64').descriptor.executablePath(), /chrome-mac-arm64/)
assert.match(descriptors.find(({ target }) => target.builderKey === 'win-x64').descriptor.executablePath(), /chrome-win64[/\\]chrome\.exe$/)
assert.match(descriptors.find(({ target }) => target.builderKey === 'linux-x64').descriptor.executablePath(), /chrome-linux64[/\\]chrome$/)

assert.equal(packagedRuntime.packagedHostPlatform('darwin', 'arm64'), 'mac15-arm64')
assert.equal(packagedRuntime.packagedHostPlatform('linux', 'x64'), 'ubuntu24.04-x64')
const env = {}
assert.equal(packagedRuntime.configurePackagedPlaywright({
  isPackaged: true,
  resourcesPath: path.join(root, 'fake-resources'),
  platform: 'win32',
  arch: 'x64',
  env,
}), path.join(root, 'fake-resources', 'playwright-browsers'))
assert.equal(env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE, 'win64')
assert.equal(env.BAILONGMA_BUNDLED_PLAYWRIGHT, '1')

const bundledNode = path.join(root, 'fake-resources', 'node-runtime', 'node.exe')
const nodeEnv = { Path: 'C:\\Windows\\System32' }
assert.equal(packagedRuntime.configureBundledNodeRuntime({
  isPackaged: true,
  resourcesPath: path.join(root, 'fake-resources'),
  platform: 'win32',
  arch: 'x64',
  env: nodeEnv,
  existsSync: candidate => candidate === bundledNode,
}), bundledNode)
assert.equal(nodeEnv.BAILONGMA_NODE_RUNTIME_PATH, bundledNode)
assert.equal(nodeEnv.BAILONGMA_MCP_NODE_PATH, bundledNode)
assert.equal(nodeEnv.Path.split(';')[0], path.dirname(bundledNode))

console.log(JSON.stringify({
  ok: true,
  mcpVersion: mcpRuntime.mcpPackage.version,
  playwrightVersion: mcpRuntime.playwrightPackage.version,
  chromiumRevision: [...revisions][0],
  targets: descriptors.map(({ target, descriptor }) => ({
    target: target.builderKey,
    executable: descriptor.executablePath(),
  })),
}, null, 2))
