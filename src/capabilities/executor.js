import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import { chromium } from 'playwright'
import { nowTimestamp } from '../time.js'
import { searchMemories, searchMemoriesByKeywords, insertMemory, upsertMemoryByMemId, normalizeConversationPartyId, createReminder, findMergeableOneOffReminder, appendReminderTask, listPendingReminders, getReminderById, cancelReminder, upsertPrefetchTask, removePrefetchTask, listPrefetchTasks, insertActionLog, upsertMusicTrack, getMusicTrack, searchMusicLibrary, listMusicLibrary, updateMusicLrc, deleteMusicTrack as dbDeleteMusicTrack } from '../db.js'
import { emitEvent, emitUICommand, emitACUIEvent, hasACUIClient, addActiveUICard, removeActiveUICard } from '../events.js'
import { dispatchSocialMessage } from '../social/dispatch.js'
import { callCapability, listCapabilities } from '../providers/registry.js'
import { isDailyLimitReached } from '../quota.js'
import { setCustomInterval as setTickerInterval, getStatus as getTickerStatus } from '../ticker.js'

// 后台进程注册表：pid → { process, command, startedAt }
const bgProcesses = new Map()

// URL 访问缓存：url → { content, fetchedAt (ms timestamp) }
// 避免同一 URL 在短时间内被反复请求（如天气每天只需查一次）
const urlCache = new Map()
const searchCache = new Map()

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

import { paths } from '../paths.js'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 文件操作只允许在 sandbox 目录内
const SANDBOX_ROOT = path.resolve(paths.sandboxDir)

// inline-script 草稿注册表（内存 + 磁盘双存）
const draftCodeMap = new Map()   // { scratchId → code }
const appIdToName  = new Map()   // { scratchId → appName }

// 由 api.js 调用：把 app:saveState 信号的状态自动落盘
export function persistAppState(componentId, state) {
  const name = appIdToName.get(componentId)
  if (!name) return false
  try {
    const statePath = path.resolve(SANDBOX_ROOT, 'apps', name, 'state.json')
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8')
    return true
  } catch { return false }
}

function createAbortError(reason = 'Aborted') {
  const err = new Error(reason)
  err.name = 'AbortError'
  return err
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError(signal.reason || 'Aborted')
}

function createMergedAbortSignal(signal, timeoutMs) {
  if (!signal && !timeoutMs) return null

  const controller = new AbortController()
  let timeoutId = null

  const abort = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason)
  }

  const onAbort = () => abort(signal?.reason || 'Aborted')
  if (signal) {
    if (signal.aborted) abort(signal.reason || 'Aborted')
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  if (timeoutMs) {
    timeoutId = setTimeout(() => abort(`Timeout ${timeoutMs}ms`), timeoutMs)
  }

  return {
    signal: controller.signal,
    cleanup() {
      if (timeoutId) clearTimeout(timeoutId)
      if (signal) signal.removeEventListener('abort', onAbort)
    },
  }
}

