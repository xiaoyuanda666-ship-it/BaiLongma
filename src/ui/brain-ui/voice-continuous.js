// voice-continuous.js —— 常开监听模式策略
//
// 这是会话的「默认策略」：麦克风常开、流式识别、静音 3.5s 自动断句发送，
// 以及 TTS 播放期间的 barge-in 打断检测（duck → 判语音/噪音）。
// 所有「何时发送」「是否打断」的决策都在这里；底层麦克风/ASR 传输在 voice-core.js。
//
// 通过 core 的钩子被安装为会话策略（见 voice-panel.js 编排层）：
//   onFrame / onTranscript / onSessionStop / onSuspendForTTS / onResume
// PTT 模式通过 core.pttHolding 在本策略之上「叠加」（按住时屏蔽自动发送）。

import { BARGEIN_THRESHOLD } from './voice-core.js';

// ─── 打断检测参数 ───
const BARGEIN_WARMUP_MS = 600; // TTS 开始后前 600ms 不检测（等 AEC 适应）

// ─── Duck 模式参数（两阶段检测：先压制音量再判断是否打断） ───
// 检测到高振幅先 duck（降音量），持续高振幅才真正打断；冲击噪音消退后直接恢复音量
const DUCK_TRIGGER_FRAMES = 3;    // 连续 3 帧高振幅 → 进入 duck 模式（≈50ms）
const DUCK_SUSTAIN_FRAMES = 10;   // duck 中再持续 10 帧高振幅 → 判定为语音，触发真正打断
const DUCK_DECAY_FRAMES   = 6;    // duck 中连续 6 帧低振幅（≈100ms）→ 判定为噪音，恢复音量
const DUCK_MAX_MS         = 1500; // duck 最长持续时间，超时自动恢复

// ─── 快速非语音检测参数（真正打断后仍保留，用于误打断的快速恢复） ───
const BARGEIN_FAST_WINDOW_MS   = 500;
const BARGEIN_FAST_SILENT_THR  = BARGEIN_THRESHOLD * 0.65;
const BARGEIN_FAST_SILENT_NEED = 7;

const BARGEIN_NO_SPEECH_MS = 3500; // 3.5s 内没有识别到语音 → 视为误触发

// ─── 自动发送：音量顺延的宽限窗口 ───
// 纯噪音（高音量但不产生转录文本）不应顺延一条已识别完成消息的发送。
// 仅当距上次「新转录」在此窗口内，才把音量活动当作「还在说话」而顺延静音计时——
// 覆盖说话中音频抖动早于转录回调到达的情况；说完话后的持续噪音超出窗口即失效。
const VOICE_GRACE_AFTER_TRANSCRIPT_MS = 800;

