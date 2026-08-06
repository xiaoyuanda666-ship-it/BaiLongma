import { runContextRuleEngine } from './rule-engine.js'

export async function buildKeywordRuntimeContext(message = '', options = {}) {
  return await runContextRuleEngine(message, options)
}
