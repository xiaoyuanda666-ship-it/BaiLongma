import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createMetadata, inspectExternalBlockmap, verifyExternalBlockmapForArtifact } from '../../scripts/publish-updates-lib.mjs'
import {
  ALLOWED_ARCHS,
  compareReleaseVersions,
  parseReleaseVersion,
  redactLog,
  resolveDistArtifact,
} from './core.mjs'

export const RELEASE_CONSTANTS = Object.freeze({
  sshHost: 'xiaobailong-update-hk',
  origin: 'https://updates.bailongma.ai',
  downloadOrigin: 'https://download.bailongma.ai',
  bucket: 'bailongma-updates-hk-prod',
  serverRoot: '/srv/bailongma-updates',
  updaterHeader: 'BailongmaUpdater/2',
  channel: 'stable',
})

const SHA_CACHE = new Map()

export function expectedMacArtifactNames(productName, version, archs = ALLOWED_ARCHS) {
  return archs.flatMap(arch => {
    const prefix = `${productName}-${version}-mac-${arch}`
    return [`${prefix}.dmg`, `${prefix}.dmg.blockmap`, `${prefix}.zip`, `${prefix}.zip.blockmap`]
  })
}

export function runProcess(command, args, {
  cwd,
  input,
  timeoutMs = 120_000,
  onLine = () => {},
  allowFailure = false,
  env,
} = {}) {
  if (!Array.isArray(args)) throw new Error('Subprocess arguments must be an array')
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: env || process.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const consume = (kind, chunk) => {
      const text = chunk.toString('utf8')
      if (kind === 'stdout') stdout += text
      else stderr += text
      for (const line of text.split(/\r?\n/).filter(Boolean)) onLine(redactLog(line), kind)
    }
    child.stdout.on('data', chunk => consume('stdout', chunk))
    child.stderr.on('data', chunk => consume('stderr', chunk))
    child.once('error', error => {
      settled = true
      reject(new Error(`${command} failed: ${redactLog(error.message)}`))
    })
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const result = { code: code ?? -1, signal, stdout: stdout.trim(), stderr: stderr.trim() }
      if (result.code !== 0 && !allowFailure) {
        reject(new Error(`${command} exited with ${result.code}: ${redactLog(result.stderr || result.stdout || signal || 'unknown error')}`))
      } else resolve(result)
    })
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    if (input == null) child.stdin.end()
    else child.stdin.end(input)
  })
}

async function sha512File(filePath, stat) {
  const key = `${filePath}:${stat.size}:${stat.mtimeMs}`
  if (SHA_CACHE.has(key)) return SHA_CACHE.get(key)
  const hash = crypto.createHash('sha512')
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', resolve)
  })
  const digest = hash.digest()
  const value = { hex: digest.toString('hex'), base64: digest.toString('base64') }
  SHA_CACHE.set(key, value)
  return value
}

export async function scanMacArtifacts({ root, productName, version, archs = ALLOWED_ARCHS }) {
  parseReleaseVersion(version)
  const distDir = path.join(root, 'dist')
  const allowedNames = expectedMacArtifactNames(productName, version, archs)
  const records = []
  for (const arch of archs) {
    for (const extension of ['dmg', 'dmg.blockmap', 'zip', 'zip.blockmap']) {
      const name = `${productName}-${version}-mac-${arch}.${extension}`
      const filePath = resolveDistArtifact(distDir, name, allowedNames)
      try {
        const stat = await fsp.stat(filePath)
        if (!stat.isFile() || stat.size === 0) throw new Error('empty')
        const hash = await sha512File(filePath, stat)
        records.push({ arch, kind: extension, name, filePath, exists: true, size: stat.size, sha512: hash.hex, sha512Base64: hash.base64, mtime: stat.mtime.toISOString() })
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.message !== 'empty') throw error
        records.push({ arch, kind: extension, name, filePath, exists: false, size: 0, sha512: null, sha512Base64: null, mtime: null })
      }
    }
  }
  return { distDir, records, complete: records.every(record => record.exists), totalBytes: records.reduce((sum, record) => sum + record.size, 0) }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function getRemoteVersion(arch, { accelerated = false } = {}) {
  const response = await fetchWithTimeout(
    `${RELEASE_CONSTANTS.origin}/stable/mac/${arch}/latest-mac.yml`,
    accelerated ? { headers: { 'X-Bailongma-Updater': RELEASE_CONSTANTS.updaterHeader } } : {},
  )
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const text = await response.text()
  const version = text.match(/^version:\s*['"]?([^'"\s]+)['"]?/m)?.[1]
  return version ? parseReleaseVersion(version).text : null
}

