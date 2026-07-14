// 通用工具桥：把 BaiLongma 的 TOOL_SCHEMAS（OpenAI function-call 形状）运行时转成
// Pi SDK 的 defineTool[]。每个 customTool 的 execute 转发既有 executeTool(name,args,context)，
// 复用 BaiLongma 全部工具实现（沙箱 / 审计 / 策略 / 市场），不逐工具手写。
// 见 .claude/plans/pi-sdk-turn-engine-migration-m3.plan.md Slice 1。
import { defineTool } from '@earendil-works/pi-coding-agent'
import { getToolSchemas } from '../capabilities/schemas.js'
import { executeTool as defaultExecuteTool } from '../capabilities/executor.js'
// 纯转换逻辑（零依赖，可在纯 node 下单测）实现在 tool-transform.js。
import { toToolDefinition, normalizeToolResult } from './tool-transform.js'

// 纯逻辑透传，便于上层单点引用。
export { normalizeToolResult }

// 主入口：toolNames（string[]）+ context → Pi defineTool[]。
// executeTool 可注入（测试用 mock）；默认走真实 executor（含沙箱 / 审计 / 策略）。
export function buildPiTools(toolNames, context = {}, { executeTool = defaultExecuteTool } = {}) {
  const schemas = getToolSchemas(toolNames)
  return schemas
    .map(schema => {
      try {
        return defineTool(toToolDefinition(schema, context, executeTool))
      } catch (e) {
        console.warn(`[pi-bridge] 跳过工具 ${schema?.function?.name || '?'}: ${e.message}`)
        return null
      }
    })
    .filter(Boolean)
}
