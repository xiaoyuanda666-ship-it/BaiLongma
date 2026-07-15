// Shared browser launch constants. Browser lifetime and pooling are owned by
// BrowserSessionManager; one-shot reads and stateful browser tools use it alike.
export const BROWSER_VIEWPORT = { width: 1365, height: 900 }

export function getPrimaryChromiumLaunchOptions(env = process.env) {
  return env.BAILONGMA_BUNDLED_PLAYWRIGHT === '1'
    ? { headless: true, channel: 'chromium' }
    : { headless: true }
}
