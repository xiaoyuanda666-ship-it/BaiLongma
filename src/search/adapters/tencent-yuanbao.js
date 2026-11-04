import { postModelJSON } from '../http.js'

export const yuanbaoWebAdapter = {
  id: 'tencent-yuanbao',
  capabilities: { search: true, fetch: false, page_content: false, date_filter: 'postfilter', domain_filter: true, max_native_domains: 1 },
  async search(connection, request, context) {
    const body = { Query: request.query }
    // Basic query works with every subscription tier, including lite.
    if (request.domains.length === 1) body.Site = request.domains[0]
    const data = await postModelJSON(connection, 'SearchPro', body, context)
    if (!Array.isArray(data?.Response?.Pages)) throw new Error('元宝搜索未返回 Pages 数组')
    const warnings = []
    const results = data.Response.Pages.flatMap(value => {
      let page
      try { page = typeof value === 'string' ? JSON.parse(value) : value } catch {
        warnings.push('元宝返回了一条无法解析的结果，已跳过。'); return []
      }
      if (!page || typeof page !== 'object') return []
      // Tencent calls content a dynamic snippet, not full page content.
      return [{ title: page.title, url: page.url, summary: page.content || page.passage || '',
        date: page.date, site_name: page.site, rerank_score: page.score, authority: page.authority_level }]
    })
    if (request.need_content) warnings.push('元宝返回搜索摘要，不返回网页全文。需要原文时请使用浏览器技能。')
    if (request.date_from || request.date_to) warnings.push('日期范围由本地结果过滤；无时区的发布日期保留为未知，返回结果不保证覆盖整个日期范围。')
    if (request.domains.length > 1) warnings.push('元宝原生仅支持一个包含域名；本次多个域名在返回结果中本地过滤，可能减少结果数。')
    if (results.length < request.count) warnings.push('服务返回数量少于请求数量；不同元宝套餐的结果数量可能不同。')
    return { results, summary: '', warnings }
  },
}
