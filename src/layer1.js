import { callLLM } from './llm.js'
import { buildLayer1Prompt } from './prompt.js'
import { runInjector, formatMemoriesForPrompt } from './memory/injector.js'
import { emitEvent } from './events.js'
import { setRateLimited } from './quota.js'

// 一层思考器只允许使用信息收集类工具
const L1_TOOLS = ['read_file', 'list_dir', 'fetch_url', 'search_memory']

// 解析 L1 输出：提取 <final_reply> 或 <next_thinker> 标签
function parseL1Output(output) {
  const finalMatch = output.match(/<final_reply>([\s\S]*?)<\/final_reply>/i)
  if (finalMatch) {
    return { mode: 'final_reply', content: finalMatch[1].trim() }
  }
  const nextMatch = output.match(/<next_thinker>([\s\S]*?)<\/next_thinker>/i)
  if (nextMatch) {
    return { mode: 'next_thinker', content: nextMatch[1].trim() }
  }
  // 格式不合规：降级为 next_thinker，把原始输出当作 hint 传下去
  console.warn('[L1] 输出格式不合规，降级为 next_thinker')
  return { mode: 'next_thinker', content: output.replace(/<think>[\s\S]*?<\/think>/gi, '').trim().slice(0, 200) }
}

export async function runLayer1({ input, state, sessionRef, signal }) {
  emitEvent('layer1_start', { input: input.slice(0, 200) })

  // 1. 注入器：为一层思考器准备记忆和方向
  const injection = await runInjector({ message: input, state })
  const memoriesText = formatMemoriesForPrompt(injection.memories, injection.recallMemories)
  const directionsText = injection.directions.join('\n')

  // 更新念头栈
  if (injection.thought) {
    state.thoughtStack.push(injection.thought)
    if (state.thoughtStack.length > 3) state.thoughtStack.shift()
  }

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

  // 2. 构建一层思考器提示词
  const systemPrompt = buildLayer1Prompt({
    memories: memoriesText,
    directions: directionsText,
    constraints: injection.constraints || [],
    task: state.task || null,
    conversationWindow: injection.conversationWindow || [],
    personMemory: injection.personMemory || null,
    actionLog: injection.actionLog || [],
  })

  emitEvent('layer1_prompt', { content: systemPrompt })

  // 3. 调用 LLM（仅信息收集工具）
  const toolCallLog = []
  let result

  try {
    result = await callLLM({
      systemPrompt,
      message: input,
      tools: L1_TOOLS,
      temperature: 0.1,
      signal,
      onToolCall: (name, args, res) => {
        emitEvent('layer1_tool', { name, args, result: String(res).slice(0, 500) })
        toolCallLog.push({ name, args, result: String(res).slice(0, 500) })
      },
      onStream: ({ event, text }) => {
        if (event === 'start') emitEvent('layer1_stream_start', {})
        else if (event === 'chunk') emitEvent('layer1_chunk', { text })
        else if (event === 'end') emitEvent('layer1_stream_end', {})
      },
    })
  } catch (err) {
    if (err.name === 'AbortError') {
      return { mode: 'next_thinker', content: '', toolCallLog, injection, rawOutput: '', aborted: true }
    }
    if (err.message?.includes('429') || err.status === 429) setRateLimited()
    throw err
  }

  const rawOutput = result.content
  emitEvent('layer1_done', { content: rawOutput.slice(0, 1000) })

  // 4. 解析输出模式
  const parsed = parseL1Output(rawOutput)
  console.log(`[L1] 模式：${parsed.mode} | 内容：${parsed.content.slice(0, 80)}`)
  emitEvent('layer1_result', { mode: parsed.mode, content: parsed.content })

  // 5. 检测 RECALL 请求（从 think 块或原始输出）
  const recallMatch = rawOutput.match(/\[RECALL:\s*(.+?)\]/i)
  if (recallMatch) {
    state.prev_recall = recallMatch[1]
    emitEvent('recall_requested', { query: state.prev_recall, layer: 1 })
  }

  return {
    mode: parsed.mode,       // 'final_reply' | 'next_thinker'
    content: parsed.content, // 回复内容 或 传给 L2 的 hint
    rawOutput,
    toolCallLog,
    injection,
    aborted: false,
  }
}
