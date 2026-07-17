// TTS 实时声音特效层 —— 把 TTS 干声接进 Web Audio 效果链，实时渲染出"贾维斯"科幻质感
//
// 效果链（综合科幻 AI 配音常用手法：环形调制 + 合唱失谐 + 金属梳状 + 通信带通 + 混响 + 压缩）：
//   <audio> → MediaElementSource
//           → 高通 → 低通(通信底色) → 临场峰值(金属脆感)  ┐  = 预处理后的「pre」
//           ├─ 干声直达
//           ├─ 卷积混响(代码合成 IR，太空舱空间感)
//           ├─ 合唱/失谐(LFO 调制短延时，AI 加倍厚度)
//           ├─ 金属梳状/Flanger(反馈短延时+LFO扫动，金属共振/扫频)
//           ├─ 驱动/失真(waveshaper，重量感/颗粒感)
//           └─ 环形调制(信号×振荡器，机器人金属签名音)
//           → 汇总 → 限制器 + 软削波(tanh 砖墙，防止叠加后爆音) → 扬声器
//
// 安全原则：任何一步不可用（Web Audio 缺失 / 上下文未被用户手势解锁 / 创建失败）
// 都直接放弃接管，退回 <audio> 原生播放，绝不让声音变哑。

import { applyContextSink } from './audio-output.js'

const FX_STORAGE_KEY = 'bailongma.ttsfx.v2'      // 音效参数（手感）；v2＝金属感默认调高+新增金属/Flanger参数
const FX_VOICES_KEY = 'bailongma.ttsfx.voices'   // 哪些音色开启了音效（音色 ID 列表）

// 音效是「按音色」开启的可选功能，默认全关 —— 只有被显式打开的音色才叠加。
// 默认档＝明显能听出的"贾维斯"质感（可被 localStorage 覆盖后实时生效）。
const DEFAULTS = {
  // —— EQ / 通信底色 ——
  highpassFreq: 110,     // Hz，去低频轰鸣（170→110，保留更多低频 body＝更厚重）
  lowpassFreq: 7200,     // Hz，轻微对讲机式高频滚降（保留清晰度，别太闷）
  presenceFreq: 3000,    // Hz，临场峰值中心
  presenceGain: 6.0,     // dB，金属脆感（5→6）
  presenceQ: 1.2,
  // —— 混响（空间感）—— 回音太重时主要砍这里；保持低
  reverbSeconds: 0.5,    // 混响尾巴长度（短，去回音感）
  reverbDecay: 3.2,      // 衰减指数，越大尾巴收得越快
  preDelaySec: 0.015,    // 预延时，贴近干声
  dry: 0.8,              // 干声电平（让出空间给加重的支路）
  wet: 1.0,              // 混响电平（用户定档；滑块上限已放宽到 2）
  // —— 合唱/失谐（AI 加倍厚度，科幻感的关键之一）——
  chorus: 1.0,           // 混入量（用户定档；上限 2）
  chorusDelayMs: 22,     // 基准延时
  chorusDepthMs: 3,      // LFO 调制深度（失谐量）
  chorusRateHz: 0.35,    // LFO 速率
  // —— 金属梳状/Flanger（短延时+反馈＝金属共振；反馈是金属感命门）——
  metallic: 1.0,         // 混入量（上限 2）
  metallicDelayMs: 6,    // 共振延时，越短金属音越高（1/延时=共振频率）
  metallicFeedback: 0.6, // 反馈量（金属感命门，0.3→0.6，调高更金属；上限 0.92）
  flangerRateHz: 0.2,    // Flanger LFO 速率（扫动梳状＝金属扫频流动感）
  flangerDepthMs: 2.5,   // Flanger 扫动深度
  // —— 驱动/失真：重量感和颗粒感（不产生回音）——
  drive: 0.4,            // 0~1 失真曲线强度
  driveMix: 0.03,        // 并联混入量（上限 2）
  // —— 环形调制（机器人金属签名音，不产生回音）——
  ring: 0.4,             // 混入量（0.27→0.4，调高更像机器人；上限 2）
  ringHz: 150,           // 调制频率（90→150，经典机器人区间），低＝闪烁/高＝刺耳电子
  // —— 总输出 ——
  output: 0.8,           // 留余量给压缩器（支路变多，略降防过载）
}