function isPathInside(parentDir, candidatePath) {
  const parent = path.resolve(parentDir)
  const candidate = path.resolve(candidatePath)
  const relative = path.relative(parent, candidate)
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

function assertInSandbox(resolvedPath) {
  if (!isPathInside(SANDBOX_ROOT, resolvedPath)) {
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
const TOOL_RISK = {
  read_file: 'low',
  list_dir: 'low',
  search_memory: 'low',
  list_processes: 'low',
  skip_recognition: 'low',
  send_message: 'medium',
  express: 'medium',
  write_file: 'medium',
  make_dir: 'medium',
  upsert_memory: 'medium',
  manage_reminder: 'medium',
  schedule_reminder: 'medium',
  manage_prefetch_task: 'medium',
  ui_show: 'medium',
  ui_update: 'medium',
  ui_hide: 'medium',
  ui_show_inline: 'medium',
  ui_patch: 'medium',
  manage_app: 'medium',
  set_tick_interval: 'medium',
  media_mode: 'low',
  music: 'low',
  delete_file: 'high',
  exec_command: 'high',
  kill_process: 'high',
  web_search: 'high',
  fetch_url: 'high',
  browser_read: 'high',
  speak: 'high',
  generate_lyrics: 'high',
  generate_music: 'high',
  generate_image: 'high',
  ui_register: 'high',
}

function classifyTool(name) {
  return TOOL_RISK[name] || 'medium'
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return '{}'
  }
}

function compactWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function previewValue(value, max = 180) {
  const text = typeof value === 'string' ? value : safeJsonStringify(value)
  const compact = compactWhitespace(text)
  return compact.length > max ? `${compact.slice(0, max)}...` : compact
}

function getExecutionSource(context = {}) {
  return context.source || context.trigger || (context.autonomous ? 'autonomous' : 'llm')
}

function summarizeToolExecution(name, args = {}) {
  switch (name) {
    case 'read_file':
      return `read_file(${args.path || args.filename || args.file_path || '?'})`
    case 'list_dir':
      return `list_dir(${args.path || args.dir || args.directory || '.'})`
    case 'write_file':
      return `write_file(${args.path || args.filename || args.file_path || '?'})`
    case 'delete_file':
      return `delete_file(${args.path || args.filename || args.file_path || '?'})`
    case 'make_dir':
      return `make_dir(${args.path || args.dir || args.directory || '?'})`
    case 'exec_command':
      return `exec_command(${String(args.command || args.cmd || '?').slice(0, 100)})`
    case 'fetch_url':
    case 'browser_read':
      return `${name}(${String(args.url || args.link || args.href || '?').slice(0, 120)})`
    case 'web_search':
      return `web_search(${String(args.query || args.q || args.keyword || '?').slice(0, 120)})`
    case 'send_message':
    case 'express':
      return `${name} -> ${args.target_id || '(unknown)'}`
    case 'upsert_memory': {
      const count = Array.isArray(args.memories) ? args.memories.length : 0
      return `upsert_memory(${count})`
    }
    default:
      return name
  }
}

function isDangerousShellCommand(command) {
  const text = String(command || '').trim()
  const reasons = []
  if (/(^|[\s"'`])\.\.([\\/]|$)/.test(text)) reasons.push('command references a parent directory')
  if (/(^|[\s"'`])[a-z]:[\\/]/i.test(text) || /(^|[\s"'`])[\\/]{2}[^\\/]/.test(text)) reasons.push('command references an absolute filesystem path')
  if (/(^|[\s"'`])~([\\/]|$)/.test(text) || /\$(home|env:userprofile)\b/i.test(text) || /%userprofile%/i.test(text)) reasons.push('command references the user home directory')
  if (/\bgit\s+reset\s+--hard\b/i.test(text) || /\bgit\s+clean\b/i.test(text)) reasons.push('command can destructively rewrite the worktree')
  if (/\b(format|diskpart|shutdown)\b/i.test(text)) reasons.push('command is system-level destructive or disruptive')
  return reasons
}

function evaluateToolPolicy(name, args = {}, context = {}) {
  const risk = classifyTool(name)
  if (name === 'exec_command') {
    const reasons = isDangerousShellCommand(args.command || args.cmd || '')
    if (reasons.length) return { allowed: false, risk, reason: reasons.join('; ') }
  }
  if (context.autonomous && risk === 'high' && !context.allowHighRiskAutonomy) {
    return { allowed: false, risk, reason: 'high-risk tool requires an explicit user-driven context' }
  }
  return { allowed: true, risk, reason: '' }
}

function inferToolStatus(result) {
  const text = String(result ?? '').trim()
  if (!text) return 'ok'
  try {
    const parsed = JSON.parse(text)
    return parsed?.ok === false ? 'error' : 'ok'
  } catch {}
  return /^(错误|请求失败|执行失败|命令超时|命令执行失败|閿欒|璇锋眰澶辫触|鎵ц澶辫触|鍛戒护瓒呮椂|鍛戒护鎵ц澶辫触)/.test(text) ? 'error' : 'ok'
}

function writeToolAuditLog({ name, args, context, policy, status, result = '', error = '', startedAt }) {
  const durationMs = Date.now() - startedAt
  const detailParts = []
  if (policy?.reason) detailParts.push(`policy=${policy.reason}`)
  const argPreview = previewValue(args, 160)
  if (argPreview && argPreview !== '{}') detailParts.push(`args=${argPreview}`)
  const resultPreview = previewValue(result || error, 220)
  if (resultPreview) detailParts.push(`result=${resultPreview}`)

  try {
    insertActionLog({
      timestamp: new Date(startedAt).toISOString(),
      tool: name,
      summary: summarizeToolExecution(name, args),
      detail: detailParts.join(' | '),
      status,
      risk: policy?.risk || classifyTool(name),
      argsJson: safeJsonStringify(args),
      resultPreview,
      error,
      durationMs,
      source: getExecutionSource(context),
    })
  } catch (err) {
    console.warn(`[audit] failed to persist tool audit log: ${err.message}`)
  }

  emitEvent('tool_audit', {
    tool: name,
    status,
    risk: policy?.risk || classifyTool(name),
    summary: summarizeToolExecution(name, args),
    duration_ms: durationMs,
    source: getExecutionSource(context),
  })
}

async function executeToolUnchecked(name, args, context = {}) {
  try {
    throwIfAborted(context.signal)
    switch (name) {
      case 'express':
        return await execExpress(args, context)
      case 'send_message':
        return await execSendMessage(args, context)
      case 'read_file':
        return await execReadFile(args, context)
      case 'list_dir':
        return await execListDir(args, context)
      case 'write_file':
        return await execWriteFile(args, context)
      case 'delete_file':
        return await execDeleteFile(args, context)
      case 'make_dir':
        return await execMakeDir(args, context)
      case 'exec_command':
        return await execCommand(args, context)
      case 'kill_process':
        return await execKillProcess(args)
      case 'list_processes':
        return await execListProcesses()
      case 'web_search':
        return await execWebSearch(args, context)
      case 'fetch_url':
        return await execFetchUrl(args, context)
      case 'browser_read':
        return await execBrowserRead(args, context)
      case 'search_memory':
        return await execSearchMemory(args)
      case 'upsert_memory':
        return await execUpsertMemory(args, context)
      case 'skip_recognition':
        return await execSkipRecognition(args)
      case 'speak':
        return await execSpeak(args)
      case 'generate_lyrics':
        return await execGenerateLyrics(args)
      case 'generate_music':
        return await execGenerateMusic(args)
      case 'generate_image':
        return await execGenerateImage(args)
      case 'set_tick_interval':
        return execSetTickInterval(args)
      case 'media_mode':
        return execMediaMode(args)
      case 'music':
        return await execMusic(args)
      case 'schedule_reminder':
      case 'manage_reminder':
        return await execManageReminder(args, context)
      case 'manage_prefetch_task':
        return execManagePrefetchTask(args)
      case 'ui_show':
        return execUIShow(args)
      case 'ui_update':
        return execUIUpdate(args)
      case 'ui_hide':
        return execUIHide(args)
      case 'ui_show_inline':
        return execUIShowInline(args)
      case 'ui_patch':
        return execUIPatch(args)
      case 'manage_app':
        return execManageApp(args)
      case 'ui_register':
        return execUIRegister(args)
      case 'set_task':
        return execSetTask(args, context)
      case 'complete_task':
        return execCompleteTask(args, context)
      case 'update_task_step':
        return execUpdateTaskStep(args, context)
      case 'recall_memory':
        return await execRecallMemory(args, context)
      default:
        return `错误：未知工具 "${name}"`
    }
  } catch (err) {
    if (err.name === 'AbortError') throw err
    return `执行失败：${err.message}`
  }
}

export async function executeTool(name, args, context = {}) {
  const startedAt = Date.now()
  const safeArgs = args || {}
  const policy = evaluateToolPolicy(name, safeArgs, context)

  if (!policy.allowed) {
    const result = toolJson({
      ok: false,
      tool: name,
      error: 'permission denied',
      policy: {
        risk: policy.risk,
        reason: policy.reason,
      },
    })
    writeToolAuditLog({ name, args: safeArgs, context, policy, status: 'denied', result, startedAt })
    return result
  }

  try {
    const result = await executeToolUnchecked(name, safeArgs, context)
    writeToolAuditLog({ name, args: safeArgs, context, policy, status: inferToolStatus(result), result, startedAt })
    return result
  } catch (err) {
    if (err.name === 'AbortError') throw err
    const result = `执行失败：${err.message}`
    writeToolAuditLog({ name, args: safeArgs, context, policy, status: 'error', result, error: err.message, startedAt })
    return result
  }
}

function resolveAllowedTargetId(targetId, allowedTargetIds = []) {
  const normalizedTarget = normalizeConversationPartyId(targetId)
  const normalizedAllowed = [...new Set((allowedTargetIds || []).map(id => normalizeConversationPartyId(id)).filter(Boolean))]
  if (!normalizedAllowed.length) {
    throw new Error('当前提示词未明确注入任何可发送的目标实体，禁止发送消息')
  }

  if (normalizedAllowed.includes(normalizedTarget)) {
    return normalizedTarget
  }

  const compact = value => String(value || '').trim().toLowerCase().replace(/^id:0*/, '')
  const targetCompact = compact(normalizedTarget)
  const fuzzyMatches = normalizedAllowed.filter(id => compact(id) === targetCompact)
  if (fuzzyMatches.length === 1) {
    console.log(`[send_message] ID 严格校验通过（模糊归一）: "${targetId}" → "${fuzzyMatches[0]}"`)
    return fuzzyMatches[0]
  }

  throw new Error(`target_id "${targetId}" 不在当前提示词明确注入的目标实体列表中：${normalizedAllowed.join(', ')}`)
}

function assertVisibleTargetId(targetId, visibleTargetIds = []) {
  const normalizedTarget = normalizeConversationPartyId(targetId)
  const normalizedVisible = [...new Set((visibleTargetIds || []).map(id => normalizeConversationPartyId(id)).filter(Boolean))]
  if (!normalizedVisible.length) {
    throw new Error('当前二层提示词未注入任何对话对象，禁止发送消息')
  }

  if (normalizedVisible.includes(normalizedTarget)) {
    return normalizedTarget
  }

  throw new Error(`target_id "${targetId}" 未出现在当前二层注入的对话记录中：${normalizedVisible.join(', ')}`)
}

function parseReminderDueAt(value) {
  if (!value || typeof value !== 'string') {
    throw new Error('未提供 due_at')
  }
  const dueAt = new Date(value.trim())
  if (Number.isNaN(dueAt.getTime())) {
    throw new Error('due_at 必须是合法的 ISO 8601 绝对时间，例如 2026-04-21T06:00:00+08:00')
  }
  return dueAt
}

function trimAssistantFluff(content) {
  let text = String(content || '').trim()
  if (!text) return text

  text = text
    .replace(/^(?:\s*\[assistant(?:\s+to\s+[^\]\r\n]+)?(?:\s+\d{4}-\d{2}-\d{2}T[^\]\r\n]+)?\]\s*)+/giu, '')
    .trim()

  const patterns = [
    /[，,、。.!！？~～\s]*(?:从现在起|从今以后|以后)?我就是[\u4e00-\u9fa5A-Za-z0-9 _-]{1,24}[，,、。.!！？~～\s]*为您效劳[！!～~。.\s]*$/u,
    /[，,、。.!！？~～\s]*有什么需要帮忙的[？?]?[，,、。.!！？~～\s]*(?:随时)?为您效劳[～~！!。.\s]*$/u,
    /[，,、。.!！？~～\s]*有什么需要我帮忙的[？?]?[，,、。.!！？~～\s]*(?:随时)?为您效劳[～~！!。.\s]*$/u,
    /[，,、。.!！？~～\s]*随时为您效劳[～~！!。.\s]*$/u,
    /[，,、。.!！？~～\s]*为您效劳[～~！!。.\s]*$/u,
    /[，,、。.!！？~～\s]*有什么需要帮忙的[？?]?[～~！!。.\s]*$/u,
    /[，,、。.!！？~～\s]*有什么需要我帮忙的[？?]?[～~！!。.\s]*$/u,
  ]

  let changed = true
  while (changed) {
    changed = false
    for (const pattern of patterns) {
      const next = text.replace(pattern, '').trim()
      if (next !== text) {
        text = next
        changed = true
      }
    }
  }

  return text
}

// express：表达器入口，根据 format 路由到对应输出渠道
async function execExpress({ target_id, content, format = 'text' }, context = {}) {
  if (!content?.trim()) return '错误：未提供表达内容'
  if (format === 'voice') {
    // 语音表达：先发文字消息再生成语音
    const sendResult = await execSendMessage({ target_id, content }, context)
    if (sendResult.startsWith('错误：') || sendResult.startsWith('执行失败：')) return sendResult
    return await execSpeak({ text: content })
  }
  // 默认：文字表达
  return await execSendMessage({ target_id, content }, context)
}

// send_message：推送到 SSE 流，所有订阅者实时收到
async function execSendMessage({ target_id, content }, context = {}) {
  if (!target_id) return '错误：未提供 target_id'
  if (!content?.trim()) return '错误：未提供消息内容'

  const resolvedId = resolveAllowedTargetId(target_id, context.allowedTargetIds)
  assertVisibleTargetId(resolvedId, context.visibleTargetIds)
  const cleanedContent = trimAssistantFluff(content)
  if (!cleanedContent) return '错误：消息内容为空'

  const timestamp = nowTimestamp()
  console.log(`\n[消息发送] → ${resolvedId}`)
  console.log(`  ${cleanedContent}`)
  console.log(`  时间：${timestamp}`)
  emitEvent('message', { from: 'consciousness', to: resolvedId, content: cleanedContent, timestamp })
  const socialResult = await dispatchSocialMessage(resolvedId, cleanedContent)
  if (socialResult?.ok) return `消息已发送至 ${resolvedId}（${socialResult.platform} 已投递）`
  if (socialResult?.skipped) return `消息已发送至 ${resolvedId}（社交平台未配置：${socialResult.reason}）`
  return `消息已发送至 ${resolvedId}`
}

function parseHourMinute(value, label = 'time') {
  const m = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!m) throw new Error(`${label} 必须是 HH:MM 格式，例如 09:00`)
  const hour = Number(m[1]), minute = Number(m[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new Error(`${label} 超出合法范围`)
  return { hour, minute }
}

// 周期提醒：根据 type/config 计算下一次触发时间（晚于 fromDate）
export function calculateNextDueAt(type, config, fromDate = new Date()) {
  const now = fromDate
  const { hour, minute } = parseHourMinute(config.time, 'time')

  if (type === 'daily') {
    const next = new Date(now)
    next.setHours(hour, minute, 0, 0)
    if (next <= now) next.setDate(next.getDate() + 1)
    return next
  }
  if (type === 'weekly') {
    const targetWeekday = Number(config.weekday)
    if (!Number.isInteger(targetWeekday) || targetWeekday < 0 || targetWeekday > 6) {
      throw new Error('weekday 必须是 0-6 之间的整数（0=周日）')
    }
    const next = new Date(now)
    next.setHours(hour, minute, 0, 0)
    let diff = (targetWeekday - now.getDay() + 7) % 7
    if (diff === 0 && next <= now) diff = 7
    next.setDate(next.getDate() + diff)
    return next
  }
  if (type === 'monthly') {
    const targetDay = Number(config.day_of_month)
    if (!Number.isInteger(targetDay) || targetDay < 1 || targetDay > 31) {
      throw new Error('day_of_month 必须是 1-31 之间的整数')
    }
    let year = now.getFullYear(), month = now.getMonth()
    for (let i = 0; i < 12; i++) {
      const lastDay = new Date(year, month + 1, 0).getDate()
      if (targetDay <= lastDay) {
        const next = new Date(year, month, targetDay, hour, minute, 0, 0)
        if (next > now) return next
      }
      month++
      if (month > 11) { month = 0; year++ }
    }
    throw new Error('找不到下一个匹配的月份')
  }
  throw new Error(`未知的 recurrence kind: ${type}`)
}

function buildSystemMessage(targetId, taskText) {
  return `我是系统，根据你设置的提醒，你现在要为用户 ${targetId} 执行这件事：${taskText}。请立即处理，并在需要时通过 send_message 把结果发给 ${targetId}。`
}

function formatReminderRow(r) {
  const recurrence = r.recurrence_type
    ? `[${r.recurrence_type}] ${(() => {
        try {
          const c = JSON.parse(r.recurrence_config || '{}')
          if (r.recurrence_type === 'daily') return `每天 ${c.time}`
          if (r.recurrence_type === 'weekly') {
            const names = ['周日','周一','周二','周三','周四','周五','周六']
            return `每${names[c.weekday]} ${c.time}`
          }
          if (r.recurrence_type === 'monthly') return `每月 ${c.day_of_month} 号 ${c.time}`
          return JSON.stringify(c)
        } catch { return '' }
      })()}`
    : '[once]'
  return `#${r.id} ${recurrence} 下次 ${r.due_at} → ${r.user_id}：${r.task}`
}

async function execManageReminder(args, context = {}) {
  const action = args.action || (args.due_at || args.kind ? 'create' : null)
  if (!action) return '错误：未提供 action（create/list/cancel）'

  if (action === 'list') {
    const rows = listPendingReminders(50)
    if (!rows.length) return '当前没有待触发的提醒。'
    return `共 ${rows.length} 条待触发提醒：\n` + rows.map(formatReminderRow).join('\n')
  }

  if (action === 'cancel') {
    const id = Number(args.id)
    if (!Number.isInteger(id) || id <= 0) return '错误：cancel 需要提供合法的提醒 id'
    const existing = getReminderById(id)
    if (!existing) return `错误：未找到提醒 #${id}`
    if (existing.status !== 'pending') return `错误：提醒 #${id} 当前状态为 ${existing.status}，无法取消`
    const result = cancelReminder(id)
    if (!result.changes) return `错误：取消提醒 #${id} 失败`
    emitEvent('reminder_cancelled', { id, user_id: existing.user_id, task: existing.task })
    return `提醒 #${id} 已取消（${existing.task}）`
  }

  if (action !== 'create') return `错误：未知 action "${action}"，仅支持 create/list/cancel`

  const { task } = args
  if (!task?.trim()) return '错误：未提供 task'
  const taskText = task.trim()
  const fallbackTargetId = context.visibleTargetIds?.[0] || context.allowedTargetIds?.[0] || 'ID:000001'
  const resolvedTargetId = resolveAllowedTargetId(args.target_id || fallbackTargetId, context.allowedTargetIds)

  const kind = args.kind || 'once'

  if (kind === 'once') {
    const dueAt = parseReminderDueAt(args.due_at)
    if (dueAt.getTime() <= Date.now()) throw new Error('提醒时间必须晚于当前时间')
    const isoDueAt = dueAt.toISOString()
    const minuteKey = isoDueAt.slice(0, 16)

    const mergeTarget = findMergeableOneOffReminder(resolvedTargetId, minuteKey)
    if (mergeTarget) {
      const mergedTaskText = `${mergeTarget.task}; ${taskText}`
      const newSystemMessage = buildSystemMessage(resolvedTargetId, mergedTaskText)
      const r = appendReminderTask(mergeTarget.id, taskText, newSystemMessage)
      if (!r.changes) return `错误：合并提醒 #${mergeTarget.id} 失败`
      emitEvent('reminder_merged', { id: mergeTarget.id, user_id: resolvedTargetId, due_at: mergeTarget.due_at, task: mergedTaskText })
      return `已合并到现有提醒 #${mergeTarget.id}（同时间），合并后任务：${mergedTaskText}`
    }

    const result = createReminder({
      userId: resolvedTargetId,
      dueAt: isoDueAt,
      task: taskText,
      systemMessage: buildSystemMessage(resolvedTargetId, taskText),
      source: `tool:manage_reminder@${nowTimestamp()}`,
    })
    emitEvent('reminder_created', { id: Number(result.lastInsertRowid), user_id: resolvedTargetId, due_at: isoDueAt, task: taskText })
    return `提醒已创建：#${result.lastInsertRowid}，将在 ${isoDueAt} 触发，目标用户 ${resolvedTargetId}`
  }

  // 周期提醒
  const config = {}
  if (kind === 'daily') {
    config.time = args.time
  } else if (kind === 'weekly') {
    config.time = args.time
    config.weekday = args.weekday
  } else if (kind === 'monthly') {
    config.time = args.time
    config.day_of_month = args.day_of_month
  } else {
    throw new Error(`未知的 kind "${kind}"，支持 once/daily/weekly/monthly`)
  }

  const nextDate = calculateNextDueAt(kind, config)
  const isoDueAt = nextDate.toISOString()
  const result = createReminder({
    userId: resolvedTargetId,
    dueAt: isoDueAt,
    task: taskText,
    systemMessage: buildSystemMessage(resolvedTargetId, taskText),
    source: `tool:manage_reminder@${nowTimestamp()}`,
    recurrenceType: kind,
    recurrenceConfig: config,
  })
  emitEvent('reminder_created', { id: Number(result.lastInsertRowid), user_id: resolvedTargetId, due_at: isoDueAt, task: taskText, recurrence_type: kind, recurrence_config: config })
  return `周期提醒已创建：#${result.lastInsertRowid} (${kind})，下次触发 ${isoDueAt}，目标用户 ${resolvedTargetId}`
}

// read_file：读取文件内容
async function execReadFile(args, context = {}) {
  throwIfAborted(context.signal)
  const rawPath = args.path || args.filename || args.file_path
  if (!rawPath) return '错误：未提供文件路径'
  const filePath = normalizeSandboxPath(rawPath)
  const resolved = path.resolve(SANDBOX_ROOT, filePath)
  assertInSandbox(resolved)
  return fs.readFileSync(resolved, 'utf-8')
}

// list_dir：列出目录内容
async function execListDir(args, context = {}) {
  throwIfAborted(context.signal)
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
async function execWriteFile(args, context = {}) {
  throwIfAborted(context.signal)
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
  const verifiedContent = fs.readFileSync(resolved, 'utf-8')
  const verified = verifiedContent === String(content)
  const bytes = Buffer.byteLength(verifiedContent, 'utf-8')
  if (!verified) {
    return toolJson({
      ok: false,
      tool: 'write_file',
      path: filePath,
      absolute_path: resolved,
      bytes,
      verified: false,
      error: 'read-back verification did not match written content',
    })
  }
  return toolJson({
    ok: true,
    tool: 'write_file',
    path: filePath,
    absolute_path: resolved,
    bytes,
    verified: true,
    content_preview: verifiedContent.slice(0, 120),
  })
}

// delete_file：删除沙盒内的文件或目录
async function execDeleteFile(args, context = {}) {
  throwIfAborted(context.signal)
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
    const verifiedAbsent = !fs.existsSync(resolved)
    return toolJson({
      ok: verifiedAbsent,
      tool: 'delete_file',
      path: filePath,
      kind: 'directory',
      verified_absent: verifiedAbsent,
    })
  } else {
    fs.unlinkSync(resolved)
    const verifiedAbsent = !fs.existsSync(resolved)
    return toolJson({
      ok: verifiedAbsent,
      tool: 'delete_file',
      path: filePath,
      kind: 'file',
      verified_absent: verifiedAbsent,
    })
  }
}

// make_dir：在沙盒内创建目录（支持多级）
async function execMakeDir(args, context = {}) {
  throwIfAborted(context.signal)
  const rawPath = args.path || args.dir || args.directory
  if (!rawPath) return '错误：未提供目录路径'
  const dirPath = normalizeSandboxPath(rawPath)
  const resolved = path.resolve(SANDBOX_ROOT, dirPath)
  assertInSandbox(resolved)
  fs.mkdirSync(resolved, { recursive: true })
  const verified = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
  return toolJson({
    ok: verified,
    tool: 'make_dir',
    path: dirPath,
    absolute_path: resolved,
    verified,
  })
}

// exec_command：在沙盒目录内执行 shell 命令
// background=true 时后台运行，返回 PID；否则等待完成，返回输出
async function execCommand(args, context = {}) {
  throwIfAborted(context.signal)
  const command = String(args.command || args.cmd || '').trim()
  if (!command) return toolJson({ ok: false, tool: 'exec_command', error: 'missing command' })

  const background = args.background === true || args.background === 'true'
  // schema 说明单位是秒，转换为毫秒；兼容旧调用（如果传入 >1000 视为已是毫秒）
  const rawTimeout = Number(args.timeout) || 30
  const timeoutMs = Math.max(1000, Math.min(rawTimeout < 1000 ? rawTimeout * 1000 : rawTimeout, 120000))

  console.log(`[exec_command] ${background ? '[后台]' : '[前台]'} ${command}`)
  emitEvent('exec_command', { command, background })

  if (background) {
    return execBackground(command)
  } else {
    return execForeground(command, timeoutMs, context.signal)
  }
}

function toolJson(payload) {
  return JSON.stringify(payload, null, 2)
}

function trimCommandOutput(value = '', max = 6000) {
  const text = String(value || '')
  return text.length > max ? `${text.slice(0, max)}\n\n...` : text
}

function execBackground(command) {
  const child = spawn(command, {
    shell: true,
    cwd: SANDBOX_ROOT,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const pid = child.pid
  if (!pid) {
    return toolJson({
      ok: false,
      tool: 'exec_command',
      mode: 'background',
      command,
      cwd: SANDBOX_ROOT,
      error: 'process did not start',
    })
  }
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

  return toolJson({
    ok: true,
    tool: 'exec_command',
    mode: 'background',
    command,
    cwd: SANDBOX_ROOT,
    pid,
    started_at: startedAt,
    hint: 'Process is running in the background. Use list_processes to inspect it or kill_process with this pid to stop it.',
  })
}

function execForeground(command, timeoutMs, signal) {
  return new Promise((resolve) => {
    throwIfAborted(signal)
    const child = spawn(command, {
      shell: true,
      cwd: SANDBOX_ROOT,
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let timer = null

    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      merged?.cleanup()
      resolve(value)
    }

    const merged = createMergedAbortSignal(signal)
    const onAbort = () => {
      child.kill()
      finish(toolJson({
        ok: false,
        tool: 'exec_command',
        mode: 'foreground',
        command,
        cwd: SANDBOX_ROOT,
        aborted: true,
        stdout: trimCommandOutput(stdout),
        stderr: trimCommandOutput(stderr),
        error: 'command aborted',
      }))
    }
    if (merged?.signal.aborted) {
      child.kill()
      finish(toolJson({
        ok: false,
        tool: 'exec_command',
        mode: 'foreground',
        command,
        cwd: SANDBOX_ROOT,
        aborted: true,
        stdout: '',
        stderr: '',
        error: 'command aborted before start',
      }))
      return
    }
    merged?.signal.addEventListener('abort', onAbort, { once: true })

    timer = setTimeout(() => {
      timedOut = true
      child.kill()
      finish(toolJson({
        ok: false,
        tool: 'exec_command',
        mode: 'foreground',
        command,
        cwd: SANDBOX_ROOT,
        timed_out: true,
        timeout_ms: timeoutMs,
        stdout: trimCommandOutput(stdout),
        stderr: trimCommandOutput(stderr),
        error: `command timed out after ${timeoutMs / 1000}s`,
        hint: 'If this is a long-running server, rerun with background=true.',
      }))
    }, timeoutMs)

    child.stdout?.on('data', (d) => { stdout += d.toString() })
    child.stderr?.on('data', (d) => { stderr += d.toString() })

    child.on('close', (code) => {
      if (timedOut) return
      finish(toolJson({
        ok: code === 0,
        tool: 'exec_command',
        mode: 'foreground',
        command,
        cwd: SANDBOX_ROOT,
        exit_code: code,
        stdout: trimCommandOutput(stdout),
        stderr: trimCommandOutput(stderr),
        error: code === 0 ? null : `command exited with code ${code}`,
        hint: code === 0 ? 'Command completed successfully.' : 'Inspect stderr/stdout before retrying or changing the command.',
      }))
    })

    child.on('error', (err) => {
      if (timedOut) return
      finish(toolJson({
        ok: false,
        tool: 'exec_command',
        mode: 'foreground',
        command,
        cwd: SANDBOX_ROOT,
        stdout: trimCommandOutput(stdout),
        stderr: trimCommandOutput(stderr),
        error: err.message,
      }))
    })
  })
}

// kill_process：停止后台进程（通过 PID）
async function execKillProcess(args) {
  const pid = Number(args.pid)
  if (!pid) return toolJson({ ok: false, tool: 'kill_process', error: 'missing pid' })
  const entry = bgProcesses.get(pid)
  if (!entry) return toolJson({ ok: false, tool: 'kill_process', pid, error: 'process not found or already exited' })
  entry.process.kill()
  bgProcesses.delete(pid)
  return toolJson({
    ok: true,
    tool: 'kill_process',
    pid,
    command: entry.command,
    stopped: true,
  })
}

// list_processes：列出当前后台进程
async function execListProcesses() {
  const processes = [...bgProcesses.entries()].map(([pid, { command, startedAt }]) => ({
    pid,
    command,
    started_at: startedAt,
  }))
  return toolJson({
    ok: true,
    tool: 'list_processes',
    count: processes.length,
    processes,
  })
}

const WEB_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
}

const BROWSER_VIEWPORT = { width: 1365, height: 900 }

function webJson(payload) {
  return JSON.stringify(payload, null, 2)
}

function normalizeWebUrl(raw) {
  const value = String(raw || '').trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) return value
  return `https://${value}`
}

function decodeHtmlEntities(value = '') {
  return String(value)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function htmlToText(html = '') {
  return decodeHtmlEntities(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function extractTitle(html = '') {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return match ? htmlToText(match[1]).slice(0, 200) : ''
}

function isLowValuePageText(text = '') {
  const compact = String(text || '').replace(/\s+/g, ' ').trim()
  if (compact.length < 80) return true
  return /^(please wait|just a moment|checking your browser|enable javascript|access denied|forbidden|captcha|安全验证|请稍候|请稍等|正在验证|访问受限)/i.test(compact)
}

// 长文阈值：抓取结果超过此长度时落盘，识别器只看摘要 + body_path
const ARTICLE_LENGTH_THRESHOLD = 2000
const ARTICLE_SUMMARY_EXCERPT = 800

function urlHash8(url) {
  return crypto.createHash('sha1').update(String(url || '')).digest('hex').slice(0, 8)
}

function sanitizeSlugPart(value, max = 40) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max)
}

// 把长文写入 sandbox/articles/{YYYY-MM}/{date}_{titleSlug}_{hash8}.md
// 同 URL 当天再次抓取直接复用已有文件，避免重复落盘
function saveLongArticle({ url, finalUrl, title, body, source }) {
  const now = new Date()
  const yyyyMm = now.toISOString().slice(0, 7)
  const date = now.toISOString().slice(0, 10)
  const hash = urlHash8(finalUrl || url || '')
  const titleSlug = sanitizeSlugPart(title)
  const baseName = titleSlug ? `${date}_${titleSlug}_${hash}.md` : `${date}_${hash}.md`

  const monthDir = path.join(SANDBOX_ROOT, 'articles', yyyyMm)
  const absPath = path.join(monthDir, baseName)
  const relPath = path.posix.join('articles', yyyyMm, baseName)

  if (fs.existsSync(absPath)) {
    return { path: relPath, bytes: fs.statSync(absPath).size, reused: true }
  }

  fs.mkdirSync(monthDir, { recursive: true })
  const frontmatter = [
    '---',
    `title: ${JSON.stringify(title || '')}`,
    `source_url: ${url || ''}`,
    finalUrl && finalUrl !== url ? `final_url: ${finalUrl}` : null,
    `source_tool: ${source || 'fetch_url'}`,
    `fetched_at: ${now.toISOString()}`,
    '---',
    '',
  ].filter(Boolean).join('\n')
  const content = frontmatter + (title ? `# ${title}\n\n` : '') + body
  fs.writeFileSync(absPath, content, 'utf-8')
  return { path: relPath, bytes: Buffer.byteLength(content, 'utf-8'), reused: false }
}

async function launchReadableBrowser() {
  const launchOptions = { headless: true }
  try {
    return await chromium.launch(launchOptions)
  } catch (firstError) {
    for (const channel of ['msedge', 'chrome']) {
      try {
        return await chromium.launch({ ...launchOptions, channel })
      } catch {}
    }
    throw firstError
  }
}

async function autoScrollPage(page, signal) {
  for (let i = 0; i < 4; i++) {
    throwIfAborted(signal)
    await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight, 800)))
    await page.waitForTimeout(450)
  }
  await page.evaluate(() => window.scrollTo(0, 0))
}

function unwrapDuckDuckGoUrl(url) {
  const decoded = decodeHtmlEntities(url)
  const uddg = decoded.match(/[?&]uddg=([^&]+)/)
  if (uddg) {
    try { return decodeURIComponent(uddg[1]) } catch { return uddg[1] }
  }
  if (decoded.startsWith('//')) return `https:${decoded}`
  return decoded
}

function parseDuckDuckGoResults(html, limit) {
  const results = []
  const resultRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let match
  while ((match = resultRegex.exec(html)) !== null && results.length < limit) {
    const url = unwrapDuckDuckGoUrl(match[1])
    const title = htmlToText(match[2])
    if (!url || !title) continue
    const nextStart = resultRegex.lastIndex
    const nextMatch = html.slice(nextStart).match(/<a[^>]+class="result__a"/i)
    const block = nextMatch ? html.slice(nextStart, nextStart + nextMatch.index) : html.slice(nextStart, nextStart + 2000)
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>|class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i)
    const snippet = htmlToText(snippetMatch?.[1] || snippetMatch?.[2] || '').slice(0, 300)
    results.push({ title, url, snippet })
  }
  return results
}

async function execWebSearch(args, context = {}) {
  throwIfAborted(context.signal)
  const query = String(args.query || args.q || args.keyword || '').trim()
  const limit = Math.max(1, Math.min(Number(args.limit) || 5, 8))
  if (!query) return webJson({ ok: false, tool: 'web_search', error: 'missing query' })

  const cacheKey = `${query}::${limit}`
  const cached = searchCache.get(cacheKey)
  if (cached && Date.now() - cached.fetchedAt < 10 * 60 * 1000) {
    return webJson({ ...cached.payload, cached: true })
  }

  const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  console.log(`[web_search] ${query}`)
  const merged = createMergedAbortSignal(context.signal, 12000)
  let res
  try {
    res = await fetch(searchUrl, { headers: WEB_HEADERS, signal: merged?.signal })
  } catch (err) {
    merged?.cleanup()
    if (err.name === 'AbortError') throw err
    return webJson({ ok: false, tool: 'web_search', query, error: err.message, hint: 'Search request failed. Try a more specific query or fetch a known reliable URL.' })
  }
  merged?.cleanup()

  if (!res.ok) {
    return webJson({ ok: false, tool: 'web_search', query, status: res.status, error: `HTTP ${res.status}`, hint: 'Search engine rejected the request. Try fetch_url with a known URL.' })
  }

  const html = await res.text()
  const results = parseDuckDuckGoResults(html, limit)
  const payload = results.length > 0
    ? { ok: true, tool: 'web_search', query, source: 'duckduckgo_html', results, hint: 'Open 1-3 reliable result URLs with fetch_url, then answer the user.' }
    : { ok: false, tool: 'web_search', query, source: 'duckduckgo_html', results: [], error: 'no results parsed', hint: 'Try a simpler query or a known URL.' }
  if (payload.ok) searchCache.set(cacheKey, { payload, fetchedAt: Date.now() })
  return webJson(payload)
}

// fetch_url: open a known URL, extract readable text, and return structured JSON.
async function execFetchUrl(args, context = {}) {
  throwIfAborted(context.signal)
  const url = normalizeWebUrl(args.url || args.URL || args.link || args.href || args.uri)
  if (!url) return webJson({ ok: false, tool: 'fetch_url', error: 'missing url' })

  const cached = urlCache.get(url)
  const ttl = getUrlTtl(url)
  if (cached && Date.now() - cached.fetchedAt < ttl) {
    const ageMin = Math.round((Date.now() - cached.fetchedAt) / 60000)
    return webJson({ ...cached.payload, cached: true, cache_age_minutes: ageMin })
  }

  console.log(`[fetch_url] -> ${url}`)
  let res
  const merged = createMergedAbortSignal(context.signal, 12000)
  try {
    res = await fetch(url, { headers: WEB_HEADERS, signal: merged?.signal })
  } catch (err) {
    merged?.cleanup()
    if (err.name === 'AbortError') throw err
    console.log(`[fetch_url] failed: ${url} - ${err.message}`)
    return webJson({ ok: false, tool: 'fetch_url', url, error: err.message, hint: 'Network request failed. Use web_search to find an alternate source.' })
  }
  merged?.cleanup()

  if (!res.ok) {
    return webJson({ ok: false, tool: 'fetch_url', url, status: res.status, error: `HTTP ${res.status}`, hint: 'This page could not be read. Use web_search to find another accessible source; do not treat this as page content.' })
  }

  const contentType = res.headers.get('content-type') || ''
  if (contentType && !/text|html|xml|json/i.test(contentType)) {
    return webJson({ ok: false, tool: 'fetch_url', url, status: res.status, content_type: contentType, error: 'unsupported content type', hint: 'Use a text/html source for reading.' })
  }

  const html = await res.text()
  const text = htmlToText(html)
  const title = extractTitle(html)
  if (isLowValuePageText(text)) {
    return webJson({
      ok: false,
      tool: 'fetch_url',
      url,
      status: res.status,
      title,
      error: 'no readable content extracted',
      content_preview: text.slice(0, 300),
      content_length: text.length,
      hint: 'The page opened, but readable article text was not extracted. It may require JavaScript rendering, block crawlers, or be an empty/verification page. Use web_search to find another accessible source.',
    })
  }
  const MAX = 5000
  const isLong = text.length >= ARTICLE_LENGTH_THRESHOLD
  let bodyPath = null
  let bodyBytes = null
  if (isLong) {
    try {
      const saved = saveLongArticle({ url, finalUrl: url, title, body: text, source: 'fetch_url' })
      bodyPath = saved.path
      bodyBytes = saved.bytes
    } catch (err) {
      console.warn(`[fetch_url] 长文落盘失败: ${err.message}`)
    }
  }
  const content = isLong
    ? `${text.slice(0, ARTICLE_SUMMARY_EXCERPT)}\n\n...`
    : (text.length > MAX ? `${text.slice(0, MAX)}\n\n...` : text)
  const payload = {
    ok: true,
    tool: 'fetch_url',
    url,
    status: res.status,
    title,
    content,
    truncated: isLong || text.length > MAX,
    content_length: text.length,
    body_path: bodyPath,
    body_bytes: bodyBytes,
    hint: bodyPath
      ? `Long article saved. Full text at sandbox path: ${bodyPath}. Use read_file to open it.`
      : 'Use this page content with other sources if needed, then answer the user.',
  }

  urlCache.set(url, { payload, fetchedAt: Date.now() })
  return webJson(payload)
}

async function execBrowserRead(args, context = {}) {
  throwIfAborted(context.signal)
  const url = normalizeWebUrl(args.url || args.URL || args.link || args.href || args.uri)
  if (!url) return webJson({ ok: false, tool: 'browser_read', error: 'missing url' })

  const timeoutMs = Math.max(5000, Math.min(Number(args.timeout_ms || args.timeout || 20000), 45000))
  const maxChars = Math.max(1000, Math.min(Number(args.max_chars || args.maxChars || 8000), 12000))
  console.log(`[browser_read] -> ${url}`)

  let browser
  let page
  try {
    browser = await launchReadableBrowser()
    const contextOptions = {
      viewport: BROWSER_VIEWPORT,
      locale: 'zh-CN',
      userAgent: WEB_HEADERS['User-Agent'],
    }
    const browserContext = await browser.newContext(contextOptions)
    page = await browserContext.newPage()
    page.setDefaultTimeout(timeoutMs)
    page.setDefaultNavigationTimeout(timeoutMs)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 12000) }).catch(() => {})
    await autoScrollPage(page, context.signal)

    const title = (await page.title()).trim()
    const text = await page.evaluate(() => {
      const selectors = ['script', 'style', 'noscript', 'svg', 'canvas', 'iframe']
      selectors.forEach(selector => document.querySelectorAll(selector).forEach(el => el.remove()))
      const candidates = [...document.querySelectorAll('article, main, [role="main"], .article, .post, .content')]
      const best = candidates
        .map(el => ({ el, text: (el.innerText || '').trim() }))
        .sort((a, b) => b.text.length - a.text.length)[0]
      return (best?.text && best.text.length > 200 ? best.text : document.body?.innerText || '').trim()
    })
    const finalUrl = page.url()
    await browser.close()
    browser = null

    if (isLowValuePageText(text)) {
      return webJson({
        ok: false,
        tool: 'browser_read',
        url,
        final_url: finalUrl,
        title,
        error: 'no readable content rendered',
        content_preview: String(text || '').slice(0, 300),
        content_length: String(text || '').length,
        hint: 'The browser opened the page, but did not find readable article text. The page may require login, CAPTCHA, or block automation. Try another source.',
      })
    }

    const isLong = text.length >= ARTICLE_LENGTH_THRESHOLD
    let bodyPath = null
    let bodyBytes = null
    if (isLong) {
      try {
        const saved = saveLongArticle({ url, finalUrl, title, body: text, source: 'browser_read' })
        bodyPath = saved.path
        bodyBytes = saved.bytes
      } catch (err) {
        console.warn(`[browser_read] 长文落盘失败: ${err.message}`)
      }
    }
    const content = isLong
      ? `${text.slice(0, ARTICLE_SUMMARY_EXCERPT)}\n\n...`
      : (text.length > maxChars ? `${text.slice(0, maxChars)}\n\n...` : text)
    return webJson({
      ok: true,
      tool: 'browser_read',
      url,
      final_url: finalUrl,
      title,
      content,
      truncated: isLong || text.length > maxChars,
      content_length: text.length,
      body_path: bodyPath,
      body_bytes: bodyBytes,
      hint: bodyPath
        ? `Long article saved. Full text at sandbox path: ${bodyPath}. Use read_file to open it.`
        : 'Rendered page content extracted by Chromium.',
    })
  } catch (err) {
    if (err.name === 'AbortError') throw err
    return webJson({
      ok: false,
      tool: 'browser_read',
      url,
      error: err.message || String(err),
      hint: 'Browser rendering failed. Try fetch_url or another accessible source.',
    })
  } finally {
    try { await page?.close() } catch {}
    try { await browser?.close() } catch {}
  }
}

// search_memory：批量按关键词检索记忆。
// 优先走 keywords 数组；为兼容旧调用方，单字符串 keyword 也接受（自动转数组）。
// 输入有 keywords 时返回 JSON 字符串（结构化命中 + matched_by），用于识别器查重。
// 输入只有 keyword 时返回旧版拼接字符串，用于主对话主动检索。
async function execSearchMemory(args = {}) {
  const { keyword, keywords, limit, limit_per_keyword, type_filter } = args

  if (Array.isArray(keywords) && keywords.length > 0) {
    const cleaned = keywords.map(k => String(k || '').trim()).filter(Boolean).slice(0, 8)
    if (cleaned.length === 0) return JSON.stringify({ ok: false, error: 'no valid keywords' })
    const hits = searchMemoriesByKeywords(cleaned, {
      limitPerKeyword: Math.max(1, Math.min(Number(limit_per_keyword || 5), 10)),
      typeFilter: type_filter || null,
    })
    return JSON.stringify({ ok: true, count: hits.length, hits }, null, 2)
  }

  if (keyword) {
    const rows = searchMemories(keyword, Math.max(1, Math.min(Number(limit || 5), 20)))
    if (rows.length === 0) return `未找到包含"${keyword}"的记忆`
    return rows.map(m =>
      `[${m.timestamp.slice(0, 10)}] ${m.event_type}: ${m.content}\n  ${m.detail?.slice(0, 100) ?? ''}`
    ).join('\n\n')
  }

  return '错误：未提供 keywords 或 keyword'
}

// upsert_memory：识别器调用，按 mem_id 批量 upsert。
async function execUpsertMemory(args = {}, context = {}) {
  const list = Array.isArray(args.memories) ? args.memories : null
  if (!list || list.length === 0) {
    return JSON.stringify({ ok: false, error: 'missing memories[]' })
  }

  const sourceRef = context.sessionRef || context.source_ref || null
  // 同批次：无 parent 的先写，有 parent 的后写，保证父节点 mem_id 已就绪
  const roots = list.filter(m => !m.parent_mem_id)
  const children = list.filter(m => m.parent_mem_id)
  const ordered = [...roots, ...children]

  const results = []
  for (const memory of ordered) {
    try {
      const payload = { ...memory, source_ref: memory.source_ref || sourceRef }
      const r = upsertMemoryByMemId(payload)
      results.push({ mem_id: r.mem_id, action: r.updated ? 'updated' : 'inserted', id: r.id })
    } catch (err) {
      results.push({ mem_id: memory.mem_id || null, action: 'error', error: err.message })
    }
  }

  const inserted = results.filter(r => r.action === 'inserted').length
  const updated = results.filter(r => r.action === 'updated').length
  const failed = results.filter(r => r.action === 'error').length
  return JSON.stringify({ ok: failed === 0, inserted, updated, failed, results }, null, 2)
}

// skip_recognition：识别器明确表示无内容要存
async function execSkipRecognition({ reason } = {}) {
  return JSON.stringify({ ok: true, skipped: true, reason: reason || '' })
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

// 语音消息自动回复 TTS：检测到用户用语音输入时，通知前端播放语音
// 由 index.js 调用，前端收到 tts_reply 事件后调用 /tts/stream 完成实际合成
// 对话型内容上限（流畅散文，天气/时间/短回答等）
const TTS_PROSE_LIMIT = 150
// 列表型内容判定：换行数 ÷ 总字数 超过此比例视为列表
const TTS_LIST_DENSITY = 0.05

export function autoSpeakForVoiceReply(text) {
  if (!text) return
  const raw = text.trim()
  if (!raw) return

  // 判断是否列表型（多行条目：热点、搜索结果等）
  const lineBreaks = (raw.match(/\n/g) || []).length
  const isList = lineBreaks >= 3 && lineBreaks / raw.length > TTS_LIST_DENSITY

  const plain = raw
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/#{1,6}\s+/g, '')
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
    .replace(/!\[[^\]]*\]\([^\)]+\)/g, '')
    .replace(/\n+/g, ' ')
    .trim()
  if (!plain) return

  let spoken
  if (!isList && plain.length <= TTS_PROSE_LIMIT) {
    // 对话型且不超限：完整播放
    spoken = plain
  } else {
    // 列表型或超长：只播第一句 + 提示
    const sentenceEnd = plain.search(/[。！？!?]/)
    const firstSentence = sentenceEnd > 0 ? plain.slice(0, sentenceEnd + 1) : plain.slice(0, 60)
    spoken = firstSentence.trim() + '，详情请看文字。'
  }

  emitEvent('tts_reply', { text: spoken })
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

// generate_image：生成图片
async function execGenerateImage({ prompt, aspect_ratio = '1:1', n = 1 }) {
  if (!prompt) return '错误：未提供图片描述'
  if (isDailyLimitReached('image')) return '错误：今日图片生成配额已用完（50 次/天）'
  const validRatios = new Set(['1:1', '16:9', '4:3', '3:4', '9:16'])
  const ratio = validRatios.has(aspect_ratio) ? aspect_ratio : '1:1'
  const count = Math.min(Math.max(Math.floor(n) || 1, 1), 4)

  const result = await callCapability('image', { prompt, aspect_ratio: ratio, n: count })

  emitEvent('image_created', { urls: result.urls, prompt: prompt.slice(0, 60) })
  console.log(`[image] 已生成 ${result.urls.length} 张图片`)
  return `图片已生成（${result.urls.length} 张）：\n${result.urls.join('\n')}`
}

// manage_prefetch_task：管理预热任务
function execManagePrefetchTask({ action, source, label, url, ttl_minutes, tags }) {
  if (action === 'list') {
    const tasks = listPrefetchTasks()
    if (tasks.length === 0) return '当前没有预热任务。'
    return tasks.map(t =>
      `[${t.enabled ? '✓' : '✗'}] ${t.source}  ${t.label}  TTL=${t.ttl_minutes}min\n  URL: ${t.url}`
    ).join('\n')
  }

  if (action === 'add') {
    if (!source) return '错误：缺少 source'
    if (!label) return '错误：缺少 label'
    if (!url) return '错误：缺少 url'
    upsertPrefetchTask({ source, label, url, ttlMinutes: ttl_minutes ?? 60, tags: tags ?? [] })
    return `预热任务已保存：${source}（${label}），TTL=${ttl_minutes ?? 60}min。下次运行预热时生效。`
  }

  if (action === 'remove') {
    if (!source) return '错误：缺少 source'
    const ok = removePrefetchTask(source)
    return ok ? `预热任务已删除：${source}` : `未找到任务：${source}`
  }

  return `错误：未知 action "${action}"，可选 add / remove / list`
}

// set_tick_interval：L2 调节自身思维节奏
function execSetTickInterval({ seconds, ttl, reason }) {
  const res = setTickerInterval({ seconds, ttl, reason })
  if (!res.ok) return `错误：${res.error}`
  const parts = [`节奏已设为 ${res.seconds}s，持续 ${res.ttl} 轮`]
  if (res.clampedFrom?.seconds !== undefined) parts.push(`（seconds ${res.clampedFrom.seconds} 越界，已 clamp 到 ${res.seconds}）`)
  if (res.clampedFrom?.ttl !== undefined) parts.push(`（ttl ${res.clampedFrom.ttl} 越界，已 clamp 到 ${res.ttl}）`)
  return parts.join('')
}

// ─────────────────────────────────────────────────────────────────────────────
// ACUI · UI 控制工具
// ─────────────────────────────────────────────────────────────────────────────
function execMediaMode(args = {}) {
  const mode = String(args.mode || args.kind || '').trim()
  const action = String(args.action || 'show').trim()
  if (!['video', 'camera', 'image', 'music'].includes(mode)) {
    return JSON.stringify({ ok: false, tool: 'media_mode', error: 'mode must be video, camera, image, or music' })
  }
  if (!['show', 'hide', 'close', 'play', 'pause', 'seek', 'set_volume', 'update'].includes(action)) {
    return JSON.stringify({ ok: false, tool: 'media_mode', error: 'unsupported action' })
  }

  const payload = {
    mode,
    action,
    url: typeof args.url === 'string' ? args.url : undefined,
    src: typeof args.src === 'string' ? args.src : undefined,
    title: typeof args.title === 'string' ? args.title : undefined,
    artist: typeof args.artist === 'string' ? args.artist : undefined,
    lrc: typeof args.lrc === 'string' ? args.lrc : undefined,
    cover: typeof args.cover === 'string' ? args.cover : undefined,
    alt: typeof args.alt === 'string' ? args.alt : undefined,
    autoplay: typeof args.autoplay === 'boolean' ? args.autoplay : (mode === 'music' ? true : undefined),
    muted: typeof args.muted === 'boolean' ? args.muted : undefined,
    camera: mode === 'camera' || args.camera === true,
  }

  if (Number.isFinite(Number(args.volume))) {
    payload.volume = Math.max(0, Math.min(1, Number(args.volume)))
  }
  if (Number.isFinite(Number(args.currentTime ?? args.time ?? args.seek))) {
    payload.currentTime = Math.max(0, Number(args.currentTime ?? args.time ?? args.seek))
  }

  emitEvent('media_mode', payload)
  emitEvent('action', { tool: 'media_mode', summary: `${mode}:${action}`, detail: payload.title || payload.url || '' })
  return JSON.stringify({ ok: true, tool: 'media_mode', ...payload })
}

// ── Music Library ─────────────────────────────────────────────────────────────

const MUSIC_AUDIO_EXTS = new Set(['.mp3', '.flac', '.wav', '.aac', '.ogg', '.m4a', '.opus'])

async function fetchLrcFromNet(title, artist) {
  try {
    const params = new URLSearchParams({ track_name: title })
    if (artist) params.set('artist_name', artist)
    const res = await fetch(`https://lrclib.net/api/get?${params}`, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'BaiLongma/1.0' },
    })
    if (!res.ok) return null
    const data = await res.json()
    return data.syncedLyrics || data.plainLyrics || null
  } catch {
    return null
  }
}

function runCommand(cmd, cwd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, cwd: cwd || paths.musicDir })
    let stdout = '', stderr = ''
    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', d => { stderr += d.toString() })
    child.on('close', code => resolve({ code, stdout, stderr }))
    child.on('error', err => resolve({ code: -1, stdout, stderr: err.message }))
  })
}

