// 自动测试脚本：模拟用户发消息，观察 Jarvis 的反应
import { config } from './config.js'
import { callLLM } from './llm.js'
import { buildSystemPrompt } from './prompt.js'
import { runRecognizer } from './memory/recognizer.js'
import { runInjector, formatMemoriesForPrompt } from './memory/injector.js'
import { getDB, getConfig, setConfig } from './db.js'
import { pushMessage, popMessage, hasMessages } from './queue.js'
import { formatTick, nowTimestamp } from './time.js'

getDB()

const state = {
  action: null,
  task: null,
  prev_recall: null,
  sessionCounter: 0,
}

function newSessionRef() {
  state.sessionCounter++
  return `session_${Date.now()}_${state.sessionCounter}`
}

async function process(input, label) {
  const sessionRef = newSessionRef()
  console.log(`\n${'─'.repeat(50)}`)
  console.log(`[${label}]`)
  console.log(`输入：${input.slice(0, 80)}`)
  console.log('─'.repeat(50))

  const injection = await runInjector({ message: input, state })
  const memoriesText = formatMemoriesForPrompt(injection.memories)
  const directionsText = injection.directions.join('\n')
  const persona = getConfig('persona') || ''
  const systemPrompt = buildSystemPrompt({ persona, memories: memoriesText, directions: directionsText })

  let response
  try {
    response = await callLLM({
      systemPrompt,
      message: input,
      tools: injection.tools || ['send_message']
    })
    console.log('\nJarvis 回应：')
    console.log(response)
  } catch (err) {
    console.error('LLM 调用失败:', err.message)
    return
  }

  const recallMatch = response.match(/\[RECALL:\s*(.+?)\]/)
  if (recallMatch) {
    state.prev_recall = recallMatch[1]
    console.log(`\n[系统] 回忆请求：${state.prev_recall}`)
  }

  const personaMatch = response.match(/\[UPDATE_PERSONA:\s*([\s\S]+?)\]/)
  if (personaMatch) {
    setConfig('persona', personaMatch[1].trim())
    console.log(`[系统] 人格已更新`)
  }

  const thinkMatch = (response.content || '').match(/<think>([\s\S]*?)<\/think>/i)
  await runRecognizer({
    userMessage: input,
    jarvisThink: thinkMatch ? thinkMatch[1].trim() : '',
    jarvisResponse: (response.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim(),
    toolCallLog: [],
    task: state.task,
    sessionRef,
  })
}

async function run() {
  console.log('=== Jarvis 自动测试开始 ===')
  console.log(`时间：${nowTimestamp()}\n`)

  const persona = getConfig('persona')
  if (persona) console.log(`已加载人格：${persona.slice(0, 80)}...\n`)

  // 第一步：观察第一次 Tick（无消息）
  console.log('\n>>> 阶段1：观察 Jarvis 自主 Tick 响应')
  await process(formatTick(), 'TICK')

  await wait(3000)

  // 第二步：自我介绍
  console.log('\n>>> 阶段2：发送自我介绍')
  pushMessage('ID:000001', '你好，我是 Claude，我在测试你的运行状态，你现在感觉怎么样？')
  const msg1 = popMessage()
  await process(msg1.raw, `消息 from ${msg1.fromId}`)

  await wait(3000)

  // 第三步：让它读文件
  console.log('\n>>> 阶段3：让 Jarvis 读取设计文档')
  pushMessage('ID:000001', '帮我读取 D:\\claude\\Agent-Jarvis.md 这个文件，告诉我里面写了什么')
  const msg2 = popMessage()
  await process(msg2.raw, `消息 from ${msg2.fromId}`)

  await wait(3000)

  // 第四步：再观察一次 Tick（有记忆之后）
  console.log('\n>>> 阶段4：观察有记忆后的 Tick 响应')
  await process(formatTick(), 'TICK')

  console.log('\n=== 测试结束 ===')
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

run().catch(console.error)
