#!/usr/bin/env node

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { extractFile } from '@electron/asar'
import pkg from '../package.json' with { type: 'json' }
import { verifyExternalBlockmapForArtifact } from './publish-updates-lib.mjs'
import { assertReleaseSignature, listMachOFiles } from './macos-signing-lib.mjs'
import {
  assertMacUpdaterConfig,
  assertMacUpdaterConfigFile,
  updaterConfigPathForApp,
} from './macos-updater-config.mjs'

const root = path.resolve(import.meta.dirname, '..')
const productName = pkg.productName || 'Bailongma'
const version = pkg.version

const supportedTargets = [
  { label: 'x64', machArch: 'x86_64' },
  { label: 'arm64', machArch: 'arm64' },
]
const requestedArgs = process.argv.slice(2)
const requestedLabels = requestedArgs.filter(label => label !== '--no-notarize')
const unknownLabels = requestedLabels.filter(label => !supportedTargets.some(target => target.label === label))
if (unknownLabels.length > 0) {
  throw new Error(`Unsupported mac artifact target(s): ${unknownLabels.join(', ')}`)
}
const targets = requestedLabels.length > 0
  ? supportedTargets.filter(target => requestedLabels.includes(target.label))
  : supportedTargets
const buildMetadataPath = path.join(root, 'dist', 'mac-build-metadata.json')
let buildMetadata = null
try {
  buildMetadata = JSON.parse(fs.readFileSync(buildMetadataPath, 'utf8'))
} catch {}
const recordedNoNotarization = buildMetadata?.version === version
  && buildMetadata?.notarized === false
  && targets.every(target => buildMetadata?.archs?.includes(target.label))
const skipNotarization = requestedArgs.includes('--no-notarize') || recordedNoNotarization

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    ...options,
  })

  if (result.error) {
    throw new Error(`${command} failed: ${result.error.message}`)
  }

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim()
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}${detail ? `\n${detail}` : ''}`)
  }

  return result.stdout.trim()
}

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} is missing: ${filePath}`)
  }
}

function assertPackagedBetterSqliteVersion(appPath, label) {
  const asarPath = path.join(appPath, 'Contents', 'Resources', 'app.asar')
  assertFile(asarPath, `${label} app.asar`)
  const packagedApp = JSON.parse(extractFile(asarPath, 'package.json').toString('utf8'))
  const expected = packagedApp.dependencies?.['better-sqlite3']
  const packagedSqlite = JSON.parse(
    extractFile(asarPath, 'node_modules/better-sqlite3/package.json').toString('utf8'),
  )
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expected || '')) {
    throw new Error(`${label} does not pin better-sqlite3 to an exact version: ${expected || 'missing'}`)
  }
  if (packagedSqlite.version !== expected) {
    throw new Error(`${label} packages better-sqlite3 ${packagedSqlite.version || 'unknown'}, expected ${expected}`)
  }
}

function assertPlistString(plistPath, key, expectedPattern, label) {
  const value = run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plistPath])
  if (!expectedPattern.test(value)) {
    throw new Error(`${label} has invalid ${key}: ${value || '(empty)'}`)
  }
}

function assertSingleArch(filePath, expectedArch, label) {
  assertFile(filePath, label)
  const archs = run('lipo', ['-archs', filePath]).split(/\s+/).filter(Boolean)
  if (archs.length !== 1 || archs[0] !== expectedArch) {
    throw new Error(`${label} has archs [${archs.join(', ')}], expected [${expectedArch}]`)
  }
}

function assertCodeSigned(filePath, label, { deep = false } = {}) {
  assertFile(filePath, label)
  const args = ['--verify']
  if (deep) args.push('--deep')
  args.push('--strict', '--verbose=2', filePath)
  run('codesign', args)
}

