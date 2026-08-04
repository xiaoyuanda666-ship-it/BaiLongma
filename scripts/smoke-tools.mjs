import { executeTool } from '../src/capabilities/executor.js'

const checks = []

function assert(condition, label, detail = '') {
  checks.push({ ok: !!condition, label, detail })
  if (!condition) {
    console.error(`[FAIL] ${label}${detail ? `\n  ${detail}` : ''}`)
  } else {
    console.log(`[PASS] ${label}`)
  }
}

function parseJsonResult(value) {
  try {
    return JSON.parse(String(value || ''))
  } catch {
    return null
  }
}

const testPath = `smoke/verifiable-${Date.now()}.txt`
const testContent = 'hello verifiable completion'

const writeResultText = await executeTool('write_file', {
  path: testPath,
  content: testContent,
}, { source: 'smoke-test' })
const writeResult = parseJsonResult(writeResultText)
assert(writeResult?.ok === true && writeResult?.verified === true, 'write_file returns verified evidence', writeResultText)
assert(writeResult?.bytes === Buffer.byteLength(testContent, 'utf-8'), 'write_file reports byte count', writeResultText)

const readResult = await executeTool('read_file', { path: testPath }, { source: 'smoke-test' })
assert(readResult === testContent, 'read_file reads back exact content', readResult)

const outsideRead = await executeTool('read_file', { path: '../package.json' }, { source: 'smoke-test' })
assert(/^执行失败：访问被拒绝/.test(String(outsideRead)), 'read_file rejects sandbox escape', outsideRead)

const deniedCommandText = await executeTool('run_command', {
  command: 'type ..\\package.json',
}, { source: 'smoke-test' })
const deniedCommand = parseJsonResult(deniedCommandText)
assert(deniedCommand?.ok === false && deniedCommand?.error === 'permission denied', 'run_command rejects parent directory access', deniedCommandText)

const quickCommandText = await executeTool('run_command', {
  command: 'node -e "console.log(\'quick-ok\')"',
  mode: 'quick',
}, { source: 'smoke-test' })
const quickCommand = parseJsonResult(quickCommandText)
assert(quickCommand?.ok === true && quickCommand?.tool === 'run_command' && quickCommand?.command_profile === 'quick' && /quick-ok/.test(quickCommand?.stdout || ''), 'run_command uses quick mode', quickCommandText)

const taskCommandText = await executeTool('run_command', {
  command: 'node -e "console.log(\'task-ok\')"',
  mode: 'task',
  timeout: 5,
}, { source: 'smoke-test' })
const taskCommand = parseJsonResult(taskCommandText)
assert(taskCommand?.ok === true && taskCommand?.tool === 'run_command' && taskCommand?.command_profile === 'task' && /task-ok/.test(taskCommand?.stdout || ''), 'run_command uses task mode', taskCommandText)

const badDownloadText = await executeTool('download_file', {
  url: 'file:///not-allowed',
  output_path: 'smoke/download.txt',
}, { source: 'smoke-test' })
const badDownload = parseJsonResult(badDownloadText)
assert(badDownload?.ok === false && badDownload?.tool === 'download_file', 'download_file validates URL scheme', badDownloadText)

const deleteResultText = await executeTool('delete_file', { path: testPath }, { source: 'smoke-test' })
const deleteResult = parseJsonResult(deleteResultText)
assert(deleteResult?.ok === true && deleteResult?.verified_absent === true, 'delete_file returns absence verification', deleteResultText)

const failed = checks.filter(item => !item.ok)
console.log(`\nSmoke checks: ${checks.length - failed.length}/${checks.length} passed`)
if (failed.length) {
  process.exitCode = 1
}
