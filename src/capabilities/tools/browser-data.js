import { isExplicitAgentBrowserDataDeletionRequest } from '../../mcp/browser-data-intent.js'
import { shutdownBuiltInChrome } from '../../mcp/client-manager.js'

const ALLOWED_DATA_TYPES = new Set(['history', 'cookies', 'site_data', 'cache'])
const ALLOWED_TIME_RANGES = new Set([
  'last_hour',
  'last_day',
  'last_7_days',
  'last_30_days',
  'all_time',
  'custom',
])

function failure(code, error) {
  return JSON.stringify({ ok: false, tool: 'browser_clear_data', code, error }, null, 2)
}

function normalizeArguments(args = {}) {
  const rawTypes = Array.isArray(args.data_types) ? args.data_types : []
  const dataTypes = [...new Set(rawTypes.map(value => String(value || '').trim().toLowerCase()))]
  if (!dataTypes.length || dataTypes.some(value => !ALLOWED_DATA_TYPES.has(value))) {
    throw new TypeError('data_types must contain one or more of: history, cookies, site_data, cache')
  }
  const timeRange = String(args.time_range || '').trim().toLowerCase()
  if (!ALLOWED_TIME_RANGES.has(timeRange)) {
    throw new TypeError('time_range must be last_hour, last_day, last_7_days, last_30_days, all_time, or custom')
  }
  if (timeRange === 'custom' && !String(args.since || '').trim()) {
    throw new TypeError('since is required when time_range is custom')
  }
  if (timeRange !== 'all_time') {
    const error = new Error('BaiLongma dedicated Chrome data can only be cleared as all_time; it never accesses the user\'s default Chrome profile.')
    error.code = 'PROFILE_TIME_RANGE_UNSUPPORTED'
    throw error
  }
  if (timeRange === 'custom') {
    const since = Date.parse(String(args.since))
    const before = args.before ? Date.parse(String(args.before)) : Date.now()
    if (!Number.isFinite(since) || !Number.isFinite(before) || since >= before) {
      throw new TypeError('custom since/before must be valid ISO-8601 timestamps with since earlier than before')
    }
  }
  const origins = Array.isArray(args.origins) ? args.origins.map(value => {
    const parsed = new URL(String(value || ''))
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new TypeError('origins must contain only HTTP(S) origins')
    return parsed.origin
  }) : null
  return {
    dataTypes,
    timeRange,
    ...(args.since ? { since: String(args.since) } : {}),
    ...(args.before ? { before: String(args.before) } : {}),
    ...(origins ? { origins: [...new Set(origins)] } : {}),
  }
}

export async function execBrowserClearData(args = {}, context = {}) {
  if (!isExplicitAgentBrowserDataDeletionRequest(context.currentUserMessage || '')) {
    return failure(
      'EXPLICIT_USER_REQUEST_REQUIRED',
      'Only an explicit current user request to delete Bailongma/Agent built-in browser data can authorize this tool.',
    )
  }

  let request
  try { request = normalizeArguments(args) } catch (error) {
    return failure(error?.code || 'INVALID_ARGUMENTS', error?.message || String(error))
  }

  const bridge = context.browserDataBridge || globalThis.bailongmaChromeBridge
  if (!bridge || typeof bridge.closePage !== 'function' || typeof bridge.clearData !== 'function') {
    return failure('BROWSER_DATA_BRIDGE_UNAVAILABLE', 'The built-in browser data service is unavailable.')
  }

  const shutdown = context.shutdownBuiltInChromeFn || shutdownBuiltInChrome
  try {
    // Detach only BaiLongma's DevTools MCP before removing its dedicated
    // profile. The user's system/default Chrome is never a target here.
    await shutdown()
    await bridge.closePage()
    const cleared = await bridge.clearData(request)
    return JSON.stringify({
      ok: true,
      tool: 'browser_clear_data',
      authorization: 'explicit_current_user_request',
      browser_page_closed: true,
      ...cleared,
      browser_preview: {
        mode: context.browserDisplayState?.mode === 'window'
          ? 'window'
          : (context.browserDisplayState?.mode === 'card' ? 'card' : ''),
        state: 'closed',
        action: 'browser_clear_data',
        renderer: 'webcontentsview',
        surface: 'bailongma_live_browser',
      },
    }, null, 2)
  } catch (error) {
    return failure(error?.code || 'CLEAR_FAILED', error?.message || String(error))
  }
}

export const __internal = { normalizeArguments }
