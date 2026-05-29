import { config, getMinimaxKey as _getMinimaxKey, getSecurity } from './config.js'
import { callLLM } from './llm.js'
import { buildSystemPrompt, buildContextBlock, combinePromptForPreview } from './prompt.js'
import { runRecognizer } from './memory/recognizer.js'
import { runInjector, formatMemoriesForPrompt, formatTaskKnowledge, formatPrefetchedItems, formatActiveUICards, formatTemporalRecall } from './memory/injector.js'
import { updateFocusFrame } from './memory/focus.js'
import { compressPoppedFrame } from './memory/focus-compress.js'
import { runMemoryRefreshLoop } from './memory/refresh-loop.js'
import { startConsolidationLoop } from './memory/consolidation-loop.js'
import { gatherContext, formatExtraContext } from './context/gatherer.js'
import { getDB, getConfig, setConfig, getKnownEntities, getOrInitBirthTime, insertConversation, insertMemory, getRecentConversationPartners, getDueReminders, markReminderFired, advanceReminderDueAt, getNextPendingReminder, getMemoryCount, getRecentConversationTimeline, loadFocusStack, saveFocusStack } from './db.js'
import { calculateNextDueAt, autoSpeakForVoiceReply } from './capabilities/executor.js'
import { popMessage, hasMessages, hasUserMessages, getQueueSnapshot, setInterruptCallback, requeueMessage, pushMessage } from './queue.js'
import { startTUI } from './tui.js'
import { startAPI } from './api.js'
import { emitEvent, emitUICommand, addActiveUICard, hasACUIClient, setStickyEvent, clearStickyEvent } from './events.js'
import { formatTick, nowTimestamp, describeExistence } from './time.js'
import { getAdaptiveTickInterval, getQuotaStatus, setRateLimited, isRateLimited, getTickInterval } from './quota.js'
import { registerProvider } from './providers/registry.js'
import { MinimaxProvider } from './providers/minimax.js'
import { isRunning, setScheduler } from './control.js'
import { getCustomIntervalMs, consumeTick as consumeTickerTick, getStatus as getTickerStatus } from './ticker.js'
import { seedSandboxOnce, seedMusicOnce } from './paths.js'
import { ensureSkillMemories } from './memory/seed-skills.js'
import { loadInstalledTools } from './capabilities/marketplace/index.js'
import { dispatchSocialMessage } from './social/dispatch.js'
import { startSocialConnectors } from './social/index.js'
import { buildHotspotRuntimeContext, buildHotspotPanelStateContext } from './hotspots.js'
import { buildPersonCardRuntimeContext, buildPersonCardPanelStateContext } from './person-cards.js'
import { buildWeatherRuntimeContext, getWeatherCardProps } from './weather.js'
import { buildDocRuntimeContext, buildDocPanelStateContext, detectDocTopic, setDocPanelState } from './docs.js'
import { collectSystemInfo, getSystemInfoBlock, getBatteryBlock, getDesktopPath } from './system-info.js'
import { collectDesktopInfo, getDesktopBlock } from './desktop-scanner.js'
import { collectLocalResources } from './local-resources-scanner.js'
import { collectGeoWeather, getGeoWeatherBlock } from './geo-weather.js'
import { collectTrending, getTrendingBlock } from './trending.js'
import { collectAgents, buildAgentContextBlock, buildDelegationAskDirections } from './agents/registry.js'
import { initIPLocation, getIPLocationBlock, getCurrentVisitorInfo, clearCurrentVisitorInfo } from './ip-location.js'
import { tryAutoConfigureKey } from './key-auto-config.js'
import { PRIMARY_USER_ID, formatPresenceForPrompt, normalizeChannel } from './identity.js'

// On first launch, copy sandbox seed files from the resource directory to the user data directory (Electron install)
seedSandboxOnce()
seedMusicOnce()

// Collect host system environment info (full scan + persist on first run, then refresh dynamic fields).
// Must complete before the main loop starts so buildSystemPrompt can inject the env block.
await collectSystemInfo()

// Scan the user's desktop (shortcuts cached by mtime, regular files scanned every time)
collectDesktopInfo(getDesktopPath())

// Scan the user's local resources (ssh hosts, keys, known_hosts, git identity)
// for the "Self-Sufficient Execution" prompt — so the agent already knows what
// the user has before being asked "上服务器看看".
collectLocalResources()

// Collect geo-location + live weather (refresh on IP change or after 7 days; weather refreshed every time)
const geoResult = await collectGeoWeather()

// Collect trending topics (CN → Weibo+Zhihu, others → HN+Reddit; 1h cache)
await collectTrending(geoResult?.location?.country_code)

// Initialize IP location module for analyzing visitor IPs
initIPLocation()

// Scan locally installed AI agents (Claude Code, Codex, Hermes, OpenClaw, etc.) and persist to known_agents table
await collectAgents()

// Load persisted installed tools
await loadInstalledTools()

// AbortController for the current LLM call (used to interrupt the main loop)
let currentAbortController = null
let currentExecution = null

// Watchdog：单轮 runTurn 超过这个时间未返回视为卡死（最可能是 fetch/LLM stream/三方网络调用
// 没传 AbortSignal 也没自己超时）。触发后强 abort，把 processing 清掉，主循环能继续
// 处理后续消息。不修复挂着的 promise（它会留在内存里直到 GC 或自行结束），但保证 UI
// "思考中"永远在有限时间内解锁、用户的下一句话能被正常处理。
const RUN_TURN_WATCHDOG_MS = 180_000

const PRIORITY = {
  tick: 10,
  background: 50,
  user: 100,
}

const L2_CONTEXT_HOURS = 24 * 7
const STARTUP_SELF_CHECK_VERSION = 'v1'
const STARTUP_SELF_CHECK_CONFIG_KEY = 'l2_startup_self_check'

// Initialize database
getDB()
if (getMemoryCount() === 0) {
  console.log('[system] Memory store is empty — injecting default seed memories')
  await import('../scripts/seed-memories.js')
}
const birthTime = getOrInitBirthTime()

// Awakening phase: first 10 heartbeat ticks after initial activation run at a fixed 10s cadence
const AWAKENING_CONFIG_KEY = 'awakening_ticks_remaining'
function getAwakeningTicks() {
  const raw = getConfig(AWAKENING_CONFIG_KEY)
  if (raw === null || raw === undefined || raw === '') return 10
  return Math.max(0, parseInt(raw, 10) || 0)
}
function decrementAwakeningTick() {
  const current = getAwakeningTicks()
  if (current > 0) setConfig(AWAKENING_CONFIG_KEY, String(current - 1))
}

// Awakening exploration tasks: after self-check completes, each autonomous heartbeat tick completes one in order
const EXPLORATION_INDEX_KEY = 'awakening_exploration_index'
// AwakeningCard call template — must be executed after completing each exploration step:
// ui_show("AwakeningCard", { index: N, total: 3, title: "title", finding: "one-sentence finding", emoji: "emoji" })
const AWAKENING_EXPLORATION_TASKS = [
  // 1. Read existing memories
  `Exploration (1/2): See what you already know.
Go through the injected memories and take stock: who do you know, what do you know, are there any threads with no follow-up.
Do this quietly. If you find something forgotten — something the user mentioned months ago but never brought up again — you can mention it in passing, but do not ask "do you need me to handle it?".
When done, call ui_show("AwakeningCard", { index:1, total:2, title:"Reading memories", finding:"(one sentence: the most notable lead in the memory store, or 'memory store ready')", emoji:"🧠" }).`,

  // 2. Surface an unfinished thread
  `Exploration (2/2): Find a forgotten thread.
Look through memories — what did the user mention before but never bring up again? A plan, an idea, something they said they wanted to do but never did?
If you find one, bring it up casually. Do not ask "do you need me to move this forward?" — just mention it and see how they react.
When done, call ui_show("AwakeningCard", { index:2, total:2, title:"Unfinished thread", finding:"(one sentence describing the forgotten thread, or 'no open threads found')", emoji:"🔍" }).`,
]

function getExplorationIndex() {
  const raw = getConfig(EXPLORATION_INDEX_KEY)
  if (raw === null || raw === undefined || raw === '') return 0
  return Math.max(0, parseInt(raw, 10) || 0)
}
function advanceExplorationTask() {
  const current = getExplorationIndex()
  if (current < AWAKENING_EXPLORATION_TASKS.length) {
    setConfig(EXPLORATION_INDEX_KEY, String(current + 1))
  }
}
function buildAwakeningExplorationDirections() {
  if (getAwakeningTicks() <= 0) return null  // 觉醒期已结束，不再注入探索任务
  const index = getExplorationIndex()
  if (index < AWAKENING_EXPLORATION_TASKS.length) return AWAKENING_EXPLORATION_TASKS[index]
  // All exploration tasks done — check whether to ask about agent delegation permissions
  const delegationAsk = buildDelegationAskDirections()
  return delegationAsk || null
}

// Restore persisted task from database (survives restarts)
const persistedTask = getConfig('current_task')
let persistedTaskSteps = []
try {
  const raw = getConfig('current_task_steps')
  if (raw) persistedTaskSteps = JSON.parse(raw)
} catch {}
if (persistedTask) {
  console.log(`[system] Resuming in-progress task: ${persistedTask.slice(0, 80)}`)
  if (persistedTaskSteps.length) console.log(`[system] Restoring task steps: ${persistedTaskSteps.length} step(s)`)
}

