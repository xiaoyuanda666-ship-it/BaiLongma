import assert from 'node:assert/strict'
import {
  createBrowserDownloadEventHandler,
  notifyBrowserDownloadJobImportantEvent,
} from './browser-download-events.js'
import { BackgroundJobManager } from './background-job-manager.js'

const messages = []
const events = []
let clock = Date.parse('2026-08-22T02:00:00.000Z')
const handle = createBrowserDownloadEventHandler({
  now: () => clock,
  pushMessageFn: (...args) => messages.push(args),
  emitEventFn: (type, data) => events.push({ type, data }),
})

const base = {
  id: 'download-7',
  event: 'started',
  state: 'progressing',
  filename: 'Doubao.dmg',
  path: '/Users/test/Downloads/Doubao.dmg',
  receivedBytes: 0,
  totalBytes: 100,
  percent: 0,
  availableActions: ['pause', 'cancel'],
  notification: {
    targetId: 'ID:download-user',
    channel: 'WECHAT',
    externalPartyId: 'wechat:download-user',
    voiceReply: false,
  },
}

assert.equal(handle(base), true)
assert.equal(messages.length, 0, 'starting a download updates UI/context without waking the Agent')
assert.equal(events.at(-1).type, 'browser_download_started')
assert.equal(Object.hasOwn(events.at(-1).data, 'notification'), false, 'UI events do not expose delivery routing metadata')

clock += 1_000
handle({ ...base, event: 'updated', receivedBytes: 50, percent: 50 })
assert.equal(messages.length, 0, 'ordinary progress never queues an APP_SIGNAL')
assert.equal(events.at(-1).type, 'browser_download_progress')

clock += 1_000
const completed = {
  ...base,
  event: 'done',
  state: 'completed',
  receivedBytes: 100,
  percent: 100,
  availableActions: ['retry'],
}
handle(completed)
assert.equal(messages.length, 1, 'completion actively queues one Agent wake-up')
assert.equal(events.at(-1).type, 'browser_download_completed')
const [fromId, content, channel, metadata] = messages[0]
assert.equal(fromId, 'SYSTEM')
assert.equal(channel, 'APP_SIGNAL')
assert.match(content, /download completed/i)
assert.match(content, /\/Users\/test\/Downloads\/Doubao\.dmg/)
assert.match(content, /Do not pause, resume, cancel, or retry from this signal alone/)
assert.deepEqual(metadata, {
  queue: 'background',
  priority: 40,
  persist: false,
  notificationTargetId: 'ID:download-user',
  notificationChannel: 'WECHAT',
  notificationExternalPartyId: 'wechat:download-user',
  notificationVoiceReply: false,
  browserDownloadId: 'download-7',
  browserDownloadState: 'completed',
})
handle(completed)
assert.equal(messages.length, 1, 'duplicate terminal events are de-duplicated')

const interrupted = {
  ...base,
  id: 'download-8',
  event: 'updated',
  state: 'interrupted',
  receivedBytes: 40,
  percent: 40,
  canResume: true,
  interruptionCount: 1,
  availableActions: ['resume', 'cancel', 'retry'],
}
handle(interrupted)
handle(interrupted)
assert.equal(messages.length, 2, 'one interruption count produces one notification')
handle({ ...interrupted, interruptionCount: 2 })
assert.equal(messages.length, 3, 'a later independent interruption can notify again')

handle({ ...base, id: 'download-9', event: 'control', state: 'paused' })
assert.equal(messages.length, 3, 'pause confirmation stays in the current tool turn')
assert.equal(events.at(-1).type, 'browser_download_paused')

handle({ ...base, id: 'download-9', event: 'done', state: 'cancelled', availableActions: ['retry'] })
assert.equal(messages.length, 4, 'terminal cancellation actively confirms completion of cancellation')
assert.equal(events.at(-1).type, 'browser_download_cancelled')

handle({
  ...base,
  id: 'download-10',
  event: 'done',
  state: 'cancelled',
  cancelRequestedByManager: true,
  availableActions: ['retry'],
})
assert.equal(messages.length, 4,
  'a cancellation already returned by browser_download_manage does not queue a duplicate Agent wake-up')
assert.equal(events.at(-1).type, 'browser_download_cancelled')

assert.equal(handle(null), false)
assert.equal(handle({ state: 'completed' }), false)

const jobMessages = []
const jobEvents = []
const jobManager = new BackgroundJobManager({
  idFactory: () => 'bg-download-event-1',
  loadSnapshot: () => [],
  saveSnapshot: () => {},
  emitEventFn: () => {},
})
jobManager.createJob({
  type: 'browser_download', target: 'CapCut', channel: 'TUI', targetId: 'ID:job-user',
})
const handleJobEvent = createBrowserDownloadEventHandler({
  jobManager,
  pushMessageFn: (...args) => jobMessages.push(args),
  emitEventFn: (type, data) => jobEvents.push({ type, data }),
})
handleJobEvent({
  ...base,
  jobId: 'bg-download-event-1',
  id: 'download-job-1',
  notification: { ...base.notification, jobId: 'bg-download-event-1' },
})
assert.equal(jobMessages.length, 0)
assert.equal(jobManager.getJob('bg-download-event-1').downloadId, 'download-job-1')
assert.equal(jobEvents.at(-1).data.job_id, 'bg-download-event-1')
assert.equal(jobEvents.at(-1).data.runtime_lane, 'background')
handleJobEvent({
  ...completed,
  jobId: 'bg-download-event-1',
  id: 'download-job-1',
  path: '/Users/test/Downloads/CapCut.dmg',
  notification: { ...base.notification, jobId: 'bg-download-event-1' },
})
handleJobEvent({
  ...completed,
  jobId: 'bg-download-event-1',
  id: 'download-job-1',
  path: '/Users/test/Downloads/CapCut.dmg',
  notification: { ...base.notification, jobId: 'bg-download-event-1' },
})
assert.equal(jobMessages.length, 1, 'job-level completion notification is persisted and emitted once')
assert.equal(jobMessages[0][3].backgroundJobId, 'bg-download-event-1')
assert.match(jobMessages[0][1], /\/Users\/test\/Downloads\/CapCut\.dmg/)

jobManager.updateJob('bg-download-event-1', {
  state: 'failed',
  downloadId: null,
  attempt: 2,
  error: { code: 'DOWNLOAD_ENTRY_NOT_REACHED', message: 'attempt two failed' },
})
assert.equal(notifyBrowserDownloadJobImportantEvent(
  jobManager.getJob('bg-download-event-1'),
  'failed',
  { jobManager, pushMessageFn: (...args) => jobMessages.push(args) },
), true)
assert.equal(notifyBrowserDownloadJobImportantEvent(
  jobManager.getJob('bg-download-event-1'),
  'failed',
  { jobManager, pushMessageFn: (...args) => jobMessages.push(args) },
), false, 'the same failed attempt notifies only once')
jobManager.updateJob('bg-download-event-1', { state: 'failed', attempt: 3 })
assert.equal(notifyBrowserDownloadJobImportantEvent(
  jobManager.getJob('bg-download-event-1'),
  'failed',
  { jobManager, pushMessageFn: (...args) => jobMessages.push(args) },
), true, 'a later retry attempt can notify its own failure once')

console.log('browser download event tests passed')
