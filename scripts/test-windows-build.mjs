#!/usr/bin/env node

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  peMachineFromBuffer,
  signingIsRequired,
  validateWindowsBuildHost,
} from './build-win.mjs'
import { resolveNodeLicense } from './prepare-node-runtime.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const winBuild = fs.readFileSync(path.join(root, 'scripts', 'build-win.mjs'), 'utf8')

const pe = Buffer.alloc(128)
pe.write('MZ', 0, 'ascii')
pe.writeUInt32LE(64, 0x3c)
pe.write('PE\0\0', 64, 'ascii')
pe.writeUInt16LE(0x8664, 68)
assert.equal(peMachineFromBuffer(pe), 0x8664)
pe.writeUInt16LE(0xaa64, 68)
assert.equal(peMachineFromBuffer(pe), 0xaa64)
assert.equal(peMachineFromBuffer(Buffer.from('not-pe')), null)

assert.doesNotThrow(() => validateWindowsBuildHost({ platform: 'win32', arch: 'x64' }))
assert.throws(() => validateWindowsBuildHost({ platform: 'darwin', arch: 'arm64' }), /must be built on Windows/)
assert.throws(() => validateWindowsBuildHost({ platform: 'win32', arch: 'arm64' }), /targets x64/)
assert.equal(signingIsRequired([], {}), false)
assert.equal(signingIsRequired(['--require-signing'], {}), true)
assert.equal(signingIsRequired([], { BAILONGMA_REQUIRE_WINDOWS_SIGNING: 'true' }), true)

assert.equal(pkg.scripts['build:win'], 'node scripts/build-win.mjs')
assert.equal(pkg.scripts['build:win:release'], 'node scripts/build-win.mjs --require-signing')
assert.equal(pkg.scripts['release:win'], 'node scripts/build-win.mjs --require-signing && node scripts/publish-win-updates.mjs')
assert.equal(pkg.scripts['smoke:win-artifacts'], 'node ./scripts/smoke-win-artifacts.mjs')
assert.deepEqual(pkg.build.win.target[0].arch, ['x64'])
for (const required of ['electron/**/*', 'src/**/*', 'skills/**/*', 'package.json']) {
  assert.ok(pkg.build.win.files.includes(required), `Windows package whitelist is missing ${required}`)
}
for (const excluded of [
  '!.dev-test/**/*',
  '!sandbox/**/*',
  '!data/**/*',
  '!images/**/*',
  '!**/node_modules/onnxruntime-node/bin/napi-v3/darwin/**/*',
  '!**/node_modules/onnxruntime-node/bin/napi-v3/linux/**/*',
  '!**/node_modules/onnxruntime-node/bin/napi-v3/win32/arm64/**/*',
]) {
  assert.ok(pkg.build.win.files.includes(excluded), `Windows package exclusions are missing ${excluded}`)
}
assert.ok(pkg.build.win.files.includes('!build/native-speech-recognizer'))
assert.ok(pkg.build.win.asarUnpack.includes('!build/native-speech-recognizer'))
assert.equal(pkg.build.nsis.createStartMenuShortcut, true)
assert.equal(pkg.build.nsis.createDesktopShortcut, false)
assert.doesNotMatch(winBuild, /build-macos-speech/)
assert.match(winBuild, /'-a', 'x64'/)
assert.ok(winBuild.indexOf('smoke-win-artifacts.mjs') < winBuild.indexOf('smoke-packaged-playwright.mjs'))

const licenseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-node-license-'))
try {
  const executable = path.join(licenseRoot, 'node.exe')
  const license = path.join(licenseRoot, 'LICENSE.txt')
  fs.writeFileSync(executable, '')
  fs.writeFileSync(license, 'Node license fixture')
  assert.equal(resolveNodeLicense(executable), license)
} finally {
  fs.rmSync(licenseRoot, { recursive: true, force: true })
}

console.log('Windows build configuration tests passed')
