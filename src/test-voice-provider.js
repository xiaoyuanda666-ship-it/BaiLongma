import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

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
  assert.equal(getVoiceRuntimeConfig('aliyun').provider, 'aliyun', 'explicit runtime provider wins while settings autosave may still be in flight')
  assert.equal(getVoiceRuntimeConfig('aliyun').aliyunApiKey, 'sk-aliyunkeyplaceholder1234567890', 'explicit runtime provider reads its own credentials')

  setVoiceConfig({
    voiceProvider: 'volcengine',
    volcAsrApiKey: '12345678-1234-1234-1234-123456789abc',
    volcAsrResourceId: 'volc.seedasr.sauc.duration',
  })
  const volcRuntime = getVoiceRuntimeConfig('volcengine')
  assert.equal(volcRuntime.provider, 'volcengine', 'Volcengine ASR can be activated')
  assert.equal(volcRuntime.volcAsrApiKey, '12345678-1234-1234-1234-123456789abc', 'Volcengine runtime config includes the raw API key')
  assert.equal(volcRuntime.volcAsrResourceId, 'volc.seedasr.sauc.duration', 'Volcengine runtime config preserves the ASR 2.0 resource ID')
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf-8')).voice, undefined, 'Volcengine runtime config does not depend on the removed config.json voice block')

  // Exercise the real handshake callbacks with missing and stale window caches.
  const apiSource = fs.readFileSync(new URL('./api.js', import.meta.url), 'utf-8')
  const runtimeExpression = apiSource.match(/const rawCfg = (getVoiceRuntimeConfig\([^\n]+\))/)[1]
  for (const file of ['./ui/brain-ui/voice-core.js', '../voice-core.js']) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf-8')
    for (const socketName of ['ws', 'bargeinWs']) {
      const handler = source.split(`${socketName}.onopen = () => {`)[1].split(/\n\s*};/)[0]
      for (const cachedProvider of [null, 'aliyun', 'tencent']) {
        const messages = []
        const socket = { send: value => messages.push(JSON.parse(value)) }
        vm.runInNewContext(`(() => { ${handler}\n })()`, {
          [socketName]: socket, cloudWs: socket,
          VOICE_PROVIDER_KEY: 'bailongma-voice-provider',
          localStorage: { getItem: () => cachedProvider },
          getLang: () => 'zh-CN', setStatus() {},
          reconnectBuffer: [], bufferedChunks: [], lastInboundTs: 0,
        })
        assert.equal(messages[0].lang, 'zh')
        const runtime = vm.runInNewContext(runtimeExpression, {
          msg: messages[0], getVoiceRuntimeConfig,
        })
        assert.equal(runtime.provider, 'volcengine', `${file}: ${socketName} ignores cache ${cachedProvider}`)
        assert.equal(runtime.volcAsrApiKey, volcRuntime.volcAsrApiKey)
      }
    }
  }

  console.log('PASS voice provider aliases, persistence and voice orb routing')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
