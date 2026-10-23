import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { runProcess } from './release-engine.mjs'
import { redactLog } from './core.mjs'

const directory = path.dirname(fileURLToPath(import.meta.url))
const project = process.env.JAPLOS_PROJECT_ROOT || path.join(os.homedir(), 'Documents/Codex/Bailongma2.0')
const updateProject = process.env.JAPLOS_UPDATE_SERVER_PROJECT || path.join(os.homedir(), 'Documents/小白龙更新服务器')
let job = null

export function validateJaplosAction(body) {
  if (!['scan', 'preflight', 'dry-run'].includes(body.action)) throw new Error('Unsupported Japlos action')
  if (!Array.isArray(body.archs) || !body.archs.length || body.archs.some(arch => !['arm64', 'x64'].includes(arch))) throw new Error('Select a valid architecture')
  return { action: body.action, archs: [...new Set(body.archs)] }
}

export function japlosJob() { return job }

export function startJaplosJob(body) {
  const request = validateJaplosAction(body)
  if (job?.state === 'running') throw new Error('Japlos v2 检查正在运行，请等待完成')
  const current = { ...request, state: 'running', startedAt: new Date().toISOString(), result: null, error: null }
  job = current
  runProcess(process.env.PYTHON || 'python3', [path.join(directory, 'japlos-inspect.py'), request.action, project, updateProject, ...request.archs], {
    timeoutMs: 20 * 60_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  }).then(result => {
    current.result = JSON.parse(result.stdout)
    current.state = 'completed'
  }).catch(error => {
    current.error = redactLog(error.message)
    current.state = 'failed'
  }).finally(() => { current.endedAt = new Date().toISOString() })
  return current
}
