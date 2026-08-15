import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { Arch } from 'builder-util'
import {
  DEVELOPER_TEAM,
  signAppRecursively,
  submitForNotarization,
  verifySignedApp,
} from './macos-signing-lib.mjs'
import { assertMacUpdaterConfigFile, updaterConfigPathForApp } from './macos-updater-config.mjs'

const root = path.resolve(import.meta.dirname, '..')
const entitlementsPath = path.join(root, 'build', 'entitlements.mac.plist')
const notaryProfile = process.env.BAILONGMA_NOTARY_PROFILE || 'BailongmaNotary'

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = `${result.stderr || ''}\n${result.stdout || ''}`.trim()
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `\n${detail}` : ''}`)
  }
  return `${result.stdout || ''}\n${result.stderr || ''}`.trim()
}

export default async function afterSignMac(context) {
  if (context.electronPlatformName !== 'darwin') return
  const arch = Arch[context.arch]
  const expectedArch = arch === 'x64' ? 'x86_64' : 'arm64'
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const speechHelperPath = path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'build', 'native-speech-recognizer')
  const nodeRuntimePath = path.join(appPath, 'Contents', 'Resources', 'node-runtime', 'node')
  for (const requiredPath of [speechHelperPath, nodeRuntimePath, entitlementsPath]) {
    if (!fs.existsSync(requiredPath)) throw new Error(`Required macOS signing input is missing: ${requiredPath}`)
  }
  assertMacUpdaterConfigFile(updaterConfigPathForApp(appPath), arch, `${arch} signed app updater config`)

  const signed = signAppRecursively(appPath, { entitlementsPath, speechHelperPath, nodeRuntimePath })
  const verified = verifySignedApp(appPath, { expectedArch, speechHelperPath, nodeRuntimePath })
  if (process.env.BAILONGMA_NOTARY_MODE === 'skip') {
    console.log(`[after-sign:mac] signed ${signed.machOFiles.length} Mach-O files and ${signed.bundles.length} nested bundles; verified ${verified.machOCount} timestamped code objects; notarization skipped by request`)
    return
  }
  const archivePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}-${arch}-notary.zip`)
  try {
    run('ditto', ['-c', '-k', '--keepParent', appPath, archivePath])
    const staged = process.env.BAILONGMA_NOTARY_MODE === 'submit'
    const submission = submitForNotarization(archivePath, { profile: notaryProfile, teamId: DEVELOPER_TEAM, cwd: root, wait: !staged })
    if (staged) {
      const statePath = path.join(context.outDir, `notary-app-${arch}.json`)
      fs.writeFileSync(statePath, `${JSON.stringify({ kind: 'app', arch, id: submission.id, appPath }, null, 2)}\n`, { mode: 0o600 })
      console.log(`[after-sign:mac] submitted ${arch} app as ${submission.id}; finalization will wait and staple it`)
    } else {
      console.log(`[after-sign:mac] Apple accepted ${arch} app submission ${submission.id}`)
      run('xcrun', ['stapler', 'staple', '-v', appPath])
      run('xcrun', ['stapler', 'validate', '-v', appPath])
    }
  } finally {
    fs.rmSync(archivePath, { force: true })
  }
  console.log(`[after-sign:mac] signed ${signed.machOFiles.length} Mach-O files and ${signed.bundles.length} nested bundles; verified ${verified.machOCount} timestamped code objects`)
}
