import { config } from '../config.js'

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
  make_dir: 'medium',
  upsert_memory: 'medium',
  merge_memories: 'high',
  downgrade_memory: 'low',
  skip_consolidation: 'low',
  manage_reminder: 'medium',
  schedule_reminder: 'medium',
  manage_prefetch_task: 'medium',
  manage_rule: 'medium',
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
  exec_command: 'high',
  exec_quick_command: 'medium',
  exec_task_command: 'high',
  exec_background_command: 'high',
  download_file: 'high',
  kill_process: 'high',
  web_search: 'high',
  fetch_url: 'high',
  browser_read: 'high',
  browser_sessions: 'low',
  browser_open: 'medium',
  browser_inspect: 'low',
  browser_act: 'high',
  browser_tabs: 'medium',
  browser_close: 'low',
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
  'browser_act',
])
export function classifyTool(name) {
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
  const blockedTools = config.security?.blockedTools || []
  if (blockedTools.includes(name)) {
    return { allowed: false, risk, reason: `工具 "${name}" 已被安全策略禁用` }
  }
  if (['exec_command', 'exec_quick_command', 'exec_task_command', 'exec_background_command'].includes(name)) {
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
  if (
    context.autonomous
    && name === 'browser_open'
    && (
      args.visible !== false
      || (args.persistent !== undefined && args.persistent !== false)
    )
    && !context.allowHighRiskAutonomy
  ) {
    return { allowed: false, risk, reason: 'an autonomous Tick cannot open a visible or persistent browser profile without explicit user authority' }
  }
  if (context.autonomous && AUTONOMOUS_USER_AUTH_REQUIRED.has(name) && !context.allowHighRiskAutonomy) {
    return { allowed: false, risk, reason: 'this authority-changing, destructive, or unbudgeted tool requires an explicit user-driven context' }
  }
  return { allowed: true, risk, reason: '' }
}
