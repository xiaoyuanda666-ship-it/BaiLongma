#!/usr/bin/env node

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import yaml from 'js-yaml'
import { assertFinalMacUpdateMetadata, refreshMacUpdateMetadata } from './refresh-macos-update-metadata.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-final-metadata-test-'))
const dist = path.join(root, 'dist')
const options = { root, productName: 'Bailongma', version: '9.8.7' }
const manifestPath = path.join(dist, 'latest-mac.yml')
fs.mkdirSync(dist)

const filename = (arch, extension) => `Bailongma-9.8.7-mac-${arch}.${extension}`
const filePath = (arch, extension) => path.join(dist, filename(arch, extension))
const hash = file => crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64')
function blockmap(arch, extension) {
  fs.writeFileSync(`${filePath(arch, extension)}.blockmap`, zlib.gzipSync(JSON.stringify({
    version: '2',
    files: [{ name: 'fixture', offset: 0, checksums: ['fixture'], sizes: [fs.statSync(filePath(arch, extension)).size] }],
  })))
}
function builderManifest(arch) {
  const files = ['zip', 'dmg'].map(extension => ({
    url: filename(arch, extension),
    size: fs.statSync(filePath(arch, extension)).size,
    sha512: hash(filePath(arch, extension)),
  }))
  const metadata = {
    version: options.version, files, path: files[0].url, sha512: files[0].sha512,
    releaseDate: '2026-01-02T03:04:05.000Z',
    releaseNotes: 'Preserve release notes', stagingPercentage: 25,
  }
  fs.writeFileSync(manifestPath, yaml.dump(metadata))
  return metadata
}

try {
  for (const arch of ['x64', 'arm64']) {
    for (const extension of ['zip', 'dmg']) {
      fs.writeFileSync(filePath(arch, extension), `${arch}-${extension}-original`)
      blockmap(arch, extension)
    }
  }
  const original = builderManifest('arm64')
  fs.appendFileSync(filePath('arm64', 'dmg'), '-stapled-ticket')
  blockmap('arm64', 'dmg')
  assert.throws(() => assertFinalMacUpdateMetadata(options), /size mismatch/)
  const finalDmg = fs.readFileSync(filePath('arm64', 'dmg'))
  refreshMacUpdateMetadata({ ...options, arch: 'arm64' })
  const refreshed = assertFinalMacUpdateMetadata(options)
  assert.equal(refreshed.arch, 'arm64')
  for (const key of ['releaseDate', 'releaseNotes', 'stagingPercentage']) {
    assert.equal(refreshed.metadata[key], original[key])
  }
  assert.deepEqual(fs.readFileSync(filePath('arm64', 'dmg')), finalDmg, 'metadata refresh must never alter artifacts')
  assert.equal(refreshed.metadata.files[1].sha512, hash(filePath('arm64', 'dmg')))

  // A byte change without size growth must still be rejected, as must a stale
  // legacy ZIP hash even when the files[] entry is already correct.
  const changed = Buffer.from(finalDmg)
  changed[0] ^= 1
  fs.writeFileSync(filePath('arm64', 'dmg'), changed)
  assert.throws(() => assertFinalMacUpdateMetadata(options), /SHA-512 mismatch/)
  refreshMacUpdateMetadata({ ...options, arch: 'arm64' })
  const legacyMismatch = yaml.load(fs.readFileSync(manifestPath, 'utf8'))
  legacyMismatch.sha512 = 'stale'
  fs.writeFileSync(manifestPath, yaml.dump(legacyMismatch))
  assert.throws(() => assertFinalMacUpdateMetadata(options), /legacy SHA-512/)
  refreshMacUpdateMetadata({ ...options, arch: 'arm64' })
  assertFinalMacUpdateMetadata(options)

  const beforeWrongArch = fs.readFileSync(manifestPath)
  assert.throws(() => refreshMacUpdateMetadata({ ...options, arch: 'x64' }), /expected x64 architecture/)
  assert.deepEqual(fs.readFileSync(manifestPath), beforeWrongArch)

  // Reversing the build order must leave a single x64 manifest, not merge both
  // architectures or silently switch back to arm64.
  builderManifest('x64')
  fs.appendFileSync(filePath('x64', 'dmg'), '-another-ticket')
  blockmap('x64', 'dmg')
  refreshMacUpdateMetadata({ ...options, arch: 'x64' })
  const x64 = assertFinalMacUpdateMetadata(options)
  assert.equal(x64.arch, 'x64')
  assert.deepEqual(x64.metadata.files.map(file => file.url), [filename('x64', 'zip'), filename('x64', 'dmg')])

  const beforeFailure = fs.readFileSync(manifestPath)
  fs.appendFileSync(filePath('x64', 'dmg'), '-invalidates-blockmap')
  assert.throws(() => refreshMacUpdateMetadata({ ...options, arch: 'x64' }), /Blockmap describes/)
  assert.deepEqual(fs.readFileSync(manifestPath), beforeFailure, 'failure must preserve the existing manifest')
  blockmap('x64', 'dmg')
  assert.throws(() => refreshMacUpdateMetadata({ ...options, version: '9.8.8', arch: 'x64' }), /must describe version/)
  assert.deepEqual(fs.readFileSync(manifestPath), beforeFailure)
  fs.rmSync(filePath('x64', 'zip'))
  assert.throws(() => refreshMacUpdateMetadata({ ...options, arch: 'x64' }), /Missing or empty release artifact/)
  assert.deepEqual(fs.readFileSync(manifestPath), beforeFailure)

  console.log('PASS final macOS metadata: post-staple hashes, last-architecture semantics, and failure preservation')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
