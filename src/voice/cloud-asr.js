// 云端 ASR WebSocket 代理
// 前端 → ws://127.0.0.1:3721/voice/cloud → 后端签名/鉴权 → 云端 ASR
//
// 支持三家服务商：
//   aliyun  — 阿里云百炼 Paraformer（首选）
//   tencent — 腾讯云 ASR
//   xunfei  — 科大讯飞 RTASR

import crypto from 'crypto'
import { WebSocket } from 'ws'

// ─── 阿里云 Paraformer ───
// 协议：run-task → PCM binary chunks → finish-task
// 结果：{header:{event:"result-generated"}, payload:{output:{sentence:{text,status}}}}
// 连接建立前的待发音频上限（~4s，防止连接失败时无限堆积）
const MAX_PENDING_CHUNKS = 16

function createAliyunSession(apiKey, lang, onTranscript, onError, onClose) {
  const WS_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference/'
  const taskId = crypto.randomUUID()

  let ready = false
  const pending = []

  const ws = new WebSocket(WS_URL, {
    headers: { Authorization: `bearer ${apiKey}` },
  })

  ws.on('open', () => {
    const langCode = (lang === 'zh' || !lang) ? 'zh' : lang
    ws.send(JSON.stringify({
      header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
      payload: {
        task_group: 'audio',
        task: 'asr',
        function: 'recognition',
        model: 'paraformer-realtime-v2',
        parameters: {
            sample_rate: 16000,
            format: 'pcm',
            language_hints: [langCode],
            punctuation_prediction: true,
            inverse_text_normalization: true,
          },
        input: {},
      },
    }))
    ready = true
    for (const buf of pending) {
      try { ws.send(buf) } catch (err) { console.warn('[CloudASR/Aliyun] 发送音频失败:', err?.message) }
    }
    pending.length = 0
  })

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())
      const event = msg?.header?.event
      if (event === 'result-generated') {
        const sentence = msg?.payload?.output?.sentence
        if (sentence?.text) {
          const isFinal = sentence.status === 'sentence_end'
          onTranscript(sentence.text, isFinal)
        }
      } else if (event === 'task-failed') {
        onError(msg?.header?.error_message || '阿里云 ASR 错误')
      }
    } catch (err) { console.warn('[CloudASR/Aliyun] 消息解析失败:', err?.message) }
  })

  ws.on('error', (err) => { pending.length = 0; onError(err.message) })
  ws.on('close', () => { pending.length = 0; onClose() })

  return {
    sendAudio(pcmBuffer) {
      if (!ready) {
        if (pending.length < MAX_PENDING_CHUNKS) pending.push(pcmBuffer)
        return
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(pcmBuffer)
    },
    flush() {
      if (ws.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify({
        header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
        payload: { input: {} },
      }))
    },
    close() { try { ws.close() } catch {} },
  }
}

function isValidAliyunAsrKey(value) {
  return /^sk-[A-Za-z0-9_\-.]{20,}$/.test(String(value || '').trim())
}

// ─── 腾讯云 ASR ───
// 签名：HMAC-SHA256(SecretKey, host+path+?+sorted_query) → base64 → URL 参数
// 结果：{code:0, result:{slice_type:0|2, ...}}，slice_type=2 为最终结果
function createTencentSession(secretId, secretKey, appId, lang, onTranscript, onError, onClose) {
  const host = 'asr.cloud.tencent.com'
  const path = `/asr/v2/${appId}`
  const ts = Math.floor(Date.now() / 1000)
  const nonce = Math.floor(Math.random() * 1000000)

  const params = {
    secretid: secretId,
    timestamp: ts,
    expired: ts + 86400,
    nonce,
    engine_model_type: lang === 'zh' ? '16k_zh' : '16k_en',
    voice_format: 1,
    needvad: 1,
  }

  const sortedQuery = Object.keys(params).sort()
    .map(k => `${k}=${params[k]}`).join('&')
  const signStr = `${host}${path}?${sortedQuery}`
  const signature = crypto.createHmac('sha256', secretKey)
    .update(signStr).digest('base64')

  const url = `wss://${host}${path}?${sortedQuery}&signature=${encodeURIComponent(signature)}`
  const ws = new WebSocket(url)

  let ready = false
  const pending = []

  ws.on('open', () => {
    ready = true
    for (const buf of pending) {
      try { ws.send(buf) } catch {}
    }
    pending.length = 0
  })

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())
      if (msg.code !== 0) { onError(`腾讯云 ASR 错误: ${msg.message}`); return }
      const result = msg.result
      if (result?.voice_text_str) {
        const isFinal = result.slice_type === 2
        onTranscript(result.voice_text_str, isFinal)
      }
    } catch {}
  })

  ws.on('error', (err) => { pending.length = 0; onError(err.message) })
  ws.on('close', () => { pending.length = 0; onClose() })

  return {
    sendAudio(pcmBuffer) {
      if (!ready) {
        if (pending.length < MAX_PENDING_CHUNKS) pending.push(pcmBuffer)
        return
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(pcmBuffer)
    },
    flush() {
      // 腾讯 ASR 通过关闭连接来结束会话
      try { ws.close() } catch (err) { console.warn('[CloudASR/Tencent] 关闭连接失败:', err?.message) }
    },
    close() { try { ws.close() } catch (err) { console.warn('[CloudASR/Tencent] 关闭连接失败:', err?.message) } },
  }
}

