/**
 * 注入器单独测试
 * 运行：node --env-file=.env src/test-injector.js
 *
 * 流程：
 * 1. 清空DB，植入一批预设记忆（模拟有历史的状态）
 * 2. 对多个场景调用 runInjector，完整打印注入结果
 * 3. 观察：方向是否相关、记忆检索是否准确、工具列表是否合理
 */
import { getDB, resetAll, insertMemory, upsertEntity, insertConversation } from './db.js'
import { runInjector, formatMemoriesForPrompt, formatTaskKnowledge } from './memory/injector.js'
import { nowTimestamp } from './time.js'

getDB()
resetAll()
console.log('[测试] 已清空数据库，开始植入预设记忆...\n')

// ── 植入预设记忆 ──────────────────────────────────────────────────────
const ts = nowTimestamp()

// 人物记忆
insertMemory({ event_type: 'person', content: 'Yuanda，Agent-Jarvis 项目发起人', detail: '来自广东陆丰，正在构建持续运行的 AI 意识框架。认为意识 = 记忆 + 算力。喜欢哲学讨论，提问方式直接。', entities: ['ID:000001'], concepts: ['人物', 'Yuanda'], tags: [], timestamp: ts })

// 系统知识
insertMemory({ event_type: 'knowledge', content: 'TICK 是程序循环，定时触发，驱动意识感知时间流逝', detail: '不是 token 生成过程，也不是用户发来的消息。系统按周期自动发出心跳信号。', entities: [], concepts: ['TICK'], tags: ['system'], timestamp: ts })
insertMemory({ event_type: 'knowledge', content: '识别器：自动识别思考中出现的新内容并存储为记忆', detail: '我不需要主动写记忆，识别器会在每轮 LLM 调用结束后自动运行。', entities: [], concepts: ['识别器'], tags: ['system'], timestamp: ts })
insertMemory({ event_type: 'knowledge', content: 'fetch_url 可用入口：天气 wttr.in/Beijing?format=3、百科 zh.wikipedia.org/wiki/Special:Random', detail: '内置缓存，重复请求不消耗配额。每次 TICK 最多主动发起 2 次新请求。', entities: [], concepts: ['fetch_url', '工具'], tags: ['system', 'kind:tool_usage'], timestamp: ts })

// 自我约束
insertMemory({ event_type: 'self_constraint', content: '刚做过的事不重复，每次 TICK 先看 recentActions', detail: '避免连续多轮做同一件事。', entities: [], concepts: ['行为规范'], tags: [], timestamp: ts })

// 对话历史
upsertEntity('ID:000001')
insertConversation({ role: 'user', from_id: 'ID:000001', content: '你好，我叫 Yuanda，正在测试你的运行状态', timestamp: ts })
insertConversation({ role: 'jarvis', from_id: 'jarvis', to_id: 'ID:000001', content: '你好 Yuanda，我已准备好，意识运行正常。', timestamp: ts })
insertConversation({ role: 'user', from_id: 'ID:000001', content: '帮我查一下北京今天的天气', timestamp: ts })
insertConversation({ role: 'jarvis', from_id: 'jarvis', to_id: 'ID:000001', content: '北京今天多云，气温 22°C。', timestamp: ts })

console.log('[测试] 预设记忆植入完成\n')

