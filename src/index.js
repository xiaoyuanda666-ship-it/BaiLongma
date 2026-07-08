import './network-proxy.js'
import { spawn } from 'child_process'
import { fileURLToPath } from 'node:url'
import { config, getMinimaxKey as _getMinimaxKey, getSecurity } from './config.js'
import { callLLM } from './llm.js'
import { buildSystemPrompt, buildContextBlock, combinePromptForPreview } from './prompt.js'
import { enqueueTurnForRecognition, configureRecognizerScheduler } from './memory/recognizer-scheduler.js'
import { runInjector, formatMemoriesForPrompt, formatActivePoliciesForPrompt, formatTaskKnowledge, formatPrefetchedItems, formatSceneManifest, formatTemporalRecall, formatAIVideoPanel } from './memory/injector.js'
import { formatToolPromptHintsForSchemas } from './memory/active-policies.js'
import { sceneStore } from './scene/scene-store.js'
import {
  ensureThreadState, attributeUserMessage, buildThreadView, getForegroundThread,
  getThreadById, openCommitment, closeCommitment, touchCommitmentThread,
  latestOpenCommitment, mergeThreads, migrateFocusStackToThreads, describeThread,
} from './memory/threads.js'
import { summarizeThread } from './memory/thread-summarize.js'
import { classifyThreadAttribution } from './memory/thread-classifier.js'
import { runMemoryRefreshLoop } from './memory/refresh-loop.js'
import { startConsolidationLoop } from './memory/consolidation-loop.js'
import { recordSelfEvolutionFromMemories } from './memory/self-evolution.js'
import { runRuntimeInjector } from './context/runtime-injector.js'
import { selectContextSections } from './context/section-gate.js'
import { getDB, getConfig, setConfig, getKnownEntities, getOrInitBirthTime, insertConversation, insertMemory, getRecentConversationPartners, getDueReminders, markReminderFired, advanceReminderDueAt, getNextPendingReminder, getMemoryCount, getRecentConversationTimeline, loadFocusStack, loadThreadState, saveThreadState, setCurrentFocusTopic, setCurrentThreadId, updateUserMessageFocusTopic, reassignConversationsThread, insertActionLog } from './db.js'
import { calculateNextDueAt, autoSpeakForVoiceReply, detectOpenFollowupQuestion } from './capabilities/executor.js'
import { popMessage, hasMessages, hasUserMessages, getQueueSnapshot, setInterruptCallback, requeueMessage, pushMessage } from './queue.js'
import { startTUI } from './tui.js'
import { startAPI } from './api.js'
import { emitEvent, setStickyEvent, clearStickyEvent } from './events.js'
import { formatTick, nowTimestamp, describeExistence } from './time.js'
import { getAdaptiveTickInterval, getQuotaStatus, setRateLimited, isRateLimited, getTickInterval } from './quota.js'
import { registerProvider } from './providers/registry.js'
import { MinimaxProvider } from './providers/minimax.js'
import { isRunning, setScheduler } from './control.js'
import { getCustomIntervalMs, consumeTick as consumeTickerTick, getStatus as getTickerStatus } from './ticker.js'
import { seedSandboxOnce, seedMusicOnce, rescueDataFromInstallDir } from './paths.js'
import { loadInstalledTools } from './capabilities/marketplace/index.js'
import { resumePendingVideoJobs, getAIVideoPanelState } from './capabilities/tools/media.js'
import { dispatchSocialMessage } from './social/dispatch.js'
import { startSocialConnectors } from './social/index.js'
import { getFeishuStatusBlock } from './social/feishu-ws.js'
import { collectSystemInfo, getSystemInfoBlock, getBatteryBlock, getDesktopPath } from './system-info.js'
import { getDesktopBlock } from './desktop-scanner.js'
import { getInstalledSoftwareBlock } from './installed-software-scanner.js'
import { collectGeoWeather, getGeoWeatherBlock } from './geo-weather.js'
import { collectTrending } from './trending.js'
import { collectAgents, buildAgentContextBlock, buildDelegationAskDirections } from './agents/registry.js'
import { refreshSkills, selectSkillsForMessage, formatSkillsForContext } from './skills/registry.js'
import { tryAutoConfigureKey } from './key-auto-config.js'
import { PRIMARY_USER_ID, formatPresenceForPrompt, normalizeChannel, isExternalChannel, isVoiceChannel } from './identity.js'
import { truncateToolResultForUI } from './runtime/tool-result-preview.js'
import { buildLLMMessages } from './runtime/messages.js'
import { parseMarkers } from './runtime/markers.js'
import { buildStrictEvaluationContext, filterStrictEvaluationTools, resolveStrictEvaluationMode } from './runtime/strict-evaluation.js'
import { extractVerbatimPayload, findRecentVerbatimPayload, hasInlineVerbatimPayload, isVerbatimOutputRequest, isVerbatimSetup, isVerbatimStart } from './runtime/verbatim.js'
import { refreshUserProfile } from './profile/infer.js'
import { isSoftwareInstallRequest } from './software-install-intent.js'
import { formatTerminalStreamContext } from './terminal-stream.js'
import { getWeatherCardProps, isWeatherQuery } from './weather.js'
import { scheduleSceneSurfaceRemoval } from './scene/transient-surfaces.js'

function reportStartupProgress(id, status, detail, message) {
  try {
    const reporter = globalThis.bailongmaStartupProgress
    if (typeof reporter === 'function') reporter({ id, status, detail, message })
  } catch {}
}

// On first launch, copy sandbox seed files from the resource directory to the user data directory (Electron install)
reportStartupProgress('resources', 'running', '复制沙箱与音乐资源', '正在准备工作区')
seedSandboxOnce()
seedMusicOnce()

// 安全护栏：把历史上误落在安装目录里的工作文件迁回 sandbox（避免下次更新随安装目录被清空）。
// 迁移发生后用粘性事件告警，前端连上即可看到提示。
try {
  const rescuedDirs = rescueDataFromInstallDir()
  if (rescuedDirs.length > 0) {
    setStickyEvent('install_dir_rescue', {
      level: 'warning',
      dirs: rescuedDirs,
      message: `检测到 ${rescuedDirs.length} 个工作目录原先存放在程序安装目录里（更新时会被清空），已自动迁移到 sandbox：${rescuedDirs.join('、')}`,
    })
  }
} catch (err) {
  console.warn('[startup] 安装目录数据迁移检查失败:', err?.message || err)
}
reportStartupProgress('resources', 'done', '工作区已准备', '工作区已准备')

// Collect host system environment info (full scan + persist on first run, then refresh dynamic fields).
// Must complete before the main loop starts so buildSystemPrompt can inject the env block.
reportStartupProgress('environment', 'running', '系统、桌面、软件与本地资源', '正在扫描本机环境')
await collectSystemInfo()

// [macOS 适配] 桌面 / 已装软件 / 本地资源 三项扫描原本是主进程内同步调用，在 macOS 上若
// 遇到某些目录（iCloud 桌面、外接盘等）的 readdirSync 阻塞，会冻结事件循环、导致 startAPI
// 永不执行、激活页打不开。改为在独立子进程中后台执行（scripts/scan-local-env.mjs 写缓存
// 文件），主进程不阻塞、API 立即可用；首次启动环境信息块可能稍晚就绪，下次启动直接命中缓存。
// 桌面路径由主进程传入：getDesktopPath() 依赖 collectSystemInfo() 填充的进程内 _cached，主进程
// 已在上一行 collectSystemInfo() 后拿到正确值；worker 是独立进程、其 _cached 为空无法自行取得，
// 故必须由主进程把桌面路径传过去（见 runLocalEnvScanInBackground）。
runLocalEnvScanInBackground(getDesktopPath())

reportStartupProgress('environment', 'done', '本机环境已扫描', '本机环境已扫描')

// 启动期"自感知"采集(地理/天气/热点/本机 agent/已装工具)是可选的、依赖网络或子进程的步骤,
// 绝不应阻塞后端启动:某个外部调用卡死(如 DNS/connect 被挂住,连 AbortController 都打不断)
// 不能把整个 startAPI 拖到永不执行。给每个采集套硬上限,超时即跳过(非致命),保证一定能启动。
function withStartupTimeout(promise, ms, label) {
  return Promise.race([
    Promise.resolve(promise).catch(err => { console.warn(`${label} 失败(忽略):`, err?.message || err); return null }),
    new Promise(resolve => setTimeout(() => { console.warn(`${label} 超时 ${ms}ms,跳过(不阻塞启动)`); resolve(null) }, ms)),
  ])
}

