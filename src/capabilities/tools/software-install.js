import crypto from 'crypto'
import { spawn, spawnSync } from 'child_process'
import { emitEvent } from '../../events.js'
import { insertActionLog, getConfig, setConfig } from '../../db.js'
import { pushMessage } from '../../queue.js'
import { PRIMARY_USER_ID } from '../../identity.js'
import { projectInstallJobToScene } from './software-install-scene.js'

const IS_WIN = process.platform === 'win32'
const OUTPUT_MAX = 256 * 1024
const JOB_RETAIN_TERMINAL_MS = 30 * 60 * 1000
const JOB_MAX_ENTRIES = 50
const JOB_SNAPSHOT_CONFIG_KEY = 'software_install_jobs'
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'needs_attention', 'cancelled'])
const ACTIVE_STATUSES = new Set(['started', 'checking_winget', 'searching', 'inspecting', 'installing', 'running'])
const ATTENTION_REASONS = new Set(['needs_elevation', 'needs_user_confirmation', 'needs_confirmation_or_timed_out'])

const PACKAGE_ALIASES = [
  {
    patterns: [/^(qq|\u817e\u8baf\s*qq|tencent\s*qq)$/i],
    ids: ['Tencent.QQ.NT', 'Tencent.QQ'],
  },
  {
    patterns: [/^(tim|\u817e\u8baf\s*tim)$/i],
    ids: ['Tencent.TIM'],
  },
  {
    patterns: [/^(wechat|weixin|\u5fae\u4fe1|\u5fae\u4fe1\u7535\u8111\u7248)$/i],
    ids: ['Tencent.WeChat'],
  },
]

const softwareInstallJobs = new Map()
const activeJobKeys = new Map()

let defaultWingetRunner = (args = [], opts = {}) => runProcess('winget', args, opts)
let notificationSink = enqueueAgentNotification
let sideEffectsEnabled = true

function toolJson(payload) {
  return JSON.stringify(payload, null, 2)
}

function nowIso() {
  return new Date().toISOString()
}

function cleanText(value = '') {
  return String(value || '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r(?!\n)/g, '\n')
}

function appendBounded(current, chunk) {
  const next = current + chunk
  return next.length > OUTPUT_MAX ? next.slice(-OUTPUT_MAX) : next
}

function truncateText(value = '', max = 4000) {
  const text = cleanText(value)
  if (text.length <= max) return text
  const headLen = Math.floor(max * 0.25)
  const tailLen = max - headLen
  return `${text.slice(0, headLen)}\n\n[output truncated: ${text.length - max} chars omitted]\n\n${text.slice(-tailLen)}`
}

function summarizeOutput(stdout = '', stderr = '', max = 1800) {
  const text = cleanText([stdout, stderr].filter(Boolean).join('\n')).trim()
  if (!text) return ''
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  return truncateText(lines.slice(-12).join('\n'), max)
}

function terminateProcessTree(child, pid = child?.pid) {
  if (!pid) {
    try { child?.kill?.() } catch {}
    return
  }
  if (IS_WIN) {
    try {
      spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      return
    } catch {}
  }
  try { child?.kill?.() } catch {}
}

function runProcess(command, args = [], { timeoutSec = 120, signal } = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, exit_code: null, stdout: '', stderr: '', timed_out: false, aborted: true, error: 'aborted before start' })
      return
    }

    let child
    try {
      child = spawn(command, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve({ ok: false, exit_code: null, stdout: '', stderr: '', timed_out: false, error: err.message })
      return
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false

    const finish = (payload) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      resolve(payload)
    }

    const onAbort = () => {
      terminateProcessTree(child)
      finish({
        ok: false,
        exit_code: null,
        stdout: cleanText(stdout),
        stderr: cleanText(stderr),
        timed_out: false,
        aborted: true,
        error: 'aborted',
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      terminateProcessTree(child)
      finish({
        ok: false,
        exit_code: null,
        stdout: cleanText(stdout),
        stderr: cleanText(stderr),
        timed_out: true,
        error: `timed out after ${timeoutSec}s`,
      })
    }, Math.max(1, timeoutSec) * 1000)

    signal?.addEventListener?.('abort', onAbort, { once: true })

    child.stdout?.on('data', chunk => { if (!timedOut) stdout = appendBounded(stdout, chunk) })
    child.stderr?.on('data', chunk => { if (!timedOut) stderr = appendBounded(stderr, chunk) })
    child.on('error', err => {
      finish({
        ok: false,
        exit_code: null,
        stdout: cleanText(stdout),
        stderr: cleanText(stderr),
        timed_out: false,
        error: err.message,
      })
    })
    child.on('close', code => {
      if (timedOut) return
      finish({
        ok: code === 0,
        exit_code: code,
        stdout: cleanText(stdout),
        stderr: cleanText(stderr),
        timed_out: false,
        error: code === 0 ? null : `command exited with code ${code}`,
      })
    })
  })
}

