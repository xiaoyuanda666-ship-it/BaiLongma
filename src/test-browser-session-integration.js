import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { BrowserSessionManager } from './capabilities/tools/browser/index.js'

const fixture = http.createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8')
  if (request.url === '/next') {
    response.end('<!doctype html><title>Next page</title><main>Navigation complete</main><button id="done">Done</button>')
    return
  }
  response.end(`<!doctype html>
    <title>Browser fixture</title>
    <main>
      <label for="name">Name</label><input id="name" placeholder="Your name">
      <label for="password">Password</label><input id="password" type="password" value="NEVER_EXPOSE_THIS_SECRET">
      <label><input id="agree" type="checkbox"> Accept terms</label>
      <label for="choice">Choice</label><input id="choice" type="radio" name="choice">
      <input id="input-button" type="button" value="SENSITIVE_BUTTON_VALUE" aria-label="Input action">
      <button id="greet" onclick="document.querySelector('#output').textContent = 'Hello ' + document.querySelector('#name').value; if (!document.querySelector('#dynamic')) { const b = document.createElement('button'); b.id = 'dynamic'; b.textContent = 'Dynamic'; document.querySelector('main').append(b) }"><span>Greet</span></button>
      <a href="/next"><span>Continue</span></a>
      <div id="plain-click" aria-label="Plain div expander" onclick="document.querySelector('#plain-expanded').hidden = false; document.querySelector('#react-outer').setAttribute('data-bailongma-ref', this.getAttribute('data-bailongma-ref'))">Open plain div</div>
      <p id="plain-expanded" hidden>Plain div expanded content</p>
      <div id="react-outer" aria-label="React nested region"><span>React nested target</span></div>
      <div id="pointer-click" class="pointer-click" aria-label="Pointer target"><span>Pointer child</span></div>
      <div id="property-click" aria-label="DOM property target">DOM property handler</div>
      <div id="dedupe-parent" aria-label="Parent click target" onclick="document.querySelector('#dedupe-output').textContent = 'parent'">
        <div id="dedupe-child" aria-label="Smallest click target" onclick="event.stopPropagation(); document.querySelector('#dedupe-output').textContent = 'child'">Smallest target</div>
      </div>
      <div id="dedupe-output">No dedupe click</div>
      <div id="static-div" aria-label="Static container">Static non-interactive div</div>
      <div id="hidden-click" aria-label="Hidden click target" style="display:none" onclick="void 0">Hidden</div>
      <button id="disabled-button" disabled>Disabled button</button>
      <button disabled><span id="disabled-button-child" aria-label="Disabled button child" onclick="void 0">Disabled child</span></button>
      <fieldset disabled><div id="disabled-fieldset-child" aria-label="Disabled fieldset child" onclick="void 0">Disabled fieldset child</div></fieldset>
      <div id="aria-disabled-click" aria-disabled="true" onclick="void 0">ARIA disabled target</div>
      <div inert><div id="inert-click" aria-label="Inert click target" onclick="void 0">Inert</div></div>
      <div id="transparent-click" aria-label="Transparent click target" style="opacity:0" onclick="void 0">Transparent</div>
      <div id="no-pointer-events" aria-label="No pointer events target" style="pointer-events:none" onclick="void 0">No pointer events</div>
      <input id="file-upload" type="file" aria-label="File upload">
      <div id="hostile-getter" aria-label="Hostile getter target">Hostile getter</div>
      <p id="getter-status">Getter untouched</p>
      <p id="output">Waiting</p>
    </main>
    <style>.pointer-click, button, a { cursor: pointer }</style>
    <script>
      const reactOuter = document.querySelector('#react-outer')
      reactOuter['__reactProps$fixture'] = { onClick: () => {} }
      reactOuter.addEventListener('click', () => {
        const clicks = Number(reactOuter.dataset.clicks || 0) + 1
        reactOuter.dataset.clicks = String(clicks)
        reactOuter.setAttribute('aria-label', 'React nested clicked ' + clicks)
      })
      const pointerClick = document.querySelector('#pointer-click')
      pointerClick.addEventListener('click', () => { pointerClick.setAttribute('aria-label', 'Pointer clicked') })
      const propertyClick = document.querySelector('#property-click')
      propertyClick.onclick = () => { propertyClick.setAttribute('aria-label', 'DOM property clicked') }
      const hostileGetter = document.querySelector('#hostile-getter')
      Object.defineProperty(hostileGetter, 'onclick', {
        configurable: true,
        get() {
          document.querySelector('#getter-status').textContent = 'Getter executed'
          return () => {}
        },
      })
    </script>`)
})

