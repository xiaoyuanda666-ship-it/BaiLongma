import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createPreparedActivationStore } from './api/activation-draft.js'
import { normalizeLLMApiFormat } from './llm-api-format.js'

const readSource = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))

// No config, database, real credentials or network are loaded by these tests.
let now = 1000
const store = createPreparedActivationStore({ now: () => now, ttlMs: 100 })
const draft = { provider: 'custom', apiKey: 'test-key', model: 'local-test', baseURL: 'http://localhost/v1', apiFormat: 'responses' }
const prepared = store.storePreparedActivation({ draft, info: { ...draft } })
assert.equal(store.getPreparedActivation(prepared.token, draft), prepared)
for (const [key, value] of Object.entries({ provider: 'openai', apiKey: 'other-key', model: 'other-model', baseURL: 'http://localhost/other', apiFormat: 'chat-completions' })) {
  assert.equal(store.getPreparedActivation(prepared.token, { ...draft, [key]: value }), null, `Changing ${key} requires fresh validation`)
}
assert.equal(store.getPreparedActivation('wrong-token', draft), null)
assert.equal(store.getPreparedActivation(prepared.token, { ...draft, apiKey: ' test-key ', baseURL: 'http://localhost/v1/' }), prepared)
now += 100
assert.equal(store.getPreparedActivation(prepared.token, draft), null)

// Legacy callers omit the format. Bind their token to the format actually tested,
// including a stored provider format that is different from the legacy default.
const legacyDraft = { ...draft, apiFormat: undefined }
const legacy = store.storePreparedActivation({ draft: legacyDraft, info: { ...draft, apiFormat: 'chat-completions' } })
assert.equal(store.getPreparedActivation(legacy.token, legacyDraft), legacy)
assert.equal(store.getPreparedActivation(legacy.token, { ...draft, apiFormat: 'responses' }), null)
assert.equal(store.getPreparedActivation(legacy.token, { ...draft, apiFormat: 'chat-completions' }), legacy)
assert.throws(() => store.getPreparedActivation(legacy.token, { ...draft, apiFormat: null }), /Unsupported LLM API format/)
store.clearPreparedActivation()
assert.equal(store.getPreparedActivation(legacy.token, legacyDraft), null)

// Execute the actual route bodies with boundary dependencies injected, so route
// coverage does not initialize the application's native database or connectors.
function loadRoute(relative, dependencies) {
  const source = readSource(relative)
    .replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*\n/gm, '')
    .replace(/export async function /g, 'async function ')
  return vm.createContext({
    console,
    readJsonBody: async request => request.body,
    jsonResponse: (response, status, body) => Object.assign(response, { status, body }),
    emitEvent: () => {},
    setStickyEvent: () => {},
    ...dependencies,
    source,
  })
}

const activationStore = createPreparedActivationStore()
const activationCalls = []
let commitCalls = 0
const activationRoute = loadRoute('./api/routes/activation.js', {
  getAgentName: () => 'Test Agent',
  validateAgentName: name => name || '',
  prepareLLMActivation: async body => ({ ...body, model: body.model || 'test-model', apiFormat: normalizeLLMApiFormat(body.apiFormat), models: [] }),
  activateLLM: async body => { activationCalls.push(plain(body)); return { ...body, apiFormat: normalizeLLMApiFormat(body.apiFormat) } },
  commitPreparedActivation: info => { commitCalls += 1; return info },
})
vm.runInContext(activationRoute.source, activationRoute)
async function activateRoute(path, body) {
  const response = {}
  assert.equal(await activationRoute.handleActivationRoutes({ method: 'POST', body }, response, new URL(`http://localhost${path}`), activationStore), true)
  assert.equal(response.status, 200)
  return plain(response.body)
}
const preparedResponse = await activateRoute('/activate/prepare', draft)
assert.equal(preparedResponse.apiFormat, 'responses')
assert.equal(preparedResponse.baseURL, draft.baseURL)
assert.equal('apiKey' in preparedResponse, false)
await activateRoute('/activate', { ...draft, preparedToken: preparedResponse.token })
assert.equal(commitCalls, 1)
assert.equal(activationCalls.length, 0)
const staleResponse = await activateRoute('/activate/prepare', draft)
await activateRoute('/activate', { ...draft, apiFormat: 'chat-completions', preparedToken: staleResponse.token })
assert.equal(commitCalls, 1)
assert.equal(activationCalls.at(-1).apiFormat, 'chat-completions')
const legacyResponse = await activateRoute('/activate/prepare', legacyDraft)
await activateRoute('/activate', { ...legacyDraft, preparedToken: legacyResponse.token })
assert.equal(commitCalls, 2)

