import fs from 'fs'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { insertConversation } from './db.js'
import { emitEvent } from './events.js'
import { nowTimestamp } from './time.js'
import { sceneStore } from './scene/scene-store.js'
import { cancelSceneSurfaceRemoval, scheduleSceneSurfaceRemoval } from './scene/transient-surfaces.js'
import { recordTerminalStreamEvent } from './terminal-stream.js'
import { getHotspotPanelState, setHotspotPanelState } from './hotspots.js'
import { SANDBOX_ROOT, assertInSandbox, normalizeSandboxPath } from './capabilities/sandbox.js'

const WEATHER_ID = 'weather-capability-demo'
const WRITE_STREAM_ID = 'capability-demo-write'
const DEMO_FILE_PATH = 'notes/capability-demo.txt'
const CMD_SCRIPT_PATH = 'notes/capability-demo.cmd'
export const CAPABILITY_DEMO_INTRO = '我能查查天气、操作读写你电脑上的文件、运行电脑里面的命令，还能给你网罗每日的热点信息'

let runId = 0
let activeCmdProcess = null
let activeCmdWindowTitle = null
let activeCmdPid = null
let demoHotspotOpened = false

export function runCapabilityDemo({
  to = '',
  channel = 'TUI',
  speak = true,
  message = true,
  clientId = '',
} = {}) {
  const currentRun = ++runId
  resetDemoSurfaces()
  const sentIntro = message && deliverIntroMessage({
    to,
    channel,
    text: CAPABILITY_DEMO_INTRO,
    speak,
    clientId,
  })
  if (!sentIntro && speak) {
    emitEvent('tts_reply', { text: CAPABILITY_DEMO_INTRO, target_client_id: clientId })
  }
  void playDemo(currentRun).catch(err => {
    console.warn('[capability-demo] sequence failed:', err?.message || err)
  })
  return CAPABILITY_DEMO_INTRO
}

function deliverIntroMessage({
  to = '',
  channel = 'TUI',
  text = '',
  speak = true,
  clientId = '',
} = {}) {
  if (!to || !text) return false
  const timestamp = nowTimestamp()
  const insertedId = insertConversation({
    role: 'jarvis',
    from_id: 'jarvis',
    to_id: to,
    content: text,
    timestamp,
    channel: channel || 'TUI',
  })
  emitEvent('message', {
    from: 'consciousness',
    to,
    content: text,
    timestamp,
    conversation_id: insertedId,
    channel: channel || 'TUI',
    speak: speak === true,
    target_client_id: clientId,
  })
  return true
}

