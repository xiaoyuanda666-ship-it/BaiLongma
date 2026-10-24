
// Key auto-config should not bind a fresh key to stale provider words from chat history.
//
// Run: node src/test-key-auto-config.js

import { detectAllKeyInfos } from './key-auto-config.js'
import {
  DEFAULT_DOUBAO_SPEECH_RATE,
  DEFAULT_DOUBAO_VOICE_ID,
  normalizeDoubaoSpeechRate,
} from './voice/tts-defaults.js'

let failed = 0

function assert(cond, label) {
  if (!cond) {
    console.error(`FAIL: ${label}`)
    failed += 1
    process.exitCode = 1
  } else {
    console.log(`PASS: ${label}`)
  }
}

function hasAliyunAsr(infos) {
  return infos.some(info => info.service === 'asr' && info.provider === 'aliyun')
}

function findAsrProvider(infos, provider) {
  return infos.find(info => info.service === 'asr' && info.provider === provider)
}

function findTtsProvider(infos, provider) {
  return infos.find(info => info.service === 'tts' && info.provider === provider)
}

{
  const infos = detectAllKeyInfos('sk-1234567890abcdefghijklmnopqrstuvwxyz')
  assert(!hasAliyunAsr(infos), 'plain sk-* key is not treated as Aliyun ASR')
}

{
  const infos = detectAllKeyInfos('刚才说的是阿里云语音，但这个是 DeepSeek key：sk-1234567890abcdefghijklmnopqrstuvwxyz')
  assert(!hasAliyunAsr(infos), 'DeepSeek-labeled sk-* key is not treated as Aliyun ASR')
}

{
  const infos = detectAllKeyInfos('配置阿里云百炼语音识别 sk-1234567890abcdefghijklmnopqrstuvwxyz')
  assert(hasAliyunAsr(infos), 'explicit same-message Aliyun ASR key is still detected')
  const aliyun = findAsrProvider(infos, 'aliyun')
  assert(aliyun?.configUpdates?.voiceProvider === 'aliyun', 'Aliyun ASR auto-config sets voice provider')
}

{
  const infos = detectAllKeyInfos('配置语音识别 sk-1234567890abcdefghijklmnopqrstuvwxyz')
  const aliyun = findAsrProvider(infos, 'aliyun')
  assert(!!aliyun, 'generic ASR sk-* key is detected as Aliyun ASR')
}

{
  const infos = detectAllKeyInfos('配置火山语音识别 01234567-89ab-4cde-8f01-23456789abcd')
  const volc = findAsrProvider(infos, 'volcengine')
  assert(!!volc, 'explicit Volcengine ASR key is detected')
  assert(volc.configUpdates?.voiceProvider === 'volcengine', 'Volcengine ASR auto-config sets voice provider')
  assert(volc.configUpdates?.volcAsrResourceId === 'volc.seedasr.sauc.duration', 'Volcengine ASR auto-config sets ASR 2.0 as default resource')
}

{
  const infos = detectAllKeyInfos('配置语音识别 abcdefghijklmnopqrstuvwxyz123456')
  assert(infos.length === 0, 'generic ASR unknown long key is not guessed as another provider')
}

{
  const infos = detectAllKeyInfos('配置豆包 TTS 01234567-89ab-4cde-8f01-23456789abcd')
  const doubao = findTtsProvider(infos, 'doubao')
  assert(!!doubao, 'explicit Doubao TTS key is detected')
  assert(doubao.configUpdates?.ttsVoiceId === DEFAULT_DOUBAO_VOICE_ID, 'Doubao TTS auto-config selects Yunzhou 2.0 by default')
  assert(doubao.configUpdates?.doubaoSpeechRate === DEFAULT_DOUBAO_SPEECH_RATE, 'Doubao TTS auto-config selects +20 speech rate by default')
  assert(doubao.configUpdates?.doubaoResourceId === 'seed-tts-2.0', 'Doubao TTS auto-config sets default 2.0 resource')
  assert(doubao.streamKeys?.doubaoResourceId === 'seed-tts-2.0', 'Doubao TTS probe uses default 2.0 resource')
}

assert(normalizeDoubaoSpeechRate(undefined) === 20, 'missing Doubao speech rate defaults to +20')
assert(normalizeDoubaoSpeechRate(0) === 0, 'explicit normal speech rate remains 0')
assert(normalizeDoubaoSpeechRate(-25) === -25, 'explicit slower speech rate is preserved')

if (failed > 0) process.exit(1)
