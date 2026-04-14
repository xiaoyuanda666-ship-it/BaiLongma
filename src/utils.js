// 从 LLM 输出中提取 JSON，兼容 <think> 标签和 markdown 代码块
export function extractJSON(raw, type = 'object') {
  if (!raw) return null

  // 去掉 <think>...</think> 块
  const withoutThink = raw.replace(/<think>[\s\S]*?<\/think>/g, '')

  // 尝试从 ```json ... ``` 代码块里提取
  const codeBlockMatch = withoutThink.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim())
    } catch {}
  }

  // 直接匹配 JSON 数组或对象
  const pattern = type === 'array' ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/
  const match = withoutThink.match(pattern)
  if (match) {
    try {
      return JSON.parse(match[0])
    } catch {}
  }

  return null
}
