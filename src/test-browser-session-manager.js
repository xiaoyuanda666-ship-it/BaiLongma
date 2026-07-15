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
  async goto(url) { this.currentUrl = url }
  async evaluate(_callback, args) {
    if (args?.selector) return { title: '', text: '', textLength: 0, elements: [] }
    return null
  }
  async close() {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }
}

class FakeContext extends EventEmitter {
  constructor({ pagePromise, browser = null } = {}) {
    super()
    this.closed = false
    this.pagePromise = pagePromise
    this.browserInstance = browser
  }
  pages() { return [] }
  async newPage() { return this.pagePromise || new FakePage() }
  async close() { this.closed = true }
  browser() { return this.browserInstance }
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

function fakeManager(name, chromium, options = {}) {
  return new BrowserSessionManager({
    sandboxRoot: path.join(tempRoot, `${name}-sandbox`),
    userDataRoot: path.join(tempRoot, `${name}-user-data`),
    chromiumLoader: async () => chromium,
    hostnameResolver: async () => [{ address: '93.184.216.34' }],
    ...options,
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

  const defaultPersistentBrowser = new FakeBrowser()
  const defaultPersistentPaths = []
  const defaultPersistentManager = fakeManager('default-persistent', {
    launchPersistentContext: async profilePath => {
      defaultPersistentPaths.push(profilePath)
      return new FakeContext({ browser: defaultPersistentBrowser })
    },
  })
  const defaultPersistent = await defaultPersistentManager.open({ url: 'https://example.com/' })
  assert.equal(defaultPersistent.persistent, true, 'http(s) browser sessions persist by default')
  assert.equal(defaultPersistent.profile, 'default', 'implicit persistent sessions use the stable default profile name')
  assert.equal(defaultPersistentPaths.length, 1)
  await defaultPersistentManager.close({ session_id: defaultPersistent.session_id })
  await defaultPersistentManager.shutdown()

  const noExpiryManager = fakeManager('no-expiry', {})
  noExpiryManager.sessions.set('durable', { activeOperations: 0, lastUsed: 0 })
  assert.equal(await noExpiryManager.sweepExpired(), 0, 'browser sessions do not expire from inactivity by default')
  assert.equal(noExpiryManager.sessions.has('durable'), true)
  noExpiryManager.sessions.delete('durable')
  await noExpiryManager.shutdown()

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
  await assert.rejects(
    manager.tabs({ session_id: 'expired' }),
    err => err instanceof BrowserSessionError && err.code === 'SESSION_CLOSED' && err.closeReason === 'TTL_EXPIRED',
  )

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

  const serialFirstStarted = deferred()
  const serialFirstGate = deferred()
  const serialEvents = []
  let serialInspectCount = 0
  const serialPage = new FakePage()
  serialPage.goto = async url => {
    const label = url.endsWith('/one') ? 'one' : 'two'
    serialEvents.push(`start:${label}`)
    if (label === 'one') {
      serialFirstStarted.resolve()
      await serialFirstGate.promise
    }
    serialPage.currentUrl = url
    serialEvents.push(`end:${label}`)
  }
  serialPage.evaluate = async (_callback, args) => {
    if (args?.selector) {
      serialInspectCount += 1
      serialEvents.push('inspect')
      return { title: '', text: '', textLength: 0, elements: [] }
    }
    return null
  }
  const serialContext = new FakeContext({ pagePromise: serialPage })
  const serialManager = fakeManager('page-serial', {
    launch: async () => new FakeBrowser({ contextPromise: Promise.resolve(serialContext) }),
  })
  const serialOpen = await serialManager.open({ url: 'about:blank' })
  const serialOne = serialManager.navigate({
    session_id: serialOpen.session_id, url: 'https://example.com/one',
  })
  await serialFirstStarted.promise
  const serialTwo = serialManager.navigate({
    session_id: serialOpen.session_id, url: 'https://example.com/two',
  })
  await delay(0)
  const queuedInspect = serialManager.inspect({ session_id: serialOpen.session_id })
  await delay(0)
  assert.deepEqual(serialEvents, ['start:one'], 'same-page navigation and inspect remain queued behind the active navigation')
  assert.equal(serialInspectCount, 0)
  serialFirstGate.resolve()
  const [serialOneResult, serialTwoResult] = await Promise.all([serialOne, serialTwo, queuedInspect])
  assert.deepEqual(serialEvents, ['start:one', 'end:one', 'start:two', 'end:two', 'inspect'])
  assert.match(serialOneResult.operation_id, /^bo_/)
  assert.equal(serialOneResult.operation_type, 'navigate')
  assert.equal(serialTwoResult.operation_type, 'navigate')
  await serialManager.shutdown()

  const parallelPageOne = new FakePage()
  const parallelPageTwo = new FakePage()
  const parallelOneStarted = deferred()
  const parallelTwoStarted = deferred()
  const parallelOneGate = deferred()
  const parallelTwoGate = deferred()
  parallelPageOne.goto = async url => {
    parallelOneStarted.resolve()
    await parallelOneGate.promise
    parallelPageOne.currentUrl = url
  }
  parallelPageTwo.goto = async url => {
    parallelTwoStarted.resolve()
    await parallelTwoGate.promise
    parallelPageTwo.currentUrl = url
  }
  const parallelContext = new FakeContext({ pagePromise: parallelPageOne })
  const parallelManager = fakeManager('page-parallel', {
    launch: async () => new FakeBrowser({ contextPromise: Promise.resolve(parallelContext) }),
  })
  const parallelOpen = await parallelManager.open({ url: 'about:blank' })
  parallelContext.newPage = async () => parallelPageTwo
  const parallelTabs = await parallelManager.tabs({ session_id: parallelOpen.session_id, action: 'new' })
  const parallelPageTwoId = parallelTabs.active_page_id
  const parallelOne = parallelManager.navigate({
    session_id: parallelOpen.session_id, page_id: parallelOpen.page_id, url: 'https://example.com/parallel-one',
  })
  const parallelTwo = parallelManager.navigate({
    session_id: parallelOpen.session_id, page_id: parallelPageTwoId, url: 'https://example.com/parallel-two',
  })
  await Promise.all([parallelOneStarted.promise, parallelTwoStarted.promise])
  assert.equal(parallelContext.closed, false, 'different page queues can have active operations concurrently')
  parallelOneGate.resolve()
  parallelTwoGate.resolve()
  await Promise.all([parallelOne, parallelTwo])
  await parallelManager.shutdown()

  const queuedAbortStarted = deferred()
  const queuedAbortGate = deferred()
  const queuedAbortUrls = []
  const queuedAbortPage = new FakePage()
  queuedAbortPage.goto = async url => {
    queuedAbortUrls.push(url)
    if (url.endsWith('/active')) {
      queuedAbortStarted.resolve()
      await queuedAbortGate.promise
    }
    queuedAbortPage.currentUrl = url
  }
  const queuedAbortManager = fakeManager('queued-abort', {
    launch: async () => new FakeBrowser({
      contextPromise: Promise.resolve(new FakeContext({ pagePromise: queuedAbortPage })),
    }),
  })
  const queuedAbortOpen = await queuedAbortManager.open({ url: 'about:blank' })
  const activeBeforeAbort = queuedAbortManager.navigate({
    session_id: queuedAbortOpen.session_id, url: 'https://example.com/active',
  })
  await queuedAbortStarted.promise
  const queuedAbortController = new AbortController()
  const cancelledBeforeStart = queuedAbortManager.navigate({
    session_id: queuedAbortOpen.session_id, url: 'https://example.com/cancelled',
  }, { signal: queuedAbortController.signal })
  await delay(0)
  queuedAbortController.abort('cancel queued navigation')
  await assert.rejects(
    cancelledBeforeStart,
    err => err.name === 'AbortError' && /^bo_/.test(err.operationId) && err.startedAt === null,
  )
  queuedAbortGate.resolve()
  await activeBeforeAbort
  assert.deepEqual(queuedAbortUrls, ['https://example.com/active'], 'aborted queued work never reaches Playwright')
  await queuedAbortManager.shutdown()

  const tabCloseStarted = deferred()
  const tabCloseGate = deferred()
  const tabClosePage = new FakePage()
  tabClosePage.goto = async url => {
    tabCloseStarted.resolve()
    await tabCloseGate.promise
    tabClosePage.currentUrl = url
  }
  const tabCloseContext = new FakeContext({ pagePromise: tabClosePage })
  const tabCloseManager = fakeManager('tab-close-barrier', {
    launch: async () => new FakeBrowser({ contextPromise: Promise.resolve(tabCloseContext) }),
  })
  const tabCloseOpen = await tabCloseManager.open({ url: 'about:blank' })
  const tabCloseNavigation = tabCloseManager.navigate({
    session_id: tabCloseOpen.session_id, url: 'https://example.com/tab-close',
  })
  await tabCloseStarted.promise
  const tabClose = tabCloseManager.tabs({
    session_id: tabCloseOpen.session_id, page_id: tabCloseOpen.page_id, action: 'close',
  })
  await delay(0)
  assert.equal(tabClosePage.closed, false, 'tabs close waits for accepted target-page operations')
  tabCloseGate.resolve()
  await Promise.all([tabCloseNavigation, tabClose])
  assert.equal(tabClosePage.closed, true)
  await tabCloseManager.shutdown()

  const allPagesOneStarted = deferred()
  const allPagesTwoStarted = deferred()
  const allPagesOneGate = deferred()
  const allPagesTwoGate = deferred()
  const allPagesOne = new FakePage()
  const allPagesTwo = new FakePage()
  allPagesOne.goto = async url => {
    allPagesOneStarted.resolve()
    await allPagesOneGate.promise
    allPagesOne.currentUrl = url
  }
  allPagesTwo.goto = async url => {
    allPagesTwoStarted.resolve()
    await allPagesTwoGate.promise
    allPagesTwo.currentUrl = url
  }
  const allPagesContext = new FakeContext({ pagePromise: allPagesOne })
  const allPagesManager = fakeManager('all-pages-close', {
    launch: async () => new FakeBrowser({ contextPromise: Promise.resolve(allPagesContext) }),
  })
  const allPagesOpen = await allPagesManager.open({ url: 'about:blank' })
  allPagesContext.newPage = async () => allPagesTwo
  const allPagesTabs = await allPagesManager.tabs({ session_id: allPagesOpen.session_id, action: 'new' })
  const allPagesNavigationOne = allPagesManager.navigate({
    session_id: allPagesOpen.session_id, page_id: allPagesOpen.page_id, url: 'https://example.com/all-one',
  })
  const allPagesNavigationTwo = allPagesManager.navigate({
    session_id: allPagesOpen.session_id, page_id: allPagesTabs.active_page_id, url: 'https://example.com/all-two',
  })
  await Promise.all([allPagesOneStarted.promise, allPagesTwoStarted.promise])
  const allPagesClose = allPagesManager.close({ session_id: allPagesOpen.session_id })
  await delay(0)
  assert.equal(allPagesContext.closed, false)
  allPagesOneGate.resolve()
  await allPagesNavigationOne
  await delay(0)
  assert.equal(allPagesContext.closed, false, 'session close waits for every page queue, not only the active page')
  allPagesTwoGate.resolve()
  await Promise.all([allPagesNavigationTwo, allPagesClose])
  assert.equal(allPagesContext.closed, true)
  await allPagesManager.shutdown()

  const queueTimeoutStarted = deferred()
  const queueTimeoutGate = deferred()
  const queueTimeoutPage = new FakePage()
  queueTimeoutPage.goto = async url => {
    queueTimeoutStarted.resolve()
    await queueTimeoutGate.promise
    queueTimeoutPage.currentUrl = url
  }
  const queueTimeoutContext = new FakeContext({ pagePromise: queueTimeoutPage })
  const queueTimeoutManager = fakeManager('queue-timeout-shutdown', {
    launch: async () => new FakeBrowser({ contextPromise: Promise.resolve(queueTimeoutContext) }),
  }, { operationQueueTimeoutMs: 60, operationDrainTimeoutMs: 80, sessionCloseTimeoutMs: 80 })
  const queueTimeoutOpen = await queueTimeoutManager.open({ url: 'about:blank' })
  const queueTimeoutActive = queueTimeoutManager.navigate({
    session_id: queueTimeoutOpen.session_id, url: 'https://example.com/queue-active',
  })
  const queueTimeoutActiveOutcome = assert.rejects(
    queueTimeoutActive,
    err => err instanceof BrowserSessionError && err.code === 'SESSION_CLOSING' && err.startedAt !== null,
  )
  await queueTimeoutStarted.promise
  const timedOutQueued = queueTimeoutManager.navigate({
    session_id: queueTimeoutOpen.session_id, url: 'https://example.com/queue-timeout',
  })
  await assert.rejects(
    timedOutQueued,
    err => err instanceof BrowserSessionError && err.code === 'OPERATION_QUEUE_TIMEOUT' &&
      /^bo_/.test(err.operationId) && err.startedAt === null,
  )
  const boundedShutdownStarted = Date.now()
  await queueTimeoutManager.shutdown()
  assert.ok(Date.now() - boundedShutdownStarted < 1_000, 'queue timeout and an unresponsive active task cannot hang shutdown')
  await queueTimeoutActiveOutcome
  queueTimeoutGate.resolve()
  await delay(0)

  const operationStarted = deferred()
  const operationGate = deferred()
  const coordinatedPage = new FakePage()
  coordinatedPage.goto = async url => {
    operationStarted.resolve()
    await operationGate.promise
    coordinatedPage.currentUrl = url
  }
  const coordinatedContext = new FakeContext({ pagePromise: coordinatedPage })
  const coordinatedBrowser = new FakeBrowser({ contextPromise: Promise.resolve(coordinatedContext) })
  const coordinatedManager = fakeManager('coordinated-close', { launch: async () => coordinatedBrowser })
  const coordinatedOpen = await coordinatedManager.open({ url: 'about:blank' })
  const navigation = coordinatedManager.navigate({
    session_id: coordinatedOpen.session_id,
    url: 'https://example.com/in-flight',
  })
  await operationStarted.promise
  const coordinatedClose = coordinatedManager.close({ session_id: coordinatedOpen.session_id })
  await delay(0)
  assert.equal(coordinatedContext.closed, false, 'close waits for an accepted in-flight operation')
  assert.equal(coordinatedManager.sessions.has(coordinatedOpen.session_id), true, 'closing session remains tracked')
  await assert.rejects(
    coordinatedManager.tabs({ session_id: coordinatedOpen.session_id }),
    err => err instanceof BrowserSessionError && err.code === 'SESSION_CLOSING',
  )
  operationGate.resolve()
  await Promise.all([navigation, coordinatedClose])
  assert.equal(coordinatedContext.closed, true)
  assert.equal(coordinatedManager.sessions.has(coordinatedOpen.session_id), false)
  await assert.rejects(
    coordinatedManager.tabs({ session_id: coordinatedOpen.session_id }),
    err => err instanceof BrowserSessionError && err.code === 'SESSION_CLOSED' && err.closeReason === 'USER_CLOSE',
  )
  const repeatedClose = await coordinatedManager.close({ session_id: coordinatedOpen.session_id })
  assert.equal(repeatedClose.close_reason, 'USER_CLOSE', 'idempotent close exposes the tombstoned close reason')
  await coordinatedManager.shutdown()

  const boundedTombstoneBrowser = new FakeBrowser()
  const boundedTombstoneManager = new BrowserSessionManager({
    sandboxRoot: path.join(tempRoot, 'bounded-tombstone-sandbox'),
    userDataRoot: path.join(tempRoot, 'bounded-tombstone-user-data'),
    maxClosedSessions: 1,
    chromiumLoader: async () => ({ launch: async () => boundedTombstoneBrowser }),
    hostnameResolver: async () => [{ address: '93.184.216.34' }],
  })
  const evictedTombstone = await boundedTombstoneManager.open({ url: 'about:blank' })
  await boundedTombstoneManager.close({ session_id: evictedTombstone.session_id })
  const retainedTombstone = await boundedTombstoneManager.open({ url: 'about:blank' })
  await boundedTombstoneManager.close({ session_id: retainedTombstone.session_id })
  assert.equal(boundedTombstoneManager.closedSessions.size, 1, 'closed-session diagnostics are bounded')
  await assert.rejects(
    boundedTombstoneManager.tabs({ session_id: evictedTombstone.session_id }),
    err => err instanceof BrowserSessionError && err.code === 'SESSION_NOT_FOUND',
  )
  await assert.rejects(
    boundedTombstoneManager.tabs({ session_id: retainedTombstone.session_id }),
    err => err instanceof BrowserSessionError && err.code === 'SESSION_CLOSED' && err.closeReason === 'USER_CLOSE',
  )
  await boundedTombstoneManager.shutdown()

  const abortedOperationStarted = deferred()
  const abortedOperationGate = deferred()
  const abortedPage = new FakePage()
  abortedPage.goto = async url => {
    abortedOperationStarted.resolve()
    await abortedOperationGate.promise
    abortedPage.currentUrl = url
  }
  const abortedContext = new FakeContext({ pagePromise: abortedPage })
  const abortedBrowser = new FakeBrowser({ contextPromise: Promise.resolve(abortedContext) })
  const abortedOperationManager = fakeManager('aborted-operation-close', { launch: async () => abortedBrowser })
  const abortedOpen = await abortedOperationManager.open({ url: 'about:blank' })
  const operationAbort = new AbortController()
  const abortedNavigation = abortedOperationManager.navigate({
    session_id: abortedOpen.session_id,
    url: 'https://example.com/aborted',
  }, { signal: operationAbort.signal })
  await abortedOperationStarted.promise
  operationAbort.abort('caller stopped waiting')
  await assert.rejects(abortedNavigation, err => err.name === 'AbortError')
  assert.equal(
    abortedOperationManager.sessions.get(abortedOpen.session_id).activeOperations,
    1,
    'caller abort does not pretend the underlying Playwright operation has settled',
  )
  const abortedClose = abortedOperationManager.close({ session_id: abortedOpen.session_id })
  await delay(0)
  assert.equal(abortedContext.closed, false, 'close still coordinates an operation whose caller was aborted')
  abortedOperationGate.resolve()
  await abortedClose
  assert.equal(abortedContext.closed, true)
  await abortedOperationManager.shutdown()

  const failedCloseContext = new FakeContext()
  failedCloseContext.close = async () => { throw new Error('simulated context close failure') }
  const failedCloseBrowser = new FakeBrowser({ contextPromise: Promise.resolve(failedCloseContext) })
  const failedCloseManager = fakeManager('failed-session-close', { launch: async () => failedCloseBrowser })
  const failedCloseOpen = await failedCloseManager.open({ url: 'about:blank' })
  await assert.rejects(
    failedCloseManager.close({ session_id: failedCloseOpen.session_id }),
    err => err instanceof BrowserSessionError && err.code === 'SESSION_CLOSE_FAILED',
  )
  assert.equal(failedCloseManager.sessions.has(failedCloseOpen.session_id), true, 'failed close retains diagnostics')
  assert.equal(failedCloseManager.sessions.get(failedCloseOpen.session_id).state, 'degraded')
  const failedCloseListing = failedCloseManager.listSessions()
  assert.equal(failedCloseListing.count, 0, 'a degraded session is not counted as active')
  assert.deepEqual(failedCloseListing.degraded_sessions, [{
    session_id: failedCloseOpen.session_id,
    state: 'degraded',
    close_reason: 'USER_CLOSE',
    failure_code: 'SESSION_CLOSE_FAILED',
    visible: true,
    persistent: false,
  }], 'browser_sessions exposes bounded diagnostics without page URLs or other sensitive state')
  await assert.rejects(
    failedCloseManager.tabs({ session_id: failedCloseOpen.session_id }),
    err => err instanceof BrowserSessionError && err.code === 'SESSION_CLOSE_FAILED',
  )
  await failedCloseManager.shutdown()

  // about:blank cannot be made persistent because it has no site origin.
  const persistentValidationManager = fakeManager('persistent-validation', {})
  await assert.rejects(
    persistentValidationManager.open({ persistent: true, profile: 'work', url: 'about:blank' }),
    err => err instanceof BrowserSessionError && err.code === 'INVALID_ARGUMENT' && /initial http\(s\) URL/.test(err.message),
  )
  await persistentValidationManager.shutdown()

  const persistentUserData = path.join(tempRoot, 'persistent-user-data')
  const persistentPaths = []
  const persistentBrowsers = []
  const persistentChromium = {
    launchPersistentContext: async profilePath => {
      persistentPaths.push(profilePath)
      const browser = new FakeBrowser()
      const context = new FakeContext({ browser })
      persistentBrowsers.push(browser)
      return context
    },
  }
  const persistentOptions = {
    sandboxRoot: path.join(tempRoot, 'persistent-sandbox'),
    userDataRoot: persistentUserData,
    chromiumLoader: async () => persistentChromium,
    hostnameResolver: async () => [{ address: '93.184.216.34' }],
  }
  const userScope = { currentTargetId: 'ID:user-one' }
  const otherScope = { currentTargetId: 'ID:user-two' }
  const persistentOne = new BrowserSessionManager(persistentOptions)
  const firstPersistent = await persistentOne.open({
    persistent: true, profile: 'work_login', url: 'https://example.com/account', visible: false,
  }, userScope)
  const firstProfilePath = persistentPaths.at(-1)
  fs.writeFileSync(path.join(firstProfilePath, 'login-state-marker'), 'authenticated')

  const concurrentPersistent = new BrowserSessionManager(persistentOptions)
  await assert.rejects(
    concurrentPersistent.open({
      persistent: true, profile: 'work_login', url: 'https://example.com/other', visible: false,
    }, userScope),
    err => err instanceof BrowserSessionError && err.code === 'PROFILE_IN_USE',
  )
  await persistentOne.close({ session_id: firstPersistent.session_id })
  await persistentOne.shutdown()

  const reopenedPersistent = await concurrentPersistent.open({
    persistent: true, profile: 'work_login', url: 'https://example.com/restart', visible: false,
  }, userScope)
  assert.equal(persistentPaths.at(-1), firstProfilePath, 'same scope/origin/name reuses state after manager restart')
  assert.equal(fs.readFileSync(path.join(persistentPaths.at(-1), 'login-state-marker'), 'utf8'), 'authenticated')
  const scopedProfiles = concurrentPersistent.listSessions({ include_profiles: true }, userScope).profiles
  assert.deepEqual(scopedProfiles.map(item => [item.profile, item.site, item.in_use]), [
    ['work_login', 'https://example.com', true],
  ])
  assert.deepEqual(concurrentPersistent.listSessions({ include_profiles: true }, otherScope).profiles, [])
  await concurrentPersistent.close({ session_id: reopenedPersistent.session_id })

  const otherSite = await concurrentPersistent.open({
    persistent: true, profile: 'work_login', url: 'https://example.org/', visible: false,
  }, userScope)
  assert.notEqual(persistentPaths.at(-1), firstProfilePath, 'same name on a different origin is isolated')
  await concurrentPersistent.close({ session_id: otherSite.session_id })
  const otherUser = await concurrentPersistent.open({
    persistent: true, profile: 'work_login', url: 'https://example.com/', visible: false,
  }, otherScope)
  assert.notEqual(persistentPaths.at(-1), firstProfilePath, 'same site/name in a different user/task scope is isolated')
  await concurrentPersistent.close({ session_id: otherUser.session_id })

  const externalLockPath = path.join(
    persistentUserData, 'browser-profiles', 'v2', 'locks', `${reopenedPersistent.profile_id}.lock`,
  )
  fs.mkdirSync(externalLockPath)
  fs.writeFileSync(path.join(externalLockPath, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'external-owner' }))
  assert.equal(
    concurrentPersistent.listSessions({ include_profiles: true }, userScope).profiles
      .find(item => item.profile_id === reopenedPersistent.profile_id)?.in_use,
    true,
  )
  await assert.rejects(
    concurrentPersistent.close({
      clear_profile: true, profile: 'work_login', url: 'https://example.com/settings',
    }, userScope),
    err => err instanceof BrowserSessionError && err.code === 'PROFILE_IN_USE',
  )
  assert.equal(fs.existsSync(firstProfilePath), true, 'offline cleanup never deletes a profile protected by an external live lock')
  fs.rmSync(externalLockPath, { recursive: true, force: true })

  const offlineClear = await concurrentPersistent.close({
    clear_profile: true, profile: 'work_login', url: 'https://example.com/settings',
  }, userScope)
  assert.equal(offlineClear.profile_cleared, true)
  assert.equal(fs.existsSync(firstProfilePath), false, 'offline cleanup removes saved login state')
  assert.deepEqual(concurrentPersistent.listSessions({ include_profiles: true }, userScope).profiles.map(item => item.site), [
    'https://example.org',
  ])

  const clearLive = await concurrentPersistent.open({
    persistent: true, profile: 'temporary', url: 'https://example.net/', visible: false,
  }, userScope)
  const clearLivePath = persistentPaths.at(-1)
  const clearLiveBrowser = persistentBrowsers.at(-1)
  const clearedLive = await concurrentPersistent.close({ session_id: clearLive.session_id, clear_profile: true })
  assert.equal(clearedLive.profile_cleared, true)
  assert.equal(clearLiveBrowser.closed, true, 'live cleanup flushes/closes the owning persistent browser before deletion')
  assert.equal(fs.existsSync(clearLivePath), false, 'live cleanup closes Chromium before deleting its profile')
  await concurrentPersistent.shutdown()

  let removeAttempts = 0
  let renameAttempts = 0
  const retryCleanupManager = new BrowserSessionManager({
    ...persistentOptions,
    userDataRoot: path.join(tempRoot, 'retry-cleanup-user-data'),
    profileRemoveTreeAsync: async target => {
      removeAttempts += 1
      if (removeAttempts < 3) {
        const err = new Error('simulated Windows profile handle delay')
        err.code = 'EPERM'
        throw err
      }
      await fs.promises.rm(target, { recursive: true, force: true })
    },
    profileRenameAsync: async (source, destination) => {
      renameAttempts += 1
      if (renameAttempts < 3) {
        const err = new Error('simulated Windows profile rename handle delay')
        err.code = 'EBUSY'
        throw err
      }
      await fs.promises.rename(source, destination)
    },
  })
  const retryCleanup = await retryCleanupManager.open({
    persistent: true, profile: 'retry_cleanup', url: 'https://example.com/', visible: false,
  }, userScope)
  await retryCleanupManager.close({ session_id: retryCleanup.session_id, clear_profile: true })
  assert.equal(renameAttempts, 3, 'profile quarantine rename retries transient Windows EBUSY failures')
  assert.equal(removeAttempts, 3, 'profile deletion retries transient Windows EPERM failures')
  await retryCleanupManager.shutdown()

  const closeFailureUserData = path.join(tempRoot, 'close-failure-user-data')
  const closeFailureBrowser = new FakeBrowser()
  closeFailureBrowser.close = async () => { throw new Error('simulated persistent browser close failure') }
  const closeFailureContext = new FakeContext({ browser: closeFailureBrowser })
  const closeFailureOptions = {
    sandboxRoot: path.join(tempRoot, 'close-failure-sandbox'),
    userDataRoot: closeFailureUserData,
    chromiumLoader: async () => ({ launchPersistentContext: async () => closeFailureContext }),
    hostnameResolver: async () => [{ address: '93.184.216.34' }],
  }
  const closeFailureManager = new BrowserSessionManager(closeFailureOptions)
  const closeFailureOpen = await closeFailureManager.open({
    persistent: true, profile: 'must_stay_locked', url: 'https://example.com/', visible: false,
  }, userScope)
  const closeFailureProfilePath = path.join(
    closeFailureUserData, 'browser-profiles', 'v2', 'profiles', closeFailureOpen.profile_id,
  )
  await assert.rejects(
    closeFailureManager.close({ session_id: closeFailureOpen.session_id, clear_profile: true }),
    err => err instanceof BrowserSessionError && err.code === 'PROFILE_CLOSE_FAILED',
  )
  assert.equal(closeFailureBrowser.isConnected(), true)
  assert.equal(fs.existsSync(closeFailureProfilePath), true, 'failed close never deletes a profile still owned by a live browser')
  const closeFailureCompetitor = new BrowserSessionManager(closeFailureOptions)
  await assert.rejects(
    closeFailureCompetitor.open({
      persistent: true, profile: 'must_stay_locked', url: 'https://example.com/', visible: false,
    }, userScope),
    err => err instanceof BrowserSessionError && err.code === 'PROFILE_IN_USE',
  )
  await closeFailureCompetitor.shutdown()
  await closeFailureManager.shutdown()

  const disconnectRejectBrowser = new FakeBrowser()
  disconnectRejectBrowser.close = async () => {
    disconnectRejectBrowser.closed = true
    throw new Error('transport rejected after process exit')
  }
  const disconnectRejectManager = new BrowserSessionManager({
    ...closeFailureOptions,
    userDataRoot: path.join(tempRoot, 'disconnect-reject-user-data'),
    chromiumLoader: async () => ({
      launchPersistentContext: async () => new FakeContext({ browser: disconnectRejectBrowser }),
    }),
  })
  const disconnectRejectOpen = await disconnectRejectManager.open({
    persistent: true, profile: 'disconnect_then_reject', url: 'https://example.com/', visible: false,
  }, userScope)
  await assert.rejects(
    disconnectRejectManager.close({ session_id: disconnectRejectOpen.session_id }),
    err => err instanceof BrowserSessionError && err.code === 'PROFILE_CLOSE_FAILED',
  )
  const disconnectRejectLock = path.join(
    tempRoot, 'disconnect-reject-user-data', 'browser-profiles', 'v2', 'locks', `${disconnectRejectOpen.profile_id}.lock`,
  )
  assert.equal(fs.existsSync(disconnectRejectLock), false, 'a rejected close releases only after disconnection is proven')
  await disconnectRejectManager.shutdown()

  const neverCloseBrowser = new FakeBrowser()
  neverCloseBrowser.close = () => new Promise(() => {})
  const neverCloseManager = new BrowserSessionManager({
    ...closeFailureOptions,
    userDataRoot: path.join(tempRoot, 'never-close-user-data'),
    persistentCloseTimeoutMs: 500,
    chromiumLoader: async () => ({
      launchPersistentContext: async () => new FakeContext({ browser: neverCloseBrowser }),
    }),
  })
  const neverCloseOpen = await neverCloseManager.open({
    persistent: true, profile: 'never_close', url: 'https://example.com/', visible: false,
  }, userScope)
  const neverCloseStarted = Date.now()
  await assert.rejects(
    neverCloseManager.close({ session_id: neverCloseOpen.session_id }),
    err => err instanceof BrowserSessionError && err.code === 'PROFILE_CLOSE_FAILED',
  )
  assert.ok(Date.now() - neverCloseStarted >= 450 && Date.now() - neverCloseStarted < 2_000)
  const neverCloseLock = path.join(
    tempRoot, 'never-close-user-data', 'browser-profiles', 'v2', 'locks', `${neverCloseOpen.profile_id}.lock`,
  )
  assert.equal(fs.existsSync(neverCloseLock), true, 'timed-out close keeps the live owner lock')
  await neverCloseManager.shutdown()

  const openFailureBrowser = new FakeBrowser()
  let openFailureCloseCount = 0
  let openFailureContext
  openFailureBrowser.close = async () => {
    openFailureCloseCount += 1
    openFailureContext.emit('close')
    throw new Error('open-failure cleanup could not close browser')
  }
  const openFailurePage = new FakePage()
  openFailurePage.goto = async () => { throw new Error('simulated navigation failure') }
  openFailureContext = new FakeContext({ browser: openFailureBrowser, pagePromise: openFailurePage })
  const openFailureOptions = {
    ...closeFailureOptions,
    userDataRoot: path.join(tempRoot, 'open-failure-user-data'),
    chromiumLoader: async () => ({
      launchPersistentContext: async () => openFailureContext,
    }),
  }
  const openFailureManager = new BrowserSessionManager(openFailureOptions)
  await assert.rejects(
    openFailureManager.open({
      persistent: true, profile: 'open_failure', url: 'https://example.com/', visible: false,
    }, userScope),
    err => err instanceof BrowserSessionError && err.code === 'OPERATION_FAILED',
  )
  assert.equal(openFailureCloseCount, 1, 'registered-session open failure uses one close path despite context close event')
  assert.equal(
    openFailureManager.listSessions({ include_profiles: true }, userScope).profiles
      .find(item => item.profile === 'open_failure')?.in_use,
    true,
    'failed open retains the profile lock when cleanup leaves its browser connected',
  )
  const openFailureCompetitor = new BrowserSessionManager(openFailureOptions)
  await assert.rejects(
    openFailureCompetitor.open({
      persistent: true, profile: 'open_failure', url: 'https://example.com/', visible: false,
    }, userScope),
    err => err instanceof BrowserSessionError && err.code === 'PROFILE_IN_USE',
  )
  await openFailureCompetitor.shutdown()
  await openFailureManager.shutdown()

  // Recover an app lock left by a dead process, while never stealing a live lock.
  const crashManager = new BrowserSessionManager(persistentOptions)
  const crashOpen = await crashManager.open({
    persistent: true, profile: 'crash_recovery', url: 'https://example.com/', visible: false,
  }, userScope)
  const crashProfileId = crashOpen.profile_id
  await crashManager.close({ session_id: crashOpen.session_id })
  await crashManager.shutdown()
  const staleLockPath = path.join(persistentUserData, 'browser-profiles', 'v2', 'locks', `${crashProfileId}.lock`)
  fs.mkdirSync(staleLockPath)
  fs.writeFileSync(path.join(staleLockPath, 'owner.json'), JSON.stringify({ pid: 2_147_483_647, token: 'dead' }))
  const recoveredManager = new BrowserSessionManager({
    ...persistentOptions,
    profileProcessAlive: () => false,
  })
  assert.equal(
    recoveredManager.listSessions({ include_profiles: true }, userScope).profiles
      .find(item => item.profile_id === crashProfileId)?.in_use,
    false,
    'profile listing recovers a dead-process lock instead of reporting permanent in-use state',
  )
  const recovered = await recoveredManager.open({
    persistent: true, profile: 'crash_recovery', url: 'https://example.com/', visible: false,
  }, userScope)
  assert.equal(recovered.profile_id, crashProfileId)
  await recoveredManager.close({ session_id: recovered.session_id })
  await recoveredManager.shutdown()

  const interruptedTrash = path.join(persistentUserData, 'browser-profiles', 'v2', 'trash', 'interrupted-delete')
  fs.mkdirSync(interruptedTrash, { recursive: true })
  fs.writeFileSync(path.join(interruptedTrash, 'cookie-debris'), 'secret')
  const cleanupRecovery = new BrowserSessionManager(persistentOptions)
  assert.equal(fs.existsSync(interruptedTrash), false, 'startup finishes an interrupted atomic profile deletion')
  await cleanupRecovery.shutdown()

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
  const persistentCleanupGate = deferred()
  const latePersistentBrowser = new FakeBrowser()
  latePersistentBrowser.close = async () => {
    await persistentCleanupGate.promise
    latePersistentBrowser.closed = true
  }
  const latePersistentContext = new FakeContext({ browser: latePersistentBrowser })
  const latePersistentOptions = {
    sandboxRoot: path.join(tempRoot, 'late-persistent-sandbox'),
    userDataRoot: path.join(tempRoot, 'late-persistent-user-data'),
    persistentCloseTimeoutMs: 500,
    hostnameResolver: async () => [{ address: '93.184.216.34' }],
    chromiumLoader: async () => ({
      launchPersistentContext: () => {
        persistentStarted.resolve()
        return delay(20).then(() => latePersistentContext)
      },
    }),
  }
  const persistentAbortManager = new BrowserSessionManager(latePersistentOptions)
  const persistentAbort = new AbortController()
  const persistentOpen = persistentAbortManager.open(
    { persistent: true, profile: 'test-profile', url: 'https://example.com/' },
    { signal: persistentAbort.signal },
  )
  await persistentStarted.promise
  persistentAbort.abort('cancel delayed persistent context')
  await assert.rejects(persistentOpen, err => err.name === 'AbortError')
  await delay(30)
  const latePersistentCompetitor = new BrowserSessionManager({
    ...latePersistentOptions,
    chromiumLoader: async () => ({ launchPersistentContext: async () => new FakeContext({ browser: new FakeBrowser() }) }),
  })
  await assert.rejects(
    latePersistentCompetitor.open({
      persistent: true, profile: 'test-profile', url: 'https://example.com/',
    }),
    err => err instanceof BrowserSessionError && err.code === 'PROFILE_IN_USE',
  )
  const persistentShutdownStarted = Date.now()
  await persistentAbortManager.shutdown()
  assert.ok(Date.now() - persistentShutdownStarted < 2_000, 'late persistent cleanup timeout keeps shutdown bounded')
  const lateProfile = persistentAbortManager.profileStore.identity('test-profile', 'https://example.com/', {})
  assert.equal(fs.existsSync(lateProfile.lockPath), true, 'timed-out late cleanup retains its profile lock')
  persistentCleanupGate.resolve()
  await delay(0)
  assert.equal(fs.existsSync(lateProfile.lockPath), false, 'a late successful disconnect releases the retained abort lock')
  const reopenedAfterLateCleanup = await latePersistentCompetitor.open({
    persistent: true, profile: 'test-profile', url: 'https://example.com/',
  })
  await latePersistentCompetitor.close({ session_id: reopenedAfterLateCleanup.session_id })
  await latePersistentCompetitor.shutdown()

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
