// 自动生成的"工具清单"与"模型清单"文档文本。
//
// 设计目的：把白龙马自知识里最容易随版本漂移的两块——能调用哪些工具、支持哪些模型——
// 改成从代码里的唯一真源派生，而不是手写。以后增删工具 / provider / 模型，文档自动跟上，
// 不必再人肉同步 self-knowledge.js / config-faq.js。
//
//   工具真源：capabilities/schemas/*.js 的各 *Schemas 对象（与发给 LLM 的 schema 同一份）
//   模型真源：config.js 的 getProviderSummaries()（即 PROVIDER_CONFIG）
//
// 仅依赖纯数据（schema 常量、PROVIDER_CONFIG 常量），不触发任何副作用，import 安全。

import { commsSchemas } from '../capabilities/schemas/comms.js'
import { filesystemSchemas } from '../capabilities/schemas/filesystem.js'
import { shellSchemas } from '../capabilities/schemas/shell.js'
import { webSchemas } from '../capabilities/schemas/web.js'
import { browserSchemas } from '../capabilities/schemas/browser.js'
import { mediaSchemas } from '../capabilities/schemas/media.js'
import { memorySchemas } from '../capabilities/schemas/memory.js'
import { uiSchemas } from '../capabilities/schemas/ui.js'
import { taskSchemas } from '../capabilities/schemas/task.js'
import { reviewSchemas } from '../capabilities/schemas/review.js'
import { remindersSchemas } from '../capabilities/schemas/reminders.js'
import { agentsSchemas } from '../capabilities/schemas/agents.js'
import { systemSchemas } from '../capabilities/schemas/system.js'
import { getProviderSummaries } from '../config.js'

// 类别顺序即文档展示顺序；label 是给人看的中文分组名。
const TOOL_CATEGORIES = [
  { label: '通信', schemas: commsSchemas },
  { label: '文件系统', schemas: filesystemSchemas },
  { label: 'Shell / 进程', schemas: shellSchemas },
  { label: '上网', schemas: webSchemas },
  { label: '交互浏览器', schemas: browserSchemas },
  { label: '媒体（语音 / 音乐 / 图像 / 视频）', schemas: mediaSchemas },
  { label: '记忆', schemas: memorySchemas },
  { label: '界面 / 面板', schemas: uiSchemas },
  { label: '任务与节奏', schemas: taskSchemas },
  { label: '成果审视', schemas: reviewSchemas },
  { label: '提醒与预取', schemas: remindersSchemas },
  { label: 'Agent 委派 / 工具市场', schemas: agentsSchemas },
  { label: '系统与规则', schemas: systemSchemas },
]

// 不对模型暴露（仅作执行器兼容别名），不进清单。
const HIDDEN_TOOLS = new Set(['express'])

// 后台人格（识别器 / 整理器 / 审视分身）专用工具：主 Agent 看得到但不该调，加注标记以免误以为是日常工具。
const BACKSTAGE_HINT = /recognizer-only|consolidator-only|reviewer-only/i

// 取描述的第一句，作为一句话简介（schema.description 常是多行长文，只要首句）。
function oneLine(desc) {
  const firstLine = String(desc || '').split('\n')[0].trim()
  if (!firstLine) return ''
  // 在首个句末标点处截断（中英文皆可）；句子过长再做硬截断。
  const m = firstLine.match(/^(.*?[。.!?！？])(\s|$)/)
  let s = m ? m[1] : firstLine
  if (s.length > 120) s = s.slice(0, 117) + '…'
  return s
}

// 工具清单：按类别分组，每个工具一行 `· name — 一句话`。
export function buildToolCatalogText() {
  const lines = []
  for (const cat of TOOL_CATEGORIES) {
    const entries = Object.entries(cat.schemas).filter(([name]) => !HIDDEN_TOOLS.has(name))
    if (!entries.length) continue
    lines.push(`■ ${cat.label}`)
    for (const [name, schema] of entries) {
      const desc = schema?.function?.description || ''
      const tag = BACKSTAGE_HINT.test(desc) ? '（后台人格专用）' : ''
      lines.push(`  · ${name}${tag} — ${oneLine(desc)}`)
    }
    lines.push('')
  }
  lines.push('注：本清单由 capabilities/schemas/ 自动生成，增删改工具会自动反映，无需手写维护。')
  lines.push('每一轮实际只加载与当前消息相关的工具子集；若发现缺少需要的工具，调用 find_tool(描述) 现场调取并在下一步即可使用。')
  return lines.join('\n')
}

// 模型清单：按 provider 分组，列默认模型与其它可选（已弃用的不列）。
export function buildModelCatalogText() {
  const summaries = getProviderSummaries()
  const lines = []
  for (const [key, info] of Object.entries(summaries)) {
    if (key === 'custom') continue
    const ids = (info.models || []).filter(m => !m.deprecated).map(m => m.id)
    const def = info.defaultModel
    const others = ids.filter(id => id !== def)
    const modelStr = def
      ? `默认 ${def}${others.length ? '；另有 ' + others.join(', ') : ''}`
      : (ids.join(', ') || '—')
    lines.push(`■ ${info.label}（provider id: ${key}）— ${modelStr}`)
  }
  lines.push('■ 自定义端点（custom）— 任意 OpenAI 兼容服务，自填 baseURL + 模型名（本地 Ollama、中转代理等）')
  lines.push('')
  lines.push('注：本清单由 config.js 的 PROVIDER_CONFIG 自动生成，新增 provider 或模型会自动反映。')
  lines.push('配置入口：⚙ → 模型设置。填入 API Key 后系统 Auto 模式会自动识别归属，无需手动选 provider。')
  return lines.join('\n')
}
