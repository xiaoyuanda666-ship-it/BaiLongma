import { deepseekWebAdapter } from './deepseek.js'
import { openaiWebAdapter } from './openai.js'

// Chat-completions compatibility does NOT imply search API compatibility.
// Add providers explicitly, with their own documented protocol and capabilities.
export const WEB_ADAPTERS = Object.freeze({ deepseek: deepseekWebAdapter, openai: openaiWebAdapter })
