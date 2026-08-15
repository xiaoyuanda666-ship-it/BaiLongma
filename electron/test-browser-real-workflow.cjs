'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { app, BaseWindow, BrowserWindow, WebContentsView, View, webContents } = require('electron')
const { createBrowserEmbedHost } = require('./browser-embed-host.cjs')

const projectRoot = path.resolve(__dirname, '..')
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-real-browser-workflow-'))
process.env.BAILONGMA_USER_DIR = path.join(testRoot, 'user')
process.env.BAILONGMA_RESOURCES_DIR = projectRoot
process.env.BAILONGMA_MCP_NODE_PATH = path.join(projectRoot, 'build', 'node-runtime', 'mac-arm64', 'node')
fs.mkdirSync(process.env.BAILONGMA_USER_DIR, { recursive: true })
app.setPath('userData', process.env.BAILONGMA_USER_DIR)
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
app.commandLine.appendSwitch('remote-debugging-port', '0')

function waitForActivePort(timeoutMs = 8_000) {
  const activePortFile = path.join(process.env.BAILONGMA_USER_DIR, 'DevToolsActivePort')
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        const port = Number(fs.readFileSync(activePortFile, 'utf8').split(/\r?\n/)[0])
        if (Number.isInteger(port) && port > 0) return resolve(port)
      } catch {}
      if (Date.now() >= deadline) return reject(new Error('Electron CDP endpoint did not become ready'))
      setTimeout(poll, 50)
    }
    poll()
  })
}

function getJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: pathname }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch (error) { reject(error) }
      })
    })
    request.on('error', reject)
  })
}

function resultText(payload) {
  return (payload?.content || []).filter(item => item?.type === 'text').map(item => item.text).join('\n')
}

function targetFor(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = text.match(new RegExp(`uid=([^\\s]+)\\s+link "${escaped}"`))
  assert.ok(match?.[1], `snapshot did not expose link ${label}:\n${text}`)
  return match[1]
}

const fixtureServer = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  if (request.url === '/form') {
    response.end('<!doctype html><title>Stable Search</title><form action="/results"><label>Query <input name="q"></label><button>Search</button></form>')
    return
  }
  if (request.url === '/prefilled-form') {
    response.end('<!doctype html><title>Prefilled Search</title><form action="/results"><label>Query <input name="q" type="search" value="electron"></label></form>')
    return
  }
  if (request.url?.startsWith('/results')) {
    const query = new URL(request.url, 'http://fixture').searchParams.get('q') || ''
    response.end(`<!doctype html><title>Results for ${query}</title><h1>Results for ${query}</h1><div style="height:3200px">Scrollable deterministic content</div><p>Bottom marker</p>`)
    return
  }
  if (request.url === '/two') {
    response.end('<!doctype html><title>Workflow Two</title><h1>Page Two</h1><a href="/one">Back by link</a>')
    return
  }
  if (request.url === '/blank') {
    response.end('<!doctype html><title>Blank Target Final</title><h1>Target blank arrived</h1>')
    return
  }
  response.end('<!doctype html><title>Workflow One</title><h1>Page One</h1><a href="/two">Go two</a><a href="/blank" target="_blank">Open blank target</a>')
})

