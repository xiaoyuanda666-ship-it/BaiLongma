import assert from 'node:assert/strict';
import { createPttController } from './ui/brain-ui/voice-ptt.js';

function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const tasks = new Map();

  return {
    setTimeout(fn, delay = 0) {
      const id = nextId++;
      tasks.set(id, { at: now + delay, fn });
      return id;
    },
    clearTimeout(id) {
      tasks.delete(id);
    },
    advance(ms) {
      const target = now + ms;
      while (true) {
        const due = [...tasks.entries()]
          .filter(([, task]) => task.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, task] = due;
        tasks.delete(id);
        now = task.at;
        task.fn();
      }
      now = target;
    },
  };
}

function createCore() {
  let text = '';
  const sent = [];
  return {
    micActive: true,
    suspendedByMedia: false,
    userWantedMic: true,
    pttHolding: false,
    flushCount: 0,
    stopped: false,
    sent,
    getText: () => text,
    setText: (value) => { text = value; },
    clearPendingInterim() {},
    suppressIncomingTranscripts() {},
    flushAsr() { this.flushCount++; },
    setStatus() {},
    sendRecognizedVoiceText() {
      sent.push(text);
      text = '';
    },
    resetTranscriptAccumulation() { text = ''; },
    stopSession() { this.stopped = true; },
  };
}

async function run() {
  const timers = createFakeTimers();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = timers.setTimeout;
  globalThis.clearTimeout = timers.clearTimeout;

  try {
    const core = createCore();
    const ptt = createPttController(core, {
      toggleVoice: async () => true,
      cancelAutoSend() {},
    });

    await ptt.pttStart();
    core.setText('这是已有的半句');
    ptt.pttEnd();

    assert.equal(core.flushCount, 1, '松手时应立即要求 ASR flush');
    assert.equal(core.pttHolding, true, '等待 final 期间应继续屏蔽常开模式自动发送');
    timers.advance(999);
    assert.deepEqual(core.sent, [], '已有 interim 时也不能提前发送');

    core.setText('这是已有的半句话，最后几个字也识别出来了');
    timers.advance(1);
    assert.deepEqual(core.sent, ['这是已有的半句话，最后几个字也识别出来了']);
    assert.equal(core.pttHolding, false, '发送后应恢复常开策略');

    const continuedCore = createCore();
    const continuedPtt = createPttController(continuedCore, {
      toggleVoice: async () => true,
      cancelAutoSend() {},
    });
    await continuedPtt.pttStart();
    continuedCore.setText('第一段');
    continuedPtt.pttEnd();
    timers.advance(500);
    await continuedPtt.pttStart();
    assert.equal(continuedCore.getText(), '第一段', '收尾窗口内再次按下应保留前一段文本');
    continuedCore.setText('第一段，接着说完');
    continuedPtt.pttEnd();
    timers.advance(999);
    assert.deepEqual(continuedCore.sent, [], '再次松手后应重新计算完整的 1 秒收尾窗口');
    timers.advance(1);
    assert.deepEqual(continuedCore.sent, ['第一段，接着说完']);

    const cancelledCore = createCore();
    const cancelledPtt = createPttController(cancelledCore, {
      toggleVoice: async () => true,
      cancelAutoSend() {},
    });
    await cancelledPtt.pttStart();
    cancelledCore.setText('失焦时的半句话');
    cancelledPtt.pttEnd({ send: false });
    timers.advance(1000);
    assert.deepEqual(cancelledCore.sent, [], '窗口失焦等被动结束不能延迟误发');
    assert.equal(cancelledCore.pttHolding, false);

    const ownedMicCore = createCore();
    ownedMicCore.micActive = false;
    const ownedMicPtt = createPttController(ownedMicCore, {
      toggleVoice: async () => {
        ownedMicCore.micActive = true;
        return true;
      },
      cancelAutoSend() {},
    });
    await ownedMicPtt.pttStart();
    ownedMicCore.setText('PTT 自己打开麦克风');
    ownedMicPtt.pttEnd();
    timers.advance(1000);
    assert.deepEqual(ownedMicCore.sent, ['PTT 自己打开麦克风']);
    assert.equal(ownedMicCore.stopped, false, '应先发送完整文本，再延迟关闭 PTT 打开的麦克风');
    timers.advance(120);
    assert.equal(ownedMicCore.stopped, true, '发送完成后应关闭 PTT 自己打开的麦克风');

    console.log('voice PTT tests passed');
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
