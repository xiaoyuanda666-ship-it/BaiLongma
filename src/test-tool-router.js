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
  assert(!has(tools, 'search_memory'), '1) ordinary filesystem request does not expose memory diagnostics')
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

// ====== 4) 短闲聊 → 真正精简基线 ======
{
  const tools = selectTools({
    messageBody: '闲聊两句',
    isTick: false,
    senderId: 'ID:000001',
  })
  // 没有强意图关键词时，不应补 web/filesystem；Agent 可经 find_tool 按需发现。
  assert(hasNone(tools, ['web_search', 'read_file', 'write_file', 'delete_file', 'make_dir']),
    `4) sparse msg stays sparse (got: ${tools.join(',')})`)
  assert(has(tools, 'send_message'), '4) core still present')
  assert(hasNone(tools, ['set_task', 'search_memory', 'probe_memory', 'voice_retire']),
    '4) sparse msg excludes task, memory diagnostics, and voice-only tool')
}

// ====== 5) TICK 精简基线 + 按需发现 ======
{
  const tools = selectTools({
    messageBody: '',
    isTick: true,
    senderId: null,
  })
  // Tick 只直接拿判断/记忆/节奏能力；业务能力由 find_tool 按判断装载。
  assert(has(tools, 'send_message'), '5) TICK has core send_message')
  assert(has(tools, 'find_tool'), '5) TICK has capability discovery')
  assert(has(tools, 'search_memory'), '5) TICK has search_memory')
  assert(has(tools, 'set_tick_interval'), '5) TICK has set_tick_interval')
  assert(tools.length === 7, `5) clean TICK baseline stays compact at 7 tools (got ${tools.length}: ${tools.join(',')})`)
  assert(hasNone(tools, [
    'web_search', 'read_file', 'manage_reminder', 'manage_prefetch_task',
    'hotspot_mode', 'exec_command', 'install_tool', 'media_mode',
  ]), `5) TICK does not pre-decide business capabilities (got: ${tools.join(',')})`)
}

