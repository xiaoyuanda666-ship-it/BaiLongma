import { apiUrl } from './api-client.js'
import { setHotspotMode, moveVoicePanel, restoreVoicePanel } from './hotspot.js'
import { setWorldcupMode } from './worldcup.js'

const FRAME_SRC = apiUrl('/src/ui/brain-ui/typhoon-broadcast.html')
const $ = (id) => document.getElementById(id)
const EXIT_ANIMATION_MS = 680
const COLLAPSE_DELAY_MS = 1600
const OPEN_GRACE_MS = 3000
const MESSAGE_PEEK_MS = 6000
const BACKGROUND_RELEASE_MS = 5 * 60 * 1000
let active = false
let closeTimer = null
let collapseTimer = null
let backgroundReleaseTimer = null

function reportState(visible, source = 'brain-ui') {
  fetch(apiUrl('/typhoon-state'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: !!visible, source }) }).catch(() => {})
}
function consoleEngaged() { const area = $('chat-area'); return !!area && (area.classList.contains('chat-pinned') || area.matches(':hover') || area.contains(document.activeElement)) }
function expandConsole() { if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null }; $('chat-area')?.classList.remove('ty-collapsed') }
function scheduleConsoleCollapse(delay = COLLAPSE_DELAY_MS) {
  if (!active || $('chat-area')?.classList.contains('chat-pinned')) return
  if (collapseTimer) clearTimeout(collapseTimer)
  collapseTimer = setTimeout(() => { collapseTimer = null; if (active && !consoleEngaged()) $('chat-area')?.classList.add('ty-collapsed') }, delay)
}
function cancelBackgroundRelease() { if (backgroundReleaseTimer) clearTimeout(backgroundReleaseTimer); backgroundReleaseTimer = null }
function scheduleBackgroundRelease(frame) {
  if (active) return
  cancelBackgroundRelease()
  backgroundReleaseTimer = setTimeout(() => {
    backgroundReleaseTimer = null
    if (!active && frame) frame.src = 'about:blank'
  }, BACKGROUND_RELEASE_MS)
}

export function setTyphoonMode(visible, { source = 'brain-ui' } = {}) {
  const next = !!visible
  if (active === next) { reportState(next, source); return }
  active = next
  const frame = $('typhoon-frame')
  if (next) {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null }
    cancelBackgroundRelease()
    setHotspotMode(false, { source: 'typhoon_open' })
    setWorldcupMode(false, { source: 'typhoon_open' })
    for (const mode of ['video-mode', 'image-mode', 'music-mode']) document.body.classList.remove(mode)
    if (frame) frame.src = FRAME_SRC
    moveVoicePanel($('chat-area'), { prepend: true })
    document.body.classList.add('typhoon-mode')
    scheduleConsoleCollapse(OPEN_GRACE_MS)
  } else {
    expandConsole()
    const voice = $('voice-panel')
    if (voice && voice.parentElement === $('chat-area')) restoreVoicePanel()
    const loaded = !!(frame && frame.src && !frame.src.includes('about:blank'))
    if (loaded) { try { frame.contentWindow?.postMessage({ type: 'typhoon-exit' }, '*') } catch {} }
    const finish = () => { closeTimer = null; document.body.classList.remove('typhoon-mode'); scheduleBackgroundRelease(frame) }
    if (loaded) closeTimer = setTimeout(finish, EXIT_ANIMATION_MS); else finish()
  }
  window.dispatchEvent(new CustomEvent('bailongma:typhoon-mode', { detail: { active: next } }))
  reportState(next, source)
}
export function toggleTyphoon(source = 'brain-ui') { setTyphoonMode(!active, { source }) }
export function initTyphoon() {
  $('ty-exit-btn')?.addEventListener('click', () => toggleTyphoon())
  const area = $('chat-area')
  area?.addEventListener('mouseenter', expandConsole)
  area?.addEventListener('mouseleave', () => scheduleConsoleCollapse())
  area?.addEventListener('focusin', expandConsole)
  area?.addEventListener('focusout', () => scheduleConsoleCollapse())
  const messages = $('chat-messages')
  if (messages) {
    new MutationObserver(() => {
      if (!active) return
      expandConsole()
      scheduleConsoleCollapse(MESSAGE_PEEK_MS)
    }).observe(messages, { childList: true, subtree: true, characterData: true })
  }
  document.addEventListener('keydown', (event) => {
    if (!active || event.code !== 'Space') return
    const target = event.target
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
    expandConsole()
    scheduleConsoleCollapse(MESSAGE_PEEK_MS)
  })
  window.addEventListener('bailongma:chat-pin', (event) => {
    if (!active) return
    if (event?.detail?.pinned) expandConsole()
    else scheduleConsoleCollapse()
  })
  window.addEventListener('bailongma:hotspot-mode', (event) => { if (event?.detail?.active && active) setTyphoonMode(false, { source: 'hotspot_open' }) })
  window.addEventListener('bailongma:worldcup-mode', (event) => { if (event?.detail?.active && active) setTyphoonMode(false, { source: 'worldcup_open' }) })
  window.addEventListener('message', (event) => {
    if (event?.data?.type !== 'typhoon-ptt' || !active) return
    const { phase } = event.data
    if (phase === 'down') {
      try { window.stopTTS?.() } catch {}
      window.bailongmaVoice?.pttStart?.()
      expandConsole()
    } else if (phase === 'up') {
      window.bailongmaVoice?.pttEnd?.()
      scheduleConsoleCollapse(MESSAGE_PEEK_MS)
    } else if (phase === 'cancel') {
      window.bailongmaVoice?.pttEnd?.({ send: false })
      scheduleConsoleCollapse()
    }
  })
}
