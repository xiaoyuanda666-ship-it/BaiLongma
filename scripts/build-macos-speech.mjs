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
    // 嵌入 Info.plist 到 __TEXT,__info_plist section。macOS TCC 要求调用麦克风/语音识别 API
    // 的可执行文件必须自带 usage description，否则进程被 SIGABRT（TCC_CRASHING_DUE_TO_PRIVACY_VIOLATION）。
    // 父 Electron app 的 Info.plist 不被子进程继承，独立二进制必须自带。
    '-Xlinker', '-sectcreate',
    '-Xlinker', '__TEXT',
    '-Xlinker', '__info_plist',
    '-Xlinker', path.join(root, 'src', 'voice', 'native-speech-recognizer.Info.plist'),
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

// 包装成 .app bundle。macOS 26 TCC 只认 .app bundle 的 Info.plist，
// 不认裸 Mach-O 的 __TEXT,__info_plist——裸二进制调用 Speech/麦克风 API 会被 SIGABRT。
// bundle 让可执行文件获得独立的 TCC 身份（CFBundleIdentifier）和 usage description。
const plistSource = path.join(root, 'src', 'voice', 'native-speech-recognizer.Info.plist')
const bundleDir = path.join(path.dirname(output), 'native-speech-recognizer.app')
const bundleMacOS = path.join(bundleDir, 'Contents', 'MacOS')
fs.rmSync(bundleDir, { recursive: true, force: true })
fs.mkdirSync(bundleMacOS, { recursive: true })
fs.copyFileSync(output, path.join(bundleMacOS, path.basename(output)))
fs.copyFileSync(plistSource, path.join(bundleDir, 'Contents', 'Info.plist'))
fs.chmodSync(path.join(bundleMacOS, path.basename(output)), 0o755)
const sign = spawnSync('codesign', ['--force', '--sign', '-', bundleDir], { stdio: 'pipe' })
if (sign.status !== 0) {
  stop(`[macos-speech] codesign of app bundle failed: ${sign.stderr?.toString().trim() || 'unknown error'}`)
}
console.log(`[macos-speech] bundled into ${bundleDir}`)
