#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  LOOPBACK_HOST,
  ReleaseStateMachine,
  createSessionSecrets,
  expectedOrigin,
  redactLog,
  sanitizeOperator,
  validateHostHeader,
  validateReleaseRequest,
  validateWriteRequest,
} from './core.mjs'
import {
  createMacReleasePlan,
  getSystemStatus,
  historyDirectory,
  readGitState,
  runMacPreflight,
  scanMacArtifacts,
} from './release-engine.mjs'

const consoleDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(consoleDir, '..', '..')
const pkg = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'))
const staticDir = path.join(consoleDir, 'public')
const secrets = createSessionSecrets()
const operator = sanitizeOperator(os.userInfo().username)
const historiesDir = historyDirectory()
await fsp.mkdir(historiesDir, { recursive: true, mode: 0o700 })

const JSON_HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
})

function json(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

function readJson(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('Request body is too large'))
        req.destroy()
      } else chunks.push(chunk)
    })
    req.once('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
      catch { reject(new Error('Invalid JSON body')) }
    })
    req.once('error', reject)
  })
}

class TaskManager {
  constructor() {
    this.active = null
    this.clients = new Set()
  }

  publicTask(task = this.active) {
    if (!task) return null
    return {
      id: task.id,
      request: task.request,
      state: task.machine.state,
      cancellable: task.machine.snapshot().cancellable,
      metadataBoundaryEntered: task.machine.metadataBoundaryEntered,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      progress: task.progress,
      services: task.services,
      logs: task.logs.slice(-500),
      steps: task.steps,
      preflight: task.preflight,
      error: task.error,
    }
  }

