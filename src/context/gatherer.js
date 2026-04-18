/**
 * 上下文采集器 — 执行前充分性检查循环
 *
 * 流程：
 *   检查 → 不够 → 解决 needs → 再检查 → 直到够了或达到 MAX_ROUNDS
 *
 * 每轮 LLM 输出：
 *   { "sufficient": true }
 *   { "sufficient": false, "needs": [{ "type": "read_file"|"search_memory"|"recall", ... }] }
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { callLLM } from '../llm.js'
import { searchMemories } from '../db.js'
import { extractJSON } from '../utils.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SANDBOX_ROOT = path.resolve(__dirname, '../../sandbox')

const MAX_ROUNDS = 3
const FILE_PREVIEW_CHARS = 2000  // 文件内容截断长度

const CHECKER_PROMPT = `你是上下文充分性检查器。判断当前注入的知识和经验是否足以处理任务的下一步。

【输出规则】
- 只输出 JSON，不输出任何其他内容
- 如果上下文已足够，输出：{"sufficient":true}
- 如果不够，输出：{"sufficient":false,"needs":[...]}

【needs 类型】
- {"type":"read_file","path":"相对路径"} — 需要读取某个文件的内容
- {"type":"search_memory","keyword":"关键词"} — 需要搜索记忆中的相关信息
- {"type":"recall","query":"查询内容"} — 需要回忆某个具体概念或经验

【判断原则】
- 任务涉及修改/调用某文件或函数，但不知道其结构 → 需要 read_file
- 任务依赖某个之前学到的知识但当前上下文没有 → 需要 search_memory
- 任务涉及某个具体概念/决策但不确定 → 需要 recall
- 已有足够信息可以直接动手 → sufficient: true
- 最多输出 3 个 needs，挑最关键的
- 宁可 sufficient: true 少取，也不要无限循环取文件`

/**
 * 主入口：采集足够上下文后返回 extraContext 数组
 * @param {object} params
 * @param {string} params.task       当前任务描述
 * @param {string} params.taskKnowledge  已有任务知识（格式化文本）
 * @param {string} params.memories   已有记忆摘要
 * @param {string} params.message    当前处理的输入（TICK 或消息）
 * @returns {Array} extraContext — 每项 { type, label, content }
 */
export async function gatherContext({ task, taskKnowledge, memories, message }) {
  if (!task) return []

  const extraContext = []

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const checkResult = await checkSufficiency({ task, taskKnowledge, memories, message, extraContext })

    if (!checkResult || checkResult.sufficient !== false) break

    const needs = checkResult.needs || []
    if (needs.length === 0) break

    let resolved = 0
    for (const need of needs) {
      const item = await resolveNeed(need, extraContext)
      if (item) {
        extraContext.push(item)
        resolved++
      }
    }

    // 本轮没有解决任何 need，停止避免死循环
    if (resolved === 0) break
  }

  return extraContext
}

async function checkSufficiency({ task, taskKnowledge, memories, message, extraContext }) {
  const extraSection = extraContext.length > 0
    ? '\n\n已补充上下文：\n' + extraContext.map(c => `[${c.label}]\n${c.content.slice(0, 500)}`).join('\n')
    : ''

  const input = `当前任务：
${task}

当前输入：
${message.slice(0, 300)}

任务知识库：
${taskKnowledge || '（空）'}

记忆摘要：
${memories || '（空）'}${extraSection}

请判断：以上信息是否足以处理任务的当前步骤？`

  let raw
  try {
    const result = await callLLM({
      systemPrompt: CHECKER_PROMPT,
      message: input,
      temperature: 0.1,
    })
    raw = result.content
  } catch (err) {
    console.error('[采集器] 充分性检查失败:', err.message)
    return { sufficient: true }  // 出错时放行，不阻塞主流程
  }

  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const parsed = extractJSON(cleaned, 'object')
  return parsed || { sufficient: true }
}

async function resolveNeed(need, existingContext) {
  const alreadyHave = existingContext.some(c => c.source === needKey(need))
  if (alreadyHave) return null

  if (need.type === 'read_file') {
    return resolveFileRead(need.path)
  }

  if (need.type === 'search_memory') {
    return resolveMemorySearch(need.keyword)
  }

  if (need.type === 'recall') {
    return resolveMemorySearch(need.query)
  }

  return null
}

function needKey(need) {
  return `${need.type}:${need.path || need.keyword || need.query || ''}`
}

function resolveFileRead(filePath) {
  if (!filePath) return null

  // 规范化：去掉 sandbox/ 前缀
  const normalized = filePath.replace(/^sandbox[\\/]/, '')
  const absPath = path.resolve(SANDBOX_ROOT, normalized)

  // 沙盒边界检查
  if (!absPath.startsWith(SANDBOX_ROOT)) {
    console.warn(`[采集器] 拒绝读取沙盒外文件: ${filePath}`)
    return null
  }

  try {
    const raw = fs.readFileSync(absPath, 'utf-8')
    const preview = raw.length > FILE_PREVIEW_CHARS
      ? raw.slice(0, FILE_PREVIEW_CHARS) + `\n…（已截断，共 ${raw.length} 字符）`
      : raw
    console.log(`[采集器] 读取文件: ${normalized} (${raw.length} chars)`)
    return {
      type: 'file',
      label: `文件 ${normalized}`,
      source: `read_file:${filePath}`,
      content: preview,
    }
  } catch (err) {
    console.warn(`[采集器] 读取失败 ${filePath}: ${err.message}`)
    return null
  }
}

function resolveMemorySearch(keyword) {
  if (!keyword) return null
  const results = searchMemories(keyword, 5)
  if (!results.length) return null

  console.log(`[采集器] 搜索记忆 "${keyword}": ${results.length} 条`)
  return {
    type: 'memory',
    label: `记忆搜索「${keyword}」`,
    source: `search_memory:${keyword}`,
    content: results.map(m => `- ${m.content}\n  ${m.detail}`).join('\n'),
  }
}

/**
 * 将 extraContext 数组格式化为可注入系统提示词的文本
 */
export function formatExtraContext(extraContext = []) {
  if (!extraContext.length) return ''
  return extraContext.map(c => `### ${c.label}\n${c.content}`).join('\n\n')
}
