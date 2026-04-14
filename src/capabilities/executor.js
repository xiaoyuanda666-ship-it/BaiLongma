import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import { nowTimestamp } from '../time.js'
import { searchMemories, insertMemory, getKnownEntities } from '../db.js'
import { emitEvent } from '../events.js'
import { callCapability, listCapabilities } from '../providers/registry.js'
import { isDailyLimitReached } from '../quota.js'

// 后台进程注册表：pid → { process, command, startedAt }
const bgProcesses = new Map()

// URL 访问缓存：url → { content, fetchedAt (ms timestamp) }
// 避免同一 URL 在短时间内被反复请求（如天气每天只需查一次）
const urlCache = new Map()

const URL_TTL_MS = {
  default: 60 * 60 * 1000,       // 默认：1 小时
  weather: 24 * 60 * 60 * 1000,  // 天气类：24 小时
  news:    30 * 60 * 1000,        // 新闻类：30 分钟
}

function getUrlTtl(url) {
  const u = url.toLowerCase()
  if (u.includes('wttr.in') || u.includes('weather') || u.includes('openweather') || u.includes('tianqi')) {
    return URL_TTL_MS.weather
  }
  if (u.includes('news') || u.includes('rss') || u.includes('feed')) {
    return URL_TTL_MS.news
  }
  return URL_TTL_MS.default
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 文件操作只允许在 sandbox 目录内
const SANDBOX_ROOT = path.resolve(__dirname, '../../sandbox')

function assertInSandbox(resolvedPath) {
  if (!resolvedPath.startsWith(SANDBOX_ROOT)) {
    throw new Error(`访问被拒绝：文件操作只允许在 sandbox 目录内（${SANDBOX_ROOT}）`)
  }
}

// 规范化路径：去掉可能带的 sandbox/ 前缀，统一以 SANDBOX_ROOT 为基准
function normalizeSandboxPath(filePath) {
  return filePath
    .replace(/^sandbox[\\/]/i, '')
    .replace(/^\.[\\/]/, '')
}

// 工具执行器：根据工具名和参数执行对应操作，返回结果字符串
export async function executeTool(name, args) {
  try {
    switch (name) {
      case 'send_message':
        return await execSendMessage(args)
      case 'read_file':
        return await execReadFile(args)
      case 'list_dir':
        return await execListDir(args)
      case 'write_file':
        return await execWriteFile(args)
      case 'delete_file':
        return await execDeleteFile(args)
      case 'make_dir':
        return await execMakeDir(args)
      case 'exec_command':
        return await execCommand(args)
      case 'kill_process':
        return await execKillProcess(args)
      case 'list_processes':
        return await execListProcesses()
      case 'fetch_url':
        return await execFetchUrl(args)
      case 'search_memory':
        return await execSearchMemory(args)
      case 'speak':
        return await execSpeak(args)
      case 'generate_lyrics':
        return await execGenerateLyrics(args)
      case 'generate_music':
        return await execGenerateMusic(args)
      default:
        return `错误：未知工具 "${name}"`
    }
  } catch (err) {
    return `执行失败：${err.message}`
  }
}

// send_message：推送到 SSE 流，所有订阅者实时收到
async function execSendMessage({ target_id, content }) {
  if (!target_id) return '错误：未提供 target_id'
  if (!content?.trim()) return '错误：未提供消息内容'

  // 验证并修正 target_id：精确匹配优先，否则模糊匹配已知实体
  const entities = getKnownEntities()
  const entityIds = entities.map(e => e.id)
  let resolvedId = target_id

  if (!entityIds.includes(target_id)) {
    // 尝试模糊匹配：去掉前缀零、忽略大小写
    const normalize = s => s.toLowerCase().replace(/^id:0*/, '')
    const targetNorm = normalize(target_id)
    const match = entityIds.find(id => normalize(id) === targetNorm)
    if (match) {
      console.log(`[send_message] ID 自动修正: "${target_id}" → "${match}"`)
      resolvedId = match
    } else if (entityIds.length > 0) {
      // 只有一个已知实体时直接用它（最常见情况）
      if (entityIds.length === 1) {
        console.log(`[send_message] 未知 ID "${target_id}"，使用唯一已知实体 "${entityIds[0]}"`)
        resolvedId = entityIds[0]
      } else {
        console.log(`[send_message] 警告：未知 target_id "${target_id}"，已知实体：${entityIds.join(', ')}`)
      }
    }
  }

  const timestamp = nowTimestamp()
  console.log(`\n[消息发送] → ${resolvedId}`)
  console.log(`  ${content}`)
  console.log(`  时间：${timestamp}`)
  emitEvent('message', { from: 'consciousness', to: resolvedId, content, timestamp })
  return `消息已发送至 ${resolvedId}`
}

// read_file：读取文件内容
async function execReadFile(args) {
  const rawPath = args.path || args.filename || args.file_path
  if (!rawPath) return '错误：未提供文件路径'
  const filePath = normalizeSandboxPath(rawPath)
  const resolved = path.resolve(SANDBOX_ROOT, filePath)
  assertInSandbox(resolved)
  const content = fs.readFileSync(resolved, 'utf-8')
  const lines = content.split('\n')
  // 限制单次读取不超过 200 行，避免上下文爆炸
  if (lines.length > 200) {
    return `[文件内容（前200行，共 ${lines.length} 行）]\n` + lines.slice(0, 200).join('\n')
  }
  return content
}

// list_dir：列出目录内容
async function execListDir(args) {
  const rawPath = args.path || args.dir || args.directory || '.'
  const dirPath = normalizeSandboxPath(rawPath)
  const resolved = path.resolve(SANDBOX_ROOT, dirPath)
  assertInSandbox(resolved)
  const entries = fs.readdirSync(resolved, { withFileTypes: true })
  const result = entries.map(e => {
    const type = e.isDirectory() ? '[目录]' : '[文件]'
    return `${type} ${e.name}`
  }).join('\n')
  return `目录：${resolved}\n\n${result}`
}

const PROTECTED_FILES = new Set(['readme.txt', 'world.txt', 'package.json'])

// write_file：写入文件
async function execWriteFile(args) {
  const rawPath = args.path || args.filename || args.file_path
  const content = args.content ?? args.text ?? args.data
  if (!rawPath) return '错误：未提供文件路径'
  if (content === undefined) return '错误：未提供写入内容'
  const filePath = normalizeSandboxPath(rawPath)
  if (PROTECTED_FILES.has(path.basename(filePath).toLowerCase())) {
    return `错误：${path.basename(filePath)} 是系统文件，不可修改`
  }
  const resolved = path.resolve(SANDBOX_ROOT, filePath)
  assertInSandbox(resolved)
  // 确保目录存在
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  fs.writeFileSync(resolved, content, 'utf-8')
  return `文件已写入：${resolved}`
}

// delete_file：删除沙盒内的文件或目录
async function execDeleteFile(args) {
  const rawPath = args.path || args.filename || args.file_path
  if (!rawPath) return '错误：未提供路径'
  const filePath = normalizeSandboxPath(rawPath)
  if (PROTECTED_FILES.has(path.basename(filePath).toLowerCase())) {
    return `错误：${path.basename(filePath)} 是系统文件，不可删除`
  }
  const resolved = path.resolve(SANDBOX_ROOT, filePath)
  assertInSandbox(resolved)
  if (!fs.existsSync(resolved)) return `错误：路径不存在：${filePath}`
  const stat = fs.statSync(resolved)
  if (stat.isDirectory()) {
    fs.rmSync(resolved, { recursive: true, force: true })
    return `目录已删除：${filePath}`
  } else {
    fs.unlinkSync(resolved)
    return `文件已删除：${filePath}`
  }
}

// make_dir：在沙盒内创建目录（支持多级）
async function execMakeDir(args) {
  const rawPath = args.path || args.dir || args.directory
  if (!rawPath) return '错误：未提供目录路径'
  const dirPath = normalizeSandboxPath(rawPath)
  const resolved = path.resolve(SANDBOX_ROOT, dirPath)
  assertInSandbox(resolved)
  fs.mkdirSync(resolved, { recursive: true })
  return `目录已创建：${dirPath}`
}

// exec_command：在沙盒目录内执行 shell 命令
// background=true 时后台运行，返回 PID；否则等待完成，返回输出
async function execCommand(args) {
  const command = args.command || args.cmd
  if (!command) return '错误：未提供命令'

  const background = args.background === true || args.background === 'true'
  // schema 说明单位是秒，转换为毫秒；兼容旧调用（如果传入 >1000 视为已是毫秒）
  const rawTimeout = Number(args.timeout) || 30
  const timeoutMs = Math.min(rawTimeout < 1000 ? rawTimeout * 1000 : rawTimeout, 120000)

  console.log(`[exec_command] ${background ? '[后台]' : '[前台]'} ${command}`)
  emitEvent('exec_command', { command, background })

  if (background) {
    return execBackground(command)
  } else {
    return execForeground(command, timeoutMs)
  }
}

function execBackground(command) {
  const child = spawn(command, {
    shell: true,
    cwd: SANDBOX_ROOT,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const pid = child.pid
  const startedAt = nowTimestamp()
  bgProcesses.set(pid, { process: child, command, startedAt })

  child.on('exit', (code) => {
    console.log(`[exec_command] 后台进程 PID ${pid} 退出，code=${code}`)
    bgProcesses.delete(pid)
    emitEvent('process_exit', { pid, command, code })
  })

  // 收集后台进程的输出，发出 SSE 事件
  child.stdout?.on('data', (data) => {
    const text = data.toString().slice(0, 500)
    emitEvent('process_output', { pid, stream: 'stdout', text })
  })
  child.stderr?.on('data', (data) => {
    const text = data.toString().slice(0, 500)
    emitEvent('process_output', { pid, stream: 'stderr', text })
  })

  return `后台进程已启动，PID=${pid}，命令：${command}\n可用 kill_process 工具停止它。`
}

function execForeground(command, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd: SANDBOX_ROOT,
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
      resolve(`命令超时（${timeoutMs / 1000}s），已强制终止。已收集输出：\n${(stdout + stderr).slice(0, 1000)}`)
    }, timeoutMs)

    child.stdout?.on('data', (d) => { stdout += d.toString() })
    child.stderr?.on('data', (d) => { stderr += d.toString() })

    child.on('close', (code) => {
      if (timedOut) return
      clearTimeout(timer)
      const combined = (stdout + (stderr ? '\n[stderr]\n' + stderr : '')).slice(0, 3000)
      resolve(`命令完成（exit code=${code}）\n${combined || '（无输出）'}`)
    })

    child.on('error', (err) => {
      if (timedOut) return
      clearTimeout(timer)
      resolve(`命令执行失败：${err.message}`)
    })
  })
}

