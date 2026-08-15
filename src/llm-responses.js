// OpenAI Responses API wire-format helpers.
//
// Bailongma keeps its orchestration state provider-neutral, then converts that
// state to Responses input Items at the transport boundary.  Model output Items
// are preserved verbatim and replayed on the next tool round; this is required
// for stateless reasoning/tool conversations and avoids reconstructing model
// state from display text.

const RESPONSE_ITEM_TYPES = new Set([
  'message',
  'reasoning',
  'function_call',
  'function_call_output',
  'web_search_call',
  'custom_tool_call',
  'custom_tool_call_output',
  'computer_call',
  'computer_call_output',
  'file_search_call',
  'code_interpreter_call',
  'image_generation_call',
  'local_shell_call',
  'local_shell_call_output',
  'shell_call',
  'shell_call_output',
  'apply_patch_call',
  'apply_patch_call_output',
  'mcp_call',
  'mcp_list_tools',
  'mcp_approval_request',
  'mcp_approval_response',
  'compaction',
  'item_reference',
])

function asText(value) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return value == null ? '' : String(value)
  return value
    .map(part => typeof part === 'string' ? part : (part?.text || part?.content || ''))
    .filter(Boolean)
    .join('')
}

function cloneItem(item) {
  if (!item || typeof item !== 'object') return item
  if (typeof structuredClone === 'function') {
    try { return structuredClone(item) } catch {}
  }
  return JSON.parse(JSON.stringify(item))
}

// Accept the simple role/content messages produced by runtime/messages.js and
// the native output Items preserved from earlier Responses rounds.
export function toResponsesInput(items = []) {
  const input = []
  for (const original of Array.isArray(items) ? items : []) {
    if (!original || typeof original !== 'object') continue

    // Runtime messages may carry the exact output Items from the preceding
    // response as private transport metadata. Prefer them over reconstructing
    // a message/tool call so reasoning and provider-specific fields survive.
    if (Array.isArray(original._response_output_items)) {
      input.push(...original._response_output_items.map(cloneItem).filter(Boolean))
      continue
    }

    if (original.type && RESPONSE_ITEM_TYPES.has(original.type) && original.role !== 'tool') {
      input.push(cloneItem(original))
      continue
    }

    if (!['system', 'developer', 'user', 'assistant'].includes(original.role)) continue
    const content = asText(original.content)
    if (content) {
      const message = { type: 'message', role: original.role, content }
      // Assistant phases are transport state, not presentation-only metadata.
      // Preserve them when history is rebuilt manually so an intermediate
      // preamble cannot be mistaken for the completed answer on a later turn.
      if (original.role === 'assistant' && ['commentary', 'final_answer'].includes(original.phase)) {
        message.phase = original.phase
      }
      input.push(message)
    }
  }
  return input
}

export function toResponsesTool(schema) {
  if (!schema || schema.type !== 'function' || !schema.function?.name) return null
  const fn = schema.function
  return {
    type: 'function',
    name: fn.name,
    description: fn.description || '',
    parameters: fn.parameters || { type: 'object', properties: {} },
    // Keep existing tool-schema validation behavior explicit during migration.
    strict: fn.strict === true,
  }
}

export function toResponsesTools(schemas = []) {
  return (Array.isArray(schemas) ? schemas : []).map(toResponsesTool).filter(Boolean)
}

export function buildResponsesRequest({
  provider = '',
  model,
  messages = [],
  toolSchemas = [],
  temperature,
  topP,
  maxTokens,
  thinking = true,
  omitSampling = false,
  stream = true,
} = {}) {
  const request = {
    model,
    input: toResponsesInput(messages),
    stream,
    store: false,
  }

  if (!omitSampling && typeof temperature === 'number') request.temperature = temperature
  if (!omitSampling && typeof topP === 'number' && topP > 0) request.top_p = topP
  if (Number.isFinite(maxTokens) && maxTokens > 0) request.max_output_tokens = maxTokens

  // DeepSeek exposes reasoning through the standard Responses field. OpenAI
  // GPT-5/o-series models use the same field. Other providers/models may not
  // implement controllable reasoning, so omission is safer than a nonstandard
  // provider-specific body extension.
  const normalizedProvider = String(provider || '').toLowerCase()
  const normalizedModel = String(model || '').toLowerCase()
  const supportsReasoningControl = normalizedProvider === 'deepseek'
    || (normalizedProvider === 'openai' && (normalizedModel.startsWith('gpt-5') || /^o\d/.test(normalizedModel)))
  if (supportsReasoningControl) {
    request.reasoning = {
      effort: thinking ? 'high' : (normalizedProvider === 'deepseek' ? 'low' : 'none'),
    }
    // OpenAI only returns a public reasoning summary when it is explicitly
    // requested. Keep this provider-gated because Responses-compatible
    // gateways may reject fields they have not implemented.
    if (normalizedProvider === 'openai' && thinking) {
      request.reasoning.summary = 'auto'
    }
  }

  const tools = toResponsesTools(toolSchemas)
  if (tools.length > 0) {
    request.tools = tools
    request.tool_choice = 'auto'
    request.parallel_tool_calls = true
  }

  // OpenAI reasoning models require encrypted reasoning Items for stateless
  // replay. Do not send `include` to other providers: it is optional in the
  // standard and some Responses-compatible gateways reject unknown fields.
  if (normalizedProvider === 'openai' && supportsReasoningControl) {
    request.include = ['reasoning.encrypted_content']
  }
  return request
}