async function probe(name, fn) {
  const startedAt = Date.now()
  try {
    const detail = await fn()
    return { name, ok: true, latencyMs: Date.now() - startedAt, detail }
  } catch (error) {
    return { name, ok: false, latencyMs: Date.now() - startedAt, error: redactLog(error.message) }
  }
}

export async function readGitState(root) {
  const [branch, commit, status] = await Promise.all([
    runProcess('git', ['branch', '--show-current'], { cwd: root }),
    runProcess('git', ['rev-parse', 'HEAD'], { cwd: root }),
    runProcess('git', ['status', '--porcelain'], { cwd: root }),
  ])
  return { branch: branch.stdout || '(detached)', commit: commit.stdout, dirty: Boolean(status.stdout), changedFiles: status.stdout ? status.stdout.split('\n').length : 0 }
}

export async function getSystemStatus({ root, version }) {
  const [git, ssh, health, gateway, downloadHttps, ...remote] = await Promise.all([
    readGitState(root),
    probe('ssh', async () => {
      await runProcess('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', RELEASE_CONSTANTS.sshHost, 'true'], { cwd: root, timeoutMs: 15_000 })
      return 'reachable'
    }),
    probe('hong-kong-health', async () => {
      const response = await fetchWithTimeout(`${RELEASE_CONSTANTS.origin}/healthz`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return 'healthy'
    }),
    probe('oss-gateway', async () => {
      const failures = []
      for (const arch of ALLOWED_ARCHS) {
        try {
          const remoteVersion = await getRemoteVersion(arch, { accelerated: true })
          if (remoteVersion) return `${arch} redirect and read succeeded`
        } catch (error) {
          failures.push(`${arch}: ${error.message}`)
        }
      }
      throw new Error(failures.join('; ') || 'No readable manifest through gateway')
    }),
    probe('download-https', async () => {
      const response = await fetchWithTimeout(RELEASE_CONSTANTS.downloadOrigin, { method: 'HEAD', redirect: 'manual' })
      await response.body?.cancel()
      return `TLS/HTTP ${response.status}`
    }),
    ...ALLOWED_ARCHS.map(arch => probe(`remote-${arch}`, () => getRemoteVersion(arch))),
  ])
  const remoteVersions = Object.fromEntries(ALLOWED_ARCHS.map((arch, index) => [arch, remote[index].ok && remote[index].detail ? remote[index].detail : null]))
  const remoteVersionStates = Object.fromEntries(ALLOWED_ARCHS.map((arch, index) => {
    const result = remote[index]
    if (result.ok && result.detail) return [arch, 'present']
    if (!result.ok && /^HTTP 404$/i.test(result.error || '')) return [arch, 'absent']
    return [arch, 'unavailable']
  }))
  return { git, version, probes: [ssh, health, gateway, downloadHttps], remoteVersions, remoteVersionStates, remoteProbes: remote }
}

async function runCheck(command, args, options = {}) {
  const result = await runProcess(command, args, { ...options, allowFailure: true })
  return { ok: result.code === 0, output: redactLog([result.stdout, result.stderr].filter(Boolean).join('\n')).slice(0, 12_000), code: result.code }
}

async function extractZipPlist(zipPath, productName, tempDir, root) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn('unzip', ['-p', zipPath, `${productName}.app/Contents/Info.plist`], { cwd: root, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []
    let stderr = ''
    child.stdout.on('data', chunk => chunks.push(chunk))
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
    child.once('error', reject)
    child.once('close', code => code === 0 && chunks.length ? resolve(Buffer.concat(chunks)) : reject(new Error(`unzip plist failed: ${stderr}`)))
  })
  const plistPath = path.join(tempDir, 'zip-Info.plist')
  await fsp.writeFile(plistPath, result, { mode: 0o600 })
  return plistPath
}

