import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-action-contract-'))
process.env.BAILONGMA_USER_DIR = tmp
process.env.BAILONGMA_RESOURCES_DIR = process.cwd()

let closeDBForTest = null

try {
  const {
    actionContractCompletionIssue,
    actionContractToolSucceeded,
    classifyActionContract,
    resolveActionContractForTurn,
    verifiedActionContractReply,
  } = await import('./runtime/action-contract.js')
  const { callLLM } = await import('./llm.js')
  const { evaluateToolPolicy } = await import('./capabilities/tool-policy.js')
  ;({ closeDBForTest } = await import('./db.js'))

  const writeContract = classifyActionContract('帮我在 sandbox 里创建一个 hello.txt 文件')
  assert.equal(writeContract?.id, 'file_write')
  assert.deepEqual(writeContract.requiredTools, ['write_file'])
  assert.equal(classifyActionContract('帮我新建一个 logs 文件夹')?.id, 'directory_create')
  assert.equal(classifyActionContract('怎么创建一个 txt 文件？'), null, 'how-to is ordinary Q&A, not an execution contract')
  assert.equal(classifyActionContract('你有多少执行命令工具？'), null, 'tool meta questions must not trigger execution')
  assert.equal(classifyActionContract('帮我安装一个 npm 插件'), null, 'plugin installation is not OS software installation')
  const displayContract = classifyActionContract('切换到大浏览器')
  assert.equal(displayContract?.id, 'browser_display_mode')
  assert.deepEqual(displayContract.requiredTools, ['browser_set_display_mode'])
  const browserLoginContract = classifyActionContract('需要你帮我登录我的 X 账号')
  assert.equal(browserLoginContract?.id, 'browser_interaction')
  assert(browserLoginContract.requiredTools.includes('browser_snapshot'))
  assert(browserLoginContract.requiredTools.includes('browser_type'))
  const browserContinuationContract = classifyActionContract('没有被墙，它能走', {
    conversationWindow: [
      { role: 'user', content: '需要你帮我登录我的 X 账号' },
      { role: 'jarvis', content: '我正在用浏览器打开 X 登录页。' },
    ],
  })
  assert.equal(browserContinuationContract?.id, 'browser_interaction')
  assert.equal(classifyActionContract('没有被墙，它能走'), null,
    'an isolated assertion remains ordinary conversation without browser continuity')
  assert.match(actionContractCompletionIssue(
    browserLoginContract,
    'X 登录页已打开，用户名填好了，已经到密码页了。',
    { successfulToolNames: new Set(['browser_snapshot']) },
  ), /navigation|input|later login page/i,
    'a snapshot cannot be laundered into navigation/form completion')
  assert.match(actionContractCompletionIssue(
    browserLoginContract,
    '页面加载出来了，X 登录页正常显示。',
    { successfulToolNames: new Set(['browser_snapshot']) },
  ), /navigation/i,
    'a snapshot cannot be laundered into a page-load claim')
  const closeBrowserContract = classifyActionContract('关掉你的浏览器')
  assert.equal(closeBrowserContract?.id, 'browser_close')
  assert.deepEqual(closeBrowserContract.requiredTools, ['browser_close'])
  for (const phrase of [
    '不要关闭浏览器',
    '保持浏览器打开',
    '别关当前网页',
    '不要退出浏览器',
  ]) {
    assert.notEqual(classifyActionContract(phrase)?.id, 'browser_close',
      `keep-open wording must not create a close contract: ${phrase}`)
  }
  const keepOpenDisplayContract = classifyActionContract(
    '切回你的小窗口浏览器，最后停留在小窗口，不要关闭浏览器',
  )
  assert.equal(keepOpenDisplayContract?.id, 'browser_display_mode')
  assert.deepEqual(keepOpenDisplayContract.requiredTools, ['browser_set_display_mode'])
  for (const phrase of [
    '关掉浏览器',
    '现在真正关掉你的浏览器',
    '关闭当前网页',
    '关掉刚才打开的浏览器',
    '请关掉浏览器，谢谢',
    '那现在怎么办？关掉你的小窗口浏览器',
    '关掉浏览器，不用说话，只回一个👌图标',
    '关掉浏览器，只回复👌',
  ]) {
    const explicitCloseContract = classifyActionContract(phrase)
    assert.equal(explicitCloseContract?.id, 'browser_close', phrase)
    assert.deepEqual(explicitCloseContract.requiredTools, ['browser_close'])
    assert.equal(verifiedActionContractReply(explicitCloseContract), '👌',
      'a successful explicit browser close has one deterministic acknowledgement')
  }
  const closeAfterResearchContract = classifyActionContract('查完 Agent Skill 后关闭浏览器并告诉我结果')
  assert.equal(closeAfterResearchContract?.id, 'browser_close')
  assert.equal(verifiedActionContractReply(closeAfterResearchContract), '',
    'a close inside a larger task must not replace the substantive result')
  assert.equal(verifiedActionContractReply(classifyActionContract('查完后关闭浏览器')), '',
    'unknown substantive wording outside the close clause is preserved by default')
  assert.equal(classifyActionContract('退出这个网站的登录'), null,
    'website sign-out is not a browser lifecycle close')
  for (const phrase of [
    '用大的窗口打开',
    '请用大一点的窗口打开这个网页',
    '用大 窗口 口打',
    '用小的窗口打开',
  ]) {
    const spokenDisplayContract = classifyActionContract(phrase)
    assert.equal(spokenDisplayContract?.id, 'browser_display_mode', phrase)
    assert.deepEqual(spokenDisplayContract.requiredTools, ['browser_set_display_mode'])
  }
  const combinedBrowserContract = classifyActionContract(
    '请用你的浏览器打开 https://example.com，保持停留，不要切换到大窗口。',
  )
  assert.equal(combinedBrowserContract?.id, 'browser_open_in_display_mode')
  assert.deepEqual(combinedBrowserContract.requiredTools, ['browser_navigate'])
  assert.equal(combinedBrowserContract.expectedBrowserDisplayMode, 'card')
  assert.equal(actionContractToolSucceeded(
    combinedBrowserContract,
    'browser_navigate',
    JSON.stringify({ ok: true, browser_preview: { mode: 'card' } }),
  ), true, 'navigation in the requested compact presentation satisfies the combined contract')
  assert.equal(actionContractToolSucceeded(
    combinedBrowserContract,
    'browser_navigate',
    JSON.stringify({ ok: true, browser_preview: { mode: 'window' } }),
  ), false, 'navigation in the wrong presentation cannot satisfy the combined contract')
  const systemBrowserContract = classifyActionContract('用我电脑上的浏览器打开 https://example.com')
  assert.equal(systemBrowserContract?.id, 'system_browser_open')
  assert.deepEqual(systemBrowserContract.requiredTools, ['system_browser_open'])
  assert.match(actionContractCompletionIssue(
    systemBrowserContract,
    '已在默认浏览器 Safari 中打开。三个浏览器各自独立。',
  ), /default browser/i)
  assert.equal(actionContractCompletionIssue(
    systemBrowserContract,
    '已交给电脑的系统默认浏览器打开；小窗和大窗共享页面，电脑浏览器独立。',
  ), '')
  assert.match(verifiedActionContractReply(systemBrowserContract, {
    args: { url: 'https://example.com/' },
    result: JSON.stringify({ ok: true, url: 'https://example.com/' }),
  }), /系统默认浏览器.*小窗口浏览器.*同一个实时页面/s)
  const webContract = classifyActionContract('请联网搜索 Microsoft Playwright MCP 官方仓库')
  assert.equal(webContract?.id, 'web')
  assert.deepEqual(webContract.requiredTools, ['browser_navigate'], 'fresh web lookup requires real Playwright navigation')
  assert.equal(webContract.requiredTools.some(name => ['web_search', 'web_read', 'fetch_url', 'browser_read'].includes(name)), false)
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

  // A successful system-browser handoff still does not prove a concrete app
  // name, and must not be summarized as three independent browser profiles.
  let systemRounds = 0
  const systemExecuted = []
  const systemReply = await callLLM({
    systemPrompt: 'system',
    message: '用我电脑上的浏览器打开 https://example.com',
    tools: ['system_browser_open'],
    mustReply: true,
    localReply: true,
    toolContext: { currentTargetId: 'ID:000001', actionContract: systemBrowserContract },
    _streamOnceForTest: async ({ messages }) => {
      systemRounds += 1
      if (systemRounds === 1) {
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: [{
            id: 'system-open',
            name: 'system_browser_open',
            arguments: JSON.stringify({ url: 'https://example.com/' }),
          }],
        }
      }
      if (systemRounds === 2) {
        return {
          content: '已在 Safari 中打开。三个浏览器各自独立。',
          reasoningContent: '', aborted: false, toolCalls: [],
        }
      }
      assert(messages.some(m => String(m.content || '').includes('do not name Safari')))
      return {
        content: '已交给电脑的系统默认浏览器打开。小窗口和大窗口共享同一个页面，电脑浏览器独立。',
        reasoningContent: '', aborted: false, toolCalls: [],
      }
    },
    _executeToolForTest: async (name) => {
      systemExecuted.push(name)
      if (name === 'system_browser_open') {
        return JSON.stringify({ ok: true, surface: 'system', url: 'https://example.com/' })
      }
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      return JSON.stringify({ ok: false, error: 'unexpected tool' })
    },
  })
  assert.equal(systemRounds, 3, 'unsupported system-browser claims get one correction round')
  assert.deepEqual(systemExecuted, ['system_browser_open', 'send_message'])
  assert.doesNotMatch(systemReply.content, /Safari|三个浏览器各自独立/)
  assert.match(systemReply.content, /系统默认浏览器/)

  let snapshotRounds = 0
  const snapshotExecuted = []
  await callLLM({
    systemPrompt: 'Use the automatic snapshot in each browser action result.',
    message: '打开 https://example.com 并保持浏览器打开',
    tools: ['browser_navigate', 'browser_snapshot'],
    mustReply: true,
    localReply: true,
    toolContext: { currentTargetId: 'ID:000001' },
    _streamOnceForTest: async ({ messages }) => {
      snapshotRounds += 1
      if (snapshotRounds === 1) {
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: [{
            id: 'navigate-with-auto-snapshot',
            name: 'browser_navigate',
            arguments: JSON.stringify({ url: 'https://example.com/' }),
          }],
        }
      }
      assert(messages.some(entry => {
        try {
          const parsed = JSON.parse(String(entry.content || ''))
          return parsed?.content?.some(item => item?.text?.includes('heading "Example Domain" [ref=e1]'))
        } catch { return false }
      }),
        'the next Agent round receives inline accessibility YAML from browser_navigate')
      return { content: '已打开 Example Domain，并保持浏览器打开。', reasoningContent: '', aborted: false, toolCalls: [] }
    },
    _executeToolForTest: async (name) => {
      snapshotExecuted.push(name)
      if (name === 'browser_navigate') {
        return JSON.stringify({
          ok: true,
          content: [{ type: 'text', text: '```yaml\n- heading "Example Domain" [ref=e1]\n```' }],
        })
      }
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      return JSON.stringify({ ok: false, error: 'unexpected tool' })
    },
  })
  assert.equal(snapshotExecuted.includes('browser_snapshot'), false,
    'Agent does not mechanically call browser_snapshot after an action that already returned inline YAML')

  // Regression for the installed-app failure: when a login continuation only
  // produces prose, the runtime must suppress it, insist on a real browser
  // action, and reject the same fabricated claims after a mere snapshot.
  let loginRounds = 0
  const loginExecuted = []
  const loginResult = await callLLM({
    systemPrompt: 'Follow the current browser task.',
    message: '没有被墙，它能走',
    tools: browserLoginContract.requiredTools,
    mustReply: true,
    localReply: true,
    toolContext: {
      currentTargetId: 'ID:000001',
      actionContract: browserContinuationContract,
    },
    _streamOnceForTest: async ({ messages }) => {
      loginRounds += 1
      if (loginRounds === 1) {
        return {
          content: '页面加载出来了，用户名填好了，已经到密码页了。',
          reasoningContent: '', aborted: false, toolCalls: [],
        }
      }
      if (loginRounds === 2) {
        assert(messages.some(m => String(m.content || '').includes('No matching action has actually run')))
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: [{ id: 'login-snapshot', name: 'browser_snapshot', arguments: '{}' }],
        }
      }
      if (loginRounds === 3) {
        return {
          content: '页面加载出来了，用户名填好了，已经到密码页了。',
          reasoningContent: '', aborted: false, toolCalls: [],
        }
      }
      assert(messages.some(m => String(m.content || '').includes('Reply from verified evidence only')))
      return {
        content: '我已检查当前页面；尚未执行输入或提交，也不能确认已登录。',
        reasoningContent: '', aborted: false, toolCalls: [],
      }
    },
    _executeToolForTest: async name => {
      loginExecuted.push(name)
      if (name === 'browser_snapshot') return JSON.stringify({ ok: true, content: [{ type: 'text', text: 'X login page' }] })
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      return JSON.stringify({ ok: false, error: 'unexpected tool' })
    },
  })
  assert.equal(loginRounds, 4)
  assert.deepEqual(loginExecuted, ['browser_snapshot', 'send_message'])
  assert.match(loginResult.content, /尚未执行输入或提交/)
  assert.doesNotMatch(loginResult.content, /密码页|填好了/)

  let realBrowserCloseCalls = 0
  let keepOpenRounds = 0
  await callLLM({
    systemPrompt: 'Follow the current user request.',
    message: '不要关闭浏览器',
    tools: ['browser_close'],
    mustReply: true,
    localReply: true,
    toolContext: { currentTargetId: 'ID:000001', currentUserMessage: '不要关闭浏览器' },
    _streamOnceForTest: async () => {
      keepOpenRounds += 1
      if (keepOpenRounds === 1) {
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: [{ id: 'wrong-close', name: 'browser_close', arguments: '{}' }],
        }
      }
      return { content: '浏览器会保持打开。', reasoningContent: '', aborted: false, toolCalls: [] }
    },
    _executeToolForTest: async (name, args, context) => {
      const policy = evaluateToolPolicy(name, args, context)
      if (!policy.allowed) return JSON.stringify({ ok: false, error: 'permission denied', policy })
      if (name === 'browser_close') realBrowserCloseCalls += 1
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      return JSON.stringify({ ok: true })
    },
  })
  assert.equal(realBrowserCloseCalls, 0,
    'an erroneous model browser_close is rejected before the real close implementation runs')

  let closeReplyRounds = 0
  const closeReplyMessages = []
  const closeReplyResult = await callLLM({
    systemPrompt: 'Follow the current user request.',
    message: '关掉浏览器',
    tools: ['browser_close', 'send_message'],
    mustReply: true,
    localReply: true,
    toolContext: {
      currentTargetId: 'ID:000001',
      currentUserMessage: '关掉浏览器',
      actionContract: closeBrowserContract,
    },
    _streamOnceForTest: async () => {
      closeReplyRounds += 1
      if (closeReplyRounds === 1) {
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: [{ id: 'close-browser', name: 'browser_close', arguments: '{}' }],
        }
      }
      return {
        content: '关掉了。Bing 搜索页面已关闭，profile 数据保留着。',
        reasoningContent: '',
        aborted: false,
        toolCalls: [],
      }
    },
    _executeToolForTest: async (name, args) => {
      if (name === 'browser_close') return JSON.stringify({ ok: true, closed: true })
      if (name === 'send_message') {
        closeReplyMessages.push(args.content)
        return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      }
      return JSON.stringify({ ok: false, error: 'unexpected tool' })
    },
  })
  assert.deepEqual(closeReplyMessages, ['👌'],
    'runtime fallback replaces a verbose browser-close draft with one emoji')
  assert.equal(closeReplyResult.content, '👌')
  assert.equal(closeReplyRounds, 1,
    'a successful standalone close does not spend another provider round on narration')

  let externalCloseRounds = 0
  const externalCloseMessages = []
  await callLLM({
    systemPrompt: 'Follow the current user request.',
    message: '关闭当前页面',
    tools: ['browser_close', 'send_message'],
    mustReply: true,
    localReply: false,
    toolContext: {
      currentTargetId: 'ID:000001',
      currentUserMessage: '关闭当前页面',
      actionContract: closeBrowserContract,
    },
    _streamOnceForTest: async () => {
      externalCloseRounds += 1
      if (externalCloseRounds === 1) {
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: [{ id: 'external-close-browser', name: 'browser_close', arguments: '{}' }],
        }
      }
      if (externalCloseRounds === 2) {
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: [{
            id: 'verbose-close-reply',
            name: 'send_message',
            arguments: JSON.stringify({
              target_id: 'ID:000001',
              content: '浏览器窗口已关闭，Cookie 和 profile 都还在。',
            }),
          }],
        }
      }
      return { content: '', reasoningContent: '', aborted: false, toolCalls: [] }
    },
    _executeToolForTest: async (name, args) => {
      if (name === 'browser_close') return JSON.stringify({ ok: true, closed: true })
      if (name === 'send_message') {
        externalCloseMessages.push(args.content)
        return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      }
      return JSON.stringify({ ok: false, error: 'unexpected tool' })
    },
  })
  assert.deepEqual(externalCloseMessages, ['👌'],
    'explicit send_message content is normalized after a successful browser close')
  assert.equal(externalCloseRounds, 1,
    'external delivery also uses the runtime-owned close acknowledgement immediately')
  console.log('test-action-contract passed')
} finally {
  closeDBForTest?.()
  fs.rmSync(tmp, { recursive: true, force: true })
}

process.exit(process.exitCode || 0)
