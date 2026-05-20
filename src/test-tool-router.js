// Tool-router 按需注入纯算法测试（动态上下文记忆池第 4 步）。
//
// tool-router.js 不碰 DB / 网络 / LLM，纯函数，直接 import 即可。
//
// Run: node src/test-tool-router.js

import { selectTools } from './memory/tool-router.js'

let failed = 0
function assert(cond, label) {
  if (!cond) {
    console.error(`FAIL: ${label}`)
    failed++
    process.exitCode = 1
  } else {
    console.log(`PASS: ${label}`)
  }
}

function has(tools, name) {
  return tools.includes(name)
}
function hasAll(tools, names) {
  return names.every(n => tools.includes(n))
}
function hasNone(tools, names) {
  return names.every(n => !tools.includes(n))
}

// ====== 1) Filesystem 触发 ======
{
  const tools = selectTools({
    messageBody: '帮我读一下 D:\\xxx\\README.md',
    isTick: false,
    senderId: 'ID:000001',
  })
  assert(hasAll(tools, ['read_file', 'write_file', 'list_dir']),
    `1) filesystem keywords → fs group injected (got: ${tools.join(',')})`)
  assert(has(tools, 'send_message'), '1) core send_message present')
  assert(has(tools, 'search_memory'), '1) senderId present → search_memory in')
}

// ====== 2) Web 触发 ======
{
  const tools = selectTools({
    messageBody: '搜一下 vLLM 最新版本',
    isTick: false,
    senderId: 'ID:000001',
  })
  assert(hasAll(tools, ['web_search', 'fetch_url', 'browser_read']),
    `2) web keywords → web group injected (got: ${tools.join(',')})`)
  assert(hasNone(tools, ['exec_command', 'kill_process']),
    '2) exec group not over-triggered')
}

// ====== 3) Reminder 触发 ======
{
  const tools = selectTools({
    messageBody: '提醒我明天 9 点开会',
    isTick: false,
    senderId: 'ID:000001',
  })
  assert(has(tools, 'manage_reminder'),
    `3) reminder keyword → manage_reminder injected (got: ${tools.join(',')})`)
}

// ====== 4) 短闲聊 → Fallback 安全网 ======
{
  const tools = selectTools({
    messageBody: '闲聊两句',
    isTick: false,
    senderId: 'ID:000001',
  })
  // 没有强意图关键词，fallback 应该补 web + filesystem
  assert(hasAll(tools, ['web_search', 'read_file']),
    `4) sparse msg → fallback adds web + fs (got: ${tools.join(',')})`)
  assert(has(tools, 'send_message'), '4) core still present')
}

// ====== 5) TICK 广注入 ======
{
  const tools = selectTools({
    messageBody: '',
    isTick: true,
    senderId: null,
  })
  // 按需求：core + web + memory + reminders + prefetch + hotspot + ticker
  assert(has(tools, 'send_message'), '5) TICK has core send_message')
  assert(has(tools, 'search_memory'), '5) TICK has search_memory')
  assert(has(tools, 'web_search'), '5) TICK has web_search')
  assert(has(tools, 'manage_reminder'), '5) TICK has manage_reminder')
  assert(has(tools, 'manage_prefetch_task'), '5) TICK has manage_prefetch_task')
  assert(has(tools, 'hotspot_mode'), '5) TICK has hotspot_mode')
  assert(has(tools, 'set_tick_interval'), '5) TICK has set_tick_interval')
  // 但仍省 exec / admin / media（除非关键词命中）
  assert(hasNone(tools, ['exec_command', 'install_tool', 'media_mode']),
    `5) TICK does NOT pull exec/admin/media (got: ${tools.join(',')})`)
}

// ====== 6) hasTask=true → 完整 task 控制组 ======
{
  const tools = selectTools({
    messageBody: '刚才那个任务的进度报一下',
    isTick: false,
    senderId: 'ID:000001',
    hasTask: true,
  })
  assert(hasAll(tools, ['set_task', 'complete_task', 'update_task_step']),
    `6) hasTask=true → full task_ctrl group (got: ${tools.filter(t => t.includes('task')).join(',')})`)
  // hasTask 还应解锁 focus_banner
  assert(has(tools, 'focus_banner'),
    '6) hasTask also unlocks focus_banner')
}

// ====== 6b) hasTask=false → 只 set_task（opener） ======
{
  const tools = selectTools({
    messageBody: '正常闲聊',
    isTick: false,
    senderId: 'ID:000001',
    hasTask: false,
  })
  assert(has(tools, 'set_task'), '6b) no task → set_task still available (opener)')
  assert(hasNone(tools, ['complete_task', 'update_task_step']),
    '6b) no task → no complete_task / update_task_step')
}

// ====== 7) Installed 工具永远全注入 ======
{
  const tools = selectTools({
    messageBody: '随便说点啥',
    isTick: false,
    senderId: 'ID:000001',
    installedToolNames: ['my_custom_tool', 'another_custom'],
  })
  assert(hasAll(tools, ['my_custom_tool', 'another_custom']),
    `7) installed tools always injected (got: ${tools.join(',')})`)
}

