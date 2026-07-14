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

export function browserContextOptions(options = {}) {
  return {
    viewport: options.viewport || BROWSER_VIEWPORT,
    locale: options.locale || 'zh-CN',
    acceptDownloads: false,
    // Service-worker requests are not visible to BrowserContext.route. Block
    // registration so the URL/private-network guard covers all page traffic.
    serviceWorkers: 'block',
  }
}

function launchCandidates(options) {
  // The Bailongma-specific flag is an explicit packaged-runtime contract.
  // Falling back to a machine-wide Edge/Chrome installation would hide a
  // missing or corrupt extraResource and make an "offline bundled" build
  // depend on the user's machine.
  if (process.env.BAILONGMA_BUNDLED_PLAYWRIGHT === '1') return [options]
  const candidates = [options]
  for (const channel of ['chromium', 'msedge', 'chrome']) {
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
