import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { constants } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Launch executables directly so spaces in paths and signal forwarding do not
// depend on cmd.exe, PowerShell, or a POSIX shell.
export function start(mode = 'app', extraArgs = [], {
  root = repoRoot,
  processRef = process,
  spawnImpl = spawn,
  exists = existsSync,
  execFileSyncImpl = execFileSync,
  electronPath = () => require('electron'),
} = {}) {
  if (!['app', 'backend', 'dev'].includes(mode)) {
    throw new Error(`Unknown startup mode: ${mode}`)
  }
  if (processRef.platform === 'win32') {
    // Preserve UTF-8 in the attached Windows console, without a shell wrapper
    // around the long-running child or inherited chcp output handles.
    execFileSyncImpl(processRef.env.ComSpec || 'cmd.exe', ['/d', '/c', 'chcp 65001'], { stdio: 'ignore' })
  }
  const isApp = mode === 'app'
  const command = isApp ? electronPath() : processRef.execPath
  const args = isApp ? [root] : [
    ...(exists(path.join(root, '.env')) ? [`--env-file=${path.join(root, '.env')}`] : []),
    ...(mode === 'dev' ? ['--watch'] : []),
    path.join(root, 'src/index.js'),
  ]
  const env = { ...processRef.env }
  if (isApp) delete env.ELECTRON_RUN_AS_NODE
  const child = spawnImpl(command, [...args, ...extraArgs], { cwd: root, env, stdio: 'inherit' })
  const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => child.kill(signal)]))
  for (const [signal, handler] of handlers) processRef.on(signal, handler)
  const cleanup = () => {
    for (const [signal, handler] of handlers) processRef.removeListener(signal, handler)
  }
  child.once('error', error => {
    cleanup()
    console.error(`Unable to start BaiLongma: ${error.message}`)
    processRef.exitCode = 1
  })
  child.once('exit', (code, signal) => {
    cleanup()
    processRef.exitCode = code ?? (128 + (constants.signals[signal] || 1))
  })
  return child
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    start(process.argv[2], process.argv.slice(3))
  } catch (error) {
    console.error(`Unable to start BaiLongma: ${error.message}`)
    process.exitCode = 1
  }
}
