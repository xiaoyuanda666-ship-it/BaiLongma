import fs from 'fs'
import os from 'os'
import path from 'path'
import { Writable } from 'stream'
import vm from 'node:vm'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-browser-display-'))
process.env.BAILONGMA_USER_DIR = tmp

let failed = 0
function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`PASS: ${label}`)
    return
  }
  failed += 1
  process.exitCode = 1
  console.error(`FAIL: ${label}${detail ? `\n  ${detail}` : ''}`)
}

const {
  browserPreviewDirectory,
  createBrowserPreviewFilename,
  inferBrowserSurface,
  inferBrowserDisplayMode,
  isExplicitBrowserDisplayModeRequest,
  isSystemBrowserIntent,
  isSystemBrowserRequest,
  pruneBrowserPreviewFiles,
  resolveBrowserPreviewFile,
} = await import('./mcp/browser-display.js')
const { handleBrowserPreviewRoutes } = await import('./api/routes/browser-preview.js')

class CaptureResponse extends Writable {
  constructor() {
    super()
    this.statusCode = 0
    this.headers = {}
    this.chunks = []
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode
    this.headers = headers
    return this
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk))
    callback()
  }
}

try {
  // Exercise actual renderer payloads with a stale challenge URL. Neither
  // geometry synchronization nor enlargement may turn it into navigation.
  const uiSource = fs.readFileSync(new URL('./ui/brain-ui/app.js', import.meta.url), 'utf8')
  const extractFunction = (name, nextName) => uiSource.slice(
    uiSource.indexOf(`function ${name}(`), uiSource.indexOf(`function ${nextName}(`),
  ).replace(/async\s*$/, '')
  const updates = []
  const ui = vm.createContext({
    browserEmbedBridge: {}, browserPreviewActive: true, browserPreviewEl: { hidden: false },
    document: { visibilityState: 'visible' },
    browserPreviewNativeSlotEl: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 500, height: 300 }) },
    getComputedStyle: () => ({ borderTopLeftRadius: '12' }), window: {},
    browserPreviewNativeUrl: 'https://example.org/challenge',
    browserPreviewHostTransitioning: false, browserPreviewHostTransitionTarget: '',
    browserPreviewDisplayMode: 'card', browserPreviewHostTransitionToken: 0,
    browserPreviewLoadToken: 0, browserPreviewPending: false, browserEmbedFrameRequest: 0,
    lastBrowserEmbedGeometry: '', browserPreviewTransitionDuration: () => 0,
    callBrowserEmbed: async (_method, payload) => { updates.push(payload) },
    concealBrowserPreviewSurface: () => {}, finalizeBrowserPreviewHidden: () => {},
  })
  vm.runInContext(extractFunction('browserEmbedPayload', 'syncNativeBrowserEmbed'), ui)
  const payload = vm.runInContext('browserEmbedPayload()', ui)
  assert(payload.mode === 'card' && !('url' in payload),
    'card geometry never replays a stale challenge URL')
  vm.runInContext('async ' + extractFunction('showNativeBrowserWindow', 'loadBrowserPreviewImage'), ui)
  await vm.runInContext('showNativeBrowserWindow({ url: "https://example.org/challenge" })', ui)
  assert(updates[0]?.mode === 'window' && !('url' in updates[0]),
    'enlarging the live page never replays a stale preview URL')

  assert(inferBrowserDisplayMode('帮我查一下 Playwright MCP 最新资料') === 'card',
    'small information lookup uses the compact browser card')
  assert(inferBrowserDisplayMode('在百度搜索 bailongma') === 'card',
    'search-engine lookup uses the compact browser card')
  assert(inferBrowserDisplayMode(
    '[ID:000001] 2026-07-26T00:20:03+08:00 [语音识别] 帮我查一下马云是谁',
  ) === 'card',
  'voice-message envelope is removed before classifying a person lookup')
  assert(inferBrowserDisplayMode('马云是谁') === 'card',
    'short person fact question uses the compact browser card')
  assert(inferBrowserDisplayMode('介绍一下乔布斯') === 'card',
    'person introduction request uses the compact browser card')
  assert(inferBrowserDisplayMode('高德地图是什么东西') === 'card',
    'product fact question uses the compact browser card')
  assert(inferBrowserDisplayMode('登录网站并回复评论') === 'window',
    'interactive login and reply task uses the large external browser')
  assert(inferBrowserDisplayMode('介绍一下怎么登录这个网站') === 'window',
    'interactive intent still overrides the informational question pattern')
  assert(inferBrowserDisplayMode('用外部大窗口打开百度') === 'window',
    'an explicit external-window request overrides compact mode')
  assert(inferBrowserDisplayMode('切换到大浏览器') === 'window',
    'an explicit large-browser switch selects the external window')
  assert(inferBrowserDisplayMode('用大的窗口打开') === 'window',
    'a natural spoken large-window request selects the external window')
  assert(inferBrowserDisplayMode('请用大一点的窗口打开这个网页') === 'window',
    'a softened spoken large-window request selects the external window')
  assert(inferBrowserDisplayMode('用大 窗口 口打') === 'window',
    'speech-recognition spacing noise still selects the external window')
  assert(inferBrowserDisplayMode('切换到小浏览器') === 'card',
    'an explicit compact-browser switch selects the embedded card')
  assert(inferBrowserDisplayMode('请用小的窗口打开') === 'card',
    'a natural spoken compact-window request selects the embedded card')
  assert(inferBrowserSurface('用你的浏览器查一下资料') === 'card',
    '"你的浏览器" means Bailongma compact card')
  assert(inferBrowserSurface('用我的浏览器打开这个视频') === 'window',
    '"我的浏览器" means Bailongma large window')
  assert(inferBrowserSurface('请打开白龙马专用 Chrome 让我自己登录') === 'chrome'
    && inferBrowserDisplayMode('请打开白龙马专用 Chrome 让我自己登录') === 'window',
  'BaiLongma dedicated Chrome is an explicit controllable surface and uses its visible window')
  assert(inferBrowserDisplayMode('看视频') === 'window',
    'video normally prefers the large Bailongma window')
  assert(inferBrowserDisplayMode('用你的小窗口浏览器看视频') === 'card',
    'an explicit compact-video request overrides the usual large-window preference')
  for (const phrase of [
  '用我电脑上的浏览器打开',
  '用电脑的浏览器打开',
  '用电脑上安装的浏览器访问这个网站',
    '电脑浏览器打开',
    '用默认浏览器打开',
  ]) {
    assert(inferBrowserSurface(phrase) === 'system',
      `computer-browser ownership selects the installed browser: ${phrase}`)
    assert(isSystemBrowserIntent(phrase) === true,
      `computer-browser intent is recognized: ${phrase}`)
    assert(isSystemBrowserRequest(phrase) === true,
      `computer-browser action is recognized: ${phrase}`)
  }
  for (const phrase of [
    '不要用系统浏览器，就用你的浏览器登录',
    '不用电脑浏览器，继续当前页面',
    '不要使用默认浏览器',
  ]) {
    assert(isSystemBrowserIntent(phrase) === false,
      `a negated computer-browser phrase is not treated as system-browser intent: ${phrase}`)
    assert(isSystemBrowserRequest(phrase) === false,
      `a negated computer-browser phrase is not treated as system-browser action: ${phrase}`)
  }
  assert(isExplicitBrowserDisplayModeRequest('用大的窗口打开') === true,
    'the real failed spoken phrase requires an observable display switch')
  assert(isExplicitBrowserDisplayModeRequest('切回你的小窗口浏览器') === true,
    'returning to the compact browser requires an observable display switch')
  assert(inferBrowserDisplayMode(
    '请只使用行动日志里的小窗口打开 GitHub，等待加载后向下滚动到 README，不要打开外部大窗口',
  ) === 'card',
  'an explicit compact-window request overrides interaction words and a negated large window')
  assert(inferBrowserDisplayMode(
    '请明确使用行动日志里的小窗口打开 https://example.com，不要使用外部大窗口',
  ) === 'card',
  'the real compact-view retry message stays in card mode')
  assert(inferBrowserDisplayMode('打开浏览器看看今天的新闻') === 'card',
    'ordinary browser opening defaults to the compact browser card')
  assert(inferBrowserDisplayMode('打开 B 站给我看') === 'window',
    'a request to present the page to the user uses the large external browser')
  assert(inferBrowserDisplayMode('查看这篇文章的评论区') === 'card',
    'read-only comment browsing stays in the compact browser card')
  assert(inferBrowserDisplayMode('在文章下面评论一下') === 'window',
    'writing a comment uses the large external browser')
  assert(inferBrowserDisplayMode('看看今天有什么值得关注的内容', { autonomous: true }) === 'card',
    'autonomous background browsing defaults to the compact browser card')
  assert(inferBrowserDisplayMode('处理这个任务') === 'card',
    'ambiguous foreground browser work defaults to the compact browser card')

  const first = createBrowserPreviewFilename()
  assert(resolveBrowserPreviewFile(first)?.startsWith(browserPreviewDirectory()),
    'generated preview filename resolves inside the controlled reader directory')
  assert(resolveBrowserPreviewFile('../brain-ui-preview-1234567890123-1.png') === '',
    'preview resolver rejects path traversal')
  assert(resolveBrowserPreviewFile('unrelated.png') === '',
    'preview resolver rejects unrelated files')

  fs.mkdirSync(browserPreviewDirectory(), { recursive: true })
  for (let index = 0; index < 9; index += 1) {
    const filename = createBrowserPreviewFilename(Date.now() + index)
    const filePath = resolveBrowserPreviewFile(filename)
    fs.writeFileSync(filePath, `preview-${index}`)
    const stamp = new Date(Date.now() + index * 1000)
    fs.utimesSync(filePath, stamp, stamp)
  }
  pruneBrowserPreviewFiles({ keep: 3 })
  const remaining = fs.readdirSync(browserPreviewDirectory())
    .filter(name => name.startsWith('brain-ui-preview-'))
  assert(remaining.length === 3, 'preview cleanup retains only the newest bounded set', remaining.join(', '))

  const servedName = remaining[0]
  const servedPath = resolveBrowserPreviewFile(servedName)
  const expected = fs.readFileSync(servedPath)
  const response = new CaptureResponse()
  const finished = new Promise(resolve => response.on('finish', resolve))
  const handled = await handleBrowserPreviewRoutes(
    { method: 'GET' },
    response,
    new URL(`http://localhost/browser-preview?file=${encodeURIComponent(servedName)}`),
    { requireLocalOrToken: () => true },
  )
  await finished
  assert(handled === true
    && response.statusCode === 200
    && response.headers['Content-Type'] === 'image/png'
    && Buffer.concat(response.chunks).equals(expected),
  'authenticated preview route streams only the selected PNG',
  `${response.statusCode} ${JSON.stringify(response.headers)}`)

  const rejected = new CaptureResponse()
  const rejectedFinished = new Promise(resolve => rejected.on('finish', resolve))
  const rejectedHandled = await handleBrowserPreviewRoutes(
    { method: 'GET' },
    rejected,
    new URL('http://localhost/browser-preview?file=../secret.png'),
    { requireLocalOrToken: () => true },
  )
  await rejectedFinished
  assert(rejectedHandled === true && rejected.statusCode === 404,
    'preview route rejects traversal and non-preview filenames')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

if (failed === 0) console.log('All browser display mode tests passed.')
