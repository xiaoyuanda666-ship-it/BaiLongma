import assert from 'node:assert/strict'
import { BackgroundJobManager } from './background-job-manager.js'
import { BrowserLeaseManager } from './runtime/browser-lease.js'
import { BrowserDownloadTaskRunner } from './browser-download-task-runner.js'
import {
  configureBrowserDownloadTaskStarter,
  execStartBrowserDownloadTask,
} from './capabilities/tools/browser-download-task.js'

const manager = new BackgroundJobManager({
  idFactory: () => 'bg-runner-1',
  loadSnapshot: () => [],
  saveSnapshot: () => {},
  emitEventFn: () => {},
})
const events = []
let captured = null
const runner = new BrowserDownloadTaskRunner({
  jobManager: manager,
  leaseManager: new BrowserLeaseManager(),
  emitEventFn: (type, data) => events.push({ type, data }),
  callLLMFn: async options => {
    captured = options
    assert.equal(options.silentSignal, true)
    assert.equal(options.mustReply, false)
    assert.equal(options.localReply, false)
    assert.equal(options.toolContext.outputContract, 'no_chat')
    assert.equal(options.toolContext.runtimeLane, 'background')
    assert.equal(options.toolContext.taskType, 'browser_download')
    assert.ok(options.tools.includes('browser_navigate'))
    assert.ok(options.tools.includes('browser_click'))
    assert.ok(options.tools.includes('browser_snapshot'))
    assert.ok(options.tools.includes('browser_wait_for'))
    assert.ok(!options.tools.includes('send_message'))
    assert.ok(!options.tools.includes('run_command'))
    assert.ok(!options.tools.includes('upsert_memory'))
    options.onToolExecute('browser_navigate', { url: 'https://www.capcut.com/' })
    options.onToolCall('browser_navigate', { url: 'https://www.capcut.com/' }, JSON.stringify({ ok: true }))
    manager.handleDownloadEvent({
      jobId: options.toolContext.browserDownloadJobId,
      id: 'download-runner-1',
      event: 'started',
      state: 'progressing',
      filename: 'CapCut.dmg',
      path: '/Users/test/Downloads/CapCut.dmg',
      availableActions: ['pause', 'cancel'],
    })
    options.onToolCall('browser_click', { element: '請按這裡' }, JSON.stringify({ ok: true }))
    return { content: '', toolResult: null, aborted: true, delivered: false }
  },
})

const job = manager.createJob({
  type: 'browser_download', target: 'CapCut', channel: 'TUI', targetId: 'ID:download-user',
})
await runner.run(job.jobId)
assert.ok(captured)
assert.equal(manager.getJob(job.jobId).state, 'downloading')
assert.equal(manager.getJob(job.jobId).downloadId, 'download-runner-1')
assert.ok(events.some(event => event.type === 'tool_executing'
  && event.data.job_id === job.jobId
  && event.data.runtime_lane === 'background'
  && event.data.task_type === 'browser_download'))
assert.ok(events.some(event => event.type === 'tool_call'
  && event.data.name === 'browser_click'
  && event.data.job_id === job.jobId))

let startedPayload = null
configureBrowserDownloadTaskStarter(async (args, context) => {
  startedPayload = { args, context }
  return { jobId: 'bg-start-tool-1', target: args.target }
})
const startResult = JSON.parse(await execStartBrowserDownloadTask({ target: '豆包' }, {
  currentTargetId: 'ID:download-user', currentChannel: 'TUI',
}))
assert.deepEqual(startResult, {
  ok: true,
  tool: 'start_browser_download_task',
  status: 'started',
  job_id: 'bg-start-tool-1',
  target: '豆包',
})
assert.equal(startedPayload.context.currentTargetId, 'ID:download-user')

