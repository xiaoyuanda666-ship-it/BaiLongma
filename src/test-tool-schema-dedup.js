import assert from 'node:assert/strict'
import {
  BUILTIN_TOOL_NAMES,
  LEGACY_TOOL_ALIASES,
  TOOL_SCHEMAS,
  buildBuiltinToolSchemas,
} from './capabilities/builtin-tools.js'
import { getToolSchema, getToolSchemas } from './capabilities/schemas.js'
import { validateToolManifest } from './capabilities/marketplace/index.js'

const builtinNames = Object.keys(TOOL_SCHEMAS)
const functionNames = builtinNames.map(name => TOOL_SCHEMAS[name]?.function?.name)
const REMOVED_WEB_TOOLS = ['web_search', 'web_read', 'fetch_url', 'browser_read']
const REMOVED_BROWSER_TOOLS = ['browser_sessions', 'browser_open', 'browser_inspect', 'browser_act']

assert.equal(new Set(builtinNames).size, builtinNames.length)
assert.equal(new Set(functionNames).size, functionNames.length)
assert.deepEqual(functionNames, builtinNames)
assert.equal(BUILTIN_TOOL_NAMES.size, builtinNames.length + LEGACY_TOOL_ALIASES.length)

assert.deepEqual(
  getToolSchemas(['web_read', 'fetch_url', 'read_file', 'browser_read'])
    .map(schema => schema.function.name),
  ['read_file'],
)
assert.equal(getToolSchema('read_file')?.function?.name, 'read_file')
assert.equal(getToolSchema('not_a_real_tool'), null, 'unregistered tools have no callable schema')
assert.ok([...REMOVED_WEB_TOOLS, ...REMOVED_BROWSER_TOOLS].every(name => TOOL_SCHEMAS[name] === undefined))
assert.deepEqual(getToolSchemas([...REMOVED_WEB_TOOLS, ...REMOVED_BROWSER_TOOLS]), [])
assert.ok(REMOVED_WEB_TOOLS.every(name => LEGACY_TOOL_ALIASES.includes(name)),
  'removed web names remain reserved without exposing schemas')

assert.throws(
  () => buildBuiltinToolSchemas([
    ['first', { same_tool: { type: 'function', function: { name: 'same_tool' } } }],
    ['second', { same_tool: { type: 'function', function: { name: 'same_tool' } } }],
  ]),
  /Duplicate built-in tool "same_tool" in first and second/,
)

assert.throws(
  () => buildBuiltinToolSchemas([
    ['broken', { schema_key: { type: 'function', function: { name: 'different_name' } } }],
  ]),
  /schema key\/name mismatch/,
)

for (const name of ['find_tool', 'review_work', 'install_software', ...LEGACY_TOOL_ALIASES]) {
  assert.throws(
    () => validateToolManifest({
      name,
      description: 'conflicting extension',
      parameters: { type: 'object', properties: {} },
      code: 'return true',
    }),
    /保留名称/,
  )
}

console.log('test-tool-schema-dedup passed')
