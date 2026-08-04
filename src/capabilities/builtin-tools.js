import { commsSchemas } from './schemas/comms.js'
import { filesystemSchemas } from './schemas/filesystem.js'
import { shellSchemas } from './schemas/shell.js'
import { mediaSchemas } from './schemas/media.js'
import { memorySchemas } from './schemas/memory.js'
import { knowledgeSchemas } from './schemas/knowledge.js'
import { uiSchemas } from './schemas/ui.js'
import { sceneSchemas } from './schemas/scene.js'
import { taskSchemas } from './schemas/task.js'
import { reviewSchemas } from './schemas/review.js'
import { remindersSchemas } from './schemas/reminders.js'
import { agentsSchemas } from './schemas/agents.js'
import { systemSchemas } from './schemas/system.js'
import { apiCapabilitySchemas } from './schemas/api-capabilities.js'
import { BUILTIN_BROWSER_ALLOWED_TOOLS } from '../mcp/chrome-devtools-server.js'

export const BUILTIN_SCHEMA_GROUPS = Object.freeze([
  ['comms', commsSchemas],
  ['filesystem', filesystemSchemas],
  ['shell', shellSchemas],
  ['media', mediaSchemas],
  ['memory', memorySchemas],
  ['knowledge', knowledgeSchemas],
  ['ui', uiSchemas],
  ['scene', sceneSchemas],
  ['task', taskSchemas],
  ['review', reviewSchemas],
  ['reminders', remindersSchemas],
  ['agents', agentsSchemas],
  ['system', systemSchemas],
  ['api-capabilities', apiCapabilitySchemas],
])

// Reserve retired aliases and built-in browser names so installed
// tools cannot hijack them. Retired aliases remain absent from both the
// model-facing schema and the executor.
export const LEGACY_TOOL_ALIASES = Object.freeze([
  'web_search',
  'web_read',
  'fetch_url',
  'browser_read',
  'exec_command',
  'exec_quick_command',
  'exec_task_command',
  'exec_background_command',
  'schedule_reminder',
  ...BUILTIN_BROWSER_ALLOWED_TOOLS,
])

export function buildBuiltinToolSchemas(groups = BUILTIN_SCHEMA_GROUPS) {
  const catalog = {}
  const owners = new Map()
  for (const [groupName, schemas] of groups) {
    if (!schemas || typeof schemas !== 'object' || Array.isArray(schemas)) {
      throw new Error(`Invalid built-in tool schema group: ${groupName}`)
    }
    for (const [name, schema] of Object.entries(schemas)) {
      const functionName = schema?.function?.name
      if (functionName !== name) {
        throw new Error(`Built-in tool schema key/name mismatch in ${groupName}: "${name}" != "${functionName || ''}"`)
      }
      if (owners.has(name)) {
        throw new Error(`Duplicate built-in tool "${name}" in ${owners.get(name)} and ${groupName}`)
      }
      owners.set(name, groupName)
      catalog[name] = schema
    }
  }
  return catalog
}

export const TOOL_SCHEMAS = Object.freeze(buildBuiltinToolSchemas())
export const BUILTIN_TOOL_NAMES = new Set([
  ...Object.keys(TOOL_SCHEMAS),
  ...LEGACY_TOOL_ALIASES,
])