let jobSequence = 0
const serialManager = new BackgroundJobManager({
  idFactory: () => `bg-serial-${++jobSequence}`,
  loadSnapshot: () => [],
  saveSnapshot: () => {},
  emitEventFn: () => {},
})
const serialCalls = []
const releases = new Map()
const serialRunner = new BrowserDownloadTaskRunner({
  jobManager: serialManager,
  leaseManager: new BrowserLeaseManager(),
  emitEventFn: () => {},
  notifyImportantFn: () => {},
  callLLMFn: options => new Promise(resolve => {
    const id = options.toolContext.browserDownloadJobId
    serialCalls.push(id)
    releases.set(id, () => {
      serialManager.handleDownloadEvent({
        jobId: id,
        id: `download-${id}`,
        event: 'started',
        state: 'progressing',
        filename: `${id}.dmg`,
        path: `/Users/test/Downloads/${id}.dmg`,
      })
      resolve({ content: '', aborted: false, delivered: false })
    })
  }),
})
const serialJob1 = serialManager.createJob({ type: 'browser_download', target: '豆包', channel: 'TUI' })
const serialJob2 = serialManager.createJob({ type: 'browser_download', target: 'CapCut', channel: 'TUI' })
const serialRun1 = serialRunner.run(serialJob1.jobId)
const serialRun2 = serialRunner.run(serialJob2.jobId)
await new Promise(resolve => setImmediate(resolve))
assert.deepEqual(serialCalls, [serialJob1.jobId], 'the second browser download task waits for the shared browser')
releases.get(serialJob1.jobId)()
await serialRun1
await new Promise(resolve => setImmediate(resolve))
assert.deepEqual(serialCalls, [serialJob1.jobId, serialJob2.jobId])
releases.get(serialJob2.jobId)()
await serialRun2

let waitingSequence = 0
const waitingManager = new BackgroundJobManager({
  idFactory: () => `bg-waiting-${++waitingSequence}`,
  loadSnapshot: () => [],
  saveSnapshot: () => {},
  emitEventFn: () => {},
})
const waitingNotifications = []
const loginRunner = new BrowserDownloadTaskRunner({
  jobManager: waitingManager,
  leaseManager: new BrowserLeaseManager(),
  emitEventFn: () => {},
  notifyImportantFn: (waitingJob, event) => waitingNotifications.push({ waitingJob, event }),
  callLLMFn: async options => {
    options.onToolCall('browser_snapshot', {}, JSON.stringify({
      ok: false,
      structured_content: { code: 'USER_LOGIN_REQUIRED', user_action_required: true },
    }))
    return { content: '', aborted: true, delivered: false }
  },
})
const loginJob = waitingManager.createJob({ type: 'browser_download', target: '豆包', channel: 'TUI' })
await loginRunner.run(loginJob.jobId)
assert.equal(waitingManager.getJob(loginJob.jobId).state, 'waiting_user')
assert.equal(waitingManager.getJob(loginJob.jobId).error.code, 'LOGIN_REQUIRED')
assert.deepEqual(waitingNotifications.map(item => item.event), ['needs_user'])

const captchaRunner = new BrowserDownloadTaskRunner({
  jobManager: waitingManager,
  leaseManager: new BrowserLeaseManager(),
  emitEventFn: () => {},
  notifyImportantFn: (waitingJob, event) => waitingNotifications.push({ waitingJob, event }),
  callLLMFn: async options => {
    options.onToolCall('browser_snapshot', {}, JSON.stringify({
      ok: false,
      structured_content: { code: 'BROWSER_CHALLENGE', user_action_required: true },
      error: 'CAPTCHA challenge page',
    }))
    return { content: '', aborted: true, delivered: false }
  },
})
const captchaJob = waitingManager.createJob({ type: 'browser_download', target: '马维斯', channel: 'TUI' })
await captchaRunner.run(captchaJob.jobId)
assert.equal(waitingManager.getJob(captchaJob.jobId).state, 'waiting_user')
assert.equal(waitingManager.getJob(captchaJob.jobId).error.code, 'CAPTCHA_REQUIRED')

