// 联网工具：web_search / web_read。Legacy fetch_url/browser_read executors are
// retained for historical calls but are not exposed in the tool schema.
// 实现按职责拆分到 ./web/ 子模块，此处仅作 barrel 再导出，保持对外接口不变。
//   web/util.js         —— 共享底层（HTTP 头、HTML 处理、长文落盘）
//   web/browser.js      —— 共享 Chromium 单例
//   web/search.js       —— web_search 多引擎
//   web/browser-read.js —— 内部 Playwright 一次性读取兼容层
//   web/fetch.js        —— web_read（受保护直连 / 本地 Playwright / Jina）
export { execWebSearch } from './web/search.js'
export { execWebRead, execFetchUrl } from './web/fetch.js'
export { execBrowserRead } from './web/browser-read.js'
