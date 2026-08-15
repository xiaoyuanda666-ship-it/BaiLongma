import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import {
  ReleaseStateMachine,
  compareReleaseVersions,
  parseReleaseVersion,
  redactLog,
  resolveDistArtifact,
  validateReleaseRequest,
  validateWriteRequest,
} from '../core.mjs'

test('strict numeric release versions compare without lexical errors', () => {
  assert.deepEqual(parseReleaseVersion('2.10.0').parts, [2, 10, 0])
  assert.equal(compareReleaseVersions('2.10.0', '2.9.999'), 1)
  assert.equal(compareReleaseVersions('2.1.655', '2.1.655'), 0)
  assert.throws(() => parseReleaseVersion('2.01.0'), /numeric x.y.z/)
  assert.throws(() => parseReleaseVersion('2.1'), /numeric x.y.z/)
})

test('release request requires fixed channel, architectures and exact formal confirmation', () => {
  const base = { version: '2.1.656', archs: ['x64', 'arm64'], channel: 'stable', stagingPercentage: 25, releaseNotes: 'notes', mode: 'upload' }
  assert.equal(validateReleaseRequest({ ...base, dryRun: true }, '2.1.656').dryRun, true)
  assert.throws(() => validateReleaseRequest({ ...base, dryRun: false }, '2.1.656'), /checkbox/)
  assert.throws(() => validateReleaseRequest({ ...base, dryRun: false, confirmed: true, confirmationVersion: '2.1.65' }, '2.1.656'), /does not match/)
  const formal = validateReleaseRequest({ ...base, dryRun: false, confirmed: true, confirmationVersion: '2.1.656' }, '2.1.656')
  assert.equal(formal.dryRun, false)
  assert.equal(formal.confirmed, true)
  assert.equal(formal.confirmationVersion, '2.1.656')
  assert.deepEqual(validateReleaseRequest(formal, '2.1.656'), formal)
  assert.equal(validateReleaseRequest({ ...base, dryRun: true, testBuild: true }, '2.1.656').testBuild, true)
  assert.throws(() => validateReleaseRequest({ ...base, dryRun: false, testBuild: true, confirmed: true, confirmationVersion: '2.1.656' }, '2.1.656'), /test build/)
  assert.throws(() => validateReleaseRequest({ ...base, channel: 'beta', dryRun: true }, '2.1.656'), /stable/)
})

test('artifact paths cannot escape dist or select an arbitrary file', () => {
  const dist = path.resolve('/tmp/bailongma-fixed-dist')
  const allowed = ['Bailongma-2.1.656-mac-x64.zip']
  assert.equal(resolveDistArtifact(dist, allowed[0], allowed), path.join(dist, allowed[0]))
  assert.throws(() => resolveDistArtifact(dist, '../secret', allowed), /Unsafe/)
  assert.throws(() => resolveDistArtifact(dist, 'package.json', allowed), /fixed release inventory/)
})

test('state machine makes post-metadata cancellation uncertain', () => {
  const early = new ReleaseStateMachine()
  early.transition('VALIDATING')
  assert.equal(early.cancel().state, 'CANCELLED')

  const late = new ReleaseStateMachine()
  for (const state of ['VALIDATING', 'READY', 'STAGING', 'UPLOADING_ARTIFACTS', 'VERIFYING_ARTIFACTS', 'PUBLISHING_METADATA']) late.transition(state)
  const snapshot = late.cancel()
  assert.equal(snapshot.state, 'UNCERTAIN')
  assert.equal(snapshot.cancellable, false)
  assert.throws(() => late.transition('SUCCEEDED'), /terminal/)
})

test('CSRF validation requires exact Host, Origin and constant-time token match', () => {
  const request = { headers: { host: '127.0.0.1:43123', origin: 'http://127.0.0.1:43123', 'x-release-session-token': 'secret-token', 'content-type': 'application/json' } }
  assert.equal(validateWriteRequest(request, { token: 'secret-token', port: 43123 }), true)
  assert.throws(() => validateWriteRequest({ headers: { ...request.headers, host: 'localhost:43123' } }, { token: 'secret-token', port: 43123 }), /Host/)
  assert.throws(() => validateWriteRequest({ headers: { ...request.headers, origin: 'https://evil.example' } }, { token: 'secret-token', port: 43123 }), /Origin/)
  assert.throws(() => validateWriteRequest({ headers: { ...request.headers, 'x-release-session-token': 'wrong-token' } }, { token: 'secret-token', port: 43123 }), /session token/)
})

test('log redaction removes signed OSS URLs, keys and PEM payloads', () => {
  const raw = 'https://download.bailongma.ai/stable/a.zip?OSSAccessKeyId=LTAIEXAMPLE123&Expires=99&Signature=secret accessKeySecret=hunter2\n-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'
  const safe = redactLog(raw)
  assert.doesNotMatch(safe, /secret|hunter2|LTAIEXAMPLE123|BEGIN PRIVATE KEY/)
  assert.match(safe, /REDACTED/)
})
