#!/usr/bin/env node

// Run: node --experimental-vm-modules scripts/test-macos-build-plan.mjs
// Execute the real build script in a VM whose process, filesystem mutations,
// and child processes are fixtures. Nothing builds, signs, publishes, or uploads.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

assert.equal(typeof vm.SourceTextModule, 'function', 'Run this test with --experimental-vm-modules')
const require = createRequire(import.meta.url)
const yargs = require('yargs/yargs')
const { configureBuildCommand, normalizeOptions } = require('electron-builder/out/builder.js')
const { validateConfiguration } = require('app-builder-lib/out/util/config/config.js')
const buildPath = fileURLToPath(new URL('./build-mac.mjs', import.meta.url))
const source = fs.readFileSync(buildPath, 'utf8')
const fixturePackage = Object.freeze({ productName: 'BuildPlanFixture', version: '9.8.7' })
const builderEntry = './node_modules/electron-builder/cli.js'

async function runPlan(args, { inheritedMode, failBuilder = false } = {}) {
  const calls = []
  const writes = []
  const removals = []
  // Deliberately model a release CI with Apple credentials available. These
  // are dummy values in a private VM; no real credentials are read or changed.
  const env = {
    CI: 'true', npm_lifecycle_event: 'release',
    APPLE_KEYCHAIN_PROFILE: 'fixture-only-notary-profile',
  }
  if (inheritedMode !== undefined) env.BAILONGMA_NOTARY_MODE = inheritedMode
  const context = vm.createContext({
    process: {
      argv: ['fixture-node', buildPath, ...args], platform: 'darwin', env,
      exit(status) { throw Object.assign(new Error(`fixture process.exit(${status})`), { exitCode: status }) },
    },
    console: { log() {}, warn() {}, error() {} },
  })
  const fakeFs = {
    rmSync(target, options) { removals.push({ target, options: structuredClone(options) }) },
    writeFileSync(target, contents, options) { writes.push({ target, contents, options: structuredClone(options) }) },
  }
  const fixtures = new Map([
    ['node:fs', { default: fakeFs }],
    ['node:path', { default: path }],
    ['node:child_process', {
      spawnSync(command, childArgs, options) {
        calls.push({ command, args: [...childArgs], options: structuredClone(options), env: { ...env } })
        return { status: failBuilder && childArgs[0] === builderEntry ? 17 : 0 }
      },
    }],
    ['../package.json', { default: fixturePackage }],
  ])
  const module = new vm.SourceTextModule(source, { context, identifier: buildPath })
  await module.link(specifier => {
    const exports = fixtures.get(specifier)
    assert.ok(exports, `Build plan imported an unisolated dependency: ${specifier}`)
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value)
    }, { context, identifier: `fixture:${specifier}` })
  })
  let error
  try { await module.evaluate({ timeout: 2000 }) } catch (caught) { error = caught }
  return { calls, writes, removals, env, error }
}

async function assertBuilderSafety(call, mode) {
  assert.equal(call.command, 'node')
  assert.equal(call.env.BAILONGMA_NOTARY_MODE, mode, 'custom notarization hooks must receive the explicit mode')
  assert.ok(call.args.includes('--config.mac.notarize=false'), 'disable electron-builder automatic notarization explicitly')
  const parsed = configureBuildCommand(yargs(call.args.slice(1)).exitProcess(false)).parse()
  const options = normalizeOptions(parsed)
  // Validate with the installed builder's actual schema. Its CLI initially
  // parses "false" as a string; schema coercion must produce boolean false.
  await validateConfiguration(options.config, { isEnabled: false, add() {} })
  assert.equal(options.config.mac.notarize, false, 'built-in notarization must remain off even when credentials exist')
  assert.equal(options.publish, 'never', 'a build must not publish even in a release CI environment')
}

for (const testCase of [
  { args: [], archs: ['x64', 'arm64'], notarized: true },
  { args: [], archs: ['x64', 'arm64'], notarized: true, inheritedMode: 'skip' },
  { args: ['--no-notarize'], archs: ['x64', 'arm64'], notarized: false },
  { args: ['--no-notarize'], archs: ['x64', 'arm64'], notarized: false, inheritedMode: 'submit' },
  { args: ['x64', '--no-notarize'], archs: ['x64'], notarized: false, inheritedMode: 'submit' },
  { args: ['arm64'], archs: ['arm64'], notarized: true },
]) {
  const plan = await runPlan(testCase.args, testCase)
  assert.ifError(plan.error)
  const builderCalls = plan.calls.filter(call => call.args[0] === builderEntry)
  assert.equal(builderCalls.length, testCase.archs.length * 2, 'every architecture builds an app and packages its artifacts')
  for (const call of builderCalls) await assertBuilderSafety(call, testCase.notarized ? 'submit' : 'skip')
  for (const arch of testCase.archs) {
    const archCalls = builderCalls.filter(call => call.args.includes(`--${arch}`))
    assert.equal(archCalls.length, 2)
    assert.ok(archCalls[0].args.includes('dir'))
    assert.ok(archCalls[1].args.includes('dmg') && archCalls[1].args.includes('zip'))
    assert.ok(archCalls[1].args.includes('--prepackaged'))
  }
  assert.equal(plan.env.BAILONGMA_NOTARY_MODE, testCase.inheritedMode, 'temporary hook mode does not leak out of builder calls')
  assert.equal(Object.hasOwn(plan.env, 'BAILONGMA_NOTARY_MODE'), testCase.inheritedMode !== undefined)

  const finalizations = plan.calls.filter(call => call.args[0] === 'scripts/finalize-macos-notarization.mjs')
  assert.deepEqual(finalizations.map(call => call.args.slice(1)), testCase.notarized
    ? [['app', ...testCase.archs], ['dmg', ...testCase.archs]] : [],
  'no-notarize must not wait for, staple, or otherwise finalize Apple submissions')
  assert.equal(plan.calls.some(call => /publish|upload/.test(call.args[0])), false, 'the build must not invoke a release/upload script')
  const smoke = plan.calls.at(-1)
  assert.deepEqual(smoke.args, ['scripts/smoke-mac-artifacts.mjs', ...testCase.archs, ...(testCase.notarized ? [] : ['--no-notarize'])])
  assert.equal(plan.writes.length, 1)
  assert.equal(path.basename(plan.writes[0].target), 'mac-build-metadata.json')
  assert.deepEqual(JSON.parse(plan.writes[0].contents), {
    version: fixturePackage.version, archs: testCase.archs, notarized: testCase.notarized,
  })
}

// A failed builder must stop the plan before any finalization or success
// metadata. The fixture return code prevents testing a fabricated success path.
const failed = await runPlan(['--no-notarize'], { failBuilder: true })
assert.equal(failed.error?.exitCode, 17)
assert.equal(failed.calls.filter(call => call.args[0] === builderEntry).length, 1)
assert.equal(failed.calls.some(call => /finalize-macos-notarization|smoke-mac-artifacts/.test(call.args[0])), false)
assert.equal(failed.writes.length, 0)

console.log('PASS isolated macOS build plans: explicit no-publish, built-in notarization disabled, custom modes, and failure stopping')