// 在独立子进程中后台执行本地环境扫描，主进程不阻塞（避免 macOS 上同步扫描冻结事件循环）。
// 脚本路径用「模块相对路径」(import.meta.url) 解析，而非 process.cwd()——这样无论是开发模式
// (node src/index.js，cwd=项目根) 还是打包后的 Electron 模式 (脚本位于 app.asar 内，cwd 不固定)，
// 都能正确定位 worker。
//
// electron 模式的特殊性：后端(src/index.js)是被 electron/main.cjs 经 import() 加载到 electron 主进程
// 内的，因此本函数里 process.execPath 指向 App 二进制。若像 node 模式那样 spawn(process.execPath,
// [scriptPath])，electron 永远加载 package.json 的 main(electron/main.cjs)，传入的脚本路径被忽略，
// 会错误地拉起「完整 App 副本」。故 electron 模式改用 --bailongma-scan-worker 标志，由 main.cjs 识别后
// 仅执行扫描并退出（不抢单实例锁、不创建窗口）。
function runLocalEnvScanInBackground(desktopPath) {
  try {
    const env = { ...process.env, BAILONGMA_DESKTOP_PATH: desktopPath || '' }
    const isElectron = typeof process.versions.electron !== 'undefined'
    let child
    if (isElectron) {
      // 打包/桌面模式：App 二进制 + 专用标志，main.cjs 识别后仅运行扫描并退出。
      child = spawn(process.execPath, ['--bailongma-scan-worker'], {
        detached: true,
        stdio: 'ignore',
        env,
      })
    } else {
      // 纯 node 后端模式：直接以脚本路径启动子进程。
      const scriptPath = fileURLToPath(new URL('../scripts/scan-local-env.mjs', import.meta.url))
      child = spawn(process.execPath, [scriptPath], {
        detached: true,
        stdio: 'ignore',
        env,
      })
    }
    child.unref()
    console.log('[startup] 本地环境扫描已在后台子进程启动')
  } catch (e) {
    console.warn('[startup] 本地环境扫描子进程启动失败(忽略):', e?.message || e)
  }
}

// Collect geo-location + live weather (refresh on IP change or after 7 days; weather refreshed every time)
reportStartupProgress('geo', 'running', '读取缓存或请求实时天气', '正在刷新天气位置')
const geoResult = await withStartupTimeout(collectGeoWeather(), 12000, '[startup] geo-weather')
reportStartupProgress('geo', 'done', '天气位置已刷新', '天气位置已刷新')

// Collect trending topics (CN → Weibo+Zhihu, others → HN+Reddit; 1h cache)
reportStartupProgress('trending', 'running', '加载今日热点源', '正在采集热点')
await withStartupTimeout(collectTrending(geoResult?.location?.country_code), 12000, '[startup] trending')
reportStartupProgress('trending', 'done', '热点采集完成', '热点采集完成')

// Scan locally installed AI agents (Claude Code, Codex, Hermes, OpenClaw, etc.) and persist to known_agents table
reportStartupProgress('agents', 'running', 'Claude Code / Codex / Hermes', '正在扫描本地 Agent')
await withStartupTimeout(collectAgents(), 15000, '[startup] agents')
reportStartupProgress('agents', 'done', '本地 Agent 扫描完成', '本地 Agent 扫描完成')

// Load persisted installed tools
reportStartupProgress('tools', 'running', '恢复已安装能力', '正在加载工具槽')
await withStartupTimeout(loadInstalledTools(), 12000, '[startup] installed-tools')
reportStartupProgress('tools', 'done', '工具槽已加载', '工具槽已加载')

// 本地嵌入模型预热：provider==='local' 时后台 fire-and-forget 建好 pipeline（含首次模型下载），
// 让首条向量召回不被冷启动撞穿超时。绝不阻塞启动，失败静默（召回会自动退化为 FTS5）。
;(async () => {
  try {
    const { getEmbeddingCredentials } = await import('./config.js')
    const cred = getEmbeddingCredentials()
    if (cred?.provider === 'local' && cred.model) {
      const { warmupLocalEmbedding } = await import('./embedding-local.js')
      warmupLocalEmbedding(cred.model).catch(() => {})
    }
  } catch {}
})().catch(() => {})

// Load Agent Skills metadata. Full SKILL.md bodies are injected only when a turn matches.
reportStartupProgress('skills', 'running', '技能目录、SQLite、线程状态', '正在加载技能和记忆')
const startupSkills = refreshSkills()
console.log(`[skills] Loaded ${startupSkills.length} Agent Skill(s)`)

// AbortController for the current LLM call (used to interrupt the main loop)
let currentAbortController = null
let currentExecution = null

// Watchdog：单轮 runTurn 超过这个时间未返回视为卡死（最可能是 fetch/LLM stream/三方网络调用
// 没传 AbortSignal 也没自己超时）。触发后强 abort，把 processing 清掉，主循环能继续
// 处理后续消息。不修复挂着的 promise（它会留在内存里直到 GC 或自行结束），但保证 UI
// "思考中"永远在有限时间内解锁、用户的下一句话能被正常处理。
const RUN_TURN_WATCHDOG_MS = 600_000

const PRIORITY = {
  tick: 10,
  background: 50,
  user: 100,
}

const L2_CONTEXT_HOURS = 24 * 7
const STARTUP_SELF_CHECK_VERSION = 'v2'
const STARTUP_SELF_CHECK_CONFIG_KEY = 'l2_startup_self_check'

// Initialize database
getDB()
if (getMemoryCount() === 0) {
  console.log('[system] Memory store is empty — injecting default seed memories')
  await import('../scripts/seed-memories.js')
}
const birthTime = getOrInitBirthTime()
refreshUserProfile(PRIMARY_USER_ID)
reportStartupProgress('skills', 'done', `已加载 ${startupSkills.length} 个技能并恢复记忆`, '技能和记忆已加载')

// Awakening phase: first 10 heartbeat ticks after initial activation run at a fixed 10s cadence
const AWAKENING_CONFIG_KEY = 'awakening_ticks_remaining'
function getAwakeningTicks() {
  const raw = getConfig(AWAKENING_CONFIG_KEY)
  if (raw === null || raw === undefined || raw === '') return 10
  return Math.max(0, parseInt(raw, 10) || 0)
}
function decrementAwakeningTick() {
  const current = getAwakeningTicks()
  if (current > 0) {
    const next = current - 1
    setConfig(AWAKENING_CONFIG_KEY, String(next))
    // 觉醒期结束:收起 awakening surface(单 surface 的生命周期到此为止;幂等，不存在则无操作）。
    if (next === 0) sceneStore.set('awakening', null)
  }
}

// Awakening exploration tasks: after self-check completes, each autonomous heartbeat tick completes one in order
const EXPLORATION_INDEX_KEY = 'awakening_exploration_index'
// Awakening surface call template — must be executed after completing each exploration step.
// Single surface "awakening" that morphs through findings (SCENE-PROTOCOL §6 kind=awakening):
// ui_set({ id: "awakening", kind: "awakening", intent: "ambient", data: { index: N, total: 3, title: "title", finding: "one-sentence finding", emoji: "emoji" } })
const AWAKENING_EXPLORATION_TASKS = [
  // 1. Read existing memories
  `Exploration (1/2): See what you already know.
Go through the injected memories silently and take stock: who do you know, what do you know, are there any threads with no follow-up.
[HARD RULE — DO NOT VIOLATE] During the awakening exploration phase the user has not started a conversation with you yet. Calling send_message to proactively open a topic — including any "casual mention" of memories you uncovered — is forbidden. Record findings only in the AwakeningCard below; do not turn them into outbound messages.
When done, call ui_set({ id:"awakening", kind:"awakening", intent:"ambient", data:{ index:1, total:2, title:"Reading memories", finding:"(one sentence: the most notable lead in the memory store, or 'memory store ready')", emoji:"🧠" } }).
If later the user opens a conversation and the topic is relevant, you may bring the finding in then — not before.`,

  // 2. Surface an unfinished thread
  `Exploration (2/2): Find a forgotten thread.
Look through memories silently — what did the user mention before but never bring up again? A plan, an idea, something they said they wanted to do but never did?
[HARD RULE — DO NOT VIOLATE] Same as Task 1: send_message is forbidden during awakening exploration. Do not "casually bring it up". Do not ask "do you need me to move this forward?". Do not draft an opening line to the user. The thread, if found, lives only in the AwakeningCard finding field; it waits for the user to start the conversation.
When done, call ui_set({ id:"awakening", kind:"awakening", intent:"ambient", data:{ index:2, total:2, title:"Unfinished thread", finding:"(one sentence describing the forgotten thread, or 'no open threads found')", emoji:"🔍" } }).`,
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
  pendingVerbatimRecital: null,
  pendingConfidenceHint: null,  // 上一轮 refresh-loop 的 confidence，供下次 runInjector 调整召回数量后清空
  tickCounter: 0,             // 累计 TICK 计数（每次进 isTick 路径自增）
  lastTaskRefreshTick: -10,   // 上次 TICK 路径触发 refresh-loop 时的 tickCounter；初值 -10 保证首个 TICK 立刻可触发（差值 = 0 - (-10) = 10 >= 5）
  threadState: initThreadState(),  // 线索模型（DynamicMemoryPool.md 第 8 章）：threads + 前台指针 + 承诺，重启从 db 恢复
}