async function runWinget(args = [], opts = {}) {
  const runner = opts.runner || defaultWingetRunner
  return await runner(args, opts)
}

function looksLikePackageId(value = '') {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]+\.[A-Za-z0-9][A-Za-z0-9_.-]+$/.test(String(value || '').trim())
}

export function parseWingetSearchOutput(output = '') {
  const lines = cleanText(output)
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(Boolean)
  const results = []
  let inRows = false
  for (const line of lines) {
    if (/^-{3,}/.test(line.replace(/\s/g, ''))) {
      inRows = true
      continue
    }
    if (!inRows || /^Name\s+Id\s+Version/i.test(line)) continue
    const match = line.match(/^(.+?)\s{2,}([A-Za-z0-9][A-Za-z0-9_.-]+\.[A-Za-z0-9][A-Za-z0-9_.-]+)\s{2,}(\S+)/)
    if (!match) continue
    results.push({
      name: match[1].trim(),
      id: match[2].trim(),
      version: match[3].trim(),
    })
  }
  return results
}

function aliasIdsFor(query = '') {
  const q = String(query || '').trim()
  const hit = PACKAGE_ALIASES.find(alias => alias.patterns.some(pattern => pattern.test(q)))
  return hit ? hit.ids : []
}

function uniqueIds(ids = []) {
  const seen = new Set()
  const out = []
  for (const id of ids) {
    const clean = String(id || '').trim()
    if (!clean || seen.has(clean.toLowerCase())) continue
    seen.add(clean.toLowerCase())
    out.push(clean)
  }
  return out
}

export function resolveInitialWingetCandidateIds({ query = '', package_id = '' } = {}) {
  const ids = []
  if (looksLikePackageId(package_id)) ids.push(package_id)
  ids.push(...aliasIdsFor(query))
  if (looksLikePackageId(query)) ids.push(query)
  return uniqueIds(ids)
}

function mergeCandidateIds(initial = [], searched = []) {
  return uniqueIds([
    ...initial,
    ...searched.map(r => r.id),
  ])
}

function collectDedupeKeys({ query = '', package_id = '', initialIds = [] } = {}) {
  return uniqueIds([
    query,
    package_id,
    ...initialIds,
  ]).map(v => v.toLowerCase())
}

function findActiveDuplicate(keys = []) {
  for (const key of keys) {
    const id = activeJobKeys.get(key)
    if (!id) continue
    const job = softwareInstallJobs.get(id)
    if (job && ACTIVE_STATUSES.has(job.status)) return job
  }
  return null
}

function registerActiveKeys(job) {
  for (const key of job.dedupe_keys || []) activeJobKeys.set(key, job.job_id)
}

function releaseActiveKeys(job) {
  for (const key of job.dedupe_keys || []) {
    if (activeJobKeys.get(key) === job.job_id) activeJobKeys.delete(key)
  }
}

