'use strict'

const BROWSER_EMBED_PARTITION = 'persist:bailongma-browser'
const TRUSTED_GOOGLE_OAUTH_HOSTS = new Set(['accounts.google.com'])
const configuredSessions = new WeakMap()
const WINDOWS_CARD_SCROLLBAR_CSS = `
  ::-webkit-scrollbar {
    display: none !important;
    width: 0 !important;
    height: 0 !important;
  }
`

function isAllowedWebUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function normalizeWebUrl(value) {
  if (!isAllowedWebUrl(value)) {
    throw new TypeError('browser embed URL must use http:// or https://')
  }
  return new URL(value).href
}

// Google Sign-In opens a real popup and uses window.opener/postMessage to
// return its result to the X page. Replacing that popup with the current page
// breaks the OAuth hand-off and leaves both navigations aborted. Keep this
// exception deliberately narrow: every other target=_blank stays single-page.
function isTrustedGoogleOauthPopupUrl(value) {
  try {
    const url = new URL(String(value || ''))
    return url.protocol === 'https:' && TRUSTED_GOOGLE_OAUTH_HOSTS.has(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

function finiteNonNegative(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite non-negative number`)
  }
  return value
}

function normalizeBounds(value, contentBounds) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('browser embed bounds are required')
  }

  const x = finiteNonNegative(value.x, 'bounds.x')
  const y = finiteNonNegative(value.y, 'bounds.y')
  const width = finiteNonNegative(value.width, 'bounds.width')
  const height = finiteNonNegative(value.height, 'bounds.height')
  const contentWidth = finiteNonNegative(contentBounds?.width, 'window width')
  const contentHeight = finiteNonNegative(contentBounds?.height, 'window height')
  const roundingTolerance = 2
  const horizontalTransitionAllowance = Math.min(
    contentWidth,
    Math.max(128, width),
  )

  // Horizontal card transitions intentionally begin beyond the right edge by
  // one card width plus a small CSS gap. Electron clips child Views to the
  // BaseWindow, so allow that bounded overflow while still rejecting oversized
  // or unbounded IPC geometry. This lets the live WebContentsView move with its
  // DOM bezel instead of failing the first off-screen animation frame.
  if (
    x > contentWidth + horizontalTransitionAllowance + roundingTolerance
    || y > contentHeight + roundingTolerance
    || width > contentWidth + roundingTolerance
    || height > contentHeight + roundingTolerance
  ) {
    throw new RangeError('browser embed bounds exceed the main window transition budget')
  }

  // DOM rectangles can contain sub-pixel values while native Views use device-
  // independent integer pixels. Expand to the surrounding pixel so no web content
  // leaks beyond the renderer-provided rectangle because of independent rounding.
  const left = Math.floor(x)
  const top = Math.floor(y)
  const right = Math.ceil(x + width)
  const bottom = Math.ceil(y + height)
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  }
}

function requestPolicyUrl(value) {
  const parsed = new URL(String(value || ''))
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:'
  else if (parsed.protocol === 'wss:') parsed.protocol = 'https:'
  return parsed.href
}

function configureIsolatedSession(targetSession, {
  assertRequestAllowed,
  installNativeRequestGuard = false,
  logger = console,
} = {}) {
  if (!targetSession) return false
  if (configuredSessions.has(targetSession)) {
    return configuredSessions.get(targetSession).nativeRequestGuard
  }

  targetSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  targetSession.setPermissionCheckHandler(() => false)
  targetSession.on('will-download', (event, item) => {
    event.preventDefault()
    try { item?.cancel() } catch {}
  })

  let nativeRequestGuard = false
  if (
    installNativeRequestGuard
    && typeof assertRequestAllowed === 'function'
    && typeof targetSession.webRequest?.onBeforeRequest === 'function'
  ) {
    targetSession.webRequest.onBeforeRequest({
      urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'],
    }, (details, callback) => {
      let completed = false
      const finish = decision => {
        if (completed) return
        completed = true
        callback(decision)
      }
      let policyUrl
      try {
        policyUrl = requestPolicyUrl(details?.url)
      } catch (error) {
        logger.warn?.('[browser-embed] blocked malformed network request:', error?.message || error)
        finish({ cancel: true })
        return
      }
      Promise.resolve(assertRequestAllowed(policyUrl)).then(
        () => finish({ cancel: false }),
        error => {
          logger.warn?.('[browser-embed] blocked network request:', error?.message || error)
          finish({ cancel: true })
        },
      )
    })
    nativeRequestGuard = true
  }
  configuredSessions.set(targetSession, { nativeRequestGuard })
  return nativeRequestGuard
}

function navigationUrl(event, legacyUrl) {
  return typeof event?.url === 'string' ? event.url : legacyUrl
}

function blockUnsafeNavigation(event, legacyUrl) {
  const url = navigationUrl(event, legacyUrl)
  // A newly-created WebContentsView starts without a committed renderer. An
  // explicit about:blank navigation is the minimal bootstrap needed before a
  // CDP client can reliably attach. Keep every other non-web scheme blocked.
  const isBootstrap = typeof url === 'string' && url.startsWith('about:blank')
  if (url && !isBootstrap && !isAllowedWebUrl(url)) event.preventDefault()
}

function createBrowserEmbedHost({
  WebContentsView,
  View,
  BrowserWindow,
  BaseWindow,
  getPartition = () => BROWSER_EMBED_PARTITION,
  isAppQuitting = () => false,
  onNavigation = () => {},
  assertNavigationAllowed = async url => normalizeWebUrl(url),
  nativeRequestGuard = false,
  onDiagnosticInput = () => false,
  logger = console,
  platform = process.platform,
  transitionDurationMs = 480,
  waitForTransition = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  if (typeof WebContentsView !== 'function') {
    throw new TypeError('WebContentsView constructor is required')
  }

  let mainOwnerWindow = null
  let currentParentWindow = null
  let externalWindow = null
  let browserView = null
  let browserViewPartition = null
  let browserViewNativeRequestGuard = false
  let inputShield = null
  let rendererReadyPromise = null
  let requestedUrl = null
  let externalRestingContentBounds = null
  let transitionSequence = 0
  let windowOpenSequence = 0
  let pendingWindowOpenNavigation = null
  let scrollbarDocumentRevision = 0
  let cardScrollbarCssKey = null
  let cardScrollbarInsert = null
  const state = {
    available: true,
    attached: false,
    visible: false,
    mode: 'card',
    bounds: null,
    radius: 0,
    url: null,
    interactive: false,
    zoomFactor: 1,
    loading: false,
    error: null,
    transitioning: false,
    transitionTarget: null,
  }

  function snapshot() {
    const contents = browserView?.webContents
    return {
      ...state,
      bounds: state.bounds ? { ...state.bounds } : null,
      webContentsId: contents && !contents.isDestroyed() ? contents.id : null,
      partition: browserViewPartition || String(getPartition() || BROWSER_EMBED_PARTITION),
    }
  }

  function setViewVisibility(visible) {
    browserView?.setVisible(Boolean(visible))
    inputShield?.setVisible(Boolean(visible && !state.interactive))
  }

  function invalidateCardScrollbarStyle() {
    scrollbarDocumentRevision += 1
    // Electron discards inserted CSS with the old document during a main-frame
    // navigation, so its removal key is no longer useful for the new page.
    cardScrollbarCssKey = null
  }

  async function syncCardScrollbarStyle() {
    const contents = browserView?.webContents
    if (!contents || contents.isDestroyed()) return
    if (
      typeof contents.insertCSS !== 'function'
      || typeof contents.removeInsertedCSS !== 'function'
    ) return

    const shouldUseCompactScrollbar = platform === 'win32' && state.mode === 'card'
    if (!shouldUseCompactScrollbar) {
      const key = cardScrollbarCssKey
      cardScrollbarCssKey = null
      if (key) {
        try { await contents.removeInsertedCSS(key) } catch {}
      }
      // An insert that is already in flight checks the current mode when it
      // resolves and removes itself before this promise completes.
      if (cardScrollbarInsert) await cardScrollbarInsert.promise
      return
    }

    const revision = scrollbarDocumentRevision
    if (cardScrollbarCssKey || cardScrollbarInsert?.revision === revision) {
      if (cardScrollbarInsert?.revision === revision) await cardScrollbarInsert.promise
      return
    }

    const pending = {
      revision,
      promise: null,
    }
    pending.promise = contents.insertCSS(WINDOWS_CARD_SCROLLBAR_CSS, {
      cssOrigin: 'user',
    }).then(async key => {
      const stillCurrent = (
        !contents.isDestroyed()
        && browserView?.webContents === contents
        && platform === 'win32'
        && state.mode === 'card'
        && scrollbarDocumentRevision === revision
      )
      if (stillCurrent) {
        cardScrollbarCssKey = key
        return
      }
      try { await contents.removeInsertedCSS(key) } catch {}
    }).catch(error => {
      logger.warn?.('[browser-embed] unable to style compact scrollbar:', error?.message || error)
    }).finally(() => {
      if (cardScrollbarInsert === pending) cardScrollbarInsert = null
    })
    cardScrollbarInsert = pending
    await pending.promise
  }

  function applyExternalBounds() {
    if (
      !externalWindow
      || externalWindow.isDestroyed()
      || currentParentWindow !== externalWindow
    ) return
    const content = externalWindow.getContentBounds()
    const bounds = { x: 0, y: 0, width: content.width, height: content.height }
    state.bounds = bounds
    browserView?.setBounds(bounds)
    browserView?.setBorderRadius(0)
    if (inputShield) {
      inputShield.setBounds(bounds)
      inputShield.setBorderRadius(0)
    }
  }

  function setExternalContentBounds(windowHost, bounds, animate = false) {
    if (typeof windowHost.setContentBounds === 'function') {
      windowHost.setContentBounds(bounds, animate)
      return
    }
    windowHost.setBounds(bounds, animate)
  }

  function cardScreenBounds(targetWindow, bounds) {
    const owner = targetWindow.getContentBounds()
    return {
      x: Math.round(owner.x + bounds.x),
      y: Math.round(owner.y + bounds.y),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height)),
    }
  }

  function transitionConfig(value) {
    const enabled = value === true || (value && typeof value === 'object' && value.enabled !== false)
    const requestedDuration = value && typeof value === 'object'
      ? Number(value.durationMs)
      : Number(transitionDurationMs)
    return {
      enabled,
      durationMs: Number.isFinite(requestedDuration)
        ? Math.max(0, Math.min(2_000, requestedDuration))
        : 480,
    }
  }

  async function waitForActiveTransition(token, durationMs) {
    if (durationMs > 0) await waitForTransition(durationMs)
    return token === transitionSequence
  }

  function createView() {
    const partition = String(getPartition() || '').trim()
    if (!partition) throw new TypeError('browser embed partition is required')
    const view = new WebContentsView({
      webPreferences: {
        partition,
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        navigateOnDragDrop: false,
        webviewTag: false,
        plugins: false,
      },
    })
    browserViewPartition = partition
    const contents = view.webContents
    browserViewNativeRequestGuard = configureIsolatedSession(contents.session, {
      assertRequestAllowed: assertNavigationAllowed,
      installNativeRequestGuard: nativeRequestGuard,
      logger,
    })

    contents.setWindowOpenHandler(details => {
      const rawUrl = String(details?.url || '')
      const sequence = ++windowOpenSequence
      if (isTrustedGoogleOauthPopupUrl(rawUrl)) {
        const normalized = normalizeWebUrl(rawUrl)
        // This window is intentionally user-operated. It uses the same durable
        // partition as the X page, while Playwright remains attached only to
        // the original page so passwords, MFA, and consent cannot be automated.
        pendingWindowOpenNavigation = {
          sequence,
          consumed: false,
          navigation: Promise.resolve({
            ok: true,
            kind: 'google_oauth_popup',
            sequence,
            requestedUrl: normalized,
            finalUrl: normalized,
          }),
        }
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            show: true,
            width: 520,
            height: 720,
            autoHideMenuBar: true,
            webPreferences: {
              partition: browserViewPartition || String(getPartition() || BROWSER_EMBED_PARTITION),
              sandbox: true,
              nodeIntegration: false,
              contextIsolation: true,
              webSecurity: true,
              allowRunningInsecureContent: false,
              webviewTag: false,
              plugins: false,
            },
          },
        }
      }
      const navigation = Promise.resolve().then(async () => {
        const normalized = normalizeWebUrl(rawUrl)
        const allowedUrl = await assertNavigationAllowed(normalized)
        if (contents.isDestroyed()) throw new Error('browser page was closed before navigation')
        await contents.loadURL(String(allowedUrl || normalized))
        const finalUrl = contents.getURL()
        if (!isAllowedWebUrl(finalUrl)) throw new Error('new-window target did not finish on an HTTP(S) page')
        return { ok: true, sequence, requestedUrl: normalized, finalUrl }
      }).catch(error => {
        logger.warn?.('[browser-embed] blocked new-window navigation:', error?.message || error)
        return {
          ok: false,
          sequence,
          requestedUrl: isAllowedWebUrl(rawUrl) ? rawUrl : '',
          error: error?.message || String(error),
        }
      })
      // Non-OAuth popups stay denied: a validated target is taken over by this
      // one managed WebContents instead of creating a second tab/window.
      pendingWindowOpenNavigation = { sequence, consumed: false, navigation }
      return { action: 'deny' }
    })
    contents.on('will-frame-navigate', blockUnsafeNavigation)
    contents.on('will-navigate', blockUnsafeNavigation)
    contents.on('will-redirect', blockUnsafeNavigation)
    contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame !== false && isInPlace !== true) invalidateCardScrollbarStyle()
    })
    contents.on('did-finish-load', () => {
      void syncCardScrollbarStyle()
    })
    contents.on('before-input-event', (event, input) => {
      if (onDiagnosticInput(input, contents) === true) {
        event.preventDefault()
        return
      }
      if (!state.interactive) event.preventDefault()
    })
    contents.on('did-start-loading', () => {
      state.loading = true
      state.error = null
    })
    contents.on('did-stop-loading', () => {
      state.loading = false
      const currentUrl = contents.getURL()
      if (isAllowedWebUrl(currentUrl)) {
        state.url = currentUrl
        requestedUrl = currentUrl
        try {
          onNavigation({
            url: currentUrl,
            title: typeof contents.getTitle === 'function' ? contents.getTitle() : '',
            visitedAt: Date.now(),
          })
        } catch (error) {
          logger.warn?.('[browser-embed] unable to record navigation:', error?.message || error)
        }
      }
    })
    contents.on('did-navigate', (_event, url) => {
      if (isAllowedWebUrl(url)) {
        state.url = url
        requestedUrl = url
        try { onNavigation({ url, title: '', visitedAt: Date.now() }) } catch {}
      }
    })
    contents.on('did-navigate-in-page', (_event, url) => {
      if (isAllowedWebUrl(url)) {
        state.url = url
        requestedUrl = url
        try {
          onNavigation({
            url,
            title: typeof contents.getTitle === 'function' ? contents.getTitle() : '',
            visitedAt: Date.now(),
          })
        } catch {}
      }
    })
    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (isMainFrame === false || errorCode === -3) return
      state.loading = false
      state.error = {
        code: Number(errorCode) || 0,
        message: String(errorDescription || 'page load failed'),
        url: isAllowedWebUrl(validatedUrl) ? validatedUrl : state.url,
      }
    })
    contents.on('render-process-gone', (_event, details) => {
      state.loading = false
      state.error = {
        code: 0,
        message: `embedded browser renderer exited: ${details?.reason || 'unknown'}`,
        url: state.url,
      }
    })

    view.setVisible(false)
    return view
  }

  function createInputShield() {
    if (typeof View !== 'function') return null
    const shield = new View()
    shield.setBackgroundColor('#00000000')
    shield.setVisible(false)
    return shield
  }

  function removeFromCurrentParent() {
    if (currentParentWindow && !currentParentWindow.isDestroyed()) {
      try {
        if (inputShield) currentParentWindow.contentView.removeChildView(inputShield)
        if (browserView) currentParentWindow.contentView.removeChildView(browserView)
      } catch {}
    }
    currentParentWindow = null
    state.attached = false
  }

  function detachFromOwner({ closeContents = false } = {}) {
    transitionSequence += 1
    state.transitioning = false
    state.transitionTarget = null
    removeFromCurrentParent()
    state.visible = false
    setViewVisibility(false)
    if (externalWindow && !externalWindow.isDestroyed()) externalWindow.hide()
    if (closeContents && browserView?.webContents && !browserView.webContents.isDestroyed()) {
      try { browserView.webContents.close() } catch {}
    }
    if (closeContents) {
      browserView = null
      browserViewNativeRequestGuard = false
      inputShield = null
      rendererReadyPromise = null
      requestedUrl = null
      invalidateCardScrollbarStyle()
      cardScrollbarInsert = null
      state.bounds = null
      state.url = null
      state.loading = false
      state.error = null
    }
    mainOwnerWindow = null
  }

  function ensureView(targetWindow) {
    if (!targetWindow || targetWindow.isDestroyed()) {
      throw new Error('main window is unavailable')
    }
    if (mainOwnerWindow && mainOwnerWindow !== targetWindow) detachFromOwner()
    mainOwnerWindow = targetWindow
    if (!browserView || browserView.webContents.isDestroyed()) {
      browserView = createView()
      inputShield = createInputShield()
    }
  }

  async function ensureRendererReady() {
    const contents = browserView?.webContents
    if (!contents || contents.isDestroyed()) {
      throw new Error('embedded browser renderer is unavailable')
    }
    if (contents.getURL()) return
    if (!rendererReadyPromise) {
      // A unique fragment lets the MCP client distinguish this managed page
      // from Bailongma's own renderer and other hidden Electron windows.
      rendererReadyPromise = contents.loadURL(`about:blank#bailongma-browser-${contents.id}`).catch(error => {
        state.loading = false
        state.error = {
          code: 0,
          message: error?.message || String(error),
          url: null,
        }
        throw error
      }).finally(() => {
        rendererReadyPromise = null
      })
    }
    await rendererReadyPromise
  }

  function attachTo(targetWindow) {
    if (currentParentWindow === targetWindow) return
    removeFromCurrentParent()
    targetWindow.contentView.addChildView(browserView)
    if (inputShield) targetWindow.contentView.addChildView(inputShield)
    currentParentWindow = targetWindow
    state.attached = true
  }

  async function prime(targetWindow) {
    ensureView(targetWindow)
    state.mode = 'card'
    state.visible = false
    state.bounds = { x: 0, y: 0, width: 1, height: 1 }
    state.radius = 0
    state.interactive = false
    state.zoomFactor = 1
    attachTo(targetWindow)
    browserView.setBounds(state.bounds)
    browserView.setBorderRadius(0)
    browserView.webContents.setZoomFactor(1)
    if (inputShield) {
      inputShield.setBounds(state.bounds)
      inputShield.setBorderRadius(0)
    }
    setViewVisibility(false)
    await ensureRendererReady()
    return snapshot()
  }

  function transferMainWindow(fromWindow, toWindow) {
    if (mainOwnerWindow !== fromWindow || !toWindow || toWindow.isDestroyed()) return false
    mainOwnerWindow = toWindow
    if (currentParentWindow === fromWindow) attachTo(toWindow)
    return true
  }

  function ensureExternalWindow() {
    if (externalWindow && !externalWindow.isDestroyed()) return externalWindow
    // BrowserWindow provides a normal platform window with a draggable native
    // title bar and the standard close/minimize/zoom controls. BaseWindow is
    // retained as a test/older-Electron fallback, but it is not used by the
    // production main process because its bare content surface gave users no
    // discoverable way to move or dismiss the large browser.
    const ExternalWindow = typeof BrowserWindow === 'function' ? BrowserWindow : BaseWindow
    if (typeof ExternalWindow !== 'function') {
      throw new Error('large embedded browser window is unavailable')
    }
    externalWindow = new ExternalWindow({
      width: 1280,
      height: 840,
      minWidth: 480,
      minHeight: 360,
      show: false,
      title: 'Bailongma Browser',
      backgroundColor: '#000000',
      frame: true,
      titleBarStyle: 'default',
      closable: true,
      minimizable: true,
      maximizable: true,
      movable: true,
      resizable: true,
      fullscreenable: true,
      autoHideMenuBar: true,
      ...(typeof BrowserWindow === 'function' ? {
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webviewTag: false,
        },
      } : {}),
    })
    const hostWindow = externalWindow
    externalRestingContentBounds = hostWindow.getContentBounds()
    const rememberExternalBounds = () => {
      if (
        state.transitioning
        || state.mode !== 'window'
        || currentParentWindow !== hostWindow
        || !state.visible
      ) return
      externalRestingContentBounds = hostWindow.getContentBounds()
    }
    hostWindow.on('resize', () => {
      applyExternalBounds()
      rememberExternalBounds()
    })
    hostWindow.on('move', rememberExternalBounds)
    hostWindow.on('close', event => {
      if (isAppQuitting()) return
      event.preventDefault()
      // The red window button dismisses only the large presentation. Keep the
      // managed WebContentsView alive so a later card/window action preserves
      // URL, history, cookies, title and webContents id.
      transitionSequence += 1
      state.transitioning = false
      state.transitionTarget = null
      state.visible = false
      setViewVisibility(false)
      hostWindow.hide()
    })
    hostWindow.on('closed', () => {
      if (currentParentWindow === hostWindow) {
        currentParentWindow = null
        state.attached = false
      }
      if (externalWindow === hostWindow) externalWindow = null
    })
    return hostWindow
  }

  async function applyCardLayout(targetWindow, { bounds, radius, visible, interactive }) {
    if (externalWindow && !externalWindow.isDestroyed()) externalWindow.hide()
    attachTo(targetWindow)
    state.mode = 'card'
    state.interactive = interactive
    state.bounds = bounds
    state.radius = Math.min(radius, bounds.width / 2, bounds.height / 2)
    state.zoomFactor = bounds.width > 0 ? Math.min(1, bounds.width / 1280) : 1
    state.visible = visible && bounds.width > 0 && bounds.height > 0
    await syncCardScrollbarStyle()
    browserView.setBounds(bounds)
    browserView.setBorderRadius(state.radius)
    browserView.webContents.setZoomFactor(state.zoomFactor)
    if (inputShield) {
      inputShield.setBounds(bounds)
      inputShield.setBorderRadius(state.radius)
    }
    setViewVisibility(state.visible)
  }

  async function moveToWindow(targetWindow, { visible, interactive, transition }) {
    const windowHost = ensureExternalWindow()
    const sourceIsCard = currentParentWindow !== windowHost
    const sourceWasVisible = state.visible
    const reversingCardTransition = Boolean(
      currentParentWindow === windowHost
      && state.transitioning
      && state.transitionTarget === 'card',
    )
    const startBounds = sourceIsCard && state.bounds
      ? cardScreenBounds(targetWindow, state.bounds)
      : null
    const targetBounds = externalRestingContentBounds || windowHost.getContentBounds()
    const shouldAnimate = Boolean(
      transition.enabled
      && sourceWasVisible
      && visible
      && ((sourceIsCard && startBounds) || reversingCardTransition),
    )
    const token = ++transitionSequence

    state.mode = 'window'
    state.interactive = interactive
    state.radius = 0
    state.zoomFactor = 1
    state.transitioning = shouldAnimate
    state.transitionTarget = shouldAnimate ? 'window' : null
    browserView.webContents.setZoomFactor(1)
    await syncCardScrollbarStyle()

    if (shouldAnimate && startBounds) setExternalContentBounds(windowHost, startBounds, false)
    attachTo(windowHost)
    applyExternalBounds()
    state.visible = visible && state.bounds.width > 0 && state.bounds.height > 0
    setViewVisibility(state.visible)
    if (state.visible) windowHost.show()
    else windowHost.hide()

    if (shouldAnimate) {
      setExternalContentBounds(windowHost, targetBounds, true)
      const active = await waitForActiveTransition(token, transition.durationMs)
      if (!active) return snapshot()
      applyExternalBounds()
    } else if (reversingCardTransition) {
      // A non-animated reversal still has to cancel the native shrink that is
      // already in flight, otherwise the large host can finish at card size.
      setExternalContentBounds(windowHost, targetBounds, false)
      applyExternalBounds()
    }

    if (token === transitionSequence) {
      state.transitioning = false
      state.transitionTarget = null
      if (state.visible) windowHost.focus()
    }
    return snapshot()
  }

  async function moveToCard(targetWindow, { bounds, radius, visible, interactive, transition }) {
    const sourceIsWindow = Boolean(
      externalWindow
      && !externalWindow.isDestroyed()
      && currentParentWindow === externalWindow,
    )
    const sourceWasVisible = state.visible
    const shouldAnimate = Boolean(
      transition.enabled
      && sourceIsWindow
      && sourceWasVisible
      && visible,
    )
    const token = ++transitionSequence

    state.transitioning = shouldAnimate
    state.transitionTarget = shouldAnimate ? 'card' : null
    if (shouldAnimate) {
      const targetBounds = cardScreenBounds(targetWindow, bounds)
      setExternalContentBounds(externalWindow, targetBounds, true)
      const active = await waitForActiveTransition(token, transition.durationMs)
      if (!active) return snapshot()
    }

    if (token !== transitionSequence) return snapshot()
    await applyCardLayout(targetWindow, { bounds, radius, visible, interactive })
    state.transitioning = false
    state.transitionTarget = null
    return snapshot()
  }

  async function update(targetWindow, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('browser embed update options must be an object')
    }
    if (typeof options.visible !== 'boolean') {
      throw new TypeError('browser embed visible must be a boolean')
    }
    if (options.interactive != null && typeof options.interactive !== 'boolean') {
      throw new TypeError('browser embed interactive must be a boolean')
    }

    const mode = options.mode == null ? 'card' : options.mode
    if (mode !== 'card' && mode !== 'window') {
      throw new TypeError('browser embed mode must be "card" or "window"')
    }
    const bounds = mode === 'card'
      ? normalizeBounds(options.bounds, targetWindow?.getContentBounds?.())
      : null
    const radius = finiteNonNegative(options.radius ?? 0, 'browser embed radius')
    const nextUrl = options.url == null ? null : normalizeWebUrl(options.url)
    const transition = transitionConfig(options.transition)

    ensureView(targetWindow)
    await ensureRendererReady()
    if (mode === 'window') {
      await moveToWindow(targetWindow, {
        visible: options.visible,
        interactive: options.interactive === true,
        transition,
      })
    } else {
      await moveToCard(targetWindow, {
        bounds,
        radius,
        visible: options.visible,
        interactive: options.interactive === true,
        transition,
      })
    }

    if (nextUrl && nextUrl !== requestedUrl) {
      requestedUrl = nextUrl
      state.url = nextUrl
      state.loading = true
      state.error = null
      try {
        await browserView.webContents.loadURL(nextUrl)
      } catch (error) {
        state.loading = false
        state.error ||= {
          code: 0,
          message: error?.message || String(error),
          url: nextUrl,
        }
        logger.warn?.('[browser-embed] load failed:', state.error.message)
      }
    }

    await syncCardScrollbarStyle()
    return snapshot()
  }

  function hide(targetWindow) {
    if (mainOwnerWindow && mainOwnerWindow !== targetWindow) {
      throw new Error('embedded browser belongs to another window')
    }
    transitionSequence += 1
    state.visible = false
    state.transitioning = false
    state.transitionTarget = null
    setViewVisibility(false)
    if (externalWindow && !externalWindow.isDestroyed()) externalWindow.hide()
    return snapshot()
  }

  // Closing a browser page is deliberately different from clearing its
  // persistent partition. The WebContents and its large-window host are
  // destroyed, while cookies, login state, site storage, cache, and the
  // separately persisted visit history remain untouched.
  function closePage() {
    pendingWindowOpenNavigation = null
    detachFromOwner({ closeContents: true })
    if (externalWindow && !externalWindow.isDestroyed()) {
      try { externalWindow.destroy() } catch {}
    }
    externalWindow = null
    externalRestingContentBounds = null
    state.mode = 'card'
    state.radius = 0
    state.interactive = false
    state.zoomFactor = 1
    return snapshot()
  }

  function getState(targetWindow) {
    if (mainOwnerWindow && mainOwnerWindow !== targetWindow) {
      throw new Error('embedded browser belongs to another window')
    }
    return snapshot()
  }

  function releaseWindow(targetWindow) {
    if (mainOwnerWindow !== targetWindow) return
    detachFromOwner()
  }

  function destroyAll() {
    closePage()
  }

  function getTarget() {
    const contents = browserView?.webContents
    if (!contents || contents.isDestroyed()) return null
    return Object.freeze({
      webContentsId: contents.id,
      partition: browserViewPartition || String(getPartition() || BROWSER_EMBED_PARTITION),
      url: isAllowedWebUrl(contents.getURL()) ? contents.getURL() : state.url,
      debugUrl: contents.getURL(),
      mode: state.mode,
      visible: state.visible,
      nativeNetworkGuard: browserViewNativeRequestGuard,
    })
  }

  function getWebContents() {
    const contents = browserView?.webContents
    return contents && !contents.isDestroyed() ? contents : null
  }

  async function consumeWindowOpenNavigation() {
    const pending = pendingWindowOpenNavigation
    if (!pending || pending.consumed) return null
    pending.consumed = true
    const result = await pending.navigation
    if (pendingWindowOpenNavigation === pending) pendingWindowOpenNavigation = null
    return result
  }

  return {
    update,
    prime,
    transferMainWindow,
    hide,
    closePage,
    consumeWindowOpenNavigation,
    getState,
    releaseWindow,
    destroyAll,
    getTarget,
    getWebContents,
  }
}

module.exports = {
  BROWSER_EMBED_PARTITION,
  configureIsolatedSession,
  createBrowserEmbedHost,
  isAllowedWebUrl,
  isTrustedGoogleOauthPopupUrl,
  normalizeBounds,
}
