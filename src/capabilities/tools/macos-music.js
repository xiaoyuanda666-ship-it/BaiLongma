import { execFile } from 'node:child_process'

const FIELD_SEPARATOR = String.fromCharCode(31)
const STATUS_SCRIPT = `
set fieldSeparator to character id 31
tell application "Music"
  set playbackState to (player state as text)
  set trackName to ""
  set artistName to ""
  set albumName to ""
  set trackDuration to ""
  set playerPosition to ""
  set playerVolume to ""
  try
    set trackName to (name of current track as text)
    set artistName to (artist of current track as text)
    set albumName to (album of current track as text)
    set trackDuration to (duration of current track as text)
  end try
  try
    set playerPosition to (player position as text)
  end try
  try
    set playerVolume to (sound volume as text)
  end try
  return playbackState & fieldSeparator & trackName & fieldSeparator & artistName & fieldSeparator & albumName & fieldSeparator & trackDuration & fieldSeparator & playerPosition & fieldSeparator & playerVolume
end tell
`

const ACTION_SCRIPTS = Object.freeze({
  open: 'tell application "Music" to activate',
  play: 'tell application "Music" to play',
  pause: 'tell application "Music" to pause',
  toggle: 'tell application "Music" to playpause',
  next: 'tell application "Music" to next track',
  previous: 'tell application "Music" to previous track',
})

function execFileAsync(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

function numericOrNull(value) {
  const number = Number.parseFloat(String(value || ''))
  return Number.isFinite(number) ? number : null
}

export function parseMacOSMusicStatus(output = '') {
  const [rawState = '', title = '', artist = '', album = '', duration = '', position = '', volume = ''] = String(output)
    .trimEnd()
    .split(FIELD_SEPARATOR)
  const playbackState = rawState.trim().toLowerCase().replace(/\s+/g, '_') || 'unknown'
  return {
    ok: playbackState !== 'unknown',
    tool: 'system_music',
    platform: 'darwin',
    app: 'Music',
    app_running: true,
    playback_state: playbackState,
    title: title.trim(),
    artist: artist.trim(),
    album: album.trim(),
    duration_seconds: numericOrNull(duration),
    position_seconds: numericOrNull(position),
    volume: numericOrNull(volume),
  }
}

async function isMusicAppRunning(runner) {
  try {
    await runner('/usr/bin/pgrep', ['-x', 'Music'], {
      timeout: 2_000,
      windowsHide: true,
      maxBuffer: 8 * 1024,
    })
    return true
  } catch (error) {
    if (Number(error?.code) === 1) return false
    throw error
  }
}

export async function getMacOSMusicStatus({
  platform = process.platform,
  runner = execFileAsync,
} = {}) {
  if (platform !== 'darwin') {
    return {
      ok: false,
      tool: 'system_music',
      platform,
      available: false,
      app_running: false,
      playback_state: 'unavailable',
      error: 'system_music is available only on macOS',
    }
  }

  try {
    if (!await isMusicAppRunning(runner)) {
      return {
        ok: true,
        tool: 'system_music',
        platform: 'darwin',
        app: 'Music',
        available: true,
        app_running: false,
        playback_state: 'not_running',
        title: '',
        artist: '',
        album: '',
        duration_seconds: null,
        position_seconds: null,
        volume: null,
      }
    }
    const { stdout } = await runner('/usr/bin/osascript', ['-e', STATUS_SCRIPT], {
      timeout: 4_000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    })
    return { ...parseMacOSMusicStatus(stdout), available: true }
  } catch (error) {
    return {
      ok: false,
      tool: 'system_music',
      platform: 'darwin',
      app: 'Music',
      available: true,
      app_running: true,
      playback_state: 'unknown',
      error: String(error?.stderr || error?.message || error || 'unable to read Music.app state').trim().slice(0, 400),
    }
  }
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function execSystemMusic(args = {}, context = {}) {
  const action = String(args.action || 'status').trim().toLowerCase()
  if (!['status', ...Object.keys(ACTION_SCRIPTS)].includes(action)) {
    return JSON.stringify({
      ok: false,
      tool: 'system_music',
      error: 'action must be status, open, play, pause, toggle, next, or previous',
    })
  }
  const platform = String(context.platform || process.platform)
  const runner = typeof context.runSystemMusicProcess === 'function'
    ? context.runSystemMusicProcess
    : execFileAsync
  const readStatus = () => getMacOSMusicStatus({ platform, runner })
  const before = await readStatus()
  if (action === 'status') return JSON.stringify({ ...before, action })
  if (platform !== 'darwin') return JSON.stringify({ ...before, action })

  // Pause/track navigation must never launch Music.app just to satisfy a
  // command. Play/open/toggle may intentionally open it.
  if (!before.app_running && ['pause', 'next', 'previous'].includes(action)) {
    return JSON.stringify({
      ...before,
      ok: false,
      action,
      changed: false,
      error: 'Music.app is not open',
    })
  }

  try {
    await runner('/usr/bin/osascript', ['-e', ACTION_SCRIPTS[action]], {
      timeout: 6_000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    })
    await wait(140)
    let after = await readStatus()
    // The Apple event can return slightly before Music publishes its state.
    if ((action === 'pause' && after.playback_state === 'playing')
      || (action === 'play' && after.playback_state !== 'playing')) {
      await wait(240)
      after = await readStatus()
    }
    const verified = action === 'pause'
      ? after.ok && after.playback_state === 'paused'
      : action === 'play'
        ? after.ok && after.playback_state === 'playing'
        : after.ok
    return JSON.stringify({
      ...after,
      ok: verified,
      action,
      changed: verified,
      previous_playback_state: before.playback_state,
      ...(verified ? {} : { error: after.error || `Music.app did not reach the expected state after ${action}` }),
    })
  } catch (error) {
    const after = await readStatus()
    return JSON.stringify({
      ...after,
      ok: false,
      action,
      changed: false,
      error: String(error?.stderr || error?.message || error || `failed to ${action} Music.app`).trim().slice(0, 400),
    })
  }
}

function formatClock(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0))
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`
}

export async function buildMacOSMusicRuntimeContext(options = {}) {
  const status = await getMacOSMusicStatus(options)
  if (status.platform !== 'darwin') return ''
  if (!status.app_running) {
    return '[macOS System Music]\nMusic.app is not open. There is no active system music playback.'
  }
  if (!status.ok) {
    return `[macOS System Music]\nMusic.app is open, but its playback state could not be verified: ${status.error || 'unknown error'}. Do not claim that playback changed without a successful system_music result.`
  }
  const track = status.title
    ? `Current track: "${status.title}"${status.artist ? ` — ${status.artist}` : ''}${status.album ? ` (${status.album})` : ''}.`
    : 'Current track metadata is unavailable.'
  const position = status.position_seconds != null
    ? ` Position: ${formatClock(status.position_seconds)}${status.duration_seconds != null ? ` / ${formatClock(status.duration_seconds)}` : ''}.`
    : ''
  return `[macOS System Music]\nMusic.app is open. Authoritative playback state: ${status.playback_state}. ${track}${position}`
}

export const __internal = {
  ACTION_SCRIPTS,
  FIELD_SEPARATOR,
  STATUS_SCRIPT,
}
