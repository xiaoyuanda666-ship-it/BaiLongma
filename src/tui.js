import readline from 'readline'
import { pushMessage } from './queue.js'

export function startTUI(userId = 'ID:000001') {
  // 非交互式终端（如后台运行、管道）时跳过 TUI
  if (!process.stdin.isTTY) {
    console.log('[TUI] 非交互式模式，TUI 已跳过（使用 API 发消息）')
    return
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\n你: '
  })

  rl.prompt()

  rl.on('line', (line) => {
    const text = line.trim()
    if (text) {
      pushMessage(userId, text)
    }
    rl.prompt()
  })

  rl.on('close', () => {
    console.log('\nJarvis 关闭中...')
    process.exit(0)
  })
}
