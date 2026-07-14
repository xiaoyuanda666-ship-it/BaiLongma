// 共享 Chromium 单例：避免每次 browser_read 冷启动（耗时 3~5 秒）
import { throwIfAborted } from '../../abort-utils.js'

let _sharedBrowser = null
let _sharedBrowserLastUsed = 0
let _playwrightChromium = null
const BROWSER_IDLE_TIMEOUT_MS = 10 * 60 * 1000  // 闲置 10 分钟后关掉

export const BROWSER_VIEWPORT = { width: 1365, height: 900 }

export async function getSharedBrowser() {
  const now = Date.now()
  if (_sharedBrowser && now - _sharedBrowserLastUsed > BROWSER_IDLE_TIMEOUT_MS) {
    try { await _sharedBrowser.close() } catch {}
    _sharedBrowser = null
  }
  if (!_sharedBrowser) {
    _sharedBrowser = await launchReadableBrowser()
  }
  _sharedBrowserLastUsed = Date.now()
  return _sharedBrowser
}

export function invalidateSharedBrowser() {
  _sharedBrowser = null
}

async function launchReadableBrowser() {
  const chromium = await getPlaywrightChromium()
  const launchOptions = getPrimaryChromiumLaunchOptions()
  if (launchOptions.channel === 'chromium') {
    return chromium.launch(launchOptions)
  }
  try {
    return await chromium.launch(launchOptions)
  } catch (firstError) {
    for (const channel of ['msedge', 'chrome']) {
      try {
        return await chromium.launch({ ...launchOptions, channel })
      } catch {}
    }
    throw firstError
  }
}

export function getPrimaryChromiumLaunchOptions(env = process.env) {
  return env.BAILONGMA_BUNDLED_PLAYWRIGHT === '1'
    ? { headless: true, channel: 'chromium' }
    : { headless: true }
}

async function getPlaywrightChromium() {
  if (_playwrightChromium) return _playwrightChromium
  try {
    const mod = await import('playwright')
    _playwrightChromium = mod.chromium
    return _playwrightChromium
  } catch (err) {
    throw new Error(`Playwright is not bundled in this build: ${err.message || String(err)}`)
  }
}

export async function autoScrollPage(page, signal) {
  for (let i = 0; i < 4; i++) {
    throwIfAborted(signal)
    await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight, 800)))
    await page.waitForTimeout(450)
  }
  await page.evaluate(() => window.scrollTo(0, 0))
}
