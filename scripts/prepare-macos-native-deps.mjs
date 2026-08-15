#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const requested = process.argv.slice(2)
const archs = requested.length ? requested : ['x64', 'arm64']
if (archs.some(arch => !['x64', 'arm64'].includes(arch))) throw new Error(`Unsupported macOS architecture: ${archs.join(', ')}`)

const packages = {
  x64: [
    '@img/sharp-darwin-x64@0.34.5',
    '@img/sharp-libvips-darwin-x64@1.2.4',
    'sherpa-onnx-darwin-x64@1.13.4',
  ],
  arm64: [
    '@img/sharp-darwin-arm64@0.34.5',
    '@img/sharp-libvips-darwin-arm64@1.2.4',
    'sherpa-onnx-darwin-arm64@1.13.4',
  ],
}

function packagePath(specifier) {
  const name = specifier.startsWith('@') ? specifier.slice(0, specifier.lastIndexOf('@')) : specifier.slice(0, specifier.indexOf('@'))
  return path.join(root, 'node_modules', ...name.split('/'), 'package.json')
}

const missing = [...new Set(archs.flatMap(arch => packages[arch]).filter(specifier => !fs.existsSync(packagePath(specifier))))]
if (missing.length) {
  console.log(`[native-deps:mac] installing missing optional packages: ${missing.join(', ')}`)
  const result = spawnSync('npm', [
    'install', '--no-save', '--package-lock=false', '--ignore-scripts', '--include=optional', '--force', ...missing,
  ], { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`npm install failed with exit ${result.status}`)
}

for (const arch of archs) {
  for (const specifier of packages[arch]) {
    if (!fs.existsSync(packagePath(specifier))) throw new Error(`Required ${arch} native package is missing after preparation: ${specifier}`)
  }
}
console.log(`[native-deps:mac] native packages ready for ${archs.join(' + ')}`)