const settingsCalls = []
const settingsRoute = loadRoute('./api/routes/settings.js', {
  saveLLMSettings: async body => { settingsCalls.push(plain(body)); return { model: 'test', apiFormat: normalizeLLMApiFormat(body.apiFormat) } },
  switchModel: model => ({ model }),
})
vm.runInContext(settingsRoute.source, settingsRoute)
for (const body of [{ apiFormat: 'chat-completions' }, { provider: 'custom', ...draft }, { model: 'legacy-model-only' }]) {
  const response = {}
  await settingsRoute.handleSettingsRoutes({ method: 'POST', body }, response, new URL('http://localhost/settings/model'))
  assert.equal(response.status, 200)
}
assert.equal(settingsCalls.length, 2)
assert.deepEqual(settingsCalls[0], { apiFormat: 'chat-completions' })
const invalidResponse = {}
await settingsRoute.handleSettingsRoutes({ method: 'POST', body: { apiFormat: null } }, invalidResponse, new URL('http://localhost/settings/model'))
assert.equal(invalidResponse.status, 400)

function makeElement(value = '') {
  const listeners = new Map()
  return {
    value, disabled: false, style: {}, textContent: '',
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(type, handler) { listeners.set(type, handler) },
    dispatch(type) { return listeners.get(type)?.({ type }) },
    focus() {}, setAttribute() {},
  }
}

// Drive the shipped activation script with fake DOM/fetch boundaries. In
// particular, an in-flight prepare result must not restore an obsolete token.
const html = readSource('../activation.html')
const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, makeElement()]))
elements.get('apiFormat').value = 'responses'
const browserRequests = []
let delayedPrepare = null
let delayNextPrepare = false
let nextToken = 0
const activationUi = vm.createContext({
  console, URLSearchParams,
  window: { location: { search: '', replace() {} } },
  sessionStorage: { setItem() {} },
  document: { getElementById: id => elements.get(id) },
  setTimeout: () => 1, clearTimeout() {},
  fetch: async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null
    browserRequests.push({ url, body })
    if (url === '/activate/prepare' && delayNextPrepare) {
      delayNextPrepare = false
      return new Promise(resolve => { delayedPrepare = resolve })
    }
    return { ok: true, json: async () => ({ ok: true, activated: false, provider: body?.provider, model: 'test-model', apiFormat: body?.apiFormat, token: `token-${++nextToken}` }) }
  },
})
const activationScript = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)][0][1]
vm.runInContext(activationScript.replace(/^\s*import [^\n]+\n/m, ''), activationUi)
elements.get('apiKey').value = 'test-official-key'
elements.get('apiFormat').value = 'chat-completions'
elements.get('apiFormat').dispatch('change')
await activationUi.prepareActivation()
assert.ok(activationUi.isPreparedForCurrentDraft())
assert.equal(browserRequests.at(-1).body.apiFormat, 'chat-completions')

elements.get('apiFormat').value = 'responses'
elements.get('apiFormat').dispatch('change')
assert.equal(activationUi.isPreparedForCurrentDraft(), false)
delayNextPrepare = true
const inFlight = activationUi.prepareActivation()
elements.get('apiFormat').value = 'chat-completions'
elements.get('apiFormat').dispatch('change')
delayedPrepare({ ok: true, json: async () => ({ ok: true, token: 'obsolete-responses-token', apiFormat: 'responses' }) })
assert.equal(await inFlight, null)
assert.equal(activationUi.isPreparedForCurrentDraft(), false)
await activationUi.prepareActivation()
await activationUi.activate()
const officialBody = browserRequests.filter(request => request.url === '/activate').at(-1).body
assert.equal(officialBody.apiFormat, 'chat-completions')
assert.notEqual(officialBody.preparedToken, 'obsolete-responses-token')
elements.get('customBaseUrl').value = 'http://localhost/v1'
elements.get('customModel').value = 'local-test'
elements.get('apiFormat').value = 'responses'
await activationUi.activateCustom()
assert.deepEqual(browserRequests.at(-1).body, { provider: 'custom', baseURL: 'http://localhost/v1', model: 'local-test', apiKey: 'none', apiFormat: 'responses', agentName: '' })

