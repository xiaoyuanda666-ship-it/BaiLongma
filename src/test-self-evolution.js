import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

let failed = 0
function assert(cond, label) {
  if (cond) {
    console.log(`PASS: ${label}`)
  } else {
    console.error(`FAIL: ${label}`)
    failed++
    process.exitCode = 1
  }
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tempUserDir = fs.mkdtempSync(path.join(repoRoot, 'sandbox', 'self-evolution-test-'))
process.env.JARVIS_USER_DIR = tempUserDir
process.env.USERPROFILE = tempUserDir
process.env.HOME = tempUserDir

try {
  const db = await import('./db.js')
  const evo = await import('./memory/self-evolution.js')

  db.getDB()
  evo.resetSelfEvolutionState()

  db.upsertMemoryByMemId({
    mem_id: 'lesson_file_work_verify_after_patch',
    type: 'knowledge',
    title: 'Verify file edits after patch',
    content: 'After editing files, run the relevant test or syntax check before reporting success.',
    detail: 'This lesson came from a failed file-edit workflow.',
    entities: ['agent:jarvis'],
    tags: ['kind:failure_lesson', 'domain:file_work', 'trigger:test', 'trigger:verify'],
    salience: 4,
    timestamp: '2026-06-29T00:00:00.000Z',
  })

  db.upsertMemoryByMemId({
    mem_id: 'fact_user_prefers_green_tea',
    type: 'fact',
    title: 'Tea preference',
    content: 'The user prefers green tea.',
    detail: 'Plain user preference, not an agent behavior update.',
    entities: ['ID:000001'],
    tags: [],
    salience: 2,
    timestamp: '2026-06-29T00:01:00.000Z',
  })

  const first = evo.recordSelfEvolutionFromMemories([
    { mem_id: 'lesson_file_work_verify_after_patch', action: 'inserted' },
    { mem_id: 'fact_user_prefers_green_tea', action: 'inserted' },
  ])

  assert(first.length === 1, 'only actionable policy-like memories are recorded')
  assert(first[0]?.kind === 'failure_lesson', 'kind is derived from kind:* tag')

  let state = evo.getSelfEvolutionState()
  assert(state.total_events === 1, 'total event count increments')
  assert(state.learned_count === 1, 'learned count tracks unique recent memories')
  assert(state.recent[0]?.mem_id === 'lesson_file_work_verify_after_patch', 'recent journal stores the learned memory')

  const second = evo.recordSelfEvolutionFromMemories([
    { mem_id: 'lesson_file_work_verify_after_patch', action: 'updated' },
  ])

  state = evo.getSelfEvolutionState()
  assert(second.length === 1, 'updates to actionable memories are recorded')
  assert(state.total_events === 2, 'updates count as evolution events')
  assert(state.learned_count === 1, 'duplicate mem_id does not duplicate recent journal')
  assert(state.recent[0]?.action === 'updated', 'recent journal keeps the latest action for a memory')

  const promptText = evo.formatSelfEvolutionForPrompt({ maxRecent: 3 })
  assert(promptText.includes('Self-evolution loop is active'), 'prompt formatter renders the safety framing')
  assert(promptText.includes('lesson_file_work_verify_after_patch'), 'prompt formatter includes recent learned memory id')
} catch (err) {
  failed++
  process.exitCode = 1
  console.error(`FAIL: unexpected error: ${err.stack || err.message}`)
} finally {
  try { fs.rmSync(tempUserDir, { recursive: true, force: true }) } catch {}
}

console.log(failed === 0 ? '\nAll self-evolution tests passed' : `\n${failed} self-evolution test(s) failed`)
process.exit(failed === 0 ? 0 : 1)