function summarizeWingetFailure(result) {
  const text = `${result?.stdout || ''}\n${result?.stderr || ''}\n${result?.error || ''}`.trim()
  if (result?.aborted) return 'cancelled'
  if (result?.timed_out) return 'needs_confirmation_or_timed_out'
  if (/0x80190194|404|not found/i.test(text)) return 'download_not_found'
  if (/No package found|No installed package found/i.test(text)) return 'no_package'
  if (/requires administrator|administrator privileges|run as administrator|elevation|elevated|UAC/i.test(text)) return 'needs_elevation'
  if (/requires user interaction|user interaction is required|interactive|prompt|confirm|confirmation|input is required|installer UI|another installation is in progress/i.test(text)) return 'needs_user_confirmation'
  if (/cancelled|canceled|user cancelled|user canceled|operation was canceled|\u7528\u6237\u53d6\u6d88/i.test(text)) return 'cancelled'
  if (/already installed|No applicable update found|No newer package versions are available|already the latest|current version|\u5df2\u5b89\u88c5|\u5df2\u662f\u6700\u65b0|\u6ca1\u6709\u53ef\u7528\u7684\u66f4\u65b0|\u672a\u627e\u5230\u9002\u7528\u7684\u66f4\u65b0/i.test(text)) {
    return 'already_installed_or_current'
  }
  return 'install_failed'
}

function extractVersionFromShow(stdout = '') {
  const text = cleanText(stdout)
  const version = text.match(/^\s*Version:\s*(.+)$/mi)
  if (version?.[1]) return version[1].trim()
  const installerVersion = text.match(/^\s*Installer\s+Version:\s*(.+)$/mi)
  return installerVersion?.[1]?.trim() || ''
}

async function inspectCandidate(id, context = {}) {
  const show = await runWinget([
    'show',
    '--id', id,
    '--exact',
    '--source', 'winget',
    '--accept-source-agreements',
    '--disable-interactivity',
  ], { timeoutSec: 45, signal: context.signal, runner: context.runner })
  return {
    id,
    ok: show.ok,
    exit_code: show.exit_code,
    stdout: show.stdout,
    stderr: show.stderr,
    error: show.error,
    version: show.ok ? extractVersionFromShow(show.stdout) : '',
    output_summary: summarizeOutput(show.stdout, show.stderr),
  }
}

async function installCandidate(id, { silent = false } = {}, context = {}) {
  const args = [
    'install',
    '--id', id,
    '--exact',
    '--source', 'winget',
    '--accept-package-agreements',
    '--accept-source-agreements',
    '--disable-interactivity',
  ]
  if (silent) args.push('--silent')
  const result = await runWinget(args, { timeoutSec: 300, signal: context.signal, runner: context.runner })
  const reason = result.ok ? null : summarizeWingetFailure(result)
  const alreadyInstalled = reason === 'already_installed_or_current'
  return {
    id,
    command: `winget ${args.join(' ')}`,
    ok: result.ok || alreadyInstalled,
    already_installed_or_current: alreadyInstalled,
    exit_code: result.exit_code,
    stdout: result.stdout,
    stderr: result.stderr,
    output_summary: summarizeOutput(result.stdout, result.stderr),
    error: result.error,
    timed_out: result.timed_out === true,
    aborted: result.aborted === true,
    reason,
  }
}

function publicAttempt(attempt = {}) {
  return {
    id: attempt.id,
    command: attempt.command,
    ok: attempt.ok,
    already_installed_or_current: attempt.already_installed_or_current === true,
    exit_code: attempt.exit_code,
    reason: attempt.reason,
    error: attempt.error,
    timed_out: attempt.timed_out === true,
    output_summary: attempt.output_summary || summarizeOutput(attempt.stdout, attempt.stderr),
    stdout: truncateText(attempt.stdout || '', 2000),
    stderr: truncateText(attempt.stderr || '', 2000),
  }
}

function publicInspect(candidate = {}) {
  return {
    id: candidate.id,
    ok: candidate.ok,
    exit_code: candidate.exit_code,
    version: candidate.version || '',
    error: candidate.error,
    output_summary: candidate.output_summary || summarizeOutput(candidate.stdout, candidate.stderr),
  }
}