const YTDLP_LOCAL = path.join(paths.musicDir, 'yt-dlp.exe')
const YTDLP_URL   = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'

async function resolveYtDlp() {
  // 1. 系统 PATH 里有就直接用
  const sys = await runCommand('yt-dlp --version', paths.musicDir)
  if (sys.code === 0) return 'yt-dlp'

  // 2. music 目录里有本地副本就用它
  if (fs.existsSync(YTDLP_LOCAL)) {
    const local = await runCommand(`"${YTDLP_LOCAL}" --version`, paths.musicDir)
    if (local.code === 0) return `"${YTDLP_LOCAL}"`
  }

  // 3. 自动下载 yt-dlp.exe 到 music 目录
  emitEvent('action', { tool: 'music', summary: 'yt-dlp 未安装，正在自动下载…', detail: YTDLP_URL })
  const res = await fetch(YTDLP_URL, { signal: AbortSignal.timeout(60000) })
  if (!res.ok) return null
  const buf = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(YTDLP_LOCAL, buf)
  fs.chmodSync(YTDLP_LOCAL, 0o755)
  return `"${YTDLP_LOCAL}"`
}

async function execMusic(args = {}) {
  const action = String(args.action || 'list').trim()
  const musicDir = paths.musicDir

  // ── list ──────────────────────────────────────────────────────────────────
  if (action === 'list') {
    const rows = listMusicLibrary(Number(args.limit) || 50)
    return JSON.stringify({ ok: true, count: rows.length, tracks: rows })
  }

  // ── search ────────────────────────────────────────────────────────────────
  if (action === 'search') {
    const q = String(args.query || '').trim()
    if (!q) return JSON.stringify({ ok: false, error: 'query required' })
    const rows = searchMusicLibrary(q, Number(args.limit) || 20)
    return JSON.stringify({ ok: true, count: rows.length, tracks: rows })
  }

  // ── scan ──────────────────────────────────────────────────────────────────
  if (action === 'scan') {
    const entries = fs.readdirSync(musicDir, { withFileTypes: true })
    const added = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (!MUSIC_AUDIO_EXTS.has(ext)) continue
      const filePath = path.join(musicDir, entry.name)
      const baseName = path.basename(entry.name, ext)
      const track = upsertMusicTrack({ title: baseName, filePath })
      added.push({ id: track.id, title: track.title, file_path: track.file_path })
    }
    return JSON.stringify({ ok: true, scanned: added.length, tracks: added })
  }

  // ── add ───────────────────────────────────────────────────────────────────
  if (action === 'add') {
    const filePath = String(args.path || '').trim()
    if (!filePath) return JSON.stringify({ ok: false, error: 'path required' })
    if (!fs.existsSync(filePath)) return JSON.stringify({ ok: false, error: `file not found: ${filePath}` })
    const ext = path.extname(filePath).toLowerCase()
    if (!MUSIC_AUDIO_EXTS.has(ext)) return JSON.stringify({ ok: false, error: `unsupported format: ${ext}` })
    const baseName = path.basename(filePath, ext)
    const track = upsertMusicTrack({
      title: String(args.title || baseName),
      artist: String(args.artist || ''),
      album: String(args.album || ''),
      filePath,
    })
    return JSON.stringify({ ok: true, track })
  }

  // ── download ──────────────────────────────────────────────────────────────
  if (action === 'download') {
    const url = String(args.url || '').trim()
    if (!url) return JSON.stringify({ ok: false, error: 'url required' })

    // 自动解析 yt-dlp 路径（没有则自动下载）
    const ytdlp = await resolveYtDlp()
    if (!ytdlp) return JSON.stringify({ ok: false, error: 'yt-dlp 自动下载失败，请检查网络连接' })

    // Download: print final filepath after conversion
    const outTemplate = path.join(musicDir, '%(title)s.%(ext)s').replace(/\\/g, '/')
    const dlCmd = `${ytdlp} -x --audio-format mp3 --audio-quality 192K --no-playlist --print after_move:filepath -o "${outTemplate}" "${url}"`
    const result = await runCommand(dlCmd)

    if (result.code !== 0) {
      return JSON.stringify({ ok: false, error: `yt-dlp failed: ${result.stderr.slice(0, 400)}` })
    }

    // Parse output filepath (last non-empty line)
    const lines = result.stdout.trim().split('\n').map(l => l.trim()).filter(Boolean)
    let filePath = lines[lines.length - 1] || ''

    // Fallback: scan for newest mp3 in musicDir
    if (!filePath || !fs.existsSync(filePath)) {
      const files = fs.readdirSync(musicDir)
        .filter(f => f.endsWith('.mp3'))
        .map(f => ({ f, mt: fs.statSync(path.join(musicDir, f)).mtimeMs }))
        .sort((a, b) => b.mt - a.mt)
      if (files.length) filePath = path.join(musicDir, files[0].f)
    }

    if (!filePath || !fs.existsSync(filePath)) {
      return JSON.stringify({ ok: false, error: 'Download completed but could not locate output file' })
    }

    const baseName = path.basename(filePath, '.mp3')
    const title  = String(args.title  || baseName)
    const artist = String(args.artist || '')

    // Auto-fetch lyrics
    let lrc = ''
    if (title) {
      lrc = await fetchLrcFromNet(title, artist) || ''
    }

    const track = upsertMusicTrack({ title, artist, album: String(args.album || ''), filePath, lrc, sourceUrl: url })
    return JSON.stringify({ ok: true, track, lrc_fetched: Boolean(lrc) })
  }

  // ── get_lyrics ────────────────────────────────────────────────────────────
  if (action === 'get_lyrics') {
    const id = Number(args.id)
    let title  = String(args.title  || '').trim()
    let artist = String(args.artist || '').trim()

    if (id) {
      const track = getMusicTrack(id)
      if (!track) return JSON.stringify({ ok: false, error: `track id=${id} not found` })
      if (!title)  title  = track.title
      if (!artist) artist = track.artist
    }
    if (!title) return JSON.stringify({ ok: false, error: 'title required' })

    const lrc = await fetchLrcFromNet(title, artist)
    if (!lrc) return JSON.stringify({ ok: false, error: `lyrics not found for "${title}" on lrclib.net` })

    if (id) updateMusicLrc(id, lrc)
    return JSON.stringify({ ok: true, id: id || null, title, artist, lrc_length: lrc.length, lrc })
  }

  // ── delete ────────────────────────────────────────────────────────────────
  if (action === 'delete') {
    const id = Number(args.id)
    if (!id) return JSON.stringify({ ok: false, error: 'id required' })
    const track = getMusicTrack(id)
    if (!track) return JSON.stringify({ ok: false, error: `track id=${id} not found` })
    dbDeleteMusicTrack(id)
    return JSON.stringify({ ok: true, deleted: { id, title: track.title } })
  }

  return JSON.stringify({ ok: false, error: `unknown action: ${action}` })
}

