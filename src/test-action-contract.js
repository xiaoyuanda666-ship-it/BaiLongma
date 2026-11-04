import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-action-contract-'))
process.env.BAILONGMA_USER_DIR = tmp
process.env.BAILONGMA_RESOURCES_DIR = process.cwd()

let closeDBForTest = null
const itemText = item => String(item?.content ?? item?.output ?? '')

try {
  const {
    actionContractCompletionIssue,
    actionContractToolCallIssue,
    actionContractToolSucceeded,
    browserPageFindResultFromEvidence,
    browserScreenshotDeliveryMatches,
    browserScreenshotPathFromEvidence,
    classifyActionContract,
    collectVerifiedWebResearchSources,
    filterMemoriesForActionContract,
    inferWebResearchSourceCount,
    resolveActionContractForTurn,
    verifiedActionContractReply,
  } = await import('./runtime/action-contract.js')
  const { callLLM, slowAckText } = await import('./llm.js')
  const { finalizeToolInjection } = await import('./injectors/tool-injector.js')
  const { evaluateToolPolicy } = await import('./capabilities/tool-policy.js')
  ;({ closeDBForTest } = await import('./db.js'))

  const writeContract = classifyActionContract('帮我在 sandbox 里创建一个 hello.txt 文件')
  assert.equal(writeContract?.id, 'file_write')
  assert.deepEqual(writeContract.requiredTools, ['write_file'])
  const editContract = classifyActionContract('帮我修改 src/app.js 文件里的一个函数')
  assert.equal(editContract?.id, 'file_edit')
  assert.deepEqual(editContract.requiredTools, ['read_file', 'edit_file'])
  assert.equal(editContract.restrictTools, true)
  assert.equal(editContract.requireAllTools, true)
  const naturalWebpageWrite = classifyActionContract('帮我做一个简单的个人主页，保存成网页，我想双击就能打开。')
  assert.equal(naturalWebpageWrite?.id, 'file_write')
  assert.deepEqual(naturalWebpageWrite.requiredTools, ['write_file'])
  assert.equal(classifyActionContract('不用发代码，你直接帮我保存成网页就行。')?.id, 'file_write')
  const naturalWebpageEdit = classifyActionContract('把网页上的名字改成小远，再加一句“喜欢做有意思的小工具”。')
  assert.equal(naturalWebpageEdit?.id, 'file_edit')
  assert.equal(naturalWebpageEdit.restrictTools, true)
  assert.equal(naturalWebpageEdit.requireAllTools, true)
  const webpageConversation = [
    { role: 'user', content: '帮我做一个简单的个人主页，保存成网页。' },
    { role: 'jarvis', content: '已经保存为个人主页.html。' },
  ]
  for (const phrase of [
    '把按钮改成绿色，其他别动。',
    '把背景换成浅灰色，其他别动。',
  ]) {
    const continuation = classifyActionContract(phrase, { conversationWindow: webpageConversation })
    assert.equal(continuation?.id, 'file_edit', phrase)
    assert.deepEqual(continuation.requiredTools, ['read_file', 'edit_file'], phrase)
    assert.equal(continuation.restrictTools, true, phrase)
    assert.equal(continuation.requireAllTools, true, phrase)
  }
  assert.equal(classifyActionContract('把按钮改成绿色，其他别动。'), null,
    'a terse edit without recent file context must not invent a file target')
  assert.match(actionContractToolCallIssue(
    naturalWebpageEdit,
    'edit_file',
    { path: '个人主页.html', operation: 'replace' },
    { successfulToolNames: new Set() },
  ), /read_file/i, 'edit_file cannot run before the target file has been read')
  assert.equal(actionContractToolCallIssue(
    naturalWebpageEdit,
    'edit_file',
    { path: '个人主页.html', operation: 'replace' },
    { successfulToolNames: new Set(['read_file']) },
  ), '', 'edit_file can run after a successful read_file')
  assert.equal(classifyActionContract('帮我新建一个 logs 文件夹')?.id, 'directory_create')
  assert.equal(classifyActionContract('怎么创建一个 txt 文件？'), null, 'how-to is ordinary Q&A, not an execution contract')
  assert.equal(classifyActionContract('你有多少执行命令工具？'), null, 'tool meta questions must not trigger execution')
  assert.equal(classifyActionContract('帮我安装一个 npm 插件'), null, 'plugin installation is not OS software installation')
  // Browser actions now use the bsk CLI. Legacy wrapper-driven loops are retired.
  for (const phrase of [
    '下载 CapCut', '帮我下载豆包', '需要你帮我登录我的 X 账号',
    '关掉你的浏览器', '把当前页面截张图发给我看看',
    '打开 https://example.com', '用我电脑上的浏览器打开 https://example.com',
  ]) {
    const contract = classifyActionContract(phrase)
    assert.equal(contract?.id, 'bsk', phrase)
    assert.deepEqual(contract.requiredTools, ['run_command'], phrase)
    assert.equal(actionContractToolSucceeded(contract, 'browser_navigate', '{"ok":true}'), false)
    assert.equal(actionContractToolSucceeded(contract, 'run_command', JSON.stringify({
      ok: true, command: 'bsk doctor', exit_code: 0,
    })), false, 'setup cannot count as task completion')
    assert.equal(actionContractToolSucceeded(contract, 'run_command', JSON.stringify({
      ok: true, command: 'bsk observe --session task', exit_code: 1,
    })), false, 'failed CLI calls cannot count as task completion')
  }
  assert.equal(classifyActionContract('下载到哪里了？'), null)
  const webContract = classifyActionContract('请联网搜索 Electron 官方仓库')
  assert.equal(webContract.id, 'web')
  assert.deepEqual(webContract.requiredTools, ['web_search', 'run_command'])
  const newsContract = classifyActionContract('帮我上网看看今天有什么 AI 新闻，挑三条重要的告诉我，链接也发我一下。')
  assert.equal(newsContract.id, 'web_research')
  assert.equal(newsContract.minimumVerifiedSources, 3)
  assert.equal(inferWebResearchSourceCount('找 5 条最近的消息'), 5)
  assert.equal(collectVerifiedWebResearchSources([{ name: 'browser_navigate', result: '{"ok":true}' }]).length, 0)
  assert.notEqual(actionContractCompletionIssue(newsContract, '已经查好了。', { successfulToolEvidence: [] }), '')

  assert.equal(classifyActionContract('打开人物卡片看看'), null,
    'person-card commands are left to model semantic intent instead of regex action contracts')
  assert.equal(classifyActionContract('人物卡片有点问题，经常错误触发'), null,
    'person-card feature discussions do not create a UI action contract')
  if (process.platform === 'darwin') {
    const explicitMusicPause = classifyActionContract('暂停 Apple Music')
    assert.equal(explicitMusicPause?.id, 'macos_system_music')
    assert.deepEqual(explicitMusicPause.requiredTools, ['system_music'])
    const contextualMusicPause = classifyActionContract('暂停', {
      runtimeContext: '[macOS System Music]\nMusic.app is open. Authoritative playback state: playing.',
    })
    assert.equal(contextualMusicPause?.id, 'macos_system_music', 'live Music.app state makes terse pause an evidenced action')
    assert.equal(classifyActionContract('播放我的 mac 系统里的 Music')?.id, 'macos_system_music')
    assert.equal(classifyActionContract('怎么暂停 Apple Music？'), null, 'music how-to remains ordinary explanation')

    let musicRounds = 0
    const musicCalls = []
    const musicResult = await callLLM({
      systemPrompt: 'system',
      message: '暂停',
      tools: ['system_music'],
      mustReply: true,
      localReply: true,
      toolContext: {
        currentTargetId: 'ID:000001',
        currentUserMessage: '暂停',
        actionContract: contextualMusicPause,
      },
      _streamOnceForTest: async ({ messages }) => {
        musicRounds += 1
        if (musicRounds === 1) return { content: '已经暂停了。', reasoningContent: '', aborted: false, toolCalls: [] }
        if (musicRounds === 2) {
          assert(messages.some(item => String(item.content || '').includes('No matching action has actually run')))
          return {
            content: '', reasoningContent: '', aborted: false,
            toolCalls: [{ id: 'music-pause-1', name: 'system_music', arguments: JSON.stringify({ action: 'pause' }) }],
          }
        }
        return { content: '已暂停《七里香》。', reasoningContent: '', aborted: false, toolCalls: [] }
      },
      _executeToolForTest: async (name, args) => {
        musicCalls.push({ name, args })
        return JSON.stringify({ ok: true, tool: 'system_music', action: 'pause', playback_state: 'paused', title: '七里香' })
      },
    })
    assert.equal(musicRounds, 3, 'a text-only pause claim is replaced by a real Music.app action round')
    assert.deepEqual(musicCalls.filter(call => call.name === 'system_music'), [
      { name: 'system_music', args: { action: 'pause' } },
    ])
    assert.match(musicResult.content, /已暂停/)
  }
  assert.equal(
    resolveActionContractForTurn('帮我在 sandbox 里创建一个 hello.txt 文件', {
      strictEvaluation: { active: true, forbiddenTools: ['write_file'] },
    }),
    null,
    'an action contract never requires a tool forbidden by strict evaluation',
  )

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
      if (socialRounds === 3) {
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: [{ id: 'final-send', name: 'send_message', arguments: JSON.stringify({ target_id: 'ID:000001', content: '文件已创建：sandbox/hello.txt。' }) }],
        }
      }
      return { content: '', reasoningContent: '', aborted: false, toolCalls: [] }
    },
    _executeToolForTest: async (name) => {
      socialExecuted.push(name)
      if (name === 'write_file') return JSON.stringify({ ok: true, path: 'sandbox/hello.txt' })
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      return JSON.stringify({ ok: false, error: 'unexpected tool' })
    },
  })
  assert.equal(socialRounds, 4, 'ordinary final delivery gets a non-terminal reconsideration round')
  assert.deepEqual(socialExecuted, ['write_file', 'send_message'], 'premature social completion was suppressed, not delivered')
  assert.equal(social.delivered, true)

  console.log('test-action-contract passed')
} finally {
  closeDBForTest?.()
  fs.rmSync(tmp, { recursive: true, force: true })
}

process.exit(process.exitCode || 0)
