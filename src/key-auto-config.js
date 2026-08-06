// 用户发送 API Key 时自动识别服务商、验证、写入配置
// 支持 TTS（豆包、MiniMax、OpenAI、ElevenLabs、火山）和 ASR（阿里云、腾讯、讯飞）
// 支持单条消息包含多个 key（如"百炼语音识别 sk-xxx 豆包语音发声 uuid-xxx"）
import { setVoiceConfig, setTTSConfig, setSeedanceConfig } from './config.js'
import { streamTTS } from './voice/tts-providers.js'
import { DEFAULT_DOUBAO_SPEECH_RATE, DEFAULT_DOUBAO_VOICE_ID } from './voice/tts-defaults.js'

// 提取文本中所有候选 key 字符串（20~120 字符的字母数字 token）
function extractCandidateKeys(text) {
  const seen = new Set()
  const results = []
  const re = /[A-Za-z0-9\-_\.]{20,120}/g
  let m
  while ((m = re.exec(text)) !== null) {
    if (!seen.has(m[0])) { seen.add(m[0]); results.push({ key: m[0], index: m.index }) }
  }
  return results
}

// 判断消息是否"纯 key"（整条消息几乎只有 key 本身）
function isKeyOnlyMessage(text) {
  return /^[\s\n]*[A-Za-z0-9\-_\.]{20,120}[\s\n]*$/.test(text)
}

function isValidAliyunAsrKey(key) {
  return /^sk-[A-Za-z0-9_\-.]{20,}$/.test(String(key || '').trim())
}

const LLM_KEY_HINT_RE = /deepseek|deep\s*seek|openai|open\s*ai|chatgpt|gpt|qwen|通义|千问|moonshot|kimi|智谱|zhipu|claude|gemini|minimax|mini\s*max|mimo|小米|xiaomi/g

function hasCloserLlmKeyHint(text, providerPos, keyPos) {
  const segment = text.slice(providerPos, keyPos).toLowerCase()
  LLM_KEY_HINT_RE.lastIndex = 0
  return LLM_KEY_HINT_RE.test(segment)
}

// 所有服务商的检测规则（按出现在消息中的关键词位置匹配）
const PROVIDER_RULES = [
  // TTS
  {
    re: /doubao|豆包|方舟|ark[\s_\-]?api|volcengine.*tts|tts.*volcengine/,
    skip: /asr|识别/,
    service: 'tts', provider: 'doubao', label: '豆包 TTS',
    makeConfig: (key) => ({
      configUpdates: {
        ttsProvider: 'doubao',
        ttsVoiceId: DEFAULT_DOUBAO_VOICE_ID,
        doubaoSpeechRate: DEFAULT_DOUBAO_SPEECH_RATE,
        doubaoKey: key,
        doubaoResourceId: 'seed-tts-2.0',
      },
      streamKeys: { doubaoKey: key, doubaoResourceId: 'seed-tts-2.0' },
    }),
  },
  {
    re: /minimax|mini[\s_\-]?max/,
    skip: /asr|识别/,
    service: 'tts', provider: 'minimax', label: 'MiniMax TTS',
    makeConfig: (key) => ({
      configUpdates: { ttsProvider: 'minimax', minimaxKey: key },
      streamKeys: { minimaxKey: key },
    }),
  },
  {
    re: /eleven[\s_\-]?labs?|elevenlabs/,
    service: 'tts', provider: 'elevenlabs', label: 'ElevenLabs TTS',
    makeConfig: (key) => ({
      configUpdates: { ttsProvider: 'elevenlabs', elevenLabsKey: key },
      streamKeys: { elevenLabsKey: key },
    }),
  },
  {
    re: /(openai|open[\s_\-]?ai).*tts|tts.*(openai|open[\s_\-]?ai)/,
    service: 'tts', provider: 'openai', label: 'OpenAI TTS',
    makeConfig: (key) => ({
      configUpdates: { ttsProvider: 'openai', openaiTtsKey: key },
      streamKeys: { openaiKey: key },
    }),
  },
  {
    re: /volcano.*tts|tts.*volcano|火山.*(?:合成|语音)|(?:合成|语音).*火山/,
    skip: /asr|识别/,
    service: 'tts', provider: 'volcano', label: '火山引擎 TTS',
    makeConfig: (key, key2) => ({
      configUpdates: { ttsProvider: 'volcano', volcanoToken: key, ...(key2 ? { volcanoAppId: key2 } : {}) },
      streamKeys: { volcanoToken: key, volcanoAppId: key2 || '' },
    }),
  },
  // ASR
  {
    re: /aliyun|阿里云|百炼|dashscope|paraformer/,
    service: 'asr', provider: 'aliyun', label: '阿里云 ASR',
    makeConfig: (key) => ({ configUpdates: { voiceProvider: 'aliyun', aliyunApiKey: key } }),
  },
  {
    re: /tencent|腾讯.*(?:asr|识别)|(?:asr|识别).*腾讯|secret[\s_\-]?id/,
    service: 'asr', provider: 'tencent', label: '腾讯云 ASR',
    makeConfig: (key, key2) => ({
      configUpdates: { voiceProvider: 'tencent', tencentSecretId: key, ...(key2 ? { tencentSecretKey: key2 } : {}) },
    }),
  },
  {
    re: /xunfei|讯飞|iflytek/,
    service: 'asr', provider: 'xunfei', label: '讯飞 ASR',
    makeConfig: (key, key2) => ({
      configUpdates: { voiceProvider: 'xunfei', xunfeiAppId: key, ...(key2 ? { xunfeiApiKey: key2 } : {}) },
    }),
  },
  {
    re: /volcengine.*(?:asr|识别)|(?:asr|识别).*volcengine|火山.*(?:asr|识别)|(?:asr|识别).*火山|豆包.*(?:asr|识别)|(?:asr|识别).*豆包/,
    service: 'asr', provider: 'volcengine', label: '火山豆包 ASR',
    makeConfig: (key) => ({
      configUpdates: {
        voiceProvider: 'volcengine',
        volcAsrApiKey: key,
        volcAsrResourceId: 'volc.seedasr.sauc.duration',
      },
    }),
  },
]