// ====== 5b) Active-task TICK keeps task controls, not unrelated business schemas ======
{
  const tools = selectTools({
    messageBody: '',
    isTick: true,
    senderId: null,
    hasTask: true,
  })
  assert(hasAll(tools, ['complete_task', 'update_task_step', 'review_work', 'focus_banner']),
    `5b) task TICK keeps explicit task judgment controls (got: ${tools.join(',')})`)
  assert(hasNone(tools, ['web_search', 'read_file', 'manage_reminder', 'hotspot_mode']),
    `5b) task TICK still discovers unrelated capabilities on demand (got: ${tools.join(',')})`)
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

// ====== 6b) 无任务闲聊不暴露 set_task；明确任务意图才给 ======
{
  const tools = selectTools({
    messageBody: '正常闲聊',
    isTick: false,
    senderId: 'ID:000001',
    hasTask: false,
  })
  assert(!has(tools, 'set_task'), '6b) no task + no task intent → set_task omitted')
  assert(hasNone(tools, ['complete_task', 'update_task_step']),
    '6b) no task → no complete_task / update_task_step')
}

{
  const tools = selectTools({
    messageBody: '帮我创建一个多步任务，分阶段完成这个项目',
    isTick: false,
    senderId: 'ID:000001',
  })
  assert(has(tools, 'set_task'), '6c) explicit task intent → set_task injected')
}

{
  const tools = selectTools({
    messageBody: '你还记得我们之前说过的部署方案吗？',
    isTick: false,
    senderId: 'ID:000001',
  })
  assert(hasAll(tools, ['search_memory', 'probe_memory']), '6d) explicit memory intent → memory tools injected')
}

{
  const tools = selectTools({
    messageBody: '先这样，再见',
    isTick: false,
    senderId: 'ID:000001',
    isVoiceTurn: true,
  })
  assert(has(tools, 'voice_retire'), '6e) voice turn → voice_retire injected')
}

// ====== 7) Installed 工具：用户轮直给，Tick 按需发现 ======
{
  const tools = selectTools({
    messageBody: '随便说点啥',
    isTick: false,
    senderId: 'ID:000001',
    installedToolNames: ['my_custom_tool', 'another_custom'],
  })
  assert(hasAll(tools, ['my_custom_tool', 'another_custom']),
    `7) user turn keeps installed tools directly available (got: ${tools.join(',')})`)
}

{
  const tools = selectTools({
    messageBody: '',
    isTick: true,
    senderId: null,
    installedToolNames: ['my_custom_tool'],
  })
  assert(!has(tools, 'my_custom_tool'), '7b) installed tool is discoverable, not an implicit Tick autonomy grant')
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
  assert(hasAll(tools, [
    'speak', 'complete_startup_self_check', 'read_file', 'write_file',
    'web_search', 'media_mode', 'hotspot_mode',
  ]), '11) startupSelfCheckActive → fixed self-check tool set injected')
}

// ====== 11b) Worldcup / Hotspot 不再被关键词自动注入 ======
// 设计变更：worldcup_mode / hotspot_mode 不再因关键词命中而自动注入 schema；
// 改由 Agent 依 prompt 规则自决，需要时调 find_tool 发现并当场装载（TOOL_GROUPS 仍保留触发词供 find_tool 用）。
{
  const tools = selectTools({
    messageBody: '今天世界杯的赛况怎么样了',
    isTick: false,
    senderId: 'ID:000001',
  })
  assert(!has(tools, 'worldcup_mode'),
    `11b) 世界杯关键词不再自动注入 worldcup_mode（改 Agent 经 find_tool 自决, got: ${tools.join(',')})`)
  assert(has(tools, 'find_tool'),
    '11b) find_tool 常驻——Agent 可据此发现并装载 worldcup_mode')
}
{
  const tools = selectTools({
    messageBody: '微博热搜现在有什么',
    isTick: false,
    senderId: 'ID:000001',
  })
  assert(!has(tools, 'hotspot_mode'),
    `11c) 热点关键词不再自动注入 hotspot_mode（非 TICK 轮, got: ${tools.join(',')})`)
  assert(has(tools, 'find_tool'),
    '11c) find_tool 常驻——Agent 可据此发现并装载 hotspot_mode')
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
{
  const tools = selectTools({
    messageBody: '马云是谁',
    isTick: false,
    senderId: 'ID:000001',
  })
  assert(has(tools, 'person_card_mode'),
    `14b) direct person question → person_card_mode injected (got: ${tools.join(',')})`)
}
{
  const tools = selectTools({
    messageBody: '帮我写一个项目介绍',
    isTick: false,
    senderId: 'ID:000001',
  })
  assert(!has(tools, 'person_card_mode'),
    `14c) non-person introduction → person_card_mode NOT injected (got: ${tools.join(',')})`)
}
{
  const tools = selectTools({
    messageBody: '人物卡片有点问题，经常错误触发',
    isTick: false,
    senderId: 'ID:000001',
  })
  assert(!has(tools, 'person_card_mode'),
    `14d) talking about the feature itself → person_card_mode NOT injected (got: ${tools.join(',')})`)
}

// ====== 14e) Terminal stream / progress window ======
{
  const tools = selectTools({
    messageBody: 'please show a terminal stream progress window while writing files',
    isTick: false,
    senderId: 'ID:000001',
  })
  assert(has(tools, 'terminal_stream'),
    `14e) terminal stream intent -> terminal_stream injected (got: ${tools.join(',')})`)
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
  const tools = selectTools({
    messageBody: '帮我安装剪映，最好下载官方安装包',
    isTick: false,
    senderId: 'ID:000001',
  })
  assert(hasAll(tools, ['install_software', 'find_tool']),
    `16) software install intent -> dedicated install tool injected (got: ${tools.join(',')})`)
  assert(hasNone(tools, ['web_search', 'download_file', 'exec_command']),
    `16) software install intent does not expose manual web/shell fallback before install_software (got: ${tools.join(',')})`)
}

{
  const tools = selectTools({
    messageBody: '现在请你帮我安装一个 QQ',
    isTick: false,
    senderId: 'ID:000001',
  })
  assert(has(tools, 'install_software'),
    `16b) natural app install request -> install_software injected (got: ${tools.join(',')})`)
  assert(hasAll(tools, ['install_tool', 'list_tools']),
    '16b) admin tools may also be present, but software install tools must not be missed')
}

{
  const tools = selectTools({
    messageBody: '安装一个工具市场里的自定义工具',
    isTick: false,
    senderId: 'ID:000001',
  })
  assert(hasNone(tools, ['exec_command', 'exec_task_command', 'download_file']),
    `16c) marketplace/tool-factory install request does not over-trigger software installer tools (got: ${tools.join(',')})`)
}

{
  const tools = selectTools({
    messageBody: 'please install QQ for me',
    isTick: false,
    senderId: 'ID:000001',
  })
  assert(has(tools, 'install_software'),
    `16b-en) English app install request -> install_software injected (got: ${tools.join(',')})`)
}

{
  const tools = selectTools({
    messageBody: 'https://docs.example.test/vision-api\n\nsk-testVisionRouterKey1234567890',
    isTick: false,
    senderId: 'ID:000001',
  })
  assert(has(tools, 'manage_api_capability'),
    `17) API docs plus key -> manage_api_capability injected (got: ${tools.join(',')})`)
}

{
  const tools = selectTools({
    messageBody: '\u662f\u7684',
    isTick: false,
    senderId: 'ID:000001',
    recentActionLog: [
      {
        tool: 'analyze_image',
        status: 'error',
        result_preview: '{"ok":false,"tool":"analyze_image","error":"not_configured"}',
      },
    ],
  })
  assert(has(tools, 'manage_api_capability'),
    `18) confirm after unconfigured vision -> manage_api_capability injected (got: ${tools.join(',')})`)
}

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
