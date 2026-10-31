import { postModelJSON } from '../model-http.js'

function endpoint(connection, action) {
  return /\/v1\/?$/.test(connection.baseURL) ? `tools/${action}` : `v1/tools/${action}`
}

export const deepseekWebAdapter = {
  id: 'deepseek',
  capabilities: { search: true, fetch: true, page_content: true, date_filter: 'query', domain_filter: true },
  async search(connection, request, context) {
    const { query, count, need_content, original_question, date_from, date_to, domains } = request
    // Broaden by one day: providers do not define the timezone/boundary semantics
    // of after/before. The shared layer checks returned dates in the user's zone.
    const shift = (day, delta) => new Date(Date.parse(`${day}T00:00:00Z`) + delta * 86400000).toISOString().slice(0, 10)
    const effectiveQuery = [query,
      date_from && `after:${shift(date_from, -1)}`,
      date_to && `before:${shift(date_to, 1)}`,
      domains.length && domains.map(domain => `site:${domain}`).join(' OR '),
    ].filter(Boolean).join(' ')
    if ([...effectiveQuery].length > 128) throw new Error('DeepSeek 搜索词（含日期和站点条件）不能超过 128 个 Unicode 字符，请缩短关键词')
    const body = { query: effectiveQuery, count, need_content }
    if (original_question) body.ori_question = [...original_question].slice(0, 128).join('')
    const data = await postModelJSON(connection, endpoint(connection, 'search'), body, context)
    if (!Array.isArray(data?.results)) throw new Error('搜索服务未返回 results 数组')
    return { results: data.results, summary: '', effective_query: effectiveQuery }
  },
  async fetch(connection, url, context) {
    const data = await postModelJSON(connection, endpoint(connection, 'fetch'), { url }, context)
    if (typeof data?.content !== 'string' || !data.content.trim()) throw new Error('网页服务没有返回正文')
    return { title: data.title, content: data.content }
  },
}
