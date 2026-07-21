// voice-panel.js —— 语音面板编排层
//
// 组装共享会话引擎（voice-core）+ 两个模式策略（常开 voice-continuous / 按住空格 voice-ptt），
// 暴露 initVoicePanel + window.bailongmaVoice（承重墙：app.js 的 TTS 打断与视频/音乐联动依赖它）。
//
// 解耦结构：
//   voice-core.js       共享机制——点云渲染 + 麦克风采集 + ASR 传输/转录 + 会话生命周期
//   voice-continuous.js  常开策略——自动断句发送 + barge-in 打断检测（会话默认策略）
//   voice-ptt.js         PTT 策略——按住门控 + 松手立即发送（在常开策略之上叠加）
//
// 改一个模式的策略只动对应文件，底层机制集中在 core；两模式共用同一个 core 会话，
// 以保持「常开在跑时按空格 = 强制立即发一次」的叠加语义。

import { createVoiceCore } from './voice-core.js';
import { createContinuousPolicy } from './voice-continuous.js';
import { createPttController } from './voice-ptt.js';
import { createWakeFlow } from './voice-wake.js';
import { getApiToken } from './api-client.js';

export function initVoicePanel({
  btnId, panelId, canvasId, statusId, transcriptId,
  compactTranscriptId, compactPanelId,
  getChatInput, getSendBtn, getSendMessage, getLang, getAutoSend, getAutoMic,
}) {
  const btn        = document.getElementById(btnId);
  const panel      = document.getElementById(panelId);
  const canvas     = document.getElementById(canvasId);
  const transcript = document.getElementById(transcriptId);
  const compactTranscript = document.getElementById(compactTranscriptId);
  const compactPanel = document.getElementById(compactPanelId);

  if (!panel || !canvas) return;

  // 窄窗口会隐藏左侧栏，紧凑聊天区仍需同步显示实时识别文字。
  // 使用镜像而不是搬动 voice-panel，避免与世界杯/热点等媒体模式争夺同一 DOM 节点。
  if (transcript && compactTranscript) {
    const syncCompactTranscript = () => {
      const text = transcript.textContent.trim();
      compactTranscript.textContent = text || '按住空格键开始说话';
      compactPanel?.classList.toggle('has-transcript', Boolean(text));
    };
    new MutationObserver(syncCompactTranscript).observe(transcript, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    syncCompactTranscript();
  }

  // ─── 组装 core + 两个模式策略 ───
  const core = createVoiceCore({ canvas, transcript, getChatInput, getSendMessage, getLang });
  const continuous = createContinuousPolicy(core, { getAutoSend });

  // 常开会话开关：点球/按钮触发，也被 PTT 在「mic 未开」时复用（保持叠加语义）
  async function toggleVoice() {
    if (!core.micActive) {
      if (!navigator.mediaDevices?.getUserMedia) {
        if (transcript) {
          transcript.textContent = window.isSecureContext === false
            ? '局域网麦克风需要 HTTPS，请使用安全访问链接'
            : '当前浏览器无法访问麦克风';
        }
        return false;
      }
      const isRemoteHost = !['localhost', '127.0.0.1', '::1'].includes(location.hostname);
      if (isRemoteHost && !getApiToken()) {
        if (transcript) transcript.textContent = '局域网访问未配对，请使用桌面端显示的带口令链接';
        return false;
      }
      // startSession 内部已处理失败回退 + 状态同步
      return Boolean(await core.startSession());
    }
    core.stopSession();
    return false;
  }

  const ptt = createPttController(core, {
    toggleVoice,
    cancelAutoSend: continuous.cancelAutoSend,
  });

  // 唤醒会话编排（命中「小白龙」→ 悬浮球入场 → 10s 无话退场）。非 Electron 环境内部自动失能。
  const wake = createWakeFlow(core);

  // 安装模式策略钩子：continuous = 会话默认策略；PTT 通过 core.pttHolding 在其上叠加。
  // 每帧：先喂唤醒编排（把状态+真实音量+文字推给悬浮球窗），再走 continuous 打断检测。
  core.setOnFrame((vol, frame) => {
    wake.onFrame(vol, frame);
    continuous.onFrame(vol, frame);
  });
  // 转写到达：先喂唤醒编排（用于「10s 内是否识别到语音」判定），再走 continuous 自动发送策略。
  core.setOnTranscript((msg, isFinal) => {
    wake.onTranscript(msg, isFinal);
    continuous.onTranscript(msg, isFinal);
  });
  core.setOnSessionStop(continuous.onSessionStop);
  core.setOnSuspendForTTS(continuous.onSuspendForTTS);
  core.setOnResume(continuous.onResume);
  // 会话状态变化 → 同步按钮高亮（mic 开着或用户保留了开麦意图时高亮）
  core.setOnState(() => {
    btn?.classList.toggle('active', core.micActive || core.userWantedMic);
  });

  // ─── 承重墙：window.bailongmaVoice 接口契约（app.js 依赖，不可改形状） ───
  window.bailongmaVoice = {
    isActive: () => core.micActive,
    // app.js 的模型事件流驱动：键盘/语音/心跳入口共用同一个思考视觉状态。
    setThinking: (active) => core.setThinking(active),
    // 视频/音乐模式：完全停止 mic（不需要打断能力）
    suspendForMedia: () => core.suspendForMedia(),
    // TTS 模式：只停云端 ASR WebSocket，保持 mic 硬件 + ScriptProcessor，开启打断预缓冲
    suspendForTTS: () => core.suspendForTTS(),
    // TTS 正常结束：清掉续播计时再恢复会话
    resumeAfterMedia: () => {
      continuous.clearNoSpeechTimer();
      core.resumeSession(false);
    },
    stop: () => core.stopSession(),
    setTTSAnalyser: (analyser) => core.setTTSAnalyser(analyser),
    pttStart: ptt.pttStart,
    pttEnd: ptt.pttEnd,
  };

  window.addEventListener('bailongma:video-mode', (event) => {
    if (event.detail?.active) {
      window.bailongmaVoice.suspendForMedia();
    } else {
      window.bailongmaVoice.resumeAfterMedia();
    }
  });

  window.addEventListener('bailongma:music-mode', (event) => {
    if (event.detail?.active) {
      window.bailongmaVoice.suspendForMedia();
    } else {
      window.bailongmaVoice.resumeAfterMedia();
    }
  });

  // ─── 面板初始化 ───
  function openPanel() {
    panel.hidden = false;
    core.startRenderLoop();
  }

  btn?.addEventListener('click', toggleVoice);
  canvas.addEventListener('click', toggleVoice);

  core.setStatus('idle');
  core.setThinking(document.body.classList.contains('model-thinking'));
  openPanel();
  if (getAutoMic?.()) toggleVoice();
}
