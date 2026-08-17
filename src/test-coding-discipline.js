// 编程纪律内化层测试：触发器纯函数 + buildSystemPrompt gated 注入。
// Run: node src/test-coding-discipline.js
import { register } from 'node:module'
register('./test-prompt-split-loader.mjs', import.meta.url)

import { shouldInjectCoding, shouldInjectDiagnose, CODING_BLOCK, DIAGNOSE_BLOCK } from './prompt-blocks/coding-discipline.js'
import { buildSystemPrompt } from './prompt.js'

let failed = 0
function assert(cond, label) {
  if (!cond) { console.error(`FAIL: ${label}`); failed++; process.exitCode = 1 }
  else console.log(`PASS: ${label}`)
}

console.log('— 信号源 1：用户消息 —')
assert(shouldInjectCoding({ userMessage: '做一个地月自由返回轨道的 3D 可视化' }), '做一个…3D可视化 → coding')
assert(shouldInjectCoding({ userMessage: '帮我写个爬虫脚本' }), '写个爬虫脚本 → coding')
assert(shouldInjectCoding({ userMessage: '重构一下这个项目' }), '重构…项目 → coding')
assert(shouldInjectCoding({ userMessage: 'build a landing page for me' }), '英文 build a page → coding')
assert(!shouldInjectCoding({ userMessage: '帮我写一篇关于秋天的文章' }), '写文章 ≠ coding')
assert(!shouldInjectCoding({ userMessage: '明天天气怎么样' }), '天气 ≠ coding')
assert(!shouldInjectCoding({ userMessage: '我们看个动画片吧' }), '看动画片 ≠ coding')
assert(!shouldInjectCoding({ userMessage: '做个计划安排下周的行程' }), '做计划 ≠ coding')
// 2.1.377 实测漏报回归：动宾被冒号隔断 + 产物词不在表内，靠"英文目录名"强规则兜住
assert(shouldInjectCoding({ userMessage: '上次那个地月自由返回轨道做得不够好，把 free-return 目录清掉重做一个更好的：地球、月球、飞船8字自由返回轨迹，月球真实周期，可旋转视角、可调时间速度，这次把视觉效果和物理正确性都做扎实。' }), '138 原话（free-return 目录）→ coding')
assert(shouldInjectCoding({ userMessage: '帮我改下 main.js 里的参数' }), '点名 .js 文件 → coding')
assert(shouldInjectCoding({ userMessage: '做一个三体运动的模拟' }), '做…模拟 → coding')
assert(!shouldInjectCoding({ userMessage: '帮我把下载目录整理一下' }), '中文目录整理 ≠ coding（目录规则只认英文名）')

console.log('— 信号源 2：task 文本（TICK 干活轮，用户零输入）—')
assert(shouldInjectCoding({ userMessage: 'TICK', taskText: '重建霍曼转移轨道3D动画，实现行星轨道和飞船运动' }), 'task 文本命中 → coding（TICK 轮内化生效）')
assert(!shouldInjectCoding({ userMessage: 'TICK', taskText: '整理用户的航班信息并提醒' }), '非编程 task 不触发')

console.log('— 信号源 3：最近动作模式 —')
assert(shouldInjectCoding({ recentActionsText: 'write_file(free-return/main.js), exec_command(node server.js)' }), 'write_file+exec → coding')
assert(shouldInjectCoding({ recentActionsText: 'write_file(a.html) | exec_command(npm install three)' }), 'write_file+npm → coding')
assert(shouldInjectCoding({ recentActionsText: 'edit_file(a.html, replace) | run_command(npm test)' }), 'edit_file+run → coding')
assert(!shouldInjectCoding({ recentActionsText: 'web_search(flights), send_message -> user' }), '查航班动作 ≠ coding')
assert(!shouldInjectCoding({ recentActionsText: 'write_file(notes.md)' }), '只写文件没执行 ≠ coding（写笔记场景）')

console.log('— Diagnose 触发 —')
assert(shouldInjectDiagnose({ userMessage: '页面打不开，显示 404' }), '404 → diagnose')
assert(shouldInjectDiagnose({ userMessage: '这个动画是坏的，黑屏' }), '坏了/黑屏 → diagnose')
assert(shouldInjectDiagnose({ userMessage: 'the app is broken, fix it' }), '英文 broken → diagnose')
assert(shouldInjectDiagnose({ userMessage: 'TICK', taskText: '修复 free-return 页面加载不出的问题' }), 'task 含症状词 → diagnose')
assert(!shouldInjectDiagnose({ userMessage: '今天聊得很开心' }), '闲聊 ≠ diagnose')
assert(!shouldInjectDiagnose({ userMessage: '做一个新的网页' }), '纯新建 ≠ diagnose')

console.log('— buildSystemPrompt 集成注入 —')
{
  const base = { agentName: '小白龙', persona: '', birthTime: '2026-01-01', userMessage: '' }
  const p1 = buildSystemPrompt({ ...base, userMessage: '做一个 three.js 的太阳系动画网页' })
  assert(p1.includes('## Coding Discipline'), '编程消息 → 注入 Coding Discipline')
  assert(p1.includes('Skeleton first'), '段内容完整（垂直切片）')
  assert(!p1.includes('## Debugging Discipline'), '纯新建不注入 Debugging')

  const p2 = buildSystemPrompt({ ...base, userMessage: '页面报错了，修一下' })
  assert(p2.includes('## Debugging Discipline'), '报错消息 → 注入 Debugging Discipline')
  assert(p2.includes('feedback loop'), '段内容完整（回路优先）')

  const p3 = buildSystemPrompt({ ...base, userMessage: '今天天气真好' })
  assert(!p3.includes('## Coding Discipline') && !p3.includes('## Debugging Discipline'), '闲聊零注入（少即是强）')

  const p4 = buildSystemPrompt({ ...base, userMessage: '', currentTaskText: '实现自由返回轨道可视化项目', recentActionsSummary: 'write_file(main.js) | exec_command(node server.js)' })
  assert(p4.includes('## Coding Discipline'), 'TICK 轮（消息为空）靠 task+动作信号注入 → 内化语义成立')

  const p5 = buildSystemPrompt({ ...base, userMessage: '动画显示出错了帮我修复，顺便把代码重构一下' })
  assert(p5.includes('## Coding Discipline') && p5.includes('## Debugging Discipline'), '复合场景两段并存')
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILURE(S)`)