// kill_process：停止后台进程（通过 PID）
async function execKillProcess(args) {
  const pid = Number(args.pid)
  if (!pid) return '错误：未提供 PID'
  const entry = bgProcesses.get(pid)
  if (!entry) return `错误：未找到 PID=${pid} 的后台进程（可能已退出）`
  entry.process.kill()
  bgProcesses.delete(pid)
  return `进程 PID=${pid} 已停止（命令：${entry.command}）`
}

// list_processes：列出当前后台进程
async function execListProcesses() {
  if (bgProcesses.size === 0) return '当前没有运行中的后台进程。'
  const lines = [...bgProcesses.entries()].map(([pid, { command, startedAt }]) =>
    `PID=${pid}  启动于 ${startedAt.slice(11, 19)}  命令：${command}`
  )
  return `运行中的后台进程（${bgProcesses.size} 个）：\n${lines.join('\n')}`
}

// fetch_url：获取网页内容，提取纯文本（带 TTL 缓存）
async function execFetchUrl(args) {
  const url = args.url || args.URL || args.link
  if (!url) return '错误：未提供 URL'

  // 检查缓存
  const cached = urlCache.get(url)
  const ttl = getUrlTtl(url)
  if (cached && Date.now() - cached.fetchedAt < ttl) {
    const ageMin = Math.round((Date.now() - cached.fetchedAt) / 60000)
    const ttlH = Math.round(ttl / 3600000)
    console.log(`[fetch_url] 缓存命中（${ageMin}分钟前，TTL ${ttlH}h）: ${url}`)
    return `[缓存内容，${ageMin}分钟前获取，${ttlH}小时内有效]\n${cached.content}`
  }

  console.log(`[fetch_url] → ${url}`)
  let res
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Jarvis/0.1)' },
      signal: AbortSignal.timeout(10000),
    })
  } catch (err) {
    console.log(`[fetch_url] 失败: ${url} — ${err.message}`)
    return `请求失败：${err.message}（URL: ${url}）`
  }
  if (!res.ok) return `请求失败：HTTP ${res.status}（URL: ${url}）`

  const html = await res.text()

  // 剥离 HTML 标签，保留可读文本
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s{3,}/g, '\n\n')
    .trim()

  // 限制长度，避免上下文爆炸
  const MAX = 3000
  const result = text.length > MAX
    ? `[内容节选，共 ${text.length} 字符]\n\n` + text.slice(0, MAX) + '\n\n...'
    : text

  // 写入缓存
  urlCache.set(url, { content: result, fetchedAt: Date.now() })

  return result
}

