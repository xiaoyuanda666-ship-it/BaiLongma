import crypto from 'node:crypto'
import { emitEvent } from './events.js'
import { getConfig, setConfig } from './db.js'
import { projectBrowserDownloadJobToScene } from './capabilities/tools/browser-download-task-scene.js'

export const BACKGROUND_JOB_STATES = Object.freeze([
  'queued',
  'navigating',
  'downloading',
  'paused',
  'waiting_user',
  'interrupted',
  'failed',
  'cancelled',
  'completed',
])

const VALID_STATES = new Set(BACKGROUND_JOB_STATES)
const TERMINAL_STATES = new Set(['failed', 'cancelled', 'completed'])
const RESTART_UNRECOVERABLE_STATES = new Set(['queued', 'navigating', 'downloading', 'paused'])
const SNAPSHOT_CONFIG_KEY = 'background_jobs_v1'
const MAX_JOBS = 100
const TERMINAL_RETENTION_MS = 30 * 60 * 1000

function nowIso(now) {
  return new Date(Number(now())).toISOString()
}

function clone(value) {
  if (value == null) return value
  return JSON.parse(JSON.stringify(value))
}

function normalizeError(value) {
  if (!value) return null
  if (typeof value === 'string') return { code: 'BACKGROUND_JOB_ERROR', message: value }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { code: 'BACKGROUND_JOB_ERROR', message: String(value) }
  }
  return {
    code: String(value.code || 'BACKGROUND_JOB_ERROR'),
    message: String(value.message || value.error || value.code || 'background job error'),
    ...(value.recoverable === true ? { recoverable: true } : {}),
    ...(value.details && typeof value.details === 'object' ? { details: clone(value.details) } : {}),
  }
}

function normalizeJob(raw = {}, now = Date.now) {
  const timestamp = nowIso(now)
  const state = VALID_STATES.has(raw.state) ? raw.state : 'queued'
  const notifiedEvents = Array.isArray(raw.notifiedEvents)
    ? [...new Set(raw.notifiedEvents.map(String).filter(Boolean))].slice(-50)
    : []
  return {
    jobId: String(raw.jobId || ''),
    type: String(raw.type || 'browser_download'),
    state,
    target: String(raw.target || ''),
    channel: String(raw.channel || 'AUTO'),
    targetId: String(raw.targetId || ''),
    externalPartyId: String(raw.externalPartyId || ''),
    voiceReply: raw.voiceReply === true,
    downloadId: raw.downloadId ? String(raw.downloadId) : null,
    error: normalizeError(raw.error),
    createdAt: String(raw.createdAt || timestamp),
    updatedAt: String(raw.updatedAt || raw.createdAt || timestamp),
    completedAt: raw.completedAt ? String(raw.completedAt) : null,
    filename: String(raw.filename || ''),
    path: String(raw.path || ''),
    receivedBytes: Math.max(0, Number(raw.receivedBytes) || 0),
    totalBytes: Math.max(0, Number(raw.totalBytes) || 0),
    percent: Number.isFinite(Number(raw.percent)) ? Number(raw.percent) : null,
    paused: raw.paused === true,
    canResume: raw.canResume === true,
    canRetry: raw.canRetry === true,
    availableActions: Array.isArray(raw.availableActions)
      ? raw.availableActions.map(String).filter(Boolean).slice(0, 8)
      : [],
    attempt: Math.max(1, Number(raw.attempt) || 1),
    retryOf: raw.retryOf ? String(raw.retryOf) : null,
    interruptionCount: Math.max(0, Number(raw.interruptionCount) || 0),
    reason: String(raw.reason || ''),
    notifiedEvents,
  }
}

export function publicBackgroundJob(job) {
  if (!job) return null
  const snapshot = clone(job)
  delete snapshot.notifiedEvents
  return snapshot
}

