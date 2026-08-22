import assert from 'node:assert/strict'
import { BackgroundJobManager } from './background-job-manager.js'

let clock = Date.parse('2026-08-23T01:00:00.000Z')
let persisted = []
const events = []
const manager = new BackgroundJobManager({
  now: () => clock,
  idFactory: () => 'bg-download-1',
  loadSnapshot: () => persisted,
  saveSnapshot: snapshot => { persisted = structuredClone(snapshot) },
  emitEventFn: (type, data) => events.push({ type, data }),
})

const job = manager.createJob({
  type: 'browser_download',
  target: 'CapCut',
  channel: 'TUI',
  targetId: 'ID:download-user',
})
assert.deepEqual({
  jobId: job.jobId,
  type: job.type,
  state: job.state,
  target: job.target,
  channel: job.channel,
  downloadId: job.downloadId,
  error: job.error,
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
  completedAt: job.completedAt,
}, {
  jobId: 'bg-download-1',
  type: 'browser_download',
  state: 'queued',
  target: 'CapCut',
  channel: 'TUI',
  downloadId: null,
  error: null,
  createdAt: '2026-08-23T01:00:00.000Z',
  updatedAt: '2026-08-23T01:00:00.000Z',
  completedAt: null,
})
assert.equal(events.at(-1).type, 'background_job_update')
assert.equal(events.at(-1).data.runtime_lane, 'background')
assert.equal(events.at(-1).data.task_type, 'browser_download')

clock += 1_000
manager.updateJob(job.jobId, { state: 'navigating' })
clock += 1_000
manager.handleDownloadEvent({
  jobId: job.jobId,
  id: 'download-7',
  event: 'started',
  state: 'progressing',
  filename: 'CapCut.dmg',
  path: '/Users/test/Downloads/CapCut.dmg',
  receivedBytes: 0,
  totalBytes: 100,
  percent: 0,
  availableActions: ['pause', 'cancel'],
})
assert.equal(manager.getJob(job.jobId).state, 'downloading')
assert.equal(manager.getJob(job.jobId).downloadId, 'download-7')
assert.equal(manager.findByDownloadId('download-7')?.jobId, job.jobId)

clock += 1_000
manager.handleDownloadEvent({
  jobId: job.jobId,
  id: 'download-7',
  event: 'updated',
  state: 'paused',
  receivedBytes: 40,
  totalBytes: 100,
  percent: 40,
  availableActions: ['resume', 'cancel'],
})
assert.equal(manager.getJob(job.jobId).state, 'paused')
assert.equal(manager.getJob(job.jobId).percent, 40)

clock += 1_000
manager.handleDownloadEvent({
  jobId: job.jobId,
  id: 'download-7',
  event: 'done',
  state: 'completed',
  filename: 'CapCut.dmg',
  path: '/Users/test/Downloads/CapCut.dmg',
  receivedBytes: 100,
  totalBytes: 100,
  percent: 100,
  availableActions: ['retry'],
})
const completed = manager.getJob(job.jobId)
assert.equal(completed.state, 'completed')
assert.equal(completed.completedAt, '2026-08-23T01:00:04.000Z')
assert.equal(completed.path, '/Users/test/Downloads/CapCut.dmg')
assert.equal(manager.claimImportantNotification(job.jobId, 'completed:download-7'), true)
assert.equal(manager.claimImportantNotification(job.jobId, 'completed:download-7'), false,
  'one important event can be claimed only once')
assert.ok(persisted.some(item => item.jobId === job.jobId && item.state === 'completed'),
  'jobs and notification claims are persisted')

const controlManager = new BackgroundJobManager({
  now: () => clock,
  idFactory: () => 'bg-control-1',
  loadSnapshot: () => [],
  saveSnapshot: () => {},
  emitEventFn: () => {},
})
const controlJob = controlManager.createJob({ type: 'browser_download', target: '豆包', channel: 'TUI' })
controlManager.bindDownload(controlJob.jobId, { id: 'download-control-1', state: 'progressing', attempt: 1 })
assert.equal(controlManager.applyDownloadControl('download-control-1', 'pause').state, 'paused')
assert.equal(controlManager.applyDownloadControl('download-control-1', 'resume').state, 'downloading')
assert.equal(controlManager.applyDownloadControl('download-control-1', 'cancel').state, 'downloading',
  'cancellation remains non-terminal until Electron emits DownloadItem done')
controlManager.handleDownloadEvent({
  jobId: controlJob.jobId,
  id: 'download-control-1',
  event: 'done',
  state: 'cancelled',
  availableActions: ['retry'],
})
assert.equal(controlManager.getJob(controlJob.jobId).state, 'cancelled')
assert.equal(controlManager.applyDownloadControl('download-control-1', 'retry', { attempt: 2 }).state, 'queued')
assert.equal(controlManager.getJob(controlJob.jobId).downloadId, null)
assert.equal(controlManager.getJob(controlJob.jobId).attempt, 2)

const recoveryManager = new BackgroundJobManager({
  now: () => clock,
  loadSnapshot: () => [
    {
      jobId: 'bg-stale-download', type: 'browser_download', state: 'downloading', target: '豆包',
      channel: 'TUI', downloadId: 'download-stale', error: null,
      createdAt: '2026-08-23T00:00:00.000Z', updatedAt: '2026-08-23T00:01:00.000Z', completedAt: null,
    },
    {
      jobId: 'bg-finished-download', type: 'browser_download', state: 'completed', target: 'CapCut',
      channel: 'TUI', downloadId: 'download-finished', error: null,
      createdAt: '2026-08-23T00:50:00.000Z', updatedAt: '2026-08-23T00:59:00.000Z',
      completedAt: '2026-08-23T00:59:00.000Z',
    },
  ],
  saveSnapshot: () => {},
  emitEventFn: () => {},
})
const recovered = recoveryManager.recoverInterruptedJobs()
assert.deepEqual(recovered.map(item => item.jobId), ['bg-stale-download'])
assert.equal(recoveryManager.getJob('bg-stale-download').state, 'interrupted')
assert.equal(recoveryManager.getJob('bg-stale-download').error.code, 'RECOVERY_REQUIRED')
assert.equal(recoveryManager.getJob('bg-finished-download').state, 'completed')

console.log('background job manager tests passed')
