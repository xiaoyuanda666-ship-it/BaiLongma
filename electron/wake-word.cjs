// wake-word.cjs —— 主进程侧的语音唤醒管理器
//
// 不在主进程里直接跑 sherpa:它自带 onnxruntime,与后端 transformers 的 onnxruntime-node
// 同进程会原生崩溃(已坐实)。改为 fork 一个只加载 sherpa 的 utilityProcess(kws-process.cjs),
// 本模块只负责:启动子进程、转发 PCM、转达命中。第一步仅检测+写日志,不做其他动作。
const { utilityProcess } = require('electron')
const path = require('path')

let child = null
let spawned = false
let onHit = null

// 把模型目录解析到真实文件系统(打包后走 .asar.unpacked)
function resolveModelDir(codeRoot) {
  const base = codeRoot.endsWith('.asar')
    ? codeRoot.replace(/\.asar$/, '.asar.unpacked')
    : codeRoot
  return path.join(base, 'src', 'voice', 'kws-model')
}

/**
 * 启动唤醒子进程。fork 失败不抛(不拖垮 app)。
 * @returns {boolean} 是否成功 fork(引擎是否就绪由子进程异步回报 'ready')
 */
function initWakeWord({ codeRoot, logDir }) {
  if (child) return spawned
  const modelDir = resolveModelDir(codeRoot)
  const logFile = path.join(logDir, 'wake-word.log')
  try {
    child = utilityProcess.fork(path.join(__dirname, 'kws-process.cjs'), [], {
      stdio: 'inherit',
      serviceName: 'jarvis-kws',
    })
    child.on('message', (msg) => {
      if (!msg) return
      if (msg.type === 'ready') {
        console.log('[wake] KWS 子进程就绪')
      } else if (msg.type === 'error') {
        console.error('[wake] KWS 子进程初始化失败(功能禁用):', msg.error)
      } else if (msg.type === 'hit') {
        console.log('[wake] 命中唤醒词:', msg.keyword)
        try { onHit && onHit(msg.keyword) } catch {}
      }
    })
    child.on('exit', (code) => {
      console.warn('[wake] KWS 子进程退出 code=' + code)
      child = null
      spawned = false
    })
    // 等子进程真正起好再发 init,否则 fork 后立刻 post 可能在监听器挂上前丢失
    child.on('spawn', () => {
      try { child.postMessage({ type: 'init', modelDir, logFile }) } catch {}
    })
    spawned = true
    return true
  } catch (err) {
    console.error('[wake] 无法启动 KWS 子进程(忽略):', err?.message || err)
    child = null
    return false
  }
}

/**
 * 转发一块 16kHz Float32 PCM 给子进程。接受 ArrayBuffer / TypedArray。
 * 用 transfer 移交 ArrayBuffer,避免跨进程拷贝。
 */
function feedPcm(buffer) {
  if (!child || !buffer) return
  let ab = null
  if (buffer instanceof ArrayBuffer) ab = buffer
  else if (ArrayBuffer.isView(buffer)) ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  else return
  // 注意:Electron utilityProcess.postMessage 的 transfer 列表只接受 MessagePortMain,
  // 放 ArrayBuffer 会抛错。这里直接结构化克隆(每块 ~6KB,频率低,拷贝开销可忽略)。
  try { child.postMessage({ type: 'pcm', buf: ab }) } catch (err) {
    console.error('[wake] feedPcm 投递失败:', err?.message || err)
  }
}

function isEnabled() { return spawned }
function setOnHit(cb) { onHit = cb }

module.exports = { initWakeWord, feedPcm, isEnabled, setOnHit }