function itemKey(item, outputIndex) {
  return String(item?.id || `output_${Number.isInteger(outputIndex) ? outputIndex : 0}`)
}

function textFromMessageItem(item) {
  if (item?.type !== 'message' || !Array.isArray(item.content)) return ''
  return item.content
    .filter(part => part?.type === 'output_text' || part?.type === 'text' || part?.type === 'refusal')
    .map(part => part.text || part.refusal || '')
    .join('')
}

function messagePhase(item) {
  return item?.type === 'message' && item.phase === 'commentary'
    ? 'commentary'
    : 'final_answer'
}

function textFromReasoningItem(item) {
  if (item?.type !== 'reasoning') return ''
  const content = Array.isArray(item.content)
    ? item.content.map(part => part?.text || '').join('')
    : ''
  if (content) return content
  return Array.isArray(item.summary)
    ? item.summary.map(part => part?.text || '').join('')
    : ''
}

function normalizeUsage(response) {
  const usage = response?.usage || {}
  const inputTokens = Number(usage.input_tokens) || 0
  const outputTokens = Number(usage.output_tokens) || 0
  return {
    totalTokens: Number(usage.total_tokens) || inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    cachedTokens: Number(usage.input_tokens_details?.cached_tokens) || 0,
    reasoningTokens: Number(usage.output_tokens_details?.reasoning_tokens) || 0,
  }
}

