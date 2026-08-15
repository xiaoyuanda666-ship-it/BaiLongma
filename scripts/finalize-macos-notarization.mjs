#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { DEVELOPER_TEAM } from './macos-signing-lib.mjs'

const root = path.resolve(import.meta.dirname, '..')
const dist = path.join(root, 'dist')
const [kind, ...archs] = process.argv.slice(2)
if (!['app', 'dmg'].includes(kind) || archs.length === 0 || archs.some(arch => !['x64', 'arm64'].includes(arch))) {
  throw new Error('Usage: finalize-macos-notarization.mjs <app|dmg> <x64|arm64> [...]')
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error) throw result.error
  const detail = `${result.stdout || ''}\n${result.stderr || ''}`.trim()
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed${detail ? `\n${detail}` : ''}`)
  return detail
}

function rebuildBlockmap(artifactPath) {
  const binary = process.arch === 'arm64' ? 'app-builder_arm64' : 'app-builder_amd64'
  const builder = path.join(root, 'node_modules', 'app-builder-bin', 'mac', binary)
  const blockmapPath = `${artifactPath}.blockmap`
  fs.rmSync(blockmapPath, { force: true })
  const metadata = JSON.parse(run(builder, ['blockmap', '--input', artifactPath, '--output', blockmapPath]))
  if (Number(metadata.size) !== fs.statSync(artifactPath).size) throw new Error(`Final blockmap size mismatch for ${artifactPath}`)
  console.log(`[notary:mac] rebuilt ${path.basename(blockmapPath)} for final ${metadata.size}-byte artifact`)
}

function waitForSubmission(id) {
  return new Promise((resolve, reject) => {
    const child = spawn('xcrun', [
      'notarytool', 'wait', id,
      '--keychain-profile', process.env.BAILONGMA_NOTARY_PROFILE || 'BailongmaNotary',
      '--team-id', DEVELOPER_TEAM,
      '--output-format', 'json',
    ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => {
      let submission
      try { submission = JSON.parse(stdout || '{}') } catch {}
      if (code === 0 && submission?.status === 'Accepted') return resolve(submission)
      const detail = `${stdout}\n${stderr}`.trim()
      const logResult = spawnSync('xcrun', [
        'notarytool', 'log', id,
        '--keychain-profile', process.env.BAILONGMA_NOTARY_PROFILE || 'BailongmaNotary',
        '--team-id', DEVELOPER_TEAM,
      ], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
      const log = `${logResult.stdout || ''}\n${logResult.stderr || ''}`.trim().slice(0, 24_000)
      reject(new Error(`Apple notarization failed (submission ${id})${detail ? `\n${detail}` : ''}${log ? `\nApple notarization log:\n${log}` : ''}`))
    })
  })
}

await Promise.all(archs.map(async arch => {
  const statePath = path.join(dist, `notary-${kind}-${arch}.json`)
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  console.log(`[notary:mac] waiting for ${kind} ${arch} submission ${state.id}`)
  await waitForSubmission(state.id)
  const target = kind === 'app' ? state.appPath : state.dmgPath
  console.log(`[notary:mac] Apple accepted ${kind} ${arch} submission ${state.id}`)
  run('xcrun', ['stapler', 'staple', '-v', target])
  run('xcrun', ['stapler', 'validate', '-v', target])
  if (kind === 'dmg') run('codesign', ['--verify', '--strict', '--verbose=4', target])
}))

if (kind === 'dmg') {
  for (const arch of archs) {
    const prefix = path.join(dist, `Bailongma-${JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version}-mac-${arch}`)
    rebuildBlockmap(`${prefix}.dmg`)
    rebuildBlockmap(`${prefix}.zip`)
  }
}
