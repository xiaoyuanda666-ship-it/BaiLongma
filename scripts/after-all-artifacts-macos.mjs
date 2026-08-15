import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DEVELOPER_TEAM, signDmg, submitForNotarization } from './macos-signing-lib.mjs'

const root = path.resolve(import.meta.dirname, '..')
const notaryProfile = process.env.BAILONGMA_NOTARY_PROFILE || 'BailongmaNotary'

function run(command, args, { json = false } = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error) throw result.error
  const detail = `${result.stdout || ''}\n${result.stderr || ''}`.trim()
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed${detail ? `\n${detail}` : ''}`)
  return json ? JSON.parse(String(result.stdout || '{}')) : detail
}

function blockmapBuilder() {
  const binary = process.arch === 'arm64' ? 'app-builder_arm64' : 'app-builder_amd64'
  return path.join(root, 'node_modules', 'app-builder-bin', 'mac', binary)
}

function rebuildBlockmap(artifactPath) {
  const blockmapPath = `${artifactPath}.blockmap`
  fs.rmSync(blockmapPath, { force: true })
  const metadata = run(blockmapBuilder(), ['blockmap', '--input', artifactPath, '--output', blockmapPath], { json: true })
  const finalSize = fs.statSync(artifactPath).size
  if (Number(metadata.size) !== finalSize) {
    throw new Error(`Blockmap size ${metadata.size} does not match final artifact size ${finalSize}: ${artifactPath}`)
  }
  return { blockmapPath, metadata }
}

export default async function afterAllArtifacts(buildResult) {
  if (process.platform !== 'darwin') return []
  const artifacts = [...buildResult.artifactPaths].filter(filePath => /\.(?:dmg|zip)$/.test(filePath))
  const dmgs = artifacts.filter(filePath => filePath.endsWith('.dmg'))
  for (const dmgPath of dmgs) {
    signDmg(dmgPath)
    if (process.env.BAILONGMA_NOTARY_MODE === 'skip') {
      console.log(`[after-artifacts:mac] signed ${path.basename(dmgPath)}; notarization skipped by request`)
      continue
    }
    const staged = process.env.BAILONGMA_NOTARY_MODE === 'submit'
    const submission = submitForNotarization(dmgPath, { profile: notaryProfile, teamId: DEVELOPER_TEAM, cwd: root, wait: !staged })
    if (staged) {
      const arch = path.basename(dmgPath).match(/-mac-(x64|arm64)\.dmg$/)?.[1]
      if (!arch) throw new Error(`Cannot identify DMG architecture from ${dmgPath}`)
      fs.writeFileSync(path.join(path.dirname(dmgPath), `notary-dmg-${arch}.json`), `${JSON.stringify({ kind: 'dmg', arch, id: submission.id, dmgPath }, null, 2)}\n`, { mode: 0o600 })
      console.log(`[after-artifacts:mac] submitted ${path.basename(dmgPath)} as ${submission.id}; finalization will wait and staple it`)
    } else {
      console.log(`[after-artifacts:mac] Apple accepted ${path.basename(dmgPath)} submission ${submission.id}`)
      run('xcrun', ['stapler', 'staple', '-v', dmgPath])
      run('xcrun', ['stapler', 'validate', '-v', dmgPath])
      run('codesign', ['--verify', '--strict', '--verbose=4', dmgPath])
    }
  }
  if (process.env.BAILONGMA_NOTARY_MODE === 'submit') return []
  for (const artifactPath of artifacts) {
    const { blockmapPath, metadata } = rebuildBlockmap(artifactPath)
    console.log(`[after-artifacts:mac] rebuilt ${path.basename(blockmapPath)} for final ${metadata.size}-byte artifact`)
  }
  return []
}