// 从当前消息中识别所有 {provider, key} 对。
// 服务商关键词必须和 key 出现在同一条用户消息里，避免旧上下文把新的 LLM key 误归类为语音 key。
export function detectAllKeyInfos(currentText) {
  const t = currentText.toLowerCase()
  const allKeys = extractCandidateKeys(currentText)
  if (allKeys.length === 0) return []

  const results = []
  const usedKeyIndices = new Set()

  for (const rule of PROVIDER_RULES) {
    if (!rule.re.test(t)) continue
    if (rule.skip && rule.skip.test(t)) continue

    // 找关键词在文本中的位置
    const match = rule.re.exec(t)
    const rulePos = match ? match.index : 0

    // 取关键词位置之后最近的未用 key
    const nearestKey = allKeys
      .filter((k, i) => !usedKeyIndices.has(i) && k.index >= rulePos)
      .sort((a, b) => a.index - b.index)[0]

    if (!nearestKey) continue
    if (rule.provider === 'aliyun' && hasCloserLlmKeyHint(t, rulePos, nearestKey.index)) continue

    const keyIdx = allKeys.indexOf(nearestKey)
    usedKeyIndices.add(keyIdx)

    // 对于需要两个 key 的（腾讯、火山、讯飞），取下一个未用 key
    const nextKey = allKeys.filter((k, i) => !usedKeyIndices.has(i) && k.index > nearestKey.index)[0]
    const nextKeyIdx = nextKey ? allKeys.indexOf(nextKey) : -1
    const needsSecond = rule.provider === 'tencent' || rule.provider === 'volcano' || rule.provider === 'xunfei'
    if (needsSecond && nextKey) usedKeyIndices.add(nextKeyIdx)

    const config = rule.makeConfig(nearestKey.key, needsSecond && nextKey ? nextKey.key : undefined)
    results.push({ service: rule.service, provider: rule.provider, label: rule.label, ...config })
  }

  // 无关键词时：格式推断（只在当前消息里找 key）
  if (results.length === 0) {
    const currentKeys = extractCandidateKeys(currentText)
    if (currentKeys.length === 0) return []
    const key = currentKeys[0].key

    if (key.startsWith('eyJ')) {
      results.push({
        service: 'tts', provider: 'minimax', label: 'MiniMax TTS',
        configUpdates: { ttsProvider: 'minimax', minimaxKey: key },
        streamKeys: { minimaxKey: key },
      })
    } else if (key.startsWith('AKID')) {
      results.push({
        service: 'asr', provider: 'tencent', label: '腾讯云 ASR',
        configUpdates: { tencentSecretId: key },
      })
    } else if (key.startsWith('sk-') && isKeyOnlyMessage(currentText)) {
      // sk- 纯 key 消息：尝试 OpenAI TTS，失败则静默跳过
      results.push({
        service: 'tts', provider: 'openai', label: 'OpenAI TTS',
        configUpdates: { ttsProvider: 'openai', openaiTtsKey: key },
        streamKeys: { openaiKey: key },
        tryOnly: true,
      })
    }
  }

  // 宽泛 ASR 上下文：当前消息说的是语音识别，但没点名服务商
  if (results.length === 0 && /语音识别|识别语音|asr|听写|转文字|speech[\s_\-]?to[\s_\-]?text/.test(t)) {
    const currentKeys = extractCandidateKeys(currentText)
    if (currentKeys.length === 0) return []
    const key = currentKeys[0].key
    if (/^sk-[A-Za-z0-9_\-.]{20,}$/.test(key)) {
      results.push({
        service: 'asr', provider: 'aliyun', label: '阿里云 ASR',
        configUpdates: { voiceProvider: 'aliyun', aliyunApiKey: key },
      })
    } else if (key.startsWith('AKID')) {
      results.push({
        service: 'asr', provider: 'tencent', label: '腾讯云 ASR',
        configUpdates: { voiceProvider: 'tencent', tencentSecretId: key },
      })
    } else if (/^\d{6,10}$/.test(key)) {
      const next = currentKeys[1]?.key
      results.push({
        service: 'asr', provider: 'xunfei', label: '讯飞 ASR',
        configUpdates: { voiceProvider: 'xunfei', xunfeiAppId: key, ...(next ? { xunfeiApiKey: next } : {}) },
      })
    } else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) {
      results.push({
        service: 'asr', provider: 'volcengine', label: '火山豆包 ASR',
        configUpdates: {
          voiceProvider: 'volcengine',
          volcAsrApiKey: key,
          volcAsrResourceId: 'volc.seedasr.sauc.duration',
        },
      })
    }
  }

  // 宽泛语音上下文（当前消息有"配置语音/tts/合成"但无具体服务商）
  if (
    results.length === 0 &&
    /配置语音|语音配置|语音合成|设置语音|tts[\s_\-]?key|语音.*key|key.*语音/.test(t) &&
    !/语音识别|识别语音|asr|听写|转文字|speech[\s_\-]?to[\s_\-]?text/.test(t)
  ) {
    const currentKeys = extractCandidateKeys(currentText)
    if (currentKeys.length === 0) return []
    const key = currentKeys[0].key
    if (key.startsWith('eyJ')) {
      results.push({
        service: 'tts', provider: 'minimax', label: 'MiniMax TTS',
        configUpdates: { ttsProvider: 'minimax', minimaxKey: key },
        streamKeys: { minimaxKey: key },
      })
    } else {
      results.push({
        service: 'tts', provider: 'openai', label: 'OpenAI TTS',
        configUpdates: { ttsProvider: 'openai', openaiTtsKey: key },
        streamKeys: { openaiKey: key },
        tryOnly: true,
      })
    }
  }

  return results
}

