import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { paths } from '../../../paths.js'
import { createAbortError, throwIfAborted } from '../../abort-utils.js'
import {
  browserContextOptions, browserLaunchOptions, launchBrowser,
  launchPersistentBrowserContext, loadChromium,
} from './runtime.js'
import { clearPageRefs, inspectPage } from './snapshot.js'

const ALLOWED_ACTIONS = new Set([
  'click', 'fill', 'press', 'select', 'check', 'uncheck', 'hover',
  'scroll', 'wait', 'back', 'forward', 'reload',
])

export class BrowserSessionError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined)
    this.name = 'BrowserSessionError'
    this.code = code
  }
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value ?? fallback)
  if (!Number.isFinite(number)) throw new BrowserSessionError('INVALID_ARGUMENT', 'Expected a finite number')
  return Math.max(min, Math.min(Math.trunc(number), max))
}

function optionalBoolean(args, key, fallback = false) {
  const value = args?.[key]
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new BrowserSessionError('INVALID_ARGUMENT', `${key} must be a boolean`)
  return value
}

function sessionId() {
  return `bs_${crypto.randomBytes(12).toString('hex')}`
}

function pageId() {
  return `bp_${crypto.randomBytes(8).toString('hex')}`
}

export function sanitizeBrowserRuntimeUrl(value, maxLength = 240) {
  const raw = String(value || 'about:blank')
  if (raw === 'about:blank') return raw
  try {
    const parsed = new URL(raw)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    const safe = parsed.href
    return safe.length <= maxLength ? safe : `${safe.slice(0, Math.max(0, maxLength - 1))}…`
  } catch {
    return '[unavailable]'
  }
}

function profileName(value) {
  const name = String(value || 'default').trim()
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    throw new BrowserSessionError('INVALID_ARGUMENT', 'profile must contain only letters, numbers, _ or -')
  }
  return name
}

export function normalizeBrowserUrl(value, { optional = false } = {}) {
  if ((value === undefined || value === null || value === '') && optional) return null
  const raw = String(value || 'about:blank').trim()
  if (raw === 'about:blank') return raw
  let parsed
  try { parsed = new URL(raw) } catch { throw new BrowserSessionError('INVALID_ARGUMENT', `Invalid URL: ${raw}`) }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new BrowserSessionError('URL_BLOCKED', `Unsupported URL protocol: ${parsed.protocol}`)
  }
  if (parsed.username || parsed.password) throw new BrowserSessionError('URL_BLOCKED', 'URLs containing credentials are not allowed')
  return parsed.href
}

function isPrivateAddress(address) {
  const value = String(address || '').toLowerCase().split('%')[0]
  if (net.isIP(value) === 4) {
    const bytes = value.split('.').map(Number)
    return bytes[0] === 10 || bytes[0] === 127 || bytes[0] === 0 ||
      (bytes[0] === 169 && bytes[1] === 254) || (bytes[0] === 172 && bytes[1] >= 16 && bytes[1] <= 31) ||
      (bytes[0] === 192 && bytes[1] === 168) || (bytes[0] === 100 && bytes[1] >= 64 && bytes[1] <= 127) ||
      (bytes[0] === 198 && [18, 19].includes(bytes[1])) || bytes[0] >= 224
  }
  if (net.isIP(value) === 6) {
    if (value.startsWith('::ffff:') && net.isIP(value.slice(7)) === 4) return isPrivateAddress(value.slice(7))
    const mappedHex = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    if (mappedHex) {
      const high = Number.parseInt(mappedHex[1], 16)
      const low = Number.parseInt(mappedHex[2], 16)
      return isPrivateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
    }
    return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') ||
      /^fe[89ab]/.test(value) || value.startsWith('ff') || value.startsWith('::ffff:127.') ||
      value.startsWith('::ffff:10.') || value.startsWith('::ffff:192.168.')
  }
  return false
}