// search_memory：主动搜索记忆
async function execSearchMemory({ keyword, limit = 5 }) {
  if (!keyword) return '错误：未提供搜索关键词'
  const rows = searchMemories(keyword, limit)
  if (rows.length === 0) return `未找到包含"${keyword}"的记忆`
  return rows.map(m =>
    `[${m.timestamp.slice(0, 10)}] ${m.event_type}: ${m.content}\n  ${m.detail?.slice(0, 100) ?? ''}`
  ).join('\n\n')
}

// speak：将文字转为语音，保存为音频文件
// 有效的 MiniMax 声音 ID
const VALID_VOICE_IDS = new Set([
  'male-qn-qingse', 'male-qn-jingying', 'male-qn-badao', 'male-qn-daxuesheng',
  'female-shaonv', 'female-yujie', 'female-chengshu', 'female-tianmei',
  'presenter_male', 'presenter_female', 'audiobook_male_1', 'audiobook_female_1',
])
const DEFAULT_VOICE = 'male-qn-qingse'

async function execSpeak(args) {
  const text = args.text || args.content || args.words || args.speech
  const voiceRaw = args.voice_id || args.voice
  const voice_id = VALID_VOICE_IDS.has(voiceRaw) ? voiceRaw : DEFAULT_VOICE
  const { filename } = args
  console.log(`[speak] args:`, JSON.stringify(args))
  if (!text) return '错误：未提供要朗读的文字'
  if (isDailyLimitReached('tts')) return '错误：今日 TTS 配额已用完'
  if (text.length > 1000) return `错误：文字过长（${text.length} 字），请控制在 1000 字以内`

  const result = await callCapability('tts', { text, voice_id })

  // 生成文件名：优先使用传入的，否则自动生成
  const ts = nowTimestamp().replace(/[:.+]/g, '-').slice(0, 19)
  const fname = filename ? filename.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, '') + '.mp3' : `speech_${ts}.mp3`
  const resolved = path.resolve(SANDBOX_ROOT, 'audio', fname)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  fs.writeFileSync(resolved, result.buffer)

  const relPath = `audio/${fname}`
  emitEvent('audio_created', { path: relPath, text: text.slice(0, 60) })
  console.log(`[speak] 已生成: ${relPath}`)
  return `语音已生成：${relPath}（时长约 ${result.duration ?? '?'} 秒）`
}