function assertDeveloperTeam(filePath, label) {
  const result = spawnSync('codesign', ['--display', '--verbose=4', filePath], {
    cwd: root,
    encoding: 'utf8',
  })
  const detail = `${result.stdout || ''}\n${result.stderr || ''}`
  if (result.error || result.status !== 0) {
    throw new Error(`${label} signing metadata is unavailable: ${detail.trim()}`)
  }
  const teamId = detail.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim()
  if (!teamId || teamId === 'not set') {
    throw new Error(`${label} does not have a Developer Team signature`)
  }
}

function assertEntitlement(filePath, entitlement, label) {
  const result = spawnSync('codesign', ['--display', '--entitlements', ':-', filePath], {
    cwd: root,
    encoding: 'utf8',
  })
  const detail = `${result.stdout || ''}\n${result.stderr || ''}`
  if (result.error || result.status !== 0) {
    throw new Error(`${label} entitlements are unavailable: ${detail.trim()}`)
  }
  if (!new RegExp(`<key>${entitlement.replaceAll('.', '\\.')}</key>\\s*<true\\s*/>`).test(detail)) {
    throw new Error(`${label} is missing required entitlement ${entitlement}`)
  }
}

function mountDmg(dmgPath) {
  const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-dmg-'))
  run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, dmgPath])
  return mountPoint
}

function detachDmg(mountPoint) {
  const result = spawnSync('hdiutil', ['detach', mountPoint, '-quiet'], {
    encoding: 'utf8',
  })
  if (result.status === 0) return

  spawnSync('hdiutil', ['detach', mountPoint, '-force', '-quiet'], {
    encoding: 'utf8',
  })
}

