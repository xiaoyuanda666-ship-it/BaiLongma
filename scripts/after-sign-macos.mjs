import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entitlementsPath = path.join(root, 'build', 'entitlements.mac.plist')
const relativeSpeechHelper = path.join(
  'Contents', 'Resources', 'app.asar.unpacked', 'build', 'native-speech-recognizer',
)
const relativeNodeRuntime = path.join('Contents', 'Resources', 'node-runtime', 'node')
const disableTimestamp = String(process.env.BAILONGMA_CODESIGN_TIMESTAMP || '').trim().toLowerCase() === 'none'
const timestampArgs = disableTimestamp ? ['--timestamp=none'] : []

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim()
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`)
  }
  return `${result.stdout || ''}\n${result.stderr || ''}`
}

function signingIdentity(appPath) {
  const configured = String(process.env.CSC_NAME || process.env.BAILONGMA_CODESIGN_IDENTITY || '').trim()
  if (configured) return configured
  const detail = run('codesign', ['--display', '--verbose=4', appPath])
  const authority = detail.match(/^Authority=(Developer ID Application: .+)$/m)?.[1]?.trim()
  if (!authority) throw new Error('Could not recover the Developer ID Application identity from the signed app')
  return authority
}

/**
 * electron-builder signs bare entries from mac.binaries without applying
 * entitlementsInherit. The native speech helper is such an entry, yet it owns
 * AVAudioEngine input. Re-sign it explicitly, then re-seal only the outer app
 * bundle so the helper keeps its own audio-input entitlement.
 */
export default async function afterSignMac(context) {
  if (context.electronPlatformName !== 'darwin') return
  // electron-builder passes the architecture output directory here (for
  // example dist/mac-arm64), rather than the .app bundle itself.
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const speechHelperPath = path.join(appPath, relativeSpeechHelper)
  const nodeRuntimePath = path.join(appPath, relativeNodeRuntime)
  if (!fs.existsSync(speechHelperPath)) {
    throw new Error(`Native speech helper is missing from packaged app: ${speechHelperPath}`)
  }
  if (!fs.existsSync(nodeRuntimePath)) {
    throw new Error(`Bundled Node runtime is missing from packaged app: ${nodeRuntimePath}`)
  }
  if (!fs.existsSync(entitlementsPath)) {
    throw new Error(`macOS entitlements are missing: ${entitlementsPath}`)
  }

  const identity = signingIdentity(appPath)
  // Re-sign the complete bundle first. This is normally a no-op after
  // electron-builder's own signing, but makes the hook robust when a nested
  // framework was left with a stale signature by a signer retry.
  run('codesign', [
    '--force', '--deep', '--options', 'runtime', '--entitlements', entitlementsPath,
    '--sign', identity, ...timestampArgs, appPath,
  ])
  run('codesign', [
    '--force', '--options', 'runtime', '--entitlements', entitlementsPath,
    '--sign', identity, ...timestampArgs, speechHelperPath,
  ])
  // The Chrome DevTools MCP server runs in this standalone Node process. Node
  // initializes V8 JIT on startup; under the hardened runtime it crashes with
  // SIGTRAP unless its own signature has the JIT entitlements. `--deep` does
  // not reliably apply them to an executable stored under Resources/.
  run('codesign', [
    '--force', '--options', 'runtime', '--entitlements', entitlementsPath,
    '--sign', identity, ...timestampArgs, nodeRuntimePath,
  ])
  // Do not use --deep here: it would sign the helper again without its own
  // entitlement file. The outer signature only needs resealing after the
  // nested helper changed.
  run('codesign', [
    '--force', '--options', 'runtime', '--entitlements', entitlementsPath,
    '--sign', identity, ...timestampArgs, appPath,
  ])
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
  console.log('[after-sign:mac] signed native speech helper and Node runtime with required entitlements')
}