export function createResponsesEventAccumulator({
  onTextDelta,
  onCommentaryDelta,
  onReasoningDelta,
  onFunctionCallStarted,
  onFunctionArgumentsDelta,
} = {}) {
  let content = ''
  let commentaryContent = ''
  let reasoningContent = ''
  let terminalType = ''
  let terminalResponse = null
  let lastSequenceNumber = -1
  const outputItems = new Map()
  const toolCalls = new Map()

  const phaseForEvent = (event = {}) => {
    const byIndex = outputItems.get(Number(event.output_index) || 0)
    if (byIndex?.type === 'message') return messagePhase(byIndex)
    if (event.item_id) {
      for (const item of outputItems.values()) {
        if (item?.id === event.item_id && item.type === 'message') return messagePhase(item)
      }
    }
    // Providers that do not implement phase keep the legacy behavior: text is
    // a final answer. The Responses protocol emits output_item.added before
    // deltas, so OpenAI commentary normally resolves through the branch above.
    return 'final_answer'
  }

  const upsertToolCall = (item = {}, outputIndex = 0) => {
    const key = itemKey(item, outputIndex)
    const existing = toolCalls.get(key) || {
      id: item.call_id || item.id || key,
      itemId: item.id || key,
      name: '',
      arguments: '',
      outputIndex,
    }
    if (item.call_id) existing.id = item.call_id
    if (item.id) existing.itemId = item.id
    if (item.name) existing.name = item.name
    if (typeof item.arguments === 'string') existing.arguments = item.arguments
    existing.outputIndex = Number.isInteger(outputIndex) ? outputIndex : existing.outputIndex
    toolCalls.set(key, existing)
    return existing
  }

  const findToolCall = (event) => {
    if (event?.item_id && toolCalls.has(String(event.item_id))) {
      return toolCalls.get(String(event.item_id))
    }
    for (const call of toolCalls.values()) {
      if (call.itemId === event?.item_id || call.outputIndex === event?.output_index) return call
    }
    return upsertToolCall({ id: event?.item_id }, event?.output_index)
  }

  const consume = (event = {}) => {
    const type = event.type || event.event || ''
    if (Number.isInteger(event.sequence_number)) {
      // Sequence numbers are observability, not a content-deduplication policy.
      // Remember the highest value so callers/tests can detect malformed streams.
      lastSequenceNumber = Math.max(lastSequenceNumber, event.sequence_number)
    }

    switch (type) {
      case 'response.output_text.delta':
      case 'response.refusal.delta':
        if (event.delta) {
          const phase = phaseForEvent(event)
          const phasedEvent = event.phase === phase ? event : { ...event, phase }
          if (phase === 'commentary') {
            commentaryContent += event.delta
            onCommentaryDelta?.(event.delta, phasedEvent)
          } else {
            content += event.delta
            onTextDelta?.(event.delta, phasedEvent)
          }
        }
        break

      case 'response.reasoning_text.delta':
      case 'response.reasoning_summary_text.delta':
        if (event.delta) {
          reasoningContent += event.delta
          onReasoningDelta?.(event.delta, event)
        }
        break

      case 'response.output_item.added': {
        const item = cloneItem(event.item)
        if (item) outputItems.set(Number(event.output_index) || 0, item)
        if (item?.type === 'function_call') {
          const call = upsertToolCall(item, event.output_index)
          onFunctionCallStarted?.(call, event)
        }
        break
      }

      case 'response.function_call_arguments.delta': {
        const call = findToolCall(event)
        if (event.delta) call.arguments += event.delta
        onFunctionArgumentsDelta?.(call, event.delta || '', event)
        break
      }

      case 'response.function_call_arguments.done': {
        const call = findToolCall(event)
        if (event.name) call.name = event.name
        if (typeof event.arguments === 'string') call.arguments = event.arguments
        break
      }

      case 'response.output_item.done': {
        const item = cloneItem(event.item)
        if (item) outputItems.set(Number(event.output_index) || 0, item)
        if (item?.type === 'function_call') upsertToolCall(item, event.output_index)
        break
      }

      case 'response.completed':
      case 'response.incomplete':
      case 'response.failed':
        terminalType = type
        terminalResponse = cloneItem(event.response) || null
        break

      case 'error':
        terminalType = type
        terminalResponse = { error: cloneItem(event.error || event) }
        break
    }
  }

  const result = () => {
    const finalItems = Array.isArray(terminalResponse?.output)
      ? terminalResponse.output.map(cloneItem)
      : [...outputItems.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => cloneItem(item))

    const callsFromItems = finalItems
      .filter(item => item?.type === 'function_call')
      .map((item, outputIndex) => ({
        id: item.call_id || item.id || `call_${outputIndex}`,
        itemId: item.id || '',
        name: item.name || '',
        arguments: typeof item.arguments === 'string' ? item.arguments : '{}',
        outputIndex,
      }))
    const finalToolCalls = callsFromItems.length > 0
      ? callsFromItems
      : [...toolCalls.values()].sort((a, b) => a.outputIndex - b.outputIndex).map(call => ({ ...call }))

    const fallbackContent = finalItems
      .filter(item => item?.type === 'message' && messagePhase(item) === 'final_answer')
      .map(textFromMessageItem)
      .join('')
    const fallbackCommentary = finalItems
      .filter(item => item?.type === 'message' && messagePhase(item) === 'commentary')
      .map(textFromMessageItem)
      .join('')
    const fallbackReasoning = finalItems.map(textFromReasoningItem).join('')
    return {
      content: content || fallbackContent,
      commentaryContent: commentaryContent || fallbackCommentary,
      reasoningContent: reasoningContent || fallbackReasoning,
      toolCalls: finalToolCalls,
      outputItems: finalItems,
      terminalType,
      response: terminalResponse,
      usage: normalizeUsage(terminalResponse),
      lastSequenceNumber,
    }
  }

  return { consume, result }
}

export function responseStreamError(parsed) {
  const hadOutput = Boolean(
    parsed?.content
    || parsed?.commentaryContent
    || parsed?.reasoningContent
    || parsed?.outputItems?.length
    || parsed?.toolCalls?.length,
  )
  if (!parsed || parsed.terminalType === 'response.completed') return null
  if (parsed.terminalType === 'response.incomplete') {
    const reason = parsed.response?.incomplete_details?.reason || 'unknown reason'
    const error = new Error(`Responses API output incomplete: ${reason}`)
    error.code = 'ERESPONSEINCOMPLETE'
    error.hadContent = hadOutput
    return error
  }
  if (parsed.terminalType === 'response.failed' || parsed.terminalType === 'error') {
    const detail = parsed.response?.error
    const message = detail?.message || detail?.code || 'unknown provider failure'
    const error = new Error(`Responses API failed: ${message}`)
    error.code = detail?.code || 'ERESPONSEFAILED'
    error.hadContent = hadOutput
    return error
  }
  const error = new Error('Responses API stream ended without a terminal response event')
  error.code = 'ERESPONSESTREAM'
  error.hadContent = hadOutput
  return error
}
