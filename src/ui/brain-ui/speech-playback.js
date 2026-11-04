// Reveal text from the audio clock, never from network arrival or a timer.
export function visibleSpeechText(segment, seconds, duration, ended = false) {
  if (ended) return segment.text
  const ms = Math.max(0, seconds * 1000)
  if (segment.alignment === 'provider' && segment.cues?.length) {
    const offset = Math.max(0, ...segment.cues.filter(c => c.startMs <= ms).map(c => c.endOffset))
    return segment.text.slice(0, offset)
  }
  if (!Number.isFinite(duration) || duration <= 0) return ''
  const chars = Array.from(segment.text)
  return chars.slice(0, Math.floor(chars.length * Math.min(1, seconds / duration))).join('')
}

export function createSpeechPlayback({ createAudio = url => new Audio(url), prepareAudio = async () => {}, suspend = () => {}, resume = () => {}, baseUrl = '' } = {}) {
  let active = null
  const seen = new Set()
  function stop() { active?.cancel() }
  async function play(message, { render, status = () => {}, replay = false }) {
    const manifest = message.speech
    if (!manifest?.segments?.length || (!replay && seen.has(manifest.id))) return false
    seen.add(manifest.id)
    if (seen.size > 200) seen.delete(seen.values().next().value)
    stop()
    const session = { cancelled: false, finish: null, cancel() { this.cancelled = true; this.finish?.('interrupted') } }
    active = session
    let prefix = ''
    suspend(); status('正在播放'); render('')
    try {
      for (const segment of manifest.segments) {
        if (session.cancelled) break
        const audio = createAudio(`${baseUrl}/${segment.path}`)
        const outcome = await new Promise(resolve => {
          let settled = false
          const finish = kind => {
            if (settled) return
            settled = true; clearTimeout(timer)
            audio.onplaying = audio.ontimeupdate = audio.onended = audio.onerror = null
            audio.pause(); audio.removeAttribute('src'); audio.load?.()
            session.finish = null; resolve(kind)
          }
          const timer = setTimeout(() => finish('failed'), 120000)
          session.finish = finish
          audio.onplaying = () => { if (!session.cancelled) status('正在播放') }
          audio.ontimeupdate = () => { if (!settled && !session.cancelled) render(prefix + visibleSpeechText(segment, audio.currentTime, audio.duration)) }
          audio.onended = () => { render(prefix + segment.text); finish('ended') }
          audio.onerror = () => finish('failed')
          Promise.resolve(prepareAudio(audio)).then(() => {
            if (!settled && !session.cancelled) return audio.play()
          }).catch(() => finish('failed'))
        })
        if (outcome !== 'ended') { status(outcome === 'interrupted' ? '已停止播放' : '播放失败，可重试'); return false }
        prefix += segment.text
      }
      status(session.cancelled ? '已停止播放' : '播放完成')
      return !session.cancelled
    } finally {
      // Keep the full authoritative reply even when playback fails/interruption
      // occurs. Never rewrite the latest unrelated conversation on the server.
      render(message.content)
      if (active === session) { active = null; resume() }
    }
  }
  return { play, stop, get active() { return !!active } }
}
