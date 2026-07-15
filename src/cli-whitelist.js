// 配置驱动的 CLI 白名单：声明式列出 agent 可经 run_cli 调用的本机 CLI（首版 gbrain）。
// run_cli 只放行白名单内的 CLI（比 exec_command 的任意 shell 更窄、更安全）。
// 纯逻辑（+ 读 config.json 块），可在纯 node 下单测。见 .claude/plans/cli-tool-invocation.plan.md M1。

// 默认白名单。path 省略 → 走 PATH 解析（execCommand/execCommandNoShell 已回退到 PATH）。
// 不把绝对路径写进源码：那是本机/某用户私有路径，分发到其他机器会 ENOENT，且泄露维护者目录。
// 若你的 Electron 环境确实缺 PATH（GUI 启动拿不到 ~/.bun/bin 等），在本地 config.json 的
// cli_whitelist 块里给该 CLI 配 path（按机器覆盖，不进仓库）：
//   { "cli_whitelist": [{ "name": "gbrain", "path": "/Users/you/.bun/bin/gbrain" }] }
export const DEFAULT_WHITELIST = [
  {
    name: 'gbrain',
    description: '本地知识库 gbrain（只读优先：search/query/ask/get/list/tags/backlinks/graph；put/delete/import/sync/embed 为写操作，TICK 自主时慎用）',
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
