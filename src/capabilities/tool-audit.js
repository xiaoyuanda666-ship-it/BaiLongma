import { insertActionLog } from '../db.js'
import { emitEvent } from '../events.js'
import { classifyTool } from './tool-policy.js'
import { previewValue, safeJsonStringify } from './tool-utils.js'

function getExecutionSource(context = {}) {
  return context.source || context.trigger || (context.autonomous ? 'autonomous' : 'llm')
}
export function summarizeToolExecution(name, args = {}) {
  switch (name) {
    case 'read_file':
      return `read_file(${args.path || args.filename || args.file_path || '?'})`
    case 'list_dir':
      return `list_dir(${args.path || args.dir || args.directory || '.'})`
    case 'write_file':
      return `write_file(${args.path || args.filename || args.file_path || '?'})`
    case 'delete_file':
      return `delete_file(${args.path || args.filename || args.file_path || '?'})`
    case 'make_dir':
      return `make_dir(${args.path || args.dir || args.directory || '?'})`
    case 'exec_command':
      return `exec_command(${String(args.command || args.cmd || '?').slice(0, 100)})`
    case 'install_software':
      return `install_software(${String(args.query || args.package_id || args.job_id || '?').slice(0, 100)})`
    case 'fetch_url':
    case 'browser_read':
      return `${name}(${String(args.url || args.link || args.href || '?').slice(0, 120)})`
    case 'web_search':
      return `web_search(${String(args.query || args.q || args.keyword || '?').slice(0, 120)})`
    case 'browser_open':
      return `browser_open(${String(args.url || 'about:blank').slice(0, 120)})`
    case 'browser_sessions':
      return 'browser_sessions()'
    case 'browser_inspect':
    case 'browser_tabs':
    case 'browser_close':
      return `${name}(session=${String(args.session_id || '?').slice(0, 80)})`
    case 'browser_act':
      return `browser_act(session=${String(args.session_id || '?').slice(0, 80)}, action=${String(args.action || '?').slice(0, 30)})`
    case 'send_message':
    case 'express':
      return `${name} -> ${args.target_id || '(unknown)'}`
    case 'upsert_memory': {
      const count = Array.isArray(args.memories) ? args.memories.length : 0
      return `upsert_memory(${count})`
    }
    default:
      return name
  }
}

const SENSITIVE_ARG_KEY_RE = /(?:api[_-]?key|apikey|access[_-]?key|secret|token|password|authorization|bearer)/i
const SECRET_VALUE_RE = /\b(?:sk|ak|rk|pk)-[A-Za-z0-9_\-.]{12,180}\b/g

function redactAuditValue(value) {
  if (typeof value === 'string') return value.replace(SECRET_VALUE_RE, '[redacted]')
  if (Array.isArray(value)) return value.map(redactAuditValue)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_ARG_KEY_RE.test(key) ? '[redacted]' : redactAuditValue(item)
  }
  return out
}

export function sanitizeToolAuditArgs(name, args = {}) {
  const redacted = redactAuditValue(args)
  if (name !== 'browser_act' || !redacted || typeof redacted !== 'object') return redacted
  const safe = { ...redacted }
  // Form text can be a password, token, personal data, or arbitrary prose. It
  // must never reach args_json/detail even when the key is merely "value".
  if (Object.prototype.hasOwnProperty.call(safe, 'value')) safe.value = '[redacted]'
  if (Object.prototype.hasOwnProperty.call(safe, 'values')) safe.values = '[redacted]'
  return safe
}

function safeResultPreview(name, result, error) {
  if (name !== 'browser_act') return previewValue(result || error, 220)
  try {
    const parsed = JSON.parse(String(result || '{}'))
    return previewValue({
      ok: parsed.ok,
      code: parsed.code,
      session_id: parsed.session_id,
      page_id: parsed.page_id,
      action: parsed.action,
    }, 220)
  } catch {
    return error ? 'browser action failed' : ''
  }
}

export function inferToolStatus(result) {
  const text = String(result ?? '').trim()
  if (!text) return 'ok'
  try {
    const parsed = JSON.parse(text)
    return parsed?.ok === false ? 'error' : 'ok'
  } catch {}
  return /^(错误|请求失败|执行失败|命令超时|命令执行失败|閿欒|璇锋眰澶辫触|鎵ц澶辫触|鍛戒护瓒呮椂|鍛戒护鎵ц澶辫触)/.test(text) ? 'error' : 'ok'
}

export function writeToolAuditLog({ name, args, context, policy, status, result = '', error = '', startedAt }) {
  const record = buildToolAuditRecord({ name, args, context, policy, status, result, error, startedAt })

  try {
    insertActionLog(record)
  } catch (err) {
    console.warn(`[audit] failed to persist tool audit log: ${err.message}`)
  }

  emitEvent('tool_audit', {
    tool: name,
    status,
    risk: policy?.risk || classifyTool(name),
    summary: record.summary,
    duration_ms: record.durationMs,
    source: record.source,
  })
}

export function buildToolAuditRecord({ name, args, context, policy, status, result = '', error = '', startedAt }) {
  const durationMs = Date.now() - startedAt
  const detailParts = []
  if (policy?.reason) detailParts.push(`policy=${policy.reason}`)
  const auditArgs = sanitizeToolAuditArgs(name, args)
  const argPreview = previewValue(auditArgs, 160)
  if (argPreview && argPreview !== '{}') detailParts.push(`args=${argPreview}`)
  const resultPreview = safeResultPreview(name, result, error)
  if (resultPreview) detailParts.push(`result=${resultPreview}`)

  return {
      timestamp: new Date(startedAt).toISOString(),
      tool: name,
      summary: summarizeToolExecution(name, auditArgs),
      detail: detailParts.join(' | '),
      status,
      risk: policy?.risk || classifyTool(name),
      argsJson: safeJsonStringify(auditArgs),
      resultPreview,
      error: name === 'browser_act' && error ? 'browser action failed' : error,
      durationMs,
      source: getExecutionSource(context),
  }
}