// generate_lyrics：生成歌词
async function execGenerateLyrics({ prompt, mode }) {
  if (!prompt) return '错误：未提供创作方向'
  if (isDailyLimitReached('lyrics')) return '错误：今日歌词生成配额已用完'

  const result = await callCapability('lyrics', { prompt, mode })

  // 自动保存歌词到 sandbox
  const ts = nowTimestamp().replace(/[:.+]/g, '-').slice(0, 19)
  const fname = `lyrics_${ts}.txt`
  const content = `# ${result.title}\n风格：${result.style}\n\n${result.lyrics}`
  const resolved = path.resolve(SANDBOX_ROOT, 'lyrics', fname)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  fs.writeFileSync(resolved, content, 'utf-8')

  emitEvent('lyrics_created', { path: `lyrics/${fname}`, title: result.title })
  return `歌词已生成并保存至 lyrics/${fname}\n\n标题：${result.title}\n风格：${result.style}\n\n${result.lyrics}`
}

// generate_music：生成音乐
async function execGenerateMusic({ prompt, lyrics, instrumental }) {
  if (!prompt) return '错误：未提供音乐描述'
  if (isDailyLimitReached('music')) return '错误：今日音乐生成配额已用完'

  const result = await callCapability('music', { prompt, lyrics, instrumental })

  const ts = nowTimestamp().replace(/[:.+]/g, '-').slice(0, 19)
  const fname = `music_${ts}.mp3`
  const resolved = path.resolve(SANDBOX_ROOT, 'music', fname)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  fs.writeFileSync(resolved, result.buffer)

  const relPath = `music/${fname}`
  emitEvent('music_created', { path: relPath, prompt: prompt.slice(0, 60) })
  console.log(`[music] 已生成: ${relPath}`)
  return `音乐已生成：${relPath}（时长约 ${result.duration ?? '?'} 秒）`
}
