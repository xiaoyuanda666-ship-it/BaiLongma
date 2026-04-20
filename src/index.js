import { config } from './config.js'
import { callLLM } from './llm.js'
import { buildSystemPrompt } from './prompt.js'
import { runRecognizer } from './memory/recognizer.js'
import { runInjector, formatMemoriesForPrompt, formatTaskKnowledge } from './memory/injector.js'
import { gatherContext, formatExtraContext } from './context/gatherer.js'
import { getDB, getConfig, setConfig, getKnownEntities, getOrInitBirthTime, insertConversation, insertMemory, getRecentConversationPartners, getDueReminders, markReminderFired, getNextPendingReminder } from './db.js'
import { popMessage, hasMessages, setInterruptCallback, requeueMessage, pushMessage } from './queue.js'
import { startTUI } from './tui.js'
import { startAPI } from './api.js'
import { emitEvent } from './events.js'
import { formatTick, nowTimestamp, describeExistence } from './time.js'
import { getAdaptiveTickInterval, getQuotaStatus, setRateLimited, isRateLimited, getTickInterval } from './quota.js'
import { registerProvider } from './providers/registry.js'
import { MinimaxProvider } from './providers/minimax.js'
import { isRunning, setScheduler } from './control.js'
import { getCustomIntervalMs, consumeTick as consumeTickerTick, getStatus as getTickerStatus } from './ticker.js'

// 当前 LLM 处理的 AbortController（主循环打断用）
let currentAbortController = null

// 初始化数据库
getDB()
const birthTime = getOrInitBirthTime()

// 从数据库恢复持久化任务（重启后不丢失）
const persistedTask = getConfig('current_task')
if (persistedTask) {
  console.log(`[系统] 恢复进行中的任务：${persistedTask.slice(0, 80)}`)
}

// 注册 Provider（多媒体能力用 MiniMax，独立于 LLM 选择）
// 本文件下方的 `function process(...)` 会遮蔽全局 process，所以用 globalThis.process 访问环境变量。
const MINIMAX_API_KEY_ENV = globalThis.process.env.MINIMAX_API_KEY
if (MINIMAX_API_KEY_ENV) {
  registerProvider(new MinimaxProvider({ apiKey: MINIMAX_API_KEY_ENV }))
}
console.log(`[LLM] 使用 ${config.provider}（模型: ${config.model}）`)

// 运行状态
const state = {
  action: null,
  task: persistedTask || null,
  prev_recall: null,
  lastToolResult: null, // 上一轮工具调用结果，下一个 TICK 由注入器注入后清空
  sessionCounter: 0,
  recentActions: [], // 最近几轮的行动摘要，格式：{ ts, summary }
  thoughtStack: [],  // 念头栈，最多保留 3 个，格式：{ concept, line }
}

function newSessionRef() {
  state.sessionCounter++
  return `session_${Date.now()}_${state.sessionCounter}`
}

export function buildToolContext({ currentTargetId = null, conversationWindow = [], includeRecentPartners = false } = {}) {
  const visibleTargetIds = [
    currentTargetId,
    ...conversationWindow.flatMap(item => [item.from_id, item.to_id]),
  ].filter(id => id && id !== 'jarvis')

  // TICK 场景：补充"最近 24h 有过双向对话的熟人"，让意识体可主动联系已建立连接的对象
  if (includeRecentPartners && !currentTargetId) {
    visibleTargetIds.push(...getRecentConversationPartners(24, 20))
  }

  const unique = [...new Set(visibleTargetIds.filter(Boolean))]
  return { allowedTargetIds: unique, visibleTargetIds: unique }
}

function buildToolContextForProcess(msg, injection) {
  return buildToolContext({
    currentTargetId: msg?.reminderTargetId || msg?.fromId || null,
    conversationWindow: injection.conversationWindow || [],
    includeRecentPartners: true,
  })
}

const MAX_MESSAGE_RETRIES = 3

function enqueueDueReminders() {
  const now = new Date().toISOString()
  const dueReminders = getDueReminders(now, 20)
  for (const reminder of dueReminders) {
    const marked = markReminderFired(reminder.id, now)
    if (!marked.changes) continue
    pushMessage('SYSTEM', reminder.system_message, 'REMINDER', {
      reminderTargetId: reminder.user_id,
      reminderId: reminder.id,
    })
    emitEvent('reminder_fired', {
      id: reminder.id,
      user_id: reminder.user_id,
      due_at: reminder.due_at,
      task: reminder.task,
    })
  }
}

