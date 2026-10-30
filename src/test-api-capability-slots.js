// API capability slot tests.
//
// Run: node src/test-api-capability-slots.js

import fs from 'fs'
import path from 'path'
import {
  KIMI_VISION_SLOT_ID,
  configureApiCapabilitySlot,
  deleteApiCapabilitySlot,
  findConfiguredApiSlotByKind,
  getApiCapabilityCredential,
  listApiCapabilitySlots,
  listApiSlotCapabilities,
  saveKimiVisionDocs,
} from './capabilities/api-slots.js'
import { execAnalyzeImage, execManageApiCapability } from './capabilities/tools/api-capability.js'
import { execRunApiCapability } from './capabilities/tools/api-capability.js'
import { capabilityContextBlocks, capabilityToolsFor, findCapabilitiesByQuery } from './capabilities/capability-registry.js'
import { paths } from './paths.js'
import { tryAutoConfigureKey } from './key-auto-config.js'

let failed = 0
function assert(cond, label, detail = '') {
  if (!cond) {
    console.error(`FAIL: ${label}${detail ? `\n  ${detail}` : ''}`)
    failed++
    process.exitCode = 1
  } else {
    console.log(`PASS: ${label}`)
  }
}

const backupExists = fs.existsSync(paths.apiCapabilitySlotsFile)
const backup = backupExists ? fs.readFileSync(paths.apiCapabilitySlotsFile, 'utf-8') : ''
const secretsBackupExists = fs.existsSync(paths.apiCapabilitySecretsFile)
const secretsBackup = secretsBackupExists ? fs.readFileSync(paths.apiCapabilitySecretsFile, 'utf-8') : ''
const secretKeyBackupExists = fs.existsSync(paths.apiCapabilitySecretKeyFile)
const secretKeyBackup = secretKeyBackupExists ? fs.readFileSync(paths.apiCapabilitySecretKeyFile, 'utf-8') : ''
const runnerDir = path.join(paths.sandboxApiCapabilitiesDir, `test-runner-${Date.now().toString(36)}`)

function restore() {
  if (backupExists) fs.writeFileSync(paths.apiCapabilitySlotsFile, backup, 'utf-8')
  else fs.rmSync(paths.apiCapabilitySlotsFile, { force: true })
  if (secretsBackupExists) fs.writeFileSync(paths.apiCapabilitySecretsFile, secretsBackup, 'utf-8')
  else fs.rmSync(paths.apiCapabilitySecretsFile, { force: true })
  if (secretKeyBackupExists) fs.writeFileSync(paths.apiCapabilitySecretKeyFile, secretKeyBackup, 'utf-8')
  else fs.rmSync(paths.apiCapabilitySecretKeyFile, { force: true })
  fs.rmSync(runnerDir, { recursive: true, force: true })
}

function parseJson(value) {
  try { return JSON.parse(String(value || '')) } catch { return null }
}

