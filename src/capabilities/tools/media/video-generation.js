import fs from 'fs'
import os from 'os'
import path from 'path'
import { emitEvent } from '../../../events.js'
import { pushMessage } from '../../../inbound-message.js'
import { getSeedanceConfig } from '../../../config.js'
import { paths } from '../../../paths.js'
import { SANDBOX_ROOT } from '../../sandbox.js'

// ─────────────────────────────────────────────────────────────────────────────
// AI 视频生成（Seedance 2.0 / 火山方舟 Ark）
//
// 异步任务式：创建任务 → 后台轮询 → 下载 mp4 到 sandbox → 推给前端面板自动播放。
// 设计要点：
//   1) 未配置 key → 返回结构化引导文案（不做硬拦截，由模型转述指引用户粘贴 key）。
//   2) 创建任务同步 await，失败立刻回传给模型（典型：model ID 不对 / 余额不足）。
//   3) 轮询在后台进行（不阻塞当前 turn），全程只 emit 面板事件，完成/失败都体现在面板上。
// ─────────────────────────────────────────────────────────────────────────────

const SEEDANCE_POLL_INTERVAL_MS = 5000
const SEEDANCE_MAX_POLL_MS = 8 * 60 * 1000   // 8 分钟兜底超时
const SEEDANCE_VIDEO_DIR = path.resolve(SANDBOX_ROOT, 'videos')

const SEEDANCE_VIDEO_KEEP = 20                          // sandbox/videos 只保留最近 N 条
const SEEDANCE_PENDING_FILE = path.join(paths.userDir, 'aivideo-pending.json')
const SEEDANCE_PENDING_TTL_MS = 48 * 60 * 60 * 1000     // 火山任务约 48h 内可查，过期不再恢复
const SEEDANCE_HISTORY_FILE = path.join(paths.userDir, 'aivideo-history.json')  // 已完成视频历史（面板重开/重启后重建队列）

