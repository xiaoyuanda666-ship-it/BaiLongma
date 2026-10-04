// Chat Completions wire-format helpers. The agent loop owns tool execution;
// this module owns request fields, streamed deltas, and assistant/tool replay.

const CHAT_PROTOCOL = 'chat-completions'

function clone(value) {
  return structuredClone(value)
}

export function toChatCompletionsMessages(messages = []) {
  const result = []
  for (const original of Array.isArray(messages) ? messages : []) {
    if (!original || typeof original !== 'object') continue
    if (original.type || Array.isArray(original._response_output_items)) {
      throw new Error('Cannot replay Responses output Items through Chat Completions')
    }
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(original.role)) continue
    const message = { role: original.role, content: clone(original.content ?? null) }
    if (original.name) message.name = original.name
    if (original.role === 'tool') {
      if (!original.tool_call_id) throw new Error('Chat Completions tool result is missing tool_call_id')
      message.tool_call_id = original.tool_call_id
    }
    if (original.role === 'assistant') {
      if (Array.isArray(original.tool_calls) && original.tool_calls.length > 0) {
        message.tool_calls = original.tool_calls.map(call => ({
          id: call.id,
          type: 'function',
          function: { name: call.function?.name || '', arguments: call.function?.arguments || '' },
        }))
      }
      // Replay an extension only when the server actually supplied it. This
      // also supports custom gateways forwarding models such as DeepSeek.
      if (typeof original.reasoning_content === 'string') {
        message.reasoning_content = original.reasoning_content
      }
    }
    result.push(message)
  }
  return result
}

export function buildChatCompletionsRequest({
  provider = '', model, messages = [], toolSchemas = [], temperature, topP,
  maxTokens, omitSampling = false, stream = true,
} = {}) {
  const request = { model, messages: toChatCompletionsMessages(messages), stream }
  const isOpenAI = String(provider || '').toLowerCase() === 'openai'
  if (!omitSampling && typeof temperature === 'number') request.temperature = temperature
  if (!omitSampling && typeof topP === 'number' && topP > 0) request.top_p = topP
  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    request[isOpenAI ? 'max_completion_tokens' : 'max_tokens'] = maxTokens
  }
  // Optional fields are provider-gated; generic compatible servers need only
  // the common Chat request shape. Reasoning controls vary by model/provider.
  if (isOpenAI) {
    request.store = false
    if (stream) request.stream_options = { include_usage: true }
  }
  const tools = (Array.isArray(toolSchemas) ? toolSchemas : [])
    .filter(schema => schema?.type === 'function' && schema.function?.name)
    .map(schema => clone(schema))
  if (tools.length > 0) {
    request.tools = tools
    request.tool_choice = 'auto'
  }
  return request
}

function normalizeUsage(usage = {}) {
  const inputTokens = Number(usage.prompt_tokens) || 0
  const outputTokens = Number(usage.completion_tokens) || 0
  return {
    totalTokens: Number(usage.total_tokens) || inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    cachedTokens: Number(usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens) || 0,
    reasoningTokens: Number(usage.completion_tokens_details?.reasoning_tokens) || 0,
  }
}

export function chatCompletionsHistoryEntries(result = {}) {
  if (result.replay) {
    if (result.replay.protocol !== CHAT_PROTOCOL) throw new Error('Chat Completions replay protocol mismatch')
    if (Array.isArray(result.replay.entries) && result.replay.entries.length) return clone(result.replay.entries)
  }
  const calls = Array.isArray(result.toolCalls) ? result.toolCalls : []
  if (!result.content && calls.length === 0) return []
  const message = { role: 'assistant', content: result.content || null }
  if (calls.length > 0) {
    message.tool_calls = calls.map(call => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }))
  }
  return [message]
}