export function createContinuousPolicy(core, { getAutoSend }) {
  // ─── 自动发送状态 ───
  // 「攒成一条，说完再发」：只有真正停足够久才发，中途思考停顿不切断。
  // 静音阈值可经 localStorage 调，默认 2s（比一次思考停顿长，比一句话间隔长）。
  const SILENCE_SEND_MS = (() => {
    const v = parseInt(localStorage.getItem('bailongma-voice-silence-ms') || '', 10);
    return Number.isFinite(v) && v >= 800 ? v : 2000;
  })();
  let autoSendTimer = null;
  // 最近一次「用户还在说」的时间戳。自动发送靠它自校正：计时器到点时若期间又有
  // 活动则顺延而不是误发。何为「活动」：真实转录（新文本）总是算；纯音量仅在
  // 「刚产生过转录」的宽限窗口内才算——见 lastTranscriptTs / onFrame。
  let lastVoiceActivityTs = 0;
  // 最近一次产生「新转录文本」的时间戳。噪音不是文字、不产生转录，故不会刷新它。
  // 用来把「说话时音频抖动顺延」与「说完后纯噪音顺延」区分开：只有距上次转录在
  // 宽限窗口内的音量才允许顺延，避免噪音无限推迟一条已识别完成消息的发送。
  let lastTranscriptTs = 0;
  function noteVoiceActivity() { lastVoiceActivityTs = Date.now(); }

  // ─── 打断检测状态 ───
  let bargeinFrames = 0;       // 阶段一：等待触发 duck 的高振幅帧计数
  let duckActive = false;
  let duckHighFrames = 0;      // duck 中持续高振幅帧数（→判语音→打断）
  let duckLowFrames = 0;       // duck 中持续低振幅帧数（→判噪音→恢复）
  let duckStartTime = 0;
  // 快速非语音检测状态（真正打断后仍保留作为兜底）
  let bargeinFastCheckActive = false;
  let bargeinFastCheckStart = 0;
  let bargeinFastSilentFrames = 0;
  // 噪音误触发恢复：barge-in 后若 ASR 一直无输出则重新播放 TTS
  let bargeinNoSpeechTimer = null;

  function clearBargeinNoSpeechTimer() {
    if (bargeinNoSpeechTimer) {
      clearTimeout(bargeinNoSpeechTimer);
      bargeinNoSpeechTimer = null;
    }
  }

  // 启动误触发恢复计时：若 N 毫秒内没有真实语音输入，则续播 TTS
  function startBargeinNoSpeechTimer() {
    clearBargeinNoSpeechTimer();
    bargeinNoSpeechTimer = setTimeout(() => {
      bargeinNoSpeechTimer = null;
      // 没有收到任何语音 → 噪音误触发，让 agent 继续说
      window.resumeTTSIfNoSpeech?.();
    }, BARGEIN_NO_SPEECH_MS);
  }

  // 自动发送：攒成一条，只有真正停说 SILENCE_SEND_MS 后才整条发出。
  // 中途停顿（思考、换气、句间）只要还在 SILENCE_SEND_MS 内就不发，避免把长消息切碎/丢尾。
  // 计时器到点时若期间又有语音活动（noteVoiceActivity），自动顺延剩余时间，而不是误发。
  function scheduleAutoSend() {
    if (core.pttHolding) return;       // PTT 按住期间禁用自动发送（由 pttEnd 统一发送）
    if (getAutoSend?.() === false) return; // 关了自动发送 → 纯手动（回车 / 松 PTT）
    noteVoiceActivity();
    if (autoSendTimer) return; // 已有计时器在跑，靠 lastVoiceActivityTs 自校正，无需重置
    const tick = () => {
      const idle = Date.now() - lastVoiceActivityTs;
      if (idle >= SILENCE_SEND_MS) {
        autoSendTimer = null;
        core.setStatus('processing');
        core.sendRecognizedVoiceText();
      } else {
        // 期间又说话了 → 顺延到「最后活动 + 静音窗口」
        autoSendTimer = setTimeout(tick, SILENCE_SEND_MS - idle);
      }
    };
    autoSendTimer = setTimeout(tick, SILENCE_SEND_MS);
  }

  function cancelAutoSend() {
    if (autoSendTimer) { clearTimeout(autoSendTimer); autoSendTimer = null; }
  }

  // ─── core 钩子：每帧音量 → barge-in 检测 + 活动计时 ───
  function onFrame(vol) {
    // 打断检测：TTS 播放中持续检测用户声音（两阶段：duck → 判断语音/噪音）
    if (core.suspendedByMedia) {
      const aecReady = Date.now() - core.ttsStartTime > BARGEIN_WARMUP_MS;
      if (aecReady) {
        if (!duckActive) {
          // 阶段一：等待触发 duck
          if (vol > BARGEIN_THRESHOLD) {
            if (++bargeinFrames >= DUCK_TRIGGER_FRAMES) {
              bargeinFrames = 0;
              duckActive = true;
              duckStartTime = Date.now();
              duckHighFrames = 0;
              duckLowFrames = 0;
              window.duckTTS?.();
            }
          } else {
            bargeinFrames = 0;
          }
        } else {
          // 阶段二：duck 中判断是语音还是冲击噪音
          const duckElapsed = Date.now() - duckStartTime;
          if (vol > BARGEIN_THRESHOLD) {
            duckHighFrames++;
            duckLowFrames = 0;
            if (duckHighFrames >= DUCK_SUSTAIN_FRAMES) {
              // 声音持续高振幅 → 语音 → 真正打断
              duckActive = false;
              duckHighFrames = 0;
              window.stopTTS?.();
              core.resumeSession(true);
              bargeinFastCheckActive = true;
              bargeinFastCheckStart = Date.now();
              bargeinFastSilentFrames = 0;
            }
          } else {
            duckLowFrames++;
            duckHighFrames = 0;
            if (duckLowFrames >= DUCK_DECAY_FRAMES || duckElapsed >= DUCK_MAX_MS) {
              // 声音迅速消退 → 冲击噪音 → 恢复原音量，TTS 不中断
              duckActive = false;
              duckLowFrames = 0;
              window.unduckTTS?.();
            }
          }
        }
      }
    }

    // 快速非语音检测（仅在真正打断后作为兜底：防止极短语音触发打断后继续重播）
    if (bargeinFastCheckActive) {
      const elapsed = Date.now() - bargeinFastCheckStart;
      if (vol < BARGEIN_FAST_SILENT_THR) {
        if (++bargeinFastSilentFrames >= BARGEIN_FAST_SILENT_NEED) {
          bargeinFastCheckActive = false;
          bargeinFastSilentFrames = 0;
          clearBargeinNoSpeechTimer();
          window.resumeTTSIfNoSpeech?.();
        }
      } else {
        bargeinFastSilentFrames = 0;
      }
      if (elapsed >= BARGEIN_FAST_WINDOW_MS) {
        bargeinFastCheckActive = false;
        bargeinFastSilentFrames = 0;
      }
    }

    // 用户还在出声且「刚产生过转录」→ 视为仍在连续语音中（音频抖动可能早于转录
    // 回调到达），顺延自动发送，避免说话间隙误发。关键：限定在 lastTranscriptTs 的
    // 宽限窗口内——说完话后的纯噪音不产生新文本、超出窗口即不再顺延，于是一条已
    // 识别完成的消息不会被环境噪音无限推迟发送。仅在录音且非 TTS 时计。
    if (vol > 0.02 && core.micActive && !core.suspendedByMedia
        && Date.now() - lastTranscriptTs < VOICE_GRACE_AFTER_TRANSCRIPT_MS) {
      noteVoiceActivity();
    }
  }

  // ─── core 钩子：收到一条 transcript 后的策略 ───
  function onTranscript() {
    // 收到真实语音 → 取消所有误触发恢复机制（正常流程下这些本就处于关闭态，清理为 no-op）
    bargeinFastCheckActive = false;
    bargeinFastSilentFrames = 0;
    clearBargeinNoSpeechTimer();
    lastTranscriptTs = Date.now(); // 「新文本」时刻：音量顺延的宽限窗口从此刻起算
    scheduleAutoSend();
  }

  // ─── core 钩子：会话停止时清理本策略的计时器/检测状态 ───
  function onSessionStop() {
    cancelAutoSend();
    clearBargeinNoSpeechTimer();
    bargeinFastCheckActive = false;
    bargeinFastSilentFrames = 0;
    duckActive = false;
    duckHighFrames = 0;
    duckLowFrames = 0;
    lastTranscriptTs = 0;
  }

  // ─── core 钩子：进入 TTS 挂起时重置打断检测计数 ───
  function onSuspendForTTS() {
    bargeinFrames = 0;
    duckActive = false;
    duckHighFrames = 0;
    duckLowFrames = 0;
  }

  // ─── core 钩子：会话恢复时重置 / 启动续播计时 ───
  function onResume(fromBargein) {
    bargeinFrames = 0;
    if (fromBargein) startBargeinNoSpeechTimer();
  }

  return {
    onFrame,
    onTranscript,
    onSessionStop,
    onSuspendForTTS,
    onResume,
    cancelAutoSend,
    clearNoSpeechTimer: clearBargeinNoSpeechTimer,
  };
}