fixture.listen(0, '127.0.0.1')
await once(fixture, 'listening')
const { port } = fixture.address()
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-browser-integration-'))
const sandboxRoot = path.join(tempRoot, 'sandbox')
const manager = new BrowserSessionManager({
  sandboxRoot,
  userDataRoot: path.join(tempRoot, 'user-data'),
  operationTimeoutMs: 10_000,
  allowPrivateNetwork: true,
})

try {
  const opened = await manager.open({ url: `http://127.0.0.1:${port}/`, visible: false })
  assert.equal(opened.ok, true)
  assert.match(opened.session_id, /^bs_/)

  const first = await manager.inspect({ session_id: opened.session_id, screenshot: true })
  assert.equal(first.title, 'Browser fixture')
  assert.ok(first.elements.length >= 3)
  const input = first.elements.find(element => element.tag === 'input')
  const greet = first.elements.find(element => element.name === 'Greet')
  const link = first.elements.find(element => element.name === 'Continue')
  assert.ok(input?.ref && greet?.ref && link?.ref)
  const plainDiv = first.elements.find(element => element.name === 'Plain div expander')
  const reactRegion = first.elements.find(element => element.name === 'React nested region')
  const pointerTarget = first.elements.find(element => element.name === 'Pointer target')
  const propertyTarget = first.elements.find(element => element.name === 'DOM property target')
  const smallestTarget = first.elements.find(element => element.name === 'Smallest click target')
  assert.ok(plainDiv?.ref, 'ordinary div with an explicit click handler gets a ref')
  assert.ok(reactRegion?.ref, 'React-style handler props on a nested region get a ref')
  assert.ok(pointerTarget?.ref, 'cursor:pointer region gets a ref')
  assert.ok(propertyTarget?.ref, 'safely readable DOM property handler gets a ref')
  assert.ok(smallestTarget?.ref, 'smallest nested click target gets a ref')
  assert.equal(first.elements.some(element => element.name === 'Parent click target'), false)
  assert.equal(first.elements.some(element => element.name === 'Static container'), false)
  assert.equal(first.elements.some(element => element.name === 'Hidden click target'), false)
  assert.equal(first.elements.some(element => element.name === 'Disabled button'), false)
  assert.equal(first.elements.some(element => element.name === 'Disabled button child'), false)
  assert.equal(first.elements.some(element => element.name === 'Disabled fieldset child'), false)
  assert.equal(first.elements.some(element => element.name === 'ARIA disabled target'), false)
  assert.equal(first.elements.some(element => element.name === 'Inert click target'), false)
  assert.equal(first.elements.some(element => element.name === 'Transparent click target'), false)
  assert.equal(first.elements.some(element => element.name === 'No pointer events target'), false)
  assert.equal(first.elements.some(element => element.name === 'File upload'), false)
  assert.equal(first.elements.some(element => element.name === 'Hostile getter target'), false)
  assert.equal(greet.role, 'button')
  assert.equal(link.role, 'link')
  const password = first.elements.find(element => element.type === 'password')
  const checkbox = first.elements.find(element => element.type === 'checkbox')
  const radio = first.elements.find(element => element.type === 'radio')
  const inputButton = first.elements.find(element => element.type === 'button')
  assert.equal(password?.name, 'Password')
  assert.equal(checkbox?.role, 'checkbox')
  assert.equal(radio?.role, 'radio')
  assert.equal(inputButton?.role, 'button')
  assert.equal(inputButton?.name, 'Input action')
  assert.equal(JSON.stringify(first).includes('NEVER_EXPOSE_THIS_SECRET'), false)
  assert.equal(JSON.stringify(first).includes('SENSITIVE_BUTTON_VALUE'), false)
  assert.ok(first.screenshot_path.startsWith('screenshots/'))
  assert.equal(path.isAbsolute(first.screenshot_path), false)
  assert.equal(fs.existsSync(path.join(sandboxRoot, ...first.screenshot_path.split('/'))), true)

  await manager.act({ session_id: opened.session_id, action: 'fill', ref: input.ref, value: 'Bailongma' })
  await manager.act({ session_id: opened.session_id, action: 'click', ref: greet.ref })
  await manager.act({ session_id: opened.session_id, action: 'click', ref: plainDiv.ref })
  await manager.act({ session_id: opened.session_id, action: 'click', ref: reactRegion.ref })
  await manager.act({ session_id: opened.session_id, action: 'click', ref: pointerTarget.ref })
  await manager.act({ session_id: opened.session_id, action: 'click', ref: propertyTarget.ref })
  await manager.act({ session_id: opened.session_id, action: 'click', ref: smallestTarget.ref })
  const updated = await manager.inspect({ session_id: opened.session_id })
  assert.match(updated.text, /Hello Bailongma/)
  assert.match(updated.text, /Plain div expanded content/)
  const updatedReact = updated.elements.find(element => element.name === 'React nested clicked 1')
  assert.ok(updatedReact?.ref)
  assert.ok(updated.elements.find(element => element.name === 'Pointer clicked')?.ref)
  assert.ok(updated.elements.find(element => element.name === 'DOM property clicked')?.ref)
  assert.doesNotMatch(updated.text, /Getter executed/)
  assert.match(updated.text, /child/)
  assert.equal(updated.elements.find(element => element.tag === 'input').ref, input.ref)
  assert.ok(updated.elements.find(element => element.name === 'Dynamic')?.ref)
  assert.equal(new Set(updated.elements.map(element => element.ref)).size, updated.elements.length)

  await manager.act({ session_id: opened.session_id, action: 'click', ref: updatedReact.ref })
  const clickedAgain = await manager.inspect({ session_id: opened.session_id })
  assert.ok(clickedAgain.elements.find(element => element.name === 'React nested clicked 2')?.ref)

  const aborted = new AbortController()
  aborted.abort('integration cancellation')
  await assert.rejects(
    manager.inspect({ session_id: opened.session_id }, { signal: aborted.signal }),
    err => err.name === 'AbortError',
  )

  await manager.act({ session_id: opened.session_id, action: 'click', ref: link.ref })
  const navigated = await manager.inspect({ session_id: opened.session_id })
  assert.equal(navigated.title, 'Next page')
  assert.match(navigated.text, /Navigation complete/)
  await assert.rejects(
    manager.act({ session_id: opened.session_id, action: 'fill', ref: input.ref, value: 'stale' }),
    err => err.code === 'STALE_REF',
  )

  const createdTabs = await manager.tabs({
    session_id: opened.session_id,
    action: 'new',
    url: `http://127.0.0.1:${port}/`,
  })
  assert.equal(createdTabs.pages.length, 2)
  const createdPageId = createdTabs.active_page_id
  assert.notEqual(createdPageId, opened.page_id)
  const switchedTabs = await manager.tabs({ session_id: opened.session_id, action: 'switch', page_id: opened.page_id })
  assert.equal(switchedTabs.active_page_id, opened.page_id)
  const closedTabs = await manager.tabs({ session_id: opened.session_id, action: 'close', page_id: createdPageId })
  assert.equal(closedTabs.pages.length, 1)

  const tabs = await manager.tabs({ session_id: opened.session_id })
  assert.equal(tabs.pages.length, 1)
  assert.equal(tabs.active_page_id, opened.page_id)
  assert.equal((await manager.close({ session_id: opened.session_id })).closed, true)
  assert.equal(manager.size, 0)
  console.log('test-browser-session-integration passed')
} finally {
  await manager.shutdown()
  fixture.close()
  await once(fixture, 'close').catch(() => {})
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
