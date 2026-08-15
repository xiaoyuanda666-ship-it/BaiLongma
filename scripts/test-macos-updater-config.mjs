#!/usr/bin/env node

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertMacUpdaterConfig,
  assertMacUpdaterConfigFile,
  createMacUpdaterConfig,
  updaterConfigPathForApp,
  writeMacUpdaterConfig,
} from './macos-updater-config.mjs'

const publish = [{
  provider: 'generic',
  url: 'https://updates.bailongma.ai/stable/${os}/${arch}',
  channel: 'latest',
}]

const x64 = createMacUpdaterConfig({ arch: 'x64', publish })
assert.deepEqual(x64, {
  provider: 'generic',
  url: 'https://updates.bailongma.ai/stable/mac/x64',
  channel: 'latest',
  updaterCacheDirName: 'bailongma-updater',
})

const arm64 = createMacUpdaterConfig({ arch: 'arm64', publish })
assert.deepEqual(arm64, {
  provider: 'generic',
  url: 'https://updates.bailongma.ai/stable/mac/arm64',
  channel: 'latest',
  updaterCacheDirName: 'bailongma-updater',
})

assert.throws(
  () => assertMacUpdaterConfig({ ...x64, url: arm64.url }, 'x64', 'wrong x64 fixture'),
  /expected .*mac\/x64/,
)
assert.throws(
  () => createMacUpdaterConfig({ arch: 'x64', publish: [{ ...publish[0], url: arm64.url }] }),
  /expected .*mac\/x64/,
)
assert.throws(
  () => createMacUpdaterConfig({ arch: 'arm64', publish: [] }),
  /publish configuration is missing/,
)

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-updater-config-test-'))
try {
  const apps = Object.fromEntries(['x64', 'arm64'].map(arch => {
    const appPath = path.join(tempRoot, arch, 'Bailongma.app')
    fs.mkdirSync(path.join(appPath, 'Contents', 'Resources'), { recursive: true })
    return [arch, appPath]
  }))
  writeMacUpdaterConfig({ appPath: apps.x64, arch: 'x64', publish })
  writeMacUpdaterConfig({ appPath: apps.arm64, arch: 'arm64', publish })
  assert.throws(
    () => assertMacUpdaterConfigFile(path.join(tempRoot, 'missing-app-update.yml'), 'arm64'),
    /is missing/,
  )
  assertMacUpdaterConfigFile(updaterConfigPathForApp(apps.x64), 'x64')
  assertMacUpdaterConfigFile(updaterConfigPathForApp(apps.arm64), 'arm64')
  assert.match(fs.readFileSync(updaterConfigPathForApp(apps.x64), 'utf8'), /\/mac\/x64/)
  assert.doesNotMatch(fs.readFileSync(updaterConfigPathForApp(apps.x64), 'utf8'), /\/mac\/arm64/)
  assert.match(fs.readFileSync(updaterConfigPathForApp(apps.arm64), 'utf8'), /\/mac\/arm64/)
  assert.doesNotMatch(fs.readFileSync(updaterConfigPathForApp(apps.arm64), 'utf8'), /\/mac\/x64/)
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

console.log('macOS updater configuration tests passed')