// LLM 失败后的通用处理：429 设限流，消息重入队列，超限放弃
function handleLLMFailure(err, label, msg) {
  console.error('LLM 调用失败:', err.message)
  if (err.message?.includes('429') || err.status === 429) setRateLimited()
  emitEvent('error', { label, error: err.message })
  if (msg) {
    const nextRetry = (msg.retryCount || 0) + 1
    if (nextRetry <= MAX_MESSAGE_RETRIES) {
      console.log(`[系统] 消息重入队列（第 ${nextRetry}/${MAX_MESSAGE_RETRIES} 次重试）`)
      emitEvent('message_requeued', { fromId: msg.fromId, retryCount: nextRetry, error: err.message })
      requeueMessage(msg, nextRetry)
    } else {
      console.error(`[系统] 消息重试 ${MAX_MESSAGE_RETRIES} 次仍失败，放弃：${msg.content?.slice(0, 60)}`)
      emitEvent('message_dropped', { fromId: msg.fromId, retryCount: nextRetry - 1, reason: err.message })
    }
  }
}

async function process(input, label, msg = null) {
  const sessionRef = newSessionRef()
  const isTick = !msg

  console.log(`\n── ${label} ──`)
  emitEvent(isTick ? 'tick' : 'message_received', { label, input: input.slice(0, 300) })

  // 用户消息已在 pushMessage 阶段写入 conversations（到达即入聊天记录），此处不再重复写。

  currentAbortController = new AbortController()

  // 1. 注入器
  const injection = await runInjector({ message: input, state })
  const memoriesText = formatMemoriesForPrompt(injection.memories, injection.recallMemories)
  const directionsText = injection.directions.join('\n')
  const taskKnowledgeText = formatTaskKnowledge(injection.taskKnowledge)

  // 任务活跃时：运行上下文充分性采集循环
  let extraContextText = ''
  if (state.task) {
    const extraContext = await gatherContext({
      task: state.task,
      taskKnowledge: taskKnowledgeText,
      memories: memoriesText,
      message: input,
    })
    extraContextText = formatExtraContext(extraContext)
    if (extraContext.length > 0) {
      console.log(`[采集器] 补充了 ${extraContext.length} 项上下文`)
      emitEvent('context_gathered', { count: extraContext.length, items: extraContext.map(c => c.label) })
    }
  }

  // 发出注入器结果事件（供 brain.html 展示）
  emitEvent('injector_result', {
    directions: injection.directions,
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
  })

  // 更新念头栈
  if (injection.thought) {
    state.thoughtStack.push(injection.thought)
    if (state.thoughtStack.length > 3) state.thoughtStack.shift()
  }

  // 2. 组装系统提示词
  const persona = getConfig('persona') || ''
  const agentName = getConfig('agent_name') || 'Longma'
  const entities = getKnownEntities()
  const hasActiveTask = !!state.task
  const systemPrompt = buildSystemPrompt({
    agentName,
    persona,
    memories: memoriesText,
    directions: directionsText,
    constraints: injection.constraints || [],
    conversationWindow: injection.conversationWindow || [],
    personMemory: injection.personMemory || null,
    thoughtStack: state.thoughtStack,
    entities,
    recentActions: state.recentActions,
    actionLog: injection.actionLog || [],
    hasActiveTask,
    task: state.task || null,
    taskKnowledge: taskKnowledgeText,
    extraContext: extraContextText,
    lastToolResult: injection.lastToolResult || null,
    existenceDesc: describeExistence(birthTime),
  })

  // 发出完整系统提示词事件
  emitEvent('system_prompt', { content: systemPrompt })

  // 3. 调用 Jarvis LLM（可被新消息打断）
  const toolCallLog = []
  let llmResult
  const toolContext = buildToolContextForProcess(msg, injection)
  try {
    llmResult = await callLLM({
      systemPrompt,
      message: input,
      tools: injection.tools || ['send_message'],
      maxTokens: undefined,
      signal: currentAbortController.signal,
      toolContext,
      onToolCall: (name, args, result) => {
        emitEvent('tool_call', { name, args, result: String(result).slice(0, 1000) })
        toolCallLog.push({ name, args, result: String(result).slice(0, 500) })
        // 记录 Jarvis 发出的消息
        if (name === 'send_message' && args?.target_id && args?.content) {
          insertConversation({
            role: 'jarvis',
            from_id: 'jarvis',
            to_id: args.target_id,
            content: args.content,
            timestamp: nowTimestamp(),
          })
        }
      },
      onRetry: ({ attempt, nextAttempt, maxAttempts, delayMs, error }) => {
        emitEvent('llm_retry', { attempt, nextAttempt, maxAttempts, delayMs, error })
      },
      onStream: ({ event, mode, text }) => {
        if (event === 'start') emitEvent('stream_start', { mode })
        else if (event === 'chunk') emitEvent('stream_chunk', { text })
        else if (event === 'end') emitEvent('stream_end', {})
      },
    })
  } catch (err) {
    if (err.name === 'AbortError') {
      console.log('[系统] LLM 处理被打断（新消息到达）')
      llmResult = { content: '', toolResult: null, aborted: true }
    } else {
      currentAbortController = null
      handleLLMFailure(err, label, msg)
      return
    }
  } finally {
    currentAbortController = null
  }

  if (llmResult.aborted) {
    // 微信式打断：丢弃半成品，下轮处理最新消息时从 conversationWindow 自然读到本条上下文。
    console.log('[系统] 当前处理被新消息打断，丢弃半成品')
    return
  }

  const response = llmResult.content

  // 存储工具结果供下一个 TICK 注入
  state.lastToolResult = llmResult.toolResult || null

  console.log('\nJarvis:', response)
  emitEvent('response', { sessionRef, label, content: response })

  // 收紧约束：回复他者时只有真实 send_message 工具调用才算已发出消息，不再做文本标签救援。
  if (msg && msg.fromId && !toolCallLog.some(t => t.name === 'send_message')) {
    console.warn(`[协议违规] 模型未调用 send_message，回复不会发出。from=${msg.fromId}`)
    emitEvent('protocol_violation', {
      label,
      reason: 'missing_send_message',
      fromId: msg.fromId,
      content: response.slice(0, 500),
    })
  }

  // 4. 检测 [RECALL: ...]
  const recallMatch = response.match(/\[RECALL:\s*(.+?)\]/)
  if (recallMatch) {
    state.prev_recall = recallMatch[1]
    console.log(`[系统] 回忆请求：${state.prev_recall}`)
    emitEvent('recall_requested', { query: state.prev_recall })
  } else {
    state.prev_recall = null
  }

  // 5. 检测 [UPDATE_PERSONA: ...]
  const personaMatch = response.match(/\[UPDATE_PERSONA:\s*([\s\S]+?)\]/)
  if (personaMatch) {
    const newPersona = personaMatch[1].trim()
    setConfig('persona', newPersona)
    console.log(`[系统] 人格已更新`)
    emitEvent('persona_updated', { persona: newPersona.slice(0, 200) })
  }

  // 6. 检测 [SET_TASK: ...] / [CLEAR_TASK]
  const setTaskMatch = response.match(/\[SET_TASK:\s*([\s\S]+?)\]/)
  if (setTaskMatch) {
    state.task = setTaskMatch[1].trim()
    setConfig('current_task', state.task)
    console.log(`[系统] 任务设置：${state.task}`)
    emitEvent('task_set', { task: state.task })
  }
  if (/\[CLEAR_TASK\]/.test(response)) {
    const clearedTask = state.task
    console.log(`[系统] 任务完成：${clearedTask}`)
    emitEvent('task_cleared', { task: clearedTask })
    state.task = null
    setConfig('current_task', '')
    // 写入 task_complete 记忆，防止后续注入时旧任务记忆让 Jarvis 误以为任务仍在进行
    if (clearedTask) {
      insertMemory({
        event_type: 'task_complete',
        content: `任务已完成：${clearedTask.slice(0, 60)}`,
        detail: '任务已通过 [CLEAR_TASK] 标记为完成，不再继续执行',
        entities: [], concepts: [], tags: ['task_complete'],
        timestamp: nowTimestamp(),
      })
    }
  }

  // 更新最近行动记录（保留最近 5 条）
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

  // 6. 识别器：分离 think 块和正文，传入完整经历
  //    后台运行，不阻塞下一轮消息/TICK 处理
  const thinkMatch = response.match(/<think>([\s\S]*?)<\/think>/i)
  const jarvisThink = thinkMatch ? thinkMatch[1].trim() : ''
  const jarvisText = response.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
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
    console.error('[识别器] 后台运行失败:', err)
  })
}