// 启动时恢复线索状态；threads 表为空但旧 focus_stack 有货 → 一次性迁移（栈顶=前台）。
function initThreadState() {
  const loaded = loadThreadState()
  if (loaded) return loaded
  try {
    const legacy = loadFocusStack()
    if (Array.isArray(legacy) && legacy.length > 0) {
      const migrated = migrateFocusStackToThreads(legacy)
      saveThreadState(migrated)
      console.log(`[threads] 从专注栈迁移 ${migrated.threads.length} 条线索（前台 = 原栈顶）`)
      return migrated
    }
  } catch (e) {
    console.warn('[threads] focus_stack 迁移失败:', e?.message || e)
  }
  return { threads: [], foregroundId: null, commitments: [] }
}

// brain-ui 兼容：把线索状态派生成"栈视图"（后台按活跃时间升序 + 前台垫底=栈顶），
// focus_frame 事件 payload 形状不变，专注帧观察面板零改动。
function deriveStackView(state) {
  const ts = ensureThreadState(state)
  const background = ts.threads
    .filter(t => t.id !== ts.foregroundId)
    .sort((a, b) => Date.parse(a.lastEventAt || 0) - Date.parse(b.lastEventAt || 0))
  const fg = getForegroundThread(state)
  return fg ? [...background, fg] : background
}

const TASK_IDLE_TICK_LIMIT = 5  // auto-clear task after N consecutive task ticks with no tool calls

// 识别器去抖调度：批量 recognizer 完成后照常广播 memories_written（按批，count 为该批写入总数）
configureRecognizerScheduler({
  onResult: (memories) => {
    emitEvent('memories_written', { count: memories?.length || 0, memories: memories || [] })
    const evolved = recordSelfEvolutionFromMemories(memories || [], { emitEvent })
    if (Array.isArray(memories) && memories.length > 0) {
      refreshUserProfile(PRIMARY_USER_ID)
    }
    if (evolved.length > 0) {
      console.log(`[self-evolution] learned ${evolved.length} behavior update(s)`)
    }
  },
})

function summarizeToolCall(t = {}) {
  const args = t.args || {}
  const status = t.ok === false ? ' failed' : ''
  if (t.name === 'send_message') return `send_message -> ${args.target_id || args.to || 'unknown'}${status}`
  if (t.name === 'fetch_url') return `fetch_url(${String(args.url || '').slice(0, 60)})${status}`
  if (t.name === 'write_file') return `write_file(${args.path || args.filename || args.file_path || '?'})${status}`
  if (t.name === 'read_file') {
    const pathArg = args.path || args.filename || args.file_path || '?'
    const rangeParts = []
    if (args.start_line !== undefined) rangeParts.push(`start=${args.start_line}`)
    if (args.end_line !== undefined) rangeParts.push(`end=${args.end_line}`)
    if (args.max_lines !== undefined) rangeParts.push(`max=${args.max_lines}`)
    const range = rangeParts.length ? ` ${rangeParts.join(' ')}` : ''
    return `read_file(${pathArg}${range})${status}`
  }
  if (t.name === 'exec_command') return `exec_command(${String(args.command || '').slice(0, 80)})${status}`
  if (t.name === 'install_software') return `install_software(${String(args.query || args.package_id || args.job_id || '?').slice(0, 80)})${status}`
  return `${t.name || 'tool'}${status}`
}

// 线索模型：task 生命周期 ↔ 承诺生命周期。
// set_task = "好的我去做"的工程化时刻（单 Agent 版 spawn）：给前台线索挂承诺，钉住温度；
// 任务完成/取消 = 交差：关承诺，线索按 lastEventAt 自然降温——没有任何突变动作。
function openTaskCommitment(description) {
  try {
    const commitment = openCommitment(state, { text: String(description || ''), tick: state.tickCounter || 0 })
    // task ↔ 承诺绑定：task 槽是单例（set_task B 会覆盖 A），但承诺是多例的——
    // 收尾时必须按 id 精确关"当前 task 的承诺"，否则 closeCommitment 默认关最老的
    // open 承诺，任务 B 完成会误关任务 A 的承诺（被覆盖的 A 承诺保持 open：
    // 用户没取消 A，承诺仍未兑现，线索保持 warm 等用户回来问）。
    state.taskCommitmentId = commitment?.id || null
    // 跨重启持久化：task 从 config 恢复、承诺从 db 恢复，绑定关系也得跟着活下来，
    // 否则重启后收尾退化回"关最老的 open 承诺"。
    setConfig('current_task_commitment_id', commitment?.id || '')
    saveThreadState(state.threadState)
  } catch (e) {
    console.log('[threads] openCommitment failed:', e?.message || e)
  }
}
function closeTaskCommitment(status = 'done') {
  try {
    const boundId = state.taskCommitmentId || getConfig('current_task_commitment_id') || null
    const closed = closeCommitment(state, {
      commitmentId: boundId,
      status,
    })
    state.taskCommitmentId = null
    setConfig('current_task_commitment_id', '')
    if (closed) saveThreadState(state.threadState)
  } catch (e) {
    console.log('[threads] closeCommitment failed:', e?.message || e)
  }
}

function autoCompleteTask(reason) {
  const clearedTask = state.task
  state.task = null
  state.lastTaskRefreshTick = -10
  state.taskSteps = []
  state.taskIdleTickCount = 0
  setConfig('current_task', '')
  setConfig('current_task_steps', '[]')
  closeTaskCommitment('done')
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
    `[HARD RULE — DO NOT VIOLATE] During self-check, calling send_message is strictly forbidden. No text output of any kind (including "checking…", "self-check complete", or any other text). All status must be expressed through speak (voice) and ui_set (the self-check surface). The text channel must remain completely silent; any text output counts as self-check failure.`,
    `There is ONE self-check surface, id="self-check" (SCENE-PROTOCOL kind=selfcheck). It morphs in place through every step — never use a different id, never remove it between steps. Each step: play a Chinese voice announcement, then ui_set the running state of this one surface.`,
    `1. Call speak text="正在检查文件读写能力"; call ui_set({ id:"self-check", kind:"selfcheck", intent:"inform", data:{ phase:"running", step:1, total:3, name:"文件读写", icon:"📁" } }). Then: use write_file to write self_check.txt in the sandbox root (content = current timestamp), then read_file it back to verify consistency. Record the result.`,
    `2. Call speak text="正在检查热点面板"; call ui_set({ id:"self-check", kind:"selfcheck", intent:"inform", data:{ phase:"running", step:2, total:3, name:"热点面板", icon:"🌐" } }). Then: hotspot_mode action=show; confirm it returns ok, then hotspot_mode action=hide. Record the result.`,
    `3. Call speak text="正在检查视频模式"; call ui_set({ id:"self-check", kind:"selfcheck", intent:"inform", data:{ phase:"running", step:3, total:3, name:"视频模式", icon:"🎬" } }). Then: web_search for "bilibili Iron Man JARVIS" ONCE — this is only a self-check, so take the FIRST BV number that appears in the results and stop immediately; do NOT keep searching for more videos or compare options, one valid BV id is enough. media_mode mode=video action=show url=https://www.bilibili.com/video/<BV> autoplay=true; wait ~5 seconds; media_mode mode=video action=hide. Record the result.`,
    `Result values: use ok, degraded, error, or skipped_* for each item. Continue to the next item even if one fails.`,
    `[FINAL THREE STEPS — REQUIRED, in order]\n(a) Morph the SAME surface to its done state: ui_set({ id:"self-check", kind:"selfcheck", intent:"inform", data:{ phase:"done", results:[{name:"文件读写",status:"ok/error/skipped",note:"..."},{name:"热点面板",status:"..."},{name:"视频模式",status:"..."}], overall:"ok/degraded/error" } }). Infer overall from actual results: all ok → ok; any skipped → degraded; any error → error.\n(b) Call complete_startup_self_check with a summary (one sentence) and the results object.\n(c) Clear the surface: ui_set({ id:"self-check", remove:true }).`,
  ].join('\n')
}