async function checkArchitecture({ root, productName, version, arch, scan }) {
  const byKind = Object.fromEntries(scan.records.filter(record => record.arch === arch).map(record => [record.kind, record]))
  const result = {
    arch,
    complete: ['dmg', 'dmg.blockmap', 'zip', 'zip.blockmap'].every(kind => byKind[kind]?.exists),
    versionMatch: false,
    cpuArchitecture: { ok: false, actual: null, expected: arch === 'x64' ? 'x86_64' : 'arm64' },
    codesign: { ok: false },
    developerTeam: null,
    hardenedRuntime: false,
    entitlements: { ok: false, required: ['com.apple.security.device.audio-input', 'com.apple.security.automation.apple-events'] },
    notarization: { ok: false },
    stapler: { ok: false },
    gatekeeper: { ok: false },
    hashes: Object.fromEntries(Object.entries(byKind).map(([kind, record]) => [kind, record.sha512])),
    blockmaps: { ok: Boolean(byKind['dmg.blockmap']?.exists && byKind['zip.blockmap']?.exists) },
    errors: [],
  }
  if (!result.complete) {
    result.errors.push('Required artifacts are incomplete')
    return result
  }
  try {
    verifyExternalBlockmapForArtifact(byKind['dmg.blockmap'].filePath, byKind.dmg.filePath)
    verifyExternalBlockmapForArtifact(byKind['zip.blockmap'].filePath, byKind.zip.filePath)
  } catch (error) {
    result.blockmaps = { ok: false, error: redactLog(error.message) }
  }

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), `bailongma-release-${arch}-`))
  const mountPoint = path.join(tempDir, 'mount')
  await fsp.mkdir(mountPoint)
  let mounted = false
  try {
    const attach = await runCheck('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, byKind.dmg.filePath], { cwd: root, timeoutMs: 180_000 })
    if (!attach.ok) throw new Error(`DMG mount failed: ${attach.output}`)
    mounted = true
    const appPath = path.join(mountPoint, `${productName}.app`)
    const plistPath = path.join(appPath, 'Contents', 'Info.plist')
    const executablePath = path.join(appPath, 'Contents', 'MacOS', productName)
    const zipPlistPath = await extractZipPlist(byKind.zip.filePath, productName, tempDir, root)
    const [dmgVersion, zipVersion, archCheck, codeCheck, signing, entitlements, stapler, gatekeeperApp, gatekeeperDmg] = await Promise.all([
      runCheck('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plistPath], { cwd: root }),
      runCheck('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', zipPlistPath], { cwd: root }),
      runCheck('lipo', ['-archs', executablePath], { cwd: root }),
      runCheck('codesign', ['--verify', '--deep', '--strict', '--verbose=4', appPath], { cwd: root, timeoutMs: 180_000 }),
      runCheck('codesign', ['--display', '--verbose=4', appPath], { cwd: root }),
      runCheck('codesign', ['--display', '--entitlements', ':-', appPath], { cwd: root }),
      runCheck('xcrun', ['stapler', 'validate', '-v', byKind.dmg.filePath], { cwd: root, timeoutMs: 180_000 }),
      runCheck('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath], { cwd: root, timeoutMs: 180_000 }),
      runCheck('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', byKind.dmg.filePath], { cwd: root, timeoutMs: 180_000 }),
    ])
    result.versionMatch = dmgVersion.ok && zipVersion.ok && dmgVersion.output.trim() === version && zipVersion.output.trim() === version
    result.cpuArchitecture = { ok: archCheck.ok && archCheck.output.trim() === result.cpuArchitecture.expected, actual: archCheck.output.trim() || null, expected: result.cpuArchitecture.expected }
    result.codesign = { ok: codeCheck.ok, detail: codeCheck.output }
    const signingText = signing.output || ''
    result.developerTeam = signingText.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() || null
    result.hardenedRuntime = /flags=.*\bruntime\b/i.test(signingText)
    const entitlementText = entitlements.output || ''
    result.entitlements = {
      ok: entitlements.ok && result.entitlements.required.every(key => new RegExp(`<key>${key.replaceAll('.', '\\.')}<\/key>\\s*<true\s*\/>`).test(entitlementText)),
      required: result.entitlements.required,
    }
    result.stapler = { ok: stapler.ok, detail: stapler.output }
    result.notarization = { ok: stapler.ok && /worked|valid|ticket/i.test(stapler.output), detail: stapler.output }
    result.gatekeeper = { ok: gatekeeperApp.ok && gatekeeperDmg.ok, app: gatekeeperApp.output, dmg: gatekeeperDmg.output }
  } catch (error) {
    result.errors.push(redactLog(error.message))
  } finally {
    if (mounted) await runCheck('hdiutil', ['detach', mountPoint, '-quiet'], { cwd: root, timeoutMs: 60_000 })
    await fsp.rm(tempDir, { recursive: true, force: true })
  }
  return result
}

