import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const source = path.join(root, 'src', 'voice', 'macos-speech.swift')
const output = path.join(root, 'build', 'native-speech-recognizer')
const rawArgs = process.argv.slice(2)
const required = rawArgs.includes('--required')
const archArgs = rawArgs.filter((arg) => !arg.startsWith('--'))
const flagArgs = rawArgs.filter((arg) => arg.startsWith('--') && arg !== '--required')
const supportedArchs = new Set(['x64', 'arm64', 'universal'])
const hostArch = process.arch === 'arm64' ? 'arm64' : 'x64'
const arch = archArgs[0] || hostArch
const deploymentTarget = process.env.MACOSX_DEPLOYMENT_TARGET || '10.15'

const swiftTargets = {
  x64: `x86_64-apple-macos${deploymentTarget}`,
  arm64: `arm64-apple-macos${deploymentTarget}`,
}

function stop(message) {
  if (required) {
    console.error(message)
    process.exit(1)
  }
  console.warn(message)
  process.exit(0)
}

if (process.platform !== 'darwin') {
  stop('[macos-speech] cannot build native speech helper on non-macOS')
}

if (!fs.existsSync(source)) {
  stop(`[macos-speech] source not found: ${source}`)
}

if (archArgs.length > 1) {
  stop(`[macos-speech] expected one architecture, got: ${archArgs.join(', ')}`)
}

if (flagArgs.length > 0) {
  stop(`[macos-speech] unsupported option: ${flagArgs.join(', ')}`)
}

if (!supportedArchs.has(arch)) {
  stop(`[macos-speech] unsupported architecture: ${arch}`)
}

fs.mkdirSync(path.dirname(output), { recursive: true })

function compileArch(targetArch, targetOutput) {
  const target = swiftTargets[targetArch]
  console.log(`[macos-speech] compiling ${targetArch} (${target})`)
  const result = spawnSync('xcrun', [
    '--sdk', 'macosx',
    'swiftc',
    source,
    '-target', target,
    '-framework', 'Speech',
    '-framework', 'AVFoundation',
    '-o', targetOutput,
  ], {
    stdio: 'inherit',
    env: {
      ...process.env,
      MACOSX_DEPLOYMENT_TARGET: deploymentTarget,
    },
  })

  if (result.error) {
    stop(`[macos-speech] swiftc failed for ${targetArch}: ${result.error.message}`)
  }

  if (result.status !== 0) {
    stop(`[macos-speech] swiftc failed for ${targetArch}`)
  }
}

fs.rmSync(output, { force: true })

if (arch === 'universal') {
  const tmpDir = path.join(root, 'build', 'macos-speech')
  const arm64Output = path.join(tmpDir, 'native-speech-recognizer-arm64')
  const x64Output = path.join(tmpDir, 'native-speech-recognizer-x64')
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.mkdirSync(tmpDir, { recursive: true })
  compileArch('arm64', arm64Output)
  compileArch('x64', x64Output)

  const lipo = spawnSync('lipo', [
    '-create',
    arm64Output,
    x64Output,
    '-output',
    output,
  ], { stdio: 'inherit' })

  if (lipo.error) {
    stop(`[macos-speech] lipo failed: ${lipo.error.message}`)
  }

  if (lipo.status !== 0) {
    stop('[macos-speech] lipo failed')
  }

  fs.rmSync(tmpDir, { recursive: true, force: true })
} else {
  compileArch(arch, output)
}

fs.chmodSync(output, 0o755)
console.log(`[macos-speech] built ${arch} helper at ${output}`)