// 测试 TTS key：用短文本合成，收到任意音频数据即视为成功
async function testTTSKey(provider, streamKeys) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: '连接超时（10 秒）' }), 10000)

    streamTTS({ text: '语音', provider, keys: streamKeys })
      .then(stream => {
        let gotData = false
        stream.on('data', () => {
          if (gotData) return
          gotData = true
          clearTimeout(timer)
          resolve({ ok: true })
          stream.destroy()
        })
        stream.on('error', err => {
          if (gotData) return
          clearTimeout(timer)
          resolve({ ok: false, error: err.message })
        })
        stream.on('end', () => {
          if (gotData) return
          clearTimeout(timer)
          resolve({ ok: false, error: '合成返回空音频' })
        })
      })
      .catch(err => {
        clearTimeout(timer)
        resolve({ ok: false, error: err.message })
      })
  })
}

// Seedance / AI 视频生成（火山方舟 Ark）密钥识别。
// 触发：消息里有视频生成相关关键词。可同时携带模型 ID / 推理接入点（ep-xxx）。
// 返回 { apiKey, model? } 或 null。
const SEEDANCE_HINT_RE = /seedance|文生视频|图生视频|ai\s*视频|视频生成|生成视频|火山.*视频|视频.*火山|方舟.*视频|即梦|doubao|dreamina|ep-[0-9a-z]/i
// 模型 ID / 推理接入点 token 的特征。独立扫描（不受 candidate ≥20 字符限制约束），
// 因为推理接入点（ep-xxxx）常常短于 20 字符，会被 extractCandidateKeys 漏掉。
const SEEDANCE_MODEL_RE = /\b(ep-[0-9a-z]{6,}|doubao-[a-z0-9-]{4,}|dreamina-[a-z0-9-]{4,}|seedance-[a-z0-9-]{2,})\b/i