// Fallback 投递：当模型未按协议调 send_message 时由主循环代为投递。
// 用 msg 自带的 externalPartyId + channel 路由（用户从哪儿发，就回到哪儿），并写入 conversations 表。
//
// 同步写一条 action_logs（tool='send_message', source='fallback'），保证 jarvis 在
// action_log 里能完整看到自己的所有真实输出——self-snapshot 的身份锚才有据可依，
// 不会把 fallback 投递误判成"幽灵回复（看似是你说过但 action_log 没记录）"。
function deliverFallbackReply(msg, content, timestamp) {
  const channel = msg.channel || ''
  const externalPartyId = msg.externalPartyId || ''
  const insertedId = insertConversation({
    role: 'jarvis',
    from_id: 'jarvis',
    to_id: msg.fromId,
    content,
    timestamp,
    channel,
    external_party_id: externalPartyId,
    // P0-2：fallback 投递的 reply 同样检测末尾是否是 follow-up 悬念
    open_question: detectOpenFollowupQuestion(content) ? 1 : 0,
  })
  emitEvent('message', {
    from: 'consciousness',
    to: msg.fromId,
    content,
    timestamp,
    conversation_id: insertedId,
    channel,
    external_party_id: externalPartyId,
  })
  if (externalPartyId) {
    dispatchSocialMessage(externalPartyId, content).catch(err => console.warn('[social] fallback send failed:', err.message))
  }
  // 同步登记 action_log，让 self-snapshot 能用 action_log 作为身份锚的真值源。
  // tool 仍为 send_message，但 source 标 'fallback' 以便区分主动调用与协议兜底。
  try {
    insertActionLog({
      timestamp,
      tool: 'send_message',
      summary: `send_message -> ${msg.fromId} (fallback)`,
      detail: String(content).slice(0, 280),
      status: 'ok',
      risk: 'medium',
      args: { target_id: msg.fromId, content, channel },
      resultPreview: `消息已发送至 ${msg.fromId}${channel ? `（${channel}）` : ''} [fallback]`,
      durationMs: 0,
      source: 'fallback',
    })
  } catch (e) {
    console.warn('[fallback] insertActionLog failed:', e?.message || e)
  }
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
  // currentTargetId 必须回传：工具执行层（llm.js 的耗时工具即时回应 ack、send_message 协议兜底）
  // 都靠 toolContext.currentTargetId 找"当前该回复谁"。早先只用它算 visibleTargetIds 却没放回
  // 返回对象，导致 toolContext.currentTargetId 恒为 undefined —— ack 不发、fallback 投递也拿不到目标。
  return { currentTargetId: currentTargetId || null, allowedTargetIds: unique, visibleTargetIds: unique }
}