export function createChatCompletionsAccumulator({
  onTextDelta, onReasoningDelta, onFunctionCallStarted, onFunctionArgumentsDelta,
} = {}) {
  let content = ''
  let reasoningContent = ''
  let finishReason = null
  let failure = null
  let usage = {}
  const calls = new Map()
  const startedCalls = new Set()
  let hasReasoningContent = false

  function consume(event = {}) {
    if (event.usage) usage = clone(event.usage)
    if (event.error) {
      failure = clone(event.error)
      return
    }
    const choice = event.choices?.find(item => (item.index ?? 0) === 0)
    if (!choice) return // A final usage-only chunk has an empty choices array.
    const delta = choice.delta || {}
    for (const text of [delta.content, delta.refusal]) {
      if (typeof text === 'string' && text) {
        content += text
        onTextDelta?.(text, event)
      }
    }
    if (typeof delta.reasoning_content === 'string') {
      hasReasoningContent = true
      if (delta.reasoning_content) {
        reasoningContent += delta.reasoning_content
        onReasoningDelta?.(delta.reasoning_content, event)
      }
    }
    for (const fragment of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const index = fragment.index
      if (!Number.isInteger(index) || index < 0) {
        failure = { message: 'Tool call delta is missing a valid index' }
        continue
      }
      if (fragment.type && fragment.type !== 'function') {
        failure = { message: `Unsupported tool call type: ${fragment.type}` }
        continue
      }
      const call = calls.get(index) || { id: '', itemId: `chat_tool_${index}`, name: '', arguments: '', outputIndex: index }
      if (typeof fragment.id === 'string') call.id += fragment.id
      if (typeof fragment.function?.name === 'string') call.name += fragment.function.name
      const argumentDelta = typeof fragment.function?.arguments === 'string' ? fragment.function.arguments : ''
      call.arguments += argumentDelta
      calls.set(index, call)
      if (call.name && !startedCalls.has(index)) {
        startedCalls.add(index)
        onFunctionCallStarted?.({ ...call }, event)
      }
      if (argumentDelta) onFunctionArgumentsDelta?.({ ...call }, argumentDelta, event)
    }
    if (choice.finish_reason != null) finishReason = choice.finish_reason
  }

  function result() {
    const toolCalls = [...calls.values()].sort((a, b) => a.outputIndex - b.outputIndex).map(call => ({ ...call }))
    let status = 'pending'
    let error = failure
    if (finishReason === 'length' || finishReason === 'content_filter') status = 'incomplete'
    else if (finishReason === 'stop' || finishReason === 'tool_calls') status = 'completed'
    else if (finishReason != null) error ||= { message: `Unsupported finish reason: ${finishReason}` }
    if (status === 'completed' && (
      toolCalls.some(call => !call.id || !call.name)
      || new Set(toolCalls.map(call => call.id)).size !== toolCalls.length
      || (finishReason === 'tool_calls' && toolCalls.length === 0)
    )) error ||= { message: 'Chat Completions returned incomplete or invalid tool call metadata' }
    if (status === 'completed' && !error) {
      for (const call of toolCalls) {
        // A terminal finish reason does not guarantee valid arguments. Never
        // let malformed JSON reach a runtime fallback that substitutes {} and
        // could turn a broken action into a different, default action.
        let args
        try { args = JSON.parse(call.arguments) } catch {}
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          error = { message: `Tool call ${call.id} arguments must be a valid JSON object` }
          break
        }
      }
    }
    if (error) status = 'failed'

    const entries = chatCompletionsHistoryEntries({ content, toolCalls })
    if (hasReasoningContent) {
      if (entries.length === 0) entries.push({ role: 'assistant', content: null })
      entries[0].reasoning_content = reasoningContent
    }
    return {
      content, commentaryContent: '', reasoningContent, toolCalls,
      usage: normalizeUsage(usage), status, finishReason, error,
      replay: { protocol: CHAT_PROTOCOL, entries },
    }
  }
  return { consume, result }
}

export function chatCompletionsStreamError(parsed) {
  if (parsed?.status === 'completed') return null
  const hadContent = Boolean(parsed?.content || parsed?.reasoningContent || parsed?.toolCalls?.length)
  let message = 'Chat Completions stream ended without a terminal finish reason'
  let code = 'ECHATCOMPLETIONSSTREAM'
  if (parsed?.status === 'incomplete') {
    message = `Chat Completions output incomplete: ${parsed.finishReason}`
    code = 'ECHATCOMPLETIONSINCOMPLETE'
  } else if (parsed?.status === 'failed') {
    message = `Chat Completions failed: ${parsed.error?.message || parsed.error?.code || 'unknown provider failure'}`
    code = parsed.error?.code || 'ECHATCOMPLETIONSFAILED'
  }
  return Object.assign(new Error(message), { code, hadContent })
}