function defaultLoadSnapshot() {
  try {
    const raw = getConfig(SNAPSHOT_CONFIG_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function defaultSaveSnapshot(snapshot) {
  setConfig(SNAPSHOT_CONFIG_KEY, JSON.stringify(snapshot))
}

export class BackgroundJobManager {
  constructor({
    now = Date.now,
    idFactory = null,
    loadSnapshot = defaultLoadSnapshot,
    saveSnapshot = defaultSaveSnapshot,
    emitEventFn = emitEvent,
    projectJobFn = () => {},
    terminalRetentionMs = TERMINAL_RETENTION_MS,
  } = {}) {
    this.now = now
    this.idFactory = idFactory || (() => `bg_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`)
    this.loadSnapshot = loadSnapshot
    this.saveSnapshot = saveSnapshot
    this.emitEvent = emitEventFn
    this.projectJob = projectJobFn
    this.terminalRetentionMs = Math.max(10 * 60 * 1000, Number(terminalRetentionMs) || TERMINAL_RETENTION_MS)
    this.jobs = new Map()
    this.downloadBindings = new Map()
    this.loaded = false
    this.load()
  }

  load() {
    if (this.loaded) return
    this.loaded = true
    let snapshots = []
    try { snapshots = this.loadSnapshot() || [] } catch {}
    if (!Array.isArray(snapshots)) return
    for (const raw of snapshots.slice(0, MAX_JOBS)) {
      const job = normalizeJob(raw, this.now)
      if (!job.jobId || this.jobs.has(job.jobId)) continue
      this.jobs.set(job.jobId, job)
      if (job.downloadId) this.downloadBindings.set(job.downloadId, job.jobId)
    }
    this.prune({ persist: false })
  }

  serializedSnapshot() {
    return [...this.jobs.values()]
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .slice(0, MAX_JOBS)
      .map(clone)
  }

  persist() {
    try { this.saveSnapshot(this.serializedSnapshot()) }
    catch (error) { console.warn('[background-jobs] persistence failed:', error?.message || error) }
  }

  prune({ persist = true } = {}) {
    const nowMs = Number(this.now())
    let changed = false
    for (const [jobId, job] of this.jobs) {
      if (!TERMINAL_STATES.has(job.state) || !job.completedAt) continue
      const completedMs = Date.parse(job.completedAt)
      if (!Number.isFinite(completedMs) || nowMs - completedMs < this.terminalRetentionMs) continue
      this.jobs.delete(jobId)
      if (job.downloadId && this.downloadBindings.get(job.downloadId) === jobId) {
        this.downloadBindings.delete(job.downloadId)
      }
      changed = true
    }
    if (changed && persist) this.persist()
  }

  emitUpdate(job) {
    const snapshot = publicBackgroundJob(job)
    const event = {
      ...snapshot,
      job_id: snapshot.jobId,
      runtime_lane: 'background',
      task_type: snapshot.type,
    }
    try { this.emitEvent('background_job_update', event) } catch {}
    try { this.projectJob(snapshot) } catch {}
    return snapshot
  }

  createJob(input = {}) {
    const timestamp = nowIso(this.now)
    const jobId = String(input.jobId || this.idFactory())
    if (!jobId) throw new TypeError('background job id is required')
    if (this.jobs.has(jobId)) throw new Error(`background job ${jobId} already exists`)
    const job = normalizeJob({
      ...input,
      jobId,
      state: input.state || 'queued',
      createdAt: input.createdAt || timestamp,
      updatedAt: input.updatedAt || timestamp,
      completedAt: input.completedAt || null,
    }, this.now)
    this.jobs.set(jobId, job)
    if (job.downloadId) this.downloadBindings.set(job.downloadId, jobId)
    this.persist()
    return this.emitUpdate(job)
  }

  getJob(jobId) {
    this.prune()
    return publicBackgroundJob(this.jobs.get(String(jobId || '')))
  }

  findByDownloadId(downloadId) {
    const jobId = this.downloadBindings.get(String(downloadId || ''))
    return jobId ? this.getJob(jobId) : null
  }

  listJobs({ includeTerminal = true } = {}) {
    this.prune()
    return [...this.jobs.values()]
      .filter(job => includeTerminal || !TERMINAL_STATES.has(job.state))
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
      .map(publicBackgroundJob)
  }

  updateJob(jobId, patch = {}) {
    const job = this.jobs.get(String(jobId || ''))
    if (!job) return null
    const nextState = patch.state == null ? job.state : String(patch.state)
    if (!VALID_STATES.has(nextState)) throw new TypeError(`invalid background job state: ${nextState}`)
    const previousDownloadId = job.downloadId
    Object.assign(job, clone(patch), {
      state: nextState,
      error: patch.error === undefined ? job.error : normalizeError(patch.error),
      updatedAt: nowIso(this.now),
    })
    if (TERMINAL_STATES.has(nextState) && !job.completedAt) job.completedAt = job.updatedAt
    if (!TERMINAL_STATES.has(nextState) && patch.completedAt === undefined) job.completedAt = null
    if (previousDownloadId && previousDownloadId !== job.downloadId
        && this.downloadBindings.get(previousDownloadId) === job.jobId) {
      this.downloadBindings.delete(previousDownloadId)
    }
    if (job.downloadId) this.downloadBindings.set(String(job.downloadId), job.jobId)
    this.persist()
    return this.emitUpdate(job)
  }

  bindDownload(jobId, download = {}) {
    const downloadId = String(download.id || download.downloadId || '').trim()
    if (!downloadId) return this.getJob(jobId)
    return this.updateJob(jobId, {
      downloadId,
      state: download.state === 'paused' ? 'paused' : 'downloading',
      filename: String(download.filename || ''),
      path: String(download.path || ''),
      receivedBytes: Math.max(0, Number(download.receivedBytes) || 0),
      totalBytes: Math.max(0, Number(download.totalBytes) || 0),
      percent: Number.isFinite(Number(download.percent)) ? Number(download.percent) : null,
      paused: download.paused === true,
      canResume: download.canResume === true,
      canRetry: download.canRetry === true,
      availableActions: Array.isArray(download.availableActions) ? download.availableActions : [],
      attempt: Math.max(1, Number(download.attempt) || 1),
      retryOf: download.retryOf || null,
      error: null,
    })
  }

  handleDownloadEvent(event = {}) {
    const downloadId = String(event.id || event.downloadId || '').trim()
    const explicitJobId = String(event.jobId || event.job_id || event.notification?.jobId || '').trim()
    const jobId = explicitJobId || this.downloadBindings.get(downloadId)
    if (!jobId || !this.jobs.has(jobId)) return null
    if (downloadId) this.downloadBindings.set(downloadId, jobId)

    const nativeState = String(event.state || '').toLowerCase()
    let state = nativeState === 'paused' || event.paused === true ? 'paused' : 'downloading'
    let error = null
    if (nativeState === 'completed') state = 'completed'
    else if (nativeState === 'cancelled') state = 'cancelled'
    else if (nativeState === 'interrupted') {
      state = 'interrupted'
      error = {
        code: 'DOWNLOAD_INTERRUPTED',
        message: 'The native browser download was interrupted.',
        recoverable: event.canResume === true || event.canRetry === true,
      }
    } else if (nativeState === 'retried') {
      state = 'queued'
    } else if (event.event === 'done' && nativeState && nativeState !== 'progressing') {
      state = 'failed'
      error = { code: 'DOWNLOAD_FAILED', message: `The native browser download ended with state ${nativeState}.` }
    }

    return this.updateJob(jobId, {
      state,
      downloadId: nativeState === 'retried' ? null : (downloadId || this.jobs.get(jobId).downloadId),
      filename: String(event.filename || this.jobs.get(jobId).filename || ''),
      path: String(event.path || this.jobs.get(jobId).path || ''),
      receivedBytes: Math.max(0, Number(event.receivedBytes) || 0),
      totalBytes: Math.max(0, Number(event.totalBytes) || 0),
      percent: Number.isFinite(Number(event.percent)) ? Number(event.percent) : null,
      paused: event.paused === true || state === 'paused',
      canResume: event.canResume === true,
      canRetry: event.canRetry === true,
      availableActions: Array.isArray(event.availableActions) ? event.availableActions : [],
      attempt: Math.max(1, Number(event.attempt) || this.jobs.get(jobId).attempt || 1),
      retryOf: event.retryOf || this.jobs.get(jobId).retryOf || null,
      interruptionCount: Math.max(0, Number(event.interruptionCount) || 0),
      error,
    })
  }

  applyDownloadControl(downloadId, action, download = {}) {
    const job = this.findByDownloadId(downloadId)
    if (!job) return null
    const normalized = String(action || '').toLowerCase()
    if (normalized === 'pause') return this.updateJob(job.jobId, { state: 'paused', paused: true })
    if (normalized === 'resume') return this.updateJob(job.jobId, { state: 'downloading', paused: false, error: null })
    if (normalized === 'cancel') return this.updateJob(job.jobId, {
      // Electron confirms cancellation asynchronously through DownloadItem's
      // terminal done event. Keep this non-terminal until that event arrives
      // so neither UI nor injected context can claim cancellation too early.
      state: job.state === 'paused' ? 'paused' : 'downloading',
      error: null,
      reason: 'Cancellation requested; waiting for the native download to stop.',
      availableActions: Array.isArray(download.availableActions) ? download.availableActions : [],
    })
    if (normalized === 'retry') return this.updateJob(job.jobId, {
      state: 'queued',
      downloadId: null,
      error: null,
      paused: false,
      attempt: Math.max(job.attempt + 1, Number(download.attempt) || 0),
    })
    return job
  }

  claimImportantNotification(jobId, eventKey) {
    const job = this.jobs.get(String(jobId || ''))
    const key = String(eventKey || '').trim()
    if (!job || !key || job.notifiedEvents.includes(key)) return false
    job.notifiedEvents.push(key)
    if (job.notifiedEvents.length > 50) job.notifiedEvents.splice(0, job.notifiedEvents.length - 50)
    job.updatedAt = nowIso(this.now)
    this.persist()
    return true
  }

  releaseImportantNotification(jobId, eventKey) {
    const job = this.jobs.get(String(jobId || ''))
    const key = String(eventKey || '').trim()
    if (!job || !key) return false
    const index = job.notifiedEvents.indexOf(key)
    if (index < 0) return false
    job.notifiedEvents.splice(index, 1)
    job.updatedAt = nowIso(this.now)
    this.persist()
    return true
  }

  recoverInterruptedJobs() {
    const recovered = []
    for (const job of [...this.jobs.values()]) {
      if (!RESTART_UNRECOVERABLE_STATES.has(job.state)) continue
      const snapshot = this.updateJob(job.jobId, {
        state: 'interrupted',
        error: {
          code: 'RECOVERY_REQUIRED',
          message: 'BaiLongma restarted and can no longer control the previous native DownloadItem. Retry or cancel this job.',
          recoverable: true,
        },
        canResume: false,
        canRetry: true,
        availableActions: ['retry', 'cancel'],
      })
      if (snapshot) recovered.push(snapshot)
    }
    return recovered
  }

  contextSnapshot() {
    return {
      retentionMs: this.terminalRetentionMs,
      jobs: this.listJobs({ includeTerminal: true }),
    }
  }
}

let singleton = null

export function getBackgroundJobManager() {
  if (!singleton) {
    singleton = new BackgroundJobManager({
      projectJobFn: projectBrowserDownloadJobToScene,
    })
  }
  return singleton
}

export const __backgroundJobManagerTestHooks = {
  setSingleton(value) { singleton = value || null },
  resetSingleton() { singleton = null },
}
