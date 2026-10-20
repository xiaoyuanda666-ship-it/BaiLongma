#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { platformConfig, validateReleaseIdentity } from './publish-updates-lib.mjs'

const SUPPORTED_ARCHS = ['x64', 'arm64']

function readFinalArtifacts({ root, productName, version, arch }) {
  validateReleaseIdentity(productName, version)
  if (arch !== undefined && !SUPPORTED_ARCHS.includes(arch)) {
    throw new Error(`Unsupported macOS metadata architecture: ${arch}`)
  }
  const manifestPath = path.join(root, 'dist', 'latest-mac.yml')
  const metadata = yaml.load(fs.readFileSync(manifestPath, 'utf8'))
  if (!metadata || typeof metadata !== 'object' || metadata.version !== version) {
    throw new Error(`latest-mac.yml must describe version ${version}`)
  }
  const manifestArch = SUPPORTED_ARCHS.find(candidate => (
    metadata.path === `${productName}-${version}-mac-${candidate}.zip`
  ))
  if (!manifestArch || (arch !== undefined && arch !== manifestArch)) {
    throw new Error(`latest-mac.yml does not describe the expected ${arch || 'macOS'} architecture`)
  }
  const prefix = `${productName}-${version}-mac-${manifestArch}`
  const expectedNames = [`${prefix}.zip`, `${prefix}.dmg`]
  const names = Array.isArray(metadata.files) ? metadata.files.map(file => file?.url) : []
  if (names.length !== expectedNames.length || new Set(names).size !== expectedNames.length
    || names.some(name => !expectedNames.includes(name))) {
    throw new Error('latest-mac.yml must reference exactly the current architecture ZIP and DMG')
  }
  // Collect verifies the final external blockmaps and hashes the actual files.
  const artifact = platformConfig('mac', { root, productName, version }).collect(manifestArch)
  return { manifestPath, metadata, artifact, arch: manifestArch }
}

export function assertFinalMacUpdateMetadata(options) {
  const result = readFinalArtifacts(options)
  for (const file of result.artifact.metadataFiles) {
    const entry = result.metadata.files.find(item => item.url === file.remoteName)
    if (entry.size !== file.size) {
      throw new Error(`latest-mac.yml size mismatch for ${file.remoteName}: ${entry.size} != ${file.size}`)
    }
    if (entry.sha512 !== file.hash.base64) {
      throw new Error(`latest-mac.yml SHA-512 mismatch for ${file.remoteName}`)
    }
  }
  if (result.metadata.sha512 !== result.artifact.primary.hash.base64) {
    throw new Error('latest-mac.yml legacy SHA-512 does not match the final ZIP')
  }
  if (Object.hasOwn(result.metadata, 'size') && result.metadata.size !== result.artifact.primary.size) {
    throw new Error('latest-mac.yml legacy size does not match the final ZIP')
  }
  return result
}

export function refreshMacUpdateMetadata(options) {
  const result = readFinalArtifacts(options)
  for (const entry of result.metadata.files) {
    const file = result.artifact.metadataFiles.find(item => item.remoteName === entry.url)
    entry.size = file.size
    entry.sha512 = file.hash.base64
  }
  result.metadata.sha512 = result.artifact.primary.hash.base64
  if (Object.hasOwn(result.metadata, 'size')) result.metadata.size = result.artifact.primary.size
  const temporary = `${result.manifestPath}.${process.pid}.tmp`
  try {
    fs.writeFileSync(temporary, yaml.dump(result.metadata, { lineWidth: -1, noRefs: true }), {
      flag: 'wx',
      mode: 0o644,
    })
    fs.renameSync(temporary, result.manifestPath)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [arch, ...extra] = process.argv.slice(2)
  if (!SUPPORTED_ARCHS.includes(arch) || extra.length > 0) {
    throw new Error('Usage: refresh-macos-update-metadata.mjs <x64|arm64>')
  }
  const root = path.resolve(import.meta.dirname, '..')
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const { manifestPath } = refreshMacUpdateMetadata({
    root, productName: pkg.productName || 'Bailongma', version: pkg.version, arch,
  })
  console.log(`[metadata:mac] refreshed ${arch} final artifact sizes and SHA-512: ${manifestPath}`)
}
