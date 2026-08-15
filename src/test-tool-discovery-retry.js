// Regression: one empty find_tool query must not make the agent give up or
// narrate a missing action. The runtime keeps discovery open across distinct
// queries, hides working narration, and exposes a newly loaded schema.
// Run: node src/test-tool-discovery-retry.js

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-tool-discovery-retry-'))
process.env.BAILONGMA_USER_DIR = tmp
process.env.BAILONGMA_RESOURCES_DIR = process.cwd()

let closeDBForTest = null
const itemText = item => String(item?.content ?? item?.output ?? '')

try {
  const { callLLM, buildToolDiscoveryRetryNudge } = await import('./llm.js')
  const { getToolSchemas } = await import('./capabilities/schemas.js')
  const { executeTool } = await import('./capabilities/executor.js')
  ;({ closeDBForTest } = await import('./db.js'))

  const findDescription = getToolSchemas(['find_tool'])[0]?.function?.description || ''
  assert.match(findDescription, /mandatory/i, 'find_tool schema makes missing-tool discovery mandatory')
  assert.match(findDescription, /four total attempts/i, 'find_tool schema advertises the four-query recovery budget')

  const retryNudge = buildToolDiscoveryRetryNudge({ attempts: 1, queries: ['read report'] })
  assert.match(retryNudge, /Call find_tool again now/i, 'retry nudge requires another real find_tool call')
  assert.match(retryNudge, /Do not output a plan/i, 'retry nudge forbids prose-only action narration')

  const emptyCatalogResult = JSON.parse(await executeTool(
    'find_tool',
    { query: '__definitely_missing_capability_7f29__' },
    { source: 'test', currentUserMessage: 'test discovery miss' },
  ))
  assert.equal(emptyCatalogResult.retryable, true, 'an empty catalog result explicitly remains retryable')
  assert.equal(emptyCatalogResult.retry_strategies?.length, 4, 'empty discovery returns four query strategies')

  const executed = []
  let rounds = 0
  const result = await callLLM({
    systemPrompt: 'Use tools to read report.txt.',
    message: '读取 report.txt 并告诉我内容',
    tools: ['find_tool'],
    toolContext: { currentTargetId: 'ID:test', currentUserMessage: '读取 report.txt 并告诉我内容' },
    mustReply: true,
    localReply: true,
    _executeToolForTest: async (name, args) => {
      executed.push({ name, args })
      if (name === 'find_tool' && args.query === 'read_file') {
        return JSON.stringify({ ok: true, tool: 'find_tool', loaded: ['read_file'], matches: [{ name: 'read_file' }] })
      }
      if (name === 'find_tool') {
        return JSON.stringify({ ok: true, tool: 'find_tool', loaded: [], matches: [], retryable: true })
      }
      if (name === 'read_file') {
        return JSON.stringify({ ok: true, path: 'report.txt', content: 'verified report' })
      }
      if (name === 'send_message') {
        return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      }
      return JSON.stringify({ ok: false, error: `unexpected tool ${name}` })
    },
    _streamOnceForTest: async ({ messages, toolSchemas }) => {
      rounds += 1
      const call = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) })
      if (rounds === 1) {
        return { content: 'I need a tool to inspect the report.', reasoningContent: '', aborted: false,
          toolCalls: [call('find-1', 'find_tool', { query: 'inspect report' })] }
      }
      if (rounds === 2) {
        assert(messages.some(message => /Call find_tool again now/i.test(String(message.content || ''))),
          'empty discovery result injects a strong retry instruction')
        return { content: 'I still need to find it.', reasoningContent: '', aborted: false,
          toolCalls: [call('find-2', 'find_tool', { query: '读取本地文件' })] }
      }
      if (rounds === 3) {
        return { content: '', reasoningContent: '', aborted: false,
          toolCalls: [call('find-3', 'find_tool', { query: 'read_file' })] }
      }
      if (rounds === 4) {
        assert(toolSchemas.some(schema => schema.function.name === 'read_file'),
          'a later successful discovery injects the loaded schema')
        return { content: '', reasoningContent: '', aborted: false,
          toolCalls: [call('read', 'read_file', { path: 'report.txt' })] }
      }
      assert(messages.some(message => itemText(message).includes('verified report')),
        'the final round receives evidence from the discovered tool')
      return { content: 'report.txt 内容是 verified report。', reasoningContent: '', aborted: false, toolCalls: [] }
    },
  })

  assert.deepEqual(executed.map(item => item.name), ['find_tool', 'find_tool', 'find_tool', 'read_file', 'send_message'],
    'the agent varies find_tool queries until a useful tool is loaded, calls it, then delivers the result')
  assert.equal(result.content, 'report.txt 内容是 verified report。',
    'discovery narration is excluded from the delivered reply')
  assert.equal(rounds, 5, 'discovery retries remain inside one bounded agent turn')

  console.log('test-tool-discovery-retry ok')
} finally {
  closeDBForTest?.()
  fs.rmSync(tmp, { recursive: true, force: true })
}
