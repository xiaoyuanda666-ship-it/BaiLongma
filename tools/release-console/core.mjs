import crypto from 'node:crypto'
import path from 'node:path'

export const LOOPBACK_HOST = '127.0.0.1'
export const ALLOWED_ARCHS = Object.freeze(['x64', 'arm64'])
export const ALLOWED_STAGING_PERCENTAGES = Object.freeze([5, 10, 25, 50, 100])

export const RELEASE_STATES = Object.freeze([
  'DRAFT',
  'VALIDATING',
  'READY',
  'STAGING',
  'UPLOADING_ARTIFACTS',
  'VERIFYING_ARTIFACTS',
  'PUBLISHING_METADATA',
  'VERIFYING_RELEASE',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'UNCERTAIN',
])

const TERMINAL_STATES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN'])
const TRANSITIONS = new Map([
  ['DRAFT', new Set(['VALIDATING', 'CANCELLED'])],
  ['VALIDATING', new Set(['READY', 'FAILED', 'CANCELLED'])],
  ['READY', new Set(['STAGING', 'SUCCEEDED', 'CANCELLED', 'FAILED'])],
  ['STAGING', new Set(['UPLOADING_ARTIFACTS', 'FAILED', 'CANCELLED'])],
  ['UPLOADING_ARTIFACTS', new Set(['VERIFYING_ARTIFACTS', 'PUBLISHING_METADATA', 'FAILED', 'CANCELLED'])],
  ['VERIFYING_ARTIFACTS', new Set(['PUBLISHING_METADATA', 'FAILED', 'CANCELLED'])],
  ['PUBLISHING_METADATA', new Set(['VERIFYING_RELEASE', 'UNCERTAIN'])],
  ['VERIFYING_RELEASE', new Set(['SUCCEEDED', 'UNCERTAIN'])],
])

export class ReleaseStateMachine {
  constructor(initial = 'DRAFT') {
    if (!RELEASE_STATES.includes(initial)) throw new Error(`Unknown release state: ${initial}`)
    this.state = initial
    this.metadataBoundaryEntered = ['PUBLISHING_METADATA', 'VERIFYING_RELEASE', 'SUCCEEDED', 'UNCERTAIN'].includes(initial)
    this.transitions = [{ from: null, to: initial, at: new Date().toISOString() }]
  }

  transition(next, detail = '') {
    if (!RELEASE_STATES.includes(next)) throw new Error(`Unknown release state: ${next}`)
    if (this.state === next) return this.snapshot()
    if (TERMINAL_STATES.has(this.state)) throw new Error(`Release is already terminal: ${this.state}`)
    if (!TRANSITIONS.get(this.state)?.has(next)) {
      throw new Error(`Invalid release transition: ${this.state} -> ${next}`)
    }
    const previous = this.state
    this.state = next
    if (next === 'PUBLISHING_METADATA') this.metadataBoundaryEntered = true
    this.transitions.push({ from: previous, to: next, detail, at: new Date().toISOString() })
    return this.snapshot()
  }

  cancel(detail = 'Cancellation requested') {
    if (TERMINAL_STATES.has(this.state)) return this.snapshot()
    return this.transition(this.metadataBoundaryEntered ? 'UNCERTAIN' : 'CANCELLED', detail)
  }

  fail(detail = '') {
    if (TERMINAL_STATES.has(this.state)) return this.snapshot()
    return this.transition(this.metadataBoundaryEntered ? 'UNCERTAIN' : 'FAILED', detail)
  }

  snapshot() {
    return {
      state: this.state,
      metadataBoundaryEntered: this.metadataBoundaryEntered,
      cancellable: !TERMINAL_STATES.has(this.state) && !this.metadataBoundaryEntered,
      transitions: this.transitions.map(item => ({ ...item })),
    }
  }
}

export function parseReleaseVersion(value) {
  const text = String(value || '').trim()
  const match = text.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  if (!match) throw new Error(`Version must be numeric x.y.z: ${text || '(empty)'}`)
  const parts = match.slice(1).map(Number)
  if (parts.some(part => !Number.isSafeInteger(part))) throw new Error(`Version component is too large: ${text}`)
  return { text, parts }
}

export function compareReleaseVersions(left, right) {
  const a = parseReleaseVersion(left).parts
  const b = parseReleaseVersion(right).parts
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  }
  return 0
}

