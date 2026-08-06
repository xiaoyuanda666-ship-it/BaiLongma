// Contract test for the three-injector facade.
// Run: node src/test-injector-categories.js

import assert from 'node:assert/strict'
import { finalizeToolInjection, mergeInjectorResults } from './memory/injector.js'

const merged = mergeInjectorResults({
  memory: {
    memories: [{ id: 1 }],
    conversationWindow: [{ role: 'user', content: 'hello' }],
    directions: ['memory direction'],
  },
  tool: {
    tools: ['read_file'],
    actionLog: [{ tool: 'read_file' }],
    directions: ['tool direction'],
  },
  information: {
    constraints: [{ content: 'constraint' }],
    prefetchedItems: [{ source: 'test' }],
    uiSignalIds: [7],
    directions: ['information direction'],
  },
})

assert.deepEqual(merged.memories, [{ id: 1 }])
assert.deepEqual(merged.tools, ['read_file'])
assert.deepEqual(merged.constraints, [{ content: 'constraint' }])
assert.deepEqual(merged.uiSignalIds, [7])
assert.equal(merged.categories.memory.memories[0].id, 1)
assert.equal(merged.categories.tool.tools[0], 'read_file')
assert.equal(merged.categories.information.uiSignalIds[0], 7)
assert.deepEqual(merged.directions, [
  'memory direction',
  'tool direction',
  'information direction',
])
assert.equal(merged.thought, null)

const localTools = finalizeToolInjection({
  initialTools: ['read_file'],
  localReply: true,
  input: '读取文件',
})
assert.deepEqual(localTools.turnTools, ['read_file'])
assert.deepEqual(localTools.modelToolNames, ['read_file'])

const contractedTools = finalizeToolInjection({
  initialTools: ['read_file'],
  actionContract: { id: 'write-required', requiredTools: ['write_file'] },
})
assert.deepEqual(contractedTools.turnTools, ['send_message', 'read_file', 'write_file'])
assert.equal(contractedTools.actionContract.id, 'write-required')
assert.deepEqual(contractedTools.unavailableTools, [])

console.log('injector category contract ok')
