// formatSceneManifest 单元测试 —— 验证回注 Agent 的紧凑清单文本。
// 纯函数(injector-format.js 无 import),可直接 `node src/scene/test-scene-manifest.js`。

import { formatSceneManifest } from '../memory/injector-format.js'

let pass = 0, fail = 0
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}`) }
}

// 1) 空 manifest → 空串(零噪声,不渲染该段)
ok('空清单返回空串', formatSceneManifest([]) === '')
ok('undefined 返回空串', formatSceneManifest() === '')

// 2) 单 surface(inform 默认、无 focus)→ 不带 flags
{
  const t = formatSceneManifest([{ id: 'weather-bj', kind: 'weather', intent: 'inform', focus: false }])
  ok('含标题段', t.includes('[Surfaces currently on screen]'))
  ok('含 id 与 kind', t.includes('id="weather-bj"') && t.includes('kind=weather'))
  ok('inform 不显示为 flag', !t.includes('[inform]'))
  ok('含 ui_set 指引', t.includes('ui_set'))
  ok('声明为 context 非触发器', t.includes('context, not a trigger'))
}

// 3) focus + confront → 带 flags
{
  const t = formatSceneManifest([{ id: 'c1', kind: 'choice', intent: 'confront', focus: true }])
  ok('focus 显示', t.includes('focus'))
  ok('confront 显示', t.includes('confront'))
}

// 4) 不泄漏 data —— manifest 本就不含 data,确保格式化也不会带出任何内容字段
{
  const t = formatSceneManifest([{ id: 'a', kind: 'text', intent: 'inform', focus: false }])
  ok('不含 data 字样', !t.toLowerCase().includes('data'))
}

console.log(`\nformatSceneManifest: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
