// Only standalone capture requests may hide navigation and tool discovery.
// A screenshot inside a larger task still requires real image delivery.
const CAPTURE_RE = /(?:截图|截屏|截(?:一?张|个)?(?:当前|现在|这个|网页|页面|浏览器|这一屏|整页)?图|take\s+(?:a\s+)?screenshot)/iu
const NEGATED_CAPTURE_RE = /(?:不要|不用|无需|请勿|禁止|不得|别|不)(?:再|要)?\s*(?:截图|截屏|截(?:一?张|个)?图)|(?:do\s+not|don't|never)\s+(?:take\s+(?:a\s+)?(?:screen\s*shot)|screenshot)/giu
const STANDALONE_RE = /^(?:(?:请|帮我|给我|把|将|对|为我|当前|现在|这个|网页|页面|浏览器|这一屏|整页|的|一张|一下|一份|张|个|图|并|然后|再|在|聊天里|聊天中|展示|显示|发给我|发我|给我看看|让我看看|看看|看一下|发送|发过来|给我|吧|谢谢|直接|就|只要)|截图|截屏|截|\s|[，,。.!！?？；;])*$/u

export function classifyBrowserScreenshotIntent(text = '') {
  const value = String(text || '').replace(NEGATED_CAPTURE_RE, '')
  if (!CAPTURE_RE.test(value)) return null
  const standalone = STANDALONE_RE.test(value)
    || /^(?:please\s+)?take\s+(?:a\s+)?screenshot(?:\s+of\s+(?:the\s+)?(?:current\s+)?page)?(?:\s+and\s+send\s+it\s+to\s+me)?[.!?\s]*$/iu.test(value)
  const requiredTools = ['browser_take_screenshot']
  if (!standalone) {
    // Keep discovery available for other actions, while preloading the common
    // prerequisites explicitly requested in capture-and-read workflows.
    if (/(?:https?:\/\/|www\.|browser_navigate\b|打开|访问|导航|\b(?:open|visit|navigate)\b)/iu.test(value)) requiredTools.unshift('browser_navigate')
    if (/(?:browser_snapshot\b|读取|阅读|正文|标题|\b(?:read|title|text)\b)/iu.test(value)) requiredTools.unshift('browser_snapshot')
  }
  return {
    id: 'browser_screenshot',
    label: '截取并发送浏览器截图',
    requiredTools,
    ...(standalone ? { directBrowserAction: true, restrictTools: true } : {}),
  }
}
