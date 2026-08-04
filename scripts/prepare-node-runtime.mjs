#!/usr/bin/env node

import { chmodSync, copyFileSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stagingRoot = path.join(projectRoot, 'build', 'node-runtime')
const MINIMUM_NODE = [20, 19, 0]

function parseTargets(args = process.argv.slice(2)) {
  const platform = args.find(value => value.startsWith('--platform='))?.split('=', 2)[1] || process.platform
  const requestedArchs = args
    .filter(value => value.startsWith('--arch='))
    .map(value => value.split('=', 2)[1])
  const archs = requestedArchs.length ? requestedArchs : [process.arch]
  if (!['darwin', 'win32', 'linux'].includes(platform)) throw new Error(`Node runtime packaging is not configured for ${platform}`)
  if (platform === 'win32' && archs.some(arch => arch !== 'x64')) throw new Error('Windows Node runtime packaging supports x64 only')
  if (platform === 'darwin' && archs.some(arch => !['arm64', 'x64'].includes(arch))) throw new Error('macOS Node runtime packaging supports arm64 and x64')
  if (platform === 'linux' && archs.some(arch => arch !== 'x64')) throw new Error('Linux Node runtime packaging currently supports x64 only')
  const platformKey = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : 'linux'
  return archs.map(arch => ({ platform, arch, key: `${platformKey}-${arch}` }))
}

function inspectNode(executable) {
  const result = spawnSync(executable, ['-p', 'JSON.stringify({platform:process.platform,arch:process.arch,version:process.versions.node})'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Cannot run Node runtime ${executable}: ${String(result.stderr || '').trim()}`)
  try {
    return JSON.parse(String(result.stdout || '').trim())
  } catch {
    throw new Error(`Node runtime ${executable} returned invalid version metadata`)
  }
}

// An Apple-silicon build host cannot execute a staged x64 Node binary unless
// Rosetta is installed.  Packaging still needs to validate that cached binary
// before creating an Intel app, so inspect its Mach-O architecture and its
// embedded Node release string without executing foreign code.
function inspectDarwinCrossArchNode(executable, target) {
  const expectedMachArch = target.arch === 'x64' ? 'x86_64' : target.arch
  const archResult = spawnSync('lipo', ['-archs', executable], { encoding: 'utf8' })
  if (archResult.error || archResult.status !== 0) return null
  const archs = String(archResult.stdout || '').trim().split(/\s+/)
  if (!archs.includes(expectedMachArch)) return null

  const stringsResult = spawnSync('strings', [executable], {
    encoding: 'utf8',
    // A full Node executable contains several MiB of string data; Node's
    // default 1 MiB child-process buffer would otherwise report ENOBUFS.
    maxBuffer: 32 * 1024 * 1024,
  })
  if (stringsResult.error || stringsResult.status !== 0) return null
  const versions = [...String(stringsResult.stdout || '').matchAll(/\bv(\d+\.\d+\.\d+)\b/g)]
    .map(match => match[1])
  const version = versions.find(isSupportedVersion)
  if (!version) return null
  return { platform: 'darwin', arch: target.arch, version }
}

function inspectNodeForTarget(executable, target) {
  if (target.platform === 'darwin' && process.platform === 'darwin' && target.arch !== process.arch) {
    return inspectDarwinCrossArchNode(executable, target)
  }
  return inspectNode(executable)
}

function isSupportedVersion(version = '') {
  const parts = String(version).replace(/^v/, '').split('.').map(Number)
  for (let index = 0; index < MINIMUM_NODE.length; index += 1) {
    if ((parts[index] || 0) > MINIMUM_NODE[index]) return true
    if ((parts[index] || 0) < MINIMUM_NODE[index]) return false
  }
  return true
}

function executableName(platform) {
  return platform === 'win32' ? 'node.exe' : 'node'
}

function validateRuntime(executable, target) {
  if (!existsSync(executable)) return null
  const metadata = inspectNodeForTarget(executable, target)
  if (!metadata) return null
  if (metadata.platform !== target.platform || metadata.arch !== target.arch) return null
  if (!isSupportedVersion(metadata.version)) {
    throw new Error(`Node ${metadata.version} is too old for chrome-devtools-mcp; Node >= ${MINIMUM_NODE.join('.')} is required`)
  }
  return metadata
}

function stageTarget(target) {
  const destinationDir = path.join(stagingRoot, target.key)
  const destination = path.join(destinationDir, executableName(target.platform))
  const destinationLicense = path.join(destinationDir, 'LICENSE.node.txt')
  const existing = validateRuntime(destination, target)
  if (existing && existsSync(destinationLicense)) {
    if (target.platform === 'darwin') spawnSync('xattr', ['-c', destination], { stdio: 'ignore' })
    console.log(`[node-runtime] reusing Node ${existing.version} for ${target.key}`)
    return
  }

  const archSourceKey = `BAILONGMA_NODE_RUNTIME_SOURCE_${target.arch.toUpperCase()}`
  const requestedSource = String(process.env[archSourceKey] || process.env.BAILONGMA_NODE_RUNTIME_SOURCE || '').trim()
  const source = realpathSync(requestedSource || process.execPath)
  const metadata = inspectNodeForTarget(source, target)
  if (!metadata) {
    throw new Error(`Cannot inspect Node runtime ${source} for ${target.key}`)
  }
  if (metadata.platform !== target.platform || metadata.arch !== target.arch) {
    throw new Error(
      `Cannot stage ${target.key} from ${metadata.platform}-${metadata.arch} Node. `
      + `Set ${archSourceKey} to a matching Node >= 20.19 executable.`,
    )
  }
  if (!isSupportedVersion(metadata.version)) {
    throw new Error(`Node ${metadata.version} is too old for chrome-devtools-mcp; Node >= ${MINIMUM_NODE.join('.')} is required`)
  }

  mkdirSync(destinationDir, { recursive: true })
  const temporary = `${destination}.tmp-${process.pid}`
  rmSync(temporary, { force: true })
  copyFileSync(source, temporary)
  if (target.platform !== 'win32') {
    chmodSync(temporary, 0o755)
    // Do not carry quarantine, provenance, or Finder metadata into the signed app.
    spawnSync('xattr', ['-c', temporary], { stdio: 'ignore' })
  }
  renameSync(temporary, destination)
  const sourceLicense = path.resolve(path.dirname(source), '..', 'LICENSE')
  if (existsSync(sourceLicense)) copyFileSync(sourceLicense, destinationLicense)
  const staged = validateRuntime(destination, target)
  console.log(`[node-runtime] staged Node ${staged.version} for ${target.key}`)
}

for (const target of parseTargets()) stageTarget(target)