function newVideoJobId() {
  return `vid_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

// 统一向前端面板广播 AI 视频生成状态
function emitAIVideo(action, payload = {}) {
  emitEvent('aivideo_mode', { action, ...payload })
}

// 视频生成进入终态后，给 agent 推一条 SYSTEM 通知，让它"知道"结果（成功/失败）。
// 走后台队列（background 优先级），不打断用户当前对话；agent 空闲时自然处理这条通知。
// 这是 emitAIVideo（只通知前端面板）之外的另一条通道——前者给眼睛，这条给 agent 的认知。
function notifyAgentVideoDone({ prompt = '', mode = 'text', ok = true, reason = '' } = {}) {
  const modeLabel = seedanceModeLabel(mode)
  const p = String(prompt || '').trim()
  const promptPart = p ? `，提示词：「${p}」` : ''
  const content = ok
    ? `[系统通知] 你之前提交的 AI 视频已经生成完成（${modeLabel}${promptPart}）。视频已自动在右侧面板播放。如果用户在等这个视频，简短地告诉他生成好了即可，不必复述提示词或描述画面。`
    : `[系统通知] 你之前提交的 AI 视频生成失败了（${modeLabel}${promptPart}）。原因：${reason || '未知'}。可以简短地把失败情况告诉用户，必要时建议换个提示词或稍后重试。`
  try { pushMessage('SYSTEM', content, 'SYSTEM', { queue: 'background' }) }
  catch (e) { console.warn(`[aivideo] 通知 agent 失败：${e.message}`) }
}

// ── AI 视频面板「感知」状态 ──
// 前端面板实时同步 { open, prompt } 到后端（POST /aivideo/draft）。注入器每轮把它贴进
// agent 上下文，让 agent 直接看到「面板开/关」「用户正在框里编辑的提示词草稿」。
// 这样用户说「帮我优化提示词」时，agent 无需追问内容，直接基于草稿改写。
const aivideoPanelState = { open: false, prompt: '', updatedAt: 0 }
export function setAIVideoPanelState({ open, prompt } = {}) {
  if (typeof open === 'boolean') aivideoPanelState.open = open
  if (typeof prompt === 'string') aivideoPanelState.prompt = prompt
  aivideoPanelState.updatedAt = Date.now()
}
export function getAIVideoPanelState() { return { ...aivideoPanelState } }

// ── 进行中任务持久化（断点续查）：app/后端重启后能恢复轮询，面板不会卡在“生成中” ──
function readPending() {
  try { const v = JSON.parse(fs.readFileSync(SEEDANCE_PENDING_FILE, 'utf-8')); return Array.isArray(v) ? v : [] }
  catch { return [] }
}
function writePending(list) {
  try {
    const tmp = SEEDANCE_PENDING_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf-8')
    fs.renameSync(tmp, SEEDANCE_PENDING_FILE)
  } catch {}
}
function addPending(entry) { writePending([...readPending().filter(e => e.taskId !== entry.taskId), entry]) }
function removePending(taskId) { writePending(readPending().filter(e => e.taskId !== taskId)) }

// ── 已完成视频历史：任务成功落盘后记一条，按 jobId 去重、只留最近 N 条。 ──
// 面板关闭重开 / app 重启后，前端拉 GET /aivideo/history 重建生成栏队列，
// 避免“视频还在磁盘上，队列却空了”——这是历史丢失 bug 的根因（jobs[] 原本纯内存）。
function readHistory() {
  try { const v = JSON.parse(fs.readFileSync(SEEDANCE_HISTORY_FILE, 'utf-8')); return Array.isArray(v) ? v : [] }
  catch { return [] }
}
function writeHistory(list) {
  try {
    const tmp = SEEDANCE_HISTORY_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf-8')
    fs.renameSync(tmp, SEEDANCE_HISTORY_FILE)
  } catch {}
}
function addHistory(entry) {
  // 新的放最前；同 jobId 去重；最多留 SEEDANCE_VIDEO_KEEP 条（与磁盘保留数对齐）
  const next = [entry, ...readHistory().filter(e => e && e.jobId !== entry.jobId)].slice(0, SEEDANCE_VIDEO_KEEP)
  writeHistory(next)
}

// 供前端 /aivideo/history 拉取：过滤掉本地 mp4 已被清理的条目，整形成前端 job 形状（newest-first）。
export function getVideoHistory() {
  return readHistory()
    .filter(e => e && e.jobId && fs.existsSync(path.join(SEEDANCE_VIDEO_DIR, `${e.jobId}.mp4`)))
    .map(e => ({
      id: e.jobId, status: 'done', videoUrl: `/media/video/${encodeURIComponent(e.jobId)}.mp4`,
      mode: e.mode || 'text', prompt: e.prompt || '',
      res: e.resolution || '', ratio: e.ratio || '', dur: e.duration || '',
    }))
}

// 保留最近 N 条生成视频，删更旧的，防止 sandbox/videos 无限膨胀
function pruneVideoDir() {
  try {
    const files = fs.readdirSync(SEEDANCE_VIDEO_DIR)
      .filter(f => f.toLowerCase().endsWith('.mp4'))
      .map(f => ({ f, mt: fs.statSync(path.join(SEEDANCE_VIDEO_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mt - a.mt)
    for (const { f } of files.slice(SEEDANCE_VIDEO_KEEP)) {
      try { fs.rmSync(path.join(SEEDANCE_VIDEO_DIR, f), { force: true }) } catch {}
    }
  } catch {}
}

// 把 Ark 返回的 video_url 下载到 sandbox/videos，返回可直接播放的本地 HTTP 路径
async function downloadGeneratedVideo(videoUrl, jobId) {
  const res = await fetch(videoUrl, { signal: AbortSignal.timeout(120000) })
  if (!res.ok) throw new Error(`下载生成视频失败：HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  fs.mkdirSync(SEEDANCE_VIDEO_DIR, { recursive: true })
  const fname = `${jobId}.mp4`
  fs.writeFileSync(path.join(SEEDANCE_VIDEO_DIR, fname), buf)
  pruneVideoDir()
  return `/media/video/${encodeURIComponent(fname)}`
}