const choiceRunner = new BrowserDownloadTaskRunner({
  jobManager: waitingManager,
  leaseManager: new BrowserLeaseManager(),
  emitEventFn: () => {},
  notifyImportantFn: (waitingJob, event) => waitingNotifications.push({ waitingJob, event }),
  callLLMFn: async () => ({
    content: '[NEEDS_USER: choose Apple Silicon or Intel package]',
    aborted: false,
    delivered: false,
  }),
})
const choiceJob = waitingManager.createJob({ type: 'browser_download', target: 'CapCut', channel: 'TUI' })
await choiceRunner.run(choiceJob.jobId)
assert.equal(waitingManager.getJob(choiceJob.jobId).state, 'waiting_user')
assert.equal(waitingManager.getJob(choiceJob.jobId).error.code, 'USER_DECISION_REQUIRED')
assert.match(waitingManager.getJob(choiceJob.jobId).error.message, /Apple Silicon or Intel/)
assert.deepEqual(waitingNotifications.map(item => item.event), ['needs_user', 'needs_user', 'needs_user'])

const boundaryManager = new BackgroundJobManager({
  idFactory: () => 'bg-boundary-1',
  loadSnapshot: () => [],
  saveSnapshot: () => {},
  emitEventFn: () => {},
})
let requestForegroundYield = null
let leaseReleaseCount = 0
const boundaryRunner = new BrowserDownloadTaskRunner({
  jobManager: boundaryManager,
  leaseManager: {
    acquire: async options => {
      requestForegroundYield = options.onYield
      return {
        assertActive: () => true,
        release: () => { leaseReleaseCount += 1 },
      }
    },
  },
  emitEventFn: () => {},
  notifyImportantFn: () => {},
  callLLMFn: async options => {
    options.onToolExecute('browser_click', { element: '下载' })
    requestForegroundYield()
    assert.equal(options.signal.aborted, false,
      'a foreground request does not abort an in-flight browser mutation')
    options.onToolCall('browser_click', { element: '下载' }, JSON.stringify({ ok: true }))
    assert.equal(options.signal.aborted, true,
      'the background runner yields immediately after the browser tool boundary')
    const error = new Error('yielded')
    error.name = 'AbortError'
    throw error
  },
})
const boundaryJob = boundaryManager.createJob({ type: 'browser_download', target: '豆包', channel: 'TUI' })
await boundaryRunner.run(boundaryJob.jobId)
assert.equal(boundaryManager.getJob(boundaryJob.jobId).state, 'queued')
assert.equal(leaseReleaseCount, 1)
boundaryManager.updateJob(boundaryJob.jobId, { state: 'cancelled' })
await new Promise(resolve => setImmediate(resolve))

const delayedNativeManager = new BackgroundJobManager({
  idFactory: () => 'bg-delayed-native-1',
  loadSnapshot: () => [],
  saveSnapshot: () => {},
  emitEventFn: () => {},
})
let grantDelayedLease = null
let delayedModelCalls = 0
const delayedNativeRunner = new BrowserDownloadTaskRunner({
  jobManager: delayedNativeManager,
  leaseManager: {
    acquire: () => new Promise(resolve => {
      grantDelayedLease = () => resolve({ assertActive: () => true, release: () => {} })
    }),
  },
  callLLMFn: async () => { delayedModelCalls += 1 },
  emitEventFn: () => {},
  notifyImportantFn: () => {},
})
const delayedNativeJob = delayedNativeManager.createJob({
  type: 'browser_download', target: 'CapCut', channel: 'TUI',
})
const delayedNativeRun = delayedNativeRunner.run(delayedNativeJob.jobId)
await Promise.resolve()
delayedNativeManager.handleDownloadEvent({
  jobId: delayedNativeJob.jobId,
  id: 'download-delayed-native',
  event: 'started',
  state: 'progressing',
  path: '/Users/test/Downloads/CapCut.dmg',
})
grantDelayedLease()
await delayedNativeRun
assert.equal(delayedNativeManager.getJob(delayedNativeJob.jobId).state, 'downloading')
assert.equal(delayedModelCalls, 0,
  'a delayed will-download event prevents a queued runner from taking the browser and clicking again')

console.log('browser download task runner tests passed')
