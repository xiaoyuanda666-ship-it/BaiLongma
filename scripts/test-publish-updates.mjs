#!/usr/bin/env node

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import {
  compareVersions,
  createMetadata,
  inspectEmbeddedBlockmap,
  platformConfig,
  publishUpdates,
} from './publish-updates-lib.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-publish-test-'))
const dist = path.join(root, 'dist')
const pkg = { productName: 'Bailongma', version: '9.8.7' }
fs.mkdirSync(dist)

function write(name, contents = name) {
  const filePath = path.join(dist, name)
  fs.writeFileSync(filePath, contents)
  return filePath
}

try {
  assert.equal(compareVersions('2.1.655', '2.1.654'), 1)
  assert.equal(compareVersions('2.1.655', '2.1.655'), 0)
  assert.equal(compareVersions('2.1.654', '2.1.655'), -1)
  assert.throws(() => compareVersions('2.1', '2.1.0'), /numeric x.y.z/)

  for (const arch of ['x64', 'arm64']) {
    const prefix = `Bailongma-9.8.7-mac-${arch}`
    for (const extension of ['zip', 'dmg']) {
      const artifact = write(`${prefix}.${extension}`)
      const externalBlockmap = zlib.gzipSync(Buffer.from(JSON.stringify({
        version: '2',
        files: [{ name: 'fixture', offset: 0, checksums: ['fixture'], sizes: [fs.statSync(artifact).size] }],
      })))
      write(`${prefix}.${extension}.blockmap`, externalBlockmap)
    }
  }
  const macConfig = platformConfig('mac', { root, ...pkg })
  const macArtifact = { arch: 'x64', ...macConfig.collect('x64') }
  const macMetadata = createMetadata({
    platform: 'mac',
    version: pkg.version,
    artifact: macArtifact,
    releaseDate: '2026-01-02T03:04:05.000Z',
  })
  assert.match(macMetadata, /Bailongma-9\.8\.7-mac-x64\.zip/)
  assert.match(macMetadata, /Bailongma-9\.8\.7-mac-x64\.dmg/)
  assert.equal((macMetadata.match(/  - url:/g) || []).length, 2)

  write('Bailongma-Setup-9.8.7.exe', 'windows-installer')
  write('Bailongma-Setup-9.8.7.exe.blockmap', zlib.gzipSync(Buffer.from(JSON.stringify({
    version: '2',
    files: [{ name: 'fixture', offset: 0, checksums: ['fixture'], sizes: [7] }],
  }))))
  const winConfig = platformConfig('win', { root, ...pkg })
  const winArtifact = { arch: 'x64', ...winConfig.collect('x64') }
  const winMetadata = createMetadata({
    platform: 'win',
    version: pkg.version,
    artifact: winArtifact,
    releaseDate: '2026-01-02T03:04:05.000Z',
  })
  assert.match(winMetadata, /path: Bailongma-Setup-9\.8\.7\.exe/)
  assert.doesNotMatch(winMetadata, /\.blockmap/)

  const blockmap = zlib.deflateRawSync(Buffer.from(JSON.stringify({
    version: '2',
    files: [{ name: 'app', offset: 0, checksums: ['fixture'], sizes: [7] }],
  })))
  const footer = Buffer.alloc(4)
  footer.writeUInt32BE(blockmap.length)
  const appImageBytes = Buffer.concat([Buffer.from('fixture-appimage'), blockmap, footer])
  const appImagePath = write('Bailongma-9.8.7-linux-x64.AppImage', appImageBytes)
  assert.equal(inspectEmbeddedBlockmap(appImagePath, appImageBytes.length), blockmap.length)
  const linuxConfig = platformConfig('linux', { root, ...pkg })
  const linuxArtifact = { arch: 'x64', ...linuxConfig.collect('x64') }
  const linuxMetadata = createMetadata({
    platform: 'linux',
    version: pkg.version,
    artifact: linuxArtifact,
    releaseDate: '2026-01-02T03:04:05.000Z',
  })
  assert.match(linuxMetadata, new RegExp(`blockMapSize: ${blockmap.length}`))
  assert.match(linuxMetadata, new RegExp(`size: ${appImageBytes.length}`))
  const expectedHash = crypto.createHash('sha512').update(appImageBytes).digest('base64')
  assert.ok(linuxMetadata.includes(expectedHash))

  await publishUpdates({
    platform: 'win',
    root,
    pkg,
    argv: ['--dry-run', '--skip-smoke'],
  })
  await publishUpdates({
    platform: 'linux',
    root,
    pkg,
    argv: ['--dry-run', '--skip-smoke'],
  })
  await assert.rejects(
    publishUpdates({ platform: 'mac', root, pkg, argv: ['--dry-run', '--skip-smoke', '--replace'] }),
    /no longer supported/,
  )
  await assert.rejects(
    publishUpdates({ platform: 'mac', root, pkg, argv: ['--dry-run', '--skip-smoke', '--host=-Fmalicious'] }),
    /Unsafe SSH host/,
  )
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}

console.log('Cross-platform update publishing tests passed')
