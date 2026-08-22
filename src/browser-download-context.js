import { getBackgroundJobManager } from './background-job-manager.js'

const MAX_CONTEXT_DOWNLOADS = 20
const MAX_METADATA_LENGTH = 1_024

function safeMetadata(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, MAX_METADATA_LENGTH)
}

function safeNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

function contextRecord(record = {}) {
  const availableActions = Array.isArray(record.availableActions)
    ? record.availableActions
      .map(safeMetadata)
      .filter(action => ['pause', 'resume', 'cancel', 'retry'].includes(action))
      .slice(0, 4)
    : []
  return {
    id: safeMetadata(record.id),
    ...(safeMetadata(record.jobId || record.job_id)
      ? { job_id: safeMetadata(record.jobId || record.job_id) }
      : {}),
    state: safeMetadata(record.state) || 'unknown',
    filename: safeMetadata(record.filename),
    save_path: safeMetadata(record.path),
    received_bytes: safeNumber(record.receivedBytes),
    total_bytes: safeNumber(record.totalBytes),
    percent: Number.isFinite(Number(record.percent)) ? Number(record.percent) : null,
    paused: record.paused === true,
    can_resume: record.canResume === true,
    can_retry: record.canRetry === true,
    available_actions: availableActions,
    attempt: safeNumber(record.attempt),
    retry_of: safeMetadata(record.retryOf) || null,
    interruption_count: safeNumber(record.interruptionCount),
    started_at: safeMetadata(record.startedAt),
    updated_at: safeMetadata(record.updatedAt),
    completed_at: safeMetadata(record.completedAt) || null,
    finished_at: safeMetadata(record.finishedAt) || null,
    retained_until: safeMetadata(record.retainedUntil) || null,
  }
}

function backgroundJobContextRecord(job = {}) {
  return {
    job_id: safeMetadata(job.jobId),
    type: safeMetadata(job.type),
    state: safeMetadata(job.state),
    target: safeMetadata(job.target),
    download_id: safeMetadata(job.downloadId) || null,
    filename: safeMetadata(job.filename),
    save_path: safeMetadata(job.path),
    received_bytes: safeNumber(job.receivedBytes),
    total_bytes: safeNumber(job.totalBytes),
    percent: Number.isFinite(Number(job.percent)) ? Number(job.percent) : null,
    available_actions: Array.isArray(job.availableActions)
      ? job.availableActions.map(safeMetadata).filter(Boolean).slice(0, 8)
      : [],
    error: job.error && typeof job.error === 'object'
      ? { code: safeMetadata(job.error.code), message: safeMetadata(job.error.message) }
      : null,
    created_at: safeMetadata(job.createdAt),
    updated_at: safeMetadata(job.updatedAt),
    completed_at: safeMetadata(job.completedAt) || null,
  }
}

function promptSafeJson(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
}

export function formatBrowserDownloadSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return ''
  const directory = safeMetadata(snapshot.directory)
  if (!directory) return ''
  const active = (Array.isArray(snapshot.active) ? snapshot.active : [])
    .slice(-MAX_CONTEXT_DOWNLOADS)
    .map(contextRecord)
  const recentBudget = Math.max(0, MAX_CONTEXT_DOWNLOADS - active.length)
  const recent = (Array.isArray(snapshot.recent) ? snapshot.recent : [])
    .slice(-recentBudget)
    .map(contextRecord)
  const retentionMs = safeNumber(snapshot.completionRetentionMs)

  return `<browser-downloads>
This is authoritative live state automatically supplied by BaiLongma; no browser, filesystem, or shell tool call is needed to discover download status or progress.
Default save directory: ${promptSafeJson(directory)}
Active downloads JSON: ${promptSafeJson(active)}
Recently finished downloads JSON: ${promptSafeJson(recent)}
Rules: progressing, paused, cancelling, and interrupted active items are not complete. Do not click the same download again while a matching active item exists. A recent item with state="completed" proves completion at its exact save_path. Important terminal/interrupted state changes also wake you through an APP_SIGNAL. Use browser_download_manage only when the CURRENT user explicitly requests pause, resume, cancel, or retry, and only with the exact id plus an action listed in available_actions; never call it just to query status. A retry is a new attempt linked by retry_of and may have a different collision-safe save_path. Finished entries remain available to you for ${retentionMs} ms and then disappear automatically.
</browser-downloads>`
}

export function formatBackgroundBrowserDownloadJobs(snapshot) {
  const jobs = (Array.isArray(snapshot?.jobs) ? snapshot.jobs : [])
    .filter(job => job?.type === 'browser_download')
    .slice(-MAX_CONTEXT_DOWNLOADS)
    .map(backgroundJobContextRecord)
  if (jobs.length === 0) return ''
  return `<background-browser-download-jobs>
This is authoritative background task state automatically supplied by BaiLongma. It is available without a tool call and is independent from the main Agent turn.
Jobs JSON: ${promptSafeJson(jobs)}
Rules: queued/navigating/downloading/paused/waiting_user/interrupted are not completed. completed includes the final exact save_path. Ordinary progress never requires a chat update. Important completion/failure/interruption/user-decision events are separately delivered once through APP_SIGNAL. Terminal task context is retained for at least ${safeNumber(snapshot.retentionMs)} ms.
</background-browser-download-jobs>`
}

export function formatBrowserDownloadContext(
  bridge = globalThis.bailongmaChromeBridge,
  jobManager = getBackgroundJobManager(),
) {
  const parts = []
  try {
    if (typeof bridge?.getDownloads === 'function') {
      const snapshot = bridge.getDownloads()
      if (!snapshot || typeof snapshot.then !== 'function') parts.push(formatBrowserDownloadSnapshot(snapshot))
    }
  } catch {}
  try { parts.push(formatBackgroundBrowserDownloadJobs(jobManager?.contextSnapshot?.())) } catch {}
  return parts.filter(Boolean).join('\n\n')
}
