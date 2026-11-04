import { modelWebTools } from '../providers/model-web.js'
import { callLLM } from '../llm.js'
import { searchAdditionalMemories, formatMemoriesForPrompt } from './injector.js'

const WEB_KEYWORDS = /最新|实时|今天|昨天|明天|news|price|股价|天气|汇率|价格/i

const ROUND3_SEARCH_PROMPT = `Use web_search for fresh public information through the configured model provider. Cite source URLs and check dates. Do not invent results if search is unavailable or fails. Browser interaction belongs to the main agent's bsk skill, not this background memory refresh.`

function buildEvalPrompt(formattedMemories, query, { round = 1, prevMissing = [] } = {}) {
  const memSnippet = formattedMemories.slice(0, 1500)
  const roundHint = round === 1
    ? `This is evaluation round 1, judging from the memory fragments currently available.`
    : `This is evaluation round ${round}. The information gaps identified in round ${round - 1} were: ${prevMissing.map(m => `"${m}"`).join(', ') || '(none)'}.\nThis round has injected additional memory fragments retrieved specifically for those gaps; use these new memories to re-evaluate in a targeted way.`
  return `You are a memory-evaluation assistant. ${roundHint} Based on the provided memory fragments, evaluate how well the following question can be answered, and output JSON.

Existing memories:
${memSnippet}

Question: ${query}

Output only JSON in the following format, nothing else:
{"confidence":"low"|"medium"|"high","missing":["missing info 1","missing info 2"]}`
}

function parseEvalResult(content) {
  try {
    const match = content.match(/\{[\s\S]*?\}/)
    if (!match) throw new Error('no json')
    const parsed = JSON.parse(match[0])
    return {
      confidence: ['low', 'medium', 'high'].includes(parsed.confidence) ? parsed.confidence : 'medium',
      missing: Array.isArray(parsed.missing) ? parsed.missing : [],
    }
  } catch {
    return { confidence: 'medium', missing: [] }
  }
}

export async function runMemoryRefreshLoop({ originalQuery, baseMemories, systemPromptBase, formattedBaseMemories, signal, maxRounds = 3 }) {
  if (!originalQuery || !originalQuery.trim()) {
    return { additionalMemories: [], round3Results: '', roundsRun: 0, skipped: true, confidence: null }
  }

  const effectiveMaxRounds = Math.max(1, Math.min(3, Number.isFinite(maxRounds) ? maxRounds : 3))

  let additionalMemories = []
  let round3Results = ''

  // 第1轮
  console.log('[记忆刷新] 第1轮 评估已有记忆覆盖度')
  let eval1 = { confidence: 'medium', missing: [] }
  try {
    if (signal?.aborted) return { additionalMemories, round3Results, roundsRun: 1, skipped: false, confidence: eval1.confidence }
    const sp1 = buildEvalPrompt(formattedBaseMemories, originalQuery, { round: 1 })
    const res1 = await callLLM({ systemPrompt: sp1, message: '请评估', maxTokens: 80, thinking: false, tools: [] })
    eval1 = parseEvalResult(res1.content || '')
  } catch (e) {
    console.log('[记忆刷新] 第1轮 LLM 调用失败:', e.message)
  }

  if (eval1.confidence === 'high' || effectiveMaxRounds < 2) {
    return { additionalMemories, round3Results, roundsRun: 1, skipped: false, confidence: eval1.confidence }
  }

  // 第2轮：直接用第1轮识别的 missing 项作为搜索词（这才是"涌现的缺口概念"）
  console.log('[记忆刷新] 第2轮 针对缺口追加记忆召回')
  let eval2 = { confidence: 'medium', missing: eval1.missing }
  try {
    if (signal?.aborted) return { additionalMemories, round3Results, roundsRun: 2, skipped: false, confidence: eval2.confidence }
    const searchTerms = eval1.missing.slice(0, 6)
    if (searchTerms.length > 0) {
      const excludeIds = new Set(baseMemories.map(m => m.id))
      const newMemories = searchAdditionalMemories(searchTerms, excludeIds)
      if (newMemories.length > 0) {
        additionalMemories = newMemories
        const combinedFormatted = formattedBaseMemories + '\n\n' + formatMemoriesForPrompt([], newMemories)
        const sp2 = buildEvalPrompt(combinedFormatted, originalQuery, { round: 2, prevMissing: eval1.missing })
        const res2 = await callLLM({ systemPrompt: sp2, message: '请评估', maxTokens: 80, thinking: false, tools: [] })
        eval2 = parseEvalResult(res2.content || '')
      }
    }
  } catch (e) {
    console.log('[记忆刷新] 第2轮 LLM 调用失败:', e.message)
  }

  if (eval2.confidence === 'high' || effectiveMaxRounds < 3) {
    return { additionalMemories, round3Results, roundsRun: 2, skipped: false, confidence: eval2.confidence }
  }

  // 第3轮
  console.log('[记忆刷新] 第3轮 针对 missing 发起外部查询')
  const missingItems = eval2.missing.slice(0, 3)
  const parts = []
  for (const item of missingItems) {
    if (signal?.aborted) break
    try {
      const needsWeb = WEB_KEYWORDS.test(item)
      const toolNames = needsWeb ? modelWebTools() : ['search_memory']
      const res3 = await callLLM({
        systemPrompt: ROUND3_SEARCH_PROMPT,
        message: `请搜索：${item}`,
        maxTokens: 600,
        thinking: false,
        tools: toolNames,
        signal,
      })
      const rawResult = (res3.toolResult?.result || res3.content || '').slice(0, 600)
      if (rawResult) parts.push(rawResult)
    } catch (e) {
      console.log(`[记忆刷新] 第3轮 "${item}" 查询失败:`, e.message)
    }
  }
  round3Results = parts.join('\n---\n')

  return { additionalMemories, round3Results, roundsRun: 3, skipped: false, confidence: eval2.confidence }
}
