#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolveTargets } from './prepare-playwright-browsers.mjs'
import { getPrimaryChromiumLaunchOptions } from '../src/capabilities/tools/web/browser.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const mainSource = readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8')
const macBuildSource = readFileSync(path.join(root, 'scripts', 'build-mac.mjs'), 'utf8')
const gitignore = readFileSync(path.join(root, '.gitignore'), 'utf8')
const require = createRequire(import.meta.url)
const runtime = require('../electron/playwright-runtime.cjs')

assert.equal(pkg.dependencies.playwright, '1.59.1')
assert.equal(pkg.dependencies['playwright-core'], '1.59.1')
assert.equal(pkg.devDependencies.playwright, undefined)
assert.deepEqual(pkg.build.extraResources, [{
  from: 'build/playwright-browsers/${os}-${arch}',
  to: 'playwright-browsers',
  filter: ['**/*'],
}])
for (const name of ['build', 'build:win', 'publish']) {
  const script = pkg.scripts[name]
  assert.ok(script.indexOf('prebuild-clean.mjs') < script.indexOf('prepare-playwright-browsers.mjs'), `${name} must clean before staging`)
  assert.ok(script.indexOf('prepare-playwright-browsers.mjs') < script.indexOf('electron-builder'), `${name} must stage before electron-builder`)
}
assert.ok(macBuildSource.indexOf('prebuild-clean.mjs') < macBuildSource.indexOf('prepare-playwright-browsers.mjs'))
assert.ok(macBuildSource.indexOf('prepare-playwright-browsers.mjs') < macBuildSource.indexOf('electron-builder'))
assert.ok(mainSource.indexOf('configurePackagedPlaywright') < mainSource.indexOf('await import(pathToFileURL(BACKEND_ENTRY)'))
assert.match(gitignore, /^build\/playwright-browsers\/$/m)

assert.deepEqual(resolveTargets([], 'win32').map((target) => target.builderKey), ['win-x64'])
assert.deepEqual(resolveTargets([], 'darwin').map((target) => target.builderKey), ['mac-x64', 'mac-arm64'])
assert.equal(runtime.packagedHostPlatform('darwin', 'arm64'), 'mac15-arm64')
const env = {}
assert.equal(runtime.configurePackagedPlaywright({
  isPackaged: true,
  resourcesPath: path.join(root, 'fake-resources'),
  platform: 'win32',
  arch: 'x64',
  env,
}), path.join(root, 'fake-resources', 'playwright-browsers'))
assert.equal(env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE, 'win64')
assert.equal(env.BAILONGMA_BUNDLED_PLAYWRIGHT, '1')
assert.deepEqual(getPrimaryChromiumLaunchOptions(env), { headless: true, channel: 'chromium' })
assert.deepEqual(getPrimaryChromiumLaunchOptions({ PLAYWRIGHT_BROWSERS_PATH: 'shared-cache' }), { headless: true })
assert.deepEqual(getPrimaryChromiumLaunchOptions({}), { headless: true })

console.log('Playwright packaging configuration: OK')
