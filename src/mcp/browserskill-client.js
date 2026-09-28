import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { browserSkillOptions, saveBrowserSkillSettings } from './browser-backend.js'

const exec = promisify(execFile)
const live = new Set()
export function browserSessionForClient(clientId) {
  if (!clientId) return null
  return [...live].find(session => session.owner === clientId && !session.closing) || null
}

export function releaseBrowserSkillForContext(context = {}) {
  if (!context) return Promise.resolve()
  const session = (context.browserLeaseState || context).browserSkillSession
  if (session?.id && context.signal?.aborted) { session.humanControl = true; session.needsObservation = true; session.unsettled = true }
  if (((session?.owner && !session?.background) || session?.humanControl || session?.challenge) && session.id && !session.closing) return Promise.resolve()
  return stopBrowserSkillForContext(context)
}
const problem = (code, message, details) => Object.assign(new Error(message), { code, details })

// argv only: page text and model arguments must never become shell source.
export async function runBsk(argv, { signal, timeout = 40_000, options = browserSkillOptions(), autoStart = false } = {}) {
  let stdout
  try {
    ;({ stdout } = await exec(options.binary, (argv[0] === '--version' ? argv : [...argv, '--json']), {
      shell: false, windowsHide: true, signal, timeout, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, BSK_AUTO_START: autoStart ? (process.env.BSK_AUTO_START || '1') : '0' },
    }))
  } catch (error) {
    let details
    try { details = JSON.parse(error.stdout) } catch {}
    if (error.killed && !signal?.aborted) {
      throw problem('BSK_TIMEOUT', `BrowserSkill ${argv[0]} timed out after ${timeout} ms`, details)
    }
    throw problem(error.code === 'ENOENT' ? 'BSK_NOT_INSTALLED' : 'BSK_COMMAND_FAILED',
      details?.error?.message || details?.message || error.message, details)
  }
  if (argv[0] === '--version') return { version: String(stdout).trim().replace(/^bsk\s+/, '') }
  let result
  try { result = JSON.parse(stdout) } catch { throw problem('BSK_INVALID_RESPONSE', 'BrowserSkill returned invalid JSON') }
  if (!result || typeof result !== 'object' || result.ok === false || result.error) {
    throw problem('BSK_OPERATION_FAILED', result?.error?.message || result?.error || 'BrowserSkill operation failed', result)
  }
  return result
}