// 后台轮询任务直到终态，全程 emit 面板事件；不返回给模型
async function seedancePollLoop({ taskId, jobId, baseURL, apiKey, prompt = '', mode = 'text', ratio = '', resolution = '', duration = '' }) {
  const deadline = Date.now() + SEEDANCE_MAX_POLL_MS
  const headers = { Authorization: `Bearer ${apiKey}` }
  try {
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, SEEDANCE_POLL_INTERVAL_MS))
      let data
      try {
        const res = await fetch(`${baseURL}/contents/generations/tasks/${taskId}`, {
          headers, signal: AbortSignal.timeout(20000),
        })
        data = await res.json()
        if (!res.ok) {
          const m = data?.error?.message || `HTTP ${res.status}`
          emitAIVideo('error', { jobId, message: `查询任务失败：${m}` })
          return
        }
      } catch (e) {
        // 单次网络抖动不算失败，继续轮询直到超时
        continue
      }

      const status = String(data.status || '').toLowerCase()
      if (status === 'succeeded') {
        const videoUrl = data?.content?.video_url
        if (!videoUrl) {
          emitAIVideo('error', { jobId, message: '生成完成但未返回视频地址' })
          return
        }
        try {
          const localUrl = await downloadGeneratedVideo(videoUrl, jobId)
          emitAIVideo('ready', { jobId, videoUrl: localUrl })
          // 落盘成功后记入已完成历史，面板重开/重启时能重建队列
          addHistory({ jobId, mode, prompt, ratio, resolution, duration, doneAt: Date.now() })
          emitEvent('action', { tool: 'aivideo_panel', summary: 'AI 视频生成完成', detail: jobId })
        } catch (e) {
          // 下载失败时退而求其次：直接播远端 URL（临时链接，可能数小时后过期）
          emitAIVideo('ready', { jobId, videoUrl })
        }
        notifyAgentVideoDone({ prompt, mode, ok: true })
        return
      }
      if (status === 'failed' || status === 'cancelled' || status === 'expired') {
        const m = data?.error?.message || status
        emitAIVideo('error', { jobId, message: `生成失败：${m}` })
        notifyAgentVideoDone({ prompt, mode, ok: false, reason: m })
        return
      }
      // queued / running → 推进度
      emitAIVideo('progress', { jobId, status: status || 'running' })
    }
    emitAIVideo('error', { jobId, message: '生成超时（超过 8 分钟未完成）' })
    notifyAgentVideoDone({ prompt, mode, ok: false, reason: '生成超时（超过 8 分钟未完成）' })
  } finally {
    // 无论成功/失败/超时/异常，都从待恢复列表移除该任务
    removePending(taskId)
  }
}

const SEEDANCE_RATIOS = new Set(['adaptive', '16:9', '9:16', '4:3', '3:4', '1:1', '21:9'])
const SEEDANCE_RESOLUTIONS = new Set(['480p', '720p', '1080p'])
function seedanceModeLabel(mode) { return mode === 'flf' ? '首尾帧' : mode === 'image' ? '图生视频' : '文生视频' }
const SEEDANCE_NOT_CONFIGURED_GUIDE = 'AI 视频生成需要先配置火山方舟（Volcengine Ark）的 Seedance API Key。请引导用户：①登录火山方舟控制台开通 Seedance 2.0；②把 API Key 直接发给你即可自动配置，例如发送「火山视频 你的APIKey」；③如果账号用的是推理接入点或特定模型版本，可一并发模型ID/ep编号，例如「火山视频 你的APIKey 模型 ep-2024xxxx」。配置成功后再让用户重述生成需求。'