// Register provider (MiniMax handles multimedia capabilities, independent of the LLM choice).
function registerMinimaxIfAvailable() {
  const envKey = process.env.MINIMAX_API_KEY
  const configKey = config.provider === 'minimax' ? config.apiKey : null
  const storedKey = _getMinimaxKey()
  const key = envKey || configKey || storedKey
  if (key) registerProvider(new MinimaxProvider({ apiKey: key }))
}
registerMinimaxIfAvailable()

if (config.needsActivation) {
  console.log('[LLM] Not activated — waiting for user to enter API key on the activation page')
} else {
  console.log(`[LLM] Using ${config.provider} (model: ${config.model})`)
}

// Runtime state
const state = {
  action: null,
  task: persistedTask || null,
  taskSteps: persistedTaskSteps,  // [{ text, status, note }], status: pending/done/failed/skipped
  taskIdleTickCount: 0,           // consecutive idle tick count (increments when no tool calls in task mode)
  prev_recall: null,
  lastToolResult: null, // result of the last tool call; injected by the injector on the next TICK then cleared
  sessionCounter: 0,
  recentActions: [], // summaries of recent turns, format: { ts, summary }
  thoughtStack: [],  // thought stack, max 3 entries, format: { concept, line }
  startupSelfCheck: null,
  pendingConfidenceHint: null,  // 上一轮 refresh-loop 的 confidence，供下次 runInjector 调整召回数量后清空
  tickCounter: 0,             // 累计 TICK 计数（每次进 isTick 路径自增）
  lastTaskRefreshTick: -10,   // 上次 TICK 路径触发 refresh-loop 时的 tickCounter；初值 -10 保证首个 TICK 立刻可触发（差值 = 0 - (-10) = 10 >= 5）
  focusStack: loadFocusStack(),  // 动态上下文记忆池第 3b/5c 步：注意力焦点栈（栈底 → 栈顶），重启从 db 恢复
}

const TASK_IDLE_TICK_LIMIT = 5  // auto-clear task after N consecutive task ticks with no tool calls

function autoCompleteTask(reason) {
  const clearedTask = state.task
  state.task = null
  state.lastTaskRefreshTick = -10
  state.taskSteps = []
  state.taskIdleTickCount = 0
  setConfig('current_task', '')
  setConfig('current_task_steps', '[]')
  console.log(`[task] Auto-cleared (${reason}): ${clearedTask}`)
  emitEvent('task_cleared', { task: clearedTask, summary: `Auto-cleared: ${reason}` })
  if (clearedTask) {
    insertMemory({
      event_type: 'task_complete',
      content: `Task auto-cleared: ${clearedTask.slice(0, 60)}`,
      detail: `Reason: ${reason}`,
      entities: [], concepts: [], tags: ['task_complete'],
      timestamp: nowTimestamp(),
    })
  }
}

function newSessionRef() {
  state.sessionCounter++
  return `session_${Date.now()}_${state.sessionCounter}`
}

