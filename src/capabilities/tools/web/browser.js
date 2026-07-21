// Shared browser launch constants. Browser lifetime and pooling are owned by
// BrowserSessionManager; one-shot reads and stateful browser tools use it alike.
export const BROWSER_VIEWPORT = { width: 1365, height: 900 }

export function getPrimaryChromiumLaunchOptions(env = process.env) {
  // Prefer the user's installed stable Google Chrome so the browser engine,
  // User-Agent Client Hints, and Chrome feature set stay internally
  // consistent. Packaged builds can still fall back to their bundled
  // Playwright Chromium when Chrome is unavailable.
  const channel = String(env.BAILONGMA_BROWSER_CHANNEL || 'chrome').trim().toLowerCase()
  if (!['chrome', 'chromium', 'msedge'].includes(channel)) {
    throw new Error(`Unsupported BAILONGMA_BROWSER_CHANNEL: ${channel}`)
  }
  return { headless: true, channel }
}