function smokeTarget(target) {
  const dmgPath = path.join(root, 'dist', `${productName}-${version}-mac-${target.label}.dmg`)
  const zipPath = path.join(root, 'dist', `${productName}-${version}-mac-${target.label}.zip`)
  const unpackedAppPath = path.join(root, 'dist', target.label === 'x64' ? 'mac' : 'mac-arm64', `${productName}.app`)
  assertFile(dmgPath, `${target.label} DMG`)
  assertFile(zipPath, `${target.label} ZIP`)
  assertFile(unpackedAppPath, `${target.label} unpacked app`)
  assertMacUpdaterConfigFile(
    updaterConfigPathForApp(unpackedAppPath),
    target.label,
    `${target.label} unpacked app app-update.yml`,
  )
  assertFile(`${dmgPath}.blockmap`, `${target.label} DMG blockmap`)
  assertFile(`${zipPath}.blockmap`, `${target.label} ZIP blockmap`)
  verifyExternalBlockmapForArtifact(`${dmgPath}.blockmap`, dmgPath)
  verifyExternalBlockmapForArtifact(`${zipPath}.blockmap`, zipPath)
  run('unzip', ['-tq', zipPath])

  const zipPlistDir = fs.mkdtempSync(path.join(os.tmpdir(), `bailongma-${target.label}-zip-`))
  const zipPlist = path.join(zipPlistDir, 'Info.plist')
  const extractedPlist = spawnSync('unzip', [
    '-p',
    zipPath,
    `${productName}.app/Contents/Info.plist`,
  ], { cwd: root, encoding: null, maxBuffer: 4 * 1024 * 1024 })
  if (extractedPlist.error || extractedPlist.status !== 0 || !extractedPlist.stdout?.length) {
    throw new Error(`${target.label} ZIP does not contain a readable app Info.plist`)
  }
  fs.writeFileSync(zipPlist, extractedPlist.stdout, { mode: 0o600 })
  const extractedUpdaterConfig = spawnSync('unzip', [
    '-p',
    zipPath,
    `${productName}.app/Contents/Resources/app-update.yml`,
  ], { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 })
  if (extractedUpdaterConfig.error || extractedUpdaterConfig.status !== 0 || !extractedUpdaterConfig.stdout?.trim()) {
    throw new Error(`${target.label} ZIP is missing a readable app-update.yml`)
  }
  assertMacUpdaterConfig(extractedUpdaterConfig.stdout, target.label, `${target.label} ZIP app-update.yml`)

  let mountPoint
  try {
    assertPlistString(zipPlist, 'CFBundleShortVersionString', new RegExp(`^${version.replaceAll('.', '\\.')}$`), `${target.label} ZIP Info.plist`)
    mountPoint = mountDmg(dmgPath)
    const appPath = path.join(mountPoint, `${productName}.app`)
    assertFile(appPath, `${target.label} app bundle`)
    assertPackagedBetterSqliteVersion(appPath, `${target.label} DMG`)
    assertMacUpdaterConfigFile(
      updaterConfigPathForApp(appPath),
      target.label,
      `${target.label} DMG app-update.yml`,
    )

    const plistPath = path.join(appPath, 'Contents', 'Info.plist')
    assertFile(plistPath, `${target.label} Info.plist`)
    assertPlistString(
      plistPath,
      'NSAppleEventsUsageDescription',
      /Music\.app/i,
      `${target.label} Info.plist`,
    )
    assertPlistString(
      plistPath,
      'CFBundleShortVersionString',
      new RegExp(`^${version.replaceAll('.', '\\.')}$`),
      `${target.label} Info.plist`,
    )

    const executablePath = path.join(appPath, 'Contents', 'MacOS', productName)
    const unpackedPath = path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked')
    const speechHelperPath = path.join(unpackedPath, 'build', 'native-speech-recognizer')
    const sqliteNodePath = path.join(unpackedPath, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
    const sqliteTestExtensionPath = path.join(unpackedPath, 'node_modules', 'better-sqlite3', 'build', 'Release', 'test_extension.node')
    const rendererHelperPath = path.join(
      appPath,
      'Contents',
      'Frameworks',
      `${productName} Helper (Renderer).app`,
    )

    assertSingleArch(executablePath, target.machArch, `${target.label} app executable`)
    assertSingleArch(speechHelperPath, target.machArch, `${target.label} native speech helper`)
    assertSingleArch(sqliteNodePath, target.machArch, `${target.label} better-sqlite3 native module`)
    assertCodeSigned(appPath, `${target.label} app`, { deep: true })
    run('codesign', ['--display', '--verbose=4', executablePath])
    for (const codePath of listMachOFiles(appPath)) {
      assertSingleArch(codePath, target.machArch, `${target.label} nested code`)
      assertReleaseSignature(codePath, `${target.label} nested code`)
    }
    assertCodeSigned(speechHelperPath, `${target.label} native speech helper`)
    assertDeveloperTeam(appPath, `${target.label} app`)
    assertDeveloperTeam(speechHelperPath, `${target.label} native speech helper`)
    assertEntitlement(appPath, 'com.apple.security.device.audio-input', `${target.label} app`)
    assertEntitlement(appPath, 'com.apple.security.automation.apple-events', `${target.label} app`)
    assertEntitlement(rendererHelperPath, 'com.apple.security.device.audio-input', `${target.label} renderer helper`)
    assertEntitlement(speechHelperPath, 'com.apple.security.device.audio-input', `${target.label} native speech helper`)
    if (!skipNotarization) {
      run('xcrun', ['stapler', 'validate', '-v', dmgPath])
      run('xcrun', ['stapler', 'validate', '-v', unpackedAppPath])
      run('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath])
      run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', dmgPath])
    }

    if (fs.existsSync(sqliteTestExtensionPath)) {
      throw new Error(`${target.label} package still includes better-sqlite3 test_extension.node`)
    }

    console.log(`[smoke:mac-artifacts] ${target.label} OK${skipNotarization ? ' (Developer ID signed, not notarized)' : ''}`)
  } finally {
    if (mountPoint) detachDmg(mountPoint)
    fs.rmSync(zipPlistDir, { recursive: true, force: true })
  }
}

for (const target of targets) {
  smokeTarget(target)
}

console.log('[smoke:mac-artifacts] all mac artifacts OK')