function sleep(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

function isCurrent(id) {
  return id === runId
}

function noteAction(summary, detail = '') {
  emitEvent('action', {
    tool: 'capability_demo',
    summary,
    detail,
  })
}

function emitWritePreview(action, payload = {}) {
  const title = payload.title || '流式写入 capability-demo.txt'
  const bridge = globalThis?.terminalStreamBridge
  if (bridge && ['open', 'clear', 'write'].includes(action)) {
    bridge.emit('open', { title, stream_id: WRITE_STREAM_ID, placement: 'auto', relayout: true, focus: false, source: 'capability_demo' })
  } else if (bridge && action === 'close') {
    bridge.emit('close', { stream_id: WRITE_STREAM_ID })
  }
  recordTerminalStreamEvent({
    action,
    stream_id: WRITE_STREAM_ID,
    title,
    format: 'plain',
    artifact_kind: 'file',
    artifact_path: DEMO_FILE_PATH,
    hold_open: false,
    ...payload,
  })
}

function showWeatherCard() {
  cancelSceneSurfaceRemoval(WEATHER_ID)
  sceneStore.set(WEATHER_ID, {
    kind: 'weather',
    intent: 'ambient',
    order: 10,
    data: {
      variant: 'compact',
      city: '天气卡片',
      temp: 24,
      condition: '多云',
      forecast: [
        { day: '今天', low: 21, high: 26, condition: '多云' },
        { day: '明天', low: 20, high: 27, condition: '晴' },
        { day: '后天', low: 22, high: 28, condition: '小雨' },
      ],
    },
  })
  scheduleSceneSurfaceRemoval(WEATHER_ID, { kind: 'weather', ttlMs: 30000 })
  emitEvent('action', { tool: 'weather_surface', summary: '演示天气卡片', detail: 'capability demo' })
}

function hideWeatherCard() {
  cancelSceneSurfaceRemoval(WEATHER_ID)
  sceneStore.set(WEATHER_ID, null)
}

function setHotspotDemo(open) {
  const state = setHotspotPanelState({ active: !!open, source: 'capability_demo' })
  demoHotspotOpened = !!open
  emitEvent('hotspot_mode', {
    action: open ? 'show' : 'hide',
    active: state.active,
    reason: 'capability demo',
  })
  emitEvent('action', {
    tool: 'hotspot_mode',
    summary: open ? '演示打开热点面板' : '演示关闭热点面板',
    detail: 'capability demo',
  })
}

function closeWritePreview() {
  emitWritePreview('close', { title: '流式写入 capability-demo.txt', force: true })
}

function resetDemoSurfaces() {
  hideWeatherCard()
  closeWritePreview()
  closeCmdWindow()
  if (demoHotspotOpened) setHotspotDemo(false)
}

function resolveSandboxFile(relPath) {
  const normalized = normalizeSandboxPath(relPath)
  const resolved = path.resolve(SANDBOX_ROOT, normalized)
  assertInSandbox(resolved)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  return { normalized, resolved }
}

async function streamWriteDemoFile(id) {
  noteAction('演示流式文本写入', DEMO_FILE_PATH)
  const { resolved } = resolveSandboxFile(DEMO_FILE_PATH)
  const article = [
    '白龙马像一个住在电脑里的行动伙伴。它不仅能回答问题，也能把能力投到屏幕上：查询天气时变成卡片，写文件时把文字一段段落到磁盘，运行命令时打开真实窗口，让过程被看见。它还能展开热点面板，替你整理当天值得关注的信息。无论是记录灵感、检查环境、生成内容，还是把复杂任务拆成一步步行动，它都应该让你看得见、听得懂、能掌控。好的助手不只是会说，更要能把事情做出来，并让你清楚地看到每一步。',
    '',
    `生成时间：${nowTimestamp()}`,
  ].join('\n')
  const chunks = chunkText(article, 18)

  fs.writeFileSync(resolved, '', 'utf-8')
  emitWritePreview('clear')
  emitWritePreview('write', {
    text: `$ write_file ${DEMO_FILE_PATH} --stream --article=zh\n\n`,
    newline: false,
    level: 'muted',
  })

  for (const chunk of chunks) {
    await sleep(430)
    if (!isCurrent(id)) return false
    fs.appendFileSync(resolved, chunk, 'utf-8')
    emitWritePreview('write', { text: chunk, newline: false })
  }

  await sleep(500)
  if (!isCurrent(id)) return false
  const content = fs.readFileSync(resolved, 'utf-8')
  const verified = content === chunks.join('')
  emitWritePreview('write', {
    text: `\n[write_file ${verified ? 'done' : 'failed'}, ${Buffer.byteLength(content, 'utf-8')} bytes]\n`,
    newline: false,
    level: verified ? 'success' : 'error',
  })
  noteAction(verified ? '流式写入完成' : '流式写入校验失败', DEMO_FILE_PATH)
  return true
}

function chunkText(text = '', size = 20) {
  const chars = Array.from(String(text || ''))
  const chunks = []
  for (let i = 0; i < chars.length; i += size) chunks.push(chars.slice(i, i + size).join(''))
  return chunks
}

function writeCmdDemoScript(windowTitle = 'Bailongma Capability Demo') {
  const { resolved } = resolveSandboxFile(CMD_SCRIPT_PATH)
  const safeTitle = sanitizeCmdTitle(windowTitle)
  const randomLine = Array(20).fill('%random%').join('')
  const lines = [
    '@echo off',
    `title ${safeTitle}`,
    'color 0f',
    'mode con: cols=80 lines=50',
    ':loop',
    `echo ${randomLine}`,
    'goto loop',
  ]
  fs.writeFileSync(resolved, lines.join('\r\n'), 'utf-8')
  return resolved
}

function sanitizeCmdTitle(title = '') {
  return String(title || 'Bailongma Capability Demo')
    .replace(/[&|<>^"]/g, '')
    .slice(0, 96)
    .trim() || 'Bailongma Capability Demo'
}

function quoteCmdPath(value = '') {
  return `"${String(value || '').replace(/"/g, '""')}"`
}

function quotePowerShellString(value = '') {
  return `'${String(value || '').replace(/'/g, "''")}'`
}

function startVisibleCmdWithPid({ comspec, scriptPath }) {
  const args = `/d /k call ${quoteCmdPath(scriptPath)}`
  const ps = [
    `$p = Start-Process -FilePath ${quotePowerShellString(comspec)} -ArgumentList ${quotePowerShellString(args)} -WorkingDirectory ${quotePowerShellString(SANDBOX_ROOT)} -WindowStyle Normal -PassThru`,
    '$p.Id',
  ].join('; ')
  const result = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    ps,
  ], {
    cwd: SANDBOX_ROOT,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `powershell exited ${result.status}`).trim())
  }
  const pid = Number(String(result.stdout || '').trim().split(/\s+/).pop())
  if (!Number.isFinite(pid) || pid <= 0) {
    throw new Error('Start-Process did not return a valid pid')
  }
  return pid
}

