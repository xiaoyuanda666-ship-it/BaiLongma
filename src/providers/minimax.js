import { request } from 'undici'
import { BaseProvider } from './base.js'
import { recordDailyUsage, getDailyUsage } from '../quota.js'

const CAPABILITIES = ['tts', 'music', 'lyrics', 'image']

const DAILY_LIMITS = {
  tts:    4000,
  music:  100,
  lyrics: 100,
  image:  50,
}

export class MinimaxProvider extends BaseProvider {
  constructor({ apiKey }) {
    super({
      name: 'minimax',
      apiKey,
      baseURL: 'https://api.minimaxi.com/v1',
    })
  }

  canDo(capability) {
    return CAPABILITIES.includes(capability)
  }

  async call(capability, params) {
    switch (capability) {
      case 'tts':    return this.#tts(params)
      case 'music':  return this.#music(params)
      case 'lyrics': return this.#lyrics(params)
      case 'image':  return this.#image(params)
      default: throw new Error(`MinimaxProvider: 不支持的能力 "${capability}"`)
    }
  }

  getQuotaStatus() {
    const status = {}
    for (const cap of CAPABILITIES) {
      const used = getDailyUsage(cap)
      const limit = DAILY_LIMITS[cap]
      status[cap] = { used, limit, ratio: ((used / limit) * 100).toFixed(1) + '%' }
    }
    return status
  }

  // ── Text to Speech ──
  async #tts({ text, voice_id = 'male-qn-qingse', speed = 1.0, emotion = 'neutral' }) {
    if (!text) throw new Error('tts: 缺少 text 参数')
    const data = await this.request('/t2a_v2', {
      model: 'speech-2.8-hd',
      text,
      voice_setting: { voice_id, speed, emotion, vol: 1.0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3' },
    })
    if (!data?.data?.audio) throw new Error('tts: 响应中无音频数据')
    recordDailyUsage('tts', 1)
    // MiniMax 返回 hex 编码的音频，时长在 extra_info.audio_length（毫秒）
    const audioBuffer = Buffer.from(data.data.audio, 'hex')
    const durationSec = data.extra_info?.audio_length
      ? (data.extra_info.audio_length / 1000).toFixed(1)
      : null
    return { buffer: audioBuffer, format: 'mp3', duration: durationSec }
  }

  // ── Music Generation ──
  async #music({ prompt, lyrics, instrumental = false }) {
    if (!prompt) throw new Error('music: 缺少 prompt 参数')
    const body = {
      model: 'music-2.6',
      prompt,
      audio_setting: { sample_rate: 44100, bitrate: 256000, format: 'mp3' },
    }
    if (instrumental) {
      body.is_instrumental = true
    } else if (lyrics) {
      body.lyrics = lyrics
    }
    const data = await this.request('/music_generation', body)
    if (!data?.data?.audio) throw new Error('music: 响应中无音频数据')
    recordDailyUsage('music', 1)
    const audioBuffer = Buffer.from(data.data.audio, 'hex')
    return { buffer: audioBuffer, format: 'mp3', duration: data.data.duration }
  }

  // ── Lyrics Generation ──
  async #lyrics({ prompt, mode = 'write_full_song' }) {
    if (!prompt) throw new Error('lyrics: 缺少 prompt 参数')
    const data = await this.request('/lyrics_generation', { prompt, mode })
    if (!data?.data) throw new Error('lyrics: 响应中无歌词数据')
    recordDailyUsage('lyrics', 1)
    return {
      title: data.data.song_title,
      style: data.data.style_tags,
      lyrics: data.data.lyrics,
    }
  }

  // ── Image Generation ──
  async #image({ prompt, aspect_ratio = '1:1', n = 1, model = 'image-01' }) {
    if (!prompt) throw new Error('image: 缺少 prompt 参数')
    if (model === 'MiniMax-H3-Image' || model === 'MiniMax-H3-Image-Highspeed') {
      return this.#h3Image({ model, prompt, aspect_ratio, n })
    }
    if (model !== 'image-01') throw new Error('Unsupported MiniMax image model')
    const data = await this.request('/image_generation', {
      model: 'image-01',
      prompt,
      aspect_ratio,
      n,
      response_format: 'url',
    })
    if (!data?.data?.image_urls?.length) throw new Error('image: 响应中无图片 URL')
    recordDailyUsage('image', n)
    return { urls: data.data.image_urls }
  }

  async #h3Image(params) {
    const region = process.env.MINIMAX_IMAGE_REGION || 'cn'
    if (region !== 'cn' && region !== 'global') {
      throw new Error('MINIMAX_IMAGE_REGION must be cn or global')
    }
    const host = region === 'global' ? 'api.minimax.io' : 'api.minimax.cn'
    const timeout = 600_000
    const { statusCode, body } = await request(`https://${host}/v1/images/generations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...params, response_format: 'url' }),
      headersTimeout: timeout,
      bodyTimeout: timeout,
      signal: AbortSignal.timeout(timeout),
      idempotent: false,
      maxRedirections: 0,
    })
    const response = await body.json().catch(() => null)
    if (statusCode !== 200) {
      throw new Error(`Image generation failed (HTTP ${statusCode}): ${response?.error?.message || 'No error detail'}`)
    }

    const urls = []
    const errors = []
    for (const image of Array.isArray(response?.data) ? response.data : []) {
      if (image?.error || !image?.url) errors.push(image?.error?.message || 'Missing image URL')
      else urls.push(image.url)
    }
    if (!urls.length) throw new Error(errors.join('; ') || 'Image generation returned no URLs')
    recordDailyUsage('image', urls.length)
    return { urls, errors }
  }
}