let processing = false
let currentTimer = null  // 当前 pending 的下一轮 timer，pushMessage 时可清掉以立即执行

async function onTick() {
  if (processing) return
  processing = true

  try {
    enqueueDueReminders()
    if (hasMessages()) {
      const msg = popMessage()
      await process(msg.raw, `L1 消息 from ${msg.fromId}`, msg)
    } else {
      const tick = formatTick()
      await process(tick, 'L2 TICK')
    }
  } finally {
    processing = false
    // 消耗一轮自定义节奏 TTL（到期自动回归默认）
    consumeTickerTick()
  }
}

// 调度优先级（从高到低）：
//   1. 有消息待处理 → 0
//   2. 429 rate-limited → quota 的 10 分钟
//   3. L2 自定义节奏（ttl > 0）→ L2 指定值
//   4. 有任务 → 30s
//   5. 空闲 → config.tickInterval
function scheduleNextTick() {
  if (!isRunning()) return
  if (currentTimer) { clearTimeout(currentTimer); currentTimer = null }

  enqueueDueReminders()

  const hasPending = hasMessages()
  const rateLimited = isRateLimited()
  const customMs = getCustomIntervalMs()
  const taskActive = !!state.task
  const nextReminder = getNextPendingReminder()

  let interval
  let label
  if (hasPending) {
    interval = 0
    label = '立即（消息待处理）'
  } else if (rateLimited) {
    interval = getTickInterval(config.tickInterval)
    label = `限流中（${interval / 1000}s）`
  } else if (customMs !== null) {
    const ticker = getTickerStatus()
    interval = customMs
    label = `L2 自定义 ${interval / 1000}s（剩 ${ticker.ttl} 轮${ticker.reason ? ' · ' + ticker.reason : ''}）`
  } else if (taskActive) {
    interval = 30000
    label = '任务模式 30s'
  } else {
    interval = config.tickInterval
    label = `${interval / 1000}s`
  }

  if (nextReminder) {
    const dueInMs = Math.max(0, new Date(nextReminder.due_at).getTime() - Date.now())
    if (dueInMs < interval) {
      interval = dueInMs
      label = `提醒触发 ${Math.ceil(dueInMs / 1000)}s`
    }
  }

  const quota = getQuotaStatus()
  console.log(`[配额] ${quota.rpmUsed} RPM | ${quota.tpmUsed} TPM | 占用 ${quota.ratio} | 下次 Tick ${label}`)
  emitEvent('quota', { ...quota, nextTickMs: interval, ticker: getTickerStatus() })
  currentTimer = setTimeout(async () => {
    currentTimer = null
    await onTick()
    scheduleNextTick()
  }, interval)
}

