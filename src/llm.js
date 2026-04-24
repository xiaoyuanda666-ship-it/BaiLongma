import OpenAI from 'openai'
import { config } from './config.js'
import { executeTool } from './capabilities/executor.js'
import { getToolSchemas } from './capabilities/schemas.js'
import { recordUsage, shouldThrottle } from './quota.js'
import { insertActionLog } from './db.js'

// 延迟创建 OpenAI 客户端：激活流程把 key 写入 config 后再调用这里，
// 避免模块加载阶段就锁死尚未填入的 apiKey/baseURL。
let client = null
let clientKey = null
function getClient() {
  const signature = `${config.provider}|${config.baseURL}|${config.apiKey}`
  if (client && clientKey === signature) return client
  if (!config.apiKey) {
    throw new Error('LLM 尚未激活，请先通过激活页填入 API Key')
  }
  client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL })
  clientKey = signature
  return client
}

function shouldEnableDeepSeekThinking(thinking) {
  if (!thinking) return false
  if (config.model === 'deepseek-chat') return false
  return true
}

// 单次流式调用，返回 { content, toolCalls, aborted }
async function streamOnce({ messages, toolSchemas, temperature, topP, maxTokens, thinking = true, signal, onStream }) {
  const requestParams = {
    model: config.model,
    temperature,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  }

  if (typeof topP === 'number' && topP > 0) requestParams.top_p = topP
  if (config.provider === 'deepseek') {
    const thinkingEnabled = shouldEnableDeepSeekThinking(thinking)
    requestParams.reasoning_effort = 'high'
    requestParams.extra_body = {
      thinking: { type: thinkingEnabled ? 'enabled' : 'disabled' }
    }
  } else {
    if (!thinking) requestParams.thinking = { type: 'disabled' }
  }
  if (maxTokens) requestParams.max_tokens = maxTokens
  if (toolSchemas.length > 0) {
    requestParams.tools = toolSchemas
    requestParams.tool_choice = 'auto'
  }

  const stream = await getClient().chat.completions.create(requestParams, { signal })

  let fullContent = ''
  let fullReasoningContent = ''
  let toolCallsMap = {}
  let inThink = false
  let thinkDone = false
  let streamStarted = false
  let usageTokens = 0

  try {
  for await (const chunk of stream) {
    if (signal?.aborted) break
    if (chunk.usage?.total_tokens) {
      usageTokens = chunk.usage.total_tokens
    }
    const choice = chunk.choices?.[0]
    if (!choice) continue

    const delta = choice.delta

    // 工具调用增量
    if (delta?.tool_calls) {
      if (streamStarted) {
        onStream?.({ event: 'end' })
        streamStarted = false
      }
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0
        if (!toolCallsMap[idx]) {
          toolCallsMap[idx] = { id: tc.id || '', name: '', arguments: '' }
        }
        if (tc.id) toolCallsMap[idx].id = tc.id
        if (tc.function?.name) toolCallsMap[idx].name += tc.function.name
        if (tc.function?.arguments) toolCallsMap[idx].arguments += tc.function.arguments
      }
      continue
    }

    // DeepSeek reasoner 思考内容（独立字段，不在 content 里）
    const reasoningText = delta?.reasoning_content
    if (reasoningText) {
      fullReasoningContent += reasoningText
      if (!thinkDone) {
        inThink = true
        if (!streamStarted) { onStream?.({ event: 'start', mode: 'think' }); streamStarted = true }
        onStream?.({ event: 'chunk', text: reasoningText })
      }
      continue
    }

    // 文本增量
    const text = delta?.content
    if (!text) continue

    // DeepSeek：思考流结束、进入正式回答时，先关闭 think 流
    if (inThink && !thinkDone) {
      inThink = false
      thinkDone = true
      if (streamStarted) { onStream?.({ event: 'end' }); streamStarted = false }
    }

    fullContent += text

    // 解析 <think> 标签流式推送
    if (!thinkDone) {
      if (!inThink && fullContent.includes('<think>')) {
        inThink = true
        const after = fullContent.split('<think>').slice(1).join('<think>')
        if (after.length > 0) {
          if (!streamStarted) { onStream?.({ event: 'start', mode: 'think' }); streamStarted = true }
          onStream?.({ event: 'chunk', text: after })
        }
        continue
      }
      if (inThink) {
        if (fullContent.includes('</think>')) {
          inThink = false
          thinkDone = true
          const chunkBeforeEnd = text.split('</think>')[0]
          if (chunkBeforeEnd) onStream?.({ event: 'chunk', text: chunkBeforeEnd })
          onStream?.({ event: 'end' })
          streamStarted = false
          const afterThink = fullContent.split('</think>').slice(1).join('</think>').trimStart()
          if (afterThink) {
            onStream?.({ event: 'start', mode: 'text' }); streamStarted = true
            onStream?.({ event: 'chunk', text: afterThink })
          }
        } else {
          if (!streamStarted) { onStream?.({ event: 'start', mode: 'think' }); streamStarted = true }
          onStream?.({ event: 'chunk', text })
        }
        continue
      }
    }

    if (!streamStarted) { onStream?.({ event: 'start', mode: 'text' }); streamStarted = true }
    onStream?.({ event: 'chunk', text })
  }

  } catch (err) {
    if (err.name === 'AbortError' || signal?.aborted) {
      if (streamStarted) onStream?.({ event: 'end' })
      return {
        content: fullContent,
        reasoningContent: fullReasoningContent,
        toolCalls: Object.values(toolCallsMap),
        aborted: true
      }
    }
    err.hadContent = fullContent.length > 0
    if (streamStarted) onStream?.({ event: 'end' })
    throw err
  }

  if (streamStarted) onStream?.({ event: 'end' })
  if (usageTokens > 0) {
    recordUsage(usageTokens)
    console.log(`[配额] 本轮 tokens: ${usageTokens}`)
  }

  return {
    content: fullContent,
    reasoningContent: fullReasoningContent,
    toolCalls: Object.values(toolCallsMap),
    aborted: false
  }
}

