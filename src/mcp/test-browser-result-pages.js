import assert from 'node:assert/strict'
import { paginateBrowserResult, readBrowserResultPage } from './browser-result-pages.js'

const context = { currentTargetId: 'reader' }
const text = '开始\\n' + '长正文"\\\n'.repeat(30000) + '末尾正文'
const payload = { ok: true, tool: 'browser_find', remote_tool: 'browser_find',
  structured_content: { page_find: { total_matches: 9 } } }
let result = paginateBrowserResult(payload, [{ type: 'text', text }], context)
assert.equal(result.structured_content.page_find.total_matches, 9)
const cursor = result.pagination.next_cursor
assert.equal(readBrowserResultPage(cursor, { currentTargetId: 'other' }).ok, false)
assert.equal(readBrowserResultPage('invalid', context).ok, false)
let restored = ''
while (true) {
  assert.ok(JSON.stringify(result).length < 100000)
  restored += result.content[0].text
  if (!result.pagination.has_more) break
  result = readBrowserResultPage(result.pagination.next_cursor, context)
  assert.equal(result.ok, true)
}
assert.equal(restored, text, 'all page text, including escaped characters and final content, is preserved')
assert.equal(result.truncated, false)
assert.equal(result.pagination.next_cursor, null)
for (let i = 0; i < 9; i++) paginateBrowserResult(payload, [{ type: 'text', text: 'x'.repeat(12000) }], context)
assert.equal(readBrowserResultPage(cursor, context).code, 'BROWSER_CURSOR_EXPIRED')
console.log('Browser result pagination tests passed')

// Legacy formatter pagination is retained for non-browser MCP compatibility.
// BrowserSkill continuation uses its own observe cursor, never this cache.
const fs = await import('node:fs')
const os = await import('node:os')
const path = await import('node:path')
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-pages-'))
process.env.BAILONGMA_USER_DIR = userDir
try {
  const { __internal, executeBuiltInChromeTool } = await import('./client-manager.js')
  const tool = { alias: 'browser_snapshot', remoteName: 'browser_snapshot', serverId: 'builtin_chrome_devtools' }
  const options = { serverConfig: { builtIn: true, chromeDevtools: true }, browserContext: context }
  const shortText = 'uid=1_0 ' + '正文'.repeat(25000) + '完整结尾'
  const small = JSON.parse(__internal.formatMcpToolResult(tool, {
    content: [{ type: 'text', text: shortText }],
    structuredContent: { snapshot: { duplicated: shortText }, page_find: { total_matches: 9 } },
  }, options))
  assert.equal(small.content[0].text, shortText)
  assert.equal(small.truncated, undefined)
  assert.equal(small.structured_content.page_find.total_matches, 9)
  assert.equal(small.structured_content.snapshot, undefined)
  let large = JSON.parse(__internal.formatMcpToolResult(tool, {
    content: [{ type: 'text', text }],
  }, options))
  let full = large.content[0].text
  while (large.pagination.has_more) {
    large = readBrowserResultPage(large.pagination.next_cursor, context)
    assert.equal(large.ok, true)
    full += large.content[0].text
  }
  assert.equal(full, text)
  console.log('Legacy formatter pagination integration tests passed')
} finally {
  fs.rmSync(userDir, { recursive: true, force: true })
}

const unicode = paginateBrowserResult(payload, [{ type: 'text', text: 'x'.repeat(9999) + '😀尾' }], context)
assert.equal(unicode.content[0].text.length, 9999)
assert.equal(readBrowserResultPage(unicode.pagination.next_cursor, context).content[0].text, '😀尾')
const failed = paginateBrowserResult({ ...payload, ok: false }, [{ type: 'text', text: 'failure'.repeat(2000) }], context)
assert.equal(readBrowserResultPage(failed.pagination.next_cursor, context).ok, false)
console.log('Unicode boundaries and failed-result status tests passed')
