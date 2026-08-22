let startBrowserDownloadTask = null

function toolJson(payload) {
  return JSON.stringify(payload, null, 2)
}

export function configureBrowserDownloadTaskStarter(starter) {
  startBrowserDownloadTask = typeof starter === 'function' ? starter : null
}

export async function execStartBrowserDownloadTask(args = {}, context = {}) {
  const target = String(args.target || args.query || args.name || '').trim()
  if (!target || target.length > 300) {
    return toolJson({
      ok: false,
      tool: 'start_browser_download_task',
      code: 'INVALID_DOWNLOAD_TARGET',
      error: 'target must be a non-empty software or file description of at most 300 characters',
    })
  }
  if (!startBrowserDownloadTask) {
    return toolJson({
      ok: false,
      tool: 'start_browser_download_task',
      code: 'BACKGROUND_RUNTIME_UNAVAILABLE',
      error: 'the background browser download runtime is unavailable',
    })
  }

  try {
    const job = await startBrowserDownloadTask({ ...args, target }, context)
    const jobId = String(job?.jobId || job?.job_id || '').trim()
    if (!jobId) throw new Error('background runtime did not return a job id')
    return toolJson({
      ok: true,
      tool: 'start_browser_download_task',
      status: 'started',
      job_id: jobId,
      target,
    })
  } catch (error) {
    return toolJson({
      ok: false,
      tool: 'start_browser_download_task',
      code: 'BACKGROUND_TASK_START_FAILED',
      error: error?.message || String(error),
    })
  }
}