export function stableGatePassed(check) {
  return Boolean(
    check.complete
    && check.versionMatch
    && check.localVersionHigher
    && check.cpuArchitecture?.ok
    && check.codesign?.ok
    && check.developerTeam
    && check.hardenedRuntime
    && check.entitlements?.ok
    && check.notarization?.ok
    && check.stapler?.ok
    && check.gatekeeper?.ok
    && check.blockmaps?.ok
  )
}

export function applyRemoteVersionGate(check, version, remoteVersion, remoteVersionState = 'unavailable') {
  check.remoteVersion = remoteVersion || null
  check.remoteVersionState = remoteVersionState
  check.firstRelease = remoteVersionState === 'absent'
  check.localVersionHigher = check.firstRelease
    || Boolean(remoteVersionState === 'present' && check.remoteVersion && compareReleaseVersions(version, check.remoteVersion) > 0)
  return check
}

export async function runMacPreflight({ root, productName, version, archs = ALLOWED_ARCHS, remoteVersions = {}, remoteVersionStates = {} }) {
  const scan = await scanMacArtifacts({ root, productName, version, archs })
  const checks = []
  for (const arch of archs) {
    const check = await checkArchitecture({ root, productName, version, arch, scan })
    applyRemoteVersionGate(check, version, remoteVersions[arch], remoteVersionStates[arch])
    check.stableEligible = stableGatePassed(check)
    checks.push(check)
  }
  return { version, archs, scan, checks, stableEligible: checks.every(check => check.stableEligible), checkedAt: new Date().toISOString() }
}

export async function createMacReleasePlan({ root, productName, version, archs, releaseNotes = '', stagingPercentage = 100 }) {
  const scan = await scanMacArtifacts({ root, productName, version, archs })
  if (!scan.complete) throw new Error('Release artifacts are incomplete')
  const releaseDate = new Date().toISOString()
  const manifests = []
  for (const arch of archs) {
    const byKind = Object.fromEntries(scan.records.filter(record => record.arch === arch).map(record => [record.kind, record]))
    verifyExternalBlockmapForArtifact(byKind['zip.blockmap'].filePath, byKind.zip.filePath)
    verifyExternalBlockmapForArtifact(byKind['dmg.blockmap'].filePath, byKind.dmg.filePath)
    const asEngineFile = record => ({
      filePath: record.filePath,
      remoteName: record.name,
      size: record.size,
      hash: { hex: record.sha512, base64: record.sha512Base64 },
    })
    const zip = asEngineFile(byKind.zip)
    const dmg = asEngineFile(byKind.dmg)
    const artifact = {
      arch,
      files: [zip, asEngineFile(byKind['zip.blockmap']), dmg, asEngineFile(byKind['dmg.blockmap'])],
      primary: zip,
      metadataFiles: [zip, dmg],
      manifestName: 'latest-mac.yml',
    }
    manifests.push({
      arch,
      name: artifact.manifestName,
      object: `stable/mac/${arch}/${artifact.manifestName}`,
      content: createMetadata({ platform: 'mac', version, artifact, releaseDate, releaseNotes, stagingPercentage }),
    })
  }
  const immutable = scan.records.map(record => ({ arch: record.arch, name: record.name, size: record.size, serverPath: `${RELEASE_CONSTANTS.serverRoot}/stable/mac/${record.arch}/${record.name}`, object: `stable/mac/${record.arch}/${record.name}` }))
  return {
    version,
    archs,
    localFiles: scan.records.map(record => record.filePath),
    checks: ['artifact completeness and version', 'CPU architecture', 'codesign and Developer Team', 'Hardened Runtime and entitlements', 'Apple notarization ticket', 'stapler validation', 'Gatekeeper assessment', 'SHA-512 and blockmap validation', 'remote version monotonicity'],
    serverDirectories: archs.map(arch => `${RELEASE_CONSTANTS.serverRoot}/stable/mac/${arch}`),
    ossObjects: [...immutable.map(item => item.object), ...manifests.map(item => item.object)],
    immutable,
    manifests,
    metadataSwitch: 'After every immutable file for every selected architecture is uploaded and verified, publish all latest-mac.yml manifests.',
    totalUploadBytes: scan.totalBytes + Buffer.byteLength(manifests.map(item => item.content).join('')),
    stagingPercentage,
  }
}

export function historyDirectory() {
  return path.join(os.homedir(), 'Library', 'Application Support', 'Bailongma Release Console', 'releases')
}
