const REPAIR_TOOLS = ['manage_tool_factory', 'install_tool']
const COMMON_TOOL_NAMES = [
  'web_read',
  'fetch_url',
  'web_search',
  'browser_read',
  'manage_tool_factory',
  'install_tool',
  'uninstall_tool',
  'list_tools',
  'find_tool',
]

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeToolName(value) {
  const name = String(value || '').trim()
  return /^[a-z][a-z0-9_]{1,49}$/.test(name) ? name : ''
}

function normalizeToolList(values = []) {
  if (!Array.isArray(values)) return []
  return [...new Set(values.map(normalizeToolName).filter(Boolean))]
}

function hasStrictMarker(text) {
  return /(strict\s+(?:evaluation|eval|test)\s+mode|strict\s+mode|严格(?:评估|测试|验收)模式|严格(?:评估|测试|验收)|测试约束|评测约束)/i.test(text)
}

function hasNoRepairMarker(text) {
  return /(失败(?:就|后)?(?:直接)?(?:报告|汇报)失败|do\s+not\s+(?:self[-\s]?)?(?:repair|fix)|don't\s+(?:self[-\s]?)?(?:repair|fix)|no\s+self[-\s]?repair|不要(?:自行|自我)?(?:诊断|修复|补救)|不要(?:重新|再)\s*(?:propose|review|install)|不要(?:重新|再)?(?:生成|重写|创建|注册)工具)/i.test(text)
}

function hasForbidNearTool(text, toolName) {
  const name = escapeRegExp(toolName)
  const forbid = String.raw`(?:不要|别|禁止|不得|不允许|严禁|do\s+not|don't|never|must\s+not|forbid|forbidden)`
  const action = String.raw`(?:调用|使用|执行|走|用|call|use|invoke|run)`
  return new RegExp(`${forbid}[\\s\\S]{0,40}${action}[\\s\\S]{0,30}\\b${name}\\b`, 'i').test(text)
    || new RegExp(`\\b${name}\\b[\\s\\S]{0,40}(?:is\\s+)?(?:forbidden|not\\s+allowed|禁止|禁用|不可用)`, 'i').test(text)
    || new RegExp(`(?:禁止|禁用)[\\s\\S]{0,30}\\b${name}\\b`, 'i').test(text)
}

export function resolveStrictEvaluationMode(message = '', options = {}) {
  const text = String(message || '')
  const explicit = options.strictEvaluation ?? options.strict_evaluation ?? options.enabled
  const explicitMode = String(options.evaluationMode || options.evaluation_mode || '').toLowerCase()
  const forbidden = new Set(normalizeToolList(options.forbiddenTools || options.forbidden_tools || []))

  for (const name of COMMON_TOOL_NAMES) {
    if (text.includes(name) && hasForbidNearTool(text, name)) forbidden.add(name)
  }

  const noRepair = !!options.noRepair
    || hasNoRepairMarker(text)
  if (noRepair) {
    for (const name of REPAIR_TOOLS) forbidden.add(name)
  }

  const active = explicit === true
    || explicit === 'true'
    || explicitMode === 'strict'
    || hasStrictMarker(text)
    || forbidden.size > 0

  return {
    active,
    source: explicit === true || explicit === 'true' || explicitMode === 'strict'
      ? 'api'
      : (hasStrictMarker(text) ? 'prompt' : (forbidden.size > 0 ? 'constraints' : 'none')),
    noRepair: active && noRepair,
    forbiddenTools: [...forbidden].sort(),
  }
}

export function isStrictEvaluationActive(strictEvaluation) {
  return !!strictEvaluation?.active
}

export function isToolForbiddenInStrictEvaluation(strictEvaluation, toolName) {
  if (!isStrictEvaluationActive(strictEvaluation)) return false
  const name = normalizeToolName(toolName)
  if (!name) return false
  return normalizeToolList(strictEvaluation.forbiddenTools).includes(name)
}

export function filterStrictEvaluationTools(tools = [], strictEvaluation = null) {
  if (!isStrictEvaluationActive(strictEvaluation)) return Array.isArray(tools) ? [...tools] : []
  return (Array.isArray(tools) ? tools : []).filter(name => !isToolForbiddenInStrictEvaluation(strictEvaluation, name))
}

export function buildStrictEvaluationContext(strictEvaluation = {}) {
  if (!isStrictEvaluationActive(strictEvaluation)) return ''
  const forbidden = normalizeToolList(strictEvaluation.forbiddenTools)
  const forbiddenText = forbidden.length ? forbidden.join(', ') : '(none)'
  return [
    '[strict evaluation mode]',
    `Forbidden tools this turn: ${forbiddenText}.`,
    'Obey the user/test constraints exactly. If an allowed action fails, do not switch to a forbidden tool.',
    strictEvaluation.noRepair
      ? 'Repair mode is disabled for this turn: do not propose, review, install, or rewrite tools to recover. Report the strict-evaluation failure instead.'
      : 'If a forbidden tool seems necessary, report that the requested strict constraints prevent continuing.',
  ].join('\n')
}

export function makeStrictForbiddenToolResult(toolName, strictEvaluation = {}) {
  return JSON.stringify({
    ok: false,
    tool: toolName,
    skipped: 'strict_evaluation_forbidden_tool',
    error: 'strict evaluation mode forbids this tool',
    forbidden_tools: normalizeToolList(strictEvaluation.forbiddenTools),
    instruction: strictEvaluation.noRepair
      ? 'Do not self-repair or try another prohibited path. Report the strict-evaluation failure to the user/test harness.'
      : 'Do not call this forbidden tool. Continue only with allowed tools, or report that the strict constraints block completion.',
  }, null, 2)
}
