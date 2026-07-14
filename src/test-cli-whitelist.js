// CLI 白名单纯逻辑单测（mergeWhitelist / isAllowed / 默认 gbrain / 可配置扩展）。
// 只测零依赖纯函数，保证纯 node 可跑。见 .claude/plans/cli-tool-invocation.plan.md M1。
import assert from 'node:assert/strict'
import {
  DEFAULT_WHITELIST, mergeWhitelist, isAllowed, listAllowedClis, isCliAllowed,
  getCliEntry, loadCliWhitelist, _resetCacheForTest,
} from './cli-whitelist.js'

let passed = 0
const ok = n => { passed += 1; console.log('  ✓', n) }

console.log('test-cli-whitelist: 白名单纯逻辑\n')

// --- 默认白名单含 gbrain ---
{
  assert.ok(DEFAULT_WHITELIST.some(e => e.name === 'gbrain'))
  assert.ok(DEFAULT_WHITELIST.find(e => e.name === 'gbrain').path, 'gbrain 应有 path（避开 Electron PATH 问题）')
  ok('默认白名单含 gbrain 且带绝对 path')
}

// --- isAllowed：gbrain 放行，危险/未列名拒绝 ---
{
  const w = DEFAULT_WHITELIST
  assert.equal(isAllowed('gbrain', w), true)
  assert.equal(isAllowed('curl', w), false)
  assert.equal(isAllowed('rm', w), false)
  assert.equal(isAllowed('', w), false)
  assert.equal(isAllowed(undefined, w), false)
  ok('isAllowed：gbrain 放行；curl/rm/空 拒绝')
}

// --- mergeWhitelist：空/非法 → default；configured 合并（default ∪ configured）---
{
  assert.equal(mergeWhitelist(null), DEFAULT_WHITELIST)
  assert.equal(mergeWhitelist([]), DEFAULT_WHITELIST)
  assert.equal(mergeWhitelist(undefined), DEFAULT_WHITELIST)

  // 加一个 CLI：default(gbrain) + extra 都在
  const merged = mergeWhitelist([{ name: 'extra_cli', description: 'd' }])
  assert.equal(merged.some(e => e.name === 'gbrain'), true)
  assert.equal(merged.some(e => e.name === 'extra_cli'), true)

  // configured 同名覆盖 default（如改 gbrain 的 description/path）
  const over = mergeWhitelist([{ name: 'gbrain', description: '覆盖', path: '/x/gbrain' }])
  const gb = over.find(e => e.name === 'gbrain')
  assert.equal(gb.description, '覆盖')
  assert.equal(gb.path, '/x/gbrain')
  assert.equal(over.filter(e => e.name === 'gbrain').length, 1, '同名不重复')
  ok('mergeWhitelist：空→default；加 CLI 合并；同名 configured 覆盖且不重复')
}

// --- 不改代码即可扩展（M2 验证形态）：configured 加 CLI 后 isAllowed 放行 ---
{
  const w = mergeWhitelist([{ name: 'rg', description: 'ripgrep' }])
  assert.equal(isAllowed('rg', w), true)
  assert.equal(isAllowed('gbrain', w), true)   // default 仍在
  assert.equal(isAllowed('curl', w), false)
  ok('可配置扩展：加 rg 后 rg 放行、gbrain 仍在、curl 仍拒')
}

// --- 文件背书的加载器（仓库 config.json 无 cli_whitelist 块 → 用默认）---
{
  _resetCacheForTest()
  assert.equal(isCliAllowed('gbrain'), true)     // 走 loadCliWhitelist → 默认
  assert.equal(isCliAllowed('curl'), false)
  const gb = getCliEntry('gbrain')
  assert.ok(gb, 'getCliEntry(gbrain) 应返回条目')
  assert.ok(gb.path, 'gbrain 条目应带 path')
  const list = listAllowedClis()
  assert.ok(list.some(e => e.name === 'gbrain'))
  assert.ok(!list.some(e => e.name === 'curl'))
  const a = loadCliWhitelist()
  const b = loadCliWhitelist()
  assert.equal(a, b, 'loadCliWhitelist 应缓存（同引用）')   // 命中 _cached 分支
  _resetCacheForTest()
  ok('加载器：isCliAllowed/getCliEntry/listAllowedClis/loadCliWhitelist 走默认 + 缓存')
}

// --- buildCliSchemas：生成 run_cli 工具 schema，description 含白名单 CLI（让模型发现）---
{
  const { buildCliSchemas } = await import('./capabilities/schemas/cli.js')
  const schemas = buildCliSchemas()
  assert.ok(schemas.run_cli, '应含 run_cli schema')
  const fn = schemas.run_cli.function
  assert.equal(fn.name, 'run_cli')
  assert.equal(fn.parameters.type, 'object')
  assert.ok(fn.parameters.properties.cmd, '应有 cmd 参数')
  assert.ok(fn.parameters.properties.args, '应有 args 参数')
  assert.ok(fn.description.includes('gbrain'), 'description 应列出 gbrain（让模型发现可用 CLI）')
  // 空白名单分支：description 走兜底文案
  const empty = (await import('./capabilities/schemas/cli.js')).buildCliSchemas([])
  assert.ok(empty.run_cli.function.description.includes('暂无白名单'), '空白名单 → 兜底文案')
  ok('buildCliSchemas：run_cli schema 形状正确 + description 含白名单 CLI；空白名单走兜底')
}

// --- isAllowed / getCliEntry 边界分支（非数组 whitelist / null name / 未命中 → null）---
{
  const w = DEFAULT_WHITELIST
  assert.equal(isAllowed('gbrain', null), false)         // whitelist 非数组 → []
  assert.equal(isAllowed('gbrain', 'nope'), false)       // whitelist 非数组 → []
  assert.equal(isAllowed(null, w), false)                // name null → '' trim
  assert.equal(getCliEntry('nonexistent_xyz'), null)     // find 未命中 → || null
  ok('isAllowed/getCliEntry 边界：非数组 whitelist / null name / 未命中 → null')
}

console.log(`\ntest-cli-whitelist: ${passed} passed`)