// 判断是否为瞬时错误（5xx / 网络抖动 / 超时），429 交给外层 setRateLimited
function isTransientError(err) {
  const status = err.status ?? err.response?.status
  if (status && status >= 500 && status < 600) return true
  if (status === 408) return true
  const code = err.code || err.cause?.code
  if (code && ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE'].includes(code)) return true
  const msg = err.message || ''
  return /timeout|timed out|socket hang up|fetch failed|network error|upstream/i.test(msg)
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
    const timer = setTimeout(resolve, ms)
    const onAbort = () => { clearTimeout(timer); reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// 包装 streamOnce：对瞬时错误做有限次退避重试；已流出内容时不重试避免 UI 重复
async function streamOnceWithRetry(args) {
  const BACKOFFS_MS = [800, 2500]
  const MAX_ATTEMPTS = BACKOFFS_MS.length + 1
  let lastErr
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (args.signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' })
    try {
      return await streamOnce(args)
    } catch (err) {
      if (err.name === 'AbortError' || args.signal?.aborted) throw err
      if (err.hadContent) throw err
      if (!isTransientError(err)) throw err
      lastErr = err
      if (attempt < MAX_ATTEMPTS - 1) {
        const delay = BACKOFFS_MS[attempt]
        args.onRetry?.({
          attempt: attempt + 1,
          nextAttempt: attempt + 2,
          maxAttempts: MAX_ATTEMPTS,
          delayMs: delay,
          error: err.message || String(err),
        })
        console.warn(`[LLM] 瞬时错误 "${(err.message || '').slice(0, 80)}"，${delay}ms 后第 ${attempt + 2} 次尝试`)
        await abortableSleep(delay, args.signal)
      }
    }
  }
  throw lastErr
}

// XML 格式工具调用的参数名别名映射（某些模型使用不同参数名）
const PARAM_ALIASES = {
  send_message: { to: 'target_id', message: 'content', text: 'content', recipient: 'target_id' },
  read_file: { file: 'path', filename: 'path', filepath: 'path' },
  write_file: { file: 'path', filename: 'path', filepath: 'path', text: 'content', data: 'content' },
  list_dir: { directory: 'path', dir: 'path', folder: 'path' },
  make_dir: { directory: 'path', dir: 'path', folder: 'path' },
  delete_file: { file: 'path', filename: 'path' },
  exec_command: { cmd: 'command', shell: 'command', bg: 'background' },
  fetch_url: { link: 'url', href: 'url', uri: 'url' },
  search_memory: { q: 'keyword', query: 'keyword', term: 'keyword' },
}

function normalizeArgs(toolName, args) {
  const aliases = PARAM_ALIASES[toolName]
  if (!aliases) return args
  const normalized = { ...args }
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (alias in normalized && !(canonical in normalized)) {
      normalized[canonical] = normalized[alias]
      delete normalized[alias]
    }
  }
  return normalized
}

// 从文本内容中解析 XML 格式的工具调用（MiniMax 有时输出 XML 而非 JSON tool_calls）
function parseXmlToolCalls(content) {
  const calls = []
  const invokeRegex = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/g
  let match
  while ((match = invokeRegex.exec(content)) !== null) {
    const name = match[1]
    const body = match[2]
    const xmlArgs = {}
    const paramRegex = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g
    let param
    while ((param = paramRegex.exec(body)) !== null) {
      xmlArgs[param[1]] = param[2].trim()
    }
    calls.push({ id: `xml_${calls.length}`, name, arguments: JSON.stringify(xmlArgs), xmlArgs })
  }
  return calls
}

function formatToolArgPreview(args = {}) {
  return Object.entries(args)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .slice(0, 3)
    .map(([key, value]) => `${key}=${String(value).slice(0, 80)}`)
    .join(', ')
}

function summarizeToolCall(name, args = {}) {
  switch (name) {
    case 'send_message':
      return `send_message -> ${args.target_id || '(unknown)'}`
    case 'read_file':
      return `read_file(${args.path || args.filename || args.file_path || '?'})`
    case 'list_dir':
      return `list_dir(${args.path || args.dir || args.directory || '.'})`
    case 'fetch_url':
      return `fetch_url(${String(args.url || args.link || args.href || '?').slice(0, 80)})`
    case 'search_memory':
      return `search_memory(${String(args.keyword || args.query || args.q || '?').slice(0, 60)})`
    case 'write_file':
      return `write_file(${args.path || args.filename || args.file_path || '?'})`
    case 'delete_file':
      return `delete_file(${args.path || args.filename || args.file_path || '?'})`
    case 'make_dir':
      return `make_dir(${args.path || args.dir || args.directory || '?'})`
    case 'exec_command':
      return `exec_command(${String(args.command || args.cmd || '?').slice(0, 80)})`
    default: {
      const preview = formatToolArgPreview(args)
      return preview ? `${name}(${preview})` : name
    }
  }
}

function buildToolLogDetail(args = {}, result = '') {
  const argPreview = formatToolArgPreview(args)
  const resultPreview = String(result || '').replace(/\s+/g, ' ').trim().slice(0, 180)
  if (argPreview && resultPreview) return `${argPreview} | ${resultPreview}`
  return argPreview || resultPreview
}

function shouldPersistActionLog(toolName) {
  return toolName !== 'send_message'
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return
  const err = new Error(signal.reason || 'Aborted')
  err.name = 'AbortError'
  throw err
}

// 主调用：agentic 循环，连续执行工具直到模型停止
// 返回 { content: string, toolResult: { name, args, result } | null, aborted: bool }
export async function callLLM({ systemPrompt, message, temperature = 0.5, topP = 0.9, tools = [], maxTokens, thinking = true, signal, onToolCall, onStream, onRetry, toolContext = {} }) {
  const toolSchemas = getToolSchemas(tools)

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: message }
  ]

  if (shouldThrottle()) {
    console.log('[配额] 用量超过 95%，跳过本次调用')
    return { content: '（配额接近上限，等待窗口滚动）', toolResult: null, aborted: false }
  }

  let allContent = ''
  let lastToolResult = null
  const MAX_TOOL_ROUNDS = 10

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    throwIfAborted(signal)

    const { content, reasoningContent, toolCalls, aborted } = await streamOnceWithRetry({
      messages,
      toolSchemas,
      temperature,
      topP,
      maxTokens,
      thinking,
      signal,
      onRetry,
      onStream: round === 0 ? onStream : undefined,  // 只在第一轮流式推送
    })

    if (aborted) {
      if (content) allContent += (allContent ? '\n' : '') + content
      break
    }

    if (content) allContent += (allContent ? '\n' : '') + content

    // 若无 JSON 工具调用，尝试从内容中解析 XML 格式工具调用（MiniMax 备用格式）
    let effectiveToolCalls = toolCalls
    if (toolCalls.length === 0 && content) {
      const xmlCalls = parseXmlToolCalls(content)
      if (xmlCalls.length > 0) {
        console.log(`[工具调用] 检测到 XML 格式工具调用，共 ${xmlCalls.length} 个`)
        effectiveToolCalls = xmlCalls
        // 从 allContent 中去掉 XML 调用块，避免污染 response
        allContent = allContent.replace(/<invoke[\s\S]*?<\/invoke>/g, '').trim()
      }
    }

    // 无工具调用：本轮结束
    if (effectiveToolCalls.length === 0) break

    // 为没有 id 的工具调用分配 id（保证 assistant 消息与 tool 消息 id 一致）
    effectiveToolCalls.forEach((tc, i) => { if (!tc.id) tc.id = `tool_${round}_${i}` })

    // 执行所有工具调用，收集结果
    const toolResults = []
    for (const tc of effectiveToolCalls) {
      throwIfAborted(signal)
      console.log(`[工具调用] ${tc.name}`)
      let args
      try { args = JSON.parse(tc.arguments || '{}') } catch { args = {} }
      if (!tc.arguments || tc.arguments === '{}') {
        console.log(`[工具警告] ${tc.name} 参数为空`)
      }
      const normalizedArgs = normalizeArgs(tc.name, args)
      const result = await executeTool(tc.name, normalizedArgs, { ...toolContext, signal })
      throwIfAborted(signal)
      if (shouldPersistActionLog(tc.name)) {
        insertActionLog({
          timestamp: new Date().toISOString(),
          tool: tc.name,
          summary: summarizeToolCall(tc.name, normalizedArgs),
          detail: buildToolLogDetail(normalizedArgs, result),
        })
      }
      console.log(`[工具结果] ${tc.name}: ${result.slice(0, 100)}`)
      if (onToolCall) onToolCall(tc.name, args, result)
      lastToolResult = { name: tc.name, args: normalizedArgs, result }
      toolResults.push({ id: tc.id, name: tc.name, result })
    }
    throwIfAborted(signal)

    // 将本轮 assistant 消息（含工具调用）加入对话
    // 若是 XML 解析的工具调用，assistant 消息用文本形式（避免 MiniMax 不支持 tool_calls 格式回放）
    const isXmlRound = toolCalls.length === 0 && effectiveToolCalls.length > 0
    if (isXmlRound) {
      // XML 工具调用：assistant 消息为纯文本，工具结果作为 user 消息注入
      if (content) messages.push({ role: 'assistant', content })
      const resultSummary = toolResults.map(tr =>
        `[工具结果] ${tr.name}: ${tr.result.slice(0, 300)}`
      ).join('\n')
      messages.push({ role: 'user', content: `工具执行结果：\n${resultSummary}\n\n请继续完成任务。` })
    } else {
      const assistantMsg = {
        role: 'assistant',
        tool_calls: effectiveToolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments || '{}' }
        }))
      }
      if (content) assistantMsg.content = content
      if (reasoningContent) assistantMsg.reasoning_content = reasoningContent
      messages.push(assistantMsg)

      // 将工具结果加入对话
      for (const tr of toolResults) {
        messages.push({
          role: 'tool',
          tool_call_id: tr.id,
          content: String(tr.result)
        })
      }
    }
  }

  return { content: allContent, toolResult: lastToolResult, aborted: signal?.aborted ?? false }
}
