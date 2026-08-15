import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import zlib from 'node:zlib'
import { publishUpdates } from '../../../scripts/publish-updates-lib.mjs'
import { applyRemoteVersionGate, createMacReleasePlan, expectedMacArtifactNames, scanMacArtifacts, stableGatePassed } from '../release-engine.mjs'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-release-console-'))
  const dist = path.join(root, 'dist')
  fs.mkdirSync(dist)
  const productName = 'Bailongma'
  const version = '9.8.7'
  for (const name of expectedMacArtifactNames(productName, version).filter(name => !name.endsWith('.blockmap'))) {
    const artifactPath = path.join(dist, name)
    fs.writeFileSync(artifactPath, Buffer.from(`fixture:${name}`))
    const blockmap = zlib.gzipSync(Buffer.from(JSON.stringify({ version: '2', files: [{ name: 'fixture', offset: 0, checksums: ['x'], sizes: [fs.statSync(artifactPath).size] }] })))
    fs.writeFileSync(`${artifactPath}.blockmap`, blockmap)
  }
  return { root, productName, version }
}

test('release engine scans exactly eight fixed macOS artifacts and builds two manifests', async t => {
  const data = fixture()
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }))
  const scan = await scanMacArtifacts(data)
  assert.equal(scan.records.length, 8)
  assert.equal(scan.complete, true)
  assert.ok(scan.records.every(record => /^[0-9a-f]{128}$/.test(record.sha512)))
  const plan = await createMacReleasePlan({ ...data, archs: ['x64', 'arm64'], releaseNotes: 'Safe rollout', stagingPercentage: 25 })
  assert.equal(plan.immutable.length, 8)
  assert.equal(plan.manifests.length, 2)
  assert.ok(plan.manifests.every(item => item.content.includes('stagingPercentage: 25')))
  assert.match(plan.manifests[0].content, /releaseNotes: \|-\n  Safe rollout/)
  assert.notEqual(plan.manifests[0].content, plan.manifests[1].content)
  assert.match(plan.manifests.find(item => item.arch === 'x64').content, /mac-x64\.zip/)
  assert.match(plan.manifests.find(item => item.arch === 'arm64').content, /mac-arm64\.zip/)
})

test('shared publish engine dry-run returns metadata without remote commands', async t => {
  const data = fixture()
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }))
  const events = []
  const result = await publishUpdates({
    platform: 'mac',
    root: data.root,
    pkg: { productName: data.productName, version: data.version },
    argv: ['--dry-run', '--skip-smoke'],
    releaseOptions: { releaseNotes: 'dry only', stagingPercentage: 10 },
    onEvent: event => events.push(event),
  })
  assert.equal(result.dryRun, true)
  assert.equal(result.artifacts.length, 2)
  assert.ok(result.artifacts.every(artifact => artifact.metadata.includes('stagingPercentage: 10')))
  assert.ok(events.some(event => event.type === 'dry-run-complete'))
  assert.ok(!events.some(event => event.type === 'remote-read' || event.type === 'staging'))
})

test('a confirmed missing remote manifest is allowed as a first release, but an unavailable remote is blocked', () => {
  const validCheck = () => ({
    complete: true,
    versionMatch: true,
    cpuArchitecture: { ok: true },
    codesign: { ok: true },
    developerTeam: 'XD5VMPN37G',
    hardenedRuntime: true,
    entitlements: { ok: true },
    notarization: { ok: true },
    stapler: { ok: true },
    gatekeeper: { ok: true },
    blockmaps: { ok: true },
  })

  const firstRelease = applyRemoteVersionGate(validCheck(), '2.1.655', null, 'absent')
  assert.equal(firstRelease.firstRelease, true)
  assert.equal(firstRelease.localVersionHigher, true)
  assert.equal(stableGatePassed(firstRelease), true)

  const unavailable = applyRemoteVersionGate(validCheck(), '2.1.655', null, 'unavailable')
  assert.equal(unavailable.firstRelease, false)
  assert.equal(unavailable.localVersionHigher, false)
  assert.equal(stableGatePassed(unavailable), false)

  const olderRemote = applyRemoteVersionGate(validCheck(), '2.1.655', '2.1.616', 'present')
  assert.equal(olderRemote.localVersionHigher, true)
  assert.equal(stableGatePassed(olderRemote), true)
})