export function getSoftwareInstallJobSnapshot(jobOrId, { detail = true } = {}) {
  const job = typeof jobOrId === 'string' ? softwareInstallJobs.get(jobOrId) : jobOrId
  if (!job) return null
  const snapshot = {
    job_id: job.job_id,
    tool: 'install_software',
    ok: job.ok,
    status: job.status,
    phase: job.phase,
    query: job.query,
    requested_package_id: job.requested_package_id || null,
    package_id: job.package_id || null,
    selected_package_id: job.selected_package_id || null,
    version: job.version || '',
    winget_version: job.winget_version || '',
    silent: job.silent === true,
    candidates: job.candidates || [],
    reason: job.reason || null,
    error: job.error || null,
    exit_code: job.exit_code ?? null,
    already_installed_or_current: job.already_installed_or_current === true,
    message: job.message || '',
    started_at: job.started_at,
    updated_at: job.updated_at,
    completed_at: job.completed_at || null,
    notify_target_id: job.notify_target_id || PRIMARY_USER_ID,
    notification_sent: job.notification_sent === true,
  }
  if (detail) {
    snapshot.search_results = job.search_results || []
    snapshot.inspected = (job.inspected || []).map(publicInspect)
    snapshot.attempts = (job.attempts || []).map(publicAttempt)
  }
  return snapshot
}

export function listSoftwareInstallJobs({ includeTerminal = true, detail = false } = {}) {
  const jobs = [...softwareInstallJobs.values()]
    .filter(job => includeTerminal || !TERMINAL_STATUSES.has(job.status))
    .sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')))
    .map(job => getSoftwareInstallJobSnapshot(job, { detail }))
  return jobs
}

function persistJobSnapshots() {
  if (!sideEffectsEnabled) return
  try {
    const snapshots = [...softwareInstallJobs.values()]
      .sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')))
      .slice(0, JOB_MAX_ENTRIES)
      .map(job => getSoftwareInstallJobSnapshot(job, { detail: true }))
    setConfig(JOB_SNAPSHOT_CONFIG_KEY, JSON.stringify(snapshots))
  } catch (err) {
    console.warn(`[install_software] failed to persist job snapshots: ${err.message}`)
  }
}

function loadPersistedSnapshotsOnce() {
  if (!sideEffectsEnabled) {
    loadPersistedSnapshotsOnce.done = true
    return
  }
  if (loadPersistedSnapshotsOnce.done) return
  loadPersistedSnapshotsOnce.done = true
  try {
    const raw = getConfig(JOB_SNAPSHOT_CONFIG_KEY)
    if (!raw) return
    const snapshots = JSON.parse(raw)
    if (!Array.isArray(snapshots)) return
    for (const snapshot of snapshots.slice(0, JOB_MAX_ENTRIES)) {
      if (!snapshot?.job_id || softwareInstallJobs.has(snapshot.job_id)) continue
      softwareInstallJobs.set(snapshot.job_id, {
        ...snapshot,
        dedupe_keys: collectDedupeKeys({
          query: snapshot.query,
          package_id: snapshot.requested_package_id || snapshot.package_id,
          initialIds: snapshot.candidates || [],
        }),
        persisted_only: true,
      })
    }
  } catch (err) {
    console.warn(`[install_software] failed to load persisted job snapshots: ${err.message}`)
  }
}
loadPersistedSnapshotsOnce.done = false

function pruneJobs() {
  if (softwareInstallJobs.size <= JOB_MAX_ENTRIES) return
  const terminal = [...softwareInstallJobs.values()]
    .filter(job => TERMINAL_STATUSES.has(job.status))
    .sort((a, b) => String(a.completed_at || a.updated_at || '').localeCompare(String(b.completed_at || b.updated_at || '')))
  while (softwareInstallJobs.size > JOB_MAX_ENTRIES && terminal.length) {
    softwareInstallJobs.delete(terminal.shift().job_id)
  }
}

function updateJob(job, patch = {}) {
  Object.assign(job, patch, { updated_at: nowIso() })
  softwareInstallJobs.set(job.job_id, job)
  persistJobSnapshots()
  const snapshot = getSoftwareInstallJobSnapshot(job, { detail: false })
  emitEvent('software_install_job_update', snapshot)
  // 把 job 状态投影成 Scene 的 progress 卡(声明式 UI)。测试态关副作用,不碰全局 sceneStore。
  if (sideEffectsEnabled) projectInstallJobToScene(snapshot)
}

