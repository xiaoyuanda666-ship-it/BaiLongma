#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function validateLinuxBuildHost({ platform = process.platform, arch = process.arch } = {}) {
  if (platform !== 'linux') {
    throw new Error('Linux packages must be built on Linux so native dependencies and AppImage contents match the target OS.')
  }
  if (arch !== 'x64') {
    throw new Error(`Linux packaging currently targets x64, but the build Node is ${arch}. Use an x64 Linux build host.`)
  }
}

export function elfMachineFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 20) return null
  if (!buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return null
  const encoding = buffer[5]
  if (encoding === 1) return buffer.readUInt16LE(18)
  if (encoding === 2) return buffer.readUInt16BE(18)
  return null
}

export function assertElfX64(filePath, label = path.basename(filePath)) {
  if (!fs.existsSync(filePath)) throw new Error(`${label} is missing: ${filePath}`)
  const fd = fs.openSync(filePath, 'r')
  const header = Buffer.alloc(64)
  let bytesRead
  try {
    bytesRead = fs.readSync(fd, header, 0, header.length, 0)
  } finally {
    fs.closeSync(fd)
  }
  const machine = elfMachineFromBuffer(header.subarray(0, bytesRead))
  if (machine !== 0x3e) {
    const actual = machine === null ? 'not an ELF executable' : `ELF machine 0x${machine.toString(16)}`
    throw new Error(`${label} must be Linux x64 (${actual}): ${filePath}`)
  }
  return filePath
}

function walkFiles(root, accept, out = []) {
  if (!fs.existsSync(root)) return out
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name)
    if (entry.isDirectory()) walkFiles(child, accept, out)
    else if (entry.isFile() && accept(child)) out.push(child)
  }
  return out
}

function requireDirectory(resolved, label) {
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`${label} is missing. Run npm ci on an x64 Linux host before building: ${resolved}`)
  }
  return resolved
}

export function validateLinuxNativeDependencies(root = projectRoot) {
  const sharpRoot = requireDirectory(path.join(root, 'node_modules', '@img', 'sharp-linux-x64'), 'sharp-linux-x64')
  const sherpaRoot = requireDirectory(path.join(root, 'node_modules', 'sherpa-onnx-linux-x64'), 'sherpa-onnx-linux-x64')
  const onnxBinding = path.join(
    root,
    'node_modules',
    'onnxruntime-node',
    'bin',
    'napi-v3',
    'linux',
    'x64',
    'onnxruntime_binding.node',
  )
  assertElfX64(onnxBinding, 'ONNX Runtime Linux binding')

  const sharpBindings = walkFiles(sharpRoot, file => file.endsWith('.node'))
  const sherpaBindings = walkFiles(sherpaRoot, file => file.endsWith('.node'))
  if (sharpBindings.length === 0) throw new Error(`sharp-linux-x64 contains no native .node binding: ${sharpRoot}`)
  if (sherpaBindings.length === 0) throw new Error(`sherpa-onnx-linux-x64 contains no native .node binding: ${sherpaRoot}`)
  for (const file of sharpBindings) assertElfX64(file, 'sharp Linux binding')
  for (const file of sherpaBindings) assertElfX64(file, 'sherpa-onnx Linux binding')
  return { sharpBindings, sherpaBindings, onnxBinding }
}

function run(command, args) {
  console.log(`[build:linux] ${path.basename(command)} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: false,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`)
}

function packageMetadata() {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
  const electronVersion = String(pkg.devDependencies?.electron || '').trim()
  if (!/^\d+\.\d+\.\d+$/.test(electronVersion)) throw new Error('devDependencies.electron must be pinned to an exact version')
  const targetArchs = pkg.build?.linux?.target?.flatMap(target => target.arch || []) || []
  if (targetArchs.length !== 1 || targetArchs[0] !== 'x64') {
    throw new Error('build.linux.target must contain exactly the x64 architecture')
  }
  return { pkg, electronVersion }
}

function main() {
  validateLinuxBuildHost()
  const { pkg, electronVersion } = packageMetadata()

  run(process.execPath, ['scripts/check-native-dependency-versions.mjs'])
  run(process.execPath, ['scripts/prebuild-clean.mjs'])
  validateLinuxNativeDependencies()
  run(process.execPath, ['scripts/prepare-playwright-browsers.mjs', '--platform=linux', '--arch=x64'])
  run(process.execPath, ['scripts/prepare-node-runtime.mjs', '--platform=linux', '--arch=x64'])
  run(process.execPath, [
    './node_modules/@electron/rebuild/lib/cli.js',
    '-f', '-w', 'better-sqlite3', '-v', electronVersion, '-a', 'x64',
  ])
  assertElfX64(
    path.join(projectRoot, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
    'rebuilt better-sqlite3 binding',
  )

  run(process.execPath, ['./node_modules/electron-builder/cli.js', '--linux', 'AppImage', '--x64'])
  const appImage = path.join(projectRoot, 'dist', `${pkg.productName}-${pkg.version}-linux-x64.AppImage`)
  if (!fs.existsSync(appImage) || fs.statSync(appImage).size === 0) {
    throw new Error(`AppImage is missing or empty: ${appImage}`)
  }
  assertElfX64(path.join(projectRoot, 'dist', 'linux-unpacked', pkg.name), 'packaged Bailongma executable')
  run(process.execPath, ['scripts/smoke-linux-artifacts.mjs'])
  run(process.execPath, ['scripts/smoke-packaged-playwright.mjs'])
  console.log(`[build:linux] Bailongma ${pkg.version} Linux x64 build and smoke checks complete`)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try { main() } catch (error) {
    console.error(`[build:linux] ${error?.message || error}`)
    process.exit(1)
  }
}