export const SETUP_GUIDE = 'https://github.com/Tencent/BrowserSkill/blob/main/AGENT_INSTALL.md'
export async function getBrowserSkillStatus({ run = runBsk, options = browserSkillOptions() } = {}) {
  try {
    const cli = await run(['--version'], { timeout: 5000, options, autoStart: false })
    const result = await run(['status'], { timeout: 10_000, options, autoStart: false })
    const browsers = (Array.isArray(result.browsers) ? result.browsers : []).filter(b => b.browser_name === 'chrome')
    const matches = options.browser ? browsers.filter(b => b.instance_id === options.browser || b.label === options.browser) : browsers
    const selected = matches.length === 1 ? matches[0] : null
    const incompatible = selected && (cli.version !== result.daemon_version || selected.version_skew || selected.extension_version !== result.daemon_version
      || selected.extension_protocol_version !== result.protocol_version || result.protocol_version !== '1.3')
    const state = incompatible ? 'version_mismatch' : selected ? 'ready' : matches.length ? 'browser_selection_required' : 'browser_not_connected'
    return { ok: true, backend: 'browserskill', ready: state === 'ready', state,
      selected_browser: options.browser, binary: options.binary, browsers,
      cli_version: cli.version, daemon_version: result.daemon_version, protocol_version: result.protocol_version,
      guide: SETUP_GUIDE,
      hint: state === 'ready' ? '' : state === 'browser_selection_required' ? '请选择 Chrome 扩展实例；可在该配置的扩展弹窗核对实例 ID。'
        : state === 'version_mismatch' ? 'CLI、daemon 与扩展需要匹配版本；请手动更新并运行 bsk doctor。不会重启共享 daemon。'
        : '打开所选 Chrome 配置，连接 BrowserSkill 扩展；未安装时按安装指南操作。不会切换其他配置。' }
  } catch (error) { return { ok: false, backend: 'browserskill', ready: false, code: error.code, error: error.message,
    binary: options.binary, guide: SETUP_GUIDE, hint: '检查 CLI 绝对路径；运行 bsk --version 和 bsk doctor。若 daemon 未运行，请在终端启动 bsk daemon start；不要重启共享 daemon。' } }
}
export function browserTasks() {
  return [...live].map(s => ({ session_id: s.id, browser: s.options.browser, owner: s.owner || '',
    state: s.closing ? 'closing' : s.humanControl ? (s.unsettled ? 'waiting_for_idle' : 'user_control') : s.agentPending ? 'running' : 'idle',
    pending: s.agentPending, needs_observation: s.needsObservation, challenge: !!s.challenge }))
}
export async function controlBrowserTask(id, action) {
  const session = [...live].find(s => s.id === id)
  if (!session) throw problem('BSK_UNKNOWN_SESSION', '该任务会话不存在；不会操作其他会话')
  if (session.controlPending) throw problem('BSK_CONTROL_PENDING', '上一项会话控制尚未完成，请等待后再操作')
  session.controlPending = true
  try { return await applyBrowserTaskControl(session, action) } finally { session.controlPending = false }
}
async function applyBrowserTaskControl(session, action) {
  if (action === 'takeover' || action === 'cancel') {
    session.humanControl = true // Block queued work immediately; accepted daemon actions must finish.
    session.needsObservation = true
    session.unsettled = true
    await session.queue
    const waited = await session.run(['debug', 'wait', '--session', session.id, '--wait-ms', '30000'], {options:session.options, timeout:35000})
    if (waited.activity?.state !== 'idle' || waited.activity?.wait_complete !== true) throw problem('BSK_STILL_BUSY', '已阻止新的 Agent 操作，但 Chrome 中已接受的操作尚未确认结束，请刷新状态后再接管。')
    session.unsettled = false
    return { ok: true, state: 'user_control', message: 'Agent 已停止操作，请在同一个 Chrome 页面继续。' }
  }
  if (action === 'resume') {
    if (!session.humanControl) throw problem('BSK_NOT_PAUSED', '请先接管再恢复')
    await session.enqueue(async () => {
      await session.call(['observe'], {}, { human: true })
      session.needsObservation = true // The Agent itself must read fresh refs next.
      session.challenge = false
      session.humanControl = false
      session.unsettled = false
    })
    return { ok: true, state: 'idle' }
  }
  if (action === 'close') { await session.stop(); return { ok: true, state: 'closed' } }
  throw problem('BSK_INVALID_ACTION', '只支持 takeover、cancel、resume、close')
}