function readParams() {
  let saved = {}
  try {
    const raw = localStorage.getItem(FX_STORAGE_KEY)
    if (raw) saved = JSON.parse(raw) || {}
  } catch { /* ignore */ }
  return { ...DEFAULTS, ...saved }
}

// 持久化部分参数（供设置面板调用），返回合并后的完整参数
export function setJarvisFxParams(patch = {}) {
  const next = { ...readParams(), ...patch }
  try { localStorage.setItem(FX_STORAGE_KEY, JSON.stringify(next)) } catch { /* ignore */ }
  return next
}

export function getJarvisFxParams() {
  return readParams()
}

// 清除自定义参数，恢复默认档
export function resetJarvisFxParams() {
  try { localStorage.removeItem(FX_STORAGE_KEY) } catch { /* ignore */ }
  return { ...DEFAULTS }
}

// ── 按音色的开关（默认全关，显式打开才生效）─────────────────────────────────
function readEnabledVoices() {
  try {
    const raw = localStorage.getItem(FX_VOICES_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

export function isFxEnabledForVoice(voiceId) {
  if (!voiceId) return false
  return readEnabledVoices().includes(voiceId)
}

export function setFxEnabledForVoice(voiceId, on) {
  if (!voiceId) return
  const set = new Set(readEnabledVoices())
  if (on) set.add(voiceId); else set.delete(voiceId)
  try { localStorage.setItem(FX_VOICES_KEY, JSON.stringify([...set])) } catch { /* ignore */ }
}

// ── 付费解锁（基于时间的一次性密码）────────────────────────────────────────
// 密码＝20 位数字，格式：秒RR 分RR 时RR 日RR 月RR
//   （UTC 的秒/分/时/日/月 各 2 位，每个后面紧跟 2 位随机 RR）。
// 校验：取偶数段还原时间，与设备当前时间比，≤1 小时才解锁（永久）。
// 注意：纯客户端校验，是付费门槛/君子协议，非强加密保护。
// 生成器只在 scripts/gen-fx-password.mjs（作者专用），此处仅校验，不生成。
const UNLOCK_KEY = 'bailongma.ttsfx.unlocked'
const PW_WINDOW_MS = 60 * 60 * 1000  // 1 小时有效窗口

// 解码密码 → 返回它代表的时间与当前时间的最小绝对差(ms)；格式非法返回 null
function decodeFxPasswordDiff(password) {
  const s = String(password || '').replace(/\D/g, '')
  if (s.length !== 20) return null
  // 秒RR分RR时RR日RR月RR：真实分量在每 4 位的前 2 位
  const ss = +s.slice(0, 2), mi = +s.slice(4, 6), hh = +s.slice(8, 10)
  const dd = +s.slice(12, 14), MM = +s.slice(16, 18)
  if (ss > 59 || mi > 59 || hh > 23 || dd < 1 || dd > 31 || MM < 1 || MM > 12) return null
  const now = Date.now()
  const y = new Date(now).getUTCFullYear()
  let best = Infinity
  for (const yy of [y - 1, y, y + 1]) {            // 跨年/跨月边界：取最近的候选
    const t = Date.UTC(yy, MM - 1, dd, hh, mi, ss)
    const diff = Math.abs(t - now)
    if (diff < best) best = diff
  }
  return best
}

export function isFxUnlocked() {
  try { return localStorage.getItem(UNLOCK_KEY) === '1' } catch { return false }
}

export function tryUnlockFx(password) {
  const diff = decodeFxPasswordDiff(password)
  if (diff == null) return { ok: false, reason: '密码格式不正确' }
  if (diff > PW_WINDOW_MS) return { ok: false, reason: '密码已过期（超过 1 小时），请重新向作者索取' }
  try { localStorage.setItem(UNLOCK_KEY, '1') } catch { /* ignore */ }
  return { ok: true }
}

// ── 懒加载共享 AudioContext ───────────────────────────────────────────────────
let _ctx = null
function ensureCtx() {
  if (_ctx) return _ctx
  const AudioCtx = window.AudioContext || window.webkitAudioContext
  if (!AudioCtx) return null
  try { _ctx = new AudioCtx() } catch { return null }
  return _ctx
}

export async function resumeJarvisAudioContext() {
  const ctx = ensureCtx()
  if (!ctx) return { supported: false, state: 'unavailable' }
  try {
    if (ctx.state === 'suspended') await ctx.resume()
  } catch (error) {
    return { supported: true, state: ctx.state, error: String(error?.message || error) }
  }
  return { supported: true, state: ctx.state }
}

// 失真曲线（经典 waveshaper 公式）：amount 0~1，越大越脏越有"重量颗粒感"
function makeDistortionCurve(amount) {
  const k = Math.max(0, amount) * 120
  const n = 8192
  const curve = new Float32Array(n)
  const deg = Math.PI / 180
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1
    curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x))
  }
  return curve
}

