import assert from 'node:assert/strict'
import {
  __softwareInstallTestHooks,
  execInstallSoftware,
  listSoftwareInstallJobs,
  parseWingetSearchOutput,
  resolveInitialWingetCandidateIds,
} from './capabilities/tools/software-install.js'

function parseToolResult(result) {
  return JSON.parse(String(result))
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForJob(jobId, predicate = job => ['succeeded', 'failed', 'needs_attention', 'cancelled'].includes(job?.status), timeoutMs = 1000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const job = listSoftwareInstallJobs({ detail: true }).find(item => item.job_id === jobId)
    if (predicate(job)) return job
    await sleep(10)
  }
  throw new Error(`timed out waiting for job ${jobId}`)
}

function makeRunner(handler) {
  const calls = []
  const runner = async (args) => {
    calls.push(args)
    return await handler(args, calls)
  }
  runner.calls = calls
  return runner
}

async function withIsolatedInstallState(fn) {
  __softwareInstallTestHooks.reset()
  const notifications = []
  __softwareInstallTestHooks.setNotificationSink(job => {
    notifications.push(job)
  })
  try {
    await fn({ notifications })
  } finally {
    __softwareInstallTestHooks.reset()
  }
}

const qqIds = resolveInitialWingetCandidateIds({ query: 'QQ' })
assert.deepEqual(qqIds.slice(0, 2), ['Tencent.QQ.NT', 'Tencent.QQ'])

const parsed = parseWingetSearchOutput(`
Name               Id                 Version         Source
-------------------------------------------------------------
Tencent QQ         Tencent.QQ         9.7.23.29392    winget
QQ                 Tencent.QQ.NT      9.9.31.49738    winget
QQ Music           Tencent.QQMusic    22.22           winget
`)
assert.deepEqual(parsed.map(r => r.id), ['Tencent.QQ', 'Tencent.QQ.NT', 'Tencent.QQMusic'])

await withIsolatedInstallState(async ({ notifications }) => {
  let releaseInstall
  const installStarted = new Promise(resolve => { releaseInstall = resolve })
  const runner = makeRunner(async (args) => {
    if (args[0] === '--version') return { ok: true, exit_code: 0, stdout: 'v1.9.0', stderr: '' }
    if (args[0] === 'search') return { ok: true, exit_code: 0, stdout: '', stderr: '' }
    if (args[0] === 'show') return { ok: true, exit_code: 0, stdout: 'Version: 9.9.31.49738', stderr: '' }
    if (args[0] === 'install') {
      await installStarted
      return { ok: true, exit_code: 0, stdout: 'Successfully installed', stderr: '' }
    }
    throw new Error(`unexpected winget args: ${args.join(' ')}`)
  })

  const result = parseToolResult(await execInstallSoftware(
    { query: 'QQ' },
    { allowNonWindowsForTest: true, wingetRunner: runner, currentTargetId: 'ID:000001' },
  ))
  assert.equal(result.ok, true)
  assert.equal(result.status, 'started')
  assert.ok(result.job_id)
  assert.equal(runner.calls.length, 0, 'install_software returns before winget is invoked')

  await waitForJob(result.job_id, job => job?.status === 'installing')
  releaseInstall()
  const finished = await waitForJob(result.job_id)
  assert.equal(finished.status, 'succeeded')
  assert.equal(finished.package_id, 'Tencent.QQ.NT')
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].job_id, result.job_id)
  assert.equal(notifications[0].status, 'succeeded')
})

await withIsolatedInstallState(async () => {
  const runner = makeRunner(async (args) => {
    if (args[0] === '--version') return { ok: true, exit_code: 0, stdout: 'v1.9.0', stderr: '' }
    if (args[0] === 'search') return { ok: true, exit_code: 0, stdout: '', stderr: '' }
    if (args[0] === 'show') return { ok: true, exit_code: 0, stdout: 'Version: 9.9.31.49738', stderr: '' }
    if (args[0] === 'install') {
      return {
        ok: false,
        exit_code: 1,
        stdout: 'No applicable update found; package is already installed.',
        stderr: '',
        error: 'command exited with code 1',
      }
    }
    throw new Error(`unexpected winget args: ${args.join(' ')}`)
  })

  const result = parseToolResult(await execInstallSoftware(
    { query: 'QQ' },
    { allowNonWindowsForTest: true, wingetRunner: runner },
  ))
  const finished = await waitForJob(result.job_id)
  assert.equal(finished.status, 'succeeded')
  assert.equal(finished.already_installed_or_current, true)
})

console.log('software install async job checks complete')
