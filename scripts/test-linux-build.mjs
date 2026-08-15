#!/usr/bin/env node

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  elfMachineFromBuffer,
  validateLinuxBuildHost,
} from './build-linux.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

const elf = Buffer.alloc(64)
Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(elf)
elf[5] = 1
elf.writeUInt16LE(0x3e, 18)
assert.equal(elfMachineFromBuffer(elf), 0x3e)
elf.writeUInt16LE(0xb7, 18)
assert.equal(elfMachineFromBuffer(elf), 0xb7)
assert.equal(elfMachineFromBuffer(Buffer.from('not-elf')), null)

assert.doesNotThrow(() => validateLinuxBuildHost({ platform: 'linux', arch: 'x64' }))
assert.throws(() => validateLinuxBuildHost({ platform: 'darwin', arch: 'arm64' }), /must be built on Linux/)
assert.throws(() => validateLinuxBuildHost({ platform: 'linux', arch: 'arm64' }), /targets x64/)

assert.equal(pkg.scripts['build:linux'], 'node scripts/build-linux.mjs')
assert.equal(pkg.scripts['release:linux'], 'node scripts/build-linux.mjs && node scripts/publish-linux-updates.mjs')
assert.equal(pkg.scripts['smoke:linux-artifacts'], 'node ./scripts/smoke-linux-artifacts.mjs')
assert.deepEqual(pkg.build.linux.target[0].arch, ['x64'])
for (const excluded of [
  '!**/node_modules/onnxruntime-node/bin/napi-v3/darwin/**/*',
  '!**/node_modules/onnxruntime-node/bin/napi-v3/win32/**/*',
  '!**/node_modules/sherpa-onnx-darwin-*/**/*',
  '!**/node_modules/sherpa-onnx-win-*/**/*',
  '!build/native-speech-recognizer',
]) {
  assert.ok(pkg.build.linux.files.includes(excluded), `Linux package exclusions are missing ${excluded}`)
}

console.log('Linux build configuration tests passed')
