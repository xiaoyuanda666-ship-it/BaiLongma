import { getSearchSettings, resolveSearchConnection } from './connections.js'
import { selectSearchRoute } from './router.js'
import { normalizeWebSearchRequest, searchModelWeb } from './normalize.js'
import { WEB_ADAPTERS } from './registry.js'
import { redactModelSecret } from '../providers/model-http.js'
import { throwIfAborted } from '../capabilities/abort-utils.js'

export function getModelWebConnection(args = {}) {
  const route = selectSearchRoute(getSearchSettings(), args)
  return resolveSearchConnection(route.connections[0])
}
export function modelWebTools() {
  return getSearchSettings().connections.some(item => item.enabled && item.configured) ? ['web_search'] : []
}
export async function execModelWeb(name, args = {}, context = {}) {
  throwIfAborted(context.signal)
  if (name !== 'web_search') return JSON.stringify({ ok: false, tool: name, error: 'unknown_tool' })
  const attempts = []
  try {
    normalizeWebSearchRequest(args, context) // Invalid requests never trigger provider failover.
    if (args.require_content !== undefined && typeof args.require_content !== 'boolean') throw new Error('require_content 必须为布尔值')
    if (args.language !== undefined && !['zh', 'en'].includes(args.language)) throw new Error('language 必须是 zh 或 en')
    if (args.topic !== undefined && !['general', 'news', 'technical', 'academic'].includes(args.topic)) throw new Error('topic 无效')
    const route = selectSearchRoute(getSearchSettings(), args, context)
    if (!route.connections.length) return JSON.stringify({ ok: false, tool: name, error: 'not_configured', guide: '请在设置 → 搜索服务中启用或添加搜索连接。' })
    for (const [index, item] of route.connections.entries()) {
      throwIfAborted(context.signal)
      let connection
      try {
        connection = resolveSearchConnection(item)
        if (!connection) throw new Error('not_configured')
        if (args.require_content && !WEB_ADAPTERS[item.adapter].capabilities.page_content) throw new Error('此服务不支持返回网页正文')
        const result = await searchModelWeb(connection, { ...args, need_content: args.require_content || args.need_content }, context)
        throwIfAborted(context.signal)
        if (args.require_content && !result.results.some(item => item.content?.trim())) throw new Error('搜索未取得要求的网页正文')
        attempts.push({ provider: item.id, status: 'success' })
        return redactModelSecret(JSON.stringify({ ok: true, tool: name, ...result, adapter: item.adapter,
          provider: item.id, selection_reason: route.reason, fallback_used: index > 0, attempts }), connection.apiKey)
      } catch (error) {
        throwIfAborted(context.signal)
        const message = redactModelSecret(error.message, connection?.apiKey)
        attempts.push({ provider: item.id, status: 'error', error: message })
        if (!error.retryable || index === route.connections.length - 1) return JSON.stringify({ ok: false, tool: name,
          provider: item.id, error: message, retryable: !!error.retryable, selection_reason: route.reason, attempts })
      }
    }
  } catch (error) {
    throwIfAborted(context.signal)
    return JSON.stringify({ ok: false, tool: name, error: error.message, attempts })
  }
}