// 新消息到达时调用：清掉当前 pending timer，立即跑下一轮
// 如果当前正在 processing，则依赖 abort 机制让它快速结束，finally 后 scheduleNextTick 会用 interval=0 立即续跑
function triggerImmediateTick() {
  if (processing) return  // 由 abort + 结束后的 scheduleNextTick 接力
  if (!isRunning()) return
  if (currentTimer) { clearTimeout(currentTimer); currentTimer = null }
  // 异步启动一轮，不等结果
  ;(async () => {
    await onTick()
    scheduleNextTick()
  })()
}

async function main() {
  console.log('Jarvis 启动中...')

  const persona = getConfig('persona')
  if (persona) {
    console.log(`[系统] 已加载人格：${persona.slice(0, 60)}...`)
  } else {
    console.log('[系统] 人格未设置，等待 Jarvis 自我定义')
  }

  // 启动 HTTP API
  startAPI(3721)

  // 启动 TUI
  startTUI('ID:000001')

  console.log('输入消息后按回车发送给 Jarvis\n')

  // 注册调度函数，供控制层（stop/start）唤起
  setScheduler(scheduleNextTick)

  // 注册打断回调：新消息到达时打断当前 LLM 处理 + 立即触发下一轮（不等定时器）
  setInterruptCallback(() => {
    if (currentAbortController) {
      console.log('[系统] 新消息到达，打断当前处理')
      currentAbortController.abort()
    }
    triggerImmediateTick()
  })

  // 首次立即运行，之后自适应调度
  await onTick()
  scheduleNextTick()
}

main()