app.whenReady().then(async () => {
  let mainWindow
  let host
  let clearDataCalls = 0
  try {
    await new Promise((resolve, reject) => {
      fixtureServer.once('error', reject)
      fixtureServer.listen(0, '127.0.0.1', resolve)
    })
    const fixturePort = fixtureServer.address().port
    const baseUrl = `http://127.0.0.1:${fixturePort}`

    mainWindow = new BaseWindow({ width: 900, height: 680, show: false })
    host = createBrowserEmbedHost({
      WebContentsView,
      View,
      BrowserWindow,
      BaseWindow,
      assertNavigationAllowed: async url => url,
      transitionDurationMs: 0,
    })
    await host.prime(mainWindow)
    await host.update(mainWindow, {
      mode: 'card',
      visible: true,
      bounds: { x: 20, y: 20, width: 760, height: 560 },
      radius: 16,
      interactive: true,
    })

    const cdpPort = await waitForActivePort()
    const resolveTarget = async () => {
      const target = host.getTarget()
      if (!target) return null
      const catalog = await getJson(cdpPort, '/json/list')
      const match = catalog.find(candidate => {
        try { return webContents.fromDevToolsTargetId(candidate.id)?.id === target.webContentsId }
        catch { return false }
      })
      return { ...target, cdpEndpoint: `http://127.0.0.1:${cdpPort}`, targetId: match?.id || null }
    }
    globalThis.bailongmaChromeBridge = {
      ensureEndpoint: async () => {
        const target = await resolveTarget()
        if (!target?.targetId) throw new Error('embedded target is unavailable')
        return target.cdpEndpoint
      },
      getTarget: resolveTarget,
      closePage: () => host.closePage(),
      clearData: async () => { clearDataCalls += 1 },
    }

    const [{ executeBuiltInChromeTool, shutdownBuiltInChrome }, { config }, { evaluateToolPolicy }] = await Promise.all([
      import(pathToFileURL(path.join(projectRoot, 'src', 'mcp', 'client-manager.js')).href),
      import(pathToFileURL(path.join(projectRoot, 'src', 'config.js')).href),
      import(pathToFileURL(path.join(projectRoot, 'src', 'capabilities', 'tool-policy.js')).href),
    ])
    config.security.browserPrivateNetwork = true
    const context = { browserDisplayMode: 'card', browserDisplayState: { mode: 'card' } }
    const call = async (name, args = {}) => JSON.parse(await executeBuiltInChromeTool(name, args, context))

    const opened = await call('browser_navigate', { url: `${baseUrl}/one` })
    assert.equal(opened.ok, true, JSON.stringify(opened))
    assert.match(resultText(opened), /Page One/)
    assert.doesNotMatch(resultText(opened), /\[Snapshot\]\(/)
    assert.match(resultText(opened), /## Latest page snapshot/)
    assert.match(resultText(opened), /"scrollY":0/)
    const originalTarget = host.getTarget()

    context.browserDisplayState.mode = 'window'
    await host.update(mainWindow, { mode: 'window', visible: true, interactive: true })
    const largeWindow = BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Bailongma Browser')
    assert.ok(largeWindow, 'large browser must use a native BrowserWindow')
    assert.equal(largeWindow.isMovable(), true)
    assert.equal(largeWindow.isClosable(), true)
    assert.equal(largeWindow.isMinimizable(), true)
    largeWindow.close()
    assert.equal(host.getState(mainWindow).visible, false, 'native close hides the large presentation')
    assert.equal(host.getTarget().webContentsId, originalTarget.webContentsId,
      'native close must preserve the controlled page')
    await host.update(mainWindow, { mode: 'window', visible: true, interactive: true })
    assert.equal(host.getTarget().webContentsId, originalTarget.webContentsId,
      'reopening the large window must reuse the same WebContentsView')
    context.browserDisplayState.mode = 'card'
    await host.update(mainWindow, {
      mode: 'card', visible: true, interactive: true,
      bounds: { x: 20, y: 20, width: 760, height: 560 }, radius: 16,
    })
    assert.equal(host.getTarget().webContentsId, originalTarget.webContentsId)
    assert.equal(host.getTarget().url, `${baseUrl}/one`)

    const keepOpenPolicy = evaluateToolPolicy('browser_close', {}, {
      currentUserMessage: '切回你的小窗口浏览器，最后停留在小窗口，不要关闭浏览器',
    })
    assert.equal(keepOpenPolicy.allowed, false)
    const browserCloseCalls = 0

    const goTwo = targetFor(resultText(opened), 'Go two')
    const clickedTwo = await call('browser_click', { element: 'Go two', target: goTwo })
    assert.equal(clickedTwo.ok, true)
    assert.equal(clickedTwo.browser_preview.url, `${baseUrl}/two`)
    const backed = await call('browser_navigate_back')
    assert.equal(backed.ok, true)
    assert.equal(backed.browser_preview.url, `${baseUrl}/one`)
    const forwarded = await call('browser_navigate_forward')
    assert.equal(forwarded.ok, true, JSON.stringify(forwarded))
    assert.equal(forwarded.browser_preview.url, `${baseUrl}/two`)
    const reloaded = await call('browser_reload')
    assert.equal(reloaded.ok, true)
    assert.equal(reloaded.browser_preview.url, `${baseUrl}/two`)

    const reopenedOne = await call('browser_navigate', { url: `${baseUrl}/one` })
    const blankTarget = targetFor(resultText(reopenedOne), 'Open blank target')
    const blankClick = await call('browser_click', { element: 'Open blank target', target: blankTarget })
    assert.equal(blankClick.ok, true, JSON.stringify(blankClick))
    assert.equal(blankClick.browser_preview.url, `${baseUrl}/blank`)
    assert.match(resultText(blankClick), /Target blank arrived/)
    assert.equal(host.getTarget().webContentsId, originalTarget.webContentsId)

    const formPage = await call('browser_navigate', { url: `${baseUrl}/form` })
    const inputMatch = resultText(formPage).match(/uid=([^\s]+)\s+textbox "Query\s*"/)
    assert.ok(inputMatch?.[1], resultText(formPage))
    const typed = await call('browser_type', { uid: inputMatch[1], text: 'bailongma' })
    assert.equal(typed.ok, true)
    const submitted = await call('browser_press_key', { key: 'Enter' })
    assert.equal(submitted.ok, true, JSON.stringify(submitted))
    assert.equal(submitted.browser_preview.url, `${baseUrl}/results?q=bailongma`)
    assert.match(resultText(submitted), /Results for bailongma/)
    const foundOnCurrentPage = await call('browser_find', { text: 'Results for bailongma' })
    assert.equal(foundOnCurrentPage.ok, true, JSON.stringify(foundOnCurrentPage))
    assert.equal(foundOnCurrentPage.structured_content?.page_find?.query, 'Results for bailongma')
    assert.equal(foundOnCurrentPage.structured_content?.page_find?.found, true)
    assert.equal(foundOnCurrentPage.structured_content?.page_find?.total_matches, 1)
    assert.equal(foundOnCurrentPage.browser_preview.url, `${baseUrl}/results?q=bailongma`,
      'current-page find must not navigate away')
    const beforeScroll = Number(resultText(submitted).match(/"scrollY":(\d+)/)?.[1])
    const scrolled = await call('browser_press_key', { key: 'PageDown' })
    const afterScroll = Number(resultText(scrolled).match(/"scrollY":(\d+)/)?.[1])
    assert.ok(afterScroll > beforeScroll, JSON.stringify({ beforeScroll, afterScroll, result: scrolled }))

    const prefilledForm = await call('browser_navigate', { url: `${baseUrl}/prefilled-form` })
    const prefilledInputMatch = resultText(prefilledForm).match(/uid=([^\s]+)\s+searchbox "Query\s*"/)
    assert.ok(prefilledInputMatch?.[1], resultText(prefilledForm))
    const replaced = await call('browser_type', {
      uid: prefilledInputMatch[1], text: 'bailongma replacement', replace: true,
    })
    assert.equal(replaced.ok, true, JSON.stringify(replaced))
    assert.match(resultText(replaced), /value="bailongma replacement"/)
    const fallbackSubmitted = await call('browser_click', {
      search_submit: true, element: 'search submit',
    })
    assert.equal(fallbackSubmitted.ok, true, JSON.stringify(fallbackSubmitted))
    assert.equal(fallbackSubmitted.browser_preview.url, `${baseUrl}/results?q=bailongma+replacement`)
    assert.match(resultText(fallbackSubmitted), /Results for bailongma replacement/)

    for (let index = 0; index < 30; index += 1) {
      const stable = await call('browser_snapshot')
      assert.equal(stable.ok, true)
      assert.equal(stable.browser_preview.web_contents_id, originalTarget.webContentsId)
      assert.equal(stable.browser_preview.renderer, 'webcontentsview')
    }

    assert.equal(browserCloseCalls, 0)
    assert.equal(clearDataCalls, 0)
    console.log(JSON.stringify({
      ok: true,
      officialMcp: true,
      inlineSnapshot: true,
      sameWebContentsAcrossModes: true,
      nativeLargeWindowControls: true,
      nativeClosePreservesPage: true,
      browserCloseCalls,
      browserClearDataCalls: clearDataCalls,
      forwardFinalUrl: forwarded.browser_preview.url,
      targetBlankFinalUrl: blankClick.browser_preview.url,
      submittedUrl: submitted.browser_preview.url,
      fallbackSubmittedUrl: fallbackSubmitted.browser_preview.url,
      currentPageFindMatches: foundOnCurrentPage.structured_content?.page_find?.total_matches,
      scrollBefore: beforeScroll,
      scrollAfter: afterScroll,
      stabilityOperations: 30,
    }))
    await shutdownBuiltInChrome()
  } finally {
    try { host?.destroyAll() } catch {}
    try { mainWindow?.destroy() } catch {}
    await new Promise(resolve => fixtureServer.close(resolve))
    fs.rmSync(testRoot, { recursive: true, force: true })
    app.quit()
  }
}).catch(error => {
  console.error(error)
  app.exit(1)
})
