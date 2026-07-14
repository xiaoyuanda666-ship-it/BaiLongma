// 配置驱动的 CLI 白名单：声明式列出 agent 可经 run_cli 调用的本机 CLI（首版 gbrain）。
// run_cli 只放行白名单内的 CLI（比 exec_command 的任意 shell 更窄、更安全）。
// 纯逻辑（+ 读 config.json 块），可在纯 node 下单测。见 .claude/plans/cli-tool-invocation.plan.md M1。

// 默认白名单。path 可选——Electron 进程 PATH 常缺失用户级 bin（如 ~/.bun/bin），
// 故 gbrain 用实测到的绝对路径，避免"command not found"。可在 config 覆盖。
export const DEFAULT_WHITELIST = [
  {
    name: 'gbrain',
    description: '本地知识库 gbrain（只读优先：search/query/ask/get/list/tags/backlinks/graph；put/delete/import/sync/embed 为写操作，TICK 自主时慎用）',
    path: '/Users/richard/.bun/bin/gbrain',
  },
]

// 纯函数：configured 与 default 合并（default ∪ configured，同名 configured 覆盖）。
// configured 为空/非法 → 用 default。便于单测（不碰文件）。
export function mergeWhitelist(configured, defaults = DEFAULT_WHITELIST) {
  if (!Array.isArray(configured) || configured.length === 0) return defaults
  const byName = new Map()
  for (const e of defaults) if (e && e.name) byName.set(e.name, e)
  for (const e of configured) if (e && e.name) byName.set(e.name, e)
  return [...byName.values()]
}

// 纯函数：name 是否在给定白名单内。
export function isAllowed(name, whitelist) {
  const n = String(name || '').trim()
  return (Array.isArray(whitelist) ? whitelist : []).some(e => e && e.name === n)
}

import fs from 'node:fs'

// 读 config.json 的 cli_whitelist 块。路径解析与 src/config.js 对齐：
// Electron 用 JARVIS_USER_DIR（userData）；纯 node 退到仓库 ./config.json（无块 → 用默认）。
function readConfigBlock() {
  try {
    const userDir = process.env.JARVIS_USER_DIR
    const file = userDir ? `${userDir}/config.json` : './config.json'
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return Array.isArray(raw?.cli_whitelist) ? raw.cli_whitelist : null
  } catch { return null }
}

let _cached = null
export function loadCliWhitelist() {
  if (_cached) return _cached
  _cached = mergeWhitelist(readConfigBlock(), DEFAULT_WHITELIST)
  return _cached
}

// 测试用：重置缓存。
export function _resetCacheForTest() { _cached = null }

export function isCliAllowed(name) {
  return isAllowed(name, loadCliWhitelist())
}

export function getCliEntry(name) {
  const n = String(name || '').trim()
  return loadCliWhitelist().find(e => e && e.name === n) || null
}

export function listAllowedClis() {
  return loadCliWhitelist().map(e => ({ name: e.name, description: e.description || '' }))
}