// ─── 讯飞 RTASR ───
function createXunfeiSession(appId, apiKey, lang, onTranscript, onError, onClose) {
  const ts = Math.floor(Date.now() / 1000).toString()
  const md5Base = crypto.createHash('md5').update(appId + ts).digest('hex')
  const signa = crypto.createHmac('sha1', apiKey).update(md5Base).digest('base64')

  const langParam = lang === 'en' ? 'en_us' : 'cn'
  const url = `wss://rtasr.xfyun.cn/v1/ws?appid=${appId}&ts=${ts}&signa=${encodeURIComponent(signa)}&lang=${langParam}`
  const ws = new WebSocket(url)

  let ready = false
  const pending = []

  ws.on('open', () => {
    ready = true
    for (const buf of pending) {
      try { ws.send(buf) } catch (err) { console.warn('[CloudASR/Xunfei] 发送音频失败:', err?.message) }
    }
    pending.length = 0
  })

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())
      if (msg.action === 'error') { onError(`讯飞 RTASR 错误: ${msg.desc}`); return }
      if (msg.action === 'result') {
        const parsed = JSON.parse(msg.data)
        const isFinal = parsed.type === '1'
        const text = (parsed.ws || [])
          .flatMap(w => w.cw || [])
          .map(c => c.w || '').join('')
        if (text) onTranscript(text, isFinal)
      }
    } catch (err) { console.warn('[CloudASR/Xunfei] 消息解析失败:', err?.message) }
  })

  ws.on('error', (err) => { pending.length = 0; onError(err.message) })
  ws.on('close', () => { pending.length = 0; onClose() })

  return {
    sendAudio(pcmBuffer) {
      if (!ready) {
        if (pending.length < MAX_PENDING_CHUNKS) pending.push(pcmBuffer)
        return
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(pcmBuffer)
    },
    flush() {
      if (ws.readyState !== WebSocket.OPEN) return
      // 讯飞要求发送结束帧
      ws.send(JSON.stringify({ end: true }))
    },
    close() { try { ws.close() } catch (err) { console.warn('[CloudASR/Xunfei] 关闭连接失败:', err?.message) } },
  }
}

// ─── 工厂函数 ───
// config: { provider, lang, aliyunApiKey?, tencentSecretId?, tencentSecretKey?,
//           tencentAppId?, xunfeiAppId?, xunfeiApiKey? }
export function createCloudASRSession(config, onTranscript, onError, onClose) {
  const { provider = 'aliyun', lang = 'zh' } = config

  if (provider === 'aliyun') {
    if (!config.aliyunApiKey) { onError('未配置阿里云 API Key'); return null }
    if (!isValidAliyunAsrKey(config.aliyunApiKey)) {
      onError('阿里云 ASR Key 格式不正确：请填写百炼/DashScope 控制台的 sk- 开头 API Key')
      return null
    }
    return createAliyunSession(config.aliyunApiKey, lang, onTranscript, onError, onClose)
  }

  if (provider === 'tencent') {
    if (!config.tencentSecretId || !config.tencentSecretKey) {
      onError('未配置腾讯云 SecretId/SecretKey'); return null
    }
    const appId = config.tencentAppId || ''
    return createTencentSession(config.tencentSecretId, config.tencentSecretKey, appId, lang, onTranscript, onError, onClose)
  }

  if (provider === 'xunfei') {
    if (!config.xunfeiAppId || !config.xunfeiApiKey) {
      onError('未配置讯飞 AppId/ApiKey'); return null
    }
    return createXunfeiSession(config.xunfeiAppId, config.xunfeiApiKey, lang, onTranscript, onError, onClose)
  }

  onError(`未知云端 ASR 服务商: ${provider}`)
  return null
}
