import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { config } from './config.js'
import { TOOL_SCHEMAS } from './capabilities/schemas.js'
import { execFetchUrl, execWebRead } from './capabilities/tools/web.js'
import { shutdownBrowserTools } from './capabilities/tools/browser-tools.js'

const server = http.createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8')
  if (request.url === '/dynamic') {
    response.end('<!doctype html><title>Dynamic</title><main id="app"></main><script>document.querySelector("#app").textContent = "Rendered by local Playwright with enough readable content to pass extraction and prove that JavaScript execution completed successfully."</script>')
    return
  }
  response.end('<!doctype html><title>Static</title><main>Static content with enough readable text for the protected HTTP extraction path to succeed.</main>')
})

server.listen(0, '127.0.0.1')
await once(server, 'listening')
const { port } = server.address()
const previousPrivateNetwork = config.security.browserPrivateNetwork

try {
  assert.ok(TOOL_SCHEMAS.web_read, 'web_read is exposed')
  assert.equal(TOOL_SCHEMAS.fetch_url, undefined, 'legacy fetch_url schema is hidden')
  assert.equal(TOOL_SCHEMAS.browser_read, undefined, 'legacy browser_read schema is hidden')

  config.security.browserPrivateNetwork = false
  const blocked = JSON.parse(await execWebRead({
    url: `http://127.0.0.1:${port}/static`, render: 'http', fresh: true, remote_fallback: false,
  }))
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, 'PRIVATE_NETWORK_BLOCKED')

  config.security.browserPrivateNetwork = true
  const direct = JSON.parse(await execWebRead({
    url: `http://127.0.0.1:${port}/static`, render: 'http', fresh: true, remote_fallback: false,
  }))
  assert.equal(direct.ok, true)
  assert.equal(direct.tool, 'web_read')
  assert.equal(direct.read_source, 'http')
  assert.equal(direct.title, 'Static')

  const dynamic = JSON.parse(await execWebRead({
    url: `http://127.0.0.1:${port}/dynamic`, render: 'auto', fresh: true, remote_fallback: false,
  }))
  assert.equal(dynamic.ok, true)
  assert.equal(dynamic.tool, 'web_read')
  assert.equal(dynamic.read_source, 'playwright')
  assert.match(dynamic.content, /Rendered by local Playwright/)

  const legacy = JSON.parse(await execFetchUrl({
    url: `http://127.0.0.1:${port}/static`, render: 'http', fresh: true, remote_fallback: false,
  }))
  assert.equal(legacy.tool, 'web_read', 'legacy executor alias returns the canonical contract')

  console.log('test-web-read passed')
} finally {
  config.security.browserPrivateNetwork = previousPrivateNetwork
  await shutdownBrowserTools()
  server.close()
  await once(server, 'close')
}
