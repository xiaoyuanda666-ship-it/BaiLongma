import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-voice-provider-'))
process.env.BAILONGMA_USER_DIR = tmp
process.env.BAILONGMA_RESOURCES_DIR = process.cwd()

try {
  const configFile = path.join(tmp, 'config.json')
  const voiceDir = path.join(tmp, 'voice')
  fs.writeFileSync(configFile, JSON.stringify({
    voice: {
      provider: 'macos-local',
      lang: 'zh-CN',
      macosRecognitionMode: 'auto',
    },
  }, null, 2))

  const {
    getVoiceConfig,
    getVoiceRuntimeConfig,
    normalizeVoiceProvider,
    setVoiceConfig,
  } = await import('./config.js')

  assert.equal(normalizeVoiceProvider('macos'), 'local', 'macos alias maps to local ASR')
  assert.equal(normalizeVoiceProvider('macos-local'), 'local', 'legacy macos-local alias maps to local ASR')
  assert.equal(normalizeVoiceProvider('doubao'), 'volcengine', 'doubao alias maps to volcengine ASR')
  assert.equal(normalizeVoiceProvider('iflytek'), 'xunfei', 'iflytek alias maps to xunfei ASR')
  assert.equal(normalizeVoiceProvider('unknown-provider'), 'aliyun', 'unknown ASR provider falls back to aliyun')

  assert.equal(getVoiceConfig().voiceProvider, 'local', 'legacy voice.provider is used when voiceProvider is absent')
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf-8')).voice, undefined, 'legacy voice block is removed from config.json')
  assert.equal(JSON.parse(fs.readFileSync(path.join(voiceDir, 'active.json'), 'utf-8')).provider, 'local', 'active voice provider is stored separately')
  assert.equal(JSON.parse(fs.readFileSync(path.join(voiceDir, 'local.json'), 'utf-8')).lang, 'zh-CN', 'local ASR options migrate to voice/local.json')
  assert.equal(getVoiceRuntimeConfig().provider, 'local', 'runtime voice config uses active provider')
  assert.equal(getVoiceRuntimeConfig().macosRecognitionMode, 'auto', 'runtime voice config merges active provider file')

  setVoiceConfig({ voiceProvider: 'macos' })
  assert.equal(getVoiceConfig().voiceProvider, 'local', 'saved ASR provider aliases are normalized')

  setVoiceConfig({ voiceProvider: 'unknown-provider' })
  assert.equal(getVoiceConfig().voiceProvider, 'local', 'invalid ASR provider keeps previous valid provider')

  setVoiceConfig({ voiceProvider: 'aliyun', aliyunApiKey: 'sk-aliyunkeyplaceholder1234567890' })
  assert.equal(getVoiceConfig().voiceProvider, 'aliyun', 'cloud ASR provider can be activated')
  assert.equal(getVoiceConfig().aliyunApiKey.configured, true, 'Aliyun ASR key is reported from voice/aliyun.json')
  assert.equal(getVoiceRuntimeConfig().provider, 'aliyun', 'runtime config switches to Aliyun provider')
  assert.equal(getVoiceRuntimeConfig().aliyunApiKey, 'sk-aliyunkeyplaceholder1234567890', 'runtime config includes Aliyun key')

  setVoiceConfig({ voiceProvider: 'tencent', tencentSecretId: 'sid-123' })
  assert.equal(getVoiceConfig().voiceProvider, 'tencent', 'Tencent ASR provider can be activated')
  assert.equal(JSON.parse(fs.readFileSync(path.join(voiceDir, 'aliyun.json'), 'utf-8')).aliyunApiKey, 'sk-aliyunkeyplaceholder1234567890', 'Aliyun ASR key survives provider switch')
  assert.equal(JSON.parse(fs.readFileSync(path.join(voiceDir, 'tencent.json'), 'utf-8')).tencentSecretId, 'sid-123', 'Tencent ASR key is stored in its own file')

  console.log('PASS voice provider aliases and legacy provider field')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
