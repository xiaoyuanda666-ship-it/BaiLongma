// Compatibility response for stale tool calls. This tool is no longer advertised.
export function normalizeBrowserDisplayMode() { return '' }
export function execBrowserSetDisplayMode() {
  return JSON.stringify({ok:false, code:'BROWSER_DISPLAY_REMOVED', error:'网页仅在真实 Chrome Agent Window 展示；已取消卡片和自建浏览器窗口。'})
}
