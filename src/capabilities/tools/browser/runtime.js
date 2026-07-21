import { BROWSER_VIEWPORT, getPrimaryChromiumLaunchOptions } from '../web/browser.js'

let playwrightPromise = null

export async function loadChromium() {
  if (!playwrightPromise) {
    playwrightPromise = import('playwright')
      .then(mod => mod.chromium)
      .catch(err => {
        playwrightPromise = null
        throw new Error(`Playwright is not bundled in this build: ${err.message || String(err)}`)
      })
  }
  return playwrightPromise
}

export function browserLaunchOptions({ visible = true } = {}) {
  return {
    ...getPrimaryChromiumLaunchOptions(),
    headless: !visible,
  }
}

export function browserContextOptions(options = {}, { visible = true } = {}) {
  const viewport = options.viewport !== undefined
    ? options.viewport
    : visible ? null : BROWSER_VIEWPORT
  return {
    // A null viewport lets a headed page follow native window resizes. Keep a
    // deterministic viewport for headless runs where there is no OS window.
    viewport,
    locale: options.locale || 'zh-CN',
    acceptDownloads: false,
    // Service-worker requests are not visible to BrowserContext.route. Block
    // registration so the URL/private-network guard covers all page traffic.
    serviceWorkers: 'block',
  }
}

function launchCandidates(options) {
  const candidates = [options]
  // Normal use prefers stable Google Chrome. A packaged build retains its
  // staged Chromium as the deterministic offline fallback. Prefer the
  // machine's current stable Edge before that fallback because Edge ships on
  // most Windows systems and stays current through the OS/browser updater.
  const fallbackChannels = ['chrome', 'msedge', 'chromium']
  for (const channel of fallbackChannels) {
    if (channel !== options.channel) candidates.push({ ...options, channel })
  }
  return candidates
}

export async function launchBrowser(chromium, options) {
  let firstError
  for (const candidate of launchCandidates(options)) {
    try { return await chromium.launch(candidate) } catch (err) { firstError ||= err }
  }
  throw firstError
}

export async function launchPersistentBrowserContext(chromium, profilePath, options) {
  let firstError
  for (const candidate of launchCandidates(options)) {
    try { return await chromium.launchPersistentContext(profilePath, candidate) } catch (err) { firstError ||= err }
  }
  throw firstError
}