const ACUI_COMPONENTS_PATH = path.resolve(__dirname, 'ui-components.json')
const ACUI_REGISTRY_PATH   = path.resolve(__dirname, '..', 'ui', 'brain-ui', 'acui', 'registry.js')
const ACUI_COMPONENTS_DIR  = path.resolve(__dirname, '..', 'ui', 'brain-ui', 'acui', 'components')

let _acuiComponentsCache = null
function loadACUIComponents() {
  if (!_acuiComponentsCache) {
    _acuiComponentsCache = JSON.parse(fs.readFileSync(ACUI_COMPONENTS_PATH, 'utf-8'))
  }
  return _acuiComponentsCache
}
function invalidateACUIComponentsCache() { _acuiComponentsCache = null }

// 校验并就地容错：number-like 字符串自动转 number，避免 LLM 把 "18" 当 18 传过来时硬挂。
function validateProps(propsSchema, props) {
  if (!props || typeof props !== 'object') return null
  for (const [name, spec] of Object.entries(propsSchema)) {
    let v = props[name]
    if (spec.required && (v === undefined || v === null)) {
      return `字段 ${name} 必填`
    }
    if (v === undefined || v === null) continue
    const t = spec.type
    if (t === 'number' && typeof v !== 'number') {
      // 容错：LLM 经常把数字当字符串传（"18"、"23.5"）。是合法 number-like 字符串就转一下。
      if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) {
        props[name] = Number(v)
        continue
      }
      return `字段 ${name} 必须为 number`
    }
    if (t === 'string' && typeof v !== 'string') return `字段 ${name} 必须为 string`
    if (t === 'array'  && !Array.isArray(v))    return `字段 ${name} 必须为 array`
    if (t === 'object' && (typeof v !== 'object' || Array.isArray(v))) return `字段 ${name} 必须为 object`
    if (t === 'boolean' && typeof v !== 'boolean') return `字段 ${name} 必须为 boolean`
  }
  return null
}

