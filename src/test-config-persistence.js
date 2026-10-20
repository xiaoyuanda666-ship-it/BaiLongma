import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-config-persistence-'))
process.env.BAILONGMA_USER_DIR = userDir
for (const key of [
  'DEEPSEEK_API_KEY', 'MINIMAX_API_KEY', 'OPENAI_API_KEY', 'DASHSCOPE_API_KEY',
  'MOONSHOT_API_KEY', 'ZHIPU_API_KEY', 'MIMO_API_KEY', 'BAILONGMA_API_TOKEN',
  'BAILONGMA_ALLOW_LAN', 'ARK_API_KEY', 'SEEDANCE_API_KEY', 'DISCORD_BOT_TOKEN',
]) delete process.env[key]
const mainFile = path.join(userDir, 'config.json')
const providerFile = path.join(userDir, 'llm', 'custom.json')
const originalRename = fs.renameSync
let revision = 0
after(() => {
  fs.renameSync = originalRename
  fs.rmSync(userDir, { recursive: true, force: true })
})

async function fresh(extra = {}) {
  for (const file of ['llm', 'voice', 'seedance.json']) {
    fs.rmSync(path.join(userDir, file), { recursive: true, force: true })
  }
  fs.writeFileSync(mainFile, JSON.stringify({
    schemaVersion: 4, temperature: 0.7, thinking: false,
    heartbeat: { enabled: true, defaultIntervalMinutes: 30 },
    security: { fileSandbox: true, execSandbox: true },
    network: { allowLanAccess: false, accessToken: '' },
    ...extra,
  }))
  return import(`./config.js?persistence=${++revision}`)
}

function failRename(file, operation) {
  fs.renameSync = (source, destination) => {
    if (String(destination) === file) throw new Error('simulated disk failure')
    return originalRename(source, destination)
  }
  try { assert.throws(operation, /simulated disk failure/) }
  finally { fs.renameSync = originalRename }
}

function activateCustom(mod, model = 'original-model') {
  return mod.commitPreparedActivation({
    provider: 'custom', model, apiKey: 'test-key-only',
    baseURL: 'http://127.0.0.1:11434/v1', apiFormat: 'responses',
  })
}

test('zero temperature and zero speech rate survive reload', async () => {
  const mod = await fresh()
  mod.setTemperature(0)
  mod.setTTSConfig({ doubaoSpeechRate: 0 })
  const reloaded = await import(`./config.js?persistence=${++revision}`)
  assert.equal(reloaded.config.temperature, 0)
  assert.equal(reloaded.getTTSCredentials().doubaoSpeechRate, 0)
})

for (const [name, update] of [
  ['temperature', mod => mod.setTemperature(1.5)],
  ['thinking', mod => mod.setThinking(true)],
  ['context window', mod => mod.setContextWindowConfig({ chatMessageLimit: 10, toolCallLimit: 2 })],
  ['heartbeat', mod => mod.setHeartbeatConfig({ enabled: false, defaultIntervalMinutes: 90 })],
  ['security', mod => mod.setSecurity({ fileSandbox: false, allowLanAccess: true })],
  ['network', mod => mod.setNetworkConfig({ allowLanAccess: true })],
  ['LAN token', mod => mod.getLanAccessToken({ ensure: true })],
]) {
  test(`${name}: failed save preserves runtime and persisted settings`, async () => {
    const mod = await fresh()
    const beforeRuntime = structuredClone(mod.config)
    const beforeFile = fs.readFileSync(mainFile, 'utf8')
    failRename(mainFile, () => update(mod))
    assert.deepEqual(mod.config, beforeRuntime)
    assert.equal(fs.readFileSync(mainFile, 'utf8'), beforeFile)
  })
}

test('security and LAN access are saved together and survive reload', async () => {
  const mod = await fresh()
  mod.setSecurity({ fileSandbox: false, allowLanAccess: true })
  const reloaded = await import(`./config.js?persistence=${++revision}`)
  assert.equal(reloaded.getSecurity().fileSandbox, false)
  assert.equal(reloaded.getNetworkConfig().allowLanAccess, true)
  assert.ok(reloaded.getLanAccessToken())
})

test('model switch failure preserves the active model', async () => {
  const mod = await fresh()
  activateCustom(mod)
  const before = structuredClone(mod.config)
  failRename(providerFile, () => mod.switchModel('new-model'))
  assert.deepEqual(mod.config, before)
})

test('activation failure rolls back provider file and runtime', async () => {
  const mod = await fresh()
  activateCustom(mod)
  const before = structuredClone(mod.config)
  const beforeFile = fs.readFileSync(providerFile, 'utf8')
  failRename(mainFile, () => activateCustom(mod, 'new-model'))
  assert.equal(fs.readFileSync(providerFile, 'utf8'), beforeFile)
  assert.deepEqual(mod.config, before)
  const reloaded = await import(`./config.js?persistence=${++revision}`)
  assert.equal(reloaded.config.model, before.model)
})

test('voice save failure rolls back provider, active selection and main file', async () => {
  const mod = await fresh()
  mod.setVoiceConfig({ voiceProvider: 'local', lang: 'zh-CN' })
  const activeFile = path.join(userDir, 'voice', 'active.json')
  const localFile = path.join(userDir, 'voice', 'local.json')
  const before = [mainFile, activeFile, localFile].map(file => fs.readFileSync(file, 'utf8'))
  failRename(mainFile, () => mod.setVoiceConfig({ voiceProvider: 'volcengine', lang: 'en-US' }))
  assert.deepEqual([mainFile, activeFile, localFile].map(file => fs.readFileSync(file, 'utf8')), before)
})

