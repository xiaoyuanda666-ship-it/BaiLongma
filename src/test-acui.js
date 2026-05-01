/**
 * ACUI 端到端测试
 * 运行：node --env-file=.env src/test-acui.js
 *
 * 不需要真起 ws 服务，直接 mock 一个 ws 客户端塞进 acuiClients：
 *   - 调 ui_show / ui_show_inline / ui_update / ui_hide / ui_register
 *   - 收集 mock ws 收到的消息，断言 op / id / 字段
 *   - ui_register 后还会触发 acui:reload 控制事件
 *
 * 覆盖：模式 A、模式 B、ui_update、ui_hide、模式 C 语法预检负反馈、ui_register 文件落盘 + memory seed。
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

import { addACUIClient, removeACUIClient } from './events.js'
import { executeTool } from './capabilities/executor.js'
import { getDB, resetAll, searchMemoriesByKeywords } from './db.js'
import { ensureSkillMemories } from './memory/seed-skills.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REGISTRY_PATH    = path.resolve(__dirname, 'ui', 'brain-ui', 'acui', 'registry.js')
const COMPONENTS_JSON  = path.resolve(__dirname, 'capabilities', 'ui-components.json')
const COMPONENTS_DIR   = path.resolve(__dirname, 'ui', 'brain-ui', 'acui', 'components')

// ── mock ws 客户端 ────────────────────────────────────────────
function createMockClient() {
  const inbox = []
  const ws = {
    readyState: 1,
    send(data) { try { inbox.push(JSON.parse(data)) } catch { inbox.push(data) } },
    close() {},
  }
  return { ws, inbox }
}

function assert(cond, label) {
  if (!cond) {
    console.error(`✗ ${label}`)
    process.exit(1)
  }
  console.log(`✓ ${label}`)
}

// ── 备份/还原 registry 与 ui-components.json ──────────────────
const registryBak   = fs.readFileSync(REGISTRY_PATH, 'utf-8')
const componentsBak = fs.readFileSync(COMPONENTS_JSON, 'utf-8')
const createdFiles  = []

function restoreFiles() {
  fs.writeFileSync(REGISTRY_PATH, registryBak, 'utf-8')
  fs.writeFileSync(COMPONENTS_JSON, componentsBak, 'utf-8')
  for (const f of createdFiles) {
    try { fs.unlinkSync(f) } catch {}
  }
}

// ── 跑测试 ─────────────────────────────────────────────────
async function run() {
  // DB 在 Electron 的 Node ABI 下编译，普通 node 跑会 ABI 错配。
  // 拿不到 DB 就 skip 所有 DB 断言，核心命令/校验/文件改动仍可验证。
  let canUseDB = false
  try {
    getDB(); resetAll(); canUseDB = true
    console.log('[测试] DB 可用，启用全量断言\n')
  } catch (e) {
    console.log(`[测试] DB 不可用（${e.code || e.message}），跳过 DB 相关断言\n`)
  }

  if (canUseDB) {
    ensureSkillMemories()
    const skillHits = searchMemoriesByKeywords(['做组件', '画一个'], { limitPerKeyword: 5 })
    assert(skillHits.length > 0, 'skill.ui 指南记忆能被关键词命中')
  }

  const { ws, inbox } = createMockClient()
  addACUIClient(ws)

  // ── 模式 A：ui_show("WeatherCard") ──
  const r1 = JSON.parse(await executeTool('ui_show', {
    component: 'WeatherCard',
    props: { city: '北京', temp: 18, condition: '晴' },
  }))
  assert(r1.ok && r1.id, '模式 A：ui_show 返回 ok+id')
  const mountA = inbox.shift()
  assert(mountA?.kind === 'ui.command' && mountA.op === 'mount', '模式 A：mount 命令已下发')
  assert(mountA.id === r1.id && mountA.component === 'WeatherCard', '模式 A：组件与 id 正确')
  assert(mountA.hint?.placement === 'notification', '模式 A：默认 placement=notification')
  assert(mountA.hint?.size === 'md', '模式 A：默认 size=md')
  assert(mountA.hint?.draggable === false, '模式 A：notification 默认 draggable=false')
  assert(mountA.hint?.modal === false, '模式 A：notification 默认 modal=false')

  // ── 模式 A 显式 hint：placement=floating + size=lg + draggable 自动 true ──
  const r1b = JSON.parse(await executeTool('ui_show', {
    component: 'WeatherCard',
    props: { city: '上海', temp: 22, condition: '多云' },
    hint: { placement: 'floating', size: 'lg' },
  }))
  const mountAb = inbox.shift()
  assert(mountAb.hint.placement === 'floating' && mountAb.hint.size === 'lg', 'hint 透传：floating + lg')
  assert(mountAb.hint.draggable === true, 'floating 默认 draggable=true')
  assert(mountAb.hint.enter === 'fade-up', 'floating 默认 enter=fade-up')

  // ── 模式 A center 默认 modal=true ──
  const r1c = JSON.parse(await executeTool('ui_show', {
    component: 'WeatherCard',
    props: { city: '广州', temp: 26, condition: '晴' },
    hint: { placement: 'center' },
  }))
  const mountAc = inbox.shift()
  assert(mountAc.hint.modal === true, 'center 默认 modal=true')
  assert(mountAc.hint.enter === 'scale-up', 'center 默认 enter=scale-up')

  // ── 模式 A 媒体组件：默认走 stage 舞台层 ──
  const r1d = JSON.parse(await executeTool('ui_show', {
    component: 'ImageViewer',
    props: { url: 'https://example.com/photo.jpg', title: '示例图片' },
  }))
  const mountAd = inbox.shift()
  assert(r1d.ok && mountAd.component === 'ImageViewer', '媒体组件：ImageViewer 已注册并可下发')
  assert(mountAd.hint.placement === 'stage', '媒体组件：默认 placement=stage')
  assert(mountAd.hint.modal === true, '媒体组件：stage 默认 modal=true')
  assert(mountAd.hint.enter === 'stage-up', '媒体组件：stage 默认 enter=stage-up')
  JSON.parse(await executeTool('ui_hide', { id: r1d.id })); inbox.shift()

  // 关掉这两张 floating/center 卡片，避免污染后续断言（不发 unmount，直接 shift 出剩余消息也行；这里直接 hide）
  JSON.parse(await executeTool('ui_hide', { id: r1b.id })); inbox.shift()
  JSON.parse(await executeTool('ui_hide', { id: r1c.id })); inbox.shift()

  // ── ui_update：浅合并 props ──
  const r2 = JSON.parse(await executeTool('ui_update', {
    id: r1.id,
    props: { temp: 20 },
  }))
  assert(r2.ok, 'ui_update 返回 ok')
  const updateMsg = inbox.shift()
  assert(updateMsg?.op === 'update' && updateMsg.id === r1.id && updateMsg.props.temp === 20, 'update 命令字段正确')

  // ── ui_hide ──
  const r3 = JSON.parse(await executeTool('ui_hide', { id: r1.id }))
  assert(r3.ok, 'ui_hide 返回 ok')
  const hideMsg = inbox.shift()
  assert(hideMsg?.op === 'unmount' && hideMsg.id === r1.id, 'unmount 命令字段正确')

  // ── 模式 B：ui_show_inline inline-template ──
  const r4 = JSON.parse(await executeTool('ui_show_inline', {
    mode: 'inline-template',
    template: '<div class="card"><h3>${title}</h3><ul>${items}</ul></div>',
    styles: '.card { padding:16px; background:#11161c; color:#c9d1d9; border-radius:8px }',
    props: { title: '今日待办', items: '开会、打电话、写报告' },
  }))
  assert(r4.ok && r4.mode === 'inline-template' && r4.id.startsWith('scratch-'), '模式 B：返回 ok + mode + scratch id')
  const mountB = inbox.shift()
  assert(mountB?.op === 'mount' && mountB.mode === 'inline-template', '模式 B：mount 命令含 mode=inline-template')
  assert(typeof mountB.template === 'string' && mountB.template.includes('${title}'), '模式 B：template 透传到前端')
  assert(typeof mountB.styles === 'string' && mountB.styles.includes('background:#11161c'), '模式 B：styles 透传到前端')
  assert(mountB.hint?.enter === 'slide-from-right' && mountB.hint?.exit === 'slide-to-right', '模式 B：默认 hint 已注入')
  assert(mountB.hint?.placement === 'notification', '模式 B：默认 placement=notification')

  // ── 模式 B 显式 hint：center + modal ──
  const r4b = JSON.parse(await executeTool('ui_show_inline', {
    mode: 'inline-template',
    template: '<div>${msg}</div>',
    props: { msg: '请确认操作' },
    hint: { placement: 'center', size: 'sm' },
  }))
  const mountBb = inbox.shift()
  assert(mountBb.hint.placement === 'center' && mountBb.hint.modal === true, '模式 B：center + 默认 modal=true')
  JSON.parse(await executeTool('ui_hide', { id: r4b.id })); inbox.shift()

  // ── 容错：number-like 字符串自动转 number ──
  const r4n = JSON.parse(await executeTool('ui_show', {
    component: 'WeatherCard',
    props: { city: '北京', temp: '18', condition: '晴' },  // temp 故意传字符串
  }))
  assert(r4n.ok, '数字容错：temp="18" 被自动转成数字后 ok')
  const mountN = inbox.shift()
  assert(mountN?.props?.temp === 18, '数字容错：mount 命令里 temp 已是 number')

  // ── 容错：ui_show_inline 缺 props 兜底 ──
  const r4o = JSON.parse(await executeTool('ui_show_inline', {
    mode: 'inline-template',
    template: '<div>hello</div>',
    // 故意不传 props
  }))
  assert(r4o.ok, '缺 props 兜底：仍然 ok')
  inbox.shift()

  // ── 模式 B 透传 data-acui-each 模板（前端解析，后端只透传） ──
  const r4e = JSON.parse(await executeTool('ui_show_inline', {
    mode: 'inline-template',
    template: '<ul>${title}<li data-acui-each="items">${item}</li></ul>',
    props: { title: '清单', items: ['一', '二', '三'] },
  }))
  assert(r4e.ok, 'each 模板：后端透传 ok')
  const mountE = inbox.shift()
  assert(mountE.template.includes('data-acui-each="items"'), 'each 模板：data-acui-each 透传到前端')

  // ── 模式 C 语法预检负反馈 ──
  const r5 = await executeTool('ui_show_inline', {
    mode: 'inline-script',
    code: 'export default class extends HTMLElement { foo( }',  // 故意语法错
    props: {},
  })
  assert(typeof r5 === 'string' && r5.includes('语法预检失败'), '模式 C：bad code 被语法预检拦截')

  // ── 模式 C 形状错误 ──
  const r6 = await executeTool('ui_show_inline', {
    mode: 'inline-script',
    code: 'export default class extends Object {}',
    props: {},
  })
  assert(typeof r6 === 'string' && r6.includes('export default class extends HTMLElement'), '模式 C：非 HTMLElement 子类被拒')

  // ── 模式 C 合法代码（无 ws 客户端时也应通过校验，再被 mount） ──
  const r7 = JSON.parse(await executeTool('ui_show_inline', {
    mode: 'inline-script',
    code: `export default class extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'open' }) }
  set props(v) { this._p = v; this.shadowRoot.innerHTML = '<div>' + (v?.title || '') + '</div>' }
}`,
    props: { title: 'hi' },
  }))
  assert(r7.ok && r7.mode === 'inline-script', '模式 C：合法代码通过预检并 mount')
  const mountC = inbox.shift()
  assert(mountC?.mode === 'inline-script' && typeof mountC.code === 'string', '模式 C：mount 命令含 code')

  // ── ui_register：转正一个内联组件 ──
  const sampleCode = `class TodoCardTest extends HTMLElement {
  static tagName = 'acui-todo-card-test'
  static propsSchema = {
    title: { type: 'string', required: true },
    items: { type: 'array', required: false }
  }
  static enter = 'slide-from-right'
  static exit  = 'slide-to-right'
  constructor() { super(); this.attachShadow({ mode: 'open' }) }
  set props(v) {
    this._p = v
    const items = (v.items || []).map(i => '<li>' + i + '</li>').join('')
    this.shadowRoot.innerHTML = '<div><h3>' + v.title + '</h3><ul>' + items + '</ul></div>'
  }
}
if (!customElements.get(TodoCardTest.tagName)) {
  customElements.define(TodoCardTest.tagName, TodoCardTest)
}
export { TodoCardTest }`
  const r8 = JSON.parse(await executeTool('ui_register', {
    component_name: 'TodoCardTest',
    code: sampleCode,
    props_schema: { title: { type: 'string', required: true }, items: { type: 'array', required: false } },
    use_case: '展示一组待办事项（列表 + 标题），适合用户说"今天的待办"等场景。',
    example_call: 'ui_show("TodoCardTest", { title:"今日待办", items:["开会","打电话"] })',
  }))
  assert(r8.ok && r8.component_name === 'TodoCardTest', 'ui_register 返回 ok')
  const compFile = path.join(COMPONENTS_DIR, 'todo-card-test.js')
  createdFiles.push(compFile)
  assert(fs.existsSync(compFile), '组件文件已写盘：todo-card-test.js')

  const reg = fs.readFileSync(REGISTRY_PATH, 'utf-8')
  assert(reg.includes('todo-card-test.js') && reg.includes('TodoCardTest'), 'registry.js 已追加 import 与导出键')

  const compsJson = JSON.parse(fs.readFileSync(COMPONENTS_JSON, 'utf-8'))
  assert(compsJson.TodoCardTest && compsJson.TodoCardTest.propsSchema, 'ui-components.json 已收录 propsSchema')

  const reloadMsg = inbox.shift()
  assert(reloadMsg?.kind === 'acui:reload' && reloadMsg.component_name === 'TodoCardTest', 'acui:reload 控制事件已下发')

  if (canUseDB) {
    const skillMem = searchMemoriesByKeywords(['TodoCardTest'], { limitPerKeyword: 5 })
    assert(skillMem.length > 0, 'ui_register 已写入 skill.ui 记忆')
  }

  removeACUIClient(ws)
  restoreFiles()
  console.log('\n✓ 全部断言通过')
}

run().catch(err => {
  console.error('\n✗ 测试失败：', err)
  restoreFiles()
  process.exit(1)
})
