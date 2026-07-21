// voice-ptt.js —— 按住空格说话（Push-To-Talk）模式策略
//
// 按下 → 开麦 / 从 TTS 恢复；松开 → flush，等待尾部识别完成后发送。按住和等待期间
// 通过 core.pttHolding 屏蔽常开策略的自动发送，由 pttEnd 统一发送。
//
// 「叠加」语义：常开会话正在跑时按空格，不重开麦克风、只「强制立即发一次」
// （pttStart 走 micActive no-op 分支，pttEnd 对同一会话 flush+send，不停麦）。
// 底层会话由 core 持有；本控制器只做门控 + 松手发送策略。
//
// 依赖（由编排层 voice-panel.js 注入）：
//   toggleVoice()    常开会话开关（开麦 + 接 ASR）——与点球/按钮共用同一入口
//   cancelAutoSend() 取消常开策略已排程的自动发送计时器

export function createPttController(core, { toggleVoice, cancelAutoSend }) {
  // release 后给云端留出固定收尾时间。不能看到已有 interim 就立刻发送：
  // 用户松手时声音虽已录完，最后几个字仍可能在 ASR 服务端排队识别。
  const FINAL_TRANSCRIPT_WAIT_MS = 1000;

  let pttStartedMic = false;
  let finalizeTimer = null;
  let pendingStartedMic = false;
  let stopTimer = null;

  async function pttStart() {
    // 1 秒收尾窗口内再次按下，视为继续同一段话：取消旧发送，但保留已经识别的文本。
    // 同时继承「这支 mic 是 PTT 打开的」状态，等最终松手发送后仍会正确关麦。
    const continuesPendingUtterance = finalizeTimer !== null;
    const inheritsOwnedMic = pendingStartedMic || stopTimer !== null;
    if (finalizeTimer) { clearTimeout(finalizeTimer); finalizeTimer = null; }
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
    pendingStartedMic = false;
    pttStartedMic = inheritsOwnedMic;

    // 让 release 时不会发出旧的累积识别结果
    core.pttHolding = true;
    if (!continuesPendingUtterance) {
      core.setText('');
      // 同时清掉上一段未定稿的 interim，否则恰好碰上 WS 重连时它会被提级进 committed
      core.clearPendingInterim?.();
    }
    cancelAutoSend?.();
    // 上一次松手发送可能还在「吞尾」窗口内；这是一次新的说话意图，立刻解除，
    // 否则新一句的开头转录会被当作旧句尾随而吞掉。
    core.suppressIncomingTranscripts?.(0);

    if (core.suspendedByMedia) {
      // Pressing Space is an explicit push-to-talk intent. Previous TTS/PTT
      // cleanup can clear userWantedMic while the voice stack is still suspended.
      const wasUserWantedMic = core.userWantedMic;
      core.userWantedMic = true;
      // mic 硬件仍在，只是 ASR WS 被 TTS 暂停 → 重连即可，不算 PTT 开的 mic
      pttStartedMic ||= !wasUserWantedMic;
      await core.resumeSession(false);
      if (!core.micActive) {
        pttStartedMic = true;
        await toggleVoice();
      }
      return;
    }
    if (core.micActive) {
      // 已经在听 → 不改状态，release 时等待最终识别后发送
      return;
    }
    pttStartedMic = true;
    await toggleVoice();
  }

  // send=false：用于窗口失焦等"非主动松手"场景——只结束这次 PTT、不把半句发出去。
  // 否则失焦（如点开 DevTools / 切窗口）会把没说完的半句直接发送，正是要避免的误发。
  function pttEnd({ send = true } = {}) {
    const startedMic = pttStartedMic;
    pttStartedMic = false;
    if (!core.micActive) {
      core.pttHolding = false;
      return;
    }

    if (!send) {
      if (finalizeTimer) { clearTimeout(finalizeTimer); finalizeTimer = null; }
      pendingStartedMic = false;
      core.pttHolding = false;
      cancelAutoSend?.();
      if (startedMic) {
        // PTT 自己开的 mic → 连 mic 一起停，避免残留
        core.stopSession();
      } else {
        // 叠加在常开会话上 → 丢弃这次按住期间的半句，并吞掉 flush 尾随 final，
        // 否则常开策略随后会把这半句误发出去
        core.resetTranscriptAccumulation();
        core.setText('');
        core.suppressIncomingTranscripts?.(1500);
      }
      return;
    }

    // 通知云端 ASR 立刻给最终结果
    core.flushAsr();

    const finalize = () => {
      finalizeTimer = null;
      const shouldStopMic = pendingStartedMic;
      pendingStartedMic = false;
      core.pttHolding = false;
      if (core.getText()) {
        cancelAutoSend?.();
        core.setStatus('processing');
        core.sendRecognizedVoiceText();
        // 常开模式 mic 不停：flushAsr 触发的尾随 final 属同一句，吞掉它，
        // 否则常开策略会 onTranscript → scheduleAutoSend 把整条消息再发一次。
        // PTT 自开的 mic 走下面的 stopSession，吞尾窗口对它无副作用。
        core.suppressIncomingTranscripts?.(1500);
        if (shouldStopMic) {
          stopTimer = setTimeout(() => {
            stopTimer = null;
            core.stopSession();
          }, 120);
        }
      } else if (shouldStopMic) {
        core.stopSession();
      }
    };

    // 即使当前已有 interim，也必须完整等待：期间到达的 final 会更新 core.getText()，
    // finalize 在窗口结束时读取最新值，因此不会漏掉句尾。
    pendingStartedMic = startedMic;
    finalizeTimer = setTimeout(finalize, FINAL_TRANSCRIPT_WAIT_MS);
  }

  return { pttStart, pttEnd };
}
