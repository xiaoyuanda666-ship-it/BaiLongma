#!/usr/bin/env node

import { spawn } from 'node:child_process'
import process from 'node:process'
import { publishUpdates } from '../../scripts/publish-updates-lib.mjs'
import { redactLog, validateReleaseRequest } from './core.mjs'

function emit(type, detail = {}) {
  process.stdout.write(`${JSON.stringify({ type, at: new Date().toISOString(), ...detail })}\n`)
}

function readInput() {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    process.stdin.on('data', chunk => {
      size += chunk.length
      if (size > 64 * 1024) reject(new Error('Worker input is too large'))
      else chunks.push(chunk)
    })
    process.stdin.once('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch (error) { reject(new Error(`Invalid worker input: ${error.message}`)) }
    })
    process.stdin.once('error', reject)
  })
}

function runBuild(root, archs) {
  return new Promise((resolve, reject) => {
    emit('state', { state: 'VALIDATING', message: `Building ${archs.join(' + ')}` })
    const child = spawn(process.execPath, ['scripts/build-mac.mjs', ...archs], {
      cwd: root,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const forward = (stream, level) => stream.on('data', chunk => {
      for (const line of chunk.toString('utf8').split(/\r?\n/).filter(Boolean)) emit('log', { level, message: redactLog(line) })
    })
    forward(child.stdout, 'info')
    forward(child.stderr, 'error')
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`macOS build exited with ${code}`)))
  })
}

try {
  const input = await readInput()
  const request = validateReleaseRequest(input.request, input.pkg.version)
  if (input.action === 'build') {
    await runBuild(input.root, request.archs)
    emit('complete', { action: 'build' })
  } else if (input.action === 'publish') {
    const originalConsole = { log: console.log, warn: console.warn, error: console.error }
    console.log = (...args) => emit('log', { level: 'info', message: redactLog(args.join(' ')) })
    console.warn = (...args) => emit('log', { level: 'warn', message: redactLog(args.join(' ')) })
    console.error = (...args) => emit('log', { level: 'error', message: redactLog(args.join(' ')) })
    try {
      const argv = [
        ...(request.dryRun ? ['--dry-run', '--skip-smoke'] : ['--yes']),
        ...request.archs.map(arch => `--arch=${arch}`),
      ]
      const result = await publishUpdates({
        platform: 'mac',
        root: input.root,
        pkg: input.pkg,
        argv,
        releaseOptions: { releaseNotes: request.releaseNotes, stagingPercentage: request.stagingPercentage },
        onEvent: event => emit('engine', { event }),
      })
      emit('complete', { action: 'publish', result })
    } finally {
      Object.assign(console, originalConsole)
    }
  } else {
    throw new Error('Unknown worker action')
  }
} catch (error) {
  emit('fatal', { message: redactLog(error?.message || error) })
  process.exitCode = 1
}
