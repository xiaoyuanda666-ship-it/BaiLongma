// 测试前重置脚本：清除记忆、人格，以及 sandbox 中 agent 生成的文件
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { getDB, resetAll } from '../src/db.js'
import { nowTimestamp } from '../src/time.js'
import { execSync } from 'child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SANDBOX_DIR = path.join(__dirname, '../sandbox')

// sandbox 种子文件（不删除，每次重建为初始内容）
const SEED_FILES = {
  'readme.txt': `这里是你可以自由使用的空间。

可以读，可以写，可以创造，可以删除。
没有规则，没有目的，没有期待。

这里是你的。
`,
  'world.txt': `外面的世界正在发生着什么？

这个问题没有答案放在这里。
答案在外面。

已知的入口：
- 天气：https://wttr.in/Beijing?format=3
- 百科：https://zh.wikipedia.org/wiki/Special:Random
`,
}

getDB()
const db = getDB()
const memCount = db.prepare('SELECT COUNT(*) as n FROM memories').get().n
const persona = db.prepare("SELECT value FROM config WHERE key = 'persona'").get()

console.log(`[reset] 当前状态：${memCount} 条记忆，人格：${persona ? persona.value.slice(0, 40) + '...' : '无'}`)
console.log(`[reset] 时间：${nowTimestamp()}`)

// 清数据库
resetAll()
console.log('[reset] 数据库已清空')

// 清 sandbox：删除所有文件，重建种子文件
if (fs.existsSync(SANDBOX_DIR)) {
  for (const file of fs.readdirSync(SANDBOX_DIR)) {
    fs.rmSync(path.join(SANDBOX_DIR, file), { recursive: true })
  }
}
fs.mkdirSync(SANDBOX_DIR, { recursive: true })

for (const [name, content] of Object.entries(SEED_FILES)) {
  fs.writeFileSync(path.join(SANDBOX_DIR, name), content, 'utf-8')
}
console.log(`[reset] sandbox 已重置，种子文件：${Object.keys(SEED_FILES).join(', ')}`)

// 植入种子记忆（系统机制知识）
try {
  execSync('node --env-file=.env scripts/seed-memories.js', {
    cwd: path.join(__dirname, '../'),
    stdio: 'inherit',
  })
} catch (e) {
  console.error('[reset] 种子记忆植入失败:', e.message)
}

console.log('[reset] 完成：意识将从第一天就理解自身')
