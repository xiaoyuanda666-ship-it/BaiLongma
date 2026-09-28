import assert from 'node:assert/strict'

const original = { window: globalThis.window, localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage, setInterval: globalThis.setInterval }
let count = 0
async function fixture({ hostname = '192.168.1.5', stored = '', hash = '#token=pairing-secret', ok = true } = {}) {
  const calls = [], events = {}, notices = []
  const storage = new Map(stored ? [['bailongma-api-token', stored]] : [])
  const localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }
  const location = new URL(`http://${hostname}:3721/brain-ui${hash}`)
  let interval
  globalThis.localStorage = localStorage
  globalThis.sessionStorage = localStorage
  globalThis.setInterval = (fn, ms) => { interval = { fn, ms }; return { unref() {} } }
  globalThis.window = {
    location,
    history: { replaceState(_state, _title, url) { calls.push({ cleanUrl: url }) } },
    document: { body: { appendChild: node => notices.push(node) }, getElementById: () => null, createElement: () => ({ setAttribute() {}, style: {} }) },
    addEventListener: (name, handler) => { events[name] = handler },
    fetch: async (url, init) => { calls.push({ url, init }); return { ok } },
  }
  await import(`./ui/brain-ui/api-client.js?test-session=${++count}`)
  return { calls, interval, events, notices, storage }
}
try {
  const paired = await fixture()
  assert.equal(paired.storage.get('bailongma-api-token'), 'pairing-secret')
  assert.equal(paired.calls[0].cleanUrl, '/brain-ui')
  assert.equal(paired.calls[1].url, 'http://192.168.1.5:3721/auth/session')
  assert.equal(paired.calls[1].init.headers.get('Authorization'), 'Bearer pairing-secret')
  assert.equal(paired.interval.ms, 4 * 3600000)
  await paired.interval.fn()
  await paired.events.focus()
  await paired.events.online()
  assert.equal(paired.calls.filter(call => call.url).length, 4)
  const local = await fixture({ hostname: '127.0.0.1', hash: '', stored: 'stale', ok: false })
  assert.equal(local.notices.length, 0)
  const invalid = await fixture({ ok: false })
  assert.equal(invalid.notices.length, 1)
  assert.match(invalid.notices[0].textContent, /连接口令无效/)
  console.log('PASS fragment pairing precedes module startup, recurring/focus/online renewal, local stale token and remote error notice')
} finally {
  Object.assign(globalThis, original)
}
