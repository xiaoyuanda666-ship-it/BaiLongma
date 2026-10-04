export const DEFAULT_LLM_API_FORMAT = 'responses'
export const LLM_API_FORMATS = Object.freeze(['responses', 'chat-completions'])

// Missing fields in older records retain the protocol those records used.
// An explicitly supplied, invalid format must never silently change routing.
export function normalizeLLMApiFormat(value = DEFAULT_LLM_API_FORMAT) {
  if (!LLM_API_FORMATS.includes(value)) {
    throw new Error(`Unsupported LLM API format: ${String(value)}. Choose responses or chat-completions.`)
  }
  return value
}