// 软削波曲线（tanh 砖墙）：把任何过冲平滑压进 [-1,1]，杜绝数字硬削波爆音。
// 小信号近似线性(tanh(x)≈x)，大信号饱和，过载时是柔和失真而非爆裂。
function makeSoftClipCurve() {
  const n = 8192
  const curve = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1
    curve[i] = Math.tanh(x)
  }
  return curve
}

// 用代码合成一段卷积混响的脉冲响应：衰减噪声 + 预延时，立体声
function buildImpulseResponse(ctx, p) {
  const rate = ctx.sampleRate
  const preDelay = Math.max(0, Math.floor(p.preDelaySec * rate))
  const tail = Math.max(1, Math.floor(p.reverbSeconds * rate))
  const len = preDelay + tail
  const ir = ctx.createBuffer(2, len, rate)
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch)
    for (let i = preDelay; i < len; i++) {
      const n = (i - preDelay) / tail
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - n, p.reverbDecay)
    }
  }
  return ir
}

// 在 ctx 上为 source 搭建效果链并连到 destination。
// 返回 { ok, teardown }；teardown 停掉振荡器并断开 source（播放结束时调用，防泄漏）。
// 中途失败则直连兜底（保证有声），返回 ok:false + 空 teardown。
function buildChain(ctx, source, p) {
  const oscillators = []
  let done = false
  const teardown = () => {
    if (done) return
    done = true
    for (const o of oscillators) { try { o.stop() } catch { /* ignore */ } }
    try { source.disconnect() } catch { /* ignore */ }
  }
  try {
    // —— 预处理：高通 → 低通 → 临场峰值 ——
    const highpass = ctx.createBiquadFilter()
    highpass.type = 'highpass'
    highpass.frequency.value = p.highpassFreq

    const lowpass = ctx.createBiquadFilter()
    lowpass.type = 'lowpass'
    lowpass.frequency.value = p.lowpassFreq

    const presence = ctx.createBiquadFilter()
    presence.type = 'peaking'
    presence.frequency.value = p.presenceFreq
    presence.gain.value = p.presenceGain
    presence.Q.value = p.presenceQ

    source.connect(highpass)
    highpass.connect(lowpass)
    lowpass.connect(presence)
    const pre = presence  // 各支路都从 pre 取信号

    // —— 末端：汇总 → 限制器(压峰值) → 软削波(砖墙防爆音) → 扬声器 ——
    // 各支路叠加后电平可能远超 0dB；限制器先压峰值，软削波兜底保证绝不硬削波。
    const out = ctx.createGain()
    // 20ms 淡入，消除起播瞬态的"咔哒"声
    const now = ctx.currentTime
    out.gain.setValueAtTime(0.0001, now)
    out.gain.exponentialRampToValueAtTime(Math.max(0.0002, p.output), now + 0.02)

    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -3   // 接近 0dB 才介入
    limiter.knee.value = 0         // 硬拐点＝真限制
    limiter.ratio.value = 20       // 高压缩比＝限制器
    limiter.attack.value = 0.002   // 快速抓峰值
    limiter.release.value = 0.12

    const softclip = ctx.createWaveShaper()
    softclip.curve = makeSoftClipCurve()
    softclip.oversample = '4x'     // 过采样减少削波带来的混叠

    out.connect(limiter)
    limiter.connect(softclip)
    softclip.connect(ctx.destination)

    // —— 干声直达 ——
    const dryGain = ctx.createGain()
    dryGain.gain.value = p.dry
    pre.connect(dryGain)
    dryGain.connect(out)

    // —— 卷积混响 ——
    if (p.wet > 0) {
      const convolver = ctx.createConvolver()
      convolver.buffer = buildImpulseResponse(ctx, p)
      const wetGain = ctx.createGain()
      wetGain.gain.value = p.wet
      pre.connect(convolver)
      convolver.connect(wetGain)
      wetGain.connect(out)
    }

    // —— 合唱/失谐：LFO 调制短延时 → AI 加倍厚度 ——
    if (p.chorus > 0) {
      const chDelay = ctx.createDelay(0.1)
      chDelay.delayTime.value = Math.max(0.001, p.chorusDelayMs / 1000)
      const lfo = ctx.createOscillator()
      lfo.type = 'sine'
      lfo.frequency.value = p.chorusRateHz
      const lfoDepth = ctx.createGain()
      lfoDepth.gain.value = p.chorusDepthMs / 1000
      lfo.connect(lfoDepth)
      lfoDepth.connect(chDelay.delayTime)
      const chGain = ctx.createGain()
      chGain.gain.value = p.chorus
      pre.connect(chDelay)
      chDelay.connect(chGain)
      chGain.connect(out)
      lfo.start()
      oscillators.push(lfo)
    }

    // —— 金属梳状 / Flanger：短延时 + 反馈 = 金属共振；LFO 扫动 = 金属扫频 ——
    if (p.metallic > 0) {
      const baseMs = Math.max(1, p.metallicDelayMs)
      const delay = ctx.createDelay(0.05)
      delay.delayTime.value = baseMs / 1000
      const fb = ctx.createGain()
      fb.gain.value = Math.min(0.92, Math.max(0, p.metallicFeedback)) // <1 保证稳定不自激
      // Flanger：LFO 扫动延时时长（深度限制在基准的 60% 内，防止延时变负）
      if (p.flangerDepthMs > 0 && p.flangerRateHz > 0) {
        const depthMs = Math.min(p.flangerDepthMs, baseMs * 0.6)
        const lfo = ctx.createOscillator()
        lfo.type = 'sine'
        lfo.frequency.value = p.flangerRateHz
        const lfoDepth = ctx.createGain()
        lfoDepth.gain.value = depthMs / 1000
        lfo.connect(lfoDepth)
        lfoDepth.connect(delay.delayTime)
        lfo.start()
        oscillators.push(lfo)
      }
      const combGain = ctx.createGain()
      combGain.gain.value = p.metallic * 0.5
      pre.connect(delay)
      delay.connect(fb)
      fb.connect(delay)      // 反馈回路 → 金属共振
      delay.connect(combGain)
      combGain.connect(out)
    }

    // —— 驱动/失真：给声音重量感和颗粒感（并联，不产生回音）——
    if (p.driveMix > 0 && p.drive > 0) {
      const shaper = ctx.createWaveShaper()
      shaper.curve = makeDistortionCurve(p.drive)
      shaper.oversample = '2x'
      const driveGain = ctx.createGain()
      driveGain.gain.value = p.driveMix
      pre.connect(shaper)
      shaper.connect(driveGain)
      driveGain.connect(out)
    }

    // —— 环形调制：信号 × 振荡器 → 机器人金属签名音 ——
    // 把振荡器(±1)连到增益的 gain（基值 0），即 output = input × osc(t)
    if (p.ring > 0) {
      const ringGain = ctx.createGain()
      ringGain.gain.value = 0
      const ringOsc = ctx.createOscillator()
      ringOsc.type = 'sine'
      ringOsc.frequency.value = p.ringHz
      ringOsc.connect(ringGain.gain)
      const ringMix = ctx.createGain()
      ringMix.gain.value = p.ring
      pre.connect(ringGain)
      ringGain.connect(ringMix)
      ringMix.connect(out)
      ringOsc.start()
      oscillators.push(ringOsc)
    }

    return { ok: true, teardown }
  } catch {
    // 搭链中途失败：source 可能已被占用，直连兜底避免变哑
    teardown()
    try { source.connect(ctx.destination) } catch { /* ignore */ }
    return { ok: false, teardown: () => {} }
  }
}

