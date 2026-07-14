// voice-continuous.js —— 常开监听模式策略
//
// 这是会话的「默认策略」：麦克风常开、流式识别、转写停更后自动断句发送，
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
const ECHO_MARGIN_VOL     = 0.025; // TTS 回声基线外还要多出的音量，才算用户插话候选
const ECHO_HARD_VOL       = 0.16;  // 极高麦克风音量直接允许进入打断候选，避免基线过高挡住真插话

// ─── 快速非语音检测参数（真正打断后仍保留，用于误打断的快速恢复） ───
const BARGEIN_FAST_WINDOW_MS   = 500;
const BARGEIN_FAST_SILENT_THR  = BARGEIN_THRESHOLD * 0.65;
const BARGEIN_FAST_SILENT_NEED = 7;

const BARGEIN_NO_SPEECH_MS = 3500; // 3.5s 内没有识别到语音 → 视为误触发

export function createContinuousPolicy(core, { getAutoSend }) {
  // ─── 自动发送状态 ───
  // 「攒成一条，说完再发」：只有转写文本停更足够久才发。底噪/呼吸/键盘声不刷新计时。
  // 延迟可经 localStorage 调，默认 2s（比一次思考停顿长，比一句话间隔长）。
  const SILENCE_SEND_MS = (() => {
    const v = parseInt(localStorage.getItem('jarvis-voice-silence-ms') || '', 10);
    return Number.isFinite(v) && v >= 800 ? v : 2000;
  })();
  let autoSendTimer = null;
  // 最近一次「转写文本发生变化」的时间戳。自动发送只看它；麦克风音量不参与重置。
  let lastTranscriptActivityTs = 0;
  let lastObservedTranscriptText = '';
  function noteTranscriptActivity() { lastTranscriptActivityTs = Date.now(); }

  // ─── 打断检测状态 ───
  let bargeinFrames = 0;       // 阶段一：等待触发 duck 的高振幅帧计数
  let duckActive = false;
  let duckHighFrames = 0;      // duck 中持续高振幅帧数（→判语音→打断）
  let duckLowFrames = 0;       // duck 中持续低振幅帧数（→判噪音→恢复）
  let duckStartTime = 0;
  let ttsEchoFloor = 0;        // TTS 播放期麦克风收到的扬声器回声基线
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

  function resetEchoFloor() {
    ttsEchoFloor = 0;
  }

  function learnEchoFloor(vol, { force = false } = {}) {
    const raw = Math.max(0, Number(vol) || 0);
    if (!force && raw > BARGEIN_THRESHOLD) return;
    const sample = Math.min(raw, BARGEIN_THRESHOLD);
    ttsEchoFloor = ttsEchoFloor
      ? (ttsEchoFloor * 0.9 + sample * 0.1)
      : sample;
  }

  function isBargeinCandidate(vol, frame = {}) {
    if (vol <= BARGEIN_THRESHOLD) return false;
    if (!frame.ttsActive) return true;
    const guard = Math.max(BARGEIN_THRESHOLD, ttsEchoFloor + ECHO_MARGIN_VOL);
    return vol >= ECHO_HARD_VOL || vol > guard;
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

  // 自动发送：攒成一条，只有转写文本 SILENCE_SEND_MS 内没有变化才整条发出。
  // 底噪不会产生新字，因此不会顺延；ASR 发来重复 interim/final 也不会刷新计时。
  function scheduleAutoSend() {
    if (core.pttHolding) return;       // PTT 按住期间禁用自动发送（由 pttEnd 统一发送）
    if (getAutoSend?.() === false) return; // 关了自动发送 → 纯手动（回车 / 松 PTT）
    noteTranscriptActivity();
    if (autoSendTimer) return; // 已有计时器在跑，靠 lastTranscriptActivityTs 自校正，无需重置
    const tick = () => {
      const idle = Date.now() - lastTranscriptActivityTs;
      if (idle >= SILENCE_SEND_MS) {
        autoSendTimer = null;
        lastObservedTranscriptText = '';
        core.setStatus('processing');
        core.sendRecognizedVoiceText();
      } else {
        // 期间又识别出新字了 → 顺延到「最后新字 + 延迟窗口」
        autoSendTimer = setTimeout(tick, SILENCE_SEND_MS - idle);
      }
    };
    autoSendTimer = setTimeout(tick, SILENCE_SEND_MS);
  }

  function cancelAutoSend() {
    if (autoSendTimer) { clearTimeout(autoSendTimer); autoSendTimer = null; }
  }

  // ─── core 钩子：每帧音量 → barge-in 检测 + 活动计时 ───
  function onFrame(vol, frame = {}) {
    // 打断检测：TTS 播放中持续检测用户声音（两阶段：duck → 判断语音/噪音）
    if (core.suspendedByMedia) {
      const aecReady = Date.now() - core.ttsStartTime > BARGEIN_WARMUP_MS;
      if (frame.ttsActive && !duckActive) {
        learnEchoFloor(vol, { force: !aecReady });
      }
      if (aecReady) {
        const bargeinCandidate = isBargeinCandidate(vol, frame);
        if (!duckActive) {
          // 阶段一：等待触发 duck
          if (bargeinCandidate) {
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
          if (bargeinCandidate) {
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

    // 自动发送不在这里看音量。底噪/回声/呼吸声只能影响打断检测和视觉反馈，不能重置发送计时。
  }

  // ─── core 钩子：收到一条 transcript 后的策略 ───
  function onTranscript() {
    // 收到真实语音 → 取消所有误触发恢复机制（正常流程下这些本就处于关闭态，清理为 no-op）
    bargeinFastCheckActive = false;
    bargeinFastSilentFrames = 0;
    clearBargeinNoSpeechTimer();
    const currentText = (core.getText?.() || '').trim();
    if (!currentText || currentText === lastObservedTranscriptText) return;
    lastObservedTranscriptText = currentText;
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
    resetEchoFloor();
    lastTranscriptActivityTs = 0;
    lastObservedTranscriptText = '';
  }

  // ─── core 钩子：进入 TTS 挂起时重置打断检测计数 ───
  function onSuspendForTTS() {
    bargeinFrames = 0;
    duckActive = false;
    duckHighFrames = 0;
    duckLowFrames = 0;
    resetEchoFloor();
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