// 合并 LLM 给的 hint 和组件 propsSchema 默认值，按 placement 推断动画/拖动/遮罩默认。
function mergeHint(hint, def) {
  const h = hint && typeof hint === 'object' ? hint : {}
  const placement = ['notification', 'center', 'floating', 'stage'].includes(h.placement)
    ? h.placement
    : (def?.placement || 'notification')

  const enterDefaults = { notification: 'slide-from-right', center: 'scale-up', floating: 'fade-up', stage: 'stage-up' }
  const exitDefaults  = { notification: 'slide-to-right',   center: 'scale-down', floating: 'fade-down', stage: 'stage-down' }

  const draggable = typeof h.draggable === 'boolean' ? h.draggable
    : (typeof def?.draggable === 'boolean' ? def.draggable : (placement === 'floating'))
  const modal = typeof h.modal === 'boolean' ? h.modal
    : (typeof def?.modal === 'boolean' ? def.modal : (placement === 'center' || placement === 'stage'))

  const size = h.size ?? def?.size ?? 'md'

  // def.enter/exit 只在 placement=notification 时生效；切换到 center/floating/stage
  // 组件原来的 slide-from-right 就不合适了，按 placement 默认动画走。
  const usesDefAnim = placement === 'notification'
  return {
    placement,
    size,
    draggable,
    modal,
    enter: h.enter || (usesDefAnim ? def?.enter : null) || enterDefaults[placement],
    exit:  h.exit  || (usesDefAnim ? def?.exit  : null) || exitDefaults[placement],
  }
}