export async function assertBrowserUrlAllowed(value, options = {}) {
  const normalized = normalizeBrowserUrl(value)
  if (normalized === 'about:blank') return normalized
  const parsed = new URL(normalized)
  const allowPrivateNetwork = typeof options.allowPrivateNetwork === 'function'
    ? options.allowPrivateNetwork() === true
    : options.allowPrivateNetwork === true
  if (allowPrivateNetwork) return normalized
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || isPrivateAddress(hostname)) {
    throw new BrowserSessionError('PRIVATE_NETWORK_BLOCKED', `Private or local network URL is disabled: ${parsed.hostname}`)
  }
  const resolver = options.hostnameResolver || (name => dns.lookup(name, { all: true, verbatim: true }))
  let addresses
  try { addresses = await resolver(hostname) } catch (err) {
    throw new BrowserSessionError('DNS_FAILED', `Could not resolve browser URL host: ${hostname}`, err)
  }
  const records = Array.isArray(addresses) ? addresses : [addresses]
  if (records.length === 0) throw new BrowserSessionError('DNS_FAILED', `Browser URL host returned no addresses: ${hostname}`)
  if (records.some(record => isPrivateAddress(record?.address || record))) {
    throw new BrowserSessionError('PRIVATE_NETWORK_BLOCKED', `Browser URL resolves to a private or local address: ${hostname}`)
  }
  return normalized
}