// 对一个 <audio> 元素接管播放并加特效。返回是否成功接管。
// 仅当该音色被显式开启音效时才接管；否则原样原生播放。
// 调用时机：new Audio(url) 之后、.play() 之前。
export function attachJarvisFx(audioEl, voiceId) {
  if (!audioEl) return false
  if (!isFxUnlocked()) return false                 // 未付费解锁 → 不接管
  if (!isFxEnabledForVoice(voiceId)) return false   // 该音色未开音效 → 不接管
  const p = readParams()
  const ctx = ensureCtx()
  if (!ctx) return false
  // 上下文未被用户手势解锁：踢一次 resume，本轮跳过（退回原生播放，绝不变哑）
  if (ctx.state !== 'running') {
    ctx.resume?.().catch(() => {})
    return false
  }
  let source
  try {
    // 同一元素只能 createMediaElementSource 一次；每次播放都是新元素故安全
    source = ctx.createMediaElementSource(audioEl)
  } catch {
    return false  // 创建失败：元素未被占用，原生播放照常
  }
  const { ok, teardown } = buildChain(ctx, source, p)
  if (ok) {
    // 播放结束/出错/被替换暂停时，停掉振荡器并断开，避免节点泄漏
    // 用 addEventListener 不会被调用方的 .onended= 赋值覆盖
    audioEl.addEventListener('ended', teardown)
    audioEl.addEventListener('error', teardown)
    audioEl.addEventListener('pause', teardown)
  }
  return ok
}