export function detectSeedanceConfig(text) {
  const t = String(text || '')
  if (!SEEDANCE_HINT_RE.test(t)) return null

  // 先抓模型 ID（如有）
  const model = t.match(SEEDANCE_MODEL_RE)?.[1] || null

  // apiKey = 第一个 ≥20 字符候选，且不等于模型 ID、本身不长得像模型
  const candidates = extractCandidateKeys(t)
  let apiKey = null
  for (const c of candidates) {
    if (model && c.key === model) continue
    if (SEEDANCE_MODEL_RE.test(c.key)) continue
    apiKey = c.key
    break
  }
  // 没识别出 key → 放弃（避免把模型 ID 误当 key 写进去）
  if (!apiKey) return null
  return { apiKey, ...(model ? { model } : {}) }
}

// 主入口：检测并处理消息中的所有 API Key
// 返回：
//   { ok: true, results: [...] }  — 至少一个 key 配置成功，应静默处理（删消息、跳 LLM）
//   { ok: false, error: '...' }   — 识别到 key 但全部验证失败，应让 LLM 告知用户
//   null                           — 未识别到任何 key，正常流程
export async function tryAutoConfigureKey(text, _recentContext = '') {
  // Seedance 视频生成 key 优先识别（写入即生效，不需要网络验证；
  // model ID 是否正确留给 AI 视频面板提交任务时由 Ark 报错引导）。
  const seedance = detectSeedanceConfig(text)
  if (seedance) {
    setSeedanceConfig(seedance)
    return { ok: true, hasTTS: false, service: 'video', provider: 'seedance' }
  }

  const infos = detectAllKeyInfos(text)
  if (infos.length === 0) return null

  let anySuccess = false
  let hasTTS = false
  const failErrors = []

  // 并行处理 ASR（无需测试），串行/并行处理 TTS（需要测试）
  const asrInfos = infos.filter(i => i.service === 'asr')
  const ttsInfos = infos.filter(i => i.service === 'tts')

  // ASR：直接配置
  const asrUpdates = {}
  for (const info of asrInfos) {
    if (info.provider === 'aliyun' && !isValidAliyunAsrKey(info.configUpdates?.aliyunApiKey)) {
      failErrors.push('阿里云 ASR: 请使用百炼/DashScope API Key（sk- 开头），不要使用 AccessKey ID/Secret 或实例 ID')
      continue
    }
    Object.assign(asrUpdates, info.configUpdates)
    anySuccess = true
  }
  if (Object.keys(asrUpdates).length > 0) setVoiceConfig(asrUpdates)

  // TTS：逐个测试，取第一个成功的作为当前 TTS provider
  for (const info of ttsInfos) {
    const testResult = await testTTSKey(info.provider, info.streamKeys)
    if (testResult.ok) {
      setTTSConfig(info.configUpdates)
      hasTTS = true
      anySuccess = true
    } else {
      if (!info.tryOnly) failErrors.push(`${info.label}: ${testResult.error}`)
    }
  }

  if (anySuccess) {
    return { ok: true, hasTTS }
  }

  // 全部失败且有非 tryOnly 的失败
  if (failErrors.length > 0) {
    return { ok: false, error: failErrors.join('；') }
  }

  // 全是 tryOnly 且全部失败 → 静默跳过
  return null
}
