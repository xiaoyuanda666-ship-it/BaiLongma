import { config } from './config.js'
import { callLLM } from './llm.js'
import { buildSystemPrompt } from './prompt.js'
import { runRecognizer } from './memory/recognizer.js'
import { runInjector, formatMemoriesForPrompt, formatTaskKnowledge } from './memory/injector.js'
import { gatherContext, formatExtraContext } from './context/gatherer.js'
import { getDB, getConfig, setConfig, getKnownEntities, getOrInitBirthTime, insertConversation, insertMemory } from './db.js'
import { popMessage, hasMessages, setInterruptCallback } from './queue.js'
import { startTUI } from './tui.js'
import { startAPI } from './api.js'
import { emitEvent } from './events.js'
import { formatTick, nowTimestamp, describeExistence } from './time.js'
import { getAdaptiveTickInterval, getQuotaStatus, setRateLimited } from './quota.js'
import { registerProvider } from './providers/registry.js'
import { MinimaxProvider } from './providers/minimax.js'
import { isRunning, setScheduler } from './control.js'

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

// 注册 Provider
if (config.apiKey) {
  registerProvider(new MinimaxProvider({ apiKey: config.apiKey }))
}

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

async function process(input, label) {
  const sessionRef = newSessionRef()
  const isTick = label === 'TICK' || label.startsWith('TICK ')

  console.log(`\n── ${label} ──`)
  emitEvent(isTick ? 'tick' : 'message_received', { label, input: input.slice(0, 300) })

  // 记录用户消息（非 TICK）
  if (!isTick) {
    const fromMatch = label.match(/消息 from (.+)/)
    const fromId = fromMatch ? fromMatch[1] : 'unknown'
    insertConversation({ role: 'user', from_id: fromId, content: input, timestamp: nowTimestamp() })
  }

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
      event_type: m.event_type || '',
      content: m.content || '',
      detail: m.detail || '',
    })),
    recallMemories: (injection.recallMemories || []).map(m => ({
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

  // 更新念头栈（新念头入栈，超过3个时出栈）
  if (injection.thought) {
    state.thoughtStack.push(injection.thought)
    if (state.thoughtStack.length > 3) state.thoughtStack.shift()
  }

  // 2. 组装系统提示词
  const persona = getConfig('persona') || ''
  const entities = getKnownEntities()
  const hasActiveTask = !!state.task
  const systemPrompt = buildSystemPrompt({
    persona,
    memories: memoriesText,
    directions: directionsText,
    constraints: injection.constraints || [],
    conversationWindow: injection.conversationWindow || [],
    personMemory: injection.personMemory || null,
    thoughtStack: state.thoughtStack,
    entities,
    recentActions: state.recentActions,
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
  currentAbortController = new AbortController()
  try {
    llmResult = await callLLM({
      systemPrompt,
      message: input,
      tools: injection.tools || ['send_message'],
      maxTokens: undefined,
      signal: currentAbortController.signal,
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
      onStream: ({ event, mode, text }) => {
        if (event === 'start') emitEvent('stream_start', { mode })
        else if (event === 'chunk') emitEvent('stream_chunk', { text })
        else if (event === 'end') emitEvent('stream_end', {})
      },
    })
  } catch (err) {
    if (err.name === 'AbortError') {
      console.log('[系统] LLM 处理被打断（新消息到达）')
      // 仍需运行识别器，将部分结果存入记忆
      llmResult = { content: '', toolResult: null, aborted: true }
    } else {
      console.error('LLM 调用失败:', err.message)
      if (err.message?.includes('429') || err.status === 429) {
        setRateLimited()
      }
      emitEvent('error', { label, error: err.message })
      currentAbortController = null
      return
    }
  } finally {
    currentAbortController = null
  }

  if (llmResult.aborted) {
    console.log('[系统] 已打断，跳过本轮响应处理，直接进入识别器')
    // 仅运行识别器（保存已发生的工具调用记录），然后退出
    await runRecognizer({
      userMessage: input,
      jarvisThink: '',
      jarvisResponse: llmResult.content || '',
      toolCallLog,
      task: state.task,
      sessionRef,
    })
    return
  }

  const response = llmResult.content

  // 存储工具结果供下一个 TICK 注入
  state.lastToolResult = llmResult.toolResult || null

  console.log('\nJarvis:', response)
  emitEvent('response', { sessionRef, label, content: response })

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
  const thinkMatch = response.match(/<think>([\s\S]*?)<\/think>/i)
  const jarvisThink = thinkMatch ? thinkMatch[1].trim() : ''
  const jarvisText = response.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const memories = await runRecognizer({
    userMessage: input,
    jarvisThink,
    jarvisResponse: jarvisText,
    toolCallLog,
    task: state.task,
    sessionRef,
  })
  emitEvent('memories_written', { count: memories?.length || 0, memories: memories || [] })
}

let processing = false

async function onTick() {
  if (processing) return
  processing = true

  try {
    if (hasMessages()) {
      const msg = popMessage()
      await process(msg.raw, `消息 from ${msg.fromId}`)
    } else {
      const tick = formatTick()
      await process(tick, 'TICK')
    }
  } finally {
    processing = false
  }
}

// 自适应调度：有消息时立即处理，有任务时 2s，其他按配额自适应
function scheduleNextTick() {
  if (!isRunning()) return
  const hasPending = hasMessages()
  const taskActive = !!state.task
  const interval = hasPending ? 0 : (taskActive ? 2000 : getAdaptiveTickInterval(config.tickInterval))
  const quota = getQuotaStatus()
  const label = hasPending ? '立即（消息待处理）' : (taskActive ? `任务模式 2s` : `${interval / 1000}s`)
  console.log(`[配额] ${quota.rpmUsed} RPM | ${quota.tpmUsed} TPM | 占用 ${quota.ratio} | 下次 Tick ${label}`)
  emitEvent('quota', { ...quota, nextTickMs: interval })
  setTimeout(async () => {
    await onTick()
    scheduleNextTick()
  }, interval)
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

  // 注册打断回调：新消息到达时打断当前 LLM 处理
  setInterruptCallback(() => {
    if (currentAbortController) {
      console.log('[系统] 新消息到达，打断当前处理')
      currentAbortController.abort()
    }
  })

  // 首次立即运行，之后自适应调度
  await onTick()
  scheduleNextTick()
}

main()
