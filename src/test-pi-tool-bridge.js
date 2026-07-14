// 通用工具桥纯逻辑单测：schema → Pi 定义的形状转换 + executeTool 结果归一。
// 只测零依赖的 tool-transform.js（不引入 Pi / executor / db），保证纯 node 可跑。
// 见 .claude/plans/pi-sdk-turn-engine-migration-m3.plan.md Slice 1。
import assert from 'node:assert/strict'
import { toToolDefinition, normalizeToolResult } from './pi/tool-transform.js'
import { memorySchemas } from './capabilities/schemas/memory.js'

let passed = 0
const ok = name => { passed += 1; console.log('  ✓', name) }

console.log('test-pi-tool-bridge: tool-transform 纯逻辑\n')

// --- toToolDefinition：OpenAI 形状 → Pi 定义 ---
{
  // Arrange：upsert_memory 有嵌套参数（memories[].tags[]），正好验证复杂 schema 不被压平。
  const schema = memorySchemas.upsert_memory
  const ctx = { currentChannel: 'TUI', currentTargetId: 'ID:000001' }
  const calls = []
  const mockExec = async (name, args, context) => {
    calls.push({ name, args, context })
    return 'ok: 1 written'
  }

  // Act
  const def = toToolDefinition(schema, ctx, mockExec)

  // Assert：解包 .function，字段正确
  assert.equal(def.name, 'upsert_memory')
  assert.equal(def.label, 'upsert_memory')
  assert.ok(def.description.length > 0)
  // 嵌套 parameters 原样保留（按引用相等 = 没被 clone / 压平）
  assert.equal(def.parameters, schema.function.parameters)
  assert.equal(def.parameters.properties.memories.items.properties.tags.type, 'array')

  // execute 真实签名 (toolCallId, params, signal, onUpdate, ctx) —— params 在第 2 位
  const toolArgs = { memories: [{ mem_id: 'fact_x', title: 't', content: 'c', tags: ['kind:fact'] }] }
  const res = await def.execute('call_test_1', toolArgs, undefined, undefined, undefined)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'upsert_memory')
  assert.deepEqual(calls[0].args, toolArgs)
  assert.deepEqual(calls[0].context, ctx)
  assert.equal(res.isError, false)
  assert.equal(res.content[0].type, 'text')
  assert.equal(res.content[0].text, 'ok: 1 written')
  ok('toToolDefinition 解包 .function、保留嵌套 parameters、execute 转发并归一')
}

// --- toToolDefinition：缺 name 显式抛错 ---
{
  assert.throws(() => toToolDefinition({ function: {} }, {}, async () => ''), /function\.name/)
  ok('toToolDefinition 缺 name 时显式抛错（不静默）')
}

// --- normalizeToolResult：各种输入 ---
{
  // 成功字符串
  let r = normalizeToolResult('done')
  assert.equal(r.isError, false)
  assert.equal(r.content[0].text, 'done')
  // 中文错误前缀
  r = normalizeToolResult('执行失败：boom')
  assert.equal(r.isError, true)
  // {ok:false} JSON
  r = normalizeToolResult(JSON.stringify({ ok: false, error: 'denied' }))
  assert.equal(r.isError, true)
  // {ok:true} JSON
  r = normalizeToolResult(JSON.stringify({ ok: true, data: 1 }))
  assert.equal(r.isError, false)
  // 对象输入（兜底取 content[0].text / stringify）
  r = normalizeToolResult({ content: [{ type: 'text', text: 'from-obj' }] })
  assert.equal(r.content[0].text, 'from-obj')
  ok('normalizeToolResult 成功 / 中文错误 / {ok:false} / 对象输入 均正确判定 isError')
}

// --- normalizeToolResult：边界（对象无 content[0].text → stringify；null；空串；英文错误）---
{
  let r = normalizeToolResult({ foo: 'bar' })            // 对象无 content[0].text → JSON.stringify
  assert.equal(r.isError, false)
  assert.equal(r.content[0].text, JSON.stringify({ foo: 'bar' }))
  r = normalizeToolResult(null)                           // null（typeof null === 'object'）
  assert.equal(r.content[0].text, 'null')
  assert.equal(r.isError, false)
  r = normalizeToolResult('')                             // 空串 → 非错误
  assert.equal(r.isError, false)
  r = normalizeToolResult('Error: boom')                 // 英文 error 前缀
  assert.equal(r.isError, true)
  ok('normalizeToolResult 对象无 text / null / 空串 / 英文错误 均正确')
}

// --- toToolDefinition：flat schema（无 .function 包裹，直接是 {name,parameters,...}）---
{
  const flat = {
    name: 'flat_tool', description: 'd',
    parameters: { type: 'object', properties: { a: { type: 'string' } } },
  }
  const def = toToolDefinition(flat, {}, async () => 'ok')
  assert.equal(def.name, 'flat_tool')
  assert.equal(def.parameters, flat.parameters)           // 直接用 schema.parameters
  ok('toToolDefinition 接受 flat schema（无 .function 包裹）')
}

// --- toToolDefinition：缺 parameters / 缺 description → 默认兜底 ---
{
  const minimal = { function: { name: 'mini' } }          // 无 description、无 parameters
  const def = toToolDefinition(minimal, {}, async () => 'ok')
  assert.equal(def.name, 'mini')
  assert.equal(def.description, 'mini')                   // 缺 description → 用 name
  assert.deepEqual(def.parameters, { type: 'object', properties: {}, additionalProperties: false })
  ok('toToolDefinition 缺 parameters/description 时用默认兜底')
}

console.log(`\ntest-pi-tool-bridge: ${passed} passed`)