function shouldUseFx(voiceId) {
  return isFxUnlocked() && isFxEnabledForVoice(voiceId)
}

export function attachJarvisAudioGraph(audioEl, voiceId) {
  if (!audioEl) return null
  const ctx = ensureCtx()
  if (!ctx) return null
  if (ctx.state !== 'running') {
    ctx.resume?.().catch(() => {})
    return null
  }

  let mediaSource
  try {
    mediaSource = ctx.createMediaElementSource(audioEl)
  } catch {
    return null
  }

  const analyser = ctx.createAnalyser()
  analyser.fftSize = 512
  analyser.smoothingTimeConstant = 0.5

  let fxTeardown = null
  let done = false
  const teardown = () => {
    if (done) return
    done = true
    try { fxTeardown?.() } catch { /* ignore */ }
    try { analyser.disconnect() } catch { /* ignore */ }
    try { mediaSource.disconnect() } catch { /* ignore */ }
    audioEl.removeEventListener('ended', teardown)
    audioEl.removeEventListener('error', teardown)
    audioEl.removeEventListener('pause', teardown)
  }

  try {
    mediaSource.connect(analyser)
    if (shouldUseFx(voiceId)) {
      const chain = buildChain(ctx, analyser, readParams())
      fxTeardown = chain.teardown
    } else {
      analyser.connect(ctx.destination)
    }
    // 声音经此 ctx 输出 → 把输出设备 sink 设在 ctx 上（元素的 setSinkId 在此被绕过）。
    applyContextSink(ctx).catch(() => {})
  } catch {
    teardown()
    try {
      mediaSource.connect(ctx.destination)
      applyContextSink(ctx).catch(() => {})
      return {
        analyser: null,
        teardown: () => { try { mediaSource.disconnect() } catch { /* ignore */ } },
      }
    } catch { /* ignore */ }
    return null
  }

  audioEl.addEventListener('ended', teardown)
  audioEl.addEventListener('error', teardown)
  audioEl.addEventListener('pause', teardown)
  return { analyser, teardown }
}