async function raceAbort(promise, signal) {
  throwIfAborted(signal)
  if (!signal) return promise
  let onAbort
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(createAbortError(signal.reason || 'Aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

function mergeAbortSignals(...signals) {
  const active = signals.filter(Boolean)
  if (!active.length) return { signal: null, cleanup() {} }
  const controller = new AbortController()
  const listeners = new Map()
  const abortFrom = signal => {
    if (!controller.signal.aborted) controller.abort(signal.reason || 'Aborted')
  }
  for (const signal of active) {
    if (signal.aborted) abortFrom(signal)
    else {
      const listener = () => abortFrom(signal)
      listeners.set(signal, listener)
      signal.addEventListener('abort', listener, { once: true })
    }
  }
  return {
    signal: controller.signal,
    cleanup() {
      for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener)
      listeners.clear()
    },
  }
}

// Resource creation cannot be cancelled by Playwright. If AbortSignal wins the
// race, keep observing the creation promise and close a resource that appears
// later so it cannot become an orphan browser/context/page.
async function raceResource(resourcePromise, signal, cleanup, tracker) {
  let aborted = Boolean(signal?.aborted)
  let abortReason = signal?.reason || 'Aborted'
  let onAbort
  const tracked = Promise.resolve(resourcePromise).then(async resource => {
    if (!aborted) return resource
    try { await cleanup(resource) } catch {}
    throw createAbortError(abortReason)
  })
  if (tracker) {
    tracker.add(tracked)
    const untrack = () => tracker.delete(tracked)
    tracked.then(untrack, untrack)
  }
  if (!signal) return tracked
  if (aborted) {
    tracked.catch(() => {})
    throw createAbortError(abortReason)
  }
  const abortedPromise = new Promise((_, reject) => {
    onAbort = () => {
      aborted = true
      abortReason = signal.reason || 'Aborted'
      reject(createAbortError(abortReason))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([tracked, abortedPromise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export class BrowserSessionManager {
  constructor(options = {}) {
    this.maxSessions = boundedInteger(options.maxSessions, 4, 1, 32)
    this.maxPagesPerSession = boundedInteger(options.maxPagesPerSession, 8, 1, 32)
    this.sessionTtlMs = boundedInteger(options.sessionTtlMs, 15 * 60_000, 1_000, 24 * 60 * 60_000)
    this.operationTimeoutMs = boundedInteger(options.operationTimeoutMs, 30_000, 500, 120_000)
    this.sandboxRoot = path.resolve(options.sandboxRoot || paths.sandboxDir)
    this.userDataRoot = path.resolve(options.userDataRoot || paths.userDir)
    this.chromiumLoader = options.chromiumLoader || loadChromium
    // Private/LAN browsing is disabled by default. The agent adapter binds this
    // to config.network.allowLanAccess; tests/local development must opt in.
    this.allowPrivateNetwork = options.allowPrivateNetwork || false
    this.hostnameResolver = options.hostnameResolver
    this.sessions = new Map()
    this.sharedBrowsers = new Map()
    this.sharedBrowserLaunches = new Map()
    this.resourceCreations = new Set()
    this.pendingOpenTasks = new Set()
    this.shutdownController = new AbortController()
    this.shutdownPromise = null
    this.pendingOpens = 0
    this.closed = false
    this.now = options.now || Date.now
    fs.mkdirSync(path.join(this.sandboxRoot, 'screenshots'), { recursive: true })
    fs.mkdirSync(path.join(this.userDataRoot, 'browser-profiles'), { recursive: true })
    this.sweepTimer = setInterval(() => this.sweepExpired().catch(() => {}), Math.min(this.sessionTtlMs, 30_000))
    this.sweepTimer.unref?.()
  }

  get size() { return this.sessions.size }

  async open(args = {}, context = {}) {
    this.#assertOpen()
    throwIfAborted(context.signal)
    if (this.sessions.size + this.pendingOpens >= this.maxSessions) {
      throw new BrowserSessionError('SESSION_LIMIT', `Maximum browser sessions reached (${this.maxSessions})`)
    }
    let finishPendingOpen
    const pendingOpenTask = new Promise(resolve => { finishPendingOpen = resolve })
    this.pendingOpenTasks.add(pendingOpenTask)
    this.pendingOpens += 1
    let merged = { signal: context.signal, cleanup() {} }
    let chromium = null
    let browser = null
    let browserContext = null
    const id = sessionId()
    let persistent = false
    try {
      const visible = optionalBoolean(args, 'visible', true)
      persistent = optionalBoolean(args, 'persistent')
      const url = await this.#assertUrl(args.url)
      const timeout = this.#timeout(args.timeout_ms)
      let persistentProfilePath = null
      if (persistent) {
        const root = path.join(this.userDataRoot, 'browser-profiles')
        persistentProfilePath = path.resolve(root, profileName(args.profile))
        if (path.dirname(persistentProfilePath) !== root) throw new BrowserSessionError('INVALID_ARGUMENT', 'Unsafe profile path')
      }
      merged = mergeAbortSignals(context.signal, this.shutdownController.signal)
      const signal = merged.signal
      chromium = await raceAbort(this.chromiumLoader(), signal)
      if (persistent) {
        fs.mkdirSync(persistentProfilePath, { recursive: true })
        browserContext = await raceResource(launchPersistentBrowserContext(chromium, persistentProfilePath, {
          ...browserLaunchOptions({ visible }),
          ...browserContextOptions(args),
        }), signal, resource => resource.close(), this.resourceCreations)
        browser = browserContext.browser()
      } else {
        browser = await this.#sharedBrowser(chromium, visible, signal)
        browserContext = await raceResource(
          browser.newContext(browserContextOptions(args)),
          signal,
          resource => resource.close(),
          this.resourceCreations,
        )
      }
      await this.#installRequestGuard(browserContext)
      const session = {
        id, browser, context: browserContext, persistent, visible,
        pages: new Map(), activePageId: null, lastUsed: this.now(), activeOperations: 0,
        failure: null, closing: false, preserveEmptyPages: 0,
      }
      this.sessions.set(id, session)
      browserContext.on?.('close', () => {
        if (!session.closing) this.#closeSession(session).catch(() => {})
      })
      browserContext.on('page', page => this.#registerPage(session, page))
      for (const existing of browserContext.pages()) this.#registerPage(session, existing)
      let active = this.#activePage(session)
      if (!active) {
        const page = await raceResource(
          browserContext.newPage(), signal, resource => resource.close(), this.resourceCreations,
        )
        active = this.#registerPage(session, page)
      }
      this.#configurePage(active.page, timeout)
      if (url !== 'about:blank') {
        await this.#operate(session, signal, () => active.page.goto(url, { waitUntil: 'domcontentloaded', timeout }))
      }
      return this.#sessionResult(session, active)
    } catch (err) {
      this.sessions.delete(id)
      try { await browserContext?.close() } catch {}
      if (persistent) try { await browser?.close() } catch {}
      throw this.#normalizeError(err, 'OPEN_FAILED')
    } finally {
      this.pendingOpens -= 1
      this.pendingOpenTasks.delete(pendingOpenTask)
      finishPendingOpen()
      merged.cleanup()
    }
  }

  async inspect(args = {}, context = {}) {
    const session = this.#getSession(args)
    const pageState = this.#getPage(session, args.page_id)
    const maxChars = boundedInteger(args.max_chars, 8_000, 500, 20_000)
    const maxElements = boundedInteger(args.max_elements, 80, 1, 200)
    const result = await this.#operate(session, context.signal, async () => {
      this.#assertPageHealthy(pageState)
      const snapshot = await inspectPage(pageState, { maxChars, maxElements })
      let screenshotPath = null
      if (args.screenshot) screenshotPath = await this.#screenshot(session, pageState, args.full_page)
      return {
        ok: true,
        session_id: session.id,
        page_id: pageState.id,
        url: pageState.page.url(),
        title: snapshot.title,
        text: snapshot.text,
        text_length: snapshot.textLength,
        truncated: snapshot.textLength > maxChars,
        elements: snapshot.elements,
        screenshot_path: screenshotPath,
      }
    })
    return result
  }

  async act(args = {}, context = {}) {
    const action = String(args.action || '').toLowerCase()
    if (!ALLOWED_ACTIONS.has(action)) {
      throw new BrowserSessionError('ACTION_NOT_ALLOWED', `Unsupported browser action: ${action || '(missing)'}`)
    }
    const session = this.#getSession(args)
    const pageState = this.#getPage(session, args.page_id)
    const timeout = this.#timeout(args.timeout_ms)
    return this.#operate(session, context.signal, async () => {
      this.#assertPageHealthy(pageState)
      const page = pageState.page
      this.#configurePage(page, timeout)
      let refEntry = null
      if (['click', 'fill', 'press', 'select', 'check', 'uncheck', 'hover'].includes(action)) {
        const ref = String(args.ref || '')
        refEntry = pageState.refs.get(ref)
        if (!refEntry || refEntry.epoch !== pageState.documentEpoch) {
          throw new BrowserSessionError('STALE_REF', `Unknown or stale element ref: ${ref || '(missing)'}`)
        }
      }
      const target = refEntry?.handle
      if (action === 'click') await target.click({ timeout })
      else if (action === 'fill') await target.fill(String(args.value ?? ''), { timeout })
      else if (action === 'press') await target.press(String(args.key || args.value || ''), { timeout })
      else if (action === 'select') {
        const values = args.values ?? args.value
        if (values === undefined) throw new BrowserSessionError('INVALID_ARGUMENT', 'select requires value or values')
        await target.selectOption(Array.isArray(values) ? values.map(String) : String(values), { timeout })
      } else if (action === 'check') await target.check({ timeout })
      else if (action === 'uncheck') await target.uncheck({ timeout })
      else if (action === 'hover') await target.hover({ timeout })
      else if (action === 'scroll') {
        if (args.ref) {
          const entry = pageState.refs.get(String(args.ref))
          if (!entry || entry.epoch !== pageState.documentEpoch) throw new BrowserSessionError('STALE_REF', `Unknown or stale element ref: ${args.ref}`)
          await entry.handle.hover({ timeout })
        }
        await page.mouse.wheel(
          boundedInteger(args.delta_x, 0, -100_000, 100_000),
          boundedInteger(args.delta_y, 700, -100_000, 100_000),
        )
      } else if (action === 'wait') {
        await page.waitForTimeout(boundedInteger(args.ms ?? args.value, 500, 0, 30_000))
      } else if (action === 'back') await page.goBack({ waitUntil: 'domcontentloaded', timeout })
      else if (action === 'forward') await page.goForward({ waitUntil: 'domcontentloaded', timeout })
      else if (action === 'reload') await page.reload({ waitUntil: 'domcontentloaded', timeout })
      return {
        ok: true, session_id: session.id, page_id: pageState.id,
        action, url: page.url(), title: await page.title(),
      }
    })
  }

  async tabs(args = {}, context = {}) {
    const session = this.#getSession(args)
    const action = String(args.action || 'list').toLowerCase()
    return this.#operate(session, context.signal, async () => {
      if (action === 'new') {
        if (session.pages.size >= this.maxPagesPerSession) {
          throw new BrowserSessionError('PAGE_LIMIT', `Maximum pages reached (${this.maxPagesPerSession})`)
        }
        const rawUrl = normalizeBrowserUrl(args.url, { optional: true })
        const url = rawUrl ? await this.#assertUrl(rawUrl) : null
        const page = await session.context.newPage()
        const state = this.#pageByObject(session, page) || this.#registerPage(session, page)
        session.activePageId = state.id
        if (url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.#timeout(args.timeout_ms) })
      } else if (action === 'switch') {
        const state = this.#getPage(session, args.page_id)
        session.activePageId = state.id
        await state.page.bringToFront()
      } else if (action === 'close') {
        const state = this.#getPage(session, args.page_id)
        session.preserveEmptyPages += 1
        try {
          await state.page.close()
          if (!session.pages.size) this.#registerPage(session, await session.context.newPage())
        } finally {
          session.preserveEmptyPages -= 1
          if (!session.pages.size) this.#closeSession(session).catch(() => {})
        }
      } else if (action !== 'list') {
        throw new BrowserSessionError('INVALID_ARGUMENT', `Unsupported tabs action: ${action}`)
      }
      return { ok: true, session_id: session.id, active_page_id: session.activePageId, pages: await this.#pageList(session) }
    })
  }

  async close(args = {}) {
    const id = String(args.session_id || args.sessionId || '')
    const session = this.sessions.get(id)
    if (!session) return { ok: true, session_id: id, closed: false }
    await this.#closeSession(session)
    return { ok: true, session_id: id, closed: true }
  }

  listSessions() {
    this.#assertOpen()
    const sessions = []
    for (const session of [...this.sessions.values()]) {
      for (const state of [...session.pages.values()]) {
        if (state.page.isClosed()) session.pages.delete(state.id)
      }
      const browserDisconnected = typeof session.browser?.isConnected === 'function' && !session.browser.isConnected()
      if (session.closing || session.failure || browserDisconnected || (!session.pages.size && !session.preserveEmptyPages)) {
        this.#closeSession(session).catch(() => {})
        continue
      }
      if (!session.pages.has(session.activePageId)) {
        session.activePageId = session.pages.keys().next().value || null
      }
      sessions.push({
        session_id: session.id,
        visible: session.visible,
        persistent: session.persistent,
        active_page_id: session.activePageId,
        pages: [...session.pages.values()].map(state => ({
          page_id: state.id,
          active: state.id === session.activePageId,
          url: sanitizeBrowserRuntimeUrl(state.page.url()),
        })),
      })
    }
    return { ok: true, count: sessions.length, sessions }
  }

  async sweepExpired() {
    const now = this.now()
    const expired = [...this.sessions.values()].filter(session => !session.activeOperations && now - session.lastUsed >= this.sessionTtlMs)
    await Promise.allSettled(expired.map(session => this.#closeSession(session)))
    return expired.length
  }

  async shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise
    this.closed = true
    this.shutdownController.abort('Browser session manager is shutting down')
    clearInterval(this.sweepTimer)
    this.shutdownPromise = (async () => {
      await Promise.allSettled([...this.pendingOpenTasks])
      // An aborted Playwright create call can settle later. Drain the tracker
      // until stable so shutdown never returns ahead of its late cleanup.
      while (this.resourceCreations.size) {
        await Promise.allSettled([...this.resourceCreations])
      }
      await Promise.allSettled([...this.sessions.values()].map(session => this.#closeSession(session)))
      await Promise.allSettled([...this.sharedBrowsers.values()].map(browser => browser.close()))
      this.sessions.clear()
      this.sharedBrowsers.clear()
      this.sharedBrowserLaunches.clear()
    })()
    return this.shutdownPromise
  }

  #assertOpen() {
    if (this.closed) throw new BrowserSessionError('MANAGER_CLOSED', 'Browser session manager is closed')
  }

  #timeout(value) { return boundedInteger(value, this.operationTimeoutMs, 500, 120_000) }

  async #sharedBrowser(chromium, visible, signal) {
    const key = visible ? 'visible' : 'headless'
    let browser = this.sharedBrowsers.get(key)
    if (browser?.isConnected()) return browser
    if (browser) this.sharedBrowsers.delete(key)

    let record = this.sharedBrowserLaunches.get(key)
    if (!record) {
      record = { browser: null, delivered: false, waiters: 0, promise: null }
      const creation = Promise.resolve(launchBrowser(chromium, browserLaunchOptions({ visible })))
        .then(async launched => {
          record.browser = launched
          if (record.waiters === 0 || this.shutdownController.signal.aborted) {
            try { await launched.close() } catch {}
            throw createAbortError(this.shutdownController.signal.reason || 'Browser launch no longer has a consumer')
          }
          return launched
        })
      record.promise = creation
      this.sharedBrowserLaunches.set(key, record)
      this.resourceCreations.add(creation)
      const settleSuccess = () => {
        this.resourceCreations.delete(creation)
      }
      const settleFailure = () => {
        this.resourceCreations.delete(creation)
        if (this.sharedBrowserLaunches.get(key) === record) this.sharedBrowserLaunches.delete(key)
      }
      creation.then(settleSuccess, settleFailure)
    }

    record.waiters += 1
    try {
      browser = await raceAbort(record.promise, signal)
      throwIfAborted(signal)
      record.delivered = true
      if (!this.sharedBrowsers.has(key)) {
        this.sharedBrowsers.set(key, browser)
        browser.on('disconnected', () => {
          if (this.sharedBrowsers.get(key) === browser) this.sharedBrowsers.delete(key)
          for (const session of this.sessions.values()) {
            if (session.browser === browser) {
              session.failure = new BrowserSessionError('BROWSER_DISCONNECTED', 'Browser process disconnected')
              this.#closeSession(session).catch(() => {})
            }
          }
        })
      }
      if (this.sharedBrowserLaunches.get(key) === record) this.sharedBrowserLaunches.delete(key)
      return browser
    } finally {
      record.waiters -= 1
      if (!record.delivered && record.waiters === 0 && record.browser?.isConnected()) {
        try { await record.browser.close() } catch {}
        if (this.sharedBrowserLaunches.get(key) === record) this.sharedBrowserLaunches.delete(key)
      }
    }
  }

  #registerPage(session, page) {
    const existing = this.#pageByObject(session, page)
    if (existing) return existing
    if (session.pages.size >= this.maxPagesPerSession) {
      page.close().catch(() => {})
      return null
    }
    const state = {
      id: pageId(), page, refs: new Map(), refToken: crypto.randomBytes(6).toString('hex'),
      documentEpoch: 0, failure: null,
    }
    session.pages.set(state.id, state)
    session.activePageId = state.id
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) {
        state.documentEpoch += 1
        // Clear synchronously so old refs become stale immediately. Do not dispose
        // the handles here: this event can fire while a click is still waiting for
        // its scheduled navigation, and disposing that click's handle turns a
        // successful navigation into a misleading TARGET_CLOSED error. Chromium
        // releases the old execution-context handles with the document.
        state.refs = new Map()
      }
    })
    page.on('crash', () => { state.failure = new BrowserSessionError('PAGE_CRASHED', 'Browser page crashed') })
    page.on('download', download => { download.cancel().catch(() => {}) })
    page.on('close', () => {
      clearPageRefs(state).catch(() => {})
      session.pages.delete(state.id)
      if (session.activePageId === state.id) session.activePageId = session.pages.keys().next().value || null
      if (!session.pages.size && !session.preserveEmptyPages && !session.closing) {
        this.#closeSession(session).catch(() => {})
      }
    })
    return state
  }

  #pageByObject(session, page) { return [...session.pages.values()].find(state => state.page === page) || null }
  #activePage(session) { return session.pages.get(session.activePageId) || session.pages.values().next().value || null }

  #getSession(args) {
    this.#assertOpen()
    const id = String(args.session_id || args.sessionId || '')
    const session = this.sessions.get(id)
    if (!session) throw new BrowserSessionError('SESSION_NOT_FOUND', `Browser session not found: ${id || '(missing)'}`)
    if (session.failure) throw session.failure
    if (session.closing) throw new BrowserSessionError('SESSION_CLOSED', `Browser session is closing: ${id}`)
    session.lastUsed = this.now()
    return session
  }

  #getPage(session, id) {
    const state = id ? session.pages.get(String(id)) : this.#activePage(session)
    if (!state) throw new BrowserSessionError('PAGE_NOT_FOUND', `Browser page not found: ${id || '(active)'}`)
    return state
  }

  #assertPageHealthy(state) {
    if (state.failure) throw state.failure
    if (state.page.isClosed()) throw new BrowserSessionError('PAGE_CLOSED', `Browser page is closed: ${state.id}`)
  }

  #configurePage(page, timeout) {
    page.setDefaultTimeout(timeout)
    page.setDefaultNavigationTimeout(timeout)
  }

  #assertUrl(url) {
    return assertBrowserUrlAllowed(url, {
      allowPrivateNetwork: this.allowPrivateNetwork,
      hostnameResolver: this.hostnameResolver,
    })
  }

  async #installRequestGuard(browserContext) {
    if (typeof browserContext.routeWebSocket === 'function') {
      await browserContext.routeWebSocket('**/*', async webSocket => {
        try {
          const raw = String(webSocket.url())
          const parsed = new URL(raw)
          if (!['ws:', 'wss:'].includes(parsed.protocol) || parsed.username || parsed.password) {
            throw new BrowserSessionError('URL_BLOCKED', 'Unsafe WebSocket URL')
          }
          parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
          await this.#assertUrl(parsed.href)
          webSocket.connectToServer()
        } catch {
          await Promise.resolve(webSocket.close({ code: 1008, reason: 'Blocked by browser network policy' })).catch(() => {})
        }
      })
    }
    if (typeof browserContext.route !== 'function') return
    await browserContext.route('**/*', async route => {
      try {
        await this.#assertUrl(route.request().url())
        await route.continue()
      } catch (err) {
        await route.abort('blockedbyclient').catch(() => {})
      }
    })
  }

  async #operate(session, signal, operation) {
    throwIfAborted(signal)
    session.activeOperations += 1
    session.lastUsed = this.now()
    try {
      return await raceAbort(Promise.resolve().then(operation), signal)
    } catch (err) {
      if (err?.name === 'AbortError') throw err
      throw this.#normalizeError(err, 'OPERATION_FAILED')
    } finally {
      session.activeOperations -= 1
      session.lastUsed = this.now()
    }
  }

  async #screenshot(session, pageState, fullPage) {
    const filename = `${session.id}-${pageState.id}-${Date.now()}.png`
    const relative = path.posix.join('screenshots', filename)
    const absolute = path.join(this.sandboxRoot, ...relative.split('/'))
    await pageState.page.screenshot({ path: absolute, fullPage: Boolean(fullPage), type: 'png' })
    return relative
  }

  async #pageList(session) {
    return Promise.all([...session.pages.values()].map(async state => ({
      page_id: state.id, active: state.id === session.activePageId,
      url: state.page.url(), title: state.page.isClosed() ? '' : await state.page.title().catch(() => ''),
    })))
  }

  #sessionResult(session, pageState) {
    return {
      ok: true, session_id: session.id, page_id: pageState.id,
      url: pageState.page.url(), persistent: session.persistent, visible: session.visible,
    }
  }

  async #closeSession(session) {
    if (session.closing) return
    session.closing = true
    this.sessions.delete(session.id)
    for (const state of session.pages.values()) await clearPageRefs(state)
    try { await session.context.close() } catch {}
    if (session.persistent) try { await session.browser?.close() } catch {}
  }

  #normalizeError(err, fallbackCode) {
    if (err instanceof BrowserSessionError || err?.name === 'AbortError') return err
    const message = err?.message || String(err)
    if (/Target page, context or browser has been closed/i.test(message)) {
      return new BrowserSessionError('TARGET_CLOSED', message, err)
    }
    if (/Timeout/i.test(message)) return new BrowserSessionError('TIMEOUT', message, err)
    return new BrowserSessionError(fallbackCode, message, err)
  }
}

export const BROWSER_ACTIONS = Object.freeze([...ALLOWED_ACTIONS])