function readStartupSelfCheckState() {
  try {
    const raw = getConfig(STARTUP_SELF_CHECK_CONFIG_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function writeStartupSelfCheckState(value) {
  setConfig(STARTUP_SELF_CHECK_CONFIG_KEY, JSON.stringify(value))
}

function ensureStartupSelfCheckState() {
  const current = readStartupSelfCheckState()
  if (current?.version === STARTUP_SELF_CHECK_VERSION && current.status === 'completed') {
    state.startupSelfCheck = { ...current, active: false }
    return state.startupSelfCheck
  }

  const now = nowTimestamp()
  const next = {
    version: STARTUP_SELF_CHECK_VERSION,
    status: 'running',
    started_at: current?.started_at || now,
    updated_at: now,
    attempts: Number(current?.attempts || 0) + (current?.status === 'running' ? 0 : 1),
    results: current?.version === STARTUP_SELF_CHECK_VERSION && current?.results ? current.results : {},
    active: true,
  }
  writeStartupSelfCheckState(next)
  state.startupSelfCheck = next
  return next
}

function buildStartupSelfCheckDirections(checkState) {
  if (!checkState?.active) return ''
  return [
    `This is the L2 startup self-check flow (${STARTUP_SELF_CHECK_VERSION}). It runs once; when finished you must call complete_startup_self_check to record the results — it will not run again.`,
    `[HARD RULE — DO NOT VIOLATE] During self-check, calling send_message is strictly forbidden. No text output of any kind (including "checking…", "self-check complete", or any other text). All status must be expressed through speak (voice) and ui_show (cards). The text channel must remain completely silent; any text output counts as self-check failure.`,
    `Complete the following 3 checks in order. Before each one, you must simultaneously play a voice announcement and show a progress card. After the check completes, close the card before moving to the next:`,
    `1. Call speak text="Checking file read/write"; call ui_show("SelfCheckStepCard", {step:1, total:3, name:"File read/write", icon:"📁"}) and save the returned id as step_card_id. Then: use write_file to write self_check.txt in the sandbox root (content = current timestamp), then read_file it back to verify consistency. Record the result and call ui_hide(step_card_id).`,
    `2. Call speak text="Checking hotspot panel"; call ui_show("SelfCheckStepCard", {step:2, total:3, name:"Hotspot panel", icon:"🌐"}) and save the returned id as step_card_id. Then: hotspot_mode action=show; confirm it returns ok, then hotspot_mode action=hide. Record the result and call ui_hide(step_card_id).`,
    `3. Call speak text="Checking video mode"; call ui_show("SelfCheckStepCard", {step:3, total:3, name:"Video mode", icon:"🎬"}) and save the returned id as step_card_id. Then: web_search for "bilibili Iron Man JARVIS" to find a BV number; media_mode mode=video action=show url=https://www.bilibili.com/video/<BV> autoplay=true; wait ~5 seconds; media_mode mode=video action=hide. Record the result and call ui_hide(step_card_id).`,
    `Result values: use ok, degraded, error, or skipped_* for each item. Continue to the next item even if one fails.`,
    `[FINAL TWO STEPS — REQUIRED]\n(a) Call ui_show to display SelfCheckCard with props: { results: [{name:"File read/write",status:"ok/error",...},{name:"Hotspot panel",...},{name:"Video mode",...}], overall:"ok/degraded/error" }. Infer overall from actual results: all ok → ok; any skipped → degraded; any error → error.\n(b) Call complete_startup_self_check with a summary (one sentence) and the results object.`,
  ].join('\n')
}

// 把工具结果压缩成"前端可安全 JSON.parse"的字符串。
// 原本用 slice(0, 1000) 会从字符串中间切断 JSON，让 thought-stream 的人类化格式器拿不到结构，
// 只能回退展示原始（残缺的）JSON 文本。
function truncateToolResultForUI(parsed, raw) {
  if (parsed && typeof parsed === 'object') {
    const compact = compactToolPayload(parsed)
    const out = JSON.stringify(compact)
    if (out.length <= 4000) return out
    return out.slice(0, 4000)
  }
  return String(raw ?? '').slice(0, 1000)
}

function compactToolPayload(payload) {
  if (Array.isArray(payload)) {
    return payload.slice(0, 10).map(compactToolPayload)
  }
  if (payload && typeof payload === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(payload)) {
      if (typeof v === 'string' && v.length > 600) {
        const cut = v.slice(0, 600)
        out[k] = `${cut}…（已截断，原 ${v.length} 字符）`
      } else if (v && typeof v === 'object') {
        out[k] = compactToolPayload(v)
      } else {
        out[k] = v
      }
    }
    return out
  }
  return payload
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

function requiresToolForUserMessage(text = '') {
  const input = String(text || '')
  const fileIntent = /(sandbox|文件|目录|创建|新建|写入|读取|删除|列出|保存|test-\d+|\.txt|\.json|\.md|\.js|\.html|\.css)/i.test(input)
    && /(创建|新建|写入|读取|删除|列出|保存|改|修改|生成|create|write|read|delete|list|save)/i.test(input)
  const commandIntent = /(执行命令|运行命令|跑命令|exec|command|npm|node|git|powershell|cmd)/i.test(input)
  const webIntent = /(打开网页|抓取|联网|搜索|查询最新|fetch|url|https?:\/\/)/i.test(input)
  return fileIntent || commandIntent || webIntent
}

function hasNonMessageToolCall(toolCallLog = []) {
  return toolCallLog.some(t => t.name && t.name !== 'send_message')
}

// Fallback 投递：当模型未按协议调 send_message 时由主循环代为投递。
// 用 msg 自带的 externalPartyId + channel 路由（用户从哪儿发，就回到哪儿），并写入 conversations 表。
function deliverFallbackReply(msg, content, timestamp) {
  const channel = msg.channel || ''
  const externalPartyId = msg.externalPartyId || ''
  emitEvent('message', {
    from: 'consciousness',
    to: msg.fromId,
    content,
    timestamp,
    channel,
    external_party_id: externalPartyId,
  })
  if (externalPartyId) {
    dispatchSocialMessage(externalPartyId, content).catch(err => console.warn('[social] fallback send failed:', err.message))
  }
  insertConversation({
    role: 'jarvis',
    from_id: 'jarvis',
    to_id: msg.fromId,
    content,
    timestamp,
    channel,
    external_party_id: externalPartyId,
  })
}

export function buildToolContext({ currentTargetId = null, conversationWindow = [], includeRecentPartners = false } = {}) {
  const visibleTargetIds = [
    currentTargetId,
    ...conversationWindow.flatMap(item => [item.from_id, item.to_id]),
  ].filter(id => id && id !== 'jarvis')

  // TICK scenario: add recent contacts and the primary user so the agent can proactively reach established connections.
  if (includeRecentPartners && !currentTargetId) {
    visibleTargetIds.push(PRIMARY_USER_ID, ...getRecentConversationPartners(L2_CONTEXT_HOURS, 20))
  }

  const unique = [...new Set(visibleTargetIds.filter(Boolean))]
  return { allowedTargetIds: unique, visibleTargetIds: unique }
}

function buildToolContextForProcess(msg, injection) {
  const base = buildToolContext({
    currentTargetId: msg?.reminderTargetId || msg?.fromId || null,
    conversationWindow: injection.conversationWindow || [],
    includeRecentPartners: true,
  })

  return {
    ...base,
    // 当前 turn 的渠道信息：execSendMessage 在 AUTO 模式下优先用这里，确保"在哪儿收的消息就回到哪儿"
    currentChannel: msg?.channel || null,
    currentExternalPartyId: msg?.externalPartyId || null,

    onSetTask: (description, steps) => {
      state.task = description
      state.lastTaskRefreshTick = -10
      state.taskSteps = steps.map(s => ({ text: s, status: 'pending', note: '' }))
      setConfig('current_task', description)
      setConfig('current_task_steps', JSON.stringify(state.taskSteps))
      console.log(`[task] Started: ${description} (${steps.length} step(s))`)
      emitEvent('task_set', { task: description, steps })
    },

    onCompleteTask: (summary) => {
      const clearedTask = state.task
      state.task = null
      state.taskSteps = []
      state.taskIdleTickCount = 0
      setConfig('current_task', '')
      setConfig('current_task_steps', '[]')
      console.log(`[task] Completed: ${clearedTask}`)
      emitEvent('task_cleared', { task: clearedTask, summary })
      if (clearedTask) {
        insertMemory({
          event_type: 'task_complete',
          content: `Task completed: ${clearedTask.slice(0, 60)}${summary ? ' — ' + summary.slice(0, 60) : ''}`,
          detail: 'Task marked complete via the complete_task tool',
          entities: [], concepts: [], tags: ['task_complete'],
          timestamp: nowTimestamp(),
        })
      }
    },

    onUpdateTaskStep: (idx, status, note) => {
      if (!state.taskSteps[idx]) return { error: `Step ${idx + 1} does not exist (${state.taskSteps.length} total)` }
      state.taskSteps[idx] = { ...state.taskSteps[idx], status, note }
      setConfig('current_task_steps', JSON.stringify(state.taskSteps))
      const done = state.taskSteps.filter(s => s.status === 'done').length
      emitEvent('task_step_updated', { index: idx, status, note, progress: `${done}/${state.taskSteps.length}` })
      // Option C: auto-clear task when all steps reach a terminal state
      const terminal = ['done', 'failed', 'skipped']
      const allTerminal = state.taskSteps.length > 0 && state.taskSteps.every(s => terminal.includes(s.status))
      if (allTerminal) autoCompleteTask('all steps complete')
      return {}
    },

    startupSelfCheck: state.startupSelfCheck,
    onCompleteStartupSelfCheck: ({ summary = '', results = {} } = {}) => {
      const now = nowTimestamp()
      const completed = {
        version: STARTUP_SELF_CHECK_VERSION,
        status: 'completed',
        started_at: state.startupSelfCheck?.started_at || now,
        completed_at: now,
        updated_at: now,
        results,
        summary,
      }
      writeStartupSelfCheckState(completed)
      state.startupSelfCheck = { ...completed, active: false }
      insertMemory({
        mem_id: `system_l2_startup_self_check_${STARTUP_SELF_CHECK_VERSION}`,
        type: 'system',
        title: `L2 startup self-check ${STARTUP_SELF_CHECK_VERSION}`,
        content: `L2 startup self-check completed: ${summary || 'no summary'}`,
        detail: JSON.stringify({ summary, results }, null, 2),
        tags: ['system', 'l2', 'startup_self_check', STARTUP_SELF_CHECK_VERSION],
        entities: [],
        timestamp: now,
      })
      clearStickyEvent('startup_self_check_started')
      emitEvent('startup_self_check_completed', completed)
      return completed
    },

    onRecall: (query) => {
      state.prev_recall = query
    },
  }
}

function formatConversationMessage(row, currentMsg = null, prevChannel = '') {
  if (row.role === 'jarvis') {
    // Jarvis 出站的渠道也标出来，让模型能"看到"自己上次回到了哪里
    const rawChannel = row.channel || ''
    const normalized = normalizeChannel(rawChannel)
    const channelTag = (normalized && normalized !== 'TUI' && normalized !== 'SYSTEM') ? `[via ${normalized}] ` : ''
    return {
      role: 'assistant',
      content: `${channelTag}${trimAssistantFluff(row.content || '')}`,
    }
  }

  // Truncate timestamp to minute precision (drop seconds and timezone)
  const ts = row.timestamp ? row.timestamp.slice(0, 16).replace('T', ' ') : ''
  const rawChannel = row.channel || currentMsg?.channel || ''
  const normalizedChannel = normalizeChannel(rawChannel)

  const isSystemSignal = row.from_id === 'SYSTEM' || normalizedChannel === 'SYSTEM' || rawChannel === 'APP_SIGNAL' || rawChannel === 'REMINDER'

  if (isSystemSignal) {
    const channelLabel = rawChannel ? ` · ${rawChannel}` : ''
    return {
      role: 'user',
      content: `[system signal · ${ts}${channelLabel}]\n${row.content || ''}\n(Respond with tools only. Do NOT call send_message.)`.trim(),
    }
  }

  const isCurrent = currentMsg
    && row.role === 'user'
    && row.from_id === currentMsg.fromId
    && row.timestamp === currentMsg.timestamp
    && row.content === currentMsg.content
  const marker = isCurrent ? 'current user message' : 'user message'
  // 简化后的渠道：TUI 视为默认不显示；其他（WECHAT/DISCORD/FEISHU/WECOM）显示
  let channelLabel = (normalizedChannel && normalizedChannel !== 'TUI') ? ` · ${normalizedChannel}` : ''

  // channel 切换提示：本条消息相对上一条的入口换了，给模型一个显眼的指代锚点。
  // 主要场景：用户在 TUI 聊到一半切到微信继续问"那现在呢？"——必须让 LLM 知道
  // 入口变了、感知能力也跟着变了，否则代词会被 runtime 块（电池/系统块）抢走。
  if (prevChannel && normalizedChannel && prevChannel !== normalizedChannel) {
    channelLabel += ` (channel switch: ${prevChannel} → ${normalizedChannel})`
  }

  return {
    role: 'user',
    content: `[${marker} · ${row.from_id || 'unknown'} · ${ts}${channelLabel}]\n${row.content || ''}`.trim(),
  }
}

function formatTaskSteps(taskSteps = []) {
  if (!taskSteps?.length) return ''
  const statusIcon = { done: '✓', failed: '✗', skipped: '—', pending: '○' }
  const lines = taskSteps.map((s, i) => {
    const icon = statusIcon[s.status] || '○'
    const note = s.note ? ` (${s.note})` : ''
    return `  ${i + 1}. [${icon}] ${s.text}${note}`
  })
  const done = taskSteps.filter(s => s.status === 'done').length
  const total = taskSteps.length
  return `Task step progress (${done}/${total}):\n${lines.join('\n')}`
}

function buildRuntimeContextMessages({ recentActions = [], actionLog = [], lastToolResult = null, taskSteps = [], batteryBlock = '' } = {}) {
  const parts = []

  if (batteryBlock) {
    parts.push(batteryBlock)
  }

  if (taskSteps?.length > 0) {
    parts.push(formatTaskSteps(taskSteps))
  }

  if (recentActions?.length > 0) {
    const lines = recentActions.map(item => `- ${item.ts?.slice(11, 16) || ''} ${item.summary || ''}`).join('\n')
    parts.push(`Recent assistant actions:\n${lines}\nAvoid immediately repeating the same action unless the current user message asks for it.`)
  }

  if (actionLog?.length > 0) {
    const lines = actionLog.slice(-10).map(item => {
      const time = item.timestamp?.slice(11, 16) || ''
      const detail = item.detail ? `\n  ${item.detail}` : ''
      return `- ${time} ${item.tool || ''} · ${item.summary || ''}${detail}`
    }).join('\n')
    parts.push(`Recent tool/action log:\n${lines}\nUse this as runtime context only. Do not repeat completed actions unless the current task requires it.`)
  }

  if (lastToolResult) {
    const argsSummary = Object.entries(lastToolResult.args || {})
      .map(([key, value]) => `${key}=${String(value).slice(0, 60)}`)
      .join(', ')
    const resultPreview = String(lastToolResult.result || '').slice(0, 500)
    parts.push(`Previous tool result:\n${lastToolResult.name}(${argsSummary}) ->\n${resultPreview}\nAbsorb this result before deciding the next step.`)
  }

  if (parts.length === 0) return []
  return [{
    role: 'user',
    content: `[runtime context]\n${parts.join('\n\n')}`,
  }]
}

function buildLLMMessages({ systemPrompt, contextBlock = '', conversationWindow = [], input, msg = null, recentActions = [], actionLog = [], lastToolResult = null, taskSteps = [], batteryBlock = '' }) {
  const messages = [{ role: 'system', content: systemPrompt }]
  messages.push(...buildRuntimeContextMessages({ recentActions, actionLog, lastToolResult, taskSteps, batteryBlock }))

  const rows = Array.isArray(conversationWindow) ? conversationWindow : []
  // Track which message in the array should receive this round's <context> block:
  // it's the last user-role message representing the "current" turn — either the
  // matched row from conversationWindow (when msg is already persisted to db) or
  // the appended fallback message below (TICK / unmatched cases).
  let currentMessageIndex = -1
  // prevChannel 维护：上一条非 SYSTEM 消息的 normalized channel，用于在 marker
  // 上标注 channel switch（"那现在呢"代词消解所依赖的核心信号之一）。
  let prevChannel = ''

  for (const row of rows) {
    if (!row?.content) continue
    const rowNorm = normalizeChannel(row.channel || '')
    const isSystemRow = row.from_id === 'SYSTEM' || rowNorm === 'SYSTEM' || row.channel === 'APP_SIGNAL' || row.channel === 'REMINDER'
    const formatted = formatConversationMessage(row, msg, isSystemRow ? '' : prevChannel)
    if (!formatted.content) continue
    messages.push(formatted)
    const isCurrent = !!msg
      && row.role === 'user'
      && row.from_id === msg.fromId
      && row.timestamp === msg.timestamp
      && row.content === msg.content
    if (isCurrent) currentMessageIndex = messages.length - 1
    if (!isSystemRow && rowNorm) prevChannel = rowNorm
  }

  const hasCurrentMessage = currentMessageIndex >= 0

  if (!hasCurrentMessage) {
    messages.push({
      role: 'user',
      content: input,
    })
    currentMessageIndex = messages.length - 1
  }

  // Prepend this round's <context>...</context> to the current user message.
  // The block is NOT persisted to db — conversations are written from the raw
  // user content (see queue.pushMessage) and assistant outputs are stored
  // verbatim, so the next round's conversationWindow stays clean.
  if (contextBlock && currentMessageIndex >= 0) {
    const target = messages[currentMessageIndex]
    target.content = `${contextBlock}\n\n${target.content || ''}`
  }

  return messages
}

const MAX_MESSAGE_RETRIES = 3

function createAbortError(reason = 'Aborted') {
  const err = new Error(reason)
  err.name = 'AbortError'
  return err
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError(signal.reason || 'Aborted')
}

function getProcessPriority(msg) {
  if (!msg) return PRIORITY.tick
  return typeof msg.priority === 'number' ? msg.priority : PRIORITY.background
}

function isVoiceChannel(channel) {
  return channel === 'voice' || channel === '语音识别' || channel === 'FocusBanner'
}

function isFastUserMessage(msg) {
  return !!msg && getProcessPriority(msg) >= PRIORITY.user
}

function shouldPreemptFor(entry) {
  if (!entry || !processing || !currentExecution) return true
  const incomingPriority = entry.priority || PRIORITY.background
  if (incomingPriority > currentExecution.priority) return true

  // Allow preemption between concurrent user messages.
  // If the current execution is stuck in a tool call, a new user message can still interrupt immediately.
  if (incomingPriority >= PRIORITY.user && currentExecution.priority >= PRIORITY.user) return true

  return false
}

function beginExecution({ priority, kind, label, controller }) {
  currentAbortController = controller
  currentExecution = {
    priority,
    kind,
    label,
    startedAt: Date.now(),
  }
}

function clearExecution(controller) {
  if (currentAbortController === controller) currentAbortController = null
  if (currentExecution && currentAbortController === null) currentExecution = null
}

function enqueueDueReminders() {
  const now = new Date().toISOString()
  const dueReminders = getDueReminders(now, 20)
  for (const reminder of dueReminders) {
    if (reminder.recurrence_type) {
      let nextDueIso
      try {
        const config = JSON.parse(reminder.recurrence_config || '{}')
        nextDueIso = calculateNextDueAt(reminder.recurrence_type, config, new Date()).toISOString()
      } catch (err) {
        console.error(`[reminder #${reminder.id}] Failed to calculate next recurrence time: ${err.message} — falling back to one-shot`)
        const marked = markReminderFired(reminder.id, now)
        if (!marked.changes) continue
      }
      if (nextDueIso) {
        const advanced = advanceReminderDueAt(reminder.id, nextDueIso)
        if (!advanced.changes) continue
      }
    } else {
      const marked = markReminderFired(reminder.id, now)
      if (!marked.changes) continue
    }
    pushMessage('SYSTEM', reminder.system_message, 'REMINDER', {
      reminderTargetId: reminder.user_id,
      reminderId: reminder.id,
    })
    emitEvent('reminder_fired', {
      id: reminder.id,
      user_id: reminder.user_id,
      due_at: reminder.due_at,
      task: reminder.task,
      recurrence_type: reminder.recurrence_type,
    })
  }
}

// Common LLM failure handler: set rate-limit on 429, requeue message, drop after max retries
function handleLLMFailure(err, label, msg) {
  console.error('LLM call failed:', err.message)
  if (err.message?.includes('429') || err.status === 429) setRateLimited()
  emitEvent('error', { label, error: err.message })
  if (msg) {
    const nextRetry = (msg.retryCount || 0) + 1
    if (nextRetry <= MAX_MESSAGE_RETRIES) {
      console.log(`[system] Message requeued (retry ${nextRetry}/${MAX_MESSAGE_RETRIES})`)
      emitEvent('message_requeued', { fromId: msg.fromId, retryCount: nextRetry, error: err.message })
      requeueMessage(msg, nextRetry)
    } else {
      console.error(`[system] Message dropped after ${MAX_MESSAGE_RETRIES} retries: ${msg.content?.slice(0, 60)}`)
      emitEvent('message_dropped', { fromId: msg.fromId, retryCount: nextRetry - 1, reason: err.message })
    }
  }
}

// 判断本轮消息相对历史是否发生了 channel 切换（如 TUI → WECHAT）。
// 用于给 LLM 显式提示"入口换了"，避免"那现在呢"这类追问被 runtime 块（电量等）抢走代词。
function detectChannelSwitch(msg, conversationWindow) {
  if (!msg) return false
  const currentNorm = normalizeChannel(msg.channel || '')
  if (!currentNorm) return false
  const rows = Array.isArray(conversationWindow) ? conversationWindow : []
  // 倒序找最近一条不是 current 本身、不是 SYSTEM 的消息
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (!row) continue
    const isSelf = row.role === 'user'
      && row.from_id === msg.fromId
      && row.timestamp === msg.timestamp
      && row.content === msg.content
    if (isSelf) continue
    const prevNorm = normalizeChannel(row.channel || '')
    if (!prevNorm || prevNorm === 'SYSTEM') continue
    return prevNorm !== currentNorm
  }
  return false
}

// Build systemEnv on demand: inject each block based on keywords in the message
function buildSystemEnv(msg) {
  const text = (typeof msg === 'string' ? msg : msg?.content || '').toLowerCase()
  const blocks = []
  // 英文缩写用 \b 避免误匹配子串（os→close, ip→script, ram→program）
  if (/系统信息|操作系统|电脑|主机名|内存|运行内存|hostname|时区|用户名|\bos\b|\bcpu\b|\bram\b|\bip\b|\bip地址\b|locale/.test(text))
    blocks.push(getSystemInfoBlock())
  if (/桌面|快捷方式|桌面文件|桌面应用|已安装|浏览器|启动程序/.test(text))
    blocks.push(getDesktopBlock())
  if (/天气|气温|温度|下雨|下雪|晴天|气候|风力|风速|台风|位置|城市|在哪个城市/.test(text))
    blocks.push(getGeoWeatherBlock())
  if (/热点|新闻|热搜|热榜|今天发生|最近发生|微博|知乎|头条/.test(text))
    blocks.push(getTrendingBlock())
  // 总是注入访客 IP 信息（如果有的话），让 AI 了解当前访问的网络环境和位置
  const visitorInfo = getCurrentVisitorInfo()
  if (visitorInfo) {
    blocks.push(getIPLocationBlock(visitorInfo))
  }
  return blocks.filter(Boolean).join('\n\n')
}

async function runTurn(input, label, msg = null) {
  const sessionRef = newSessionRef()
  const isTick = !msg
  if (isTick) state.tickCounter += 1
  const priority = getProcessPriority(msg)
  const fastUserPath = isFastUserMessage(msg)
  const controller = new AbortController()
  let llmResult = null
  let toolCallLog = []

  console.log(`\n── ${label} ──`)
  emitEvent(isTick ? 'tick' : 'message_received', { label, input: input.slice(0, 300) })

  // User messages are written to conversations at the pushMessage stage (recorded on arrival) — do not write them again here.
  try {
    beginExecution({
      priority,
      kind: isTick ? 'tick' : (fastUserPath ? 'user' : 'background'),
      label,
      controller,
    })

    if (isTick) ensureStartupSelfCheckState()

    // Key auto-config: if the user message contains an API key, silently configure it, purge the DB entry, notify frontend, and skip LLM
    let keyConfigFailDir = null
    if (!isTick && msg) {
      const recentCtx = getRecentConversationTimeline(5, 1).map(r => r.content || '').join(' ')
      const autoConfigResult = await tryAutoConfigureKey(input, recentCtx)
      if (autoConfigResult?.ok) {
        // Delete the user message from DB (no key trace left)
        getDB().prepare(
          `DELETE FROM conversations WHERE role = 'user' AND from_id = ? AND timestamp = ?`
        ).run(msg.fromId, msg.timestamp)
        // Notify frontend: remove last user message bubble + speak via TTS if available
        emitEvent('key_configured', {
          ttsText: autoConfigResult.hasTTS ? 'Voice synthesis successful' : null,
        })
        return  // Skip LLM, silent round
      }
      if (autoConfigResult && !autoConfigResult.ok) {
        // Key detected but validation failed: keep message and let LLM inform the user
        keyConfigFailDir = `[system] An API key was detected in the user message but validation failed: ${autoConfigResult.error}. Inform the user that the key is invalid and suggest checking whether it is correct or has expired.`
      }
    }

    // 1. Injector
    const injection = await runInjector({ message: input, state })
    throwIfAborted(controller.signal)

    // 1b. Focus stack —— 动态上下文记忆池第 3b/3c 步：多帧栈 + 压缩回填
    // 在 runInjector 之后、buildContextBlock 之前更新，让 <focus> / <focus-history> 段拿到最新栈。
    try {
      // Focus classifier 策略（Step 6a 重构）：
      //   - 始终启用 LLM 仲裁（除非用户显式关掉 state.focusClassifierDisabled）
      //   - fastUserPath: async 模式 —— v0 同步建帧零延迟，LLM 后台 patch refined topic
      //   - 后台路径（TICK/background）: sync 模式 —— 不在乎多 800ms，让 LLM 在主上下文构建前就 refine
      //   - LLM 失败/超时/解析失败：focus-classifier 内部打日志后回退 v0，绝不阻塞主流程
      const classifierDisabled = state.focusClassifierDisabled === true
      const focusResult = await updateFocusFrame(state, input, {
        isTick,
        tickCounter: state.tickCounter || 0,
        classifierEnabled: !classifierDisabled,
        classifierMode: fastUserPath ? 'async' : 'sync',
        onClassifierRefined: () => {
          // async 模式 LLM 回填 topic 后保存到 db，让下次启动恢复时也能拿到 refined topic
          try {
            saveFocusStack(state.focusStack || [])
            emitEvent('focus_frame', {
              focusStack: state.focusStack || [],
              topFrame: state.focusStack && state.focusStack.length > 0
                ? state.focusStack[state.focusStack.length - 1]
                : null,
              event: 'refined',
            })
          } catch (e) {
            console.log('[focus] saveFocusStack after async refine failed:', e?.message || 'unknown')
          }
        },
        signal: controller.signal,
      })
      const topFrame = state.focusStack && state.focusStack.length > 0
        ? state.focusStack[state.focusStack.length - 1]
        : null
      emitEvent('focus_frame', {
        focusStack: state.focusStack || [],
        topFrame,
        event: focusResult?.event || 'noop',
      })

      // 5c 步：持久化焦点栈到 db。noop 路径不写库（DELETE+INSERT 0 行也是无意义 IO）。
      // 任何 push/pop/touch/refresh 都视为栈状态变化，写一次。better-sqlite3 同步，
      // 写入 ~ ms 级；失败 saveFocusStack 内部 console.warn 后吞掉。
      if (focusResult?.event && focusResult.event !== 'noop') {
        saveFocusStack(state.focusStack || [])
      }

      // 压缩回填：每帧 pop 异步压缩成一句话结论，挂回新栈顶 + 沉淀到长期记忆。
      // fire-and-forget，参考 recognizer.js:196 的双层 catch 模式，绝不能阻塞主对话。
      if (focusResult?.poppedFrames?.length > 0) {
        for (const popped of focusResult.poppedFrames) {
          ;(async () => {
            try {
              // saveStack 回调：compress 把 conclusion push 进 currentTopFrame 后调用，
              // 把更新后的栈写回 db。focus-compress 不直接依赖 state。
              const saveStack = () => saveFocusStack(state.focusStack || [])
              await compressPoppedFrame(popped, topFrame, { sessionRef, emitEvent, saveStack })
            } catch {
              // 压缩失败 → 当作"那帧没沉淀"继续，不打扰用户
            }
          })().catch(() => {})
        }
      }
    } catch (e) {
      // 焦点判断不应该影响主流程；任何异常吞掉、记录日志即可
      console.log('[focus] updateFocusFrame failed:', e.message)
    }

    const directions = [...(injection.directions || [])]
    if (isTick) {
      const startupSelfCheckDirections = buildStartupSelfCheckDirections(state.startupSelfCheck)
      if (startupSelfCheckDirections) {
        // When self-check is active, inject only the self-check instruction — not the generic tick directions.
        // This prevents the "can stay silent" option from conflicting with "must run self-check".
        directions.unshift(startupSelfCheckDirections)
      } else {
        const explorationDirections = buildAwakeningExplorationDirections()
        if (explorationDirections) {
          // Awakening exploration phase: each autonomous tick focuses on one exploration task — skip generic directions.
          directions.unshift(explorationDirections)
        } else {
          directions.unshift(
            `This is an autonomous L2 heartbeat tick with no new user message. You have full tool access and may act proactively — no need to wait for the user.\n` +
            `Things you can proactively do (examples, not exhaustive):\n` +
            `- Check in with the user based on the time of day (morning/evening/late night)\n` +
            `- Browse the sandbox folder and check for in-progress projects or file changes; report if relevant\n` +
            `- Search memories for unfinished commitments, pending follow-ups, or upcoming reminders and move them forward\n` +
            `- Find a topic worth expanding from recent conversation and share a thought or piece of information\n` +
            `- Search the web for something the user cares about and push valuable findings\n` +
            `- Check task progress or prefetched data (weather/news) and proactively report changes\n` +
            `Guidelines:\n` +
            `- **Cooldown — strongest rule.** Look at the recent conversation timeline. If your own last send_message is less than 30 minutes old AND the user has not replied since, the default action is silence. Do NOT call send_message. Do not restart a topic the user just walked away from, do not "follow up" on a question you already asked, do not pivot to a stale earlier topic just because the new one didn't get a response. The only carve-outs: a real new fact arrived (reminder fires, a tool you were running just finished with a result the user asked for, a scheduled action's time came up). Boredom, curiosity, and "maybe they'd want to know" are not carve-outs.\n` +
            `- Proactive but not intrusive: don't repeat what was just said; don't bother late at night without reason (23:00–06:00: only message when there is clear value)\n` +
            `- Have substance: before sending, make sure there is something genuinely worth saying — not just "checking in"\n` +
            `- One thing per tick: pick the most valuable action, do it, and stop — don't pile multiple actions into one tick\n` +
            `- If there is truly nothing worth doing, stay silent and call no tools`
          )
        }
      }
    }
    if (fastUserPath) {
      directions.unshift('Current turn is a real-time external user message. Understand it quickly and reply directly with send_message before doing slow tools or deep context gathering. Use heavier tools only when the reply depends on them. During execution, whenever there is meaningful progress or a useful finding, send_message to keep the user in the loop. Do not ask for permission for actions you can safely perform; act, and speak when there is something worth saying.')
    }
    if (isVoiceChannel(msg?.channel)) {
      directions.push('The current user message came from voice input. Speak naturally and concisely — like talking to a person, not writing an article. Get to the point, avoid filler phrases, and do not use Markdown formatting (no bullet points, asterisks, or headers). Say what needs to be said and stop.')
      directions.push('If the voice input is clearly a speech recognition error (meaningless noise, garbled syllables, random characters) OR appears to be ambient speech not directed at you — such as someone nearby talking to another person, background conversation, or utterances with no plausible intent to address an AI assistant — silently ignore it: do NOT call send_message or any other tool. Only respond when the input is reasonably addressed to you.')
    }

    if (keyConfigFailDir) directions.unshift(keyConfigFailDir)

    const memoriesText = formatMemoriesForPrompt(injection.memories, injection.recallMemories)
    const directionsText = directions.join('\n')
    const taskKnowledgeText = formatTaskKnowledge(injection.taskKnowledge)
    const temporalRecallText = formatTemporalRecall(injection.temporalRecall)

    // Real-time user messages take the fast path: skip heavy context gathering to avoid slowdowns from task background.
    const prefetchText = formatPrefetchedItems(injection.prefetchedItems)
    const hotspotStateText = buildHotspotPanelStateContext()
    const hotspotContextText = buildHotspotRuntimeContext(msg?.content || input)
    const personCardStateText = buildPersonCardPanelStateContext()
    const personCardContextText = buildPersonCardRuntimeContext(msg?.content || input)
    const weatherContextText = await buildWeatherRuntimeContext(msg?.content || input)
    // Keyword detection is a soft hint injected into context; the agent decides whether to open the doc panel
    const detectedDocTopic = detectDocTopic(msg?.content || input)
    const docStateText = buildDocPanelStateContext(detectedDocTopic)
    const docContextText = buildDocRuntimeContext(msg?.content || input)

    // When weather keywords are detected, auto-pop WeatherCard after 1 second
    if (weatherContextText && hasACUIClient()) {
      setTimeout(() => {
        getWeatherCardProps(msg?.content || input).then(cardProps => {
          if (!cardProps) return
          const id = `weathercard-${Date.now()}`
          emitUICommand({ op: 'mount', id, component: 'WeatherCard', props: cardProps, hint: { placement: 'notification', enter: 'flash-in', exit: 'flash-out' } })
          addActiveUICard(id, { component: 'WeatherCard' })
        }).catch(() => {})
      }, 1000)
    }

    // 用户跨渠道可达性快照（让 L2 主动消息能选对渠道：用户在外面就发微信，在电脑前就发本地）
    const presenceText = formatPresenceForPrompt(PRIMARY_USER_ID)

    let extraContextText = ''
    if (state.task && !fastUserPath) {
      const extraContext = await gatherContext({
        task: state.task,
        taskKnowledge: taskKnowledgeText,
        memories: memoriesText,
        message: input,
        signal: controller.signal,
      })
      throwIfAborted(controller.signal)
      extraContextText = formatExtraContext(extraContext)
      if (extraContext.length > 0) {
        console.log(`[context] Added ${extraContext.length} context item(s)`)
        emitEvent('context_gathered', { count: extraContext.length, items: extraContext.map(c => c.label) })
      }
    }

    // Emit injector result event (used by brain.html for display)
    emitEvent('injector_result', {
      directions,
      tools: injection.tools || [],
      matchedMemories: (injection.memories || []).map(m => ({
        id: m.id,
        mem_id: m.mem_id || '',
        event_type: m.event_type || '',
        content: m.content || '',
        detail: m.detail || '',
      })),
      recallMemories: (injection.recallMemories || []).map(m => ({
        id: m.id,
        mem_id: m.mem_id || '',
        event_type: m.event_type || '',
        content: m.content || '',
        detail: m.detail || '',
      })),
      constraints: (injection.constraints || []).map(m => m.content),
      thought: injection.thought || null,
      lastToolResult: injection.lastToolResult
        ? `${injection.lastToolResult.name}: ${String(injection.lastToolResult.result).slice(0, 120)}`
        : null,
      conversationWindow: (injection.conversationWindow || []).map(m => ({
        role: m.role,
        from_id: m.from_id,
        to_id: m.to_id,
        content: (m.content || '').slice(0, 120),
        timestamp: m.timestamp,
      })),
      personMemory: injection.personMemory
        ? { content: injection.personMemory.content, detail: injection.personMemory.detail || '' }
        : null,
      fastUserPath,
    })

    // Update thought stack
    if (injection.thought) {
      state.thoughtStack.push(injection.thought)
      if (state.thoughtStack.length > 3) state.thoughtStack.shift()
    }

    // 2. Build system prompt (stable hard-floor) + context block (per-round dynamic)
    const persona = getConfig('persona') || ''
    const agentName = getConfig('agent_name') || '小白龙'
    const entities = getKnownEntities()
    const hasActiveTask = !!state.task
    const extraContextJoined = [presenceText, hotspotStateText, hotspotContextText, personCardStateText, personCardContextText, weatherContextText, docStateText, docContextText, prefetchText, extraContextText, injection.uiSignalSummary, formatActiveUICards(injection.activeUICards)].filter(Boolean).join('\n\n')

    // system 只留稳定硬底线（agent_name / persona / security）—— 让 DeepSeek prefix cache
    // 真正命中。currentTime / existenceDesc / systemEnv 改走 <runtime> 段（每轮变化）。
    const systemPrompt = buildSystemPrompt({
      agentName,
      persona,
      security: getSecurity(),
    })

    const baseContextArgs = {
      memories: memoriesText,
      temporalRecall: temporalRecallText,
      directions: directionsText,
      constraints: injection.constraints || [],
      personMemory: injection.personMemory || null,
      thoughtStack: state.thoughtStack,
      entities,
      hasActiveTask,
      task: state.task || null,
      taskKnowledge: taskKnowledgeText,
      extraContext: extraContextJoined,
      awakeningTicks: getAwakeningTicks(),
      focusStack: state.focusStack || [],
      // Runtime info：从 system 迁来的每轮变化字段，集中放 <context><runtime>
      currentTime: nowTimestamp(),
      existenceDesc: describeExistence(birthTime),
      systemEnv: buildSystemEnv(msg),
      currentChannel: msg ? normalizeChannel(msg.channel || '') : '',
      channelSwitched: detectChannelSwitch(msg, injection.conversationWindow || []),
      focusTickCounter: state.tickCounter || 0,
    }
    let contextBlock = buildContextBlock(baseContextArgs)

    const buildMessagesWithContext = (ctxBlock) => buildLLMMessages({
      systemPrompt,
      contextBlock: ctxBlock,
      conversationWindow: injection.conversationWindow || [],
      input,
      msg,
      recentActions: state.recentActions,
      actionLog: injection.actionLog || [],
      lastToolResult: injection.lastToolResult || null,
      taskSteps: state.taskSteps,
      batteryBlock: getBatteryBlock(),
    })

    let llmMessages = buildMessagesWithContext(contextBlock)

    // Memory refresh injection (L1 user messages only)
    // 实时用户消息（fastUserPath）跳过：刷新流程会先跑一次评估 LLM 调用，对实时聊天是硬性延迟税
    const shouldRefreshL1 = !isTick && !fastUserPath && msg?.content && msg.content.trim()
    const tickSinceLastRefresh = state.tickCounter - state.lastTaskRefreshTick
    const shouldRefreshTick = isTick && !!state.task && tickSinceLastRefresh >= 5
    if (shouldRefreshL1 || shouldRefreshTick) {
      try {
        const refreshResult = await runMemoryRefreshLoop({
          originalQuery: shouldRefreshL1 ? msg.content : state.task,
          baseMemories: injection.memories,
          formattedBaseMemories: memoriesText,
          systemPromptBase: combinePromptForPreview(systemPrompt, contextBlock),
          signal: controller.signal,
          maxRounds: shouldRefreshTick ? 2 : 3,
        })
        state.pendingConfidenceHint = refreshResult?.confidence ?? null
        if (shouldRefreshTick) state.lastTaskRefreshTick = state.tickCounter
        throwIfAborted(controller.signal)
        if (!refreshResult.skipped && (refreshResult.additionalMemories.length || refreshResult.round3Results)) {
          const extraParts = []
          if (refreshResult.additionalMemories.length) {
            extraParts.push(formatMemoriesForPrompt([], refreshResult.additionalMemories))
          }
          if (refreshResult.round3Results) {
            extraParts.push(`[Round 3 external query results]\n${refreshResult.round3Results}`)
          }
          const enrichedMemoriesText = memoriesText + '\n\n' + extraParts.join('\n\n')
          // Rebuild only the context block — system stays stable so prompt cache survives.
          contextBlock = buildContextBlock({
            ...baseContextArgs,
            memories: enrichedMemoriesText,
            roundInfo: { round: refreshResult.roundsRun },
          })
          llmMessages = buildMessagesWithContext(contextBlock)
          console.log(`[memory refresh] Done — ${refreshResult.roundsRun} round(s), appended ${refreshResult.additionalMemories.length} memory/memories`)
        }
      } catch (e) {
        if (e.name !== 'AbortError') console.log('[memory refresh] Error:', e.message)
      }
    }

    // Emit full prompt preview event (system + context, joined for human display)
    emitEvent('system_prompt', { content: combinePromptForPreview(systemPrompt, contextBlock), fastUserPath })

    // 3. Call Jarvis LLM (can be interrupted by a new message)
    const toolContext = buildToolContextForProcess(msg, injection)
    llmResult = await callLLM({
      systemPrompt,
      message: input,
      messages: llmMessages,
      tools: injection.tools || ['send_message'],
      maxTokens: undefined,
      temperature: config.temperature,
      signal: controller.signal,
      toolContext,
      mustReply: !!msg?.fromId,
      onToolCall: (name, args, result) => {
        const resultText = String(result)
        let ok = true
        let parsed = null
        try {
          parsed = JSON.parse(resultText)
          if (parsed && parsed.ok === false) ok = false
        } catch {
          ok = !/^(错误|请求失败|执行失败|命令超时|命令执行失败|error|failed|execution failed|command timed out)/.test(resultText.trim())
        }
        // 截断策略：保证 JSON 仍可解析，否则前端格式化器会回退展示原始 JSON 文本。
        // 优先压缩 stdout/stderr/content/snippet 等长字段，再整体 stringify，而非粗暴 slice。
        const resultForEvent = truncateToolResultForUI(parsed, resultText)
        emitEvent('tool_call', { name, args, result: resultForEvent, ok })
        toolCallLog.push({ name, args, result: resultText.slice(0, 500), ok })
        // 注：send_message 的 conversations 写入已由 executor.js 内统一处理（带 channel + external_party_id）
        // 这里仅处理语音输入的 TTS 自动回放
        if (name === 'send_message' && args?.content && isVoiceChannel(msg?.channel)) {
          const cleanedContent = trimAssistantFluff(args.content)
          if (cleanedContent) autoSpeakForVoiceReply(cleanedContent)
        }
      },
      onRetry: ({ attempt, nextAttempt, maxAttempts, delayMs, error }) => {
        emitEvent('llm_retry', { attempt, nextAttempt, maxAttempts, delayMs, error })
      },
      onToolExecute: (name) => {
        emitEvent('tool_executing', { name })
      },
      onStream: ({ event, mode, text, name }) => {
        if (event === 'start') emitEvent('stream_start', { mode })
        else if (event === 'chunk') emitEvent('stream_chunk', { text })
        else if (event === 'end') emitEvent('stream_end', {})
        else if (event === 'tool_preparing') emitEvent('tool_preparing', { name })
      },
    })
    throwIfAborted(controller.signal)
  } catch (err) {
    if (err.name === 'AbortError') {
      console.log('[system] LLM processing interrupted (new message arrived)')
      llmResult = { content: '', toolResult: null, aborted: true }
    } else {
      handleLLMFailure(err, label, msg)
      return
    }
  } finally {
    clearExecution(controller)
  }

  if (llmResult.aborted) {
    // WeChat-style interruption: discard partial output; the next round will naturally pick up this context from conversationWindow.
    // Mark this tick as aborted so onTick's finally block skips tick decrement and exploration advance.
    console.log('[system] Current processing interrupted by new message — partial output discarded')
    lastTickAborted = true
    return
  }

  const response = llmResult.content

  // Store tool result for injection on the next TICK
  state.lastToolResult = llmResult.toolResult || null

  console.log('\nJarvis:', response)
  emitEvent('response', { sessionRef, label, content: response })

  // User messages must not fail silently: if the model generated a response but forgot to call send_message,
  // the runtime delivers it as a fallback; TICK/proactive messages must still go through explicit tool calls.
  // 判断"是否漏了最终回复"必须看**最后一个**工具调用是不是 send_message，而不是"本轮是否出现过"。
  // 否则 [send_message("好，我查一下"), web_fetch, read_file] 这种"前置旁白 + 真正干活"链条会绕过兜底，
  // 模型在最后一步没补刀时直接静默退场——和 llm.js 内 sentMessage 同源的反模式，
  // 参见 lessons-bailongma-silent-exit。
  const lastToolCall = toolCallLog[toolCallLog.length - 1]
  if (msg && msg.fromId && lastToolCall?.name !== 'send_message') {
    const fallbackContent = trimAssistantFluff(
      response
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/\[RECALL:\s*.+?\]/g, '')
        .replace(/\[SET_TASK:\s*[\s\S]+?\]/g, '')
        .replace(/\[CLEAR_TASK\]/g, '')
        .replace(/\[UPDATE_PERSONA:\s*[\s\S]+?\]/g, '')
        .trim()
    )

    if (fallbackContent && requiresToolForUserMessage(input) && !hasNonMessageToolCall(toolCallLog)) {
      const timestamp = nowTimestamp()
      const blockedContent = 'I did not actually call the required tool, so I cannot claim the operation completed. Please send again — I will execute the tool first, then reply based on the result.'
      console.warn(`[protocol fallback] Blocked a text reply that required a tool call but made none. from=${msg.fromId}`)
      if (isVoiceChannel(msg.channel)) autoSpeakForVoiceReply(blockedContent)
      deliverFallbackReply(msg, blockedContent, timestamp)
      toolCallLog.push({
        name: 'send_message',
        args: { target_id: msg.fromId, content: blockedContent },
        result: 'fallback blocked missing required tool call',
      })
      emitEvent('protocol_violation', {
        label,
        reason: 'missing_required_tool_call',
        fromId: msg.fromId,
        content: fallbackContent.slice(0, 500),
      })
    } else if (fallbackContent) {
      const timestamp = nowTimestamp()
      console.warn(`[protocol fallback] Model did not call send_message — delivering response body to ${msg.fromId}`)
      if (isVoiceChannel(msg.channel)) autoSpeakForVoiceReply(fallbackContent)
      deliverFallbackReply(msg, fallbackContent, timestamp)
      toolCallLog.push({
        name: 'send_message',
        args: { target_id: msg.fromId, content: fallbackContent },
        result: 'fallback delivered from plain response',
      })
      emitEvent('protocol_violation', {
        label,
        reason: 'missing_send_message_fallback_delivered',
        fromId: msg.fromId,
        content: fallbackContent.slice(0, 500),
      })
    } else {
      console.warn(`[protocol violation] Model did not call send_message and there is no response body to fall back on. from=${msg.fromId}`)
      emitEvent('protocol_violation', {
        label,
        reason: 'missing_send_message',
        fromId: msg.fromId,
        content: response.slice(0, 500),
      })
    }
  }

  // 4. Detect [RECALL: ...]
  const recallMatch = response.match(/\[RECALL:\s*(.+?)\]/)
  if (recallMatch) {
    state.prev_recall = recallMatch[1]
    console.log(`[system] Recall requested: ${state.prev_recall}`)
    emitEvent('recall_requested', { query: state.prev_recall })
  } else {
    state.prev_recall = null
  }

  // 5. Detect [UPDATE_PERSONA: ...]
  const personaMatch = response.match(/\[UPDATE_PERSONA:\s*([\s\S]+?)\]/)
  if (personaMatch) {
    const newPersona = personaMatch[1].trim()
    setConfig('persona', newPersona)
    console.log('[system] Persona updated')
    emitEvent('persona_updated', { persona: newPersona.slice(0, 200) })
  }

  // 6. Detect [SET_TASK: ...] / [CLEAR_TASK]
  const setTaskMatch = response.match(/\[SET_TASK:\s*([\s\S]+?)\]/)
  if (setTaskMatch) {
    state.task = setTaskMatch[1].trim()
    setConfig('current_task', state.task)
    console.log(`[system] Task set: ${state.task}`)
    emitEvent('task_set', { task: state.task })
  }
  if (/\[CLEAR_TASK\]/.test(response)) {
    const clearedTask = state.task
    console.log(`[system] Task completed: ${clearedTask}`)
    emitEvent('task_cleared', { task: clearedTask })
    state.task = null
    state.taskIdleTickCount = 0
    setConfig('current_task', '')
    // Write a task_complete memory to prevent old task memories from making Jarvis think the task is still active
    if (clearedTask) {
      insertMemory({
        event_type: 'task_complete',
        content: `Task completed: ${clearedTask.slice(0, 60)}`,
        detail: 'Task marked complete via [CLEAR_TASK] — no further execution',
        entities: [], concepts: [], tags: ['task_complete'],
        timestamp: nowTimestamp(),
      })
    }
  }

  // Update recent action log (keep last 5)
  if (toolCallLog.length > 0) {
    const summary = toolCallLog.map(t => {
      if (t.name === 'send_message') return `send_message → ${t.args.target_id}`
      if (t.name === 'fetch_url') return `fetch_url(${t.args.url?.slice(0, 40)})`
      if (t.name === 'write_file') return `write_file(${t.args.path})`
      if (t.name === 'read_file') return `read_file(${t.args.path})`
      return t.name
    }).join(', ')
    state.recentActions.push({ ts: nowTimestamp(), summary })
    if (state.recentActions.length > 5) state.recentActions.shift()
  }

  // Option B: task idle detection — auto-clear after N consecutive ticks with no tool calls
  if (state.task && isTick) {
    if (toolCallLog.length === 0) {
      state.taskIdleTickCount++
      console.log(`[task] Idle tick count ${state.taskIdleTickCount}/${TASK_IDLE_TICK_LIMIT}`)
      if (state.taskIdleTickCount >= TASK_IDLE_TICK_LIMIT) {
        autoCompleteTask(`${TASK_IDLE_TICK_LIMIT} consecutive ticks with no tool calls`)
      }
    } else {
      state.taskIdleTickCount = 0
    }
  }

  // 6. Recognizer: split think block and response body, pass full experience.
  //    Runs in the background — does not block the next message/TICK.
  const thinkMatch = response.match(/<think>([\s\S]*?)<\/think>/i)
  const jarvisThink = thinkMatch ? thinkMatch[1].trim() : ''
  const jarvisText = response.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()

  // Silent tick with no tool calls = nothing happened worth remembering; skip LLM call entirely.
  if (isTick && toolCallLog.length === 0 && !jarvisText) {
    emitEvent('memories_written', { count: 0, memories: [] })
    return
  }

  runRecognizer({
    userMessage: input,
    jarvisThink,
    jarvisResponse: jarvisText,
    toolCallLog,
    task: state.task,
    sessionRef,
  }).then(memories => {
    emitEvent('memories_written', { count: memories?.length || 0, memories: memories || [] })
  }).catch(err => {
    console.error('[recognizer] Background run failed:', err)
  })

  // 本轮处理完后，清除访客信息以防止信息泄露
  clearCurrentVisitorInfo()
}

let processing = false
let lastTickAborted = false
let currentTimer = null  // timer for the next pending tick; can be cleared by pushMessage to run immediately

// 把 runTurn 用 watchdog 包一层：超时 → 强 abort + reject，让 onTick 的 finally 能跑、
// processing 清掉。runTurn 内部那个永远不 resolve 的 promise 留在后台，最终被 GC。
async function runTurnWithWatchdog(input, label, msg) {
  let timer = null
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const stuckLabel = currentExecution?.label || label
      const elapsedS = currentExecution ? Math.round((Date.now() - currentExecution.startedAt) / 1000) : null
      console.error(`[watchdog] runTurn 卡死 ${RUN_TURN_WATCHDOG_MS / 1000}s 未返回 (label=${stuckLabel}, elapsed=${elapsedS}s)，强制 abort`)
      try { currentAbortController?.abort?.('watchdog timeout') } catch {}
      // 立即清掉全局 execution 引用，避免后续 message 进来还 abort 同一个 controller
      currentAbortController = null
      currentExecution = null
      try { emitEvent('error', { label: 'watchdog', error: `runTurn stuck > ${RUN_TURN_WATCHDOG_MS / 1000}s` }) } catch {}
      const err = new Error('runTurn watchdog timeout')
      err.name = 'WatchdogTimeoutError'
      reject(err)
    }, RUN_TURN_WATCHDOG_MS)
  })
  try {
    await Promise.race([runTurn(input, label, msg), watchdog])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function onTick() {
  if (processing) return
  processing = true
  lastTickAborted = false
  let autoTick = false
  let selfCheckActiveAtStart = false

  try {
    enqueueDueReminders()
    if (hasMessages()) {
      const msg = popMessage()
      const lane = msg.queueName === 'background' ? 'BG' : 'L1'
      await runTurnWithWatchdog(msg.raw, `${lane} message from ${msg.fromId}`, msg)
    } else {
      autoTick = true
      selfCheckActiveAtStart = !!state.startupSelfCheck?.active
      const tick = formatTick()
      await runTurnWithWatchdog(tick, 'L2 TICK', null)
    }
  } catch (err) {
    // runTurn 抛错（含 watchdog 超时和 runTurn 内部 LLM 之后未捕获的异常）必须吞掉，
    // 否则会冒泡到 setTimeout 回调外层，绕过 scheduleNextTick → 主循环停摆。
    if (err?.name === 'WatchdogTimeoutError') {
      lastTickAborted = true
    } else {
      console.error('[onTick] runTurn 抛出未处理异常:', err?.stack || err?.message || err)
    }
  } finally {
    processing = false
    consumeTickerTick()
    // When interrupted by the user, do not decrement the tick or advance exploration — retry next heartbeat
    if (!lastTickAborted) {
      decrementAwakeningTick()
      // Do not advance exploration index during self-check; exploration begins sequentially after self-check ends
      if (autoTick && !selfCheckActiveAtStart) advanceExplorationTask()
    }
  }
}

// Schedule priority (high to low):
//   1. Messages pending → 0
//   2. 429 rate-limited → quota's 10-minute interval
//   3. L2 custom cadence (ttl > 0) → L2-specified value
//   4. Task active → 30s
//   5. Idle → config.tickInterval
function scheduleNextTick() {
  if (!isRunning()) return
  if (currentTimer) { clearTimeout(currentTimer); currentTimer = null }

  enqueueDueReminders()

  const hasPending = hasMessages()
  const hasPendingUser = hasUserMessages()
  const queueSnapshot = getQueueSnapshot()
  const rateLimited = isRateLimited()
  const customMs = getCustomIntervalMs()
  const taskActive = !!state.task
  const nextReminder = getNextPendingReminder()

  let interval
  let label
  if (hasPendingUser) {
    interval = 0
    label = 'immediate (user message pending)'
  } else if (hasPending) {
    interval = 0
    label = 'immediate (background message pending)'
  } else if (rateLimited) {
    interval = getTickInterval(config.tickInterval)
    label = `rate-limited (${interval / 1000}s)`
  } else if (customMs !== null) {
    const ticker = getTickerStatus()
    interval = customMs
    label = `L2 custom ${interval / 1000}s (${ticker.ttl} tick(s) remaining${ticker.reason ? ' · ' + ticker.reason : ''})`
  } else if (getAwakeningTicks() > 0) {
    const awTicks = getAwakeningTicks()
    interval = 10000
    label = `awakening 10s (${awTicks} tick(s) remaining)`
  } else if (taskActive) {
    interval = 30000
    label = 'task mode 30s'
  } else {
    interval = config.tickInterval
    label = `${interval / 1000}s`
  }

  if (nextReminder) {
    const dueInMs = Math.max(0, new Date(nextReminder.due_at).getTime() - Date.now())
    if (dueInMs < interval) {
      interval = dueInMs
      label = `reminder fires in ${Math.ceil(dueInMs / 1000)}s`
    }
  }

  const quota = getQuotaStatus()
  console.log(`[quota] ${quota.rpmUsed} RPM | ${quota.tpmUsed} TPM | ratio ${quota.ratio} | queue U:${queueSnapshot.user} B:${queueSnapshot.background} | next tick ${label}`)
  emitEvent('quota', { ...quota, nextTickMs: interval, ticker: getTickerStatus(), queue: queueSnapshot })
  currentTimer = setTimeout(async () => {
    currentTimer = null
    // try/finally 兜底：即使 onTick 抛错（理论上 onTick 自己已 catch，watchdog 也吞了
    // 异常），也保证 scheduleNextTick 总被调用，主循环不会因为单轮异常永久停摆。
    try {
      await onTick()
    } catch (err) {
      console.error('[scheduleNextTick] onTick threw:', err?.stack || err?.message || err)
    } finally {
      scheduleNextTick()
    }
  }, interval)
}

// Called when a new message arrives: clear the pending timer and run the next tick immediately.
// If currently processing, rely on the abort mechanism to finish quickly; scheduleNextTick will use interval=0 to resume.
function triggerImmediateTick() {
  if (processing) return  // rely on abort + the post-finish scheduleNextTick to continue
  if (!isRunning()) return
  if (currentTimer) { clearTimeout(currentTimer); currentTimer = null }
  // 异步启动一轮，不等结果
  ;(async () => {
    try {
      await onTick()
    } catch (err) {
      console.error('[triggerImmediateTick] onTick threw:', err?.stack || err?.message || err)
    } finally {
      scheduleNextTick()
    }
  })()
}

let loopStarted = false

async function startConsciousnessLoop({ runImmediateTick = true } = {}) {
  if (loopStarted) return
  loopStarted = true

  startConsolidationLoop()

  // Register the scheduler so the control layer (stop/start) can wake it up
  setScheduler(scheduleNextTick)

  // Register interrupt callback: when a new message arrives, interrupt the current LLM call and trigger the next tick immediately (don't wait for the timer)
  setInterruptCallback((entry) => {
    if (currentAbortController && shouldPreemptFor(entry)) {
      console.log(`[system] Higher-priority message arrived — interrupting current processing: ${entry.fromId} (${entry.queueName})`)
      emitEvent('processing_preempted', {
        by: entry.fromId,
        queueName: entry.queueName,
        priority: entry.priority,
        current: currentExecution,
      })
      currentAbortController.abort('higher-priority-message')
    }
    triggerImmediateTick()
  })

  // Initialize self-check state before the first tick so the first tick can run self-check
  ensureStartupSelfCheckState()
  if (state.startupSelfCheck?.active) {
    console.log('[system] Startup self-check starting')
    const selfCheckPayload = { version: STARTUP_SELF_CHECK_VERSION }
    setStickyEvent('startup_self_check_started', selfCheckPayload)
    emitEvent('startup_self_check_started', selfCheckPayload)
  }

  // Whether to fire an immediate L2 TICK is up to the caller; initial activation uses it to trigger self-check.
  if (runImmediateTick) {
    await onTick()
  }
  scheduleNextTick()
}

async function main() {
  console.log('Jarvis starting...')

  // 5c 步：启动时打印恢复的专注栈，便于"重启不丢栈"的直观验证。
  if (state.focusStack && state.focusStack.length > 0) {
    const path = state.focusStack
      .map(f => Array.isArray(f.topic) ? f.topic.join(',') : '')
      .filter(Boolean)
      .join(' > ')
    console.log(`[focus] 恢复 ${state.focusStack.length} 帧专注栈：${path}`)
  }

  // Sync ACUI skill memories (compare AGENT_GUIDE.md hash, update skill-ui-* entries as needed)
  ensureSkillMemories()

  const persona = getConfig('persona')
  if (persona) {
    console.log(`[system] Persona loaded: ${persona.slice(0, 60)}...`)
  } else {
    console.log('[system] No persona set — waiting for Jarvis to self-define')
  }

  // Start HTTP API — must start regardless of activation status; the activation page depends on it
  const apiPort = Number(process.env.BAILONGMA_PORT) || 3721
  startAPI(apiPort, {
    getStateSnapshot: () => ({
      action: state.action,
      task: state.task,
      taskSteps: (state.taskSteps || []).map(s => ({ ...s })),
      prev_recall: state.prev_recall,
      lastToolResult: state.lastToolResult
        ? { ...state.lastToolResult, args: { ...(state.lastToolResult.args || {}) } }
        : null,
      sessionCounter: state.sessionCounter,
      recentActions: (state.recentActions || []).map(item => ({ ...item })),
      thoughtStack: (state.thoughtStack || []).map(item => ({ ...item })),
    }),
    onActivated: () => {
      console.log(`[LLM] Activated: ${config.provider} (${config.model})`)
      registerMinimaxIfAvailable()
      startConsciousnessLoop({ runImmediateTick: true }).catch(err => console.error('[system] Main loop failed to start:', err))
    },
  })
  startSocialConnectors({ pushMessage, emitEvent }).catch(err => console.warn('[social] startup failed:', err.message))

  // Start TUI
  startTUI('ID:000001')

  if (config.needsActivation) {
    console.log(`Please open http://127.0.0.1:${apiPort}/activation in your browser to activate before sending messages\n`)
    return
  }

  console.log('Type a message and press Enter to send it to Jarvis\n')
  await startConsciousnessLoop()
}

main()
