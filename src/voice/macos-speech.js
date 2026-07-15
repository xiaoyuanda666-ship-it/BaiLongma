import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { paths } from '../paths.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function resolveMacSpeechBinary() {
  const candidates = []
  // macOS 26 TCC 只认 .app bundle 的 Info.plist，不认裸 Mach-O 的 __TEXT,__info_plist。
  // 裸二进制调用 Speech/麦克风 API 会被 SIGABRT（TCC_CRASHING_DUE_TO_PRIVACY_VIOLATION），
  // 因此优先查找 .app bundle 内的可执行文件；裸二进制仅作旧版/打包兼容的 fallback。
  if (paths.resourcesDir.endsWith('.asar')) {
    const unpacked = paths.resourcesDir.replace(/\.asar$/, '.asar.unpacked')
    candidates.push(path.join(unpacked, 'build', 'native-speech-recognizer.app', 'Contents', 'MacOS', 'native-speech-recognizer'))
    candidates.push(path.join(unpacked, 'build', 'native-speech-recognizer'))
    candidates.push(path.join(unpacked, 'src', 'voice', 'native-speech-recognizer'))
  }
  candidates.push(path.join(paths.resourcesDir, 'build', 'native-speech-recognizer.app', 'Contents', 'MacOS', 'native-speech-recognizer'))
  candidates.push(path.join(paths.resourcesDir, 'build', 'native-speech-recognizer'))
  candidates.push(path.join(paths.resourcesDir, 'src', 'voice', 'native-speech-recognizer'))
  candidates.push(path.join(__dirname, 'native-speech-recognizer'))

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { cmd: candidate, args: [] }
  }

  const source = path.join(__dirname, 'macos-speech.swift')
  if (fs.existsSync(source)) return { cmd: 'swift', args: [source] }
  return null
}

function normalizeLang(lang = 'zh-CN') {
  const value = String(lang || 'zh-CN').trim()
  if (/^en/i.test(value)) return 'en-US'
  if (/^zh/i.test(value)) return 'zh-CN'
  return value
}

export function createMacSpeechSession(config = {}, onTranscript, onError, onClose) {
  if (process.platform !== 'darwin') {
    onError('Mac 本地语音识别只支持 macOS')
    return null
  }

  const resolved = resolveMacSpeechBinary()
  if (!resolved) {
    onError('找不到 macOS 本地语音识别模块')
    return null
  }

  const lang = normalizeLang(config.lang)
  const mode = String(config.mode || config.recognitionMode || 'auto').trim() || 'auto'
  const child = spawn(resolved.cmd, [...resolved.args, '--lang', lang, '--mode', mode], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LANG: 'en_US.UTF-8' },
  })

  let stdoutBuffer = ''
  let closed = false
  let forceKillTimer = null

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8')
    const lines = stdoutBuffer.split(/\r?\n/)
    stdoutBuffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.type === 'transcript' && msg.text) {
          onTranscript(msg.text, !!msg.is_final)
        } else if (msg.type === 'error') {
          onError(msg.message || 'macOS 本地语音识别错误')
        }
      } catch {
        console.log(`[Voice:macOS] ${line}`)
      }
    }
  })

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8').trim()
    if (text) console.warn(`[Voice:macOS] ${text}`)
  })

  child.on('error', (err) => {
    onError(`macOS 本地语音识别启动失败: ${err.message}`)
  })

  child.on('exit', (code, signal) => {
    if (forceKillTimer) {
      clearTimeout(forceKillTimer)
      forceKillTimer = null
    }
    if (closed) {
      onClose?.()
      return
    }
    closed = true
    if (code && code !== 0) onError(`macOS 本地语音识别已退出 (code ${code}${signal ? `, signal ${signal}` : ''})`)
    onClose?.()
  })

  return {
    sendAudio() {},
    flush() {},
    close() {
      if (closed) return
      closed = true
      try { child.kill('SIGTERM') } catch {}
      forceKillTimer = setTimeout(() => {
        forceKillTimer = null
        if (!child.killed || child.exitCode === null) {
          try { child.kill('SIGKILL') } catch {}
        }
      }, 800)
      forceKillTimer.unref?.()
    },
  }
}
