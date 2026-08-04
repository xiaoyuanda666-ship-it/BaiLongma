import { getInstalledToolSchema } from './marketplace/index.js'
import { getMcpToolSchema } from '../mcp/client-manager.js'
import { TOOL_SCHEMAS } from './builtin-tools.js'

export { TOOL_SCHEMAS } from './builtin-tools.js'

// One availability check for every tool-loading path.  A name in a routing
// table is not enough: MCP tools are only callable after their client has
// connected and supplied a schema.  Returning a name that has no schema makes
// the model believe it can act while the provider never receives that tool.
export function getToolSchema(name) {
  if (typeof name !== 'string' || !name) return null
  return TOOL_SCHEMAS[name] ?? getInstalledToolSchema(name) ?? getMcpToolSchema(name) ?? null
}

function normalizeToolPromptHints(toolPromptHints = null) {
  if (!toolPromptHints) return new Map()
  if (toolPromptHints instanceof Map) return toolPromptHints
  if (typeof toolPromptHints !== 'object') return new Map()
  const out = new Map()
  for (const [name, value] of Object.entries(toolPromptHints)) {
    const hints = Array.isArray(value) ? value : [value]
    const cleaned = hints
      .map(h => String(h || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 3)
    if (cleaned.length > 0) out.set(name, cleaned)
  }
  return out
}

function appendToolPromptHints(schema, hints = []) {
  if (!schema || !schema.function || hints.length === 0) return schema
  const lines = hints
    .map(h => `- ${h.slice(0, 360)}`)
    .join('\n')
  return {
    ...schema,
    function: {
      ...schema.function,
      description: [
        schema.function.description || '',
        'Learned failure lessons for this tool. Apply these when relevant, but trust the current user request and actual tool result if they conflict:',
        lines,
      ].filter(Boolean).join('\n\n'),
    },
  }
}

// 根据名称列表获取 schema 数组（含已安装工具）
export function getToolSchemas(toolNames, { toolPromptHints = null } = {}) {
  const hintsByTool = normalizeToolPromptHints(toolPromptHints)
  const seenNames = new Set()
  const seenSchemaNames = new Set()
  return (Array.isArray(toolNames) ? toolNames : [])
    // `express` remains as a backward-compatible executor alias,
    // but we don't expose it to the model. The model should use
    // `send_message` for outbound text messages.
    .filter(name => {
      if (name === 'express' || typeof name !== 'string' || seenNames.has(name)) return false
      seenNames.add(name)
      return true
    })
    .map(name => {
      const schema = getToolSchema(name)
      return appendToolPromptHints(schema, hintsByTool.get(name) || [])
    })
    .filter(Boolean)
    // The requested alias and the schema's actual function name should normally
    // be identical. Deduplicate by the final API-visible name as a last line of
    // defense against malformed extension schemas or future aliases.
    .filter(schema => {
      const name = schema?.function?.name
      if (!name || seenSchemaNames.has(name)) return false
      seenSchemaNames.add(name)
      return true
    })
    // 剥离识别器专用元数据，避免发给 LLM API
    .map(({ recognizer_highlights, ...rest }) => rest)
}