function openRealCmdWindow() {
  noteAction('演示真实 CMD 窗口', '最大化窗口中刷屏随机数 5 秒')
  if (process.platform !== 'win32') {
    noteAction('跳过真实 CMD 窗口', '当前不是 Windows 环境')
    return null
  }
  closeCmdWindow()
  const windowTitle = sanitizeCmdTitle(`Bailongma Capability Demo ${Date.now()}`)
  const scriptPath = writeCmdDemoScript(windowTitle)
  activeCmdWindowTitle = windowTitle
  const comspec = process.env.ComSpec || 'cmd.exe'
  try {
    activeCmdPid = startVisibleCmdWithPid({ comspec, scriptPath })
    activeCmdProcess = null
    return { pid: activeCmdPid }
  } catch (err) {
    console.warn('[capability-demo] failed to open visible cmd with pid:', err?.message || err)
    activeCmdPid = null
    activeCmdWindowTitle = null
    return null
  }
}

function closeCmdWindow() {
  const pid = Number(activeCmdPid || activeCmdProcess?.pid || 0)
  if (process.platform === 'win32' && pid > 0) {
    try {
      const killer = spawn('taskkill.exe', ['/F', '/T', '/PID', String(pid)], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.unref()
    } catch {}
  } else if (activeCmdProcess) {
    try {
      if (!activeCmdProcess.killed) activeCmdProcess.kill()
    } catch {}
  }
  activeCmdProcess = null
  activeCmdWindowTitle = null
  activeCmdPid = null
}

async function playDemo(id) {
  const hotspotWasActive = getHotspotPanelState().active === true
  noteAction('能力演示开始', '按 2 秒节拍启动，不等待上一项结束')

  noteAction('第一步：天气卡片', '立即弹出')
  showWeatherCard()
  scheduleDemoTimer(id, 3800, hideWeatherCard)

  await sleep(2000)
  if (!isCurrent(id)) return
  noteAction('第二步：流式写文件', DEMO_FILE_PATH)
  void streamWriteDemoFile(id)
    .then(ok => {
      if (!ok || !isCurrent(id)) return
      scheduleDemoTimer(id, 1200, closeWritePreview)
    })
    .catch(err => console.warn('[capability-demo] write demo failed:', err?.message || err))

  await sleep(2000)
  if (!isCurrent(id)) return
  noteAction('第三步：CMD 随机数窗口', '真实窗口刷屏 5 秒')
  openRealCmdWindow()
  await sleep(process.platform === 'win32' ? 2000 : 1600)
  if (!isCurrent(id)) return
  closeCmdWindow()
  await sleep(300)

  if (!isCurrent(id)) return
  noteAction('第四步：热点面板', '展开热点侧边面板')
  setHotspotDemo(true)
  if (!hotspotWasActive) scheduleDemoTimer(id, 4200, () => setHotspotDemo(false))

  scheduleDemoTimer(id, 7000, () => {
    if (!hotspotWasActive) setHotspotDemo(false)
    hideWeatherCard()
    closeWritePreview()
    closeCmdWindow()
    noteAction('能力演示完成', '天气卡片、写入预览、CMD 窗口和热点面板已收起')
  })
}

function scheduleDemoTimer(id, delayMs, fn) {
  const timer = setTimeout(() => {
    if (!isCurrent(id)) return
    fn()
  }, delayMs)
  if (typeof timer.unref === 'function') timer.unref()
  return timer
}
