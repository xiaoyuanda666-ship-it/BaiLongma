import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-action-contract-'))
process.env.JARVIS_USER_DIR = tmp
process.env.JARVIS_RESOURCES_DIR = process.cwd()

let closeDBForTest = null

try {
  const { classifyActionContract } = await import('./runtime/action-contract.js')
  const { callLLM } = await import('./llm.js')
  ;({ closeDBForTest } = await import('./db.js'))

  const writeContract = classifyActionContract('帮我在 sandbox 里创建一个 hello.txt 文件')
  assert.equal(writeContract?.id, 'file_write')
  assert.deepEqual(writeContract.requiredTools, ['write_file'])
  assert.equal(classifyActionContract('帮我新建一个 logs 文件夹')?.id, 'directory_create')
  assert.equal(classifyActionContract('怎么创建一个 txt 文件？'), null, 'how-to is ordinary Q&A, not an execution contract')
  assert.equal(classifyActionContract('你有多少执行命令工具？'), null, 'tool meta questions must not trigger execution')
  assert.equal(classifyActionContract('帮我安装一个 npm 插件'), null, 'plugin installation is not OS software installation')

  let rounds = 0
  const executed = []
  const result = await callLLM({
    systemPrompt: 'system',
    message: '帮我在 sandbox 里创建一个 hello.txt 文件',
    tools: ['write_file', 'send_message'],
    mustReply: true,
    localReply: true,
    toolContext: {
      currentTargetId: 'ID:000001',
      actionContract: writeContract,
    },
    _streamOnceForTest: async ({ messages }) => {
      rounds += 1
      if (rounds === 1) {
        return { content: '已经创建好了。', reasoningContent: '', aborted: false, toolCalls: [] }
      }
      if (rounds === 2) {
        assert(messages.some(m => String(m.content || '').includes('No matching action has actually run')))
        return {
          content: '',
          reasoningContent: '',
          aborted: false,
          toolCalls: [{ id: 'write-1', name: 'write_file', arguments: JSON.stringify({ path: 'sandbox/hello.txt', content: 'hello' }) }],
        }
      }
      return { content: '文件已创建：sandbox/hello.txt。', reasoningContent: '', aborted: false, toolCalls: [] }
    },
    _executeToolForTest: async (name) => {
      executed.push(name)
      if (name === 'write_file') return JSON.stringify({ ok: true, path: 'sandbox/hello.txt', bytes: 5 })
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      return JSON.stringify({ ok: false, error: 'unexpected tool' })
    },
  })

  assert.equal(rounds, 3, 'text-only completion is replaced with a real action round')
  assert.deepEqual(executed, ['write_file', 'send_message'], 'the requested side effect runs before fallback delivery')
  assert.equal(result.delivered, true)
  assert.match(result.content, /文件已创建/)

  // A failed real attempt must not be laundered into “已创建”. The runtime
  // gives the model one correction round and delivers only the truthful result.
  let failedRounds = 0
  const failed = await callLLM({
    systemPrompt: 'system',
    message: '帮我在 sandbox 里创建一个 hello.txt 文件',
    tools: ['write_file', 'send_message'],
    mustReply: true,
    localReply: true,
    toolContext: { currentTargetId: 'ID:000001', actionContract: writeContract },
    _streamOnceForTest: async ({ messages }) => {
      failedRounds += 1
      if (failedRounds === 1) {
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: [{ id: 'write-fail', name: 'write_file', arguments: JSON.stringify({ path: 'sandbox/hello.txt', content: 'hello' }) }],
        }
      }
      if (failedRounds === 2) {
        return { content: '文件已创建。', reasoningContent: '', aborted: false, toolCalls: [] }
      }
      assert(messages.some(m => String(m.content || '').includes('has no successful tool evidence')))
      return { content: '写入失败：当前目录没有写入权限。', reasoningContent: '', aborted: false, toolCalls: [] }
    },
    _executeToolForTest: async (name) => {
      if (name === 'write_file') return JSON.stringify({ ok: false, error: 'permission denied' })
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      return JSON.stringify({ ok: false, error: 'unexpected tool' })
    },
  })
  assert.equal(failedRounds, 3, 'a false completion after tool failure gets corrected')
  assert.match(failed.content, /写入失败/)
  assert.doesNotMatch(failed.content, /已创建/)

  // Social channels cannot use the local fallback. A premature send_message is
  // therefore also blocked; it must not masquerade as the requested action.
  let socialRounds = 0
  const socialExecuted = []
  const social = await callLLM({
    systemPrompt: 'system',
    message: '帮我在 sandbox 里创建一个 hello.txt 文件',
    tools: ['write_file', 'send_message'],
    mustReply: true,
    localReply: false,
    toolContext: { currentTargetId: 'ID:000001', actionContract: writeContract },
    _streamOnceForTest: async () => {
      socialRounds += 1
      if (socialRounds === 1) {
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: [{ id: 'premature-send', name: 'send_message', arguments: JSON.stringify({ target_id: 'ID:000001', content: '文件已创建。' }) }],
        }
      }
      if (socialRounds === 2) {
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: [{ id: 'write-social', name: 'write_file', arguments: JSON.stringify({ path: 'sandbox/hello.txt', content: 'hello' }) }],
        }
      }
      return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'final-send', name: 'send_message', arguments: JSON.stringify({ target_id: 'ID:000001', content: '文件已创建：sandbox/hello.txt。' }) }],
      }
    },
    _executeToolForTest: async (name) => {
      socialExecuted.push(name)
      if (name === 'write_file') return JSON.stringify({ ok: true, path: 'sandbox/hello.txt' })
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      return JSON.stringify({ ok: false, error: 'unexpected tool' })
    },
  })
  assert.equal(socialRounds, 3)
  assert.deepEqual(socialExecuted, ['write_file', 'send_message'], 'premature social completion was suppressed, not delivered')
  assert.equal(social.delivered, true)
  console.log('test-action-contract passed')
} finally {
  closeDBForTest?.()
  fs.rmSync(tmp, { recursive: true, force: true })
}

process.exit(process.exitCode || 0)
