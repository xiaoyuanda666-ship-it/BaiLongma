import { getInstalledToolSchema } from './marketplace/index.js'
import { commsSchemas } from './schemas/comms.js'
import { filesystemSchemas } from './schemas/filesystem.js'
import { shellSchemas } from './schemas/shell.js'
import { webSchemas } from './schemas/web.js'
import { mediaSchemas } from './schemas/media.js'
import { memorySchemas } from './schemas/memory.js'
import { uiSchemas } from './schemas/ui.js'
import { sceneSchemas } from './schemas/scene.js'
import { taskSchemas } from './schemas/task.js'
import { reviewSchemas } from './schemas/review.js'
import { remindersSchemas } from './schemas/reminders.js'
import { agentsSchemas } from './schemas/agents.js'
import { systemSchemas } from './schemas/system.js'
import { apiCapabilitySchemas } from './schemas/api-capabilities.js'
import { buildCliSchemas } from './schemas/cli.js'

// 所有工具的 schema 定义（按类别拆分到 ./schemas/*.js，此处合并）。
// 调用方按需用 getToolSchemas(toolNames) 取子集，合并顺序不影响输出顺序。
export const TOOL_SCHEMAS = {
  ...commsSchemas,
  ...filesystemSchemas,
  ...shellSchemas,
  ...webSchemas,
  ...mediaSchemas,
  ...memorySchemas,
  ...uiSchemas,
  ...sceneSchemas,
  ...taskSchemas,
  ...reviewSchemas,
  ...remindersSchemas,
  ...agentsSchemas,
  ...systemSchemas,
  ...apiCapabilitySchemas,
  ...buildCliSchemas(),
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
  return toolNames
    // `express` remains as a backward-compatible executor alias,
    // but we don't expose it to the model. The model should use
    // `send_message` for outbound text messages.
    .filter(name => name !== 'express')
    .map(name => {
      const schema = TOOL_SCHEMAS[name] ?? getInstalledToolSchema(name)
      return appendToolPromptHints(schema, hintsByTool.get(name) || [])
    })
    .filter(Boolean)
    // 剥离识别器专用元数据，避免发给 LLM API
    .map(({ recognizer_highlights, ...rest }) => rest)
}
