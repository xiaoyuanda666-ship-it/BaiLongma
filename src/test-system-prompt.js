import { getDB, getConfig } from './db.js'
import { formatTick } from './time.js'
import { buildHeartbeatSystemPromptPreview } from './system-prompt-preview.js'

getDB()

const stateSnapshot = {
  action: null,
  task: getConfig('current_task') || null,
  prev_recall: null,
  lastToolResult: null,
  sessionCounter: 0,
  recentActions: [],
  thoughtStack: [],
}

async function run() {
  const preview = await buildHeartbeatSystemPromptPreview({
    stateSnapshot,
    message: formatTick(),
  })

  console.log('=== HEARTBEAT SYSTEM PROMPT PREVIEW ===')
  console.log(`message: ${preview.message}`)
  console.log(`conversationWindow: ${preview.injection.conversationWindow.length}`)
  console.log(`actionLog: ${preview.injection.actionLog.length}`)
  console.log(`memories: ${preview.injection.memories.length}`)
  console.log(`recallMemories: ${preview.injection.recallMemories.length}`)
  console.log(`taskKnowledge: ${preview.injection.taskKnowledge.length}`)
  console.log('\n=== SYSTEM PROMPT START ===\n')
  console.log(preview.systemPrompt)
  console.log('\n=== SYSTEM PROMPT END ===')
}

run().catch(err => {
  console.error('[test-system-prompt] failed:', err)
  process.exitCode = 1
})
