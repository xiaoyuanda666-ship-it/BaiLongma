import { getBackgroundJobManager } from '../../background-job-manager.js'

const ALLOWED_ACTIONS = new Set(['pause', 'resume', 'cancel', 'retry'])
let recoverBackgroundJob = null

export function configureBrowserDownloadJobRecovery(handler) {
  recoverBackgroundJob = typeof handler === 'function' ? handler : null
}

function failure(code, error, extra = {}) {
  return JSON.stringify({
    ok: false,
    tool: 'browser_download_manage',
    code,
    error,
    ...extra,
  }, null, 2)
}

export async function execBrowserDownloadManage(args = {}, context = {}) {
  const downloadId = String(args.download_id || '').trim()
  const action = String(args.action || '').trim().toLowerCase()
  if (!downloadId || downloadId.length > 160) {
    return failure('INVALID_DOWNLOAD_ID', 'download_id must be an exact non-empty id from the injected browser download context')
  }
  if (!ALLOWED_ACTIONS.has(action)) {
    return failure('INVALID_DOWNLOAD_ACTION', 'action must be pause, resume, cancel, or retry')
  }

  const manager = context.backgroundJobManager || getBackgroundJobManager()
  const recoveryJob = manager.findByDownloadId(downloadId)
  if (recoveryJob?.error?.code === 'RECOVERY_REQUIRED') {
    if (action === 'cancel') {
      const cancelled = manager.updateJob(recoveryJob.jobId, {
        state: 'cancelled', error: null, availableActions: ['retry'],
      })
      return JSON.stringify({
        ok: true,
        tool: 'browser_download_manage',
        action,
        recovery: true,
        job: cancelled,
      }, null, 2)
    }
    if (action === 'retry' && recoverBackgroundJob) {
      const retried = await recoverBackgroundJob(recoveryJob.jobId)
      return JSON.stringify({
        ok: true,
        tool: 'browser_download_manage',
        action,
        recovery: true,
        job: retried,
      }, null, 2)
    }
    return failure(
      'DOWNLOAD_RECOVERY_REQUIRED',
      action === 'resume'
        ? 'The previous native DownloadItem was lost during restart and cannot resume; retry or cancel this job.'
        : 'This recovered job cannot be controlled until the background runtime is available.',
      { job: recoveryJob },
    )
  }

  const bridge = context.browserDownloadBridge || globalThis.bailongmaChromeBridge
  if (!bridge || typeof bridge.controlDownload !== 'function') {
    return failure('BROWSER_DOWNLOAD_BRIDGE_UNAVAILABLE', 'The built-in browser download manager is unavailable.')
  }

  try {
    const result = await bridge.controlDownload(downloadId, action)
    if (result?.ok === true) {
      manager.applyDownloadControl(downloadId, action, result.download || {})
    }
    return JSON.stringify({
      tool: 'browser_download_manage',
      ...result,
    }, null, 2)
  } catch (error) {
    return failure('DOWNLOAD_CONTROL_FAILED', error?.message || String(error))
  }
}

export const __internal = { ALLOWED_ACTIONS }