export function validateReleaseRequest(input, expectedVersion) {
  const version = parseReleaseVersion(input?.version).text
  if (version !== parseReleaseVersion(expectedVersion).text) throw new Error('Version does not match package.json')
  const archs = [...new Set(Array.isArray(input?.archs) ? input.archs : [])]
  if (archs.length === 0 || archs.some(arch => !ALLOWED_ARCHS.includes(arch))) throw new Error('Unsupported or empty architecture selection')
  if (input?.channel !== 'stable') throw new Error('Only the stable channel is enabled')
  const stagingPercentage = Number(input?.stagingPercentage)
  if (!ALLOWED_STAGING_PERCENTAGES.includes(stagingPercentage)) throw new Error('Unsupported stagingPercentage')
  const releaseNotes = String(input?.releaseNotes || '')
  if (releaseNotes.length > 20_000) throw new Error('Release notes are too long')
  if (!['upload', 'build'].includes(input?.mode)) throw new Error('Unsupported release mode')
  const dryRun = input?.dryRun === true
  const testBuild = input?.testBuild === true
  if (testBuild && !dryRun) throw new Error('A test build cannot be published to stable')
  if (!dryRun) {
    if (input?.confirmed !== true) throw new Error('Release confirmation checkbox is required')
    if (String(input?.confirmationVersion || '').trim() !== version) throw new Error('Full version confirmation does not match')
  }
  return {
    version,
    archs,
    channel: 'stable',
    stagingPercentage,
    releaseNotes,
    mode: input.mode,
    dryRun,
    testBuild,
    // Preserve only normalized confirmation values so the isolated worker can
    // enforce the same formal-release gate immediately before publication.
    confirmed: !dryRun,
    confirmationVersion: dryRun ? '' : version,
  }
}

export function assertWithinDirectory(baseDir, candidatePath) {
  const base = path.resolve(baseDir)
  const candidate = path.resolve(candidatePath)
  const relative = path.relative(base, candidate)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Path is outside the fixed release directory')
  }
  return candidate
}

export function resolveDistArtifact(distDir, filename, allowedNames) {
  const name = String(filename || '')
  if (!/^[A-Za-z0-9._-]+$/.test(name) || path.basename(name) !== name) throw new Error('Unsafe artifact filename')
  if (!new Set(allowedNames).has(name)) throw new Error('Artifact is not part of the fixed release inventory')
  return assertWithinDirectory(distDir, path.join(distDir, name))
}

export function redactLog(value) {
  return String(value ?? '')
    .replace(/-----BEGIN [^-\n]*(?:PRIVATE KEY|CERTIFICATE)[\s\S]*?-----END [^-\n]*-----/gi, '[REDACTED PEM]')
    .replace(/([?&](?:OSSAccessKeyId|Signature|Expires|security-token|x-oss-security-token)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/\b(?:LTAI|STS\.)[A-Za-z0-9._-]{8,}\b/g, '[REDACTED ACCESS KEY]')
    .replace(/\b(accessKey(?:ID|Secret)|secretAccessKey|privateKey|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/(https:\/\/download\.bailongma\.ai\/[^\s?]+)\?[^\s]+/gi, '$1?[REDACTED]')
    .replace(/\bssh-(?:rsa|ed25519)\s+[A-Za-z0-9+/=]+(?:\s+[^\n]+)?/g, '[REDACTED SSH KEY]')
}

export function createSessionSecrets() {
  return {
    token: crypto.randomBytes(32).toString('base64url'),
    cookie: crypto.randomBytes(32).toString('base64url'),
  }
}

export function expectedOrigin(port) {
  return `http://${LOOPBACK_HOST}:${port}`
}

export function validateHostHeader(hostHeader, port) {
  if (String(hostHeader || '') !== `${LOOPBACK_HOST}:${port}`) throw new Error('Invalid Host header')
  return true
}

export function validateWriteRequest(req, { token, port }) {
  validateHostHeader(req.headers.host, port)
  if (req.headers.origin !== expectedOrigin(port)) throw new Error('Invalid Origin header')
  const supplied = String(req.headers['x-release-session-token'] || '')
  const expected = String(token)
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    throw new Error('Invalid session token')
  }
  if (!/^application\/json(?:;|$)/i.test(String(req.headers['content-type'] || ''))) throw new Error('JSON content type is required')
  return true
}

export function sanitizeOperator(value) {
  const operator = String(value || '').trim().replace(/[\r\n\t]/g, ' ').slice(0, 120)
  return operator || 'local-user'
}
