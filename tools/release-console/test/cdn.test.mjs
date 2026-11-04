import assert from 'node:assert/strict'
import test from 'node:test'
import { requestFollowingRedirects } from '../../../scripts/publish-updates-lib.mjs'
const source = 'https://bailongma.top/updates/stable/mac/arm64/Bailongma-2.2.156-mac-arm64.zip'
const target = 'https://download.bailongma.top/stable/mac/arm64/Bailongma-2.2.156-mac-arm64.zip'
test('CDN redirect preserves object and Range, strips updater header', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({url:String(url), ...options})
    return calls.length === 1 ? new Response(null, {status:302,headers:{location:target}}) : new Response('1234',{status:206})
  })
  const result = await requestFollowingRedirects(source, {headers:{Range:'bytes=0-3','X-Bailongma-Updater':'BailongmaUpdater/2'}, expectedFinalStatus:206,body:'none'})
  assert.equal(result.bytes.length,4)
  assert.equal(calls[1].url,target)
  assert.equal(calls[1].headers.Range,'bytes=0-3')
  assert.equal(calls[1].headers['X-Bailongma-Updater'],undefined)
})
test('redirects reject other hosts, HTTP, object substitution, credentials and feeds on CDN', async t => {
  for (const [url, location] of [
    [source,target.replace('download.bailongma.top','evil.example')],
    [source,target.replace('https:','http:')],
    [source,target.replace('2.2.156','2.2.157')],
    [source,target.replace('https://','https://user@')],
    [source,target+'?token=bad'],
    ['https://bailongma.top/updates/stable/mac/arm64/latest-mac.yml','https://download.bailongma.top/stable/mac/arm64/latest-mac.yml'],
  ]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => new Response(null,{status:302,headers:{location}}))
    await assert.rejects(requestFollowingRedirects(url,{expectedFinalStatus:200}), /unexpected host/)
    assert.equal(mock.mock.callCount(),1)
    mock.mock.restore()
  }
})
