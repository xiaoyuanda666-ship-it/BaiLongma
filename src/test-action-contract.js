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
  assert.equal(classifyActionContract('帮我新建一个 logs 文件夹')?.id, 'directory_create')
  assert.equal(classifyActionContract('怎么创建一个 txt 文件？'), null, 'how-to is ordinary Q&A, not an execution contract')
  assert.equal(classifyActionContract('你有多少执行命令工具？'), null, 'tool meta questions must not trigger execution')
  assert.equal(classifyActionContract('帮我安装一个 npm 插件'), null, 'plugin installation is not OS software installation')
  for (const phrase of [
    '只读验收，不要创建或修改任何文件',
    '不要删除任何文件',
    '别运行命令或启动程序',
    '请勿安装任何软件',
    '不用设置提醒',
    '禁止打开热点面板',
    'do not run the command',
    'never install this app',
  ]) {
    assert.equal(classifyActionContract(phrase), null,
      `explicitly forbidden work must not become an action contract: ${phrase}`)
  }
  assert.equal(
    classifyActionContract('不要删除旧文件，但创建一个新的 txt 文件')?.id,
    'file_write',
    'a negated clause must not erase a separate positive action',
  )
  assert.equal(
    classifyActionContract('创建一个新的 txt 文件时不要覆盖旧文件')?.id,
    'file_write',
    'a trailing negative constraint must preserve the positive action',
  )
  assert.equal(
    resolveActionContractForTurn('这次只读取现有文件，不要创建或修改任何文件'),
    null,
    'the live read-only verification wording must not force write_file',
  )
  const displayContract = classifyActionContract('切换到大浏览器')
  assert.equal(displayContract?.id, 'browser_display_mode')
  assert.deepEqual(displayContract.requiredTools, ['browser_set_display_mode'])
  assert.match(actionContractCompletionIssue(
    displayContract,
    '已经全屏显示。',
  ), /window mode|fullscreen/i, 'window mode cannot be described as fullscreen')
  assert.equal(verifiedActionContractReply(displayContract, {
    result: JSON.stringify({ ok: true, browser_preview: { mode: 'window' } }),
  }), '已切换到独立大窗口。')
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
  const screenshotContract = classifyActionContract('把当前页面截张图发给我看看')
  assert.equal(screenshotContract?.id, 'browser_screenshot')
  assert.deepEqual(screenshotContract.requiredTools, ['browser_take_screenshot'])
  const screenshotPath = path.join(tmp, 'captured-page.png')
  const screenshotEvidence = [{
    name: 'browser_take_screenshot',
    result: JSON.stringify({ ok: true, screenshot: { image_path: screenshotPath } }),
  }]
  assert.equal(browserScreenshotPathFromEvidence(screenshotEvidence), screenshotPath)
  assert.equal(browserScreenshotDeliveryMatches(screenshotEvidence, { image_path: screenshotPath }), true)
  assert.equal(browserScreenshotDeliveryMatches(screenshotEvidence, { image_path: `${screenshotPath}.other` }), false)
  assert.match(actionContractCompletionIssue(
    screenshotContract,
    '截图发好了。',
    { successfulToolEvidence: screenshotEvidence },
  ), /not delivered/i, 'capture without media delivery cannot be described as sent')
  assert.equal(actionContractCompletionIssue(
    screenshotContract,
    '',
    { successfulToolEvidence: screenshotEvidence, messageArgs: { image_path: screenshotPath } },
  ), '', 'send_message with the exact captured image path satisfies screenshot delivery')
  const screenshotScopedMemories = filterMemoriesForActionContract([
    {
      mem_id: 'procedure_browser_display_mode_first',
      content: '截图前先调用 browser_set_display_mode，再调用 browser_take_screenshot。',
    },
    {
      mem_id: 'lesson_browser_screenshot_image_not_forwardable',
      content: '截图无法通过 send_message 发送。',
    },
    {
      mem_id: 'fact_browser_screenshot_current',
      content: 'browser_take_screenshot 会返回持久化 image_path。',
    },
  ], screenshotContract)
  assert.deepEqual(screenshotScopedMemories.map(item => item.mem_id), ['fact_browser_screenshot_current'],
    'obsolete memories cannot expand or contradict the authoritative screenshot contract')

  const pageFindContract = classifyActionContract('机器学习在这页出现几次')
  assert.equal(pageFindContract?.id, 'browser_page_find')
  assert.equal(pageFindContract.query, '机器学习')
  assert.deepEqual(pageFindContract.requiredTools, ['browser_find'])
  const pageFindEvidence = [{
    name: 'browser_find',
    result: JSON.stringify({
      ok: true,
      structured_content: {
        page_find: {
          query: '机器学习', found: true, total_matches: 4, current_match: 1,
          source: 'rendered_page_text', url: 'https://zh.wikipedia.org/wiki/人工智能',
        },
      },
    }),
  }]
  assert.equal(browserPageFindResultFromEvidence(pageFindEvidence)?.total_matches, 4)
  assert.equal(actionContractToolSucceeded(
    pageFindContract,
    'browser_find',
    pageFindEvidence[0].result,
    { text: '机器学习' },
  ), true)
  assert.equal(verifiedActionContractReply(pageFindContract, pageFindEvidence[0], {
    successfulToolEvidence: pageFindEvidence,
  }), '当前页面里找到了“机器学习”，共出现 4 处。')

  const browserConversation = [{ role: 'jarvis', content: '当前浏览器页面已打开。' }]
  const directBrowserCases = [
    ['刷新一下。', 'browser_reload', 'browser_reload'],
    ['往下翻一屏。', 'browser_scroll', 'browser_press_key'],
    ['回到上一页。', 'browser_back', 'browser_navigate_back'],
    ['回搜索结果列表页。', 'browser_back', 'browser_navigate_back'],
    ['不是详情页，我要回搜索结果列表页。', 'browser_back', 'browser_navigate_back'],
    ['不对，回搜索结果列表。', 'browser_back', 'browser_navigate_back'],
    ['我说的是结果页。', 'browser_back', 'browser_navigate_back'],
    ['别进详情，回列表。', 'browser_back', 'browser_navigate_back'],
    ['回刚才的搜索结果页。', 'browser_back', 'browser_navigate_back'],
    ['再往前。', 'browser_forward', 'browser_navigate_forward'],
    ['放大一点。', 'browser_display_mode', 'browser_set_display_mode'],
    ['现在有几个标签页？', 'browser_tabs_list', 'browser_tabs'],
    ['重新打开 example.com。', 'browser_reopen', 'browser_navigate'],
    ['浏览器关一下。', 'browser_close', 'browser_close'],
    ['行，缩回小卡片吧。', 'browser_display_mode', 'browser_set_display_mode'],
    ['打开 DuckDuckGo。', 'browser_open_url', 'browser_navigate'],
  ]
  for (const [phrase, id, tool] of directBrowserCases) {
    const contract = classifyActionContract(phrase, { conversationWindow: browserConversation })
    assert.equal(contract?.id, id, phrase)
    assert.deepEqual(contract.requiredTools, [tool], phrase)
    const finalized = finalizeToolInjection({
      initialTools: ['send_message', 'find_tool', 'download_file', 'run_command', 'browser_navigate', 'browser_find', tool],
      actionContract: contract,
      localReply: false,
    })
    assert.equal(finalized.turnTools.includes(tool), true, phrase)
    assert.equal(finalized.turnTools.includes('find_tool'), false, `${phrase} does not waste a find_tool call`)
  }
  const directUrlContract = classifyActionContract('打开 https://zh.wikipedia.org/wiki/人工智能')
  assert.equal(directUrlContract?.id, 'browser_open_url')
  assert.deepEqual(directUrlContract.requiredTools, ['browser_navigate'])
  assert.equal(directUrlContract.directBrowserAction, true)
  assert.equal(actionContractToolSucceeded(
    directUrlContract,
    'browser_navigate',
    JSON.stringify({ ok: true, browser_preview: { url: directUrlContract.expectedUrl } }),
    { url: directUrlContract.expectedUrl },
  ), true)
  const narrowedFind = finalizeToolInjection({
    initialTools: ['send_message', 'find_tool', 'download_file', 'run_command', 'exec_command', 'browser_navigate', 'browser_find'],
    actionContract: pageFindContract,
    localReply: false,
  })
  assert.deepEqual(narrowedFind.turnTools, ['send_message', 'browser_find'])
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

  let directNavigateRounds = 0
  const directNavigateCalls = []
  const directNavigateResult = await callLLM({
    systemPrompt: 'Open the exact requested URL.',
    message: '打开 https://example.com',
    tools: ['browser_navigate', 'send_message'],
    mustReply: true,
    localReply: true,
    toolContext: {
      currentTargetId: 'ID:000001',
      currentUserMessage: '打开 https://example.com',
      actionContract: classifyActionContract('打开 https://example.com'),
    },
    _streamOnceForTest: async () => {
      directNavigateRounds += 1
      if (directNavigateRounds > 1) throw new Error('direct URL navigation should converge without another provider round')
      return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{
          id: 'direct-url-navigation',
          name: 'browser_navigate',
          arguments: JSON.stringify({ url: 'https://example.com/' }),
        }],
      }
    },
    _executeToolForTest: async (name, args, context) => {
      directNavigateCalls.push({ name, args, source: context?.source || '' })
      if (name === 'browser_navigate') {
        return JSON.stringify({ ok: true, browser_preview: { url: 'https://example.com/' } })
      }
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      return JSON.stringify({ ok: false, error: `unexpected tool ${name}` })
    },
  })
  assert.deepEqual(directNavigateCalls.map(call => call.name), ['browser_navigate', 'send_message'])
  assert.equal(directNavigateCalls.filter(call => call.name === 'send_message').length, 1,
    'a direct URL navigation sends one completion message and no slow-tool acknowledgement')
  assert.doesNotMatch(directNavigateCalls.at(-1).args.content, /我查一下/)
  assert.equal(directNavigateCalls.at(-1).args.content, '已打开 https://example.com/')
  assert.equal(directNavigateResult.delivered, true)

  const naturalAcks = Array.from({ length: 5 }, () => slowAckText('browser_navigate', {
    url: 'https://example.com/private/path?query=do-not-echo',
  }))
  assert.equal(new Set(naturalAcks).size, 5, 'lookup progress acknowledgements rotate naturally')
  for (const ack of naturalAcks) {
    assert.doesNotMatch(ack, /https?:\/\/|example\.com|do-not-echo/,
      'lookup progress acknowledgements never expose a URL or query parameter')
  }

  const searchSubmitContract = classifyActionContract('在搜索框输入 OpenAI 官网并搜索。', {
    conversationWindow: browserConversation,
  })
  assert.equal(searchSubmitContract?.id, 'browser_search_submit')
  assert.equal(searchSubmitContract.query, 'OpenAI 官网')
  assert.equal(searchSubmitContract.requireAllTools, true)
  assert.deepEqual(searchSubmitContract.requiredTools, ['browser_snapshot', 'browser_type', 'browser_click'])
  const searchSubmitInjection = finalizeToolInjection({
    initialTools: ['send_message', 'find_tool', 'browser_navigate', 'browser_press_key'],
    actionContract: searchSubmitContract,
    localReply: false,
  })
  assert.deepEqual(searchSubmitInjection.turnTools,
    ['send_message', 'browser_snapshot', 'browser_type', 'browser_click'])

  let searchSubmitRounds = 0
  const searchSubmitCalls = []
  const searchSubmitResult = await callLLM({
    systemPrompt: 'Use the current search box exactly once.',
    message: '在搜索框输入 OpenAI 官网并搜索。',
    tools: searchSubmitInjection.turnTools,
    mustReply: true,
    localReply: true,
    toolContext: {
      currentTargetId: 'ID:000001',
      currentUserMessage: '在搜索框输入 OpenAI 官网并搜索。',
      actionContract: searchSubmitContract,
    },
    _streamOnceForTest: async () => {
      searchSubmitRounds += 1
      if (searchSubmitRounds === 1) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'search-snapshot', name: 'browser_snapshot', arguments: '{}' }],
      }
      if (searchSubmitRounds === 2) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'search-type', name: 'browser_type', arguments: JSON.stringify({ uid: '1_1', text: 'OpenAI 官网' }) }],
      }
      if (searchSubmitRounds === 3) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'search-click', name: 'browser_click', arguments: JSON.stringify({ uid: '1_2', element: '搜索按钮' }) }],
      }
      throw new Error('successful search click must end the tool loop before duplicate type/Enter/navigation')
    },
    _executeToolForTest: async (name, args) => {
      searchSubmitCalls.push({ name, args })
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      if (name === 'browser_click') {
        return JSON.stringify({
          ok: true,
          browser_preview: { url: 'https://duckduckgo.com/?q=OpenAI', title: 'OpenAI at DuckDuckGo' },
          content: [{ type: 'text', text: 'Search results for OpenAI\nlink OpenAI\nlink OpenAI API' }],
        })
      }
      return JSON.stringify({
        ok: true,
        browser_preview: { url: 'https://duckduckgo.com/', title: 'DuckDuckGo' },
        content: [{ type: 'text', text: 'Search the web without being tracked' }],
      })
    },
  })
  assert.deepEqual(searchSubmitCalls.map(call => call.name),
    ['browser_snapshot', 'browser_type', 'browser_click', 'send_message'])
  assert.equal(searchSubmitCalls[1].args.replace, true,
    'search browser_type always replaces a prefilled field instead of appending')
  assert.equal(searchSubmitCalls.at(-1).args.content, '已搜索“OpenAI 官网”。')
  assert.equal(searchSubmitResult.delivered, true)

  assert.match(actionContractToolCallIssue(
    searchSubmitContract,
    'browser_click',
    { uid: '1_1', element: '搜索框' },
    { successfulToolNames: new Set(['browser_snapshot']) },
  ), /browser_type.*next/i, 'clicking the search field before typing is rejected by the ordered contract')
  assert.match(actionContractToolCallIssue(
    searchSubmitContract,
    'browser_click',
    { uid: '2_2', element: '清除本文按钮' },
    { successfulToolNames: new Set(['browser_snapshot', 'browser_type']) },
  ), /actual search-submit control/i, 'clear/voice/image controls cannot consume the one submit click')
  assert.equal(actionContractToolCallIssue(
    searchSubmitContract,
    'browser_click',
    { search_submit: true, element: 'search submit' },
    { successfulToolNames: new Set(['browser_snapshot', 'browser_type']) },
  ), '', 'a missing accessibility button can use the one form-submit click fallback')

  let orderedSearchRounds = 0
  const orderedSearchExecuted = []
  const orderedSearchResult = await callLLM({
    systemPrompt: 'Recover from invalid search-target choices without changing the fixed action order.',
    message: '在搜索框输入 OpenAI 官网并搜索。',
    tools: searchSubmitInjection.turnTools,
    mustReply: true,
    localReply: true,
    toolContext: {
      currentTargetId: 'ID:000001',
      currentUserMessage: '在搜索框输入 OpenAI 官网并搜索。',
      actionContract: searchSubmitContract,
    },
    _streamOnceForTest: async () => {
      orderedSearchRounds += 1
      if (orderedSearchRounds === 1) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'ordered-snapshot', name: 'browser_snapshot', arguments: '{}' }],
      }
      if (orderedSearchRounds === 2) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'premature-searchbox-click', name: 'browser_click', arguments: JSON.stringify({ uid: '1_1', element: '搜索框' }) }],
      }
      if (orderedSearchRounds === 3) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'ordered-type', name: 'browser_type', arguments: JSON.stringify({ uid: '1_1', text: 'OpenAI 官网' }) }],
      }
      if (orderedSearchRounds === 4) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'invalid-clear-click', name: 'browser_click', arguments: JSON.stringify({ uid: '2_2', element: '清除本文按钮' }) }],
      }
      if (orderedSearchRounds === 5) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'fallback-search-submit', name: 'browser_click', arguments: JSON.stringify({ search_submit: true, element: 'search submit' }) }],
      }
      throw new Error('verified ordered search must converge after its one valid submit click')
    },
    _executeToolForTest: async (name, args) => {
      orderedSearchExecuted.push({ name, args })
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      if (name === 'browser_click') return JSON.stringify({
        ok: true,
        browser_preview: { url: 'https://duckduckgo.com/?q=OpenAI', title: 'OpenAI at DuckDuckGo' },
        content: [{ type: 'text', text: 'Search results for OpenAI\nlink OpenAI\nlink OpenAI API' }],
      })
      return JSON.stringify({
        ok: true,
        browser_preview: { url: 'https://duckduckgo.com/', title: 'DuckDuckGo' },
        content: [{ type: 'text', text: 'Search the web without being tracked' }],
      })
    },
  })
  assert.deepEqual(orderedSearchExecuted.map(call => call.name),
    ['browser_snapshot', 'browser_type', 'browser_click', 'send_message'],
    'out-of-order focus/clear clicks stay private and cannot consume the public search sequence')
  assert.equal(orderedSearchExecuted[1].args.replace, true)
  assert.equal(orderedSearchExecuted[2].args.search_submit, true)
  assert.equal(orderedSearchResult.delivered, true)

  const unchangedSearchEvidence = [
    {
      name: 'browser_snapshot',
      args: {},
      result: JSON.stringify({
        ok: true,
        browser_preview: { url: 'https://duckduckgo.com/', title: 'DuckDuckGo' },
        content: [{ type: 'text', text: 'Search the web without being tracked' }],
      }),
    },
    {
      name: 'browser_type',
      args: { uid: '1_1', text: 'OpenAI 官网' },
      result: JSON.stringify({
        ok: true,
        browser_preview: { url: 'https://duckduckgo.com/', title: 'DuckDuckGo' },
        content: [{ type: 'text', text: 'Search the web without being tracked' }],
      }),
    },
  ]
  const unchangedSearchClick = JSON.stringify({
    ok: true,
    browser_preview: { url: 'https://duckduckgo.com/', title: 'DuckDuckGo' },
    structured_content: {
      page_change: {
        before_url: 'https://duckduckgo.com/',
        after_url: 'https://duckduckgo.com/',
        url_changed: false,
      },
    },
    content: [{ type: 'text', text: 'Search the web without being tracked' }],
  })
  assert.equal(actionContractToolSucceeded(
    searchSubmitContract,
    'browser_click',
    unchangedSearchClick,
    { uid: '1_2', element: '搜索按钮' },
    { successfulToolEvidence: unchangedSearchEvidence },
  ), false, 'ok=true click without URL/title/results-state change cannot complete a search')
  assert.match(actionContractToolCallIssue(
    searchSubmitContract,
    'browser_type',
    { uid: '1_1', text: 'OpenAI 官网' },
    { attemptedToolNames: ['browser_snapshot', 'browser_type', 'browser_click'] },
  ), /single-use/i, 'a failed submit never authorizes typing the same query again')

  let failedSearchRounds = 0
  const failedSearchExecuted = []
  const failedSearchResult = await callLLM({
    systemPrompt: 'Use the current search box exactly once and report failure honestly.',
    message: '在搜索框输入 OpenAI 官网并搜索。',
    tools: searchSubmitInjection.turnTools,
    mustReply: true,
    localReply: true,
    toolContext: {
      currentTargetId: 'ID:000001',
      currentUserMessage: '在搜索框输入 OpenAI 官网并搜索。',
      actionContract: searchSubmitContract,
    },
    _streamOnceForTest: async () => {
      failedSearchRounds += 1
      if (failedSearchRounds === 1) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'failed-search-snapshot', name: 'browser_snapshot', arguments: '{}' }],
      }
      if (failedSearchRounds === 2) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'failed-search-type', name: 'browser_type', arguments: JSON.stringify({ uid: '1_1', text: 'OpenAI 官网' }) }],
      }
      if (failedSearchRounds === 3) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'failed-search-click', name: 'browser_click', arguments: JSON.stringify({ uid: '1_2', element: '搜索按钮' }) }],
      }
      if (failedSearchRounds === 4) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'false-search-completion', name: 'send_message', arguments: JSON.stringify({ target_id: 'ID:000001', content: '已搜索“OpenAI 官网”。' }) }],
      }
      if (failedSearchRounds === 5) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'duplicate-search-type', name: 'browser_type', arguments: JSON.stringify({ uid: '1_1', text: 'OpenAI 官网' }) }],
      }
      if (failedSearchRounds === 6) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{
          id: 'honest-search-failure',
          name: 'send_message',
          arguments: JSON.stringify({ target_id: 'ID:000001', content: '点击搜索按钮后页面没有进入结果页，搜索没有生效。' }),
        }],
      }
      return { content: '', reasoningContent: '', aborted: false, toolCalls: [] }
    },
    _executeToolForTest: async (name, args) => {
      failedSearchExecuted.push({ name, args })
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      if (name === 'browser_click') return unchangedSearchClick
      return unchangedSearchEvidence.find(item => item.name === name)?.result
        || JSON.stringify({ ok: false, error: `unexpected tool ${name}` })
    },
  })
  assert.deepEqual(failedSearchExecuted.map(call => call.name),
    ['browser_snapshot', 'browser_type', 'browser_click', 'send_message'],
    'unchanged search state permits only one type, one submit, and one honest final send')
  assert.equal(failedSearchExecuted.at(-1).args.content, '点击搜索按钮后页面没有进入结果页，搜索没有生效。')
  assert.doesNotMatch(failedSearchResult.content, /已搜索/)
  assert.equal(failedSearchResult.delivered, true)

  const resultClickContract = classifyActionContract('点开第二个搜索结果。', {
    conversationWindow: browserConversation,
  })
  assert.equal(resultClickContract?.id, 'browser_search_result_click')
  assert.equal(resultClickContract.resultOrdinal, 2)
  assert.equal(resultClickContract.requireAllTools, true)
  const resultClickInjection = finalizeToolInjection({
    initialTools: ['send_message', 'find_tool', 'browser_navigate'],
    actionContract: resultClickContract,
    localReply: false,
  })
  assert.deepEqual(resultClickInjection.turnTools, ['send_message', 'browser_snapshot', 'browser_click'])

  let resultClickRounds = 0
  const resultClickCalls = []
  await callLLM({
    systemPrompt: 'Click the numbered result.',
    message: '点开第二个搜索结果。',
    tools: resultClickInjection.turnTools,
    mustReply: true,
    localReply: true,
    toolContext: {
      currentTargetId: 'ID:000001',
      currentUserMessage: '点开第二个搜索结果。',
      actionContract: resultClickContract,
    },
    _streamOnceForTest: async () => {
      resultClickRounds += 1
      if (resultClickRounds === 1) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'result-snapshot', name: 'browser_snapshot', arguments: '{}' }],
      }
      if (resultClickRounds === 2) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'result-click', name: 'browser_click', arguments: JSON.stringify({ uid: '2_2', element: '第二个搜索结果' }) }],
      }
      throw new Error('successful numbered-result click must end without find_tool or browser_navigate')
    },
    _executeToolForTest: async (name, args) => {
      resultClickCalls.push({ name, args })
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      return JSON.stringify({ ok: true, browser_preview: { url: 'https://openai.com/zh-Hans-CN/' } })
    },
  })
  assert.deepEqual(resultClickCalls.map(call => call.name), ['browser_snapshot', 'browser_click', 'send_message'])
  assert.equal(resultClickCalls.at(-1).args.content, '已点开第二个搜索结果。')

  const officialSiteContract = classifyActionContract('再帮我查查 Electron 官方网站。')
  assert.equal(officialSiteContract?.id, 'browser_official_site_lookup')
  assert.equal(officialSiteContract.officialSiteTarget, 'Electron')
  const officialSiteInjection = finalizeToolInjection({
    initialTools: ['send_message', 'find_tool', 'browser_press_key', 'browser_navigate'],
    actionContract: officialSiteContract,
    localReply: false,
  })
  assert.deepEqual(officialSiteInjection.turnTools,
    ['send_message', 'browser_navigate', 'browser_type', 'browser_click'])
  assert.match(actionContractToolCallIssue(
    officialSiteContract,
    'browser_navigate',
    { url: 'https://www.bing.com/search?q=Electron' },
  ), /search-engine results URL/i)

  let officialSiteRounds = 0
  const officialSiteCalls = []
  const officialSiteResult = await callLLM({
    systemPrompt: 'Open and verify the authoritative official site.',
    message: '再帮我查查 Electron 官方网站。',
    tools: officialSiteInjection.turnTools,
    mustReply: true,
    localReply: true,
    toolContext: {
      currentTargetId: 'ID:000001',
      currentUserMessage: '再帮我查查 Electron 官方网站。',
      actionContract: officialSiteContract,
    },
    _streamOnceForTest: async () => {
      officialSiteRounds += 1
      if (officialSiteRounds === 1) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{
          id: 'blocked-direct-search-url',
          name: 'browser_navigate',
          arguments: JSON.stringify({ url: 'https://www.bing.com/search?q=Electron' }),
        }],
      }
      if (officialSiteRounds === 2) return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{
          id: 'open-electron-official',
          name: 'browser_navigate',
          arguments: JSON.stringify({ url: 'https://www.electronjs.org/' }),
        }],
      }
      throw new Error('verified official-site navigation must converge immediately')
    },
    _executeToolForTest: async (name, args) => {
      officialSiteCalls.push({ name, args })
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      if (name === 'browser_navigate') return JSON.stringify({
        ok: true,
        browser_preview: { url: 'https://www.electronjs.org/', title: 'Electron' },
        content: [{ type: 'text', text: 'Electron | Build cross-platform desktop apps with JavaScript' }],
      })
      return JSON.stringify({ ok: false, error: `unexpected tool ${name}` })
    },
  })
  assert.deepEqual(officialSiteCalls.map(call => call.name), ['browser_navigate', 'send_message'])
  assert.equal(officialSiteCalls[0].args.url, 'https://www.electronjs.org/')
  assert.match(officialSiteCalls[1].args.content, /electronjs\.org/)
  assert.equal(officialSiteResult.delivered, true)
  assert.equal(classifyActionContract('我只是随口说说，不用查查'), null)

  const webContract = classifyActionContract('请联网搜索 Microsoft Playwright MCP 官方仓库')
  assert.equal(webContract?.id, 'web')
  assert.deepEqual(webContract.requiredTools, ['browser_navigate'], 'fresh web lookup requires real Playwright navigation')
  assert.equal(webContract.requiredTools.some(name => ['web_search', 'web_read', 'fetch_url', 'browser_read'].includes(name)), false)
  const newsContract = classifyActionContract(
    '小白龙，帮我上网看看今天有什么 AI 新闻，挑三条重要的告诉我，链接也发我一下。',
  )
  assert.equal(newsContract?.id, 'web_research', 'ordinary current-news wording activates verified web research')
  assert.deepEqual(newsContract.requiredTools, ['browser_navigate', 'browser_click'])
  assert.equal(newsContract.minimumVerifiedSources, 3)
  assert.equal(classifyActionContract('AI 最近有啥大事？')?.id, 'web_research')
  assert.equal(classifyActionContract('这两天科技圈发生啥了？')?.id, 'web_research')
  assert.equal(classifyActionContract('现在比特币多少钱？')?.id, 'web')
  assert.equal(inferWebResearchSourceCount('找 5 条最近的消息'), 5)
  assert.equal(inferWebResearchSourceCount('挑两篇最新报道'), 2)
  assert.equal(inferWebResearchSourceCount('这个新闻怎么回事？'), 1)

  const webEvidence = (url, title, { busy = false, failure = '' } = {}) => ({
    name: 'browser_navigate',
    args: { url },
    result: JSON.stringify({
      ok: true,
      content: [{ type: 'text', text: `${failure}${title} ${'article body '.repeat(20)}` }],
      structured_content: {
        snapshot: { role: 'RootWebArea', name: title, url, busy },
      },
    }),
  })
  const searchOnlyEvidence = [webEvidence(
    'https://www.bing.com/news/search?q=AI',
    'AI News - Search',
  )]
  assert.equal(collectVerifiedWebResearchSources(searchOnlyEvidence).length, 0,
    'a search-results page is discovery, not a verified source')
  assert.match(actionContractCompletionIssue(
    newsContract,
    '找到三条：https://www.bing.com/news/search?q=AI',
    { successfulToolEvidence: searchOnlyEvidence },
  ), /search-results page|actually opened/i)

  const verifiedNewsEvidence = [
    webEvidence('https://news.example.com/articles/alpha', 'Alpha AI release'),
    webEvidence('https://company.example.com/news/beta', 'Beta model announcement'),
    webEvidence('https://research.example.com/updates/gamma', 'Gamma research update'),
  ]
  const verifiedNewsReply = [
    '1. Alpha https://news.example.com/articles/alpha',
    '2. Beta https://company.example.com/news/beta',
    '3. Gamma https://research.example.com/updates/gamma',
  ].join('\n')
  assert.equal(collectVerifiedWebResearchSources(verifiedNewsEvidence).length, 3)
  assert.equal(collectVerifiedWebResearchSources([
    webEvidence('https://one.example.com/news/gpt-next', 'OpenAI launches GPT-Next today'),
    webEvidence('https://two.example.com/articles/gpt-next', 'OpenAI launches GPT-Next today - Another Outlet'),
  ]).length, 1, 'near-identical headlines on different URLs count as one event')
  assert.equal(actionContractCompletionIssue(
    newsContract,
    verifiedNewsReply,
    { successfulToolEvidence: verifiedNewsEvidence },
  ), '', 'three opened source pages plus their verified links satisfy the news research gate')
  assert.equal(actionContractCompletionIssue(
    newsContract,
    `${verifiedNewsReply}.`,
    { successfulToolEvidence: verifiedNewsEvidence },
  ), '', 'ordinary sentence punctuation after a URL does not invalidate a verified link')
  assert.match(actionContractCompletionIssue(
    newsContract,
    '只放两个链接：https://news.example.com/articles/alpha https://company.example.com/news/beta',
    { successfulToolEvidence: verifiedNewsEvidence },
  ), /only 2 of 3 links/i)
  assert.equal(collectVerifiedWebResearchSources([
    webEvidence('https://news.example.com/articles/timeout', 'Timed out article', {
      busy: true,
      failure: 'Navigation timeout of 10000 ms exceeded. ',
    }),
  ]).length, 0, 'busy or timed-out article pages cannot become verified evidence')

  let researchRounds = 0
  const researchExecuted = []
  const researchResult = await callLLM({
    systemPrompt: 'Search current news and verify original source pages.',
    message: '帮我上网看看今天有什么 AI 新闻，挑三条告诉我，链接也发我。',
    tools: newsContract.requiredTools,
    mustReply: true,
    localReply: true,
    toolContext: {
      currentTargetId: 'ID:000001',
      currentUserMessage: '帮我上网看看今天有什么 AI 新闻，挑三条告诉我，链接也发我。',
      actionContract: newsContract,
    },
    _streamOnceForTest: async ({ messages }) => {
      researchRounds += 1
      if (researchRounds === 1) {
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: [{
            id: 'research-search',
            name: 'browser_navigate',
            arguments: JSON.stringify({ url: 'https://www.bing.com/news/search?q=AI' }),
          }],
        }
      }
      if (researchRounds === 2) {
        return {
          content: '从搜索摘要看到三条新闻：https://www.bing.com/news/search?q=AI',
          reasoningContent: '', aborted: false, toolCalls: [],
        }
      }
      if (researchRounds === 3) {
        assert(messages.some(item => /search-result snippets do not count/i.test(String(item.content || ''))),
          'runtime tells the model to open original sources instead of answering from snippets')
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: verifiedNewsEvidence.map((evidence, index) => ({
            id: `research-source-${index + 1}`,
            name: 'browser_navigate',
            arguments: JSON.stringify(evidence.args),
          })),
        }
      }
      return { content: verifiedNewsReply, reasoningContent: '', aborted: false, toolCalls: [] }
    },
    _executeToolForTest: async (name, args) => {
      researchExecuted.push({ name, args })
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      if (name === 'browser_navigate') {
        if (args.url.includes('bing.com/news/search')) return searchOnlyEvidence[0].result
        const match = verifiedNewsEvidence.find(item => item.args.url === args.url)
        return match?.result || JSON.stringify({ ok: false, error: 'unexpected URL' })
      }
      return JSON.stringify({ ok: false, error: 'unexpected tool' })
    },
  })
  assert.equal(researchRounds, 4, 'snippet-only draft is held until three original pages are verified')
  assert.equal(researchExecuted.filter(item => item.name === 'browser_navigate').length, 4,
    'research opens one discovery page and three distinct source pages')
  assert.equal(researchResult.delivered, true)
  assert.equal(actionContractCompletionIssue(
    newsContract,
    researchResult.content,
    { successfulToolEvidence: verifiedNewsEvidence },
  ), '')
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
          const parsed = JSON.parse(itemText(entry))
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

  const screenshotFile = path.join(tmp, 'runtime-screenshot.png')
  fs.writeFileSync(screenshotFile, Buffer.from('screenshot'))

  let explicitScreenshotRounds = 0
  const explicitScreenshotCalls = []
  const explicitScreenshotPublicCalls = []
  const explicitScreenshotResult = await callLLM({
    systemPrompt: 'Capture and deliver the requested screenshot.',
    message: '把现在这个页面截个图发给我。',
    tools: ['browser_take_screenshot', 'send_message'],
    mustReply: true,
    localReply: true,
    toolContext: {
      currentTargetId: 'ID:000001',
      currentUserMessage: '把现在这个页面截个图发给我。',
      actionContract: screenshotContract,
    },
    _streamOnceForTest: async () => {
      explicitScreenshotRounds += 1
      if (explicitScreenshotRounds === 1) {
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: [
            { id: 'wrong-window', name: 'browser_set_display_mode', arguments: JSON.stringify({ mode: 'window' }) },
            { id: 'explicit-capture', name: 'browser_take_screenshot', arguments: '{}' },
          ],
        }
      }
      if (explicitScreenshotRounds === 2) {
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: [{
            id: 'explicit-send-image',
            name: 'send_message',
            arguments: JSON.stringify({
              target_id: 'ID:000001',
              content: '上一轮的 Example Domain 计数是 1，截图如下。',
              image_path: screenshotFile,
            }),
          }],
        }
      }
      throw new Error('a successful screenshot delivery must terminate before a duplicate send round')
    },
    _executeToolForTest: async (name, args) => {
      explicitScreenshotCalls.push({ name, args })
      if (name === 'browser_take_screenshot') {
        return JSON.stringify({ ok: true, screenshot: { image_path: screenshotFile, delivered: false } })
      }
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      return JSON.stringify({ ok: false, error: 'unexpected tool' })
    },
    onToolCall: (name, args) => explicitScreenshotPublicCalls.push({ name, args }),
  })
  assert.equal(explicitScreenshotRounds, 2)
  assert.deepEqual(explicitScreenshotCalls.map(call => call.name), ['browser_take_screenshot', 'send_message'])
  assert.deepEqual(explicitScreenshotPublicCalls.map(call => call.name), ['browser_take_screenshot', 'send_message'],
    'out-of-scope planning attempts are kept private and cannot pollute the observed tool sequence')
  assert.equal(explicitScreenshotCalls[1].args.image_path, screenshotFile)
  assert.equal(explicitScreenshotCalls[1].args.content, '',
    'screenshot delivery removes stale facts copied from a previous turn')
  assert.equal(explicitScreenshotResult.delivered, true)
  assert.doesNotMatch(explicitScreenshotResult.content, /没有成功发送|发送失败/)

  let failedScreenshotRounds = 0
  const failedScreenshotCalls = []
  const failedScreenshotResult = await callLLM({
    systemPrompt: 'Capture and deliver the requested screenshot.',
    message: '把现在这个页面截个图发给我。',
    tools: ['browser_take_screenshot', 'send_message'],
    mustReply: true,
    localReply: true,
    toolContext: {
      currentTargetId: 'ID:000001',
      currentUserMessage: '把现在这个页面截个图发给我。',
      actionContract: screenshotContract,
    },
    _streamOnceForTest: async () => {
      failedScreenshotRounds += 1
      if (failedScreenshotRounds === 1) {
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: [{ id: 'failed-capture', name: 'browser_take_screenshot', arguments: '{}' }],
        }
      }
      if (failedScreenshotRounds === 2) {
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: [{
            id: 'failed-send-image',
            name: 'send_message',
            arguments: JSON.stringify({ target_id: 'ID:000001', content: '', image_path: screenshotFile }),
          }],
        }
      }
      return { content: '截图生成了，但图片发送失败。', reasoningContent: '', aborted: false, toolCalls: [] }
    },
    _executeToolForTest: async (name, args) => {
      failedScreenshotCalls.push({ name, args })
      if (name === 'browser_take_screenshot') {
        return JSON.stringify({ ok: true, screenshot: { image_path: screenshotFile, delivered: false } })
      }
      if (name === 'send_message' && args.image_path) {
        return JSON.stringify({ ok: false, delivered: false, message_sent: false, error: 'transport_failed' })
      }
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      return JSON.stringify({ ok: false, error: 'unexpected tool' })
    },
  })
  assert.equal(failedScreenshotCalls.filter(call => call.args.image_path === screenshotFile).length, 1,
    'a failed real image send is not raced by an identical fallback image send')
  assert.match(failedScreenshotResult.content, /图片发送失败/)

  let pageFindRounds = 0
  const pageFindToolCalls = []
  const pageFindRuntimeResult = await callLLM({
    systemPrompt: 'Find text only in the current page.',
    message: '机器学习在这页出现几次',
    tools: ['browser_find', 'download_file', 'run_command', 'exec_command', 'browser_navigate', 'send_message'],
    mustReply: true,
    localReply: true,
    toolContext: {
      currentTargetId: 'ID:000001',
      currentUserMessage: '机器学习在这页出现几次',
      actionContract: pageFindContract,
    },
    _streamOnceForTest: async () => {
      pageFindRounds += 1
      if (pageFindRounds > 1) throw new Error('browser_find success must converge without another model round')
      return {
        content: '', reasoningContent: '', aborted: false,
        toolCalls: [{ id: 'find-current-page', name: 'browser_find', arguments: JSON.stringify({ text: '机器学习' }) }],
      }
    },
    _executeToolForTest: async (name, args) => {
      pageFindToolCalls.push({ name, args })
      if (name === 'browser_find') return pageFindEvidence[0].result
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      return JSON.stringify({ ok: false, error: `unexpected tool ${name}` })
    },
  })
  assert.equal(pageFindRounds, 1)
  assert.deepEqual(pageFindToolCalls.map(call => call.name), ['browser_find', 'send_message'])
  assert.equal(pageFindToolCalls.some(call => ['download_file', 'run_command', 'exec_command', 'browser_navigate'].includes(call.name)), false)
  assert.equal(pageFindRuntimeResult.content, '当前页面里找到了“机器学习”，共出现 4 处。')
  assert.equal(pageFindRuntimeResult.delivered, true)

  let screenshotRounds = 0
  const screenshotToolCalls = []
  const screenshotResult = await callLLM({
    systemPrompt: 'Capture and deliver the requested screenshot.',
    message: '把当前页面截张图发给我看看',
    tools: ['browser_take_screenshot', 'send_message'],
    mustReply: true,
    localReply: true,
    toolContext: {
      currentTargetId: 'ID:000001',
      currentUserMessage: '把当前页面截张图发给我看看',
      actionContract: screenshotContract,
    },
    _streamOnceForTest: async ({ messages }) => {
      screenshotRounds += 1
      if (screenshotRounds === 1) {
        return {
          content: '', reasoningContent: '', aborted: false,
          toolCalls: [{ id: 'capture-browser', name: 'browser_take_screenshot', arguments: '{}' }],
        }
      }
      if (screenshotRounds === 2) {
        return { content: '截图已经发给你了。', reasoningContent: '', aborted: false, toolCalls: [] }
      }
      assert(messages.some(item => /not delivered|image_path/i.test(String(item.content || ''))))
      return { content: '图片已经显示在浏览器卡片里。', reasoningContent: '', aborted: false, toolCalls: [] }
    },
    _executeToolForTest: async (name, args) => {
      screenshotToolCalls.push({ name, args })
      if (name === 'browser_take_screenshot') {
        return JSON.stringify({ ok: true, screenshot: { image_path: screenshotFile, delivered: false } })
      }
      if (name === 'send_message') return JSON.stringify({ ok: true, delivered: true, message_sent: true })
      return JSON.stringify({ ok: false, error: 'unexpected tool' })
    },
  })
  assert.equal(screenshotResult.delivered, true)
  assert.deepEqual(screenshotToolCalls.map(call => call.name), ['browser_take_screenshot', 'send_message'])
  assert.equal(screenshotToolCalls[1].args.image_path, screenshotFile)
  assert.equal(screenshotToolCalls[1].args.content, '')
  console.log('test-action-contract passed')
} finally {
  closeDBForTest?.()
  fs.rmSync(tmp, { recursive: true, force: true })
}

process.exit(process.exitCode || 0)