test('social credentials are cleared at runtime and change only after saving', async () => {
  const mod = await fresh()
  mod.setSocialConfig({ DISCORD_BOT_TOKEN: 'old-test-token' })
  failRename(mainFile, () => mod.setSocialConfig({ DISCORD_BOT_TOKEN: 'new-test-token' }))
  assert.equal(process.env.DISCORD_BOT_TOKEN, 'old-test-token')
  mod.setSocialConfig({ DISCORD_BOT_TOKEN: '' })
  assert.equal(process.env.DISCORD_BOT_TOKEN, undefined)
  assert.equal(mod.getSocialConfig().DISCORD_BOT_TOKEN.configured, false)
})

test('Seedance endpoint and model save when API key comes from environment', async () => {
  const mod = await fresh()
  process.env.ARK_API_KEY = 'env-test-key'
  try {
    mod.setSeedanceConfig({ model: 'custom-video-model', baseURL: 'https://video.example.test/v3' })
    assert.equal(mod.getSeedanceConfig().model, 'custom-video-model')
    assert.equal(mod.getSeedanceConfig().baseURL, 'https://video.example.test/v3')
  } finally { delete process.env.ARK_API_KEY }
})

test('deactivation preserves unrelated configuration and reports save failures', async () => {
  const mod = await fresh({ tts: { ttsVoiceId: 'saved-voice' } })
  activateCustom(mod)
  const before = structuredClone(mod.config)
  failRename(mainFile, () => mod.deactivate())
  assert.deepEqual(mod.config, before)
  mod.deactivate()
  const reloaded = await import(`./config.js?persistence=${++revision}`)
  assert.equal(reloaded.config.needsActivation, true)
  assert.equal(reloaded.config.temperature, 0.7)
  assert.equal(reloaded.getTTSConfig().ttsVoiceId, 'saved-voice')
})

test('saving refuses to overwrite damaged or non-object main configuration', async () => {
  const mod = await fresh()
  for (const text of ['{broken', '[]', 'null', '"invalid"']) {
    fs.writeFileSync(mainFile, text)
    assert.throws(() => mod.setThinking(true))
    assert.equal(fs.readFileSync(mainFile, 'utf8'), text)
    assert.equal(mod.config.thinking, false)
  }
})

test('redacted status objects cannot overwrite saved credentials', async () => {
  const mod = await fresh()
  mod.setSocialConfig({ DISCORD_BOT_TOKEN: 'test-social-token' })
  mod.setVoiceConfig({ voiceProvider: 'volcengine', volcAsrApiKey: 'test-voice-key' })
  mod.setTTSConfig({ openaiTtsKey: 'test-tts-key' })
  const beforeMain = fs.readFileSync(mainFile, 'utf8')
  const voiceFile = path.join(userDir, 'voice', 'volcengine.json')
  const beforeVoice = fs.readFileSync(voiceFile, 'utf8')
  assert.throws(() => mod.setSocialConfig(mod.getSocialConfig()), /status object/)
  assert.throws(() => mod.setVoiceConfig(mod.getVoiceConfig()), /status object/)
  assert.throws(() => mod.setTTSConfig(mod.getTTSConfig()), /status object/)
  assert.equal(fs.readFileSync(mainFile, 'utf8'), beforeMain)
  assert.equal(fs.readFileSync(voiceFile, 'utf8'), beforeVoice)
  assert.equal(process.env.DISCORD_BOT_TOKEN, 'test-social-token')
})

test('failed first activation removes new provider file and temporary files', async () => {
  const mod = await fresh()
  failRename(mainFile, () => activateCustom(mod))
  assert.equal(fs.existsSync(providerFile), false)
  assert.equal(mod.config.needsActivation, true)
  assert.deepEqual(fs.readdirSync(path.dirname(providerFile)), [])
  assert.equal(fs.readdirSync(userDir).some(file => file.endsWith('.tmp')), false)
})

test('partial updates preserve sibling sections across successful reloads', async () => {
  const mod = await fresh({
    social: { FEISHU_APP_ID: 'test-id', FEISHU_APP_SECRET: 'test-secret' },
    tts: { openaiTtsKey: 'saved-tts-key', ttsVoiceId: 'saved-voice' },
    embedding: { model: 'example/model', timeoutMs: 2400 },
    unrelated: { keep: true },
  })
  mod.setSocialConfig({ FEISHU_APP_ID: 'updated-id' })
  mod.setTTSConfig({ doubaoSpeechRate: 0 })
  mod.setTemperature(0)
  mod.setVoiceConfig({ voiceProvider: 'local', lang: 'en-US' })
  activateCustom(mod)
  const reloaded = await import(`./config.js?persistence=${++revision}`)
  const stored = JSON.parse(fs.readFileSync(mainFile, 'utf8'))
  assert.deepEqual(stored.social, { FEISHU_APP_ID: 'updated-id', FEISHU_APP_SECRET: 'test-secret' })
  assert.deepEqual(stored.unrelated, { keep: true })
  assert.equal(reloaded.getTTSCredentials().openaiKey, 'saved-tts-key')
  assert.equal(reloaded.getTTSCredentials().voiceId, 'saved-voice')
  assert.equal(reloaded.getEmbeddingConfig().timeoutMs, 2400)
  assert.equal(reloaded.getVoiceRuntimeConfig().lang, 'en-US')
  assert.equal(reloaded.config.temperature, 0)
  assert.equal(reloaded.config.model, 'original-model')
})
