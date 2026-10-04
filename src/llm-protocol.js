import { normalizeLLMApiFormat } from './llm-api-format.js'
import { buildResponsesRequest, createResponsesEventAccumulator, responseStreamError } from './llm-responses.js'
import {
  buildChatCompletionsRequest, createChatCompletionsAccumulator,
  chatCompletionsStreamError, chatCompletionsHistoryEntries,
} from './llm-chat-completions.js'

const responses = Object.freeze({
  id: 'responses',
  buildRequest: buildResponsesRequest,
  createAccumulator(callbacks) {
    const accumulator = createResponsesEventAccumulator(callbacks)
    return {
      consume: accumulator.consume,
      result() {
        const parsed = accumulator.result()
        const status = {
          'response.completed': 'completed', 'response.incomplete': 'incomplete',
          'response.failed': 'failed', error: 'failed',
        }[parsed.terminalType] || 'pending'
        return { ...parsed, status, replay: { protocol: 'responses', entries: structuredClone(parsed.outputItems) } }
      },
    }
  },
  streamError: responseStreamError,
  toHistoryEntries(result = {}) {
    if (result.replay) {
      if (result.replay.protocol !== 'responses') throw new Error('Responses replay protocol mismatch')
      if (Array.isArray(result.replay.entries) && result.replay.entries.length) return structuredClone(result.replay.entries)
    }
    if (result.outputItems?.length) return structuredClone(result.outputItems)
    return result.content ? [{ role: 'assistant', content: result.content }] : []
  },
  toToolResultEntries(results = []) {
    return results.map(result => ({ type: 'function_call_output', call_id: result.id, output: String(result.result) }))
  },
})

const chatCompletions = Object.freeze({
  id: 'chat-completions',
  buildRequest: buildChatCompletionsRequest,
  createAccumulator: createChatCompletionsAccumulator,
  streamError: chatCompletionsStreamError,
  toHistoryEntries: chatCompletionsHistoryEntries,
  toToolResultEntries(results = []) {
    return results.map(result => ({ role: 'tool', tool_call_id: result.id, content: String(result.result) }))
  },
})

export function getLLMProtocol(format) {
  return normalizeLLMApiFormat(format) === 'responses' ? responses : chatCompletions
}