function execUIShow({ component, props, hint }) {
  console.log(`[ui_show] component=${component} props=${JSON.stringify(props)}`)
  if (!component) return '错误：未提供 component'
  const components = loadACUIComponents()
  const def = components[component]
  if (!def) return `错误：组件 "${component}" 未注册（可用：${Object.keys(components).join(', ') || '无'}）`

  const propsErr = validateProps(def.propsSchema, props || {})
  if (propsErr) return `错误：props 校验失败 — ${propsErr}（实际 props=${JSON.stringify(props)}）`

  if (!hasACUIClient()) return '错误：当前没有 UI 客户端连接，请改用文字回答'

  const id = `${component.toLowerCase()}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
  emitUICommand({
    op: 'mount',
    id,
    component,
    props,
    hint: mergeHint(hint, def),
  })
  addActiveUICard(id, { component })
  emitEvent('action', { tool: 'ui_show', summary: `推送 ${component}`, detail: id })
  return JSON.stringify({ ok: true, id })
}

function execUIHide({ id }) {
  if (!id) return '错误：未提供 id'
  if (!hasACUIClient()) return '错误：当前没有 UI 客户端连接'
  emitUICommand({ op: 'unmount', id })
  removeActiveUICard(id)
  emitEvent('action', { tool: 'ui_hide', summary: `关闭卡片`, detail: id })
  return JSON.stringify({ ok: true, id })
}

function execUIUpdate({ id, props }) {
  if (!id) return '错误：未提供 id'
  if (!props || typeof props !== 'object' || Array.isArray(props)) return '错误：props 必须为对象'
  if (!hasACUIClient()) return '错误：当前没有 UI 客户端连接'
  emitUICommand({ op: 'update', id, props })
  emitEvent('action', { tool: 'ui_update', summary: `更新卡片`, detail: id })
  return JSON.stringify({ ok: true, id })
}

function execUIShowInline({ mode, template, styles, code, props, hint }) {
  if (mode !== 'inline-template' && mode !== 'inline-script') return `错误：mode 必须为 inline-template / inline-script，当前 "${mode}"`
  // 容错：LLM 漏传 props 或写成 null 时兜底成 {}。模板里没用到字段就不需要 props。
  if (props == null) props = {}
  if (typeof props !== 'object' || Array.isArray(props)) return '错误：props 必须为对象（可省略，但传了就必须是对象）'

  if (mode === 'inline-template') {
    if (!template || typeof template !== 'string') return '错误：mode=inline-template 时 template 为必填字符串'
    if (template.length > 8000) return '错误：template 过长（>8000 字符），请精简或转用 ui_register 注册组件'
  } else {
    if (!code || typeof code !== 'string') return '错误：mode=inline-script 时 code 为必填字符串'
    if (code.length > 32000) return '错误：code 过长（>32000 字符），请精简或转用 ui_register'
    if (!/export\s+default\s+class\s+\w*\s*extends\s+HTMLElement/.test(code)) {
      return '错误：code 必须以 `export default class extends HTMLElement` 形式开头'
    }
    // 后端语法预检：包一层 try/catch，仅做 parse 不真正执行
    try {
      new Function(code.replace(/^\s*export\s+default\s+/m, 'return '))
    } catch (e) {
      return `错误：代码语法预检失败 — ${e.message}`
    }
  }

  if (!hasACUIClient()) return '错误：当前没有 UI 客户端连接，请改用文字回答'

  const id = `scratch-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
  const payload = {
    op: 'mount',
    mode,
    id,
    props,
    hint: mergeHint(hint, null),
  }
  if (mode === 'inline-template') {
    payload.template = template
    if (styles) payload.styles = styles
  } else {
    payload.code = code
  }

  // inline-script 草稿自动落盘，供 manage_app(save) 和服务重启后恢复
  if (mode === 'inline-script') {
    draftCodeMap.set(id, code)
    try {
      const draftDir = path.resolve(SANDBOX_ROOT, 'apps', '.drafts')
      fs.mkdirSync(draftDir, { recursive: true })
      fs.writeFileSync(path.resolve(draftDir, `${id}.js`), code, 'utf-8')
    } catch (_) {}
  }

  addActiveUICard(id, { component: mode })
  emitUICommand(payload)
  emitEvent('action', {
    tool: 'ui_show_inline',
    summary: `临场组件 (${mode})`,
    detail: id,
    code: mode === 'inline-script' ? code.slice(0, 800) : undefined,
    template: mode === 'inline-template' ? template.slice(0, 800) : undefined,
  })
  return JSON.stringify({ ok: true, id, mode })
}