// ====== 8) 中英混合：media 触发 ======
{
  const tools = selectTools({
    messageBody: 'play some music please',
    isTick: false,
    senderId: 'ID:000001',
  })
  assert(hasAll(tools, ['media_mode', 'music']),
    `8) "play some music" → media group injected (got: ${tools.join(',')})`)
}

// ====== 9) ActionLog 保活（跨轮连贯） ======
{
  const tools = selectTools({
    messageBody: '继续',  // 短到不会命中任何关键词
    isTick: false,
    senderId: 'ID:000001',
    recentActionLog: [
      { tool: 'fetch_url', timestamp: '2026-05-19T10:00:00Z' },
      { tool: 'browser_read', timestamp: '2026-05-19T10:01:00Z' },
    ],
  })
  assert(hasAll(tools, ['fetch_url', 'browser_read']),
    `9) actionLog保活：上轮用过的工具被强制注入 (got: ${tools.join(',')})`)
}

// ====== 10) 多模态生成 gate：mmCaps 没配 → 不注入 ======
{
  const tools = selectTools({
    messageBody: '帮我画一张猫的图',
    isTick: false,
    senderId: 'ID:000001',
    mmCaps: [],  // 未配置 image 能力
  })
  assert(!has(tools, 'generate_image'),
    `10a) mmCaps 空 → generate_image NOT injected even with trigger (got: ${tools.join(',')})`)
}
{
  const tools = selectTools({
    messageBody: '帮我画一张猫的图',
    isTick: false,
    senderId: 'ID:000001',
    mmCaps: ['image'],
  })
  assert(has(tools, 'generate_image'),
    `10b) mmCaps=['image'] + 画关键词 → generate_image 注入 (got: ${tools.join(',')})`)
}
{
  const tools = selectTools({
    messageBody: '正常聊天，没说画图',
    isTick: false,
    senderId: 'ID:000001',
    mmCaps: ['image', 'tts', 'music', 'lyrics'],
  })
  assert(hasNone(tools, ['generate_image', 'speak', 'generate_music', 'generate_lyrics']),
    `10c) mmCaps 全配但无关键词 → MM 工具仍省掉 (got: ${tools.filter(t => t.startsWith('generate_') || t === 'speak').join(',')})`)
}

// ====== 11) 启动自检激活 ======
{
  const tools = selectTools({
    messageBody: '',
    isTick: true,
    startupSelfCheckActive: true,
  })
  assert(has(tools, 'complete_startup_self_check'),
    '11) startupSelfCheckActive → complete_startup_self_check injected')
}

// ====== 12) Exec 触发 ======
{
  const tools = selectTools({
    messageBody: '帮我执行一下 git status 这个命令',
    isTick: false,
    senderId: 'ID:000001',
  })
  assert(hasAll(tools, ['exec_command', 'kill_process', 'list_processes']),
    `12) exec keyword → exec group injected (got: ${tools.join(',')})`)
}

// ====== 13) Admin 触发 ======
{
  const tools = selectTools({
    messageBody: '装一下这个工具 / 卸载那个旧的',
    isTick: false,
    senderId: 'ID:000001',
  })
  assert(hasAll(tools, ['install_tool', 'uninstall_tool', 'list_tools']),
    `13) admin keyword → admin group injected (got: ${tools.join(',')})`)
}

// ====== 14) Person card 触发 ======
{
  const tools = selectTools({
    messageBody: '介绍一下周杰伦是个什么人',
    isTick: false,
    senderId: 'ID:000001',
  })
  assert(has(tools, 'person_card_mode'),
    `14) person card keyword → person_card_mode injected (got: ${tools.join(',')})`)
}

// ====== 15) RECALL 路径 ======
{
  const tools = selectTools({
    messageBody: '',
    isTick: false,
    senderId: null,
    hasRecall: true,
  })
  assert(has(tools, 'search_memory'), '15) hasRecall → search_memory injected')
}

// ====== 16) Schema 数量对比（仅观察，不强制断言）======
{
  const fullSetTools = selectTools({
    messageBody: '帮我读 D:\\readme.md，搜下 https://google.com，运行命令，提醒我，画张图，听首歌',
    isTick: true,
    senderId: 'ID:000001',
    hasTask: true,
    hasRecall: true,
    mmCaps: ['tts', 'image', 'music', 'lyrics'],
    installedToolNames: ['custom_x'],
  })
  const minimalTools = selectTools({
    messageBody: '嗯',
    isTick: false,
    senderId: 'ID:000001',
  })
  console.log(`\n[INFO] worst-case tool count: ${fullSetTools.length}`)
  console.log(`[INFO] minimal-case tool count: ${minimalTools.length}`)
  assert(fullSetTools.length > minimalTools.length,
    `worst-case (${fullSetTools.length}) > minimal-case (${minimalTools.length})`)
  // 主仓老版本是 ~35-40 工具全量；现在最坏情况也不应该超过那个数
  assert(fullSetTools.length <= 45,
    `worst-case (${fullSetTools.length}) stays bounded`)
}

if (failed === 0) {
  console.log('\nAll tool-router sanity checks complete.')
} else {
  console.log(`\n${failed} check(s) failed.`)
}
