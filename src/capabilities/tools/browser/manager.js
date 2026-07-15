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
import { BrowserProfileStore } from './profile-store.js'
import { clearPageRefs, extractReadablePage, inspectPage } from './snapshot.js'

const ALLOWED_ACTIONS = new Set([
  'click', 'fill', 'press', 'select', 'check', 'uncheck', 'hover',
  'scroll', 'wait', 'back', 'forward', 'reload',
])

const POINTER_CLICK_PROBE_TIMEOUT_MS = 1_500
const POINTER_INTERCEPTION_RE = /intercepts pointer events/i

function supportsKeyboardClickFallback(element = {}) {
  const tag = String(element.tag || '').toLowerCase()
  const role = String(element.role || '').toLowerCase()
  const type = String(element.type || '').toLowerCase()
  return tag === 'button'
    || tag === 'a'
    || role === 'button'
    || role === 'link'
    || (tag === 'input' && ['button', 'submit', 'reset', 'image'].includes(type))
}

async function clickElement(target, refEntry, timeout, signal) {
  const pointerTimeout = Math.min(timeout, POINTER_CLICK_PROBE_TIMEOUT_MS)
  const startedAt = Date.now()
  try {
    // A trial performs Playwright's complete actionability check without
    // dispatching the click. It lets us identify a persistent tooltip quickly
    // while preserving the caller's full timeout budget for every other kind
    // of transient page state.
    await target.click({ timeout: pointerTimeout, trial: true })
  } catch (error) {
    if (POINTER_INTERCEPTION_RE.test(error?.message || '')
        && supportsKeyboardClickFallback(refEntry?.element)) {
      // Playwright cannot abort a running ElementHandle.click. Keep the
      // pointer probe short, then observe the turn signal before attempting a
      // fallback so a user interruption can never become a delayed submit.
      throwIfAborted(signal)
      const remainingTimeout = Math.max(1, timeout - (Date.now() - startedAt))
      await target.press('Enter', { timeout: remainingTimeout })
      return 'keyboard_enter'
    }
  }
  throwIfAborted(signal)
  const remainingTimeout = Math.max(1, timeout - (Date.now() - startedAt))
  await target.click({ timeout: remainingTimeout })
  return 'pointer'
}

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

