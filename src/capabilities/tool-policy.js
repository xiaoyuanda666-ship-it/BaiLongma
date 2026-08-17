import { config } from '../config.js'
import { getMcpToolMetadata, isMcpTool } from '../mcp/client-manager.js'
import { isExplicitAgentBrowserDataDeletionRequest } from '../mcp/browser-data-intent.js'
import { isSystemBrowserRequest } from '../mcp/browser-display.js'
import {
  explicitlyKeepsBrowserOpen,
  isLocalFileToolCallBlocked,
} from '../runtime/browser-intent-guards.js'

const TOOL_RISK = {
  read_file: 'low',
  list_dir: 'low',
  search_memory: 'low',
  probe_memory: 'low',
  list_processes: 'low',
  skip_recognition: 'low',
  send_message: 'medium',
  express: 'medium',
  write_file: 'medium',
  edit_file: 'medium',
  make_dir: 'medium',
  upsert_memory: 'medium',
  merge_memories: 'high',
  downgrade_memory: 'low',
  skip_consolidation: 'low',
  manage_reminder: 'medium',
  schedule_reminder: 'medium',
  manage_prefetch_task: 'medium',
  manage_rule: 'medium',
  manage_information_subscription: 'medium',
  ui_set: 'medium',
  capability_demo: 'medium',
  terminal_stream: 'medium',
  set_tick_interval: 'medium',
  media_mode: 'low',
  hotspot_mode: 'low',
  worldcup_mode: 'low',
  open_doc_panel: 'low',
  person_card_mode: 'low',
  music: 'low',
  delegate_to_agent: 'high',
  grant_agent_delegation: 'high',
  install_tool: 'high',
  uninstall_tool: 'medium',
  list_tools: 'low',
  manage_tool_factory: 'high',
  find_tool: 'low',
  complete_startup_self_check: 'low',
  delete_file: 'high',
  install_software: 'high',
  run_command: 'high',
  exec_command: 'high', // legacy executor alias
  exec_quick_command: 'medium',
  exec_task_command: 'high',
  exec_background_command: 'high',
  download_file: 'high',
  kill_process: 'high',
  web_search: 'high',
  web_read: 'high',
  fetch_url: 'high',
  browser_read: 'high',
  browser_navigate: 'medium',
  browser_navigate_back: 'medium',
  browser_navigate_forward: 'medium',
  browser_reload: 'medium',
  browser_snapshot: 'low',
  browser_find: 'low',
  browser_click: 'high',
  browser_type: 'high',
  browser_fill_form: 'high',
  browser_select_option: 'high',
  browser_press_key: 'high',
  browser_hover: 'medium',
  browser_drag: 'high',
  browser_wait_for: 'medium',
  browser_handle_dialog: 'high',
  browser_tabs: 'medium',
  browser_take_screenshot: 'low',
  browser_console_messages: 'low',
  browser_resize: 'medium',
  browser_close: 'medium',
  browser_clear_data: 'high',
  browser_set_display_mode: 'low',
  system_browser_open: 'medium',
  system_music: 'medium',
  speak: 'high',
  generate_lyrics: 'high',
  generate_music: 'high',
  generate_image: 'high',
  run_capability: 'high',
  run_api_capability: 'high',
  analyze_image: 'high',
  manage_api_capability: 'high',
  set_security: 'high',
}

// Chrome DevTools MCP exposes these actions as browser mutations. Keep an
// explicit local backstop as well, so an autonomous Tick cannot gain mutation
// authority from missing/incorrect remote metadata.
const BROWSER_MUTATING_TOOLS = [
  'browser_navigate',
  'browser_navigate_back',
  'browser_navigate_forward',
  'browser_reload',
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_select_option',
  'browser_press_key',
  'browser_hover',
  'browser_drag',
  'browser_wait_for',
  'browser_handle_dialog',
  'browser_tabs',
  'browser_resize',
  'browser_close',
]
const STARTUP_SELF_CHECK_BROWSER_TOOLS = new Set([
  'browser_navigate',
  'browser_snapshot',
  'browser_close',
])
const SYSTEM_MUSIC_ACTION_INTENT_RE = /(?:apple\s*music|music\.app|系统音乐|音乐播放器|当前歌曲|这首歌|播放|暂停|继续|恢复|停止|上一首|下一首|切歌|换一首|play|pause|resume|stop|next|previous)/i

// Audit risk and autonomous authority are related but not identical. Several
// read-only or reversible capabilities (for example web reads and speech) are
// classified "high" for observability/cost, yet blanket-blocking every high
// label would make autonomous task progress impossible. General shell tools
// stay in the explicit-authorization set because their cwd boundary is not an
// OS sandbox. The rest of this set covers authority changes, installation,
// destructive state changes, process control, and unbudgeted provider work.
const AUTONOMOUS_USER_AUTH_REQUIRED = new Set([
  'delete_file',
  'install_software',
  'install_tool',
  'uninstall_tool',
  'manage_tool_factory',
  'set_security',
  'grant_agent_delegation',
  'manage_api_capability',
  'kill_process',
  'run_command',
  'exec_command',
  'exec_quick_command',
  'exec_task_command',
  'exec_background_command',
  'generate_image',
  'generate_music',
  'generate_lyrics',
  'run_capability',
  'run_api_capability',
  'analyze_image',
  'system_browser_open',
  'system_music',
  'browser_clear_data',
  ...BROWSER_MUTATING_TOOLS,
])
export function classifyTool(name) {
  const mcpTool = getMcpToolMetadata(name)
  if (mcpTool?.annotations?.destructiveHint === true) return 'high'
  if (mcpTool?.annotations?.readOnlyHint === true) return 'low'
  return TOOL_RISK[name] || 'medium'
}

