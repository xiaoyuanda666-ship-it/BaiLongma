import assert from 'assert/strict'

const stored = new Map()
const sessionStored = new Map()
let replacedUrl = ''
let lastFetch = null

globalThis.localStorage = {
  getItem: key => stored.get(key) || null,
  setItem: (key, value) => stored.set(key, String(value)),
  removeItem: key => stored.delete(key),
}
globalThis.sessionStorage = {
  getItem: key => sessionStored.get(key) || null,
  setItem: (key, value) => sessionStored.set(key, String(value)),
  removeItem: key => sessionStored.delete(key),
}
globalThis.window = {
  location: {
    protocol: 'https:',
    origin: 'https://192.168.1.20:3721',
    href: 'https://192.168.1.20:3721/brain-ui#token=lan-test-token',
  },
  history: {
    state: null,
    replaceState: (_state, _title, url) => { replacedUrl = url },
  },
  fetch: async (input, init) => {
    lastFetch = { input, init }
    return { ok: true }
  },
}

const client = await import(`./ui/brain-ui/api-client.js?test=${Date.now()}`)

assert.equal(client.API, 'https://192.168.1.20:3721')
assert.equal(client.getApiToken(), 'lan-test-token')
assert.equal(stored.get('bailongma-api-token'), 'lan-test-token')
assert.equal(replacedUrl, '/brain-ui')
assert.equal(client.apiWebSocketUrl('/voice/cloud'), 'wss://192.168.1.20:3721/voice/cloud')
assert.match(client.getUiClientId(), /^ui-/)
assert.equal(client.getUiClientId(), sessionStored.get('bailongma-ui-client-id'))
assert.equal(client.isUiClientTarget({ target_client_id: client.getUiClientId() }), true)
assert.equal(client.isUiClientTarget({ target_client_id: 'ui-other-client' }), false)
assert.equal(client.isUiClientTarget({}), true)
const stableClientId = client.getUiClientId()
globalThis.sessionStorage.getItem = () => { throw new Error('Safari storage temporarily unavailable') }
assert.equal(client.getUiClientId(), stableClientId, 'client id remains stable after initialization')

const protocols = client.apiWebSocketProtocols()
assert.equal(protocols[0], 'bailongma.v1')
assert.equal(
  Buffer.from(protocols[1].slice('bailongma.auth.'.length), 'base64url').toString('utf8'),
  'lan-test-token',
)

await globalThis.window.fetch('/settings/voice', {
  method: 'GET',
  headers: { Accept: 'application/json' },
})
assert.equal(lastFetch.input, '/settings/voice')
assert.equal(lastFetch.init.headers.get('Authorization'), 'Bearer lan-test-token')
assert.equal(lastFetch.init.headers.get('Accept'), 'application/json')
assert.equal(lastFetch.init.headers.get('X-Bailongma-Client-ID'), client.getUiClientId())

await globalThis.window.fetch('https://example.com/public')
assert.equal(new Headers(lastFetch.init?.headers || {}).has('Authorization'), false)
assert.equal(new Headers(lastFetch.init?.headers || {}).has('X-Bailongma-Client-ID'), false)

console.log('LAN API client tests passed')