  broadcast(type, payload) {
    const event = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`
    for (const client of this.clients) client.write(event)
  }

  emitTask(task, event) {
    const safe = { ...event, message: event.message == null ? undefined : redactLog(event.message) }
    if (safe.type === 'log') {
      task.logs.push({ at: safe.at || new Date().toISOString(), level: safe.level || 'info', message: safe.message })
      if (task.logs.length > 2_000) task.logs.splice(0, task.logs.length - 2_000)
    }
    task.steps.push(safe)
    task.updatedAt = new Date().toISOString()
    this.broadcast('task', { task: this.publicTask(task), event: safe })
  }

  transition(task, next, detail = '') {
    if (task.machine.state !== next) task.machine.transition(next, detail)
    this.emitTask(task, { type: 'state', state: next, message: detail, at: new Date().toISOString() })
  }

  async persist(task) {
    const record = {
      releaseId: task.id,
      version: task.request.version,
      architectures: task.request.archs,
      gitCommit: task.git?.commit || null,
      gitDirty: task.git?.dirty ?? null,
      files: task.preflight?.scan?.records?.map(record => ({ name: record.name, size: record.size, sha512: record.sha512 })) || [],
      releaseNotes: task.request.releaseNotes,
      stagingPercentage: task.request.stagingPercentage,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      operator,
      mode: task.request.mode,
      dryRun: task.request.dryRun,
      testBuild: task.request.testBuild,
      steps: task.steps,
      finalState: task.machine.state,
      error: task.error,
    }
    const target = path.join(historiesDir, `${task.id}.json`)
    const temp = `${target}.tmp`
    await fsp.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    await fsp.rename(temp, target)
    return record
  }

  spawnWorker(task, action) {
    return new Promise((resolve, reject) => {
      const workerPath = path.join(consoleDir, 'worker.mjs')
      const child = spawn(process.execPath, [workerPath], {
        cwd: root,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      task.child = child
      let buffered = ''
      const parseLines = chunk => {
        buffered += chunk.toString('utf8')
        const lines = buffered.split(/\r?\n/)
        buffered = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line)
            this.handleWorkerEvent(task, event)
          } catch {
            this.emitTask(task, { type: 'log', level: 'info', message: redactLog(line), at: new Date().toISOString() })
          }
        }
      }
      child.stdout.on('data', parseLines)
      child.stderr.on('data', chunk => {
        for (const line of chunk.toString('utf8').split(/\r?\n/).filter(Boolean)) {
          this.emitTask(task, { type: 'log', level: 'error', message: redactLog(line), at: new Date().toISOString() })
        }
      })
      child.once('error', reject)
      child.once('close', code => {
        task.child = null
        if (buffered.trim()) parseLines('\n')
        code === 0 ? resolve() : reject(new Error(`Release worker exited with ${code}`))
      })
      child.stdin.end(JSON.stringify({ action, root, pkg, request: task.request }))
    })
  }

  handleWorkerEvent(task, message) {
    if (message.type === 'engine') {
      const event = message.event || {}
      if (event.type === 'staging' && event.status === 'uploading') {
        if (task.machine.state === 'READY') this.transition(task, 'STAGING', 'Uploading fixed inventory to remote staging')
        this.transition(task, 'UPLOADING_ARTIFACTS', 'Uploading immutable artifacts')
        task.progress = { uploadedBytes: 0, totalBytes: event.totalBytes || 0, speed: 0, etaSeconds: null }
        task.services.hongKong = 'staging'
      } else if (event.type === 'staging' && event.status === 'uploaded') {
        task.progress.uploadedBytes = task.progress.totalBytes
        task.services.hongKong = 'staged'
        task.services.validation = 'verifying-artifacts'
        this.transition(task, 'VERIFYING_ARTIFACTS', 'Remote staging upload complete; validating immutable files')
      } else if (event.type === 'file-progress') {
        task.progress = {
          uploadedBytes: Number(event.uploadedBytes || 0),
          totalBytes: Number(event.totalBytes || task.progress.totalBytes || 0),
          speed: Number(event.speed || task.progress.speed || 0),
          etaSeconds: event.etaSeconds ?? task.progress.etaSeconds,
          currentFile: event.name,
          currentFileStatus: event.status,
        }
      } else if (event.type === 'metadata-boundary' && event.status === 'entered') {
        if (task.machine.state === 'READY') this.transition(task, 'STAGING', 'Remote staging prepared')
        if (task.machine.state === 'STAGING') this.transition(task, 'UPLOADING_ARTIFACTS', 'Immutable upload transaction started')
        if (task.machine.state === 'UPLOADING_ARTIFACTS') this.transition(task, 'VERIFYING_ARTIFACTS', 'Verifying immutable artifacts')
        this.transition(task, 'PUBLISHING_METADATA', 'Metadata publication boundary entered; cancellation is now uncertain')
        task.services.oss = 'publishing'
        task.services.hongKong = 'publishing'
      } else if (event.type === 'verify-release' && event.status === 'running') {
        if (task.machine.state === 'PUBLISHING_METADATA') this.transition(task, 'VERIFYING_RELEASE', 'Verifying origin, OSS, HTTPS, SHA-512 and Range')
        task.services.validation = 'verifying-release'
      } else if (event.type === 'verify-release' && event.status === 'passed') {
        task.services.oss = 'verified'
        task.services.hongKong = 'verified'
        task.services.validation = 'passed'
      }
      this.emitTask(task, { type: 'engine', event, at: message.at })
      return
    }
    if (message.type === 'log') this.emitTask(task, message)
    else if (message.type === 'fatal') {
      task.workerError = message.message
      this.emitTask(task, { type: 'log', level: 'error', message: message.message, at: message.at })
    } else this.emitTask(task, message)
  }

  async start(rawRequest, remoteVersions, remoteVersionStates) {
    if (this.active && !['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN'].includes(this.active.machine.state)) {
      throw new Error('Another release task is already running')
    }
    const request = validateReleaseRequest(rawRequest, pkg.version)
    const id = `${Date.now()}-${cryptoRandomId()}`
    const task = {
      id,
      request,
      machine: new ReleaseStateMachine(),
      logs: [],
      steps: [],
      progress: { uploadedBytes: 0, totalBytes: 0, speed: 0, etaSeconds: null },
      services: { oss: 'pending', hongKong: 'pending', validation: 'pending' },
      startedAt: new Date().toISOString(),
      endedAt: null,
      error: null,
      child: null,
      preflight: null,
      git: null,
    }
    this.active = task
    this.broadcast('task', { task: this.publicTask(task) })
    this.run(task, remoteVersions, remoteVersionStates).catch(() => {})
    return this.publicTask(task)
  }

  async run(task, remoteVersions, remoteVersionStates) {
    try {
      this.transition(task, 'VALIDATING', task.request.mode === 'build' ? 'Building and validating artifacts' : 'Validating existing artifacts')
      task.git = await readGitState(root)
      if (task.request.mode === 'build') await this.spawnWorker(task, 'build')
      task.preflight = await runMacPreflight({ root, productName: pkg.productName || 'Bailongma', version: pkg.version, archs: task.request.archs, remoteVersions, remoteVersionStates })
      this.emitTask(task, { type: 'preflight', result: task.preflight, at: new Date().toISOString() })
      if (!task.request.dryRun && !task.preflight.stableEligible) {
        throw new Error('Stable publication blocked: notarization, stapler, Gatekeeper, signing, architecture, completeness and version checks must all pass')
      }
      this.transition(task, 'READY', task.request.dryRun ? 'Local dry-run is ready' : 'All stable publication gates passed')
      await this.spawnWorker(task, 'publish')
      if (task.machine.state === 'READY') this.transition(task, 'SUCCEEDED', 'Dry-run completed without remote writes')
      else if (task.machine.state === 'VERIFYING_RELEASE') this.transition(task, 'SUCCEEDED', 'Release verification passed')
      else if (task.machine.state === 'UNCERTAIN') this.emitTask(task, { type: 'log', level: 'warn', message: 'Remote verification finished, but cancellation after metadata publication keeps the recorded result UNCERTAIN', at: new Date().toISOString() })
      else if (!['CANCELLED', 'FAILED'].includes(task.machine.state)) throw new Error(`Worker completed in unexpected state ${task.machine.state}`)
    } catch (error) {
      task.error = redactLog(task.workerError || error.message)
      if (!['CANCELLED', 'UNCERTAIN'].includes(task.machine.state)) task.machine.fail(task.error)
      this.emitTask(task, { type: 'state', state: task.machine.state, level: 'error', message: task.error, at: new Date().toISOString() })
    } finally {
      task.endedAt = new Date().toISOString()
      const history = await this.persist(task).catch(error => {
        this.emitTask(task, { type: 'log', level: 'error', message: `History write failed: ${error.message}`, at: new Date().toISOString() })
        return null
      })
      if (history) this.broadcast('history', { history })
      this.broadcast('task', { task: this.publicTask(task), complete: true })
    }
  }

  cancel() {
    const task = this.active
    if (!task || ['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN'].includes(task.machine.state)) throw new Error('No cancellable task is running')
    const beforeBoundary = !task.machine.metadataBoundaryEntered
    task.machine.cancel('Cancellation requested by operator')
    if (beforeBoundary) task.child?.kill('SIGTERM')
    this.emitTask(task, { type: 'state', state: task.machine.state, message: beforeBoundary ? 'Task cancelled before latest-mac.yml publication' : 'Cancellation requested after metadata boundary; remote verification continues and result is UNCERTAIN', at: new Date().toISOString() })
    return this.publicTask(task)
  }
}

function cryptoRandomId() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(9))).toString('base64url')
}

async function readHistories(limit = 30) {
  const names = (await fsp.readdir(historiesDir).catch(() => []))
    .filter(name => /^\d+-[A-Za-z0-9_-]+\.json$/.test(name))
    .sort().reverse().slice(0, limit)
  const records = []
  for (const name of names) {
    try { records.push(JSON.parse(await fsp.readFile(path.join(historiesDir, name), 'utf8'))) } catch {}
  }
  return records
}

const tasks = new TaskManager()
let cachedStatus = null
let statusPromise = null
let lastPreflight = null

async function refreshSnapshot() {
  if (!statusPromise) {
    statusPromise = (async () => {
      const [system, artifacts, histories] = await Promise.all([
        getSystemStatus({ root, version: pkg.version }),
        scanMacArtifacts({ root, productName: pkg.productName || 'Bailongma', version: pkg.version }),
        readHistories(),
      ])
      cachedStatus = { system, artifacts, histories, refreshedAt: new Date().toISOString() }
      return cachedStatus
    })().finally(() => { statusPromise = null })
  }
  return statusPromise
}

function serveStatic(req, res, pathname) {
  const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'] }
  const entry = files[pathname]
  if (!entry) return false
  const bytes = fs.readFileSync(path.join(staticDir, entry[0]))
  res.writeHead(200, {
    'Content-Type': entry[1],
    'Content-Length': bytes.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  })
  res.end(bytes)
  return true
}

const server = http.createServer(async (req, res) => {
  try {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    validateHostHeader(req.headers.host, port)
    const origin = req.headers.origin
    if (origin && origin !== expectedOrigin(port)) throw new Error('Invalid Origin header')
    const url = new URL(req.url, expectedOrigin(port))
    if (req.method === 'GET' && serveStatic(req, res, url.pathname)) return
    if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
      return json(res, 200, { token: secrets.token, operator, version: pkg.version, productName: pkg.productName || 'Bailongma', channels: [{ id: 'stable', enabled: true }, { id: 'beta', enabled: false }, { id: 'internal', enabled: false }], stagingPercentages: [5, 10, 25, 50, 100] })
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const snapshot = cachedStatus || await refreshSnapshot()
      return json(res, 200, { ...snapshot, preflight: lastPreflight, activeTask: tasks.publicTask() })
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
      res.write(`event: ready\ndata: ${JSON.stringify({ activeTask: tasks.publicTask() })}\n\n`)
      tasks.clients.add(res)
      const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000)
      req.once('close', () => { clearInterval(heartbeat); tasks.clients.delete(res) })
      return
    }
    if (req.method === 'POST') validateWriteRequest(req, { token: secrets.token, port })
    if (req.method === 'POST' && url.pathname === '/api/refresh') {
      const snapshot = await refreshSnapshot()
      return json(res, 200, { ...snapshot, activeTask: tasks.publicTask() })
    }
    if (req.method === 'POST' && url.pathname === '/api/plan') {
      const body = await readJson(req)
      const request = validateReleaseRequest({ ...body, dryRun: true }, pkg.version)
      const plan = await createMacReleasePlan({ root, productName: pkg.productName || 'Bailongma', ...request })
      return json(res, 200, { plan })
    }
    if (req.method === 'POST' && url.pathname === '/api/preflight') {
      const body = await readJson(req)
      const request = validateReleaseRequest({ ...body, dryRun: true }, pkg.version)
      lastPreflight = await runMacPreflight({
        root,
        productName: pkg.productName || 'Bailongma',
        version: pkg.version,
        archs: request.archs,
        remoteVersions: cachedStatus?.system?.remoteVersions || {},
        remoteVersionStates: cachedStatus?.system?.remoteVersionStates || {},
      })
      return json(res, 200, { preflight: lastPreflight })
    }
    if (req.method === 'POST' && url.pathname === '/api/tasks') {
      const body = await readJson(req)
      const task = await tasks.start(body, cachedStatus?.system?.remoteVersions || {}, cachedStatus?.system?.remoteVersionStates || {})
      return json(res, 202, { task })
    }
    if (req.method === 'POST' && url.pathname === '/api/cancel') {
      await readJson(req)
      return json(res, 200, { task: tasks.cancel() })
    }
    return json(res, 404, { error: 'Not found' })
  } catch (error) {
    return json(res, /Host|Origin|session token|content type/i.test(error.message) ? 403 : 400, { error: redactLog(error.message) })
  }
})

server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'))

server.listen(0, LOOPBACK_HOST, async () => {
  const address = server.address()
  const url = `http://${LOOPBACK_HOST}:${address.port}`
  console.log(`[release:ui] Bailongma Release Console listening on ${url}`)
  console.log('[release:ui] Real publication is never started automatically; it requires checkbox and exact version confirmation in the UI.')
  refreshSnapshot().catch(error => console.warn(`[release:ui] initial status refresh failed: ${redactLog(error.message)}`))
  if (!process.argv.includes('--no-open')) {
    const opener = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]]
    const child = spawn(opener[0], opener[1], { shell: false, stdio: 'ignore', windowsHide: true })
    child.unref()
  }
})

function shutdown() {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 3_000).unref()
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
