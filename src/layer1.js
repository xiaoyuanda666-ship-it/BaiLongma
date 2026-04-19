import { callLLM } from './llm.js'
import { buildLayer1Prompt } from './prompt.js'
import { runInjector, formatMemoriesForPrompt } from './memory/injector.js'
import { emitEvent } from './events.js'
import { setRateLimited } from './quota.js'
import { getMemoryByMemId, insertConversation } from './db.js'
import { nowTimestamp } from './time.js'

// 身份记忆的语义 ID（与 seed-memories.js 中 my_definition 对齐）
const IDENTITY_MEM_ID = 'my_definition'

// 一层思考器：信息收集 + 直接回复（与 L2 统一通过 send_message 工具发消息）
const L1_TOOLS = ['read_file', 'list_dir', 'fetch_url', 'search_memory', 'send_message', 'exec_command']

// 解析 L1 输出：是否调用了 send_message 决定走 l1_reply 还是 next_thinker
function parseL1Output(rawOutput, sentMessages) {
  if (sentMessages.length > 0) {
    return { mode: 'l1_reply', content: sentMessages.map(m => m.content).join('\n') }
  }
  const nextMatch = rawOutput.match(/<next_thinker>([\s\S]*?)<\/next_thinker>/i)
  if (nextMatch) {
    return { mode: 'next_thinker', content: nextMatch[1].trim() }
  }
  // 兜底：未调工具也未给出 next_thinker —— 把原文（去 think 块）截短作为 hint
  console.warn('[L1] 输出格式不合规，降级为 next_thinker')
  return {
    mode: 'next_thinker',
    content: rawOutput.replace(/<think>[\s\S]*?<\/think>/gi, '').trim().slice(0, 200),
  }
}

export async function runLayer1({ input, state, sessionRef, signal, toolContext = {} }) {
  emitEvent('layer1_start', { input: input.slice(0, 200) })

  // 1. 注入器：为一层思考器准备记忆和方向
  // 注意：念头栈的更新由调用方（process）负责，避免 L1+L2 双推
  const injection = await runInjector({ message: input, state })

  // 用 injection 的 conversationWindow 扩展 toolContext 的可见目标列表
  const conversationIds = (injection.conversationWindow || [])
    .flatMap(m => [m.from_id, m.to_id])
    .filter(id => id && id !== 'jarvis')
  const enrichedIds = [...new Set([...(toolContext.allowedTargetIds || []), ...conversationIds])]
  const enrichedToolContext = { allowedTargetIds: enrichedIds, visibleTargetIds: enrichedIds }
  const memoriesText = formatMemoriesForPrompt(injection.memories, injection.recallMemories)
  const directionsText = injection.directions.join('\n')

  emitEvent('layer1_injector_result', {
    directions: injection.directions,
    matchedMemories: (injection.memories || []).map(m => ({
      id: m.id,
      mem_id: m.mem_id || '',
      event_type: m.event_type || '',
      title: m.title || '',
      content: m.content || '',
    })),
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
    thought: injection.thought || null,
  })

  // 2. 构建一层思考器提示词（身份从记忆库读取，允许 Agent 后期自改）
  const identityMem = getMemoryByMemId(IDENTITY_MEM_ID)
  const identity = identityMem?.content || ''
  const systemPrompt = buildLayer1Prompt({
    identity,
    memories: memoriesText,
    directions: directionsText,
    constraints: injection.constraints || [],
    task: state.task || null,
    conversationWindow: injection.conversationWindow || [],
    personMemory: injection.personMemory || null,
    actionLog: injection.actionLog || [],
  })

  emitEvent('layer1_prompt', { content: systemPrompt })

  // 3. 调用 LLM（信息收集工具 + send_message）
  const toolCallLog = []
  const sentMessages = []
  let result

  try {
    result = await callLLM({
      systemPrompt,
      message: input,
      tools: L1_TOOLS,
      temperature: 0,
      signal,
      toolContext: enrichedToolContext,
      onToolCall: (name, args, res) => {
        const resStr = String(res)
        emitEvent('layer1_tool', { name, args, result: resStr.slice(0, 500) })
        toolCallLog.push({ name, args, result: resStr.slice(0, 500) })
        if (name === 'send_message' && args?.target_id && args?.content && resStr.startsWith('消息已发送')) {
          const ts = nowTimestamp()
          insertConversation({
            role: 'jarvis',
            from_id: 'jarvis',
            to_id: args.target_id,
            content: args.content,
            timestamp: ts,
          })
          sentMessages.push({ targetId: args.target_id, content: args.content, ts })
        }
      },
      onStream: ({ event, text }) => {
        if (event === 'start') emitEvent('layer1_stream_start', {})
        else if (event === 'chunk') emitEvent('layer1_chunk', { text })
        else if (event === 'end') emitEvent('layer1_stream_end', {})
      },
    })
  } catch (err) {
    if (err.name === 'AbortError') {
      return { mode: 'next_thinker', content: '', toolCallLog, injection, rawOutput: '', sentMessages, aborted: true }
    }
    if (err.message?.includes('429') || err.status === 429) setRateLimited()
    throw err
  }

  const rawOutput = result.content
  emitEvent('layer1_done', { content: rawOutput.slice(0, 1000) })

  // 4. 解析输出模式（基于是否调用了 send_message）
  const parsed = parseL1Output(rawOutput, sentMessages)
  console.log(`[L1] 模式：${parsed.mode} | 内容：${parsed.content.slice(0, 80)}`)
  emitEvent('layer1_result', { mode: parsed.mode, content: parsed.content })

  // 5. 检测 RECALL 请求（从 think 块或原始输出）
  const recallMatch = rawOutput.match(/\[RECALL:\s*(.+?)\]/i)
  if (recallMatch) {
    state.prev_recall = recallMatch[1]
    emitEvent('recall_requested', { query: state.prev_recall, layer: 1 })
  }

  return {
    mode: parsed.mode,       // 'l1_reply' | 'next_thinker'
    content: parsed.content, // 回复内容 或 传给 L2 的 hint
    rawOutput,
    toolCallLog,
    injection,
    sentMessages,
    aborted: false,
  }
}