function writeInstallActionLog(job, status = 'ok') {
  if (!sideEffectsEnabled) return
  try {
    const snapshot = getSoftwareInstallJobSnapshot(job, { detail: false })
    insertActionLog({
      timestamp: job.completed_at || job.updated_at || nowIso(),
      tool: 'install_software',
      summary: `install_software(${job.query || job.requested_package_id || job.package_id || job.job_id})`,
      detail: `job_id=${job.job_id} status=${job.status} package_id=${job.selected_package_id || job.package_id || ''} reason=${job.reason || ''}`,
      status,
      risk: 'high',
      argsJson: JSON.stringify({
        query: job.query,
        package_id: job.requested_package_id,
        silent: job.silent === true,
        job_id: job.job_id,
      }),
      resultPreview: JSON.stringify(snapshot).slice(0, 220),
      error: job.ok === false ? (job.error || job.reason || '') : '',
      durationMs: Date.parse(job.completed_at || job.updated_at || nowIso()) - Date.parse(job.started_at || nowIso()),
      source: 'background',
    })
  } catch (err) {
    console.warn(`[install_software] failed to write action log: ${err.message}`)
  }
}

function makeAgentSignal(job) {
  const snapshot = getSoftwareInstallJobSnapshot(job, { detail: true })
  const instruction = [
    '[background package job result]',
    `job_id: ${job.job_id}`,
    `target_user: ${job.notify_target_id || PRIMARY_USER_ID}`,
    `status: ${job.status}`,
    `summary: ${job.message || job.error || job.reason || ''}`,
    '',
    'This is a completion signal for a package job the user asked for earlier.',
    'Do not start another package action for this job.',
    'Notify the target user once with the result unless the result is already visible and no user-facing message is needed.',
    '',
    JSON.stringify(snapshot, null, 2),
  ]
  return instruction.join('\n')
}

function enqueueAgentNotification(job) {
  pushMessage('SYSTEM', makeAgentSignal(job), 'APP_SIGNAL', {
    queue: 'background',
    persist: false,
    notificationTargetId: job.notify_target_id || PRIMARY_USER_ID,
    notificationChannel: job.notify_channel || 'AUTO',
    notificationExternalPartyId: job.notify_external_party_id || null,
    softwareInstallJobId: job.job_id,
  })
}

function notifyJobFinished(job) {
  if (job.notification_sent) return
  try {
    notificationSink(job)
    job.notification_sent = true
    job.updated_at = nowIso()
    persistJobSnapshots()
  } catch (err) {
    console.warn(`[install_software] failed to enqueue completion notification: ${err.message}`)
  }
}

function finishJob(job, status, patch = {}) {
  const completedAt = nowIso()
  updateJob(job, {
    ...patch,
    status,
    phase: status,
    ok: status === 'succeeded',
    completed_at: completedAt,
  })
  releaseActiveKeys(job)
  writeInstallActionLog(job, job.ok === false ? 'error' : 'ok')
  emitEvent(`software_install_job_${status}`, getSoftwareInstallJobSnapshot(job, { detail: true }))
  emitEvent('action', {
    tool: 'install_software',
    summary: job.message || `software install job ${status}`,
    detail: job.job_id,
  })
  notifyJobFinished(job)
  const cleanup = setTimeout(() => {
    const current = softwareInstallJobs.get(job.job_id)
    if (current && TERMINAL_STATUSES.has(current.status)) {
      softwareInstallJobs.delete(job.job_id)
      persistJobSnapshots()
    }
  }, JOB_RETAIN_TERMINAL_MS)
  cleanup.unref?.()
  pruneJobs()
}