// AI video panel：调用 Seedance 生成视频（文生视频 / 图+提示词生视频）
// action=open  → 只打开空白输入面板，用户在面板里自己填提示词/拖图片再点生成
// action=generate（默认）→ 直接提交生成
export async function execGenerateVideo(args = {}) {
  const action = String(args.action || 'generate').trim()
  const { apiKey, model, baseURL, configured } = getSeedanceConfig()

  // 只打开空白面板：无论是否已配置都打开（未配置时面板内会提示去配 key）。
  // 用户在面板里自助填写并点“生成”（前端直连 /aivideo/generate）。
  if (action === 'open') {
    emitAIVideo('open', { configured })
    emitEvent('action', { tool: 'aivideo_panel', summary: '打开 AI 视频生成面板', detail: configured ? '' : '未配置 key' })
    return JSON.stringify({
      ok: true, tool: 'aivideo_panel', action: 'open', configured,
      message: configured
        ? 'AI 视频生成面板已打开（空白输入态）。用户可以在面板里直接填写提示词、可选地拖入一张参考图，然后点“生成”。你不需要替用户编写提示词或自动开始生成，简短确认一句即可。'
        : 'AI 视频生成面板已打开，但尚未配置火山方舟（Seedance）key。请引导用户发送「火山视频 你的APIKey」完成配置；面板里也已经显示了同样的提示。',
    })
  }

  // 写回提示词到面板输入框：只在用户「明确表示采用」优化结果后才调用。
  // 默认（用户刚说"帮我优化"）不要调用它——先在对话里给出改写版让用户确认。
  if (action === 'set_prompt') {
    const p = String(args.prompt || args.text || '').trim()
    if (!p) return JSON.stringify({ ok: false, tool: 'aivideo_panel', error: 'set_prompt 需要 prompt（要写入面板输入框的提示词）' })
    emitAIVideo('set_prompt', { prompt: p })
    setAIVideoPanelState({ prompt: p })
    emitEvent('action', { tool: 'aivideo_panel', summary: '写入优化后的提示词到视频面板', detail: p.slice(0, 40) })
    return JSON.stringify({ ok: true, tool: 'aivideo_panel', action: 'set_prompt', message: '已把这段提示词填入 AI 视频生成面板的输入框（覆盖原草稿）。提醒用户检查后自行点「生成」。' })
  }

  // 生成：未配置则返回引导（不硬拦截，交给模型/面板转述）
  if (!configured) {
    return JSON.stringify({ ok: false, tool: 'aivideo_panel', error: 'not_configured', guide: SEEDANCE_NOT_CONFIGURED_GUIDE })
  }

  const prompt = String(args.prompt || args.text || '').trim()
  // 图片：支持 images:[url1, url2?]（2 张=首尾帧），或兼容单个 image_url
  let images = Array.isArray(args.images) ? args.images.map(s => String(s || '').trim()).filter(Boolean) : []
  if (!images.length) {
    const single = String(args.image_url || args.image || '').trim()
    if (single) images = [single]
  }
  images = images.slice(0, 2)
  if (!prompt && !images.length) {
    return JSON.stringify({ ok: false, tool: 'aivideo_panel', error: '至少提供 prompt（文生视频）或图片（图生/首尾帧）；或用 action="open" 仅打开输入面板。' })
  }

  let ratio = SEEDANCE_RATIOS.has(args.ratio) ? args.ratio : '16:9'
  // adaptive=按参考图比例输出，仅图生/首尾帧有意义；文生视频无图可适配，回退 16:9
  if (ratio === 'adaptive' && !images.length) ratio = '16:9'
  const resolution = SEEDANCE_RESOLUTIONS.has(args.resolution) ? args.resolution : '720p'
  let duration = Number(args.duration)
  if (!Number.isFinite(duration)) duration = 5
  duration = Math.max(1, Math.min(15, Math.round(duration)))

  const content = []
  if (prompt) content.push({ type: 'text', text: prompt })
  if (images.length >= 2) {
    // 首尾帧：第一张=首帧，第二张=尾帧
    content.push({ type: 'image_url', image_url: { url: images[0] }, role: 'first_frame' })
    content.push({ type: 'image_url', image_url: { url: images[1] }, role: 'last_frame' })
  } else if (images.length === 1) {
    content.push({ type: 'image_url', image_url: { url: images[0] } })
  }

  const body = { model, content, ratio, resolution, duration }
  const mode = images.length >= 2 ? 'flf' : images.length === 1 ? 'image' : 'text'

  let createData
  try {
    const res = await fetch(`${baseURL}/contents/generations/tasks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    })
    createData = await res.json().catch(() => ({}))
    if (!res.ok) {
      const m = createData?.error?.message || `HTTP ${res.status}`
      return JSON.stringify({
        ok: false, tool: 'aivideo_panel', error: `创建任务失败：${m}`,
        hint: '若提示模型不存在/无权限，多半是 model ID 不对：请让用户在火山方舟确认 Seedance 模型 ID 或推理接入点（ep-xxx），重新发送「火山视频 你的APIKey 模型 正确的模型ID」即可更新。',
      })
    }
  } catch (e) {
    return JSON.stringify({ ok: false, tool: 'aivideo_panel', error: `创建任务异常：${e.message}` })
  }

  const taskId = createData.id || createData.task_id
  if (!taskId) {
    return JSON.stringify({ ok: false, tool: 'aivideo_panel', error: '创建任务返回缺少任务 ID', raw: createData })
  }

  const jobId = newVideoJobId()
  const modeLabel = seedanceModeLabel(mode)
  // 在生成栏新增一个“生成中”瓦片
  emitAIVideo('show', {
    jobId, mode, prompt: prompt.slice(0, 120),
    ratio, resolution, duration, status: 'queued',
  })
  emitEvent('action', { tool: 'aivideo_panel', summary: `提交 AI 视频生成（${modeLabel}）`, detail: prompt.slice(0, 60) })

  // 记入待恢复列表（不存 apiKey，恢复时用当前配置的 key）
  addPending({ taskId, jobId, mode, prompt: prompt.slice(0, 120), ratio, resolution, duration, baseURL, createdAt: Date.now() })

  // 后台轮询（不阻塞当前 turn）
  seedancePollLoop({ taskId, jobId, baseURL, apiKey, prompt: prompt.slice(0, 120), mode, ratio, resolution, duration }).catch(err => {
    emitAIVideo('error', { jobId, message: `轮询异常：${err.message}` })
    removePending(taskId)
  })

  return JSON.stringify({
    ok: true, tool: 'aivideo_panel', task_id: taskId, jobId, mode,
    message: `视频生成任务已提交（${modeLabel}），正在右侧面板生成中，完成后会自动播放，通常需要 1–5 分钟。无需反复查询，回复用户一句简短确认即可。`,
  })
}

// 用户点“下载”：把生成的视频从 sandbox 缓存复制到「下载\AI视频生成保存的视频\日期\」永久保存。
export function saveGeneratedVideo(jobId) {
  const safe = String(jobId || '').replace(/[^a-zA-Z0-9_\-]/g, '')
  if (!safe) return { ok: false, error: 'invalid jobId' }
  const src = path.join(SEEDANCE_VIDEO_DIR, `${safe}.mp4`)
  if (!fs.existsSync(src)) return { ok: false, error: '视频文件不存在（可能已被清理或尚未生成完成）' }
  const d = new Date()
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const dir = path.join(os.homedir(), 'Downloads', 'AI视频生成保存的视频', date)
  try {
    fs.mkdirSync(dir, { recursive: true })
    const dst = path.join(dir, `${safe}.mp4`)
    fs.copyFileSync(src, dst)
    return { ok: true, path: dst }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// 启动时恢复上次未完成的生成任务：重新发 show 事件并继续轮询，
// 让重启前正在生成的视频仍能自动落盘 / 在面板播放（而不是永远卡“生成中”）。
// 由 index.js 在后端启动后调用一次。
export function resumePendingVideoJobs() {
  const list = readPending()
  if (!list.length) return
  // 丢弃过期（>48h，火山已不可查）的条目
  const fresh = list.filter(e => e && e.taskId && (Date.now() - (e.createdAt || 0) < SEEDANCE_PENDING_TTL_MS))
  if (fresh.length !== list.length) writePending(fresh)
  if (!fresh.length) return

  const { apiKey, baseURL, configured } = getSeedanceConfig()
  if (!configured) { writePending([]); return }  // 没 key 无法恢复，清空避免无限残留

  // 延迟几秒，等前端 SSE 连上后再发事件，避免恢复太快前端收不到
  setTimeout(() => {
    for (const e of fresh) {
      emitAIVideo('show', {
        jobId: e.jobId, mode: e.mode, prompt: e.prompt,
        ratio: e.ratio, resolution: e.resolution, duration: e.duration, status: 'running',
      })
      seedancePollLoop({ taskId: e.taskId, jobId: e.jobId, baseURL: e.baseURL || baseURL, apiKey, prompt: e.prompt, mode: e.mode, ratio: e.ratio, resolution: e.resolution, duration: e.duration })
        .catch(() => removePending(e.taskId))
    }
    console.log(`[aivideo] 已恢复 ${fresh.length} 个未完成的视频生成任务`)
  }, 4000)
}
