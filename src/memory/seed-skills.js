// 启动时把 ACUI 的"组件创作指南"和当前已注册组件的用法 seed 成 skill.ui 记忆。
// 用稳定 mem_id（skill-ui-guide / skill-ui-<kebab>）upsert，反复启动不会重复。
// AGENT_GUIDE.md 改动后 hash 会变，content 跟着更新，记忆条目自动同步。

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { insertMemory } from '../db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AGENT_GUIDE_PATH    = path.resolve(__dirname, '..', 'ui', 'brain-ui', 'acui', 'AGENT_GUIDE.md')
const UI_COMPONENTS_PATH  = path.resolve(__dirname, '..', 'capabilities', 'ui-components.json')

function shortHash(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12)
}

// 已知组件的 use_case 模板：seed 时附带；ui_register 转正的组件由它自己写 use_case。
const BUILTIN_COMPONENT_USAGE = {
  WeatherCard: {
    use_case: '用户问天气、温度、出门、是否下雨、明天后天的天气。',
    example_call: 'ui_show({ component: "WeatherCard", props: { city, temp, condition, feel?, high?, low?, wind?, forecast? }, hint: { placement: "notification", size: "md" } })',
    note: 'city 必须先确定（问用户或从上下文推断）；温度数值不要瞎填，先调 fetch_url 查 wttr.in。形态默认 notification+md；用户说"详细看看"或"研究一下"时改 floating+lg。',
  },
}

function seedAgentGuide() {
  if (!fs.existsSync(AGENT_GUIDE_PATH)) {
    console.warn('[seed-skills] 跳过：AGENT_GUIDE.md 不存在')
    return
  }
  const content = fs.readFileSync(AGENT_GUIDE_PATH, 'utf-8')
  const h = shortHash(content)

  // content：摘要（命中关键词的入口）；detail：整份指南
  const summary = [
    '[技能·UI] 写组件指南',
    '什么时候用 UI 卡片 / 三种执行模式 A>B>C / 内联模板与内联组件的写法 / 转正流程 / 避雷清单。',
    '关键词：做组件、画一个、显示一下、做卡片、自己写、inline、没有这个组件、ui_show_inline、ui_register。',
  ].join('\n')

  insertMemory({
    mem_id: 'skill-ui-guide',
    type: 'skill',
    content: summary,
    detail: content,
    title: 'ACUI 组件创作指南',
    tags: ['skill.ui', 'agent-guide', `hash:${h}`],
    entities: [],
    timestamp: new Date().toISOString(),
  })
}

function seedComponentSkills() {
  if (!fs.existsSync(UI_COMPONENTS_PATH)) return
  let components
  try { components = JSON.parse(fs.readFileSync(UI_COMPONENTS_PATH, 'utf-8')) }
  catch { return }

  for (const [name, def] of Object.entries(components)) {
    const usage = BUILTIN_COMPONENT_USAGE[name]
    if (!usage) continue   // 转正的组件由 ui_register 自己写记忆，不在这里覆盖

    const kebab = name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
    const fields = Object.keys(def.propsSchema || {}).join(', ')
    const content = [
      `[技能·UI] ${name}`,
      `适用场景：${usage.use_case}`,
      `调用：${usage.example_call}`,
      fields ? `字段：${fields}` : null,
      usage.note ? `注意：${usage.note}` : null,
    ].filter(Boolean).join('\n')

    insertMemory({
      mem_id: `skill-ui-${kebab}`,
      type: 'skill',
      content,
      detail: content,
      title: `UI 组件：${name}`,
      tags: ['skill.ui', `component:${name}`],
      entities: [],
      timestamp: new Date().toISOString(),
    })
  }
}

export function ensureSkillMemories() {
  try {
    seedAgentGuide()
    seedComponentSkills()
    console.log('[seed-skills] skill.ui 记忆已同步')
  } catch (e) {
    console.warn('[seed-skills] 同步失败：', e.message)
  }
}
