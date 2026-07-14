import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-strict-eval-'))
process.env.JARVIS_USER_DIR = tmp
process.env.JARVIS_RESOURCES_DIR = process.cwd()

let closeDBForTest = null

try {
  const {
    filterStrictEvaluationTools,
    resolveStrictEvaluationMode,
  } = await import('./runtime/strict-evaluation.js')
  const { callLLM } = await import('./llm.js')
  ;({ closeDBForTest } = await import('./db.js'))

  const prompt = [
    '严格评估模式：直接调用已安装的新工具 readable_web_fetch_live_test。',
    '不要调用 fetch_url，不要重新 propose/review/install。',
    '如果新工具失败，就报告失败，不要自行修复。',
  ].join('\n')

  const strict = resolveStrictEvaluationMode(prompt)
  assert.equal(strict.active, true, 'strict evaluation is detected from explicit prompt constraints')
  assert.equal(strict.noRepair, true, 'strict evaluation disables self-repair when prompt says to report failure')
  assert(strict.forbiddenTools.includes('fetch_url'), 'fetch_url is forbidden')
  assert(strict.forbiddenTools.includes('manage_tool_factory'), 'manage_tool_factory is forbidden')
  assert(strict.forbiddenTools.includes('install_tool'), 'install_tool is forbidden')

  const visibleTools = filterStrictEvaluationTools([
    'send_message',
    'fetch_url',
    'manage_tool_factory',
    'install_tool',
    'readable_web_fetch_live_test',
  ], strict)
  assert(!visibleTools.includes('fetch_url'), 'strict filtering hides fetch_url')
  assert(!visibleTools.includes('manage_tool_factory'), 'strict filtering hides manage_tool_factory')
  assert(!visibleTools.includes('install_tool'), 'strict filtering hides install_tool')
  assert(visibleTools.includes('readable_web_fetch_live_test'), 'strict filtering keeps allowed installed tool')

  const normalFactoryPrompt = [
    'Create a new function-call tool named readable_web_fetch_live_test using manage_tool_factory propose -> review -> install.',
    'Do not overwrite the built-in fetch_url. Do not use direct install_tool.',
    'After installing it, call the new tool on a local test page and report the extracted fields.',
  ].join('\n')
  const normalFactoryMode = resolveStrictEvaluationMode(normalFactoryPrompt)
  assert.equal(normalFactoryMode.noRepair, false, 'normal Tool Factory prompt does not disable repair mode')
  assert(!normalFactoryMode.forbiddenTools.includes('manage_tool_factory'), 'normal Tool Factory prompt keeps manage_tool_factory allowed')
  assert(!normalFactoryMode.forbiddenTools.includes('fetch_url'), 'do-not-overwrite fetch_url does not forbid calling fetch_url')
  assert(normalFactoryMode.forbiddenTools.includes('install_tool'), 'direct install_tool can be forbidden without blocking managed factory')

  let round = 0
  const schemaNamesByRound = []
  const executedTools = []
  const observedTools = []

  const result = await callLLM({
    systemPrompt: 'system',
    message: prompt,
    tools: [
      'send_message',
      'fetch_url',
      'manage_tool_factory',
      'install_tool',
      'readable_web_fetch_live_test',
    ],
    toolContext: { strictEvaluation: strict },
    mustReply: false,
    _streamOnceForTest: async ({ toolSchemas }) => {
      schemaNamesByRound.push(toolSchemas.map(schema => schema?.function?.name).filter(Boolean))
      round += 1
      if (round === 1) {
        return {
          content: '',
          reasoningContent: '',
          aborted: false,
          toolCalls: [{
            id: 'call_allowed_tool',
            name: 'readable_web_fetch_live_test',
            arguments: JSON.stringify({ url: 'http://127.0.0.1:1/page' }),
          }],
        }
      }
      if (round === 2) {
        return {
          content: '',
          reasoningContent: '',
          aborted: false,
          toolCalls: [
            {
              id: 'call_forbidden_fetch',
              name: 'fetch_url',
              arguments: JSON.stringify({ url: 'http://127.0.0.1:1/page' }),
            },
            {
              id: 'call_forbidden_factory',
              name: 'manage_tool_factory',
              arguments: JSON.stringify({ action: 'propose', name: 'replacement_tool' }),
            },
          ],
        }
      }
      return {
        content: 'Strict evaluation failed: the allowed installed tool did not complete, and repair/fallback tools were forbidden.',
        reasoningContent: '',
        aborted: false,
        toolCalls: [],
      }
    },
    onToolExecute: (name) => executedTools.push(name),
    onToolCall: (name, args, toolResult) => observedTools.push({ name, args, result: String(toolResult || '') }),
  })

  assert(!schemaNamesByRound[0].includes('fetch_url'), 'callLLM omits forbidden fetch_url schema')
  assert(!schemaNamesByRound[0].includes('manage_tool_factory'), 'callLLM omits forbidden factory schema')
  assert(!executedTools.includes('fetch_url'), 'forbidden fetch_url is not executed')
  assert(!executedTools.includes('manage_tool_factory'), 'forbidden manage_tool_factory is not executed')

  const blocked = observedTools
    .filter(item => item.name === 'fetch_url' || item.name === 'manage_tool_factory')
    .map(item => JSON.parse(item.result))
  assert.equal(blocked.length, 2, 'forbidden attempted tools return observable results')
  assert(blocked.every(item => item.skipped === 'strict_evaluation_forbidden_tool'), 'forbidden attempts are strict-mode blocks')
  assert(result.content.includes('Strict evaluation failed'), 'model can end by reporting strict-mode failure')

  console.log('PASS strict evaluation blocks forbidden fallback and repair tools')
} finally {
  closeDBForTest?.()
  fs.rmSync(tmp, { recursive: true, force: true })
}

process.exit(process.exitCode || 0)