// Exercise the actual provider-population and autosave functions independently
// of unrelated audio, social and update controls in the settings panel.
const settingsSource = readSource('./ui/brain-ui/settings.js')
const settingElements = new Map(['settings-custom-llm-section', 'settings-model-row', 'settings-official-custom-model-row', 'settings-custom-baseurl', 'settings-custom-model'].map(id => [id, makeElement()]))
const providerSelect = makeElement('custom')
const apiFormatSelect = makeElement('responses')
const llmKeyInput = makeElement()
const thinkingToggle = makeElement()
const thinkingHint = makeElement()
const uiRequests = []
const settingsUi = vm.createContext({
  document: { getElementById: id => settingElements.get(id) },
  cachedProviders: {
    custom: { apiFormat: 'chat-completions', baseURL: 'http://localhost/v1', model: 'local-test', apiKey: 'custom-test-key', reasoningControl: 'effort' },
    openai: { apiFormat: 'responses', model: 'official-test', apiKey: 'official-test-key', models: [] },
  },
  cachedLlm: null, cachedMinimax: {}, providerSelect, apiFormatSelect, llmKeyInput,
  customReasoningSelect: makeElement('effort'),
  thinkingToggle, thinkingHint, t: key => key,
  modelSelect: makeElement('official-test'), officialCustomModelInput: makeElement(), llmFeedback: {},
  CUSTOM_MODEL_VALUE: '__custom_model__', API: '',
  populateModelSelect() {}, setLlmKeyVisible() {}, refreshConfigSummary() {}, refreshProviderModels() {},
  createSettingsAutosave: callback => ({ save: callback }),
  fetch: async (_url, options) => {
    const body = JSON.parse(options.body)
    uiRequests.push(body)
    return { ok: true, json: async () => ({ ok: true, ...body }) }
  },
})
vm.runInContext(settingsSource.slice(settingsSource.indexOf('  function getProviderConfigForUI('), settingsSource.indexOf('  async function loadSettings()')), settingsUi)
vm.runInContext(settingsSource.slice(settingsSource.indexOf('  const llmAutosave = '), settingsSource.indexOf('  bindDebouncedAutosave([\n    llmKeyInput,')), settingsUi)
settingsUi.applyCustomProviderUI('custom')
assert.equal(apiFormatSelect.value, 'chat-completions')
apiFormatSelect.value = 'responses'
await vm.runInContext('llmAutosave.save()', settingsUi)
assert.equal(uiRequests.at(-1).apiFormat, 'responses')
assert.equal('apiKey' in uiRequests.at(-1), false)
assert.equal(vm.runInContext('cachedProviders.custom.apiFormat', settingsUi), 'responses')
assert.equal(thinkingToggle.disabled, false)
settingsUi.applyCustomProviderUI('openai')
assert.equal(apiFormatSelect.value, 'responses')
providerSelect.value = 'openai'
apiFormatSelect.value = 'chat-completions'
await vm.runInContext('llmAutosave.save()', settingsUi)
assert.equal(thinkingToggle.disabled, true)
assert.equal(thinkingHint.textContent, 'settings.chatThinkingHint')
settingsUi.applyCustomProviderUI('custom')
assert.equal(apiFormatSelect.value, 'responses')
assert.equal(thinkingToggle.disabled, true, 'Unsaved provider drafts do not change the active reasoning controls')
settingsUi.applyCustomProviderUI('openai')
assert.equal(apiFormatSelect.value, 'chat-completions')

console.log('API format routes, prepared activation, activation UI and settings UI tests passed')