async function runInstallJob(job) {
  const runContext = { signal: job.abortController.signal, runner: job.runner }
  try {
    updateJob(job, { status: 'checking_winget', phase: 'checking_winget', message: 'Checking winget availability.' })
    const wingetVersion = await runWinget(['--version'], { timeoutSec: 15, signal: runContext.signal, runner: runContext.runner })
    if (!wingetVersion.ok) {
      finishJob(job, 'failed', {
        reason: 'winget_unavailable',
        error: 'winget is not available',
        exit_code: wingetVersion.exit_code,
        message: 'winget is not available; package job could not start.',
        attempts: [],
        winget: wingetVersion,
      })
      return
    }
    updateJob(job, { winget_version: wingetVersion.stdout.trim() })

    let searchResults = []
    if (job.query) {
      updateJob(job, { status: 'searching', phase: 'searching', message: `Searching winget for ${job.query}.` })
      const search = await runWinget([
        'search',
        job.query,
        '--source', 'winget',
        '--accept-source-agreements',
        '--disable-interactivity',
      ], { timeoutSec: 45, signal: runContext.signal, runner: runContext.runner })
      searchResults = search.ok ? parseWingetSearchOutput(search.stdout) : []
      updateJob(job, {
        search_results: searchResults,
        search_error: search.ok ? null : (search.error || summarizeOutput(search.stdout, search.stderr)),
      })
    }

    const candidateIds = mergeCandidateIds(job.initial_ids, searchResults)
    updateJob(job, { candidates: candidateIds })
    if (candidateIds.length === 0) {
      finishJob(job, 'failed', {
        reason: 'no_candidates',
        error: 'no winget package candidates found',
        message: `No winget package candidates found for ${job.query || job.requested_package_id}.`,
      })
      return
    }

    const inspected = []
    const attempts = []
    for (const id of candidateIds.slice(0, 6)) {
      updateJob(job, { status: 'inspecting', phase: 'inspecting', package_id: id, message: `Inspecting ${id}.` })
      const candidate = await inspectCandidate(id, runContext)
      inspected.push(candidate)
      updateJob(job, { inspected })
      if (!candidate.ok) continue

      updateJob(job, {
        status: 'installing',
        phase: 'installing',
        package_id: id,
        selected_package_id: id,
        version: candidate.version || '',
        message: `Installing ${id} in the background.`,
      })
      const attempt = await installCandidate(id, { silent: job.silent }, runContext)
      attempts.push(attempt)
      updateJob(job, { attempts, exit_code: attempt.exit_code ?? null })
      if (attempt.ok) {
        const already = attempt.already_installed_or_current === true
        finishJob(job, 'succeeded', {
          package_id: id,
          selected_package_id: id,
          version: candidate.version || '',
          already_installed_or_current: already,
          reason: already ? 'already_installed_or_current' : null,
          exit_code: attempt.exit_code,
          message: already
            ? `${id} is already installed or current.`
            : `Installed ${id}${candidate.version ? ` ${candidate.version}` : ''} with winget.`,
        })
        return
      }

      if (ATTENTION_REASONS.has(attempt.reason)) {
        finishJob(job, 'needs_attention', {
          package_id: id,
          selected_package_id: id,
          reason: attempt.reason,
          error: attempt.error || attempt.output_summary || attempt.reason,
          exit_code: attempt.exit_code,
          message: `${id} needs user attention: ${attempt.reason}.`,
        })
        return
      }

      if (attempt.reason === 'cancelled') {
        finishJob(job, 'cancelled', {
          package_id: id,
          selected_package_id: id,
          reason: attempt.reason,
          error: attempt.error || attempt.output_summary || attempt.reason,
          exit_code: attempt.exit_code,
          message: `${id} installation was cancelled.`,
        })
        return
      }
    }

    const lastAttempt = attempts[attempts.length - 1]
    finishJob(job, 'failed', {
      reason: 'all_candidates_failed',
      error: lastAttempt?.error || lastAttempt?.output_summary || 'all winget candidates failed',
      exit_code: lastAttempt?.exit_code ?? null,
      message: `All winget candidates failed for ${job.query || job.requested_package_id}.`,
    })
  } catch (err) {
    const aborted = err?.name === 'AbortError' || job.abortController.signal.aborted
    finishJob(job, aborted ? 'cancelled' : 'failed', {
      reason: aborted ? 'cancelled' : 'job_error',
      error: err?.message || String(err),
      message: aborted ? 'Software install job was cancelled.' : `Software install job failed: ${err?.message || err}`,
    })
  }
}

function startBackgroundInstallJob(job) {
  const t = setTimeout(() => {
    runInstallJob(job).catch(err => {
      finishJob(job, 'failed', {
        reason: 'job_error',
        error: err?.message || String(err),
        message: `Software install job failed: ${err?.message || err}`,
      })
    })
  }, 0)
  return t
}

