#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function validateWindowsBuildHost({ platform = process.platform, arch = process.arch } = {}) {
  if (platform !== 'win32') {
    throw new Error('Windows packages must be built on Windows. Cross-building would package host-native optional dependencies and an invalid better-sqlite3 binding.')
  }
  if (arch !== 'x64') {
    throw new Error(`Windows packaging currently targets x64, but the build Node is ${arch}. Run the build from an x64 Node process (Windows ARM64 may use x64 emulation).`)
  }
}

export function peMachineFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 0x40 || buffer.toString('ascii', 0, 2) !== 'MZ') return null
  const peOffset = buffer.readUInt32LE(0x3c)
  if (peOffset < 0 || peOffset + 6 > buffer.length) return null
  if (buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') return null
  return buffer.readUInt16LE(peOffset + 4)
}

export function assertPeX64(filePath, label = path.basename(filePath)) {
  if (!fs.existsSync(filePath)) throw new Error(`${label} is missing: ${filePath}`)
  const machine = peMachineFromBuffer(fs.readFileSync(filePath))
  if (machine !== 0x8664) {
    const actual = machine === null ? 'not a PE executable' : `PE machine 0x${machine.toString(16)}`
    throw new Error(`${label} must be Windows x64 (${actual}): ${filePath}`)
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
    throw new Error(`${label} is missing. Run npm ci from an x64 Windows terminal before building: ${resolved}`)
  }
  return resolved
}

export function validateWindowsNativeDependencies(root = projectRoot) {
  const sharpRoot = requireDirectory(path.join(root, 'node_modules', '@img', 'sharp-win32-x64'), 'sharp-win32-x64')
  const sherpaRoot = requireDirectory(path.join(root, 'node_modules', 'sherpa-onnx-win-x64'), 'sherpa-onnx-win-x64')
  const onnxBinding = path.join(root, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3', 'win32', 'x64', 'onnxruntime_binding.node')
  assertPeX64(onnxBinding, 'onnxruntime Windows binding')

  const sharpBindings = walkFiles(sharpRoot, file => file.toLowerCase().endsWith('.node'))
  const sherpaBindings = walkFiles(sherpaRoot, file => file.toLowerCase().endsWith('.node'))
  if (sharpBindings.length === 0) throw new Error(`sharp-win32-x64 contains no native .node binding: ${sharpRoot}`)
  if (sherpaBindings.length === 0) throw new Error(`sherpa-onnx-win-x64 contains no native .node binding: ${sherpaRoot}`)
  for (const file of sharpBindings) assertPeX64(file, 'sharp Windows binding')
  for (const file of sherpaBindings) assertPeX64(file, 'sherpa-onnx Windows binding')
  return { sharpBindings, sherpaBindings, onnxBinding }
}

function run(command, args, options = {}) {
  console.log(`[build:win] ${path.basename(command)} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    windowsHide: true,
    shell: false,
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`)
}

function packageMetadata() {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
  const electronVersion = String(pkg.devDependencies?.electron || '').trim()
  if (!/^\d+\.\d+\.\d+$/.test(electronVersion)) throw new Error('devDependencies.electron must be pinned to an exact version')
  const targetArchs = pkg.build?.win?.target?.flatMap(target => target.arch || []) || []
  if (targetArchs.length !== 1 || targetArchs[0] !== 'x64') throw new Error('build.win.target must contain exactly the x64 architecture')
  return { pkg, electronVersion }
}

function installerPath(version) {
  return path.join(projectRoot, 'dist', `Bailongma-Setup-${version}.exe`)
}

export function inspectWindowsSignature(filePath) {
  const script = [
    '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding;',
    '$s=Get-AuthenticodeSignature -LiteralPath $env:BAILONGMA_WINDOWS_ARTIFACT;',
    '[PSCustomObject]@{Status=[string]$s.Status;StatusMessage=$s.StatusMessage;Subject=$s.SignerCertificate.Subject}|ConvertTo-Json -Compress',
  ].join('')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, BAILONGMA_WINDOWS_ARTIFACT: filePath },
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Get-AuthenticodeSignature failed: ${String(result.stderr || '').trim()}`)
  try { return JSON.parse(String(result.stdout || '').trim()) } catch {
    throw new Error(`Get-AuthenticodeSignature returned invalid JSON: ${String(result.stdout || '').trim()}`)
  }
}

export function signingIsRequired(args = process.argv.slice(2), env = process.env) {
  return args.includes('--require-signing') || /^(1|true|yes)$/i.test(String(env.BAILONGMA_REQUIRE_WINDOWS_SIGNING || ''))
}

function main() {
  validateWindowsBuildHost()
  const { pkg, electronVersion } = packageMetadata()
  const requireSigning = signingIsRequired()

  run(process.execPath, ['scripts/prebuild-clean.mjs'])
  validateWindowsNativeDependencies()
  run(process.execPath, ['scripts/prepare-playwright-browsers.mjs', '--platform=win32', '--arch=x64'])
  run(process.execPath, ['scripts/prepare-node-runtime.mjs', '--platform=win32', '--arch=x64'])
  run(process.execPath, [
    './node_modules/@electron/rebuild/lib/cli.js',
    '-f', '-w', 'better-sqlite3', '-v', electronVersion, '-a', 'x64',
  ])

  assertPeX64(
    path.join(projectRoot, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
    'rebuilt better-sqlite3 binding',
  )
  run(process.execPath, ['./node_modules/electron-builder/cli.js', '--win', 'nsis', '--x64'])

  const installer = installerPath(pkg.version)
  if (!fs.existsSync(installer) || fs.statSync(installer).size === 0) {
    throw new Error(`NSIS installer is missing or empty: ${installer}`)
  }
  // NSIS commonly uses a 32-bit bootstrap executable even when its payload is
  // a Windows x64 application. Validate dist/win-unpacked/Bailongma.exe, not
  // the installer stub, as the authoritative application architecture.
  assertPeX64(path.join(projectRoot, 'dist', 'win-unpacked', 'Bailongma.exe'), 'packaged Bailongma executable')
  const signature = inspectWindowsSignature(installer)
  if (String(signature.Status).toLowerCase() !== 'valid') {
    const message = `Windows installer signature is ${signature.Status || 'unknown'}: ${signature.StatusMessage || 'no details'}`
    if (requireSigning) throw new Error(message)
    console.warn(`[build:win] WARNING: ${message}. Use npm run build:win:release for a signed release gate.`)
  } else {
    console.log(`[build:win] installer signature valid: ${signature.Subject || 'subject unavailable'}`)
  }

  run(process.execPath, ['scripts/smoke-win-artifacts.mjs'])
  run(process.execPath, ['scripts/smoke-packaged-playwright.mjs'])
  console.log(`[build:win] Bailongma ${pkg.version} Windows x64 build and smoke checks complete`)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try { main() } catch (error) {
    console.error(`[build:win] ${error?.message || error}`)
    process.exit(1)
  }
}
