import { getTTSCredentials } from '../../config.js'
import { updateLastJarvisConversationContent } from '../../db.js'
import { emitEvent } from '../../events.js'
import { stripMarkdownForSpeech } from '../../capabilities/tools/media.js'
import { streamTTS, validateTTSConfig } from '../../voice/tts-providers.js'
import { jsonResponse, readJsonBody } from '../utils.js'

export async function handleTTSRoutes(req, res, url) {
  if (req.method === 'POST' && url.pathname === '/tts/stream') {
    try {
      const body = await readJsonBody(req)
      // Strip markdown at the synthesis boundary so TTS does not speak markup symbols.
      const text = stripMarkdownForSpeech(body.text)
      if (!text) {
        jsonResponse(res, 400, { ok: false, error: 'Missing text parameter' })
        return true
      }
      const creds = getTTSCredentials()
      // Preflight config so missing provider credentials produce an actionable response.
      const check = validateTTSConfig(creds)
      if (!check.ok) {
        jsonResponse(res, 400, { ok: false, error: check.guide, needsConfig: true, provider: check.provider })
        return true
      }
      const audioStream = await streamTTS({
        text: text.slice(0, 800),
        provider: creds.provider,
        voiceId: body.voiceId || creds.voiceId || undefined,
        keys: {
          doubaoKey: creds.doubaoKey,
          doubaoAppId: creds.doubaoAppId,
          doubaoAccessKey: creds.doubaoAccessKey,
          doubaoResourceId: creds.doubaoResourceId,
          doubaoStyle: creds.doubaoStyle,
          doubaoSpeechRate: creds.doubaoSpeechRate,
          minimaxKey: creds.minimaxKey,
          openaiKey: creds.openaiKey,
          openaiBaseURL: creds.openaiBaseURL,
          elevenLabsKey: creds.elevenLabsKey,
          volcanoAppId: creds.volcanoAppId,
          volcanoToken: creds.volcanoToken,
        },
      })
      let headersWritten = false
      let responseDone = false
      let streamError = null
      const finishRes = () => { if (!responseDone) { responseDone = true; res.end() } }
      const errorRes = (msg) => { if (!responseDone) { responseDone = true; jsonResponse(res, 500, { ok: false, error: msg }) } }
      audioStream.on('data', (chunk) => {
        if (!headersWritten) {
          headersWritten = true
          res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            'Transfer-Encoding': 'chunked',
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*',
          })
        }
        res.write(chunk)
      })
      audioStream.on('end', () => {
        if (!headersWritten) {
          const errMsg = streamError?.message || 'TTS synthesis failed: API returned no audio - check whether the voice ID is enabled on your account'
          console.warn('[TTS] Empty stream:', errMsg)
          errorRes(errMsg)
        } else {
          finishRes()
        }
      })
      audioStream.on('error', (err) => {
        console.warn('[TTS] Audio stream error:', err.message)
        streamError = err
        if (!headersWritten) {
          errorRes(err.message)
        } else {
          finishRes()
        }
      })
    } catch (err) {
      console.warn('[TTS] Streaming synthesis failed:', err.message)
      if (!res.headersSent) jsonResponse(res, err.statusCode === 413 ? 413 : 500, { ok: false, error: err.message })
      else try { res.end() } catch {}
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/tts/interrupted') {
    try {
      const body = await readJsonBody(req)
      const { spokenContent } = body
      if (typeof spokenContent !== 'string') {
        jsonResponse(res, 400, { error: 'spokenContent required' })
        return true
      }
      const updated = updateLastJarvisConversationContent(spokenContent)
      emitEvent('tts_interrupted', { spokenContent })
      jsonResponse(res, 200, { ok: true, updated })
    } catch (e) {
      jsonResponse(res, e.statusCode === 413 ? 413 : 500, { error: e.message })
    }
    return true
  }

  return false
}
