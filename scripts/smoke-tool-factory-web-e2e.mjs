import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'

const checks = []
const repoRoot = process.cwd()
const tempUserDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-tool-factory-web-'))
const TOOL_NAME = 'readable_web_fetch'

process.env.JARVIS_USER_DIR = tempUserDir
process.env.JARVIS_RESOURCES_DIR = repoRoot
process.env.ELECTRON_RUN_AS_NODE = '1'

function assert(condition, label, detail = '') {
  checks.push({ ok: !!condition, label, detail })
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${label}${condition ? '' : (detail ? `\n  ${detail}` : '')}`)
}

function parseJson(value) {
  try {
    return JSON.parse(String(value || ''))
  } catch {
    return null
  }
}

function parseMarker(stdout) {
  const line = String(stdout || '').split(/\r?\n/).find(l => l.startsWith('@@RESULT@@'))
  if (!line) return null
  return parseJson(line.slice('@@RESULT@@'.length))
}

function runIsolatedNode(script, extraEnv = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-'], {
    input: script,
    cwd: repoRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      JARVIS_USER_DIR: tempUserDir,
      JARVIS_RESOURCES_DIR: repoRoot,
      ...extraEnv,
    },
    encoding: 'utf-8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  })
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address()))
  })
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve))
}

const fixtureHtml = `<!doctype html>
<html>
  <head>
    <title>Readable Test Page</title>
    <meta name="description" content="A compact summary for readers.">
  </head>
  <body>
    <main>
      <h1>Article Heading</h1>
      <p>First paragraph with <strong>important</strong> text.</p>
      <p>Second paragraph for context.</p>
      <a href="/next">Read more</a>
    </main>
  </body>
</html>`
const fixtureDataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(fixtureHtml)}`

const expectedExtract = {
  url: '',
  title: 'Readable Test Page',
  description: 'A compact summary for readers.',
  headings: ['Article Heading'],
  text: 'Article Heading First paragraph with important text. Second paragraph for context. Read more',
  links: [{ href: '/next', text: 'Read more' }],
}

const readableWebFetchCode = `
const decode = (value = '') => String(value || '')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;/gi, "'")

const cleanText = (value = '') => decode(String(value || '').replace(/<[^>]+>/g, ' '))
  .replace(/\\s+/g, ' ')
  .trim()

let html = String(args.html || '')
const url = String(args.url || '')
if (!html && url) {
  const response = await helpers.fetch(url)
  html = await response.text()
}
if (!html) throw new Error('Provide either url or html')

const withoutNoise = html
  .replace(/<script[\\s\\S]*?<\\/script>/gi, ' ')
  .replace(/<style[\\s\\S]*?<\\/style>/gi, ' ')
  .replace(/<(nav|aside|header|footer)[\\s\\S]*?<\\/\\1>/gi, ' ')

const pick = (pattern) => {
  const match = pattern.exec(withoutNoise)
  return match ? cleanText(match[1]) : ''
}

const title = pick(/<title[^>]*>([\\s\\S]*?)<\\/title>/i)
const description =
  pick(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i) ||
  pick(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i)

const headings = []
const headingRe = /<h[1-3][^>]*>([\\s\\S]*?)<\\/h[1-3]>/gi
let headingMatch
while ((headingMatch = headingRe.exec(withoutNoise)) && headings.length < 8) {
  const heading = cleanText(headingMatch[1])
  if (heading) headings.push(heading)
}

const links = []
const linkRe = /<a\\b[^>]*href=["']([^"']+)["'][^>]*>([\\s\\S]*?)<\\/a>/gi
let linkMatch
while ((linkMatch = linkRe.exec(withoutNoise)) && links.length < 20) {
  const text = cleanText(linkMatch[2])
  if (text) links.push({ href: decode(linkMatch[1]).trim(), text })
}

const bodyMatch = /<body[^>]*>([\\s\\S]*?)<\\/body>/i.exec(withoutNoise)
const source = bodyMatch ? bodyMatch[1] : withoutNoise
const maxChars = Math.max(200, Math.min(12000, Number(args.max_chars) || 4000))
const text = cleanText(source).slice(0, maxChars)

return { url, title, description, headings, text, links }
`

let proposalId = ''
let server = null

try {
  const { execManageToolFactory } = await import('../src/capabilities/tool-factory.js')
  const {
    executeInstalledTool,
    getInstalledToolSchema,
    isInstalledTool,
    uninstallTool,
  } = await import('../src/capabilities/marketplace/index.js')
  const { TOOL_SCHEMAS } = await import('../src/capabilities/schemas.js')

  assert(TOOL_SCHEMAS.fetch_url?.function?.name === 'fetch_url', 'builtin fetch_url schema still exists')
  assert(getInstalledToolSchema('fetch_url') === null, 'builtin fetch_url is not overwritten by an installed tool')

  const protectedNameProposal = parseJson(await execManageToolFactory({
    action: 'propose',
    name: 'fetch_url',
    description: 'Attempt to overwrite the builtin fetch_url tool.',
    parameters_schema: { type: 'object', properties: {}, required: [] },
    code: 'return "no"',
    tests: [{ name: 'runs', args: {}, expect: 'no' }],
  }))
  const protectedNameReview = parseJson(await execManageToolFactory({
    action: 'review',
    proposal_id: protectedNameProposal.proposal_id,
  }))
  assert(protectedNameReview?.ok === false, 'factory refuses to approve a builtin fetch_url override', JSON.stringify(protectedNameReview))
  await execManageToolFactory({ action: 'delete', proposal_id: protectedNameProposal.proposal_id })

  const proposed = parseJson(await execManageToolFactory({
    action: 'propose',
    name: TOOL_NAME,
    description: 'Fetch a web page and return readable title, description, headings, body text, and links. Use when builtin fetch_url returns noisy HTML.',
    parameters_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch when html is not provided.' },
        html: { type: 'string', description: 'Optional HTML fixture for deterministic tests.' },
        max_chars: { type: 'number', description: 'Maximum readable text characters to return.' },
      },
      required: [],
    },
    permissions: { network: true, exec: false },
    code: readableWebFetchCode,
    tests: [{
      name: 'extracts readable fields from html fixture without network',
      args: { html: fixtureHtml },
      expect_json: expectedExtract,
    }],
  }))
  proposalId = proposed?.proposal_id || ''
  assert(proposed?.ok === true && proposalId, 'readable web fetch proposal is stored as a new tool', JSON.stringify(proposed))

  const reviewed = parseJson(await execManageToolFactory({ action: 'review', proposal_id: proposalId }))
  assert(reviewed?.ok === true && reviewed.status === 'approved', 'readable web fetch passes review with deterministic fixture tests', JSON.stringify(reviewed))
  assert((reviewed?.warnings || []).some(w => /network permission requested/.test(w)), 'review warns that network permission is declared but tests are offline', JSON.stringify(reviewed?.warnings))
  assert((reviewed?.test_results || []).every(t => t.ok), 'review fixture tests pass', JSON.stringify(reviewed?.test_results))

  const installed = parseJson(await execManageToolFactory({ action: 'install', proposal_id: proposalId }))
  assert(installed?.ok === true && installed.tool === TOOL_NAME, 'approved readable web fetch installs as a separate tool', JSON.stringify(installed))
  assert(isInstalledTool(TOOL_NAME), 'new readable web fetch is in installed registry')
  assert(getInstalledToolSchema(TOOL_NAME)?.function?.name === TOOL_NAME, 'new readable web fetch exposes function-call schema')
  assert(getInstalledToolSchema('fetch_url') === null, 'installing readable web fetch still does not override builtin fetch_url')

  const fixtureResult = parseJson(await executeInstalledTool(TOOL_NAME, { html: fixtureHtml }))
  assert(fixtureResult?.title === expectedExtract.title, 'installed tool extracts title from fixture html', JSON.stringify(fixtureResult))
  assert(fixtureResult?.description === expectedExtract.description, 'installed tool extracts description from fixture html', JSON.stringify(fixtureResult))
  assert(fixtureResult?.text === expectedExtract.text, 'installed tool extracts readable body text from fixture html', JSON.stringify(fixtureResult))

  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(fixtureHtml)
  })
  const address = await listen(server)
  const fixtureUrl = `http://127.0.0.1:${address.port}/article.html`

  const beforeList = parseJson(await execManageToolFactory({ action: 'list' }))
  const runtimeResult = parseJson(await executeInstalledTool(TOOL_NAME, { url: fixtureUrl }))
  const afterList = parseJson(await execManageToolFactory({ action: 'list' }))
  assert(runtimeResult?.url === fixtureUrl, 'installed tool fetches a real local URL when url is provided', JSON.stringify(runtimeResult))
  assert(runtimeResult?.title === expectedExtract.title, 'installed tool extracts title from fetched page', JSON.stringify(runtimeResult))
  assert(runtimeResult?.links?.[0]?.href === '/next', 'installed tool extracts links from fetched page', JSON.stringify(runtimeResult?.links))
  assert((beforeList?.proposals || []).length === (afterList?.proposals || []).length, 'fallback use calls installed tool without creating another proposal')

  const reloadRun = runIsolatedNode(`
    import { executeInstalledTool, getInstalledToolSchema, loadInstalledTools } from './src/capabilities/marketplace/index.js'
    const name = ${JSON.stringify(TOOL_NAME)}
    const url = ${JSON.stringify(fixtureDataUrl)}
    await loadInstalledTools()
    const schema = getInstalledToolSchema(name)
    const result = JSON.parse(await executeInstalledTool(name, { url }))
    console.log('@@RESULT@@' + JSON.stringify({
      schema_name: schema?.function?.name,
      title: result.title,
      text: result.text,
      first_link: result.links?.[0]?.href,
    }))
  `)
  assert(reloadRun.status === 0, 'fresh runtime reload process exits cleanly', reloadRun.stderr || reloadRun.stdout)

  const reloaded = parseMarker(reloadRun.stdout)
  assert(reloaded?.schema_name === TOOL_NAME, 'fresh runtime reloads readable web fetch schema from disk', JSON.stringify(reloaded))
  assert(reloaded?.title === expectedExtract.title, 'reloaded readable web fetch still fetches and extracts the page', JSON.stringify(reloaded))
  assert(reloaded?.first_link === '/next', 'reloaded readable web fetch keeps link extraction behavior', JSON.stringify(reloaded))

  if (isInstalledTool(TOOL_NAME)) uninstallTool({ name: TOOL_NAME })
  await execManageToolFactory({ action: 'delete', proposal_id: proposalId })
  proposalId = ''
} finally {
  if (server) await closeServer(server)
  try {
    if (proposalId) {
      const { execManageToolFactory } = await import('../src/capabilities/tool-factory.js')
      await execManageToolFactory({ action: 'delete', proposal_id: proposalId })
    }
  } catch {}
  fs.rmSync(tempUserDir, { recursive: true, force: true })
}

const failed = checks.filter(c => !c.ok)
console.log(`\nReadable web tool factory smoke: ${checks.length - failed.length}/${checks.length} passed`)
if (failed.length) process.exitCode = 1
