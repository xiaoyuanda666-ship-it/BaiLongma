import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const DEVELOPER_TEAM = 'XD5VMPN37G'
export const DEFAULT_SIGNING_IDENTITY = `Developer ID Application: Yuanda Xiao (${DEVELOPER_TEAM})`

function commandResult(command, args, { cwd, allowFailure = false, encoding = 'utf8' } = {}) {
  const result = spawnSync(command, args, { cwd, encoding, maxBuffer: 64 * 1024 * 1024 })
  if (result.error) throw new Error(`${command} failed: ${result.error.message}`)
  if (result.status !== 0 && !allowFailure) {
    const detail = `${result.stderr || ''}\n${result.stdout || ''}`.trim()
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}${detail ? `\n${detail}` : ''}`)
  }
  return { status: result.status ?? -1, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') }
}

export function run(command, args, options = {}) {
  return commandResult(command, args, options).stdout.trim()
}

export function displaySignature(codePath) {
  const result = commandResult('codesign', ['--display', '--verbose=4', codePath], { allowFailure: true })
  return { ok: result.status === 0, detail: `${result.stdout}\n${result.stderr}`.trim() }
}

export function isMachO(filePath) {
  if (!fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) return false
  const result = commandResult('file', ['-b', filePath], { allowFailure: true })
  return result.status === 0 && /Mach-O/.test(result.stdout)
}

export function walk(root, visitor) {
  const entries = fs.readdirSync(root, { withFileTypes: true })
  for (const entry of entries) {
    const filePath = path.join(root, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) walk(filePath, visitor)
    else if (entry.isFile()) visitor(filePath)
  }
}

export function listMachOFiles(appPath) {
  const files = []
  walk(appPath, filePath => { if (isMachO(filePath)) files.push(filePath) })
  return files.sort((left, right) => depth(right) - depth(left) || left.localeCompare(right))
}

function depth(filePath) {
  return filePath.split(path.sep).length
}

function listCodeBundles(appPath) {
  const bundles = []
  const extensions = new Set(['.app', '.framework', '.xpc', '.appex', '.plugin', '.bundle'])
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const child = path.join(directory, entry.name)
      visit(child)
      if (child !== appPath && extensions.has(path.extname(child))) bundles.push(child)
    }
  }
  visit(appPath)
  return bundles.sort((left, right) => depth(right) - depth(left) || left.localeCompare(right))
}

function extractEntitlements(codePath, tempDir, index) {
  const result = commandResult('codesign', ['--display', '--entitlements', ':-', codePath], { allowFailure: true })
  const detail = `${result.stdout}\n${result.stderr}`
  const start = detail.indexOf('<?xml')
  const end = detail.lastIndexOf('</plist>')
  if (result.status !== 0 || start < 0 || end < start) return null
  const target = path.join(tempDir, `entitlements-${index}.plist`)
  fs.writeFileSync(target, detail.slice(start, end + '</plist>'.length), { mode: 0o600 })
  return target
}

function signOne(codePath, { identity, entitlements }) {
  const args = [
    '--force',
    '--sign', identity,
    '--timestamp',
    '--options', 'runtime',
  ]
  if (entitlements) args.push('--entitlements', entitlements)
  args.push(codePath)
  run('codesign', args)
}

export function assertReleaseSignature(codePath, label = codePath, { requireRuntime = true } = {}) {
  const signature = displaySignature(codePath)
  if (!signature.ok) throw new Error(`${label} is not signed: ${signature.detail}`)
  const authority = signature.detail.match(/^Authority=(.+)$/m)?.[1]?.trim()
  const team = signature.detail.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim()
  if (!authority?.startsWith('Developer ID Application:')) {
    throw new Error(`${label} is not signed with Developer ID Application`)
  }
  if (team !== DEVELOPER_TEAM) throw new Error(`${label} has Developer Team ${team || '(missing)'}, expected ${DEVELOPER_TEAM}`)
  if (!/^Timestamp=.+$/m.test(signature.detail)) throw new Error(`${label} signature does not include a secure timestamp`)
  if (requireRuntime && !/flags=.*\bruntime\b/i.test(signature.detail)) throw new Error(`${label} does not enable Hardened Runtime`)
  return signature.detail
}

export function assertSingleArchitecture(codePath, expectedArch, label = codePath) {
  const actual = run('lipo', ['-archs', codePath]).split(/\s+/).filter(Boolean)
  if (actual.length !== 1 || actual[0] !== expectedArch) {
    throw new Error(`${label} has architecture [${actual.join(', ')}], expected only ${expectedArch}`)
  }
}

export function signAppRecursively(appPath, {
  identity = process.env.CSC_NAME || process.env.BAILONGMA_CODESIGN_IDENTITY || DEFAULT_SIGNING_IDENTITY,
  entitlementsPath,
  speechHelperPath,
  nodeRuntimePath,
} = {}) {
  if (!fs.existsSync(appPath)) throw new Error(`App bundle is missing: ${appPath}`)
  if (!fs.existsSync(entitlementsPath)) throw new Error(`Entitlements are missing: ${entitlementsPath}`)
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-entitlements-'))
  try {
    const machOFiles = listMachOFiles(appPath)
    const bundles = listCodeBundles(appPath)
    let index = 0
    for (const codePath of machOFiles) {
      const explicit = codePath === speechHelperPath || codePath === nodeRuntimePath
      const entitlements = explicit ? entitlementsPath : extractEntitlements(codePath, tempDir, index++)
      signOne(codePath, { identity, entitlements })
    }
    for (const bundlePath of bundles) {
      signOne(bundlePath, { identity, entitlements: extractEntitlements(bundlePath, tempDir, index++) })
    }
    signOne(appPath, { identity, entitlements: entitlementsPath })
    return { machOFiles, bundles }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

export function verifySignedApp(appPath, { expectedArch, speechHelperPath, nodeRuntimePath } = {}) {
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=4', appPath])
  const mainExecutable = path.join(appPath, 'Contents', 'MacOS', path.basename(appPath, '.app'))
  run('codesign', ['--display', '--verbose=4', mainExecutable])
  const machOFiles = listMachOFiles(appPath)
  if (machOFiles.length === 0) throw new Error(`No Mach-O code found in ${appPath}`)
  for (const codePath of machOFiles) {
    assertReleaseSignature(codePath)
    if (expectedArch) assertSingleArchitecture(codePath, expectedArch)
  }
  for (const requiredPath of [speechHelperPath, nodeRuntimePath].filter(Boolean)) {
    if (!machOFiles.includes(requiredPath)) throw new Error(`Required signed runtime is missing: ${requiredPath}`)
  }
  assertReleaseSignature(appPath, 'Bailongma.app')
  return { machOCount: machOFiles.length }
}

export function signDmg(dmgPath, identity = process.env.CSC_NAME || process.env.BAILONGMA_CODESIGN_IDENTITY || DEFAULT_SIGNING_IDENTITY) {
  run('codesign', ['--force', '--sign', identity, '--timestamp', dmgPath])
  run('codesign', ['--verify', '--strict', '--verbose=4', dmgPath])
  assertReleaseSignature(dmgPath, path.basename(dmgPath), { requireRuntime: false })
}

export function submitForNotarization(filePath, {
  profile = process.env.BAILONGMA_NOTARY_PROFILE || 'BailongmaNotary',
  teamId = DEVELOPER_TEAM,
  cwd,
  wait = true,
} = {}) {
  const configuredAttempts = Number(process.env.BAILONGMA_NOTARY_SUBMIT_ATTEMPTS || 4)
  const maxAttempts = Number.isInteger(configuredAttempts) && configuredAttempts > 0
    ? Math.min(configuredAttempts, 8)
    : 4
  let result
  let submission
  let submissionId

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const args = [
      'notarytool', 'submit', filePath,
      '--keychain-profile', profile,
      '--team-id', teamId,
      // Some networks repeatedly reset Apple's accelerated multipart S3 upload
      // after several parts. The standard S3 path is slower but substantially
      // more reliable for Bailongma's large bundled-browser archives.
      '--no-s3-acceleration',
      wait ? '--wait' : '--no-wait', '--output-format', 'json',
    ]
    result = commandResult('xcrun', args, { cwd, allowFailure: true })
    try { submission = JSON.parse(result.stdout || '{}') } catch { submission = undefined }
    if (result.status === 0 && submission?.id && (!wait || submission.status === 'Accepted')) return submission

    submissionId = submission?.id || `${result.stdout}\n${result.stderr}`.match(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/i)?.[0]
    if (submissionId) {
      const infoResult = commandResult('xcrun', [
        'notarytool', 'info', submissionId,
        '--keychain-profile', profile,
        '--team-id', teamId,
        '--output-format', 'json',
      ], { cwd, allowFailure: true })
      let remote
      try { remote = JSON.parse(infoResult.stdout || '{}') } catch {}
      // Accepted is authoritative. In Progress after an aborted multipart
      // upload is not: Apple creates the record before every part is committed,
      // and such records can remain stuck indefinitely.
      if (infoResult.status === 0 && remote?.id === submissionId && remote.status === 'Accepted') return remote
    }

    const failureText = `${result.stdout}\n${result.stderr}`
    const retryableUploadFailure = /abortedUpload|Connection reset|NWError|connectTimeout|Could not connect|NSURLErrorDomain|timed?\s*out/i.test(failureText)
    if (!retryableUploadFailure || attempt === maxAttempts) break
    console.warn(`[notary:mac] upload attempt ${attempt}/${maxAttempts} failed; retrying the submission`)
  }

  let log = ''
  if (submissionId) {
    const logResult = commandResult('xcrun', [
      'notarytool', 'log', submissionId,
      '--keychain-profile', profile,
      '--team-id', teamId,
    ], { cwd, allowFailure: true })
    log = `${logResult.stdout}\n${logResult.stderr}`.trim().slice(0, 24_000)
  }
  const detail = `${result.stdout}\n${result.stderr}`.trim()
  throw new Error(
    `Apple notarization failed for ${path.basename(filePath)}`
    + `${submissionId ? ` (submission ${submissionId})` : ''}`
    + `${detail ? `\n${detail}` : ''}`
    + `${log ? `\nApple notarization log:\n${log}` : ''}`,
  )
}

export function waitForNotarization(submissionId, {
  profile = process.env.BAILONGMA_NOTARY_PROFILE || 'BailongmaNotary',
  teamId = DEVELOPER_TEAM,
  cwd,
} = {}) {
  const result = commandResult('xcrun', [
    'notarytool', 'wait', submissionId,
    '--keychain-profile', profile,
    '--team-id', teamId,
    '--output-format', 'json',
  ], { cwd, allowFailure: true })
  let submission
  try { submission = JSON.parse(result.stdout || '{}') } catch {}
  if (result.status === 0 && submission?.status === 'Accepted') return submission
  const logResult = commandResult('xcrun', [
    'notarytool', 'log', submissionId,
    '--keychain-profile', profile,
    '--team-id', teamId,
  ], { cwd, allowFailure: true })
  const detail = `${result.stdout}\n${result.stderr}`.trim()
  const log = `${logResult.stdout}\n${logResult.stderr}`.trim().slice(0, 24_000)
  throw new Error(
    `Apple notarization failed (submission ${submissionId})`
    + `${detail ? `\n${detail}` : ''}`
    + `${log ? `\nApple notarization log:\n${log}` : ''}`,
  )
}