export async function execInstallSoftware(args = {}, context = {}) {
  loadPersistedSnapshotsOnce()
  if (!IS_WIN && context.allowNonWindowsForTest !== true) {
    return toolJson({
      ok: false,
      tool: 'install_software',
      error: 'install_software currently supports Windows winget only',
    })
  }

  const query = String(args.query || args.name || '').trim()
  const packageId = String(args.package_id || args.id || '').trim()
  const silent = args.silent === true
  if (!query && !packageId) {
    return toolJson({ ok: false, tool: 'install_software', error: 'query or package_id is required' })
  }

  const initialIds = resolveInitialWingetCandidateIds({ query, package_id: packageId })
  const dedupeKeys = collectDedupeKeys({ query, package_id: packageId, initialIds })
  const duplicate = findActiveDuplicate(dedupeKeys)
  if (duplicate) {
    const snapshot = getSoftwareInstallJobSnapshot(duplicate, { detail: false })
    return toolJson({
      ok: true,
      tool: 'install_software',
      status: 'already_running',
      job_id: duplicate.job_id,
      package_id: duplicate.package_id || duplicate.requested_package_id || null,
      query: duplicate.query,
      message: `A background install job is already running for ${duplicate.query || duplicate.requested_package_id}; not starting a duplicate.`,
      job: snapshot,
    })
  }

  const jobId = `sw_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`
  const displayName = query || packageId
  const job = {
    job_id: jobId,
    query,
    requested_package_id: packageId || null,
    package_id: packageId || initialIds[0] || null,
    selected_package_id: null,
    initial_ids: initialIds,
    dedupe_keys: dedupeKeys,
    silent,
    status: 'started',
    phase: 'started',
    ok: null,
    reason: null,
    error: null,
    exit_code: null,
    version: '',
    candidates: initialIds,
    search_results: [],
    inspected: [],
    attempts: [],
    already_installed_or_current: false,
    started_at: nowIso(),
    updated_at: nowIso(),
    completed_at: null,
    message: `\u5df2\u5728\u540e\u53f0\u5f00\u59cb\u5b89\u88c5 ${displayName}\uff0c\u5b8c\u6210\u540e\u4f1a\u81ea\u52a8\u901a\u77e5\u3002`,
    notify_target_id: context.currentTargetId || PRIMARY_USER_ID,
    notify_channel: context.currentChannel || 'AUTO',
    notify_external_party_id: context.currentExternalPartyId || null,
    notification_sent: false,
    abortController: new AbortController(),
    runner: context.wingetRunner || defaultWingetRunner,
  }

  softwareInstallJobs.set(job.job_id, job)
  registerActiveKeys(job)
  persistJobSnapshots()
  writeInstallActionLog(job, 'ok')
  emitEvent('software_install_job_started', getSoftwareInstallJobSnapshot(job, { detail: false }))
  // 起手就投影一张进度卡(started 阶段不走 updateJob,这里单独投一次)。
  if (sideEffectsEnabled) projectInstallJobToScene(getSoftwareInstallJobSnapshot(job, { detail: false }))
  emitEvent('action', {
    tool: 'install_software',
    summary: job.message,
    detail: job.job_id,
  })
  startBackgroundInstallJob(job)

  return toolJson({
    ok: true,
    tool: 'install_software',
    status: 'started',
    job_id: job.job_id,
    package_id: job.package_id,
    query,
    silent,
    message: job.message,
    hint: 'The install is running in the background. Do not call install_software again for the same app; use list_processes to inspect software_install_jobs if you need status.',
  })
}

export const __softwareInstallTestHooks = {
  setWingetRunner(fn) {
    defaultWingetRunner = typeof fn === 'function' ? fn : ((args = [], opts = {}) => runProcess('winget', args, opts))
  },
  setNotificationSink(fn) {
    notificationSink = typeof fn === 'function' ? fn : enqueueAgentNotification
  },
  reset() {
    softwareInstallJobs.clear()
    activeJobKeys.clear()
    defaultWingetRunner = (args = [], opts = {}) => runProcess('winget', args, opts)
    notificationSink = enqueueAgentNotification
    sideEffectsEnabled = false
    loadPersistedSnapshotsOnce.done = true
  },
  setSideEffectsEnabled(value) {
    sideEffectsEnabled = value === true
  },
}