try {
  fs.rmSync(paths.apiCapabilitySlotsFile, { force: true })
  fs.rmSync(paths.apiCapabilitySecretsFile, { force: true })
  fs.rmSync(paths.apiCapabilitySecretKeyFile, { force: true })
  fs.mkdirSync(runnerDir, { recursive: true })
  const runnerPath = path.join(runnerDir, 'run.mjs')
  fs.writeFileSync(runnerPath, `
let input = ''
process.stdin.on('data', d => { input += d })
process.stdin.on('end', () => {
  const payload = JSON.parse(input || '{}')
  console.log(JSON.stringify({
    ok: true,
    saw_api_key: Boolean(process.env.CAPABILITY_API_KEY),
    echoed_api_key: process.env.CAPABILITY_API_KEY,
    slot_id: payload.slot.id,
    provider: payload.slot.provider,
    args: payload.args,
    output: { type: 'video', url: 'https://example.test/generated.mp4' },
  }))
})
`, 'utf-8')
  const relProgramPath = path.relative(paths.sandboxApiCapabilitiesDir, runnerPath).replace(/\\/g, '/')

  const docs = `
Moonshot / Kimi vision API docs
Endpoint: POST https://api.moonshot.cn/v1/chat/completions
Model: moonshot-v1-32k-vision-preview
Use messages content array with {type:"text"} and {type:"image_url", image_url:{url:"data:image/png;base64,..."}}
Example key: sk-xxxxxxxxxxxxxxxxxxxxxxxx
`

  {
    const slot = saveKimiVisionDocs({ docsText: docs, docsUrl: 'https://platform.moonshot.cn/docs/vision' })
    assert(slot?.id === KIMI_VISION_SLOT_ID, 'docs are saved into the Kimi vision slot', JSON.stringify(slot))
    assert(slot.configured === false, 'docs alone do not configure the slot')
    assert(slot.docs.url === 'https://platform.moonshot.cn/docs/vision', 'docs URL is stored')
    assert(!JSON.stringify(slot).includes('sk-xxxxxxxx'), 'stored docs redact placeholder key')
  }

  {
    const auto = await tryAutoConfigureKey('kimi 识图 sk-liveGenericCapabilityKeyForChecks1234567890', docs)
    assert(auto === null, 'Kimi vision key is not configured by regex/key-auto-config')
  }

  {
    const videoSlotId = 'video.fakegen'
    const configuredResult = parseJson(execManageApiCapability({
      action: 'configure',
      slot_id: videoSlotId,
      provider: 'fakegen',
      kind: 'video_generation',
      label: 'FakeGen 视频生成',
      summary: 'Test video generator capability.',
      docs_url: 'https://docs.example.test/video-generation',
      docs_summary: 'Submit prompt and receive a generated video URL.',
      docs,
      api_key: 'sk-liveGenericCapabilityKeyForChecks1234567890',
      model: 'video-model-test',
      base_url: 'https://api.example.test/v1',
      execution_instructions: 'Call this when the user asks to generate a video. Pass { prompt }.',
      program_path: relProgramPath,
      program_runtime: 'node',
      input_schema: {
        type: 'object',
        properties: { prompt: { type: 'string' } },
        required: ['prompt'],
      },
      output_schema: {
        type: 'object',
        properties: { output: { type: 'object' } },
      },
      test_results: [{ name: 'runner smoke', ok: true, detail: 'stdout JSON returned ok=true' }],
      triggers: ['生成视频', 'video generation'],
    }))
    assert(configuredResult?.ok === true && configuredResult.slot?.id === videoSlotId,
      'explicit configure action registers a generic video capability by agent intent',
      JSON.stringify(configuredResult))
    const slots = listApiCapabilitySlots()
    const slot = slots.find(s => s.id === videoSlotId)
    assert(slot?.configured === true, 'public slot reports configured')
    assert(slot?.api?.apiKey === '[configured]', 'public slot redacts API key')
    assert(slot?.program?.path === relProgramPath, 'public slot records tested runner path')
    assert(!JSON.stringify(configuredResult).includes('sk-liveGeneric'), 'configure result does not echo API key')
    const nonPublicSlot = listApiCapabilitySlots({ includeSecrets: true }).find(s => s.id === videoSlotId)
    assert(nonPublicSlot?.api?.apiKey === '', 'slot objects never expose API key even on includeSecrets reads')
    assert(getApiCapabilityCredential(slot) === 'sk-liveGenericCapabilityKeyForChecks1234567890', 'executor can resolve credential by reference')
    const slotFileText = fs.readFileSync(paths.apiCapabilitySlotsFile, 'utf-8')
    const secretFileText = fs.readFileSync(paths.apiCapabilitySecretsFile, 'utf-8')
    assert(!slotFileText.includes('sk-liveGenericCapabilityKeyForChecks1234567890'), 'slot file does not store API key plaintext')
    assert(slotFileText.includes('credentialRef'), 'slot file stores a credential reference')
    assert(!secretFileText.includes('sk-liveGenericCapabilityKeyForChecks1234567890'), 'secret store does not store API key plaintext')

    const tools = capabilityToolsFor({ rawText: '帮我生成视频', text: '帮我生成视频' })
    assert(tools.includes('run_capability'), `video intent injects run_capability (got: ${tools.join(',')})`)
    const blocks = capabilityContextBlocks({ rawText: '生成视频', text: '生成视频' })
    const block = blocks.find(b => b.includes('video.fakegen')) || ''
    assert(block.includes('https://docs.example.test/video-generation'), 'capability card injects docs URL')
    assert(block.includes(relProgramPath), 'capability card injects runner path')
    assert(!block.includes('Example key:'), 'capability card does not inject full docs text')

    const run = parseJson(await execRunApiCapability({
      slot_id: videoSlotId,
      args: { prompt: 'a dragon over a city' },
    }))
    assert(run?.ok === true && run.result?.output?.type === 'video', 'run_capability executes the registered runner', JSON.stringify(run))
    assert(run.result?.saw_api_key === true, 'runner receives credential through environment')
    assert(run.result?.echoed_api_key === '[redacted]', 'runner stdout cannot echo API key back into tool result')
    assert(!JSON.stringify(run).includes('sk-liveGenericCapabilityKeyForChecks1234567890'), 'run result does not contain API key plaintext')
  }

  {
    const localSlotId = 'local.wordcount'
    const configuredResult = parseJson(execManageApiCapability({
      action: 'configure',
      slot_id: localSlotId,
      provider: 'local',
      kind: 'text_utility',
      label: 'Local Word Counter',
      summary: 'Counts characters locally without an API key.',
      auth_type: 'none',
      protocol: 'local-program',
      execution_instructions: 'Call this when the user asks to count text locally. Pass { prompt }.',
      program_path: relProgramPath,
      program_runtime: 'node',
      input_schema: {
        type: 'object',
        properties: { prompt: { type: 'string' } },
        required: ['prompt'],
      },
      output_schema: {
        type: 'object',
        properties: { output: { type: 'object' } },
      },
      test_results: [{ name: 'local runner smoke', ok: true, detail: 'stdout JSON returned ok=true without credentials' }],
      triggers: ['local word count', '本地计数'],
    }))
    assert(configuredResult?.ok === true && configuredResult.slot?.id === localSlotId,
      'configure action registers a pure local runner capability without api_key',
      JSON.stringify(configuredResult))
    const localSlot = listApiCapabilitySlots().find(s => s.id === localSlotId)
    assert(localSlot?.configured === true, 'local runner slot reports configured')
    assert(localSlot?.api?.authType === 'none' && localSlot?.api?.credentialRequired === false, 'local runner slot declares no credential requirement')
    assert(localSlot?.api?.apiKey === '', 'local runner slot does not show an API key placeholder')
    assert(getApiCapabilityCredential(localSlot) === '', 'local runner slot has no credential to resolve')

    const tools = capabilityToolsFor({ rawText: '请本地计数', text: '请本地计数' })
    assert(tools.includes('run_capability'), `local intent injects run_capability (got: ${tools.join(',')})`)
    const blocks = capabilityContextBlocks({ rawText: '本地计数', text: '本地计数' })
    const block = blocks.find(b => b.includes(localSlotId)) || ''
    assert(block.includes('Auth type: none'), 'local capability card declares auth_type none')
    assert(block.includes('Credential: none required'), 'local capability card says no credential is required')

    const run = parseJson(await execRunApiCapability({
      slot_id: localSlotId,
      args: { prompt: 'count me locally' },
    }))
    assert(run?.ok === true && run.result?.output?.type === 'video', 'local runner capability executes without credentials', JSON.stringify(run))
    assert(run.result?.saw_api_key === false, 'local runner receives no API key environment value')
  }

  {
    const localSlotId = 'local.accidental-key'
    const configuredResult = parseJson(execManageApiCapability({
      action: 'configure',
      slot_id: localSlotId,
      provider: 'local',
      kind: 'text_utility',
      label: 'Local Accidental Key',
      auth_type: 'none',
      protocol: 'local-program',
      api_key: 'sk-shouldNotPersistForLocalCapability1234567890',
      execution_instructions: 'Call this local runner without credentials.',
      program_path: relProgramPath,
      program_runtime: 'node',
      test_results: [{ name: 'local runner smoke', ok: true }],
      triggers: ['local accidental key'],
    }))
    assert(configuredResult?.ok === true && configuredResult.slot?.api?.credentialRequired === false,
      'local runner ignores accidental api_key and stays credential-free',
      JSON.stringify(configuredResult))
    assert(getApiCapabilityCredential(localSlotId) === '', 'local runner with accidental api_key has no credential to resolve')
    const secretFileText = fs.existsSync(paths.apiCapabilitySecretsFile)
      ? fs.readFileSync(paths.apiCapabilitySecretsFile, 'utf-8')
      : ''
    assert(!secretFileText.includes('api-capability:local.accidental-key:apiKey'), 'local runner with accidental api_key does not create a secret ref')
    assert(!secretFileText.includes('sk-shouldNotPersistForLocalCapability1234567890'), 'local runner accidental api_key is not stored plaintext')
  }

  {
    const legacySlotId = 'video.legacysecret'
    const current = JSON.parse(fs.readFileSync(paths.apiCapabilitySlotsFile, 'utf-8'))
    current.version = 1
    current.slots.push({
      id: legacySlotId,
      kind: 'video_generation',
      provider: 'legacy',
      label: 'Legacy plaintext slot',
      api: {
        apiKey: 'sk-legacyPlaintextSlotKey1234567890',
        model: 'legacy-video-model',
        baseURL: 'https://legacy.example.test/v1',
      },
      program: { path: relProgramPath, runtime: 'node' },
    })
    fs.writeFileSync(paths.apiCapabilitySlotsFile, JSON.stringify(current, null, 2), 'utf-8')
    const migrated = listApiCapabilitySlots({ includeSecrets: true }).find(s => s.id === legacySlotId)
    assert(migrated?.api?.apiKey === '', 'legacy migrated slot object does not expose API key')
    assert(getApiCapabilityCredential(migrated) === 'sk-legacyPlaintextSlotKey1234567890', 'legacy plaintext slot key remains available to executor after migration')
    const migratedText = fs.readFileSync(paths.apiCapabilitySlotsFile, 'utf-8')
    assert(!migratedText.includes('sk-legacyPlaintextSlotKey1234567890'), 'legacy plaintext key is removed from slot file during migration')
    deleteApiCapabilitySlot(legacySlotId)
  }

  {
    const tools = capabilityToolsFor({ rawText: '帮我看这张图里有什么', text: '帮我看这张图里有什么' })
    assert(!tools.includes('analyze_image') && !tools.includes('run_capability'), `unconfigured vision slot is not injected (got: ${tools.join(',')})`)
    const blocks = capabilityContextBlocks({ rawText: '这张图识别一下', text: '这张图识别一下' })
    assert(!blocks.some(b => b.includes('vision.kimi')), 'docs-only vision slot does not inject workflow block')
    assert(findCapabilitiesByQuery('生成视频').some(c => c.tools.includes('run_capability')), 'find_tool discovery can find dynamic generic capability')
  }

  {
    deleteApiCapabilitySlot('vision.intentcheck')
    configureApiCapabilitySlot({
      slotId: 'vision.intentcheck',
      provider: 'intentcheck',
      kind: 'vision',
      authType: 'none',
      credentialRequired: false,
      programPath: relProgramPath,
      model: 'intentcheck-vision',
    })
    const plainMentionTools = capabilityToolsFor({
      rawText: '这个问题和截图关键词有关',
      text: '这个问题和截图关键词有关',
    })
    assert(!plainMentionTools.includes('run_capability'),
      `plain 截图 mention does not inject vision capability (got: ${plainMentionTools.join(',')})`)
    const explicitVisionTools = capabilityToolsFor({
      rawText: '帮我看截图里有什么',
      text: '帮我看截图里有什么',
    })
    assert(explicitVisionTools.includes('run_capability'),
      `explicit screenshot contents intent injects vision capability (got: ${explicitVisionTools.join(',')})`)
    deleteApiCapabilitySlot('vision.intentcheck')
  }

  {
    deleteApiCapabilitySlot('vision.acme')
    const current = JSON.parse(fs.readFileSync(paths.apiCapabilitySlotsFile, 'utf-8'))
    current.slots.push({
      id: 'image_vision.acme',
      kind: 'image_vision',
      provider: 'acme',
      label: 'Legacy Acme image vision',
      enabled: true,
      api: {
        apiKey: 'sk-legacyImageVisionAliasKey1234567890',
        baseURL: 'https://api.example.test/v1',
        endpoint: '/chat/completions',
        model: 'acme-vision-model',
      },
    })
    fs.writeFileSync(paths.apiCapabilitySlotsFile, JSON.stringify(current, null, 2), 'utf-8')
    const legacyVision = findConfiguredApiSlotByKind('vision')
    assert(legacyVision?.id === 'vision.acme', 'legacy image_vision.<provider> slot is canonicalized and discoverable as vision')
    assert(legacyVision?.kind === 'vision', 'legacy image_vision kind is normalized to vision')
    assert(getApiCapabilityCredential(legacyVision) === 'sk-legacyImageVisionAliasKey1234567890', 'legacy image_vision inline key migrates into credential store')
    deleteApiCapabilitySlot('image_vision.acme')
  }

  {
    const configured = configureApiCapabilitySlot({
      provider: 'acme',
      kind: 'image_vision',
      apiKey: 'sk-canonicalVisionAliasKey1234567890',
      model: 'acme-vision-model',
      baseURL: 'https://api.example.test/v1',
    })
    assert(configured.id === 'vision.acme', 'image_vision configure canonicalizes to vision.<provider>')
    assert(configured.kind === 'vision', 'image_vision configure stores kind=vision')
    deleteApiCapabilitySlot('vision.acme')
  }

  {
    const configured = configureApiCapabilitySlot({
      slotId: 'acme.vision',
      kind: 'image_vision',
      apiKey: 'sk-reversedVisionSlotIdKey1234567890',
      model: 'acme-vision-model',
      baseURL: 'https://api.example.test/v1',
    })
    assert(configured.id === 'vision.acme', 'provider.kind slot ids canonicalize to vision.<provider>')
    assert(configured.provider === 'acme', 'provider is inferred from provider.kind slot id when omitted')
    deleteApiCapabilitySlot('vision.acme')
  }

  {
    const originalFetch = globalThis.fetch
    const captured = []
    globalThis.fetch = async (_url, options = {}) => {
      captured.push(JSON.parse(String(options.body || '{}')))
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ choices: [{ message: { content: 'mock vision result' } }] })
        },
      }
    }
    try {
      configureApiCapabilitySlot({
        slotId: 'vision.moonshot',
        provider: 'moonshot',
        kind: 'vision',
        apiKey: 'sk-moonshotVisionTemperatureCheck1234567890',
        model: 'kimi-k2.6',
        baseURL: 'https://api.moonshot.cn/v1',
      })
      const moonshotResult = parseJson(await execAnalyzeImage({
        slot_id: 'vision.moonshot',
        image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC',
        prompt: 'describe',
      }))
      assert(moonshotResult?.ok === true, 'mocked Moonshot analyze_image succeeds', JSON.stringify(moonshotResult))
      assert(captured.at(-1)?.temperature === 1, 'Moonshot/Kimi vision uses temperature=1')

      configureApiCapabilitySlot({
        slotId: 'vision.acme',
        provider: 'acme',
        kind: 'vision',
        apiKey: 'sk-acmeVisionTemperatureCheck1234567890',
        model: 'acme-vision-model',
        baseURL: 'https://api.example.test/v1',
      })
      const acmeResult = parseJson(await execAnalyzeImage({
        slot_id: 'vision.acme',
        image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC',
        prompt: 'describe',
      }))
      assert(acmeResult?.ok === true, 'mocked generic analyze_image succeeds', JSON.stringify(acmeResult))
      assert(captured.at(-1)?.temperature === 0.2, 'generic OpenAI-compatible vision keeps low temperature')
    } finally {
      globalThis.fetch = originalFetch
      deleteApiCapabilitySlot('vision.moonshot')
      deleteApiCapabilitySlot('vision.acme')
    }
  }

  {
    deleteApiCapabilitySlot(KIMI_VISION_SLOT_ID)
    const configured = configureApiCapabilitySlot({
      slotId: KIMI_VISION_SLOT_ID,
      provider: 'kimi',
      kind: 'vision',
      apiKey: 'sk-directConfigForChecks1234567890',
      model: 'moonshot-v1-32k-vision-preview',
      baseURL: 'https://api.moonshot.cn/v1',
      programPath: relProgramPath,
    })
    assert(configured.configured === true, 'direct configure helper enables the slot')
    assert(!fs.readFileSync(paths.apiCapabilitySlotsFile, 'utf-8').includes('sk-directConfigForChecks1234567890'), 'direct configure helper does not write plaintext key to slot file')
    const caps = listApiSlotCapabilities()
    assert(caps.some(c => c.id === `api-slot:${KIMI_VISION_SLOT_ID}`), 'configured slot appears as a dynamic capability')
  }
} finally {
  restore()
}

if (failed === 0) console.log('\nAll api capability slot checks complete.')
else console.log(`\n${failed} check(s) failed.`)