function execUIPatch({ id, op, data }) {
  if (!id) return '错误：未提供 id'
  if (!op) return '错误：未提供 op'
  if (!hasACUIClient()) return '错误：当前没有 UI 客户端连接'
  emitUICommand({ op: 'patch', id, patchOp: op, data: data || {} })
  emitEvent('action', { tool: 'ui_patch', summary: `应用补丁 ${op}`, detail: id })
  return JSON.stringify({ ok: true, id, op })
}

function execManageApp({ action, name, label, draft_id, state, hint }) {
  const appsRoot = path.resolve(SANDBOX_ROOT, 'apps')

  if (action === 'save') {
    if (!name) return '错误：save 操作必须提供 name'
    if (!draft_id) return '错误：save 操作必须提供 draft_id'
    // 从内存或草稿文件取代码
    let code = draftCodeMap.get(draft_id)
    if (!code) {
      const draftPath = path.resolve(appsRoot, '.drafts', `${draft_id}.js`)
      if (!fs.existsSync(draftPath)) return `错误：找不到草稿 ${draft_id}，请确认 draft_id 是 ui_show_inline 返回的 id`
      code = fs.readFileSync(draftPath, 'utf-8')
    }
    const appDir = path.resolve(appsRoot, name)
    fs.mkdirSync(appDir, { recursive: true })
    // 版本备份（若已有同名应用）
    const componentPath = path.resolve(appDir, 'component.js')
    const metaPath = path.resolve(appDir, 'meta.json')
    if (fs.existsSync(componentPath) && fs.existsSync(metaPath)) {
      try {
        const oldMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
        const v = oldMeta.version || 1
        fs.copyFileSync(componentPath, path.resolve(appDir, `component.v${v}.js`))
      } catch (_) {}
    }
    const meta = {
      name, label: label || name,
      created_at: new Date().toISOString(),
      last_used: new Date().toISOString(),
      version: 2,
      draft_id,
      hint: hint || { placement: 'floating', size: 'lg' },
    }
    fs.writeFileSync(componentPath, code, 'utf-8')
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8')
    if (state) fs.writeFileSync(path.resolve(appDir, 'state.json'), JSON.stringify(state, null, 2), 'utf-8')
    appIdToName.set(draft_id, name)
    emitEvent('action', { tool: 'manage_app', summary: `保存应用 ${name}`, detail: draft_id })
    return JSON.stringify({ ok: true, name, path: `sandbox/apps/${name}/` })
  }

  if (action === 'open') {
    if (!name) return '错误：open 操作必须提供 name'
    const appDir = path.resolve(appsRoot, name)
    if (!fs.existsSync(appDir)) return `错误：应用 "${name}" 不存在，请先 save`
    const code = fs.readFileSync(path.resolve(appDir, 'component.js'), 'utf-8')
    const meta = JSON.parse(fs.readFileSync(path.resolve(appDir, 'meta.json'), 'utf-8'))
    let savedState = {}
    const statePath = path.resolve(appDir, 'state.json')
    if (!state && fs.existsSync(statePath)) {
      savedState = JSON.parse(fs.readFileSync(statePath, 'utf-8'))
    }
    const props = state || savedState
    const mountHint = hint || meta.hint || { placement: 'floating', size: 'lg' }
    const result = execUIShowInline({ mode: 'inline-script', code, props, hint: mountHint })
    try {
      const parsed = JSON.parse(result)
      if (parsed.ok) {
        appIdToName.set(parsed.id, name)
        meta.last_used = new Date().toISOString()
        fs.writeFileSync(path.resolve(appDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8')
      }
    } catch (_) {}
    emitEvent('action', { tool: 'manage_app', summary: `打开应用 ${name}`, detail: name })
    return result
  }

  if (action === 'list') {
    if (!fs.existsSync(appsRoot)) return JSON.stringify({ ok: true, apps: [] })
    const apps = fs.readdirSync(appsRoot, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== '.drafts')
      .map(d => {
        try { return JSON.parse(fs.readFileSync(path.resolve(appsRoot, d.name, 'meta.json'), 'utf-8')) }
        catch { return { name: d.name } }
      })
    return JSON.stringify({ ok: true, apps })
  }

  if (action === 'delete') {
    if (!name) return '错误：delete 操作必须提供 name'
    const appDir = path.resolve(appsRoot, name)
    if (!fs.existsSync(appDir)) return `错误：应用 "${name}" 不存在`
    fs.rmSync(appDir, { recursive: true })
    emitEvent('action', { tool: 'manage_app', summary: `删除应用 ${name}`, detail: name })
    return JSON.stringify({ ok: true, name, deleted: true })
  }

  return `错误：未知 action "${action}"，可用：save / open / list / delete`
}

function isPascalCase(name) { return /^[A-Z][A-Za-z0-9]*$/.test(name) }
function pascalToKebab(name) { return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase() }

const RESERVED_COMPONENT_NAMES = new Set(['Inline', 'System', 'Base', 'Test'])

function execUIRegister({ component_name, code, props_schema, use_case, example_call }) {
  if (!component_name || !isPascalCase(component_name)) return '错误：component_name 必须为 PascalCase（如 TodoCard）'
  if (RESERVED_COMPONENT_NAMES.has(component_name)) return `错误：component_name "${component_name}" 是保留名`
  if (!code || typeof code !== 'string') return '错误：code 必填字符串'
  if (!props_schema || typeof props_schema !== 'object' || Array.isArray(props_schema)) return '错误：props_schema 必须为对象'
  if (!use_case || typeof use_case !== 'string') return '错误：use_case 必填'
  if (!example_call || typeof example_call !== 'string') return '错误：example_call 必填'

  // code 必须含 customElements.define & static tagName
  if (!/customElements\s*\.\s*define/.test(code)) return '错误：code 必须以 customElements.define(...) 注册收尾'
  if (!/static\s+tagName\s*=\s*['"`]/.test(code)) return '错误：code 必须含 static tagName = "acui-..."'

  // 占用检查
  const components = loadACUIComponents()
  if (components[component_name]) return `错误：组件名 "${component_name}" 已存在`

  // 语法预检：剥离顶层 import / export 行（new Function 不接受 module 语法）
  try {
    const stripped = code
      .replace(/^\s*import\s[^\n]*\n/gm, '')
      .replace(/^\s*export\s+default\s+/gm, '')
      .replace(/^\s*export\s*\{[^}]*\}[^\n]*\n/gm, '')
      .replace(/^\s*export\s+/gm, '')
    new Function(stripped)
  } catch (e) {
    return `错误：代码语法预检失败 — ${e.message}`
  }

  const kebab = pascalToKebab(component_name)
  const filePath = path.join(ACUI_COMPONENTS_DIR, `${kebab}.js`)

  // 文件名必须严格 kebab-case，且只能写入 components 目录内
  const resolved = path.resolve(filePath)
  if (!isPathInside(ACUI_COMPONENTS_DIR, resolved)) return '错误：目标路径越界'
  if (fs.existsSync(resolved)) return `错误：目标文件已存在：${kebab}.js`

  // 写组件文件
  fs.writeFileSync(resolved, code, 'utf-8')

  // 改 registry.js：在 import 区追加，COMPONENTS 对象内追加键
  let registry = fs.readFileSync(ACUI_REGISTRY_PATH, 'utf-8')
  const importLine = `import { ${component_name} } from './components/${kebab}.js'`
  if (!registry.includes(importLine)) {
    // 在最后一个 import 后追加
    registry = registry.replace(/((?:^import .*\n)+)/m, (m) => m + importLine + '\n')
  }
  // 在 COMPONENTS 对象里追加键
  if (!new RegExp(`\\b${component_name}\\s*[,}]`).test(registry)) {
    registry = registry.replace(/export const COMPONENTS = \{([\s\S]*?)\}/, (m, body) => {
      const trimmed = body.replace(/\s+$/, '')
      const sep = trimmed.endsWith(',') || trimmed === '' ? '' : ','
      return `export const COMPONENTS = {${trimmed}${sep}\n  ${component_name},\n}`
    })
  }
  fs.writeFileSync(ACUI_REGISTRY_PATH, registry, 'utf-8')

  // 改 ui-components.json
  components[component_name] = {
    propsSchema: props_schema,
    enter: 'slide-from-right',
    exit:  'slide-to-right',
  }
  fs.writeFileSync(ACUI_COMPONENTS_PATH, JSON.stringify(components, null, 2), 'utf-8')
  invalidateACUIComponentsCache()

  // seed skill.ui 记忆
  const skillContent = `[技能·UI] ${component_name}\n适用场景：${use_case}\n调用示例：${example_call}`
  try {
    insertMemory({
      mem_id: `skill-ui-${kebab}`,
      type: 'skill',
      content: skillContent,
      detail: skillContent,
      title: `UI 组件：${component_name}`,
      tags: ['skill.ui', `component:${component_name}`],
      entities: [],
      timestamp: new Date().toISOString(),
    })
  } catch (e) {
    console.warn(`[ui_register] 写技能记忆失败：${e.message}（组件已注册成功）`)
  }

  // 通知前端热重载 registry
  emitACUIEvent('acui:reload', { component_name })

  emitEvent('action', { tool: 'ui_register', summary: `转正组件 ${component_name}`, detail: kebab })
  return JSON.stringify({ ok: true, component_name, file: `${kebab}.js` })
}

// ─────────────────────────────────────────────────────────────────────────────
// 任务管理工具（通过 context 回调通知 index.js）
// ─────────────────────────────────────────────────────────────────────────────

function execSetTask({ description, steps = [] }, context) {
  if (!description?.trim()) return '错误：未提供任务描述'
  if (!Array.isArray(steps) || steps.length === 0) return '错误：steps 不能为空，请提供具体执行步骤'
  if (!context?.onSetTask) return '错误：任务管理回调未注册'
  const cleanSteps = steps.map(s => String(s).trim()).filter(Boolean)
  context.onSetTask(description.trim(), cleanSteps)
  return `任务已开启：${description}\n步骤（${cleanSteps.length} 个）：\n${cleanSteps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`
}

function execCompleteTask({ summary = '' }, context) {
  if (!context?.onCompleteTask) return '错误：任务管理回调未注册'
  context.onCompleteTask(String(summary || '').trim())
  return `任务已完成${summary ? '：' + summary : ''}`
}

function execUpdateTaskStep({ step_index, status, note = '' }, context) {
  if (step_index === undefined || step_index === null) return '错误：未提供步骤编号'
  const idx = Number(step_index)
  if (!Number.isInteger(idx) || idx < 0) return '错误：步骤编号必须为非负整数'
  if (!['done', 'failed', 'skipped'].includes(status)) return '错误：status 必须为 done/failed/skipped'
  if (!context?.onUpdateTaskStep) return '错误：任务管理回调未注册'
  const result = context.onUpdateTaskStep(idx, status, String(note || '').trim())
  if (result?.error) return `错误：${result.error}`
  const statusLabel = { done: '完成 ✓', failed: '失败 ✗', skipped: '跳过 —' }[status]
  return `步骤 ${idx + 1} 已标记为${statusLabel}${note ? '：' + note : ''}`
}

async function execRecallMemory({ query }, context) {
  if (!query?.trim()) return '错误：未提供查询内容'
  if (context?.onRecall) context.onRecall(query.trim())
  const rows = searchMemories(query.trim(), 8)
  if (rows.length === 0) return `记忆库中未找到与"${query}"相关的内容，已标记下轮持续关注此主题。`
  const results = rows.map(m =>
    `[${m.timestamp.slice(0, 10)}] ${m.event_type || m.type || ''}: ${m.content}\n  ${(m.detail || '').slice(0, 100)}`
  ).join('\n\n')
  return `已找到 ${rows.length} 条相关记忆（下轮将持续注入此主题）：\n\n${results}`
}
