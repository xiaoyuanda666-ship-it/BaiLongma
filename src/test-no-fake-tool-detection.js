// 回归测试：验证"扫正文猜工具调用"的检测器已被删除，不再误伤正常回答。
//
// 背景（2026-06 第一性原理重构）：callLLM 曾有两支靠扫描模型正文的检测——
//   1. detectFakeToolCall：正文里出现任意工具名子串 → 判定"嘴上说调了实际没调"
//   2. 假记忆检测：正文里出现"记住了/存好了"等关键词且没调 upsert_memory → 判定假承诺
// 两者都靠 allContent='' 抹掉已成形答案 + 以 role:'user' 追问，从而把模型逼出一句
// 面向用户的"你说得对…"非相关回复替换掉原答案（实测 bug：用户问"你有哪些工具"，模型
// 正文列出含 recall_memory 的工具 → 被误判 → 好答案消失、换成一句辩护）。
//
// 真相源是运行时的工具日志（sawToolCall），不是模型散文。检测器已删。本测试钉死这个行为：
// 当模型用纯文本回答、正文里恰好含工具名 / "记住了"关键词时，callLLM 必须**一轮收尾**、
// 原样返回该正文——既不二次调用模型，也不替换内容。若有人把检测器加回来，round 会 >1、
// content 会被改写，本测试即失败。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-no-fake-detect-'))
process.env.JARVIS_USER_DIR = tmp
process.env.JARVIS_RESOURCES_DIR = process.cwd()

let closeDBForTest = null

try {
  const { callLLM } = await import('./llm.js')
  ;({ closeDBForTest } = await import('./db.js'))

  // ── 场景 1：用户问"你有哪些工具"，模型正文列出工具名（含 recall_memory）──────────
  // 旧 detectFakeToolCall 会在正文里匹配到 recall_memory/send_message 等子串而误判。
  {
    const listing =
      '我现在可以使用这些工具：recall_memory（回忆过往记忆）、send_message（给你发消息）、' +
      'set_task（设置任务）、web_search（联网搜索）等。需要我用其中哪个帮你做事，告诉我就好。'
    let rounds = 0
    const result = await callLLM({
      systemPrompt: 'system',
      message: '你现在有哪些工具？查看你的所有工具',
      tools: ['send_message', 'recall_memory', 'set_task', 'web_search', 'upsert_memory'],
      mustReply: true,
      localReply: true,   // 语音/TUI：纯文本即回复，正是出 bug 的本地渠道
      _streamOnceForTest: async () => {
        rounds += 1
        return { content: listing, reasoningContent: '', aborted: false, toolCalls: [] }
      },
    })
    assert.equal(rounds, 1, '列工具的纯文本回答只调用模型一轮（没有中途 nudge 触发二次生成）')
    assert.equal(result.content, listing, '原样返回模型正文——内容未被抹掉或替换')
    assert(result.content.includes('recall_memory'), '正文里的工具名被保留，没有被当成伪调用')
    console.log('PASS 列举工具名的纯文本回答不触发伪调用检测')
  }

  // ── 场景 2：模型说"记住了"但没调 upsert_memory ──────────────────────────────
  // 旧的假记忆检测会匹配"记住了"关键词并把这条好回复抹掉、逼模型补调 upsert_memory。
  // 现在该检测已删：本地渠道纯文本即回复，一轮收尾、原样返回。
  {
    const memReply = '好的，我记住了——你喜欢喝美式咖啡，不加糖。'
    let rounds = 0
    const result = await callLLM({
      systemPrompt: 'system',
      message: '记一下，我喜欢喝美式咖啡，不加糖',
      tools: ['send_message', 'upsert_memory'],
      mustReply: true,
      localReply: true,
      _streamOnceForTest: async () => {
        rounds += 1
        return { content: memReply, reasoningContent: '', aborted: false, toolCalls: [] }
      },
    })
    assert.equal(rounds, 1, '"记住了"的纯文本回复只调用模型一轮（假记忆检测已删，不再二次追问）')
    assert.equal(result.content, memReply, '原样返回——不被抹掉或替换为辩护文本')
    console.log('PASS "记住了"纯文本回复不触发假记忆检测')
  }

  // ── 场景 3：关于"执行命令"工具的元问题（曾触发 missingToolNudge 误判，导致回答两遍）──
  // 用户问的是"你有几个执行命令的工具"——一个**关于工具的元问题**，模型凭系统提示直接用纯文本
  // 回答即可、无需调任何工具。但这句话字面含"执行命令"，旧 requiresToolForRequest 的 commandIntent
  // 会判定成"用户要求执行命令"，于是 missingToolNudge 触发：allContent='' 抹掉答案 + 以 role:'user'
  // 逼调工具 → 模型重答一遍。语音轮第一遍已念出口，用户就听到"同一个问题被回答两遍"。
  // missingToolNudge 已删，本测试钉死：含命令/文件/联网关键词的元问题也必须一轮收尾、原样返回。
  {
    const toolCount =
      '执行命令的工具分了四种：exec_quick_command、exec_command、exec_task_command、' +
      'exec_background_command，再加上 download_file、kill_process、list_processes，一共七个。'
    let rounds = 0
    const result = await callLLM({
      systemPrompt: 'system',
      message: '你现在执行命令的那个工具有多少个？',
      tools: ['send_message', 'exec_command'],
      mustReply: true,
      localReply: true,   // 语音轮：第一遍流式已念出口，绝不能被抹掉重答
      _streamOnceForTest: async () => {
        rounds += 1
        return { content: toolCount, reasoningContent: '', aborted: false, toolCalls: [] }
      },
    })
    assert.equal(rounds, 1, '关于命令工具的元问题只调用模型一轮（missingToolNudge 已删，不再误判成动作请求）')
    assert.equal(result.content, toolCount, '原样返回——已念出口的答案不被抹掉，不会重答第二遍')
    console.log('PASS 含"执行命令"关键词的元问题不触发 missingToolNudge 误判')
  }
} finally {
  closeDBForTest?.()
  fs.rmSync(tmp, { recursive: true, force: true })
}

process.exit(process.exitCode || 0)
