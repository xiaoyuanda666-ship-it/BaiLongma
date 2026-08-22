import { sceneStore } from '../../scene/scene-store.js'

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])
const pendingRemoval = new Map()

function surfaceId(jobId) {
  return `browser-download-${jobId}`
}

function statusFor(state) {
  if (state === 'completed') return 'done'
  if (state === 'failed' || state === 'cancelled' || state === 'interrupted') return 'error'
  if (state === 'paused' || state === 'waiting_user') return 'paused'
  return 'active'
}

function noteFor(job) {
  const notes = {
    queued: '等待浏览器…',
    navigating: '正在查找官方下载入口…',
    downloading: '正在下载…',
    paused: '已暂停',
    waiting_user: '需要你确认',
    interrupted: '下载中断，可继续或重试',
    failed: '下载失败',
    cancelled: '已取消',
    completed: job.path ? `已保存到 ${job.path}` : '下载完成',
  }
  return notes[job.state] || ''
}

export function projectBrowserDownloadJobToScene(job) {
  if (!job?.jobId || job.type !== 'browser_download') return
  const id = surfaceId(job.jobId)
  if (!TERMINAL.has(job.state) && pendingRemoval.has(id)) {
    clearTimeout(pendingRemoval.get(id))
    pendingRemoval.delete(id)
  }
  const numericPercent = Number(job.percent)
  const hasPercent = Number.isFinite(numericPercent) && numericPercent >= 0
  const data = {
    label: `下载 ${job.target || job.filename || '文件'}`,
    status: statusFor(job.state),
    note: noteFor(job),
    value: job.state === 'completed' ? 100 : (hasPercent ? numericPercent : 8),
    ...(!hasPercent && ['queued', 'navigating', 'downloading'].includes(job.state)
      ? { indeterminate: true }
      : {}),
  }
  sceneStore.set(id, { kind: 'progress', data, intent: 'ambient' })

  if (TERMINAL.has(job.state) && !pendingRemoval.has(id)) {
    const timer = setTimeout(() => {
      pendingRemoval.delete(id)
      sceneStore.set(id, null)
    }, job.state === 'completed' ? 5_000 : 9_000)
    pendingRemoval.set(id, timer)
    timer.unref?.()
  }
}
