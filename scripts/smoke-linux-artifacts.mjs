#!/usr/bin/env node

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { extractFile, listPackage } from '@electron/asar'
import { assertElfX64 } from './build-linux.mjs'
import { inspectEmbeddedBlockmap } from './publish-updates-lib.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const appImage = path.join(root, 'dist', `${pkg.productName}-${pkg.version}-linux-x64.AppImage`)
const latestYml = path.join(root, 'dist', 'latest-linux.yml')

if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error(`Linux artifact smoke requires Linux x64, got ${process.platform}-${process.arch}`)
}

for (const [file, label] of [[appImage, 'AppImage'], [latestYml, 'latest-linux.yml']]) {
  assert.ok(fs.existsSync(file) && fs.statSync(file).isFile() && fs.statSync(file).size > 0,
    `${label} is missing or empty: ${file}`)
}
assertElfX64(appImage, 'AppImage runtime')
const appImageSize = fs.statSync(appImage).size
const blockMapSize = inspectEmbeddedBlockmap(appImage, appImageSize)
const appImageHash = crypto.createHash('sha512')
const appImageFd = fs.openSync(appImage, 'r')
const hashBuffer = Buffer.allocUnsafe(8 * 1024 * 1024)
try {
  while (true) {
    const bytesRead = fs.readSync(appImageFd, hashBuffer, 0, hashBuffer.length, null)
    if (bytesRead === 0) break
    appImageHash.update(hashBuffer.subarray(0, bytesRead))
  }
} finally {
  fs.closeSync(appImageFd)
}
const sha512 = appImageHash.digest('base64')

const latest = fs.readFileSync(latestYml, 'utf8')
assert.match(latest, new RegExp(`version:\\s*['\"]?${pkg.version.replaceAll('.', '\\.')}['\"]?`))
assert.ok(latest.includes(path.basename(appImage)), 'latest-linux.yml does not reference this AppImage')
assert.match(latest, new RegExp(`sha512:\\s*${sha512.replaceAll('+', '\\+').replaceAll('/', '\\/')}\\s*$`, 'm'))
assert.match(latest, new RegExp(`size:\\s*${appImageSize}\\s*$`, 'm'))
assert.match(latest, new RegExp(`blockMapSize:\\s*${blockMapSize}\\s*$`, 'm'))

const extractionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-linux-smoke-'))
try {
  const extracted = spawnSync(appImage, ['--appimage-extract'], {
    cwd: extractionRoot,
    encoding: 'utf8',
    timeout: 120_000,
  })
  assert.equal(extracted.status, 0,
    `AppImage extraction failed:\n${extracted.stdout || ''}\n${extracted.stderr || ''}`)

  const appRoot = path.join(extractionRoot, 'squashfs-root')
  const executable = path.join(appRoot, pkg.name)
  const resources = path.join(appRoot, 'resources')
  const appAsar = path.join(resources, 'app.asar')
  const appUnpacked = `${appAsar}.unpacked`
  assertElfX64(executable, 'packaged Bailongma executable')
  assertElfX64(path.join(resources, 'node-runtime', 'node'), 'bundled Node runtime')
  assertElfX64(
    path.join(appUnpacked, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
    'packaged better-sqlite3 binding',
  )
  assertElfX64(
    path.join(appUnpacked, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3', 'linux', 'x64', 'onnxruntime_binding.node'),
    'packaged ONNX Runtime binding',
  )
  assert.equal(fs.existsSync(path.join(appUnpacked, 'build', 'native-speech-recognizer')), false,
    'Linux package must not contain the macOS native speech helper')

  const entries = new Set(listPackage(appAsar).map(entry => entry.replaceAll('\\', '/')))
  for (const forbiddenPrefix of [
    '/node_modules/onnxruntime-node/bin/napi-v3/darwin',
    '/node_modules/onnxruntime-node/bin/napi-v3/win32',
    '/node_modules/sherpa-onnx-darwin-',
    '/node_modules/sherpa-onnx-win-',
  ]) {
    assert.equal([...entries].some(entry => entry.startsWith(forbiddenPrefix)), false,
      `Linux package contains forbidden content: ${forbiddenPrefix}`)
  }
  const packagedPkg = JSON.parse(extractFile(appAsar, 'package.json').toString('utf8'))
  assert.equal(packagedPkg.version, pkg.version, 'packaged version does not match package.json')
} finally {
  fs.rmSync(extractionRoot, { recursive: true, force: true })
}

console.log(JSON.stringify({
  ok: true,
  version: pkg.version,
  platform: process.platform,
  arch: process.arch,
  appImage,
  appImageBytes: appImageSize,
  blockMapSize,
}, null, 2))
