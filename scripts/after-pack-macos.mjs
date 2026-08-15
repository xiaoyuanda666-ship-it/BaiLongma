import fs from 'node:fs'
import path from 'node:path'
import { Arch } from 'builder-util'
import { assertSingleArchitecture, listMachOFiles } from './macos-signing-lib.mjs'
import { writeMacUpdaterConfig } from './macos-updater-config.mjs'

const DARWIN_PACKAGES = [
  ['@img', 'sharp-darwin-arm64'],
  ['@img', 'sharp-darwin-x64'],
  ['@img', 'sharp-libvips-darwin-arm64'],
  ['@img', 'sharp-libvips-darwin-x64'],
  ['sherpa-onnx-darwin-arm64'],
  ['sherpa-onnx-darwin-x64'],
]

function removeWrongArchitecture(unpackedNodeModules, arch) {
  const other = arch === 'arm64' ? 'x64' : 'arm64'
  for (const segments of DARWIN_PACKAGES.filter(parts => parts.at(-1).endsWith(`-${other}`))) {
    fs.rmSync(path.join(unpackedNodeModules, ...segments), { recursive: true, force: true })
  }
  const onnxRoot = path.join(unpackedNodeModules, 'onnxruntime-node', 'bin', 'napi-v3')
  for (const platform of ['linux', 'win32']) fs.rmSync(path.join(onnxRoot, platform), { recursive: true, force: true })
  fs.rmSync(path.join(onnxRoot, 'darwin', other), { recursive: true, force: true })
}

export default async function afterPackMac(context) {
  if (context.electronPlatformName !== 'darwin') return
  const arch = Arch[context.arch]
  if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported macOS package architecture: ${arch}`)
  const expectedMachArch = arch === 'x64' ? 'x86_64' : 'arm64'
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const updaterConfigPath = writeMacUpdaterConfig({
    appPath,
    arch,
    publish: context.packager.config.publish,
    updaterCacheDirName: context.packager.appInfo.updaterCacheDirName,
  })
  const unpackedNodeModules = path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules')
  removeWrongArchitecture(unpackedNodeModules, arch)
  const code = listMachOFiles(appPath)
  for (const filePath of code) assertSingleArchitecture(filePath, expectedMachArch)
  console.log(`[after-pack:mac] wrote ${arch} updater config before signing: ${updaterConfigPath}`)
  console.log(`[after-pack:mac] ${arch} architecture audit passed for ${code.length} Mach-O files`)
}
