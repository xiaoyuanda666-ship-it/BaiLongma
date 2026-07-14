// 复现"旧版 config.json 被新版加载/迁移"的过程，排查升级配置问题用。
//
// 它把一份旧格式 config.json 放进隔离临时目录，用新代码（src/config.js）加载一次，
// 打印 BEFORE / AFTER 对照（config.json + seedance.json）和内存中的 config 状态。
// 全程不碰真实配置、不启动整个 app、不撞单实例锁。
//
// 用法：
//   node scripts/probe-config-upgrade.mjs                 # 用内置"正常旧配置"样本（含内联 seedance）
//   node scripts/probe-config-upgrade.mjs broken          # 用内置"坏形状"样本（未知 provider，验证分块容错）
//   node scripts/probe-config-upgrade.mjs path\to\old.json # 用你自己的旧 config.json（自动去 BOM）
//   ... 末尾加 --keep 保留临时目录以便手动检查
//
// 注意：本工具会主动清空 LLM / seedance 相关环境变量，避免 env 兜底干扰"纯文件加载"视图。

import fs from 'fs'
import os from 'os'
import path from 'path'

// 内置样本：典型的旧版（无 schemaVersion + 内联 seedance），且 security 关了沙盒——
// 用来验证升级后这些"兄弟字段"是否被保留（旧代码会把它们一起重置）。
const SAMPLE_NORMAL = {
  provider: 'deepseek',
  apiKey: 'sk-OLD-FAKE-KEY-1234567890abcdef',
  model: 'deepseek-chat',
  temperature: 0.7,
  security: { fileSandbox: true, execSandbox: false, blockedTools: ['exec_command'] },
  voice: { voiceProvider: 'aliyun', aliyunApiKey: 'sk-aliyunFAKE1234567890abcdef' },
  tts: { ttsProvider: 'doubao', ttsVoiceId: 'zh_female_xiaohe_uranus_bigtts' },
  seedance: { apiKey: 'ark-OLD-FAKE', model: 'doubao-seedance-2-0-260128', baseURL: 'https://ark.cn-beijing.volces.com/api/v3' },
}

// "坏形状"样本：provider 是新版不认识的名字。预期：LLM 标记待激活，但 security/voice 全保留。
const SAMPLE_BROKEN = {
  provider: 'some-removed-provider',
  apiKey: 'sk-OLD-FAKE-KEY-1234567890abcdef',
  model: 'old-model',
  temperature: 1.2,
  security: { fileSandbox: false, execSandbox: false, blockedTools: ['exec_command'] },
  voice: { voiceProvider: 'aliyun', aliyunApiKey: 'sk-aliyunFAKE1234567890abcdef' },
}

const args = process.argv.slice(2)
const keep = args.includes('--keep')
const target = args.find(a => a !== '--keep')

function loadInputConfig() {
  if (!target || target === 'sample') return { src: '内置样本(正常旧配置)', obj: SAMPLE_NORMAL }
  if (target === 'broken') return { src: '内置样本(坏形状/未知 provider)', obj: SAMPLE_BROKEN }
  // 当作文件路径：读入并去 BOM 后解析（用户文件可能被编辑器存成带 BOM）
  let raw = fs.readFileSync(target, 'utf-8')
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  try {
    return { src: path.resolve(target), obj: JSON.parse(raw) }
  } catch (e) {
    console.error(`无法解析 ${target} 为 JSON：${e.message}`)
    process.exit(1)
  }
}

function clearInterferingEnv() {
  const keys = [
    'DEEPSEEK_API_KEY', 'MINIMAX_API_KEY', 'OPENAI_API_KEY', 'DASHSCOPE_API_KEY',
    'MOONSHOT_API_KEY', 'ZHIPU_API_KEY', 'MIMO_API_KEY',
    'ARK_API_KEY', 'SEEDANCE_API_KEY',
  ]
  const cleared = keys.filter(k => process.env[k])
  for (const k of keys) delete process.env[k]
  return cleared
}

function readJsonFile(p) {
  try {
    let raw = fs.readFileSync(p, 'utf-8')
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
    return raw
  } catch {
    return null
  }
}

function section(title) {
  console.log(`\n${'─'.repeat(4)} ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`)
}

const { src, obj } = loadInputConfig()
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-cfgprobe-'))
const configFile = path.join(dir, 'config.json')
const seedanceFile = path.join(dir, 'seedance.json')

// Node writeFileSync 写 UTF-8 不带 BOM —— 与真实 app 写盘一致，避免 JSON.parse 撞 BOM
fs.writeFileSync(configFile, JSON.stringify(obj, null, 2), 'utf-8')

const clearedEnv = clearInterferingEnv()
process.env.JARVIS_USER_DIR = dir

console.log(`输入来源 : ${src}`)
console.log(`隔离目录 : ${dir}`)
if (clearedEnv.length) console.log(`已临时清空干扰环境变量: ${clearedEnv.join(', ')}`)

section('BEFORE — 旧版格式 config.json')
console.log(readJsonFile(configFile))
console.log(`（schemaVersion 存在? ${Object.prototype.hasOwnProperty.call(obj, 'schemaVersion')}；内联 seedance? ${Object.prototype.hasOwnProperty.call(obj, 'seedance')}）`)

section('加载日志 + 内存 config 状态')
const mod = await import(new URL('../src/config.js', import.meta.url).href)
const c = mod.config
console.log(`  needsActivation : ${c.needsActivation}`)
console.log(`  provider/model  : ${c.provider} / ${c.model}`)
console.log(`  temperature     : ${c.temperature}`)
console.log(`  security        : ${JSON.stringify(c.security)}`)
console.log(`  seedance(独立)  : ${JSON.stringify(mod.getSeedanceConfig())}`)

section('AFTER — 迁移后的 config.json')
console.log(readJsonFile(configFile))

section('AFTER — seedance.json（迁移生成）')
console.log(readJsonFile(seedanceFile) ?? '(未生成)')

if (keep) {
  console.log(`\n临时目录已保留：${dir}`)
} else {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  console.log('\n临时目录已清理（加 --keep 可保留以便手动检查）')
}