export class BrowserSkillSession {
  constructor({ run = runBsk, options = browserSkillOptions() } = {}) {
    this.run = run
    this.options = options
    this.id = null
    this.tabId = null
    this.queue = Promise.resolve()
    this.closing = false
    this.revision = 0
    this.agentPending = 0
    this.humanControl = false
    this.needsObservation = false
  }
  enqueue(operation) {
    if (this.closing) return Promise.reject(problem('BSK_SESSION_CLOSING', 'Browser task is closing'))
    live.add(this) // Track queued/start-in-flight work before a session ID exists.
    const next = this.queue.then(() => {
      if (this.closing) throw problem('BSK_SESSION_CLOSING', 'Browser task is closing')
      return operation()
    })
    this.queue = next.catch(() => {})
    return next
  }
  async start(context = {}) {
    if (this.id) {
      if (!this.claimed) throw problem('BSK_START_PENDING', 'Session ownership was not confirmed; close the task before continuing.')
      return
    }
    const status = await getBrowserSkillStatus({ run: this.run, options: this.options })
    if (!status.ready) throw problem(status.code || status.state, status.error || status.hint, status)
    const browser = status.browsers.find(b => b.instance_id === this.options.browser || (this.options.browser && b.label === this.options.browser)) || status.browsers[0]
    this.options = { ...this.options, browser: browser.instance_id }
    // Persist exact identity, even when initial discovery had only one Chrome.
    if (this.run === runBsk && !process.env.BAILONGMA_BSK_BROWSER) saveBrowserSkillSettings({ browser: browser.instance_id })
    this.startRequestId ||= `${Date.now() + 9 * 60_000}:${randomUUID()}`
    const prepared = await this.run(['session', 'request', this.startRequestId, '--prepare'], { options: this.options })
    if (prepared.state !== 'prepared') throw problem('BSK_START_PENDING', 'Previous session creation is unresolved; close this task before starting another.')
    const args = ['session', 'start', '--name', 'Bailongma', '--browser', browser.instance_id, '--request-id', this.startRequestId]
    // Do not kill session creation on turn cancellation: retain its ID so finally can stop it.
    let result
    try { result = await this.run(args, { options: this.options }) } catch (error) {
      // Inspect the prepared request instead of repeating session creation.
      const recovered = await this.run(['session', 'request', this.startRequestId], {options:this.options})
      if (!recovered.session?.session_id) throw error
      result = recovered.session
    }
    if (!result.session_id) throw problem('BSK_INVALID_SESSION', 'BrowserSkill did not return a session ID')
    this.id = result.session_id
    live.add(this)
    const claimed = await this.run(['session', 'request', this.startRequestId, '--claim'], {options:this.options})
    if (claimed.state !== 'active' || claimed.session?.session_id !== this.id) throw problem('BSK_START_PENDING', 'Session claim was not confirmed; keep the task blocked until cleanup.')
    this.claimed = true
  }
  async call(args, context = {}, { tab = true, timeout = 40_000, human = false } = {}) {
    context.signal?.throwIfAborted()
    if (this.closing) throw problem('BSK_SESSION_CLOSING', 'Browser task is closing')
    if (this.humanControl && !human) throw problem('BSK_USER_CONTROL', '用户已接管，停止 Agent 操作')
    const command = [...args, '--session', this.id]
    if (tab && this.tabId != null) command.push('--tab-id', String(this.tabId))
    const result = await this.run(command, { signal: context.signal, options: this.options, timeout })
    if (result.tab_id != null) this.tabId = result.tab_id
    return result
  }
  invalidateReferences() {
    this.revision += 1
    this.needsObservation = true
  }
  stop() {
    if (this.stopPromise) return this.stopPromise
    this.closing = true
    this.stopPromise = this.stopOnce().finally(() => { this.stopPromise = null })
    return this.stopPromise
  }
  async stopOnce() {
    await this.queue
    if (!this.id) {
      if (this.startRequestId) {
        const cancelled = await this.run(['session', 'request', this.startRequestId, '--cancel'], {options:this.options})
        if (cancelled.state !== 'closed' || cancelled.cleanup_error) throw problem('BSK_CLEANUP_FAILED', 'Session creation cancellation was not confirmed', cancelled)
        this.startRequestId = null
      }
      live.delete(this); return
    }
    const id = this.id
    let result
    try {
      result = await this.run(['session', 'stop', id], { options: this.options })
    } catch (error) {
      // Cancelling the CLI does not cancel work already accepted by the daemon.
      // Wait only for this owned session; never replay its unfinished action.
      const reason = error.details?.data?.reason || error.details?.error?.data?.reason
      if (reason !== 'session_busy') throw error
      const waited = await this.run(['debug', 'wait', '--session', id, '--wait-ms', '30000'], {
        options: this.options, timeout: 35_000,
      })
      if (waited.activity?.state !== 'idle' || waited.activity?.wait_complete !== true || waited.activity?.wait_timed_out === true) {
        throw problem('BSK_CLEANUP_FAILED', 'BrowserSkill session remained busy during cleanup', waited)
      }
      // At most one retry. Any failure keeps the session tracked for later cleanup.
      result = await this.run(['session', 'stop', id], { options: this.options })
    }
    if (!result.stopped?.includes(id) || result.failed?.length || result.return_failures?.length) {
      throw problem('BSK_CLEANUP_FAILED', 'BrowserSkill session cleanup was incomplete', result)
    }
    this.id = null
    this.tabId = null
    this.invalidateReferences()
    live.delete(this)
  }
}

export async function stopBrowserSkillForContext(context = {}) {
  const state = context.browserLeaseState || context
  if (!state.browserSkillSession) return
  await state.browserSkillSession.stop()
  delete state.browserSkillSession
}
export async function shutdownBrowserSkill() {
  const results = await Promise.allSettled([...live].map(session => session.stop()))
  return results.filter(r => r.status === 'rejected').map(r => r.reason.message)
}
