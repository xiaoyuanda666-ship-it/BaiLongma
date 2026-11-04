import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const fail = (code, message) => Object.assign(new Error(message), { code })

async function runBsk(args) {
  const { stdout } = await exec(process.env.BAILONGMA_BSK_BINARY || 'bsk', [...args, '--json'], {
    timeout: 45_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, BSK_AUTO_START: '0' },
  })
  const result = JSON.parse(stdout)
  if (!result || result.ok === false || result.error) throw fail('BSK_FAILED', JSON.stringify(result))
  return result
}

// Persist only IDs we created. Never adopt a session from the global list.
export async function managedSession({ action = 'ensure', browser, slot = 'default', stateDir,
  run = runBsk, lockWaitMs = 10_000 } = {}) {
  if (!['ensure', 'close'].includes(action)) throw fail('INVALID_ACTION', 'Use ensure or close')
  if (!stateDir) throw fail('STATE_DIR_REQUIRED', 'A persistent session state directory is required')
  const key = createHash('sha256').update(slot).digest('hex')
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 })
  const filename = path.join(stateDir, `${key}.json`)
  const lockname = `${filename}.lock`
  const deadline = Date.now() + lockWaitMs
  let lock
  while (!lock) {
    try { lock = await fs.open(lockname, 'wx', 0o600) } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (Date.now() >= deadline) throw fail('SESSION_BUSY', `Session management is already running (or was interrupted). Wait for that command; do not start another session. Lock: ${lockname}`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }))
    let state = null
    try { state = JSON.parse(await fs.readFile(filename, 'utf8')) } catch (error) {
      if (error.code !== 'ENOENT') throw error // Corrupt/unknown state must not create a duplicate.
    }
    const save = async value => {
      const temp = `${filename}.${randomUUID()}.tmp`
      await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 })
      await fs.rename(temp, filename)
      state = value
    }
    const selectBrowser = async selector => {
      const browsers = await run(['browsers'])
      if (!Array.isArray(browsers)) throw fail('INVALID_RESPONSE', 'Expected a browser list')
      const connected = browsers.filter(b => typeof b?.instance_id === 'string' && b.instance_id && !b.unresponsive)
      const matches = selector ? connected.filter(b => b.instance_id === selector) : connected
      if (matches.length !== 1) throw fail('BROWSER_SELECTION_REQUIRED', 'The selected browser must be connected and unambiguous; no window was created')
      return matches[0]
    }
    if (state && (state.version !== 1 || !state.browser || !state.requestId)) throw fail('INVALID_STATE', 'Session state is incomplete; inspect it before creating another window')
    if (action === 'close') {
      if (!state) return { ok: true, closed: false }
      if (browser && browser !== state.browser) throw fail('PROFILE_MISMATCH', 'The requested profile does not own this slot')
      if (state.sessionId) {
        const sessions = await run(['session', 'list'])
        if (!Array.isArray(sessions)) throw fail('INVALID_RESPONSE', 'Expected a session list')
        const existing = sessions.find(s => s.session_id === state.sessionId)
        if (!existing) {
          await fs.unlink(filename)
          return { ok: true, closed: true, already_closed: true }
        }
        if (existing.browser_instance_id !== state.browser) throw fail('PROFILE_MISMATCH', 'Saved session belongs to a different browser; do not close it')
      }
      // Request cancellation also handles a start whose result was lost.
      const result = state.sessionId
        ? await run(['session', 'stop', state.sessionId])
        : await run(['session', 'request', state.requestId, '--cancel'])
      const closed = state.sessionId
        ? result.stopped?.includes(state.sessionId) && !result.failed?.length && !result.return_failures?.length
        : result.state === 'closed' && !result.cleanup_error
      if (!closed) throw fail('CLEANUP_PENDING', 'Session cleanup was not confirmed; keep the saved state and retry close')
      await fs.unlink(filename)
      return { ok: true, closed: true }
    }
    if (state?.sessionId) {
      const sessions = await run(['session', 'list'])
      if (!Array.isArray(sessions)) throw fail('INVALID_RESPONSE', 'Expected a session list')
      const existing = sessions.find(s => s.session_id === state.sessionId)
      if (existing) {
        if (existing.browser_instance_id !== state.browser) throw fail('PROFILE_MISMATCH', 'Saved session belongs to a different browser; do not reuse it')
        if (browser && browser !== state.browser) throw fail('PROFILE_MISMATCH', 'Close this slot first, or use a separate slot for the explicitly requested profile')
        return { ok: true, session_id: state.sessionId, browser_instance_id: state.browser, reused: true }
      }
      // Keep the exact profile binding even when the old window disappeared.
      // A disconnected profile must never silently retarget the next window.
      browser ||= state.browser
      // Save the replacement intent before discovery, so a failed discovery and
      // a later invocation without --browser still retain that binding.
      await save({ version: 1, browser, requestId: `${Date.now() + 9 * 60_000}:${randomUUID()}`, phase: 'new' })
    }
    if (!state) {
      const selected = await selectBrowser(browser)
      await save({ version: 1, browser: selected.instance_id, requestId: `${Date.now() + 9 * 60_000}:${randomUUID()}`, phase: 'new' })
    }
    if (browser && browser !== state.browser) throw fail('PROFILE_MISMATCH', 'Use the exact saved browser instance ID for this slot')
    if (state.phase === 'new') {
      await selectBrowser(state.browser)
      const prepared = await run(['session', 'request', state.requestId, '--prepare'])
      if (prepared.state !== 'prepared') throw fail('START_PENDING', 'Session request preparation is unresolved')
      // Write BEFORE starting. An interruption can only recover this request, never replay start.
      await save({ ...state, phase: 'starting' })
      try {
        await run(['session', 'start', '--browser', state.browser, '--name', 'Bailongma', '--request-id', state.requestId])
      } catch { /* Resolve the request below; a timeout does not mean no window was opened. */ }
    }
    const request = await run(['session', 'request', state.requestId])
    if (!request.session?.session_id) throw fail('START_PENDING', 'Previous creation is unresolved. Retry ensure to inspect it, or close this slot; do not start another session')
    const claimed = await run(['session', 'request', state.requestId, '--claim'])
    if (claimed.state !== 'active' || claimed.session?.session_id !== request.session.session_id) throw fail('START_PENDING', 'Session ownership was not confirmed')
    await save({ ...state, phase: 'active', sessionId: request.session.session_id })
    return { ok: true, session_id: state.sessionId, browser_instance_id: state.browser, reused: false }
  } finally {
    await lock.close()
    await fs.unlink(lockname)
  }
}

export function parseArguments(args) {
  const options = { action: args[0] || 'ensure' }
  for (let i = 1; i < args.length; i += 2) {
    if (!['--browser', '--slot'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw fail('INVALID_ARGUMENT', 'Usage: session.mjs ensure|close [--browser INSTANCE_ID] [--slot NAME]')
    options[args[i].slice(2)] = args[i + 1]
  }
  return options
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const userDir = process.env.BAILONGMA_USER_DIR || fileURLToPath(new URL('../../../', import.meta.url))
    // Keep separate daemons' registries apart, even when they happen to issue the same ID.
    const daemonKey = createHash('sha256').update(process.env.BSK_HOME || 'default').digest('hex').slice(0, 16)
    const result = await managedSession({ ...parseArguments(process.argv.slice(2)),
      stateDir: path.join(userDir, 'sandbox', '.browser-sessions', daemonKey) })
    console.log(JSON.stringify(result))
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error.code || 'SESSION_FAILED', error: error.message }))
    process.exitCode = 1
  }
}
