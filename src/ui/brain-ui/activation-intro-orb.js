import { createVoiceCore } from './voice-core.js'

// The activation page deliberately instantiates the same voice core as brain-ui.
// This keeps the point cloud material, speaking palette and audio response on one
// implementation instead of growing a second, approximate CSS orb.
export function createActivationIntroOrb({ canvas, audio, audioContext: sharedAudioContext = null }) {
  if (!canvas || !audio) return null

  const voiceCore = createVoiceCore({ canvas })
  let audioContext = sharedAudioContext
  const ownsAudioContext = !sharedAudioContext
  let capturedStream = null
  let mediaStreamSource = null
  let analyser = null
  let running = false
  let analyserAttached = false

  function markState(state) {
    canvas.dataset.voiceOrbState = state
  }

  function attachAudioAnalyser() {
    if (!running || analyserAttached) return
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext
      const capture = audio.captureStream || audio.mozCaptureStream
      if (!AudioContextClass || typeof capture !== 'function') return

      // captureStream observes the exact playing <audio> without rerouting its
      // output through Web Audio. Closing this context when the welcome ends thus
      // cannot mute or disturb the unchanged narration timeline.
      capturedStream = capture.call(audio)
      audioContext ||= new AudioContextClass()
      mediaStreamSource = audioContext.createMediaStreamSource(capturedStream)
      analyser = audioContext.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.72
      mediaStreamSource.connect(analyser)
      voiceCore.setTTSAnalyser(analyser)
      analyserAttached = true
      markState('analysing')
      audioContext.resume().catch(() => {
        markState('breathing')
      })
    } catch (error) {
      console.warn('[activation] voice orb audio analysis unavailable:', error?.message || error)
      try { mediaStreamSource?.disconnect() } catch {}
      if (ownsAudioContext) {
        try { audioContext?.close() } catch {}
      }
      audioContext = null
      capturedStream = null
      mediaStreamSource = null
      analyser = null
      analyserAttached = false
      markState('breathing')
    }
  }

  function start() {
    if (running) return
    running = true
    analyserAttached = false
    voiceCore.setStatus('speaking')
    voiceCore.startRenderLoop()
    markState('breathing')
    audio.addEventListener('playing', attachAudioAnalyser, { once: true })
    if (!audio.paused) attachAudioAnalyser()
  }

  function stop() {
    if (!running && !audioContext) return
    running = false
    audio.removeEventListener('playing', attachAudioAnalyser)
    voiceCore.setTTSAnalyser(null)
    voiceCore.stopRenderLoop()
    try { mediaStreamSource?.disconnect() } catch {}
    try { analyser?.disconnect() } catch {}
    try { capturedStream?.getTracks?.().forEach(track => track.stop()) } catch {}
    const contextToClose = ownsAudioContext ? audioContext : null
    audioContext = null
    capturedStream = null
    mediaStreamSource = null
    analyser = null
    analyserAttached = false
    markState('stopped')
    try { contextToClose?.close() } catch {}
  }

  return {
    start,
    stop,
    get running() { return running },
    get analyserAttached() { return analyserAttached },
  }
}
