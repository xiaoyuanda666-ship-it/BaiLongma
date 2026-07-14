import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { BROWSER_ACTIONS, BrowserSessionError, BrowserSessionManager } from './capabilities/tools/browser/index.js'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

class FakePage extends EventEmitter {
  constructor(url = 'about:blank') {
    super()
    this.closed = false
    this.currentUrl = url
  }
  setDefaultTimeout() {}
  setDefaultNavigationTimeout() {}
  isClosed() { return this.closed }
  url() { return this.currentUrl }
  async title() { return '' }
  async close() {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }
}

class FakeContext extends EventEmitter {
  constructor({ pagePromise } = {}) {
    super()
    this.closed = false
    this.pagePromise = pagePromise
  }
  pages() { return [] }
  async newPage() { return this.pagePromise || new FakePage() }
  async close() { this.closed = true }
}

class FakeBrowser extends EventEmitter {
  constructor({ contextPromise } = {}) {
    super()
    this.closed = false
    this.contextPromise = contextPromise
  }
  isConnected() { return !this.closed }
  async newContext() { return this.contextPromise || new FakeContext() }
  async close() { this.closed = true }
}

function fakeManager(name, chromium) {
  return new BrowserSessionManager({
    sandboxRoot: path.join(tempRoot, `${name}-sandbox`),
    userDataRoot: path.join(tempRoot, `${name}-user-data`),
    chromiumLoader: async () => chromium,
  })
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-browser-unit-'))
let now = 1_000
let contextClosed = false
const manager = new BrowserSessionManager({
  sandboxRoot: path.join(tempRoot, 'sandbox'),
  userDataRoot: path.join(tempRoot, 'user-data'),
  sessionTtlMs: 1_000,
  now: () => now,
  chromiumLoader: async () => { throw new Error('unit test must not launch a browser') },
})

try {
  assert.deepEqual(BROWSER_ACTIONS, [
    'click', 'fill', 'press', 'select', 'check', 'uncheck', 'hover',
    'scroll', 'wait', 'back', 'forward', 'reload',
  ])
  assert.equal(BROWSER_ACTIONS.includes('evaluate'), false)

  const launchOptions = []
  const launchDefaultsManager = fakeManager('launch-defaults', {
    launch: async options => {
      launchOptions.push(options)
      return new FakeBrowser()
    },
  })
  const defaultOpen = await launchDefaultsManager.open({ url: 'about:blank' })
  assert.equal(defaultOpen.visible, true)
  assert.equal(defaultOpen.persistent, false)
  const explicitHeadlessOpen = await launchDefaultsManager.open({ url: 'about:blank', visible: false })
  assert.equal(explicitHeadlessOpen.visible, false)
  assert.equal(explicitHeadlessOpen.persistent, false)
  assert.equal(launchOptions.length, 2, 'visible and headless sessions use separate shared browsers')
  assert.equal(launchOptions[0].headless, false, 'default product launch is headed')
  assert.equal(launchOptions[1].headless, true, 'visible=false explicitly launches headless')
  assert.equal(launchDefaultsManager.listSessions().count, 2, 'browser_sessions lists live open sessions')
  const defaultPage = launchDefaultsManager.sessions.get(defaultOpen.session_id).pages.values().next().value.page
  defaultPage.currentUrl = 'https://example.com/path/to/page?access_token=TOP_SECRET#private'
  const safeListedUrl = launchDefaultsManager.listSessions().sessions
    .find(item => item.session_id === defaultOpen.session_id).pages[0].url
  assert.equal(safeListedUrl, 'https://example.com/path/to/page', 'runtime URL omits query credentials and fragments')
  await launchDefaultsManager.close({ session_id: defaultOpen.session_id })
  assert.equal(launchDefaultsManager.listSessions().count, 1, 'closed sessions are not listed')

  const beforeTabClose = launchDefaultsManager.listSessions().sessions
    .find(item => item.session_id === explicitHeadlessOpen.session_id).pages[0].page_id
  const tabCloseResult = await launchDefaultsManager.tabs({
    session_id: explicitHeadlessOpen.session_id,
    page_id: beforeTabClose,
    action: 'close',
  })
  assert.equal(tabCloseResult.pages.length, 1, 'browser_tabs close of last tab creates a replacement page')
  assert.notEqual(tabCloseResult.pages[0].page_id, beforeTabClose)
  assert.equal(launchDefaultsManager.size, 1, 'tabs replacement preserves the session')

  const replacementPage = launchDefaultsManager.sessions
    .get(explicitHeadlessOpen.session_id).pages.values().next().value.page
  await replacementPage.close()
  await delay(0)
  assert.equal(launchDefaultsManager.listSessions().count, 0, 'manual close of the final page removes zombie session')
  assert.equal(launchDefaultsManager.size, 0, 'manual final-page close releases the session slot')
  await launchDefaultsManager.shutdown()

  await assert.rejects(
    manager.open({ url: 'file:///etc/passwd' }),
    err => err instanceof BrowserSessionError && err.code === 'URL_BLOCKED',
  )
  await assert.rejects(
    manager.open({ persistent: true, profile: '../real-chrome-profile' }),
    err => err instanceof BrowserSessionError && err.code === 'INVALID_ARGUMENT',
  )
  await assert.rejects(
    manager.act({ action: 'evaluate', session_id: 'nope' }),
    err => err instanceof BrowserSessionError && err.code === 'ACTION_NOT_ALLOWED',
  )

  manager.sessions.set('expired', {
    id: 'expired', context: { close: async () => { contextClosed = true } }, browser: null,
    persistent: false, pages: new Map(), activeOperations: 0, lastUsed: now, closing: false,
  })
  now += 1_001
  assert.equal(await manager.sweepExpired(), 1)
  assert.equal(contextClosed, true)
  assert.equal(manager.size, 0)

  const pendingAbort = new AbortController()
  const limited = new BrowserSessionManager({
    sandboxRoot: path.join(tempRoot, 'limited-sandbox'),
    userDataRoot: path.join(tempRoot, 'limited-user-data'),
    maxSessions: 1,
    chromiumLoader: () => new Promise(() => {}),
  })
  const pendingOpen = limited.open({ url: 'about:blank' }, { signal: pendingAbort.signal })
  await assert.rejects(
    limited.open({ url: 'about:blank' }),
    err => err instanceof BrowserSessionError && err.code === 'SESSION_LIMIT',
  )
  pendingAbort.abort('unit cancellation')
  await assert.rejects(pendingOpen, err => err.name === 'AbortError')
  await limited.shutdown()

  let sharedLaunchCount = 0
  const concurrentBrowser = new FakeBrowser()
  const concurrentManager = fakeManager('concurrent-open', {
    launch: () => {
      sharedLaunchCount += 1
      return delay(20).then(() => concurrentBrowser)
    },
  })
  const [concurrentOne, concurrentTwo] = await Promise.all([
    concurrentManager.open({ url: 'about:blank' }),
    concurrentManager.open({ url: 'about:blank' }),
  ])
  assert.notEqual(concurrentOne.session_id, concurrentTwo.session_id)
  assert.equal(sharedLaunchCount, 1)
  assert.equal(concurrentManager.size, 2)
  await concurrentManager.shutdown()
  assert.equal(concurrentBrowser.closed, true)

  const shutdownLaunchStarted = deferred()
  const shutdownLateBrowser = new FakeBrowser()
  const shutdownManager = fakeManager('shutdown-pending-open', {
    launch: () => {
      shutdownLaunchStarted.resolve()
      return delay(20).then(() => shutdownLateBrowser)
    },
  })
  const shutdownOpen = shutdownManager.open({ url: 'about:blank' })
  await shutdownLaunchStarted.promise
  const shutdownTask = shutdownManager.shutdown()
  await Promise.all([
    assert.rejects(shutdownOpen, err => err.name === 'AbortError'),
    shutdownTask,
  ])
  assert.equal(shutdownManager.size, 0)
  assert.equal(shutdownManager.sharedBrowsers.size, 0)
  assert.equal(shutdownManager.sharedBrowserLaunches.size, 0)
  assert.equal(shutdownLateBrowser.closed, true)
  assert.equal(shutdownLateBrowser.isConnected(), false)

  // A Playwright creation promise cannot itself be cancelled. Prove that each
  // resource is closed even when it resolves only after AbortSignal wins.
  const browserLaunchStarted = deferred()
  const lateBrowser = new FakeBrowser()
  const browserAbortManager = fakeManager('late-browser', {
    launch: () => {
      browserLaunchStarted.resolve()
      return delay(20).then(() => lateBrowser)
    },
  })
  const browserAbort = new AbortController()
  const browserOpen = browserAbortManager.open({}, { signal: browserAbort.signal })
  await browserLaunchStarted.promise
  browserAbort.abort('cancel delayed browser')
  await assert.rejects(browserOpen, err => err.name === 'AbortError')
  await delay(30)
  assert.equal(lateBrowser.closed, true)
  await browserAbortManager.shutdown()

  const contextStarted = deferred()
  const lateContext = new FakeContext()
  const contextBrowser = new FakeBrowser()
  contextBrowser.newContext = () => {
    contextStarted.resolve()
    return delay(20).then(() => lateContext)
  }
  const contextAbortManager = fakeManager('late-context', { launch: async () => contextBrowser })
  const contextAbort = new AbortController()
  const contextOpen = contextAbortManager.open({}, { signal: contextAbort.signal })
  await contextStarted.promise
  contextAbort.abort('cancel delayed context')
  await assert.rejects(contextOpen, err => err.name === 'AbortError')
  await delay(30)
  assert.equal(lateContext.closed, true)
  await contextAbortManager.shutdown()

  const pageStarted = deferred()
  const latePage = new FakePage()
  const pageContext = new FakeContext()
  pageContext.newPage = () => {
    pageStarted.resolve()
    return delay(20).then(() => latePage)
  }
  const pageBrowser = new FakeBrowser({ contextPromise: Promise.resolve(pageContext) })
  const pageAbortManager = fakeManager('late-page', { launch: async () => pageBrowser })
  const pageAbort = new AbortController()
  const pageOpen = pageAbortManager.open({}, { signal: pageAbort.signal })
  await pageStarted.promise
  pageAbort.abort('cancel delayed page')
  await assert.rejects(pageOpen, err => err.name === 'AbortError')
  await delay(30)
  assert.equal(pageContext.closed, true)
  assert.equal(latePage.closed, true)
  await pageAbortManager.shutdown()

  const persistentStarted = deferred()
  const latePersistentContext = new FakeContext()
  const persistentAbortManager = fakeManager('late-persistent', {
    launchPersistentContext: () => {
      persistentStarted.resolve()
      return delay(20).then(() => latePersistentContext)
    },
  })
  const persistentAbort = new AbortController()
  const persistentOpen = persistentAbortManager.open(
    { persistent: true, profile: 'test-profile' },
    { signal: persistentAbort.signal },
  )
  await persistentStarted.promise
  persistentAbort.abort('cancel delayed persistent context')
  await assert.rejects(persistentOpen, err => err.name === 'AbortError')
  await delay(30)
  assert.equal(latePersistentContext.closed, true)
  await persistentAbortManager.shutdown()

  await manager.shutdown()
  await assert.rejects(
    manager.open({ url: 'about:blank' }),
    err => err instanceof BrowserSessionError && err.code === 'MANAGER_CLOSED',
  )
  console.log('test-browser-session-manager passed')
} finally {
  await manager.shutdown()
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