export function isDangerousShellCommand(command) {
  const text = String(command || '').trim()
  const reasons = []
  if (config.security?.execSandbox !== false) {
    if (/(^|[\s"'`])\.\.([\\/]|$)/.test(text)) reasons.push('command references a parent directory')
    if (/(^|[\s"'`])[a-z]:[\\/]/i.test(text) || /(^|[\s"'`])[\\/]{2}[^\\/]/.test(text)) reasons.push('command references an absolute filesystem path')
    if (/(^|[\s"'`])~([\\/]|$)/.test(text) || /\$(home|env:userprofile)\b/i.test(text) || /%userprofile%/i.test(text)) reasons.push('command references the user home directory')
    if (/\bgit\s+reset\s+--hard\b/i.test(text) || /\bgit\s+clean\b/i.test(text)) reasons.push('command can destructively rewrite the worktree')
    if (/\b(format|diskpart|shutdown)\b/i.test(text)) reasons.push('command is system-level destructive or disruptive')
    if (/Remove-Item\b.*-Recurse|-Recurse\b.*Remove-Item/i.test(text)) reasons.push('recursive delete (Remove-Item -Recurse) detected')
    if (/\brd\s+\/s\b/i.test(text)) reasons.push('recursive directory delete (rd /s) detected')
    if (/\bInvoke-Expression\b|\biex\s/i.test(text)) reasons.push('dynamic code execution via Invoke-Expression detected')
  }
  return reasons
}

export function evaluateToolPolicy(name, args = {}, context = {}) {
  const risk = classifyTool(name)
  const currentUserMessage = context.currentUserMessage || ''
  const blockedTools = config.security?.blockedTools || []
  const canonicalName = ['fetch_url', 'browser_read'].includes(name)
    ? 'web_read'
    : ['run_command', 'exec_command', 'exec_quick_command', 'exec_task_command', 'exec_background_command'].includes(name)
      ? 'run_command'
      : name
  if (blockedTools.includes(canonicalName)) {
    return { allowed: false, risk, reason: `工具 "${name}" 已被安全策略禁用` }
  }
  if (name === 'system_browser_open' && !isSystemBrowserRequest(currentUserMessage)) {
    return {
      allowed: false,
      risk,
      reason: 'opening the computer default browser requires an explicit current user request for the system/default browser',
    }
  }
  if (
    name === 'system_music'
    && String(args.action || 'status').toLowerCase() !== 'status'
    && !SYSTEM_MUSIC_ACTION_INTENT_RE.test(currentUserMessage)
  ) {
    return {
      allowed: false,
      risk,
      reason: 'changing Music.app playback requires an explicit current user music-control request',
    }
  }
  if (name === 'browser_close' && explicitlyKeepsBrowserOpen(currentUserMessage)) {
    return {
      allowed: false,
      risk,
      reason: 'the current user explicitly asked to keep the browser/page open or explicitly rejected closing it',
    }
  }
  if (isLocalFileToolCallBlocked(name, args, currentUserMessage)) {
    return {
      allowed: false,
      risk,
      reason: 'this turn is explicitly limited to browser/remote-web evidence; local filesystem fallback is not authorized',
    }
  }
  if (
    name === 'browser_clear_data'
    && !isExplicitAgentBrowserDataDeletionRequest(currentUserMessage)
  ) {
    return {
      allowed: false,
      risk,
      reason: 'clearing persistent browser data requires an explicit current user request naming Bailongma/Agent built-in browser data',
    }
  }
  const startupBrowserCheck = context.autonomous
    && context.startupSelfCheck?.active === true
    && STARTUP_SELF_CHECK_BROWSER_TOOLS.has(name)
    && getMcpToolMetadata(name)?.builtIn === true
    && getMcpToolMetadata(name)?.chromeDevtools === true
  if (context.autonomous && isMcpTool(name) && !context.allowHighRiskAutonomy && !startupBrowserCheck) {
    const mcpTool = getMcpToolMetadata(name)
    const explicitlyAllowed = mcpTool?.allowAutonomousReadOnly === true
      && mcpTool?.annotations?.readOnlyHint === true
      && mcpTool?.annotations?.destructiveHint !== true
    if (!explicitlyAllowed) {
      return {
        allowed: false,
        risk,
        reason: 'MCP tools are disabled for autonomous Tick/scheduled work unless this server explicitly allows annotated read-only tools',
      }
    }
  }
  if (['run_command', 'exec_command', 'exec_quick_command', 'exec_task_command', 'exec_background_command'].includes(name)) {
    const reasons = isDangerousShellCommand(args.command || args.cmd || '')
    if (reasons.length) return { allowed: false, risk, reason: reasons.join('; ') }
  }
  if (
    context.autonomous
    && name === 'manage_rule'
    && String(args.action || 'list').trim().toLowerCase() !== 'list'
    && !context.allowHighRiskAutonomy
  ) {
    return { allowed: false, risk, reason: 'autonomous Tick may inspect rules, but changing persistent rules requires an explicit user-driven context' }
  }
  if (context.autonomous && AUTONOMOUS_USER_AUTH_REQUIRED.has(name) && !context.allowHighRiskAutonomy && !startupBrowserCheck) {
    return { allowed: false, risk, reason: 'this authority-changing, destructive, or unbudgeted tool requires an explicit user-driven context' }
  }
  return { allowed: true, risk, reason: '' }
}