function operationId() {
  return `bo_${crypto.randomBytes(10).toString('hex')}`
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
async function raceResource(resourcePromise, signal, cleanup, tracker, lifecycle = null) {
  let aborted = Boolean(signal?.aborted)
  let abortReason = signal?.reason || 'Aborted'
  let onAbort
  const tracked = Promise.resolve(resourcePromise).then(async resource => {
    if (!aborted) {
      lifecycle?.resolve?.({ resource, cleaned: false })
      return resource
    }
    try {
      await cleanup(resource)
      lifecycle?.resolve?.({ resource, cleaned: true })
    } catch (error) {
      lifecycle?.resolve?.({ resource, cleaned: false, error })
    }
    throw createAbortError(abortReason)
  }, error => {
    lifecycle?.resolve?.({ resource: null, cleaned: true, error })
    throw error
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

async function closePersistentContext(context) {
  // launchPersistentContext owns a whole browser process. Closing Browser is
  // the reliable flush boundary across Chromium channels on Windows; Edge can
  // leave BrowserContext.close() pending indefinitely for a persistent default
  // context even though the window has already begun shutting down.
  const browser = context?.browser?.()
  if (browser) return browser.close()
  return context?.close()
}

async function withCleanupTimeout(promise, timeoutMs, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new BrowserSessionError('PROFILE_CLOSE_FAILED', message)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function withSessionTimeout(promise, timeoutMs, code, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new BrowserSessionError(code, message)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

export class BrowserSessionManager {
  constructor(options = {}) {
    this.maxSessions = boundedInteger(options.maxSessions, 4, 1, 32)
    this.maxPagesPerSession = boundedInteger(options.maxPagesPerSession, 8, 1, 32)
    // Browser windows are user-visible, durable working state. Keep them open
    // until the user closes them or the application shuts down. Tests and
    // specialized consumers can still opt into expiry with sessionTtlMs.
    this.sessionTtlMs = options.sessionTtlMs == null || options.sessionTtlMs === false || options.sessionTtlMs === 0
      ? null
      : boundedInteger(options.sessionTtlMs, 15 * 60_000, 1_000, 24 * 60 * 60_000)
    this.operationTimeoutMs = boundedInteger(options.operationTimeoutMs, 30_000, 500, 120_000)
    this.operationQueueTimeoutMs = boundedInteger(
      options.operationQueueTimeoutMs,
      this.operationTimeoutMs,
      50,
      120_000,
    )
    this.persistentCloseTimeoutMs = boundedInteger(options.persistentCloseTimeoutMs, 5_000, 500, 30_000)
    this.operationDrainTimeoutMs = boundedInteger(options.operationDrainTimeoutMs, 5_000, 50, 30_000)
    this.sessionCloseTimeoutMs = boundedInteger(options.sessionCloseTimeoutMs, 5_000, 50, 30_000)
    this.maxClosedSessions = boundedInteger(options.maxClosedSessions, 100, 1, 1_000)
    this.sandboxRoot = path.resolve(options.sandboxRoot || paths.sandboxDir)
    this.userDataRoot = path.resolve(options.userDataRoot || paths.userDir)
    this.profileStore = new BrowserProfileStore({
      root: path.join(this.userDataRoot, 'browser-profiles'),
      now: options.now || Date.now,
      pid: options.profileLockPid,
      processAlive: options.profileProcessAlive,
      lockRecoveryMs: options.profileLockRecoveryMs,
      removeTreeAsync: options.profileRemoveTreeAsync,
      renameAsync: options.profileRenameAsync,
    })
    this.chromiumLoader = options.chromiumLoader || loadChromium
    // Private/LAN browsing is disabled by default. The agent adapter binds this
    // to config.network.allowLanAccess; tests/local development must opt in.
    this.allowPrivateNetwork = options.allowPrivateNetwork || false
    this.hostnameResolver = options.hostnameResolver
    this.sessions = new Map()
    this.closedSessions = new Map()
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
    this.sweepTimer = this.sessionTtlMs == null
      ? null
      : setInterval(() => this.sweepExpired().catch(() => {}), Math.min(this.sessionTtlMs, 30_000))
    this.sweepTimer?.unref?.()
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
    let persistentProfile = null
    let profileLock = null
    let persistentLifecycle = null
    let registeredSession = null
    try {
      const visible = optionalBoolean(args, 'visible', true)
      const url = await this.#assertUrl(args.url)
      // Real site sessions persist by default so login state survives a normal
      // close/restart. about:blank has no origin to isolate, so it remains an
      // ephemeral compatibility path unless persistence is explicitly asked
      // for (which is rejected below).
      persistent = optionalBoolean(args, 'persistent', url !== 'about:blank')
      const timeout = this.#timeout(args.timeout_ms)
      if (persistent) {
        if (url === 'about:blank') {
          throw new BrowserSessionError('INVALID_ARGUMENT', 'persistent browser sessions require an initial http(s) URL to isolate login state by site')
        }
        persistentProfile = this.profileStore.identity(profileName(args.profile), url, context)
        profileLock = this.profileStore.acquire(persistentProfile)
      }
      merged = mergeAbortSignals(context.signal, this.shutdownController.signal)
      const signal = merged.signal
      chromium = await raceAbort(this.chromiumLoader(), signal)
      if (persistent) {
        const persistentProfilePath = this.profileStore.prepare(persistentProfile)
        let resolveLifecycle
        persistentLifecycle = {
          promise: new Promise(resolve => { resolveLifecycle = resolve }),
          resolve: resolveLifecycle,
        }
        browserContext = await raceResource(launchPersistentBrowserContext(chromium, persistentProfilePath, {
          ...browserLaunchOptions({ visible }),
          ...browserContextOptions(args),
        }), signal, resource => {
          const closeAttempt = Promise.resolve(closePersistentContext(resource))
          // A bounded cleanup timeout lets shutdown finish, but the underlying
          // graceful close may still complete later. Release at that later
          // point only after disconnection is proven, avoiding a needless
          // until-restart lock without ever overlapping live profile owners.
          closeAttempt.then(() => {
            const lateBrowser = resource?.browser?.()
            if (typeof lateBrowser?.isConnected !== 'function' || !lateBrowser.isConnected()) {
              this.profileStore.release(profileLock)
            }
          }, () => {})
          return withCleanupTimeout(
            closeAttempt,
            this.persistentCloseTimeoutMs,
            'Aborted persistent browser did not exit; its profile remains locked for safety',
          )
        }, this.resourceCreations, persistentLifecycle)
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
      const session = registeredSession = {
        id, browser, context: browserContext, persistent, visible,
        persistentProfile, profileLock, clearProfile: false, closePromise: null,
        pages: new Map(), activePageId: null, lastUsed: this.now(), activeOperations: 0,
        operationPromises: new Set(), operationTasks: new Map(),
        controlQueue: this.#createOperationQueue('session', id),
        failure: null, closing: false, state: 'active',
        closeReason: null, closeStartedAt: null, contextClosed: false,
        operationDrainTimedOut: false, preserveEmptyPages: 0,
      }
      this.sessions.set(id, session)
      browserContext.on?.('close', () => {
        session.contextClosed = true
        if (!session.closing) this.#closeSession(session, { reason: 'CONTEXT_CLOSED' }).catch(() => {})
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
        await this.#schedulePageOperation(session, active, {
          type: 'open:navigate', signal, queueTimeoutMs: this.#queueTimeout(args.timeout_ms),
          exposeMetadata: false,
        }, async () => {
          const epoch = active.documentEpoch
          await active.page.goto(url, { waitUntil: 'domcontentloaded', timeout })
          this.#ensureDocumentEpochAdvanced(active, epoch)
        })
      }
      return this.#sessionResult(session, active)
    } catch (err) {
      if (registeredSession) {
        // Once event handlers can observe the session, use the single session
        // close path. It marks closing before touching Playwright, preventing a
        // persistent context close event from racing a second close/release.
        try { await this.#closeSession(registeredSession, { reason: 'OPEN_FAILED_CLEANUP' }) } catch {}
        throw this.#normalizeError(err, 'OPEN_FAILED')
      }
      let releaseProfileLock = true
      let failedCloseAttempt = null
      try {
        if (persistent && browserContext) {
          const closeAttempt = Promise.resolve(closePersistentContext(browserContext))
          failedCloseAttempt = closeAttempt
          await withCleanupTimeout(
            closeAttempt,
            this.persistentCloseTimeoutMs,
            'Persistent browser did not exit; its profile remains locked for safety',
          )
        } else await browserContext?.close()
      } catch {}
      const stillConnected = persistent && typeof browser?.isConnected === 'function' && browser.isConnected()
      if (stillConnected) {
        releaseProfileLock = false
        failedCloseAttempt?.then(() => {
          if (typeof browser?.isConnected !== 'function' || !browser.isConnected()) {
            this.profileStore.release(profileLock)
          }
        }, () => {})
      }
      if (persistent && !browserContext && persistentLifecycle) {
        releaseProfileLock = false
        persistentLifecycle.promise.then(({ resource, cleaned }) => {
          const lateBrowser = resource?.browser?.()
          const disconnected = typeof lateBrowser?.isConnected !== 'function' || !lateBrowser.isConnected()
          if (cleaned && disconnected) this.profileStore.release(profileLock)
        }).catch(() => {})
      }
      if (releaseProfileLock) this.profileStore.release(profileLock)
      throw this.#normalizeError(err, 'OPEN_FAILED')
    } finally {
      this.pendingOpens -= 1
      this.pendingOpenTasks.delete(pendingOpenTask)
      finishPendingOpen()
      merged.cleanup()
    }
  }

  async navigate(args = {}, context = {}) {
    const session = this.#getSession(args)
    const pageState = this.#getPage(session, args.page_id)
    const url = await this.#assertUrl(args.url)
    if (url === 'about:blank') {
      throw new BrowserSessionError('INVALID_ARGUMENT', 'browser_navigate requires an http(s) URL')
    }
    const timeout = this.#timeout(args.timeout_ms)
    return this.#schedulePageOperation(session, pageState, {
      type: 'navigate', signal: context.signal, queueTimeoutMs: this.#queueTimeout(args.timeout_ms),
    }, async () => {
      this.#assertPageHealthy(pageState)
      this.#configurePage(pageState.page, timeout)
      const epoch = pageState.documentEpoch
      await pageState.page.goto(url, { waitUntil: 'domcontentloaded', timeout })
      this.#ensureDocumentEpochAdvanced(pageState, epoch)
      return {
        ok: true,
        session_id: session.id,
        page_id: pageState.id,
        url: pageState.page.url(),
        title: await pageState.page.title(),
      }
    })
  }

  async readOnce(args = {}, context = {}) {
    let opened = null
    try {
      opened = await this.open({
        url: args.url,
        visible: false,
        persistent: false,
        timeout_ms: args.timeout_ms,
      }, context)
      const session = this.#getSession({ session_id: opened.session_id })
      const pageState = this.#getPage(session, opened.page_id)
      const timeout = this.#timeout(args.timeout_ms)
      const extractMaxChars = boundedInteger(args.extract_max_chars, 250_000, 1_000, 1_000_000)
      return await this.#schedulePageOperation(session, pageState, {
        type: 'read_once', signal: context.signal, queueTimeoutMs: this.#queueTimeout(args.timeout_ms),
      }, async () => {
        const page = pageState.page
        this.#assertPageHealthy(pageState)
        this.#configurePage(page, timeout)
        await page.waitForLoadState('networkidle', { timeout: Math.min(timeout, 8_000) }).catch(() => {})
        for (let i = 0; i < 4; i++) {
          throwIfAborted(context.signal)
          await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight, 800)))
          await page.waitForTimeout(350)
        }
        await page.evaluate(() => window.scrollTo(0, 0))
        const snapshot = await extractReadablePage(page, { maxChars: extractMaxChars })
        return {
          ok: true,
          url: args.url,
          final_url: page.url(),
          title: snapshot.title,
          text: snapshot.text,
          text_length: snapshot.textLength,
          truncated: snapshot.textLength > extractMaxChars,
        }
      })
    } finally {
      if (opened?.session_id) {
        const session = this.sessions.get(opened.session_id)
        if (session) await this.#closeSession(session, { reason: 'ONE_SHOT_COMPLETE' }).catch(() => {})
      }
    }
  }

  async inspect(args = {}, context = {}) {
    const session = this.#getSession(args)
    const pageState = this.#getPage(session, args.page_id)
    const maxChars = boundedInteger(args.max_chars, 8_000, 500, 20_000)
    const maxElements = boundedInteger(args.max_elements, 80, 1, 200)
    const timeout = this.#timeout(args.timeout_ms)
    const result = await this.#schedulePageOperation(session, pageState, {
      type: 'inspect', signal: context.signal, queueTimeoutMs: this.#queueTimeout(args.timeout_ms),
    }, async () => {
      this.#assertPageHealthy(pageState)
      this.#configurePage(pageState.page, timeout)
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
    return this.#schedulePageOperation(session, pageState, {
      type: `act:${action}`, signal: context.signal, queueTimeoutMs: this.#queueTimeout(args.timeout_ms),
    }, async () => {
      this.#assertPageHealthy(pageState)
      const page = pageState.page
      this.#configurePage(page, timeout)
      const epoch = pageState.documentEpoch
      let refEntry = null
      if (['click', 'fill', 'press', 'select', 'check', 'uncheck', 'hover'].includes(action)) {
        const ref = String(args.ref || '')
        refEntry = pageState.refs.get(ref)
        if (!refEntry || refEntry.epoch !== pageState.documentEpoch) {
          throw new BrowserSessionError('STALE_REF', `Unknown or stale element ref: ${ref || '(missing)'}`)
        }
      }
      const target = refEntry?.handle
      let clickMethod = null
      if (action === 'click') clickMethod = await clickElement(target, refEntry, timeout, context.signal)
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
      } else if (action === 'back') {
        await page.goBack({ waitUntil: 'domcontentloaded', timeout })
        this.#ensureDocumentEpochAdvanced(pageState, epoch)
      } else if (action === 'forward') {
        await page.goForward({ waitUntil: 'domcontentloaded', timeout })
        this.#ensureDocumentEpochAdvanced(pageState, epoch)
      } else if (action === 'reload') {
        await page.reload({ waitUntil: 'domcontentloaded', timeout })
        this.#ensureDocumentEpochAdvanced(pageState, epoch)
      }
      return {
        ok: true, session_id: session.id, page_id: pageState.id,
        action, ...(clickMethod ? { click_method: clickMethod } : {}),
        url: page.url(), title: await page.title(),
      }
    })
  }

  async tabs(args = {}, context = {}) {
    const session = this.#getSession(args)
    const action = String(args.action || 'list').toLowerCase()
    if (!['new', 'switch', 'close', 'list'].includes(action)) {
      throw new BrowserSessionError('INVALID_ARGUMENT', `Unsupported tabs action: ${action}`)
    }
    const rawUrl = action === 'new' ? normalizeBrowserUrl(args.url, { optional: true }) : null
    const url = rawUrl ? await this.#assertUrl(rawUrl) : null
    return this.#scheduleControlOperation(session, {
      type: `tabs:${action}`, signal: context.signal, queueTimeoutMs: this.#queueTimeout(args.timeout_ms),
    }, async () => {
      if (action === 'new') {
        if (session.pages.size >= this.maxPagesPerSession) {
          throw new BrowserSessionError('PAGE_LIMIT', `Maximum pages reached (${this.maxPagesPerSession})`)
        }
        const page = await session.context.newPage()
        const state = this.#pageByObject(session, page) || this.#registerPage(session, page)
        if (!state) throw new BrowserSessionError('PAGE_LIMIT', `Maximum pages reached (${this.maxPagesPerSession})`)
        session.activePageId = state.id
        if (url) {
          const timeout = this.#timeout(args.timeout_ms)
          await this.#schedulePageOperation(session, state, {
            type: 'tabs:new:navigate', queueTimeoutMs: this.#queueTimeout(args.timeout_ms),
            allowClosing: true, exposeMetadata: false,
          }, async () => {
            this.#configurePage(page, timeout)
            const epoch = state.documentEpoch
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout })
            this.#ensureDocumentEpochAdvanced(state, epoch)
          })
        }
      } else if (action === 'switch') {
        const state = this.#getPage(session, args.page_id)
        session.activePageId = state.id
        await this.#schedulePageOperation(session, state, {
          type: 'tabs:switch:bring_to_front', queueTimeoutMs: this.#queueTimeout(args.timeout_ms),
          allowClosing: true, exposeMetadata: false,
        }, () => state.page.bringToFront())
      } else if (action === 'close') {
        const state = this.#getPage(session, args.page_id)
        state.acceptingOperations = false
        await this.#waitForQueueIdle(state.operationQueue)
        session.preserveEmptyPages += 1
        try {
          await state.page.close()
          if (!session.pages.size) this.#registerPage(session, await session.context.newPage())
        } catch (error) {
          if (!state.page.isClosed() && session.pages.get(state.id) === state) state.acceptingOperations = true
          throw error
        } finally {
          session.preserveEmptyPages -= 1
          if (!session.pages.size) this.#closeSession(session, { reason: 'LAST_PAGE_CLOSED' }).catch(() => {})
        }
      }
      return { ok: true, session_id: session.id, active_page_id: session.activePageId, pages: await this.#pageList(session) }
    })
  }

  async close(args = {}, context = {}) {
    const id = String(args.session_id || args.sessionId || '')
    const clearProfile = optionalBoolean(args, 'clear_profile')
    if (id) {
      const session = this.sessions.get(id)
      if (!session) {
        const closed = this.closedSessions.get(id)
        return {
          ok: true, session_id: id, closed: false, profile_cleared: false,
          ...(closed ? { close_reason: closed.reason, closed_at: closed.closedAt } : {}),
        }
      }
      if (clearProfile && !session.persistent) {
        throw new BrowserSessionError('INVALID_ARGUMENT', 'Only a persistent browser session has a profile to clear')
      }
      throwIfAborted(context.signal)
      await raceAbort(this.#closeSession(session, { clearProfile, reason: 'USER_CLOSE' }), context.signal)
      const closed = this.closedSessions.get(id)
      return {
        ok: true, session_id: id, closed: true, profile_cleared: clearProfile,
        close_reason: closed?.reason || 'USER_CLOSE',
      }
    }
    if (!clearProfile) {
      throw new BrowserSessionError('INVALID_ARGUMENT', 'browser_close requires session_id, or clear_profile=true with profile and url')
    }
    const url = await this.#assertUrl(args.url)
    if (url === 'about:blank') {
      throw new BrowserSessionError('INVALID_ARGUMENT', 'Clearing a persistent profile requires its http(s) site URL')
    }
    const identity = this.profileStore.identity(profileName(args.profile), url, context)
    let lock
    try {
      lock = this.profileStore.acquire(identity)
      const cleared = await this.profileStore.clear(identity)
      return { ok: true, session_id: '', closed: false, profile_id: identity.id, profile_cleared: cleared }
    } catch (err) {
      throw this.#normalizeError(err, 'PROFILE_CLEAR_FAILED')
    } finally {
      this.profileStore.release(lock)
    }
  }

  listSessions(args = {}, context = {}) {
    this.#assertOpen()
    const includeProfiles = optionalBoolean(args, 'include_profiles')
    const sessions = []
    const degradedSessions = []
    for (const session of [...this.sessions.values()]) {
      for (const state of [...session.pages.values()]) {
        if (state.page.isClosed()) session.pages.delete(state.id)
      }
      if (session.state === 'degraded') {
        degradedSessions.push({
          session_id: session.id,
          state: 'degraded',
          close_reason: session.closeReason || 'UNKNOWN',
          failure_code: session.failure?.code || 'SESSION_CLOSE_FAILED',
          visible: session.visible === true,
          persistent: session.persistent === true,
        })
        continue
      }
      const browserDisconnected = typeof session.browser?.isConnected === 'function' && !session.browser.isConnected()
      if (session.closing || session.failure || browserDisconnected || (!session.pages.size && !session.preserveEmptyPages)) {
        const reason = session.closeReason || (browserDisconnected
          ? 'BROWSER_DISCONNECTED'
          : (!session.pages.size ? 'LAST_PAGE_CLOSED' : 'SESSION_FAILURE'))
        this.#closeSession(session, { reason }).catch(() => {})
        continue
      }
      if (!session.pages.has(session.activePageId)) {
        session.activePageId = session.pages.keys().next().value || null
      }
      sessions.push({
        session_id: session.id,
        visible: session.visible,
        persistent: session.persistent,
        ...(session.persistentProfile ? {
          profile_id: session.persistentProfile.id,
          profile: session.persistentProfile.name,
          site: session.persistentProfile.origin,
        } : {}),
        active_page_id: session.activePageId,
        pages: [...session.pages.values()].map(state => ({
          page_id: state.id,
          active: state.id === session.activePageId,
          url: sanitizeBrowserRuntimeUrl(state.page.url()),
        })),
      })
    }
    return {
      ok: true,
      count: sessions.length,
      sessions,
      degraded_sessions: degradedSessions.slice(0, this.maxSessions),
      ...(includeProfiles ? { profiles: this.profileStore.list(context) } : {}),
    }
  }

  async sweepExpired() {
    if (this.sessionTtlMs == null) return 0
    const now = this.now()
    const expired = [...this.sessions.values()].filter(session => !session.activeOperations && now - session.lastUsed >= this.sessionTtlMs)
    await Promise.allSettled(expired.map(session => this.#closeSession(session, { reason: 'TTL_EXPIRED' })))
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
      await Promise.allSettled([...this.sessions.values()].map(session => this.#closeSession(session, { reason: 'SHUTDOWN' })))
      await Promise.allSettled([...this.sharedBrowsers.values()].map(browser => browser.close()))
      // Closing a shared browser is itself a definitive cleanup boundary for
      // non-persistent contexts whose earlier context.close() attempt failed.
      await Promise.allSettled([...this.sessions.values()].map(session => this.#closeSession(session, { reason: 'SHUTDOWN' })))
      this.sharedBrowsers.clear()
      this.sharedBrowserLaunches.clear()
    })()
    return this.shutdownPromise
  }

  #assertOpen() {
    if (this.closed) throw new BrowserSessionError('MANAGER_CLOSED', 'Browser session manager is closed')
  }

  #timeout(value) { return boundedInteger(value, this.operationTimeoutMs, 500, 120_000) }

  #queueTimeout(value) {
    return value === undefined
      ? this.operationQueueTimeoutMs
      : boundedInteger(value, this.operationQueueTimeoutMs, 50, 120_000)
  }

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
              this.#closeSession(session, { reason: 'BROWSER_DISCONNECTED' }).catch(() => {})
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
      documentEpoch: 0, retiredRefs: new Set(), failure: null, acceptingOperations: true,
    }
    state.operationQueue = this.#createOperationQueue('page', state.id)
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
        this.#retirePageRefs(state)
        if (!state.operationQueue.active) {
          queueMicrotask(() => {
            if (!state.operationQueue.active) this.#disposeRetiredPageRefs(state).catch(() => {})
          })
        }
      }
    })
    page.on('crash', () => { state.failure = new BrowserSessionError('PAGE_CRASHED', 'Browser page crashed') })
    page.on('download', download => { download.cancel().catch(() => {}) })
    page.on('close', () => {
      state.acceptingOperations = false
      this.#cancelPendingQueueOperations(
        state.operationQueue,
        new BrowserSessionError('PAGE_CLOSED', `Browser page is closed: ${state.id}`),
      )
      clearPageRefs(state).catch(() => {})
      session.pages.delete(state.id)
      if (session.activePageId === state.id) session.activePageId = session.pages.keys().next().value || null
      if (!session.pages.size && !session.preserveEmptyPages && !session.closing) {
        this.#closeSession(session, { reason: 'LAST_PAGE_CLOSED' }).catch(() => {})
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
    if (!session) {
      const closed = this.closedSessions.get(id)
      if (closed) {
        const error = new BrowserSessionError(
          'SESSION_CLOSED',
          `Browser session closed (${closed.reason}): ${id}`,
        )
        error.closeReason = closed.reason
        error.closedAt = closed.closedAt
        throw error
      }
      throw new BrowserSessionError('SESSION_NOT_FOUND', `Browser session not found: ${id || '(missing)'}`)
    }
    if (session.state === 'degraded' && session.failure) throw session.failure
    if (session.closing) {
      const error = new BrowserSessionError(
        'SESSION_CLOSING',
        `Browser session is closing (${session.closeReason || 'UNKNOWN'}): ${id}`,
      )
      error.closeReason = session.closeReason
      throw error
    }
    if (session.failure) throw session.failure
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

  #createOperationQueue(kind, ownerId) {
    return { kind, ownerId, pending: [], active: null, idleWaiters: new Set() }
  }

  #scheduleControlOperation(session, options, operation) {
    return this.#enqueueOperation(session, session.controlQueue, options, operation)
  }

  #schedulePageOperation(session, pageState, options, operation) {
    if (!options?.allowClosing && session.closing) {
      throw new BrowserSessionError('SESSION_CLOSING', `Browser session is closing: ${session.id}`)
    }
    if (!pageState.acceptingOperations || pageState.page.isClosed()) {
      throw new BrowserSessionError('PAGE_CLOSED', `Browser page is closed: ${pageState.id}`)
    }
    return this.#enqueueOperation(session, pageState.operationQueue, options, async () => {
      try {
        this.#assertPageHealthy(pageState)
        return await operation()
      } finally {
        await this.#disposeRetiredPageRefs(pageState)
      }
    })
  }

  #enqueueOperation(session, queue, options = {}, operation) {
    const signal = options.signal
    throwIfAborted(signal)
    if (!options.allowClosing && session.closing) {
      throw new BrowserSessionError('SESSION_CLOSING', `Browser session is closing: ${session.id}`)
    }

    let resolveCaller
    let rejectCaller
    let resolveCompletion
    let rejectCompletion
    const task = {
      id: operationId(),
      type: String(options.type || 'operation'),
      enqueuedAt: this.now(),
      startedAt: null,
      status: 'queued',
      session,
      queue,
      signal,
      operation,
      exposeMetadata: options.exposeMetadata !== false,
      callerSettled: false,
      callerPromise: new Promise((resolve, reject) => { resolveCaller = resolve; rejectCaller = reject }),
      completion: new Promise((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject }),
      resolveCaller,
      rejectCaller,
      resolveCompletion,
      rejectCompletion,
      abortListener: null,
      queueTimer: null,
    }
    // completion is an internal lifecycle promise. Observe rejection eagerly;
    // callers receive the separate callerPromise while close/shutdown use allSettled.
    task.completion.catch(() => {})
    session.operationPromises ||= new Set()
    session.operationTasks ||= new Map()
    session.operationPromises.add(task.completion)
    session.operationTasks.set(task.id, task)
    session.activeOperations = Math.max(0, session.activeOperations || 0) + 1
    session.lastUsed = this.now()

    if (signal) {
      task.abortListener = () => {
        const error = this.#decorateOperationError(createAbortError(signal.reason || 'Aborted'), task)
        if (task.status === 'queued') this.#cancelQueuedOperation(task, error)
        else if (task.status === 'running') this.#rejectOperationCaller(task, error)
      }
      signal.addEventListener('abort', task.abortListener, { once: true })
    }
    const queueTimeoutMs = boundedInteger(
      options.queueTimeoutMs,
      this.operationQueueTimeoutMs,
      50,
      120_000,
    )
    task.queueTimer = setTimeout(() => {
      if (task.status !== 'queued') return
      this.#cancelQueuedOperation(task, new BrowserSessionError(
        'OPERATION_QUEUE_TIMEOUT',
        `Browser operation ${task.id} (${task.type}) timed out after ${queueTimeoutMs}ms waiting to start`,
      ))
    }, queueTimeoutMs)

    queue.pending.push(task)
    this.#pumpOperationQueue(queue)
    return task.callerPromise
  }

  #pumpOperationQueue(queue) {
    if (queue.active) return
    let task = queue.pending.shift()
    while (task && task.status !== 'queued') task = queue.pending.shift()
    if (!task) {
      this.#notifyQueueIdle(queue)
      return
    }
    queue.active = task
    task.status = 'running'
    task.startedAt = this.now()
    clearTimeout(task.queueTimer)
    task.queueTimer = null
    Promise.resolve().then(task.operation).then(
      value => this.#finishRunningOperation(task, null, value),
      error => this.#finishRunningOperation(task, this.#normalizeError(error, 'OPERATION_FAILED')),
    )
  }

  #finishRunningOperation(task, error, value) {
    if (task.status !== 'running') return
    task.status = 'settled'
    const result = !error && task.exposeMetadata && value && typeof value === 'object' && !Array.isArray(value)
      ? {
          ...value,
          operation_id: task.id,
          operation_type: task.type,
          operation_enqueued_at: task.enqueuedAt,
          operation_started_at: task.startedAt,
        }
      : value
    if (error) {
      const decorated = this.#decorateOperationError(error, task)
      this.#rejectOperationCaller(task, decorated)
      task.rejectCompletion(decorated)
    } else {
      this.#resolveOperationCaller(task, result)
      task.resolveCompletion(result)
    }
    this.#untrackOperation(task)
    if (task.queue.active === task) task.queue.active = null
    this.#pumpOperationQueue(task.queue)
  }

  #cancelQueuedOperation(task, error) {
    if (task.status !== 'queued') return
    task.status = 'cancelled'
    const pendingIndex = task.queue.pending.indexOf(task)
    if (pendingIndex >= 0) task.queue.pending.splice(pendingIndex, 1)
    const decorated = this.#decorateOperationError(error, task)
    this.#rejectOperationCaller(task, decorated)
    task.rejectCompletion(decorated)
    this.#untrackOperation(task)
    this.#pumpOperationQueue(task.queue)
  }

  #resolveOperationCaller(task, value) {
    if (task.callerSettled) return
    task.callerSettled = true
    task.resolveCaller(value)
  }

  #rejectOperationCaller(task, error) {
    if (task.callerSettled) return
    task.callerSettled = true
    task.rejectCaller(error)
  }

  #untrackOperation(task) {
    clearTimeout(task.queueTimer)
    task.queueTimer = null
    if (task.signal && task.abortListener) task.signal.removeEventListener('abort', task.abortListener)
    task.abortListener = null
    task.session.operationPromises?.delete(task.completion)
    task.session.operationTasks?.delete(task.id)
    task.session.activeOperations = Math.max(0, (task.session.activeOperations || 0) - 1)
    task.session.lastUsed = this.now()
  }

  #decorateOperationError(error, task) {
    if (!error || (typeof error !== 'object' && typeof error !== 'function')) return error
    error.operationId ||= task.id
    error.operationType ||= task.type
    error.enqueuedAt ??= task.enqueuedAt
    error.startedAt ??= task.startedAt
    return error
  }

  #waitForQueueIdle(queue) {
    this.#pumpOperationQueue(queue)
    if (!queue.active && !queue.pending.some(task => task.status === 'queued')) return Promise.resolve()
    return new Promise(resolve => queue.idleWaiters.add(resolve))
  }

  #notifyQueueIdle(queue) {
    if (queue.active || queue.pending.some(task => task.status === 'queued')) return
    for (const resolve of queue.idleWaiters) resolve()
    queue.idleWaiters.clear()
  }

  #cancelPendingQueueOperations(queue, error) {
    for (const task of [...queue.pending]) {
      if (task.status !== 'queued') continue
      const taskError = error instanceof BrowserSessionError
        ? new BrowserSessionError(error.code, error.message, error)
        : error
      this.#cancelQueuedOperation(task, taskError)
    }
    this.#pumpOperationQueue(queue)
  }

  async #drainSessionOperations(session) {
    while (session.operationTasks?.size) {
      await Promise.allSettled([...session.operationTasks.values()].map(task => task.completion))
    }
  }

  #cancelPendingSessionOperations(session, error) {
    if (session.controlQueue) this.#cancelPendingQueueOperations(session.controlQueue, error)
    for (const pageState of session.pages.values()) {
      pageState.acceptingOperations = false
      if (pageState.operationQueue) this.#cancelPendingQueueOperations(pageState.operationQueue, error)
    }
    for (const task of session.operationTasks?.values() || []) {
      if (task.status !== 'running') continue
      const taskError = error instanceof BrowserSessionError
        ? new BrowserSessionError(error.code, error.message, error)
        : error
      this.#rejectOperationCaller(task, this.#decorateOperationError(taskError, task))
    }
  }

  #retirePageRefs(pageState) {
    pageState.retiredRefs ||= new Set()
    for (const entry of pageState.refs.values()) {
      if (entry?.handle) pageState.retiredRefs.add(entry.handle)
    }
    pageState.refs = new Map()
  }

  #ensureDocumentEpochAdvanced(pageState, previousEpoch) {
    if (pageState.documentEpoch !== previousEpoch) return
    pageState.documentEpoch += 1
    this.#retirePageRefs(pageState)
  }

  async #disposeRetiredPageRefs(pageState) {
    const handles = [...(pageState.retiredRefs || [])]
    if (!handles.length) return
    for (const handle of handles) pageState.retiredRefs.delete(handle)
    await Promise.allSettled(handles.map(handle => handle.dispose()))
  }

  async #screenshot(session, pageState, fullPage) {
    const filename = `${session.id}-${pageState.id}-${Date.now()}.png`
    const relative = path.posix.join('screenshots', filename)
    const absolute = path.join(this.sandboxRoot, ...relative.split('/'))
    await pageState.page.screenshot({ path: absolute, fullPage: Boolean(fullPage), type: 'png' })
    return relative
  }

  async #pageList(session) {
    return Promise.all([...session.pages.values()].map(async state => {
      let title = ''
      if (!state.page.isClosed() && state.acceptingOperations) {
        title = await this.#schedulePageOperation(session, state, {
          type: 'tabs:list:title', allowClosing: true, exposeMetadata: false,
          queueTimeoutMs: this.operationQueueTimeoutMs,
        }, () => state.page.title()).catch(() => '')
      }
      return {
        page_id: state.id, active: state.id === session.activePageId,
        url: state.page.url(), title,
      }
    }))
  }

  #sessionResult(session, pageState) {
    return {
      ok: true, session_id: session.id, page_id: pageState.id,
      url: pageState.page.url(), persistent: session.persistent, visible: session.visible,
      ...(session.persistentProfile ? {
        profile_id: session.persistentProfile.id,
        profile: session.persistentProfile.name,
        site: session.persistentProfile.origin,
      } : {}),
    }
  }

  async #closeSession(session, { clearProfile = false, reason = 'UNKNOWN' } = {}) {
    if (clearProfile) session.clearProfile = true
    if (session.closePromise) return session.closePromise
    session.closing = true
    session.state = 'closing'
    session.closeReason ||= reason
    session.closeStartedAt ||= this.now()
    session.closePromise = (async () => {
      if (session.operationTasks?.size) {
        try {
          await withSessionTimeout(
            this.#drainSessionOperations(session),
            this.operationDrainTimeoutMs,
            'OPERATION_DRAIN_TIMEOUT',
            `Timed out waiting for ${session.operationTasks.size} browser operation(s) before closing`,
          )
        } catch (err) {
          if (err?.code !== 'OPERATION_DRAIN_TIMEOUT') throw err
          session.operationDrainTimedOut = true
          this.#cancelPendingSessionOperations(session, new BrowserSessionError(
            'SESSION_CLOSING',
            `Browser session close stopped queued operations after the drain timeout: ${session.id}`,
          ))
        }
      }
      for (const state of session.pages.values()) state.acceptingOperations = false
      await Promise.allSettled([...session.pages.values()].map(state => clearPageRefs(state)))
      if (session.persistent) {
        const closeAttempt = Promise.resolve(closePersistentContext(session.context))
        try {
          await withCleanupTimeout(
            closeAttempt,
            this.persistentCloseTimeoutMs,
            'Persistent browser did not exit; its profile remains locked for safety',
          )
          if (typeof session.browser?.isConnected === 'function' && session.browser.isConnected()) {
            throw new BrowserSessionError(
              'PROFILE_CLOSE_FAILED',
              'Persistent browser still reports connected; its profile remains locked for safety',
            )
          }
        } catch (err) {
          const failure = err instanceof BrowserSessionError
            ? err
            : new BrowserSessionError('PROFILE_CLOSE_FAILED', 'Persistent browser close failed; its profile remains locked for safety', err)
          session.failure = failure
          const disconnected = typeof session.browser?.isConnected !== 'function' || !session.browser.isConnected()
          if (disconnected) this.profileStore.release(session.profileLock)
          // If a timed-out graceful close eventually succeeds, release only
          // after the owning browser is proven disconnected. A rejected/still
          // connected owner deliberately leaves crash-recoverable lock debris.
          if (!disconnected) {
            closeAttempt.then(() => {
              if (typeof session.browser?.isConnected !== 'function' || !session.browser.isConnected()) {
                this.profileStore.release(session.profileLock)
              }
            }, () => {})
          }
          throw failure
        }
      } else {
        if (!session.contextClosed) {
          try {
            await withSessionTimeout(
              Promise.resolve().then(() => session.context.close()),
              this.sessionCloseTimeoutMs,
              'SESSION_CLOSE_FAILED',
              'Browser context close timed out',
            )
            session.contextClosed = true
          } catch (err) {
            const browserDisconnected = typeof session.browser?.isConnected === 'function' && !session.browser.isConnected()
            if (!session.contextClosed && !browserDisconnected) {
              throw err instanceof BrowserSessionError
                ? err
                : new BrowserSessionError('SESSION_CLOSE_FAILED', 'Browser context close failed', err)
            }
          }
        }
      }
      try {
        if (session.clearProfile && session.persistentProfile) await this.profileStore.clear(session.persistentProfile)
      } finally {
        this.profileStore.release(session.profileLock)
      }
      session.state = 'closed'
      session.closedAt = this.now()
      if (this.sessions.get(session.id) === session) this.sessions.delete(session.id)
      this.closedSessions.delete(session.id)
      this.closedSessions.set(session.id, {
        reason: session.closeReason,
        closedAt: session.closedAt,
        operationDrainTimedOut: session.operationDrainTimedOut,
        failureCode: session.failure?.code || null,
      })
      while (this.closedSessions.size > this.maxClosedSessions) {
        this.closedSessions.delete(this.closedSessions.keys().next().value)
      }
    })().catch(err => {
      const failure = err instanceof BrowserSessionError
        ? err
        : new BrowserSessionError('SESSION_CLOSE_FAILED', 'Browser session close failed', err)
      session.failure = failure
      session.state = 'degraded'
      session.closePromise = null
      throw failure
    })
    return session.closePromise
  }

  #normalizeError(err, fallbackCode) {
    if (err instanceof BrowserSessionError || err?.name === 'AbortError') return err
    const message = err?.message || String(err)
    if (['PROFILE_IN_USE', 'PROFILE_LOCK_FAILED'].includes(err?.code)) {
      return new BrowserSessionError(err.code, message, err)
    }
    if (/Target page, context or browser has been closed/i.test(message)) {
      return new BrowserSessionError('TARGET_CLOSED', message, err)
    }
    if (err?.code === 'DOCUMENT_CHANGED') return new BrowserSessionError('DOCUMENT_CHANGED', message, err)
    if (/Timeout/i.test(message)) return new BrowserSessionError('TIMEOUT', message, err)
    return new BrowserSessionError(fallbackCode, message, err)
  }
}

export const BROWSER_ACTIONS = Object.freeze([...ALLOWED_ACTIONS])
