// Query construction, retrieval gating, and deterministic light-weight reranking.

const GREETING_RE = /^(?:hi|hello|hey|thanks?|thank you|ok|okay|yes|no|你好|嗨|哈喽|谢谢|好的?|嗯|是的?|不是|拜拜)[!！,.，。\s]*$/i
const KNOWLEDGE_SIGNAL_RE = /(?:document|docs?|manual|policy|contract|spec(?:ification)?|report|file|folder|source|reference|knowledge|资料|文档|文件|手册|制度|规范|合同|报告|表格|知识库|根据.*(?:资料|文档)|查(?:一下|找一下)|第\s*\d+\s*(?:页|条|章))/i

function textOf(value) {
  if (typeof value === 'string') return value.trim()
  if (value && typeof value === 'object') return String(value.content || value.title || value.description || '').trim()
  return ''
}

/** Build a bounded semantic query from user wording plus the active task's stated goal. */
export function buildKnowledgeQuery({ query = '', task = '', hint = '', maxChars = 1600 } = {}) {
  const parts = [textOf(query), textOf(task), textOf(hint)].filter(Boolean)
  const seen = new Set()
  const unique = parts.filter(part => {
    const key = part.toLocaleLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return unique.join('\n').replace(/\s+/g, ' ').trim().slice(0, Math.max(100, Number(maxChars) || 1600))
}

/**
 * Avoid spending retrieval work on acknowledgements, but allow questions and explicit
 * document references whenever at least one knowledge region is active.
 */
export function shouldRetrieveKnowledge({ query = '', task = '', hasActiveRegion = false } = {}) {
  if (!hasActiveRegion) return false
  const prompt = buildKnowledgeQuery({ query, task, maxChars: 2000 })
  const message = textOf(query)
  if (!prompt || GREETING_RE.test(message)) return false
  if (KNOWLEDGE_SIGNAL_RE.test(prompt)) return true
  if (/[?？]/.test(message)) return true
  // Active tasks commonly ask imperative follow-ups without a question mark.
  return Boolean(textOf(task)) && message.length >= 12
}

function queryTerms(query = '') {
  const words = String(query).toLocaleLowerCase().match(/[a-z0-9_]{2,}|[\u3400-\u9fff]{2,}/g) || []
  return [...new Set(words)].slice(0, 24)
}

/**
 * A transparent, dependency-free second-pass ranking.  It combines an upstream score
 * (vector/BM25) with literal coverage from title, context, and chunk text.
 */
export function rerankEvidence(results = [], { query = '', limit = 8 } = {}) {
  const terms = queryTerms(query)
  return (Array.isArray(results) ? results : []).map((result, index) => {
    const corpus = [result.document_title, result.title, result.context, result.chunk_text, result.text].filter(Boolean).join(' ').toLocaleLowerCase()
    const matched = terms.filter(term => corpus.includes(term)).length
    const lexical = terms.length ? matched / terms.length : 0
    const upstream = Number(result.rerank_score ?? result.score ?? result.similarity ?? 0)
    return { ...result, rerank_score: upstream * 0.7 + lexical * 0.3, _knowledge_original_index: index }
  }).sort((a, b) => b.rerank_score - a.rerank_score || a._knowledge_original_index - b._knowledge_original_index)
    .slice(0, Math.max(1, Number(limit) || 8))
    .map(({ _knowledge_original_index, ...result }) => result)
}