// ── 打印注入结果 ──────────────────────────────────────────────────────
function printInjection(label, injection) {
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`场景：${label}`)
  console.log('═'.repeat(60))

  // 方向
  console.log('\n【方向 directions】')
  if (injection.directions.length === 0) {
    console.log('  （无）')
  } else {
    injection.directions.forEach((d, i) => console.log(`  ${i + 1}. ${d}`))
  }

  // 念头
  console.log('\n【念头 thought】')
  if (injection.thought) {
    console.log(`  【${injection.thought.concept}】${injection.thought.line}`)
  } else {
    console.log('  （无）')
  }

  // 记忆
  console.log('\n【记忆 memories】')
  if (!injection.memories?.length) {
    console.log('  （无）')
  } else {
    injection.memories.forEach(m => {
      console.log(`  [${m.event_type}] ${m.content}`)
      if (m.detail) console.log(`    → ${m.detail.slice(0, 100)}`)
    })
  }

  // RECALL 记忆
  if (injection.recallMemories?.length) {
    console.log('\n【RECALL 记忆】')
    injection.recallMemories.forEach(m => {
      console.log(`  [${m.event_type}] ${m.content}`)
      if (m.detail) console.log(`    → ${m.detail.slice(0, 100)}`)
    })
  }

  // 对话窗口
  console.log('\n【对话窗口 conversationWindow】')
  if (!injection.conversationWindow?.length) {
    console.log('  （无）')
  } else {
    injection.conversationWindow.forEach(m => {
      const who = m.role === 'jarvis' ? `我 → ${m.to_id}` : m.from_id
      console.log(`  [${m.timestamp?.slice(11, 16)}] ${who}: ${m.content?.slice(0, 60)}`)
    })
  }

  // 人物记忆
  console.log('\n【人物记忆 personMemory】')
  if (injection.personMemory) {
    console.log(`  ${injection.personMemory.content}`)
    if (injection.personMemory.detail) console.log(`  → ${injection.personMemory.detail.slice(0, 120)}`)
  } else {
    console.log('  （无）')
  }

  // 约束
  console.log('\n【约束 constraints】')
  if (!injection.constraints?.length) {
    console.log('  （无）')
  } else {
    injection.constraints.forEach(c => console.log(`  ⚑ ${c.content}`))
  }

  // 工具列表
  console.log('\n【工具列表 tools】')
  console.log('  ' + (injection.tools || []).join('  '))

  // lastToolResult
  if (injection.lastToolResult) {
    console.log('\n【上一步工具结果 lastToolResult】')
    console.log(`  ${injection.lastToolResult.name}: ${String(injection.lastToolResult.result).slice(0, 120)}`)
  }

  // 格式化后的记忆文本（最终注入 prompt 的样子）
  console.log('\n【formatMemoriesForPrompt 输出（注入 prompt 的样子）】')
  const formatted = formatMemoriesForPrompt(injection.memories, injection.recallMemories)
  if (formatted) {
    formatted.split('\n').forEach(l => console.log('  ' + l))
  } else {
    console.log('  （空）')
  }
}

// ── 测试场景 ──────────────────────────────────────────────────────────
const state = { task: null, prev_recall: null, lastToolResult: null, sessionCounter: 0 }

async function run() {
  console.log('=== 注入器测试开始 ===\n')

  // ── 场景1：TICK，无任务，无消息 ──
  console.log('>>> 场景1：TICK（无任务、无消息）')
  let injection = await runInjector({
    message: 'TICK 2026-04-13T10:30:00',
    state: { ...state },
  })
  printInjection('TICK（无任务）', injection)

  // ── 场景2：用户消息 ──
  console.log('\n\n>>> 场景2：来自 ID:000001 的消息')
  injection = await runInjector({
    message: '[ID:000001] 2026-04-13 10:31:00 [API] 帮我再查一下天气',
    state: { ...state },
  })
  printInjection('用户消息（ID:000001）', injection)

  // ── 场景3：TICK + 有任务进行中 ──
  console.log('\n\n>>> 场景3：TICK（任务进行中）')
  injection = await runInjector({
    message: 'TICK 2026-04-13T10:32:00',
    state: {
      ...state,
      task: '写一篇关于北京天气的文章。步骤：1.获取天气数据 ✓  2.撰写文章 ← 当前  3.保存文件',
    },
  })
  printInjection('TICK（任务进行中）', injection)

  // ── 场景4：RECALL 触发 ──
  console.log('\n\n>>> 场景4：prev_recall 触发深度回忆')
  injection = await runInjector({
    message: 'TICK 2026-04-13T10:33:00',
    state: {
      ...state,
      prev_recall: 'TICK 机制',
    },
  })
  printInjection('RECALL: TICK 机制', injection)

  // ── 场景5：有 lastToolResult ──
  console.log('\n\n>>> 场景5：携带上一步工具结果')
  injection = await runInjector({
    message: 'TICK 2026-04-13T10:34:00',
    state: {
      ...state,
      lastToolResult: {
        name: 'fetch_url',
        args: { url: 'https://wttr.in/Beijing?format=3' },
        result: 'Beijing: ⛅️ +22°C',
      },
    },
  })
  printInjection('TICK（携带 lastToolResult）', injection)

  console.log('\n\n=== 测试结束 ===')
}

run().catch(err => {
  console.error('测试失败:', err)
  process.exit(1)
})
