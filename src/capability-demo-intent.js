const CAPABILITY_DEMO_CANDIDATE_RE = /(?:你|Jarvis|jarvis|agent|ai|小白龙).{0,10}(?:能|会|可以|能够).{0,10}(?:做|干|帮|完成).{0,10}(?:什么|啥|哪些事|哪些事情)|(?:你|Jarvis|jarvis|agent|ai|小白龙).{0,10}(?:有什么|有哪些).{0,10}(?:能力|功能|本事)|(?:能力|功能).{0,8}(?:展示|演示|秀一下|介绍|showcase|demo)|(?:展示|演示|秀一下).{0,8}(?:能力|功能)|what can you do|show(?: me)?(?: your)? capabilit/i

export const CAPABILITY_DEMO_PROMPT_BLOCK = `## On-demand Capability Demo
The capability_demo tool is available in this turn because a lightweight gate saw a possible "what can you do" request. The gate is only a candidate filter; you decide by intent.
- If the user's intent is asking what you/BaiLongma can do, or explicitly requests a capability/function demo, showcase, or self-introduction through abilities, you MUST call capability_demo instead of answering with plain text.
- Do NOT call it for ordinary feasibility or implementation questions such as "这个能做吗", "这个功能能实现吗", "能不能做 X", or discussion about how to build this feature.
- Do NOT merely say the demo is happening. Saying "看屏幕" or "我把能力投出来了" without first calling capability_demo is a failure because no visual sequence will actually start.
- Call capability_demo first. Do not produce any assistant text before or after the tool call. The tool itself sends and speaks this intro while the visual sequence starts: "我能查查天气、操作读写你电脑上的文件、运行电脑里面的命令，还能给你网罗每日的热点信息" After the tool call, stop the round.`

export function shouldInjectCapabilityDemo(text = '') {
  const raw = String(text || '').trim()
  if (!raw) return false
  return CAPABILITY_DEMO_CANDIDATE_RE.test(raw)
}