function buildToolContextForProcess(msg, injection) {
  const currentChannel = msg?.notificationChannel || msg?.channel || null
  const voiceReply = msg?.notificationVoiceReply === true
    || msg?.voiceReply === true
    || isVoiceChannel(currentChannel)
  const base = buildToolContext({
    currentTargetId: msg?.notificationTargetId || msg?.reminderTargetId || msg?.fromId || null,
    conversationWindow: injection.conversationWindow || [],
    includeRecentPartners: true,
  })

  return {
    ...base,
    // 当前 turn 的渠道信息：execSendMessage 在 AUTO 模式下优先用这里，确保"在哪儿收的消息就回到哪儿"
    currentChannel,
    currentExternalPartyId: msg?.notificationExternalPartyId || msg?.externalPartyId || null,
    voiceReply,
    currentUserMessage: msg?.content || null,
    // 自我感知信号：传给工具执行层（如 upsert_memory 守门），让"镜像污染"在写入长期记忆前就被拦截
    selfPerception: injection.selfPerception || null,

    // 审视分身（review_work）取证用：当前任务目标 + 每步状态。让审视分身能拿到主 Agent 自己的
    // 计划做对照，看"声称完成"与每步证据是否一致。只读快照，不可被主 Agent 改写。
    getTaskState: () => ({ task: state.task, steps: state.taskSteps }),

    onSetTask: (description, steps) => {
      state.task = description
      state.lastTaskRefreshTick = -10
      state.taskSteps = steps.map(s => ({ text: s, status: 'pending', note: '' }))
      setConfig('current_task', description)
      setConfig('current_task_steps', JSON.stringify(state.taskSteps))
      openTaskCommitment(description)
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
      closeTaskCommitment('done')
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
      const total = state.taskSteps.length
      const done = state.taskSteps.filter(s => s.status === 'done').length
      emitEvent('task_step_updated', { index: idx, status, note, progress: `${done}/${total}` })
      // Option C: auto-clear task when all steps reach a terminal state
      const terminal = ['done', 'failed', 'skipped']
      const allTerminal = total > 0 && state.taskSteps.every(s => terminal.includes(s.status))
      // 在 autoCompleteTask 清空 taskSteps 之前先算好"下一步/是否有失败"，回传给 executor，
      // 让 update_task_step 的返回串把模型推进下一个 执行→观察→判断 微循环（ReAct 驱动）。
      const nextIndex = state.taskSteps.findIndex(s => s.status === 'pending')
      const nextStep = nextIndex >= 0 ? state.taskSteps[nextIndex].text : null
      const anyFailed = state.taskSteps.some(s => s.status === 'failed')
      if (allTerminal) autoCompleteTask('all steps complete')
      return {
        total,
        done,
        progress: `${done}/${total}`,
        allTerminal,
        nextIndex: nextIndex >= 0 ? nextIndex : null,
        nextStep,
        anyFailed,
      }
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

function resolveTurnTools(injectedTools = [], { silentSignal = false, strictEvaluation = null } = {}) {
  if (silentSignal) return []
  const tools = Array.isArray(injectedTools) ? injectedTools.filter(Boolean) : []
  if (!tools.includes('send_message')) tools.unshift('send_message')
  return filterStrictEvaluationTools(tools, strictEvaluation)
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

// 语音轮里"明显要往外部/社交渠道发送"的意图——命中则保留 send_message 工具，
// 否则语音轮默认撤掉它（回复走纯文本直投+TTS）。宁可漏判（少数情况下模型够不到外发通道，
// 会如实说一声）也不误判（"发"字太宽泛不收，必须带明确渠道词或"发到/发给我"这类路由意图）。
const EXTERNAL_SEND_HINTS = [
  '微信', 'wechat', 'discord', '飞书', 'feishu', '企微', 'wecom',
  '发到', '推送到', '发给我', '转给', '发条微信', '发个微信', '发我微信',
]
function voiceTurnNeedsSendMessage(text) {
  const b = String(text || '').toLowerCase()
  return EXTERNAL_SEND_HINTS.some(k => b.includes(k.toLowerCase()))
}

function deliverDirectReply(msg, content, finishTurn) {
  const timestamp = nowTimestamp()
  if (isVoiceChannel(msg?.channel)) autoSpeakForVoiceReply(content)
  deliverFallbackReply(msg, content, timestamp)
  finishTurn?.(content)
}

function tryHandleVerbatimTurn(input, msg, { finishTurn, conversationWindow = [] } = {}) {
  if (!msg || msg.silent === true) return false
  const text = String(input || '').trim()
  if (!text) return false

  if (isVerbatimStart(text) && state.pendingVerbatimRecital?.text) {
    const reply = state.pendingVerbatimRecital.text
    state.pendingVerbatimRecital = null
    deliverDirectReply(msg, reply, finishTurn)
    return true
  }

  const payload = extractVerbatimPayload(text)
  if (isVerbatimSetup(text) && payload.length >= 20) {
    state.pendingVerbatimRecital = {
      text: payload,
      sourceTimestamp: msg.timestamp || nowTimestamp(),
      createdAt: Date.now(),
    }
    deliverDirectReply(msg, '收到，准备好了。说"开始"我就读。', finishTurn)
    return true
  }

  if (isVerbatimOutputRequest(text)) {
    const reply = (hasInlineVerbatimPayload(text) && payload.length >= 20)
      ? payload
      : (state.pendingVerbatimRecital?.text || findRecentVerbatimPayload(conversationWindow, msg))
    if (reply) {
      state.pendingVerbatimRecital = null
      deliverDirectReply(msg, reply, finishTurn)
      return true
    }
  }

  return false
}

function isFastUserMessage(msg) {
  return !!msg && getProcessPriority(msg) >= PRIORITY.user
}

function stableFocusTopic(frame) {
  if (!frame || !Array.isArray(frame.topic) || frame.topic.length === 0) return ''
  const hitCount = Number(frame.hitCount || 0)
  const hasConclusion = Array.isArray(frame.conclusions) && frame.conclusions.length > 0
  if (hitCount < 2 && !hasConclusion) return ''
  return frame.topic.slice(0, 3).join(',')
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
  if (isSoftwareInstallRequest(text) || /软件|应用|程序|客户端|工具|装了什么|用了什么|代理|科学上网|翻墙|\bvpn\b|\bproxy\b|clash|mihomo|v2ray|xray|sing-?box|shadowrocket|shadowsocks|wireguard|tailscale|zerotier|openvpn/.test(text))
    blocks.push(getInstalledSoftwareBlock())
  if (/位置|在哪个城市/.test(text))
    blocks.push(getGeoWeatherBlock())
  // 飞书：注入实时连接状态，避免 Agent 在「是不是连上了」上瞎猜、误报未连接。
  if (/飞书|feishu|lark/.test(text))
    blocks.push(getFeishuStatusBlock())
  // 热点不再按关键词预喂热搜数据：是否取数/开面板交由 Agent 调 hotspot_mode 自决（见 prompt Hotspot Panel 规则）。
  return blocks.filter(Boolean).join('\n\n')
}

function weatherSurfaceId(city = '') {
  const slug = String(city || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return `weather-${slug || 'local'}`
}

function normalizeWeatherSurfaceData(cardProps = {}) {
  const forecast = Array.isArray(cardProps.forecast)
    ? cardProps.forecast.map(f => ({
      day: f.day || '',
      low: f.low,
      high: f.high,
      condition: f.condition || '',
    }))
    : []
  return {
    variant: cardProps.variant || 'compact',
    city: cardProps.city || '当前位置',
    temp: cardProps.temp,
    condition: cardProps.condition || '',
    forecast,
  }
}

async function projectWeatherSurfaceForTurn(message = '') {
  if (!isWeatherQuery(message)) return null

  const cardProps = await getWeatherCardProps(message)
  if (!cardProps) return null

  const data = normalizeWeatherSurfaceData(cardProps)
  const id = weatherSurfaceId(data.city)
  const changed = sceneStore.set(id, {
    kind: 'weather',
    data,
    intent: 'ambient',
  })
  scheduleSceneSurfaceRemoval(id, { kind: 'weather' })
  if (changed) {
    emitEvent('action', {
      tool: 'weather_surface',
      summary: '已显示天气卡片',
      detail: data.city,
    })
  }
  return { id, data, changed }
}

async function runTurn(input, label, msg = null) {
  const sessionRef = newSessionRef()
  const isTick = !msg
  const silentSignal = msg?.silent === true
  if (isTick) state.tickCounter += 1
  const priority = getProcessPriority(msg)
  const fastUserPath = isFastUserMessage(msg)
  const controller = new AbortController()
  let llmResult = null
  let toolCallLog = []
  let voiceTurn = false
  let localReply = false
  let terminalEmitted = false
  const finishTurn = (content = '') => {
    if (isTick || silentSignal || terminalEmitted) return
    terminalEmitted = true
    emitEvent('response', { sessionRef, label, content })
  }

  console.log(`\n── ${label} ──`)
  if (!silentSignal) emitEvent(isTick ? 'tick' : 'message_received', { label, input: input.slice(0, 300) })

  // User messages are written to conversations at the pushMessage stage (recorded on arrival) — do not write them again here.
  try {
    beginExecution({
      priority,
      kind: isTick ? 'tick' : (fastUserPath ? 'user' : 'background'),
      label,
      controller,
    })

    if (isTick) ensureStartupSelfCheckState()

    const earlyConversationWindow = msg ? getRecentConversationTimeline(12, 2, { includeAbsorbed: true }) : []
    if (!isTick && tryHandleVerbatimTurn(input, msg, { finishTurn, conversationWindow: earlyConversationWindow })) {
      return
    }

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
        finishTurn()
        return  // Skip LLM, silent round
      }
      if (autoConfigResult && !autoConfigResult.ok) {
        // Key detected but validation failed: keep message and let LLM inform the user
        keyConfigFailDir = `[system] An API key was detected in the user message but validation failed: ${autoConfigResult.error}. Inform the user that the key is invalid and suggest checking whether it is correct or has expired.`
      }
    }

    // 天气不走"绕开 LLM 的快速回复"：仍交回 LLM 回答。
    // 但天气 surface 是确定性 UI 能力,不能完全依赖模型是否记得调用 ui_set。

    // 1. Injector
    const injection = await runInjector({
      message: input,
      state,
      currentChannel: msg ? normalizeChannel(msg.channel || '') : '',
    })
    throwIfAborted(controller.signal)

    // 1b. 线索模型（DynamicMemoryPool.md 第 8 章）—— 专注栈的继任者。
    // 只有用户消息走归属判定（纯启发式，零 LLM 延迟）；TICK 永不参与判定也永不触发降温
    // ——温度是读时算出来的（buildThreadView），没有"stale 清理"这个动作。
    try {
      const saveState = () => saveThreadState(state.threadState)
      let threadResult = { event: 'noop', thread: null, switchedFrom: null }
      if (!isTick) {
        threadResult = attributeUserMessage(state, input, {
          tick: state.tickCounter || 0,
          channel: msg ? normalizeChannel(msg.channel || '') : '',
        })
      }
      const foregroundThread = getForegroundThread(state)
      emitEvent('focus_frame', {
        focusStack: deriveStackView(state),
        topFrame: foregroundThread,
        threadState: state.threadState,
        event: threadResult?.event || 'noop',
      })

      // 写时归属印章：本轮所有 insertConversation 自动带 thread_id + focus_topic。
      // TICK 轮（自主干活）归属到开放承诺的线索——Agent 干活本身就是注意力事件。
      const stampThread = !isTick
        ? foregroundThread
        : (() => {
            const oc = latestOpenCommitment(state)
            return (oc && getThreadById(state, oc.threadId)) || foregroundThread
          })()
      const stampTopicStr = stableFocusTopic(stampThread)
      setCurrentFocusTopic(stampTopicStr)
      setCurrentThreadId(stampThread?.id || '')
      if (!isTick && msg?.fromId && msg?.timestamp && stampThread) {
        try { updateUserMessageFocusTopic(msg.fromId, msg.timestamp, stampTopicStr, stampThread.id) } catch {}
      }

      if (threadResult?.event && threadResult.event !== 'noop') {
        saveState()
      }

      // 前台切走 → 旧前台做一次增量摘要（fire-and-forget；只增加表示，不隐藏任何对话）。
      if (threadResult?.switchedFrom) {
        const switched = threadResult.switchedFrom
        ;(async () => {
          try {
            await summarizeThread(switched, { sessionRef, emitEvent, saveState })
          } catch {}
        })().catch(() => {})
      }

      // 弱信号候选（与某后台线索重叠=1）→ 后台 LLM 仲裁。
      // same → 合并（线索无栈序不变量，合并永远安全）；different → 用语义化 label/topic 润色新线索。
      if (threadResult?.ambiguousWith && state.focusClassifierDisabled !== true) {
        const createdThread = threadResult.thread
        const candidate = threadResult.ambiguousWith
        const body = msg?.content || input || ''
        ;(async () => {
          try {
            const verdict = await classifyThreadAttribution({
              newMessage: body,
              candidateThread: candidate,
              createdTopic: createdThread?.topic || [],
              signal: controller.signal,
            })
            if (!verdict) return
            const ts = ensureThreadState(state)
            if (verdict.verdict === 'same' && ts.threads.includes(createdThread) && ts.threads.includes(candidate)) {
              mergeThreads(state, createdThread.id, candidate.id)
              try { reassignConversationsThread(createdThread.id, candidate.id) } catch {}
              ts.mergedAwayIds = [...(ts.mergedAwayIds || []), createdThread.id]
              setCurrentThreadId(candidate.id)
              saveState()
              ts.mergedAwayIds = []   // db 行已标 merged，清掉避免每次 save 重复 UPDATE
            } else if (ts.threads.includes(createdThread)) {
              if (verdict.label) createdThread.label = verdict.label
              if (verdict.topic.length > 0) createdThread.topic = verdict.topic
              saveState()
            }
            emitEvent('focus_frame', {
              focusStack: deriveStackView(state),
              topFrame: getForegroundThread(state),
              threadState: state.threadState,
              event: 'refined',
            })
          } catch {}
        })().catch(() => {})
      }
    } catch (e) {
      // 线索判断不应该影响主流程；任何异常吞掉、记录日志即可
      console.log('[threads] attributeUserMessage failed:', e.message)
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
      directions.unshift('Current turn is a real-time external user message. Understand it quickly and reply directly with send_message. If no slow tool is needed, send exactly one final answer and stop. Use heavier tools only when the reply depends on them. During longer execution, send progress only for meaningful new findings or blockers; do not send an acknowledgement and then a near-duplicate final answer.')
    }
    // 软件安装工作流已收敛为 software-install 能力的 context，统一经 buildSystemPrompt 注入
    //   （见 capabilities/capability-registry.js）。此处不再以 direction 重复注入同一份文本。
    if (isVoiceChannel(msg?.channel)) {
      directions.push('Voice mode: answer with judgment and meaning first. Do not read out an inventory. If details are merely evidence, compress them into the situation they prove.')
      directions.push('Voice mode style: speak like a person in the room. Default to one or two short sentences. No Markdown, no bullets, no headings, no process acknowledgement, no repeated summary. Say the situation, then stop.')
      directions.push('The current user message came from voice input. Speak naturally and concisely — like talking to a person, not writing an article. Get to the point, avoid filler phrases, and do not use Markdown formatting (no bullet points, asterisks, or headers). Say what needs to be said and stop.')
      directions.push('For voice input, do not send process acknowledgements like "I will look" or "let me check" before the answer. Send one compact answer unless you truly need a slow tool and have no result yet.')
      directions.push('If the user asks you to read, repeat, or output exact text for recording, reply with the exact text as normal chat text. Do not call the speak tool; this voice channel already turns assistant text into audio automatically. Do not paraphrase, summarize, shorten, or add commentary.')
      directions.push('If the voice input is clearly a speech recognition error (meaningless noise, garbled syllables, random characters) OR appears to be ambient speech not directed at you — such as someone nearby talking to another person, background conversation, or utterances with no plausible intent to address an AI assistant — treat it as noise and stay genuinely silent. Do NOT call send_message or any other tool. Critically, do NOT write any spoken sentence about it either: on a voice/local turn your plain text reply is read aloud by TTS, so explaining "this looks like recognition noise, so I will stay silent" is self-defeating — that explanation itself becomes spoken sound, which is the opposite of silence. Instead reply with a SINGLE emoji and nothing else — prefer 👂 — with no words, punctuation, or reasoning before or after it. A lone emoji gives TTS nothing meaningful to speak, so it stays effectively silent while still showing on screen that you registered the input and deliberately chose not to act on it. Only answer normally when the input is reasonably addressed to you.')
    }

    if (keyConfigFailDir) directions.unshift(keyConfigFailDir)

    const memoriesText = formatMemoriesForPrompt(injection.memories, injection.recallMemories)
    const activePoliciesText = formatActivePoliciesForPrompt(injection.activePolicies)
    const directionsText = directions.join('\n')
    const taskKnowledgeText = formatTaskKnowledge(injection.taskKnowledge)
    const temporalRecallText = formatTemporalRecall(injection.temporalRecall)

    // Real-time user messages take the fast path: skip heavy context gathering to avoid slowdowns from task background.
    const prefetchText = formatPrefetchedItems(injection.prefetchedItems)
    const runtimeInjectionPromise = runRuntimeInjector({
      message: msg?.content || input,
      task: state.task,
      taskKnowledge: taskKnowledgeText,
      memories: memoriesText,
      fastUserPath,
      signal: controller.signal,
    })
    const weatherSurfacePromise = (!isTick && msg && !silentSignal)
      ? projectWeatherSurfaceForTurn(msg.content || input)
      : Promise.resolve(null)
    const [runtimeInjection] = await Promise.all([runtimeInjectionPromise, weatherSurfacePromise])
    throwIfAborted(controller.signal)

    // 天气卡片投影与 runRuntimeInjector 并发;显式城市天气共用 in-flight wttr.in 请求。
    // 不使用启动期 IP geo-weather 作为天气卡兜底,避免 VPN 出口城市污染结果。

    // 用户跨渠道可达性快照（让 L2 主动消息能选对渠道：用户在外面就发微信，在电脑前就发本地）
    const presenceText = formatPresenceForPrompt(PRIMARY_USER_ID)

    if (runtimeInjection.taskExtraContextItems.length > 0) {
      console.log(`[context] Added ${runtimeInjection.taskExtraContextItems.length} context item(s)`)
      emitEvent('context_gathered', {
        count: runtimeInjection.taskExtraContextItems.length,
        items: runtimeInjection.taskExtraContextItems.map(c => c.label),
      })
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
      activePolicies: (injection.activePolicies || []).map(m => ({
        id: m.id,
        mem_id: m.mem_id || '',
        event_type: m.event_type || '',
        content: m.content || '',
        detail: m.detail || '',
        score: m._policyScore || 0,
        reasons: m._policyReasons || [],
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
      userProfile: injection.userProfile || null,
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
    const terminalStreamContext = formatTerminalStreamContext()
    const extraContextJoined = [presenceText, runtimeInjection.contextText, terminalStreamContext, prefetchText, injection.uiSignalSummary, formatSceneManifest(sceneStore.manifest()), formatAIVideoPanel(getAIVideoPanelState())].filter(Boolean).join('\n\n')
    const skillSelection = selectSkillsForMessage(msg?.content || input || '')
    const agentSkillsText = formatSkillsForContext(skillSelection)
    if (skillSelection.active.length > 0 || skillSelection.catalogRequested) {
      emitEvent('agent_skills_selected', {
        active: skillSelection.active.map(s => ({
          id: s.id,
          name: s.name,
          description: s.description,
          source: s.source,
          relativeDir: s.relativeDir,
          score: s.score,
        })),
        catalogRequested: skillSelection.catalogRequested,
        total: skillSelection.catalog.length,
      })
    }

    // system 只留稳定硬底线（agent_name / persona）—— 让 DeepSeek prefix cache
    // 真正命中。currentTime / existenceDesc / systemEnv / security 改走 <runtime> 段（每轮变化）。
    // P1：把当前 user 消息正文传给 buildSystemPrompt，让 agent registry 块按需注入
    //   （只在用户明确提到 Claude Code/Codex/Hermes 等外部 agent 时才出现）。
    // Wave 2：把 channel / geo / focus 信号一起传过去，让 8 段场景规则按需注入。
    // TODO: Wave 2 后续接入 —— hasWechatHistory 暂时按 false 传（需要查 conversations 表
    //   看当前 user 是否有 WECHAT 历史；目前依赖 currentChannel === 'WECHAT' 来触发）。
    // TODO: Wave 2 后续接入 —— hasActiveFocus 暂时按 false 传（需要把 focus banner active
    //   状态做进 state，目前依赖 keyword 触发）。
    const systemPrompt = buildSystemPrompt({
      agentName,
      persona,
      birthTime,
      userMessage: msg?.content || input || '',
      currentChannel: msg ? normalizeChannel(msg.channel || '') : '',
      isVoiceTurn: isVoiceChannel(msg?.channel),
      hasWechatHistory: false,
      hasActiveFocus: false,
      currentCountryCode: geoResult?.location?.country_code || '',
      currentTimezone: geoResult?.location?.timezone || '',
      currentTools: injection.tools || [],
      // 编程纪律内化的信号源二/三：task 文本 + 最近动作摘要（TICK 干活轮也能命中）
      currentTaskText: state.task || '',
      recentActionsSummary: (state.recentActions || []).map(a => a?.summary || '').join(' | '),
    })

    const baseContextArgs = {
      memories: memoriesText,
      activePolicies: activePoliciesText,
      temporalRecall: temporalRecallText,
      directions: directionsText,
      constraints: injection.constraints || [],
      personMemory: injection.personMemory || null,
      userProfile: injection.userProfile || null,
      thoughtStack: state.thoughtStack,
      entities,
      hasActiveTask,
      task: state.task || null,
      taskKnowledge: taskKnowledgeText,
      extraContext: extraContextJoined,
      awakeningTicks: getAwakeningTicks(),
      threadView: buildThreadView(state),
      agentSkills: agentSkillsText,
      // Runtime info：从 system 迁来的每轮变化字段，集中放 <context><runtime>
      currentTime: nowTimestamp(),
      existenceDesc: describeExistence(birthTime),
      systemEnv: buildSystemEnv(msg),
      security: getSecurity(),
      currentChannel: msg ? normalizeChannel(msg.channel || '') : '',
      channelSwitched: detectChannelSwitch(msg, injection.conversationWindow || []),
      focusTickCounter: state.tickCounter || 0,
      selfPerception: injection.selfPerception || null,
      selfSnapshot: injection.selfSnapshot || null,
      selfEvolution: injection.selfEvolution || '',
    }

    // ① 统一相关度门（动态上下文记忆池 / 少即是强：排除导向的精细化管理）。
    // 在 buildContextBlock 渲染之前，对"几乎常驻但常无关"的 section 做相关度门控 + 全段埋点。
    // 参照系 = 本轮 user 消息正文 + 当前焦点 topic（编排器已蒸馏的"在关注什么"）。
    // 参照系信号不足时 selectContextSections 内部会自动跳过门控、保留全部（守连续感红线）。
    const focusTopicWords = (getForegroundThread(state)?.topic || []).join(' ')
    const referenceFrame = [msg?.content || input || '', focusTopicWords].filter(Boolean).join(' ')
    const gateResult = selectContextSections(baseContextArgs, {
      referenceFrame,
      enabled: !state.sectionGateDisabled,
    })
    emitEvent('context_section_gate', { audit: gateResult.audit, meta: gateResult.meta })
    // 埋点即时可见：门控真正跑过的轮次，打一行全段相关度摘要（measure-only 的分数也看得到，
    // 攒分布数据用）。* 标记本可被剔除但当前 measure-only 放行的段——它们是后续 flip enforce 的候选。
    if (gateResult.meta.gated && gateResult.audit.length > 0) {
      const summary = gateResult.audit
        .map(a => `${a.section}=${a.score}${a.dropped ? '✂' : (a.enforce ? '' : (a.hits === 0 ? '*' : ''))}`)
        .join(' ')
      console.log(`[排除层] ${summary} | 参照系="${gateResult.meta.referenceFrame}"`)
    }

    let contextBlock = buildContextBlock(gateResult.args)
    const strictEvaluation = resolveStrictEvaluationMode(msg?.content || input || '', {
      strictEvaluation: msg?.strictEvaluation,
      forbiddenTools: msg?.forbiddenTools,
    })
    const strictEvaluationContext = buildStrictEvaluationContext(strictEvaluation)
    if (strictEvaluationContext) {
      contextBlock = [contextBlock, strictEvaluationContext].filter(Boolean).join('\n\n')
    }

    // P0-1：把本轮焦点 topic 字符串传给 buildLLMMessages，用于：
    //   - conversationWindow 每条消息 marker 上的 topic 标签
    //   - 当前 user 消息 marker 上的 "topic switch" 提示
    //   - 过期未答悬念的判断（话题切走时直接标 [expired]）
    const currentTopicStr = stableFocusTopic(getForegroundThread(state))

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
      currentTopic: currentTopicStr,
      isTick,
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
          // 用 gateResult.args（过门后的）而非原始 baseContextArgs，让排除层的剔除在 refresh 重建里也保留。
          contextBlock = buildContextBlock({
            ...gateResult.args,
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
    toolContext.strictEvaluation = strictEvaluation
    // 审视分身取证：把本轮正在累积的工具日志数组引用挂进 toolContext。execReviewWork 在循环中途
    // 被调时读它，即可拿到"主 Agent 到此为止实际做了什么"的真实证据（数组按引用传递，调用时已填充）。
    // 这是审视独立性的承重墙——主 Agent 无法在 review_work 参数里粉饰或省略它做过的事。
    toolContext.turnToolLog = toolCallLog
    voiceTurn = isVoiceChannel(msg?.channel)
    // localReply：本地渠道（语音 / TUI，非社交）下纯文本即回复，模型无需调 send_message——
    // runtime 协议兜底会替它真正投递（含语音 TTS）。社交渠道（微信/Discord/飞书/企微）才必须
    // send_message 才能送达外部平台。省掉 send_message 那一整轮额外 LLM 调用是语音提速的关键。
    localReply = !!msg?.fromId && !silentSignal && !isExternalChannel(msg?.channel)
    let turnTools = resolveTurnTools(injection.tools, { silentSignal, strictEvaluation })
    // 语音轮撤掉 send_message（用户决策）：语音回复直接走纯文本 → runtime 协议兜底 executeTool
    // 投递 + 自动 TTS，模型既不必也不能调 send_message，彻底消除"调工具那一轮"的延迟，也不让它
    // 在 UI 里显式出现。例外：消息意图明显要往外部/社交渠道发（"发到我微信"等）时保留，否则模型
    // 够不到外发通道。撤的只是模型的工具入口——本地投递通道（fallback / slow-ack）不受影响。
    if (voiceTurn && !silentSignal && !voiceTurnNeedsSendMessage(input)) {
      turnTools = turnTools.filter(t => t !== 'send_message')
    }
    // 能力展示是本地可视化动作。若 capability_demo 已按需注入，保留 send_message 会让模型
    // 走成"只发一句看屏幕"的普通回复；本地轮次最终文字本来就能用 plain text 投递。
    if (localReply && turnTools.includes('capability_demo')) {
      turnTools = turnTools.filter(t => t !== 'send_message')
    }
    const capabilityDemoTurn = localReply && turnTools.includes('capability_demo')
    const toolPromptHints = formatToolPromptHintsForSchemas(injection.activePolicies || [], turnTools)
    if (Object.keys(toolPromptHints).length > 0) {
      toolContext.toolPromptHints = toolPromptHints
      emitEvent('tool_prompt_hints', {
        tools: Object.keys(toolPromptHints),
        count: Object.values(toolPromptHints).reduce((sum, hints) => sum + (Array.isArray(hints) ? hints.length : 0), 0),
      })
    }
    // thinking 不用"消息是否 trivial"的正则判定来开关 reasoning：浅层模式不该替模型决定"这题用不用想"
    // ——复合意图下会把需要 reasoning 的部分误判。是否思考由「用户在设置里的显式选择」(config.thinking) 决定，
    // 默认关闭、用户主动开启才思考；这是用户的选择，不是 runtime 按难度替它判定。
    //
    // 流式回复：onStream 把 text/think 两种模式的 token 逐块吐出。curStreamMode 跟踪当前模式
    // 让 stream_chunk 也带上 mode（前端据此区分"思考流"与"正文流"）。sawTextStream 标记本轮
    // 是否流出过正文——若是，则语音 TTS 由前端边出边逐句合成（见 onToolCall 的 autoSpeak 守卫），
    // 后端不再整段补一次 autoSpeakForVoiceReply，避免重复念。
    let curStreamMode = null
    let sawTextStream = false
    llmResult = await callLLM({
      systemPrompt,
      message: input,
      messages: llmMessages,
      tools: turnTools,
      temperature: voiceTurn ? Math.min(config.temperature, 0.35) : config.temperature,
      thinking: config.thinking === true,
      signal: controller.signal,
      toolContext,
      mustReply: !!msg?.fromId && !silentSignal,
      silentSignal,
      localReply,
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
        // callLLM 的协议兜底会用 __fallback 标记它代为投递的那次 send_message，
        // 让下方遥测能区分"模型自己发的"与"runtime 兜底发的"。该标记不进 UI 事件。
        const isFallbackDelivery = !!(args && args.__fallback)
        // __ack：耗时工具的即时回应（"我查一下…"）由 llm.js 直投后补调本回调，仅为触发语音 TTS
        // （TTS 只挂在这里）。标记需剥离，避免泄进 tool_call 事件 / toolCallLog。
        const isAckDelivery = !!(args && args.__ack)
        const cleanArgs = (isFallbackDelivery || isAckDelivery) ? { ...args } : args
        if (isFallbackDelivery) delete cleanArgs.__fallback
        if (isAckDelivery) delete cleanArgs.__ack
        // 截断策略：保证 JSON 仍可解析，否则前端格式化器会回退展示原始 JSON 文本。
        // 优先压缩 stdout/stderr/content/snippet 等长字段，再整体 stringify，而非粗暴 slice。
        const resultForEvent = truncateToolResultForUI(parsed, resultText)
        emitEvent('tool_call', { name, args: cleanArgs, result: resultForEvent, ok })
        const recognizerResultLimit = ok ? 500 : 1200
        toolCallLog.push({ name, args: cleanArgs, result: resultText.slice(0, recognizerResultLimit), ok, fallback: isFallbackDelivery, ack: isAckDelivery })
        // send_message playback is driven by executor.js via message.speak.
        // That covers explicit sends, slow acknowledgements, fallback delivery,
        // and background job completion notifications through the same frontend path.
      },
      onRetry: ({ attempt, nextAttempt, maxAttempts, delayMs, error }) => {
        emitEvent('llm_retry', { attempt, nextAttempt, maxAttempts, delayMs, error })
      },
      onToolExecute: (name) => {
        emitEvent('tool_executing', { name })
      },
      onStream: ({ event, mode, text, name }) => {
        if (event === 'start') {
          curStreamMode = mode
          if (capabilityDemoTurn && mode === 'text') return
          // plainReply：本地渠道（语音 / TUI，非社交）下正文流即用户可见回复——前端据此把正文实时
          //   打进聊天气泡（社交渠道回复在 send_message 工具参数里，正文流非回复，不实时显示）。
          // speak：语音轮才自动播报——前端据此对正文流逐句流式合成。
          emitEvent('stream_start', {
            mode,
            plainReply: mode === 'text' && localReply,
            speak: mode === 'text' && voiceTurn && !silentSignal,
          })
        } else if (event === 'chunk') {
          if (capabilityDemoTurn && curStreamMode === 'text') return
          if (curStreamMode === 'text') sawTextStream = true
          emitEvent('stream_chunk', { text, mode: curStreamMode })
        } else if (event === 'end') {
          if (capabilityDemoTurn && curStreamMode === 'text') {
            curStreamMode = null
            return
          }
          emitEvent('stream_end', { mode: curStreamMode })
        }
        else if (event === 'tool_preparing') emitEvent('tool_preparing', { name })
      },
    })
    throwIfAborted(controller.signal)
  } catch (err) {
    if (err.name === 'AbortError') {
      console.log('[system] LLM processing interrupted (new message arrived)')
      llmResult = { content: '', toolResult: null, aborted: true, delivered: false }
    } else {
      handleLLMFailure(err, label, msg)
      finishTurn()
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
  finishTurn(response)

  // User messages must not fail silently: if the model generated a response but forgot to call send_message,
  // the runtime delivers it as a fallback. **单一权威**：投递这件事现在完全由 callLLM 负责——
  //   callLLM 在 mustReply && !delivered && 有可投递文本时，直接走真正的 send_message 执行器
  //   （executeTool）代为投递，从而复用 executor 的去重 / open_question / social 派发，并把
  //   action_log 标成 source:'fallback'（不变量 #8）。投递成功后 llmResult.delivered=true。
  // 因此 index.js 不再从 toolCallLog 末项二次推导"是否已回复"，也不再手工 emit+dispatch+insert，
  //   这里只剩遥测：根据 callLLM 返回的权威 delivered 信号区分"兜底投出了"与"完全无可投递文本"。
  //   silentSignal 轮 callLLM 内部已守卫绝不投递（不变量 #1），这里也用同一守卫跳过遥测噪声。
  if (msg && msg.fromId && !silentSignal) {
    const lastToolCall = toolCallLog[toolCallLog.length - 1]
    // "模型自己发的最终回复" = 末项是 send_message 且不是 runtime 兜底打的标记。
    //   兜底投递虽然也会在 toolCallLog 留下一条 send_message（带 fallback:true），但那不算模型遵守协议。
    const modelSentExplicitly = lastToolCall?.name === 'send_message' && !lastToolCall?.fallback
    if (!modelSentExplicitly) {
      if (llmResult.delivered && localReply) {
        // 本地渠道（语音 / TUI）：纯文本直投是设计内的快路径，不是协议违规——不发 violation 遥测。
        //   callLLM 兜底已真正投递（含语音 TTS / 去重 / source:'fallback' 落库）。
        console.log(`[local reply] Plain-text reply delivered to ${msg.fromId} without send_message (fast path)`)
      } else if (llmResult.delivered) {
        // 社交渠道：模型违反了"回复=调 send_message"协议但被 runtime 兜底救回——记一条遥测便于观测违规率。
        console.warn(`[protocol fallback] Model did not call send_message — callLLM delivered the response body to ${msg.fromId}`)
        emitEvent('protocol_violation', {
          label,
          reason: 'missing_send_message_fallback_delivered',
          fromId: msg.fromId,
          content: response.slice(0, 500),
        })
      } else {
        // 既没显式 send_message，callLLM 也没能兜底投递（无可投递正文 / 被中止 等）→ 纯遥测。
        console.warn(`[protocol violation] Model did not call send_message and runtime had nothing deliverable to fall back on. from=${msg.fromId}`)
        emitEvent('protocol_violation', {
          label,
          reason: 'missing_send_message',
          fromId: msg.fromId,
          content: response.slice(0, 500),
        })
      }
    }
  }

  // 协议标记解析：单一真相源 src/runtime/markers.js（只解析，副作用留在下方原地）。
  const markers = parseMarkers(response)

  // 4. Detect [RECALL: ...]
  if (markers.recall !== null) {
    state.prev_recall = markers.recall
    console.log(`[system] Recall requested: ${state.prev_recall}`)
    emitEvent('recall_requested', { query: state.prev_recall })
  } else {
    state.prev_recall = null
  }

  // 5. Detect [UPDATE_PERSONA: ...]
  if (markers.updatePersona !== null) {
    const newPersona = markers.updatePersona.trim()
    setConfig('persona', newPersona)
    console.log('[system] Persona updated')
    emitEvent('persona_updated', { persona: newPersona.slice(0, 200) })
  }

  // 6. Detect [SET_TASK: ...] / [CLEAR_TASK]
  if (markers.setTask !== null) {
    state.task = markers.setTask.trim()
    setConfig('current_task', state.task)
    openTaskCommitment(state.task)
    console.log(`[system] Task set: ${state.task}`)
    emitEvent('task_set', { task: state.task })
  }
  if (markers.clearTask) {
    const clearedTask = state.task
    console.log(`[system] Task completed: ${clearedTask}`)
    emitEvent('task_cleared', { task: clearedTask })
    state.task = null
    state.taskIdleTickCount = 0
    setConfig('current_task', '')
    closeTaskCommitment('done')
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
    const summary = toolCallLog.map(summarizeToolCall).join(', ')
    state.recentActions.push({ ts: nowTimestamp(), summary })
    if (state.recentActions.length > 5) state.recentActions.shift()

    // 线索模型（认识论修正）：Agent 干活本身就是注意力事件——行动者直接声明，不经过归属判定。
    // touch 开放承诺的线索（没有就 touch 前台），刷新 lastEventAt。
    // 这一条消灭了专注栈时代的"干活时帧饿死"（task 模式 30s/tick × 20 = 10 分钟即失焦）。
    try {
      if (touchCommitmentThread(state, { tick: state.tickCounter || 0 })) {
        saveThreadState(state.threadState)
      }
    } catch {}
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
  const thinkMatch = response.match(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/i)
  const jarvisThink = thinkMatch ? thinkMatch[1].trim() : ''
  const jarvisText = response.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim()

  // Silent tick with no tool calls = nothing happened worth remembering; skip LLM call entirely.
  if (isTick && toolCallLog.length === 0 && !jarvisText) {
    emitEvent('memories_written', { count: 0, memories: [] })
    return
  }

  // 去抖批处理：把本轮排进识别队列，由 scheduler 决定何时合并成一次批量 recognizer 调用
  // （空闲/攒满/超时/用过耐久信息工具时 flush）。不再每轮一次 LLM 调用。
  enqueueTurnForRecognition({
    userMessage: input,
    jarvisThink,
    jarvisResponse: jarvisText,
    toolCallLog,
    task: state.task,
    sessionRef,
  })
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

  // 启动时打印恢复的线索状态，便于"重启不丢线索/承诺"的直观验证。
  {
    const ts = ensureThreadState(state)
    if (ts.threads.length > 0) {
      const fg = getForegroundThread(state)
      const open = ts.commitments.filter(c => c.status === 'open').length
      console.log(`[threads] 恢复 ${ts.threads.length} 条线索（前台：${fg ? describeThread(fg) : '无'}；开放承诺 ${open} 个）`)
    }
  }


  const persona = getConfig('persona')
  if (persona) {
    console.log(`[system] Persona loaded: ${persona.slice(0, 60)}...`)
  } else {
    console.log('[system] No persona set — waiting for Jarvis to self-define')
  }

  // Start HTTP API — must start regardless of activation status; the activation page depends on it
  const apiPort = Number(process.env.BAILONGMA_PORT) || 3721
  reportStartupProgress('api', 'running', `准备监听 127.0.0.1:${apiPort}`, '正在启动本地 API')
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
  reportStartupProgress('api', 'running', `等待 127.0.0.1:${apiPort} 就绪`, '正在等待本地 API 就绪')
  startSocialConnectors({ pushMessage, emitEvent }).catch(err => console.warn('[social] startup failed:', err.message))

  // 恢复重启前未完成的 AI 视频生成任务（继续轮询，避免面板永远卡“生成中”）
  try { resumePendingVideoJobs() } catch (err) { console.warn('[aivideo] resume failed:', err.message) }

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
