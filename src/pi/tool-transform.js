// 纯工具 schema 转换 + 结果归一，零依赖（不引入 Pi / executor / db），
// 便于在纯 node 下单测。被 src/pi/tool-bridge.js 复用（buildPiTools 再包一层 Pi defineTool）。
// 见 .claude/plans/pi-sdk-turn-engine-migration-m3.plan.md Slice 1。

// executeTool 的结果（string 或 JSON 字符串）归一成 Pi customTool 的返回形状。
// 错误结果（中文错误前缀 / {ok:false}）标 isError，让模型看到失败而非误判成功。
// 与 src/index.js runTurn 的 onToolCall 里 ok 判定用同一组前缀，保持语义一致。
const ERROR_RE = /^(错误|请求失败|执行失败|命令超时|命令执行失败|error|failed|execution failed|command timed out)/i

export function normalizeToolResult(raw) {
  const text = typeof raw === 'string'
    ? raw
    : (raw?.content?.[0]?.text ?? JSON.stringify(raw))
  let isError = false
  const trimmed = String(text).trim()
  if (ERROR_RE.test(trimmed)) isError = true
  else {
    try { if (JSON.parse(trimmed)?.ok === false) isError = true } catch { /* 非 JSON，按成功处理 */ }
  }
  return { content: [{ type: 'text', text }], details: {}, isError }
}

// BaiLongma schema = { type:'function', function:{ name, description, parameters:{...} } }
// → 纯定义 { name, label, description, parameters, execute }（execute 转发注入的 executeTool）。
// executeTool 必须由调用方注入（桥注入真实 executor，测试注入 mock），本模块不持有运行时依赖。
export function toToolDefinition(schema, context = {}, executeTool) {
  const fn = schema?.function || schema
  const name = fn?.name
  if (!name) throw new Error('工具 schema 缺少 function.name')
  const parameters = fn?.parameters || { type: 'object', properties: {}, additionalProperties: false }
  return {
    name,
    label: name,
    description: fn?.description || name,
    parameters,
    // Pi 调用签名 = execute(toolCallId, params, signal, onUpdate, ctx)；真正的工具参数在第 2 位
    // （PoC 用空参工具没暴露这点，嵌套参数 smoke 才发现——见 pi-agent-core ToolDefinition）。
    // params 已按 parameters schema 校验过，直接转发给 executeTool。
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const raw = await executeTool(name, params || {}, context)
      return normalizeToolResult(raw)
    },
  }
}
