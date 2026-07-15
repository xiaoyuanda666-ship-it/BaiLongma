// 回归测试：run_cli 经 execCommandNoShell 以 argv 直传 spawn(shell:false)，
// 参数里的 shell 元字符（; $() 反引号）是字面量，不会被解释为命令拼接。
// 这正是 #2 修复点：修复前 args 被拼进 `spawn(command, {shell:true})`，
// args="x; echo INJECTED" 会执行第二条命令。
//
// 这里直接测 execCommandNoShell（run_cli 的执行核心），用一个真实安全二进制（node -e）
// 验证：元字符出现在 argv 里时，它们被当作 node 脚本的字面字符串处理，而非 shell 命令。
// Run: node src/test-run-cli-noshell.js
import assert from 'node:assert/strict'
import { execCommandNoShell } from './capabilities/tools/shell.js'

let passed = 0
const ok = n => { passed += 1; console.log('  ✓', n) }

console.log('test-run-cli-noshell: run_cli 无 shell 注入防护\n')

// --- 正常执行：node -e "console.log('hello')" ---
{
  const r = await execCommandNoShell(
    { bin: process.execPath, args: ['-e', "console.log('hello')"] },
    {}
  )
  const obj = JSON.parse(r)
  assert.equal(obj.ok, true, '正常调用应成功')
  assert.ok(obj.stdout.includes('hello'), `stdout 应含 hello: ${obj.stdout}`)
  ok('正常 argv 执行：node -e console.log(hello)')
}

// --- 注入回归：元字符在 argv 里是字面量，不触发 shell 拼接 ---
// node -e "process.stdout.write(process.argv[1])" "; echo INJECTED"
// 若走 shell:true，`;` 会分隔命令并执行 echo INJECTED → stdout 含 "INJECTED"。
// 走 shell:false（已修复），`; echo INJECTED` 作为单个 argv 传给 node，被当字面字符串打印。
{
  const r = await execCommandNoShell(
    {
      bin: process.execPath,
      args: ['-e', "process.stdout.write(process.argv[1])", '; echo INJECTED'],
    },
    {}
  )
  const obj = JSON.parse(r)
  assert.equal(obj.ok, true)
  // 关键断言：stdout 是字面 "; echo INJECTED"，而不是 shell 执行 echo 的输出
  assert.equal(
    obj.stdout.trim(),
    '; echo INJECTED',
    `元字符应被当字面量，实际 stdout: "${obj.stdout}"`
  )
  assert.ok(!obj.stdout.includes('INJECTED\n') || obj.stdout.includes('; echo INJECTED'),
    '不应出现 shell 注入执行的独立 INJECTED 行')
  ok('注入回归：`; echo INJECTED` 作为字面 argv，未被 shell 解释')
}

// --- 反引号 / $() / | 同理是字面量 ---
{
  const r = await execCommandNoShell(
    {
      bin: process.execPath,
      args: ['-e', "process.stdout.write(process.argv[1])", '$(whoami) `id` | cat'],
    },
    {}
  )
  const obj = JSON.parse(r)
  assert.equal(obj.ok, true)
  assert.equal(
    obj.stdout.trim(),
    '$(whoami) `id` | cat',
    `命令替换/管道符应字面量，实际: "${obj.stdout}"`
  )
  ok('命令替换 $(...)、反引号、管道符均字面量，零注入')
}

// --- 参数数组形态：每个 token 独立 argv（不被空格合并）---
{
  // 两个含空格的 token，shell 拆分会破坏它们；argv 直传保留原样
  const r = await execCommandNoShell(
    {
      bin: process.execPath,
      args: ['-e', "process.stdout.write(JSON.stringify(process.argv.slice(1)))", 'with space', 'a;b'],
    },
    {}
  )
  const obj = JSON.parse(r)
  assert.equal(obj.ok, true)
  const argvTail = JSON.parse(obj.stdout)
  assert.deepEqual(argvTail, ['with space', 'a;b'], '含空格/分号的 token 应原样保留为独立 argv')
  ok('argv token 边界保留：含空格与分号的 token 不被拆分')
}

console.log(`\ntest-run-cli-noshell: ${passed} passed`)
