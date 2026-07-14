// voice-core.js —— 语音共享机制引擎（mechanism，不含模式策略）
//
// 职责：点云球渲染 + 麦克风采集 + 云端 ASR 传输/转录引擎 + 会话生命周期。
// 不含任何「怎么用」的策略——自动发送断句、barge-in 打断检测、PTT 门控分别在
// voice-continuous.js / voice-ptt.js。两个模式共用同一个 core 会话（保持「叠加」语义）。
//
// 模式通过下列钩子注入策略（由编排层 voice-panel.js 组装、可组合多个模式）：
//   setOnFrame(vol)          每帧音量回调（barge-in 检测 / 活动计时）
//   setOnTranscript(msg,fin) 收到一条 transcript 后的策略（断句/发送触发）
//   setOnSessionStop()       会话停止时各模式清理自己的计时器/标志
//   setOnSuspendForTTS()     进入 TTS 挂起时各模式重置检测状态
//   setOnResume(fromBargein) 会话恢复时各模式重置状态/启动续播计时
//   setOnState()             会话状态变化后编排层同步 UI（如按钮高亮）
//
// 点云算法移植自 ACUI (Remix)/Voice Component.html

// ─── 球面采样（Fibonacci） ───
function fibSphere(n, radius) {
  const pts = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    pts.push({ x: Math.cos(theta) * r * radius, y: y * radius, z: Math.sin(theta) * r * radius });
  }
  return pts;
}

const BASE_PTS  = fibSphere(3200, 1.0);
const BASE_PTS2 = fibSphere(1200, 0.88);

// 小尺寸抽稀：球被媒体模式缩成小坞（世界杯 40px / 热点·视频 56px）时，4400 个点
// 的投影、排序、逐点绘制大部分是浪费——按 canvas 的 CSS 尺寸隔 N 取 1。
// Fibonacci 采样本身均匀，等距抽稀后依旧均匀，小尺寸下视觉无差别，成本随点数线性降。
const PTS_BY_STRIDE = new Map();
function ptsForStride(stride) {
  let pts = PTS_BY_STRIDE.get(stride);
  if (!pts) {
    pts = stride === 1
      ? { outer: BASE_PTS, inner: BASE_PTS2 }
      : {
          outer: BASE_PTS.filter((_, i) => i % stride === 0),
          inner: BASE_PTS2.filter((_, i) => i % stride === 0),
        };
    PTS_BY_STRIDE.set(stride, pts);
  }
  return pts;
}

// ─── 正弦噪声 ───
function sn(x, y, z, t) {
  return (
    Math.sin(x * 2.3 + t * 1.1) * Math.cos(y * 1.9 + t * 0.8) * 0.38 +
    Math.sin(y * 3.1 + t * 1.4) * Math.cos(z * 2.7 + t * 0.6) * 0.30 +
    Math.sin(z * 1.7 + t * 0.9) * Math.cos(x * 3.3 + t * 1.2) * 0.30 +
    Math.sin(x * 5.1 + y * 4.3 + t * 2.1) * 0.14
  );
}

function lerp(a, b, t) { return a + (b - a) * t; }
function lerpArr(a, b, t) { return a.map((v, i) => lerp(v, b[i], t)); }

// ─── 状态配置 ───
// idle = 麦克风关闭（灰色）  listening = 麦克风开启待命（白色）
// recognizing = 正在识别（蓝色）  done = 识别完成（绿色，2s 后回 listening）
// speaking = AI 正在说话（紫色，可打断）
const STATE_CFG = {
  idle:        { amp: 0.003, spd: 0.10, r: [50,68,80],    g: [50,68,80],    b: [55,73,85]   },
  listening:   { amp: 0.055, spd: 0.75, r: [185,215,245], g: [185,215,245], b: [195,225,255] },
  recognizing: { amp: 0.55,  spd: 4.50, r: [25,75,165],   g: [95,155,230],  b: [195,230,255] },
  done:        { amp: 0.10,  spd: 1.20, r: [30,105,65],   g: [145,200,135], b: [45,90,60]   },
  processing:  { amp: 0.15,  spd: 1.10, r: [100,60,200],  g: [80,60,180],   b: [220,190,255] },
  error:       { amp: 0.10,  spd: 0.70, r: [200,240,255], g: [20,30,40],    b: [20,30,40]   },
  event:       { amp: 0.60,  spd: 4.00, r: [255,200,50],  g: [200,160,30],  b: [50,80,150]   },
  speaking:    { amp: 0.09,  spd: 1.00, r: [130,95,185],  g: [105,80,170],  b: [225,200,255] },
};

// 共享阈值：core 的 speaking→recognizing 视觉分支 + continuous 的打断检测都用它。
// 放 core 作单一来源，continuous 从这里 import，避免两处各写一份。
export const BARGEIN_THRESHOLD = 0.09; // 振幅阈值（高于环境噪声和 AEC 残留）

const CLOUD_WS_URL  = 'ws://127.0.0.1:3721/voice/cloud';
const VOICE_PROVIDER_KEY = 'jarvis-voice-provider';
const VOICE_MIC_DEVICE_KEY = 'jarvis-voice-mic-device-id';

// 采集分块大小（样本数）：AudioWorklet 累积到该样本数再投递；ScriptProcessor 回退也用它。
// 2048 @ 16kHz = 128ms/块，权衡延迟与消息/网络开销。
const PCM_CHUNK_SAMPLES = 2048;
// 缓冲上限按「块」计，依分块时长换算，保证时间窗口不随分块大小漂移。
const BARGEIN_PRE_BUFFER_MS = 1500;
const BARGEIN_MAX_CHUNKS    = Math.ceil(BARGEIN_PRE_BUFFER_MS * 16000 / 1000 / PCM_CHUNK_SAMPLES);
// 重连预缓冲上限 ≈8s，防长断连无限堆积
const RECONNECT_MAX_CHUNKS  = Math.ceil(8000 * 16000 / 1000 / PCM_CHUNK_SAMPLES);

// AudioWorklet 处理器源码：跑在独立音频线程，把 Float32 转 Int16 并按块投递到主线程。
// 用 Blob URL 加载（见 ensurePcmWorkletModule），规避 Electron 打包后 file:// 路径问题。
// 关键：采集不再占用主线程，UI 渲染（点阵球）再卡也不会丢音频帧——这是长语音丢字的根治点。
const PCM_WORKLET_SRC = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this._size = (options && options.processorOptions && options.processorOptions.chunk) || 2048;
    this._buf = new Int16Array(this._size);
    this._n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        let s = ch[i];
        if (s > 1) s = 1; else if (s < -1) s = -1;
        this._buf[this._n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this._n >= this._size) {
          const out = this._buf.slice(0, this._n);
          this.port.postMessage(out.buffer, [out.buffer]);
          this._n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor);
`;

export function createVoiceCore({ canvas, transcript, getChatInput, getSendMessage, getLang }) {
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, cx = 0, cy = 0, scale = 0;
  // canvas 的 CSS 短边，绘制帧的 resize 顺手写入（节流档位/抽稀档位都按它判）。
  // 初值取大,首帧按全量画,第一次 resize 后立刻校正。
  let cssMinSize = Infinity;

  function resizeCanvasToDisplay() {
    const rect = canvas.getBoundingClientRect();
    cssMinSize = Math.min(rect.width, rect.height);
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
    const nextW = Math.max(1, Math.round(rect.width * dpr));
    const nextH = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== nextW || canvas.height !== nextH) {
      canvas.width = nextW;
      canvas.height = nextH;
    }
    W = nextW; H = nextH; cx = W / 2; cy = H / 2;
    scale = Math.min(W, H) * 0.34;
  }

  // ─── 渲染状态 ───
  let sk = 'idle';
  let animState = {
    amp: STATE_CFG.idle.amp, spd: STATE_CFG.idle.spd,
    col: [STATE_CFG.idle.r, STATE_CFG.idle.g, STATE_CFG.idle.b],
    t: 0, rotY: 0, rotX: 0.25,
  };
  let rafId = null;
  let eventFlashCount = 0;
  let doneTimer = null;
  // ── 画面节流（drawFrame 内分析与绘制已解耦：音量分析每帧必跑，降帧只降"画"不降"听"）──
  // 近乎静止的画面 60fps 全速投影排序 4400 个点纯属浪费（笔记本常驻占用的大头之一）。
  // 三个条件互相独立（targetDrawFps）：
  //   ① 灰色待机且麦克风关闭 → 18fps（原有）
  //   ② 麦克风开着但持续静音（常开聆听/世界杯空格 PTT 待命）→ 18fps
  //      —— 此前条件只认 ①，麦一开就永远满帧，是世界杯大屏 GPU 拉满的根因
  //   ③ 球被媒体模式缩成小坞（CSS 短边 ≤100px）→ 上限 30fps，点数同步抽稀 1/4
  const IDLE_FPS = 18;
  const SMALL_FPS_CAP = 30;
  const QUIET_AFTER_MS = 2500;  // 静音持续多久进入降帧；任何人声下一帧立即恢复满帧
  const QUIET_VOL = 0.02;       // 与绘制段"有声→放大振幅"分支同阈值，单一来源
  let lastDrawTs = 0;
  let lastVoiceTs = 0;          // 最近一次 vol 超过 QUIET_VOL 的时刻（performance.now）
  let lastVol = 0;              // 分析帧比绘制帧密，绘制段用最近一次分析到的音量
  let ttsData = null;
  let lastTTSVol = 0;
  // 外部音量注入：悬浮球窗口没有自己的麦克风/TTS 分析器，由主窗口每帧把真实音量
  // （麦克风音量 / TTS 音量）经 IPC 推过来，注入这里驱动球体跳动，复刻 brain-ui 的动画。
  // 主窗口自己渲染时不用它（保持 null），行为不变。
  let externalVol = null;       // null = 未注入；数值 = 用它当本帧的视觉音量

  // 画面节流档位：返回 0 = 不限（跟随显示器刷新率）
  function targetDrawFps(ts) {
    let fps = 0;
    const calm = sk === 'idle' || sk === 'listening';
    if (sk === 'idle' && !micData) fps = IDLE_FPS;                                   // ①
    else if (calm && micData && ts - lastVoiceTs > QUIET_AFTER_MS) fps = IDLE_FPS;   // ②
    if (cssMinSize <= 100) fps = fps ? Math.min(fps, SMALL_FPS_CAP) : SMALL_FPS_CAP; // ③
    return fps;
  }

  // 小坞抽稀档位：≤100px 取 1/4（小坞 40/56px），≤160px 取 1/2，大尺寸全量
  function strideForSize() {
    return cssMinSize <= 100 ? 4 : cssMinSize <= 160 ? 2 : 1;
  }

  // ─── 模式注入钩子（由编排层组装，可组合多个模式） ───
  let onFrame = null;        // (vol) 每帧：barge-in 检测 / 活动计时
  let onTranscript = null;   // (msg, isFinal) 收到 transcript 后的策略
  let onSessionStop = null;  // () 会话停止，各模式清理
  let onSuspendForTTS = null;// () 进入 TTS 挂起，各模式重置检测状态
  let onResume = null;       // (fromBargein) 会话恢复，各模式重置/续播
  let onState = null;        // () 会话状态变化，编排层同步 UI

  function setStatus(newSk) { sk = newSk; }
  const getStatus = () => sk;
  // 注入外部音量（悬浮球窗口用）；传 null 取消注入，回到自带麦克风/TTS 音量逻辑。
  function setExternalVol(v) { externalVol = (v == null ? null : Number(v) || 0); }

  function triggerDone() {
    setStatus('done');
    if (doneTimer) clearTimeout(doneTimer);
    doneTimer = setTimeout(() => {
      doneTimer = null;
      if (sk === 'done') setStatus(micActive ? 'listening' : 'idle');
    }, 2000);
  }

  function setTTSAnalyser(analyser) {
    if (analyser) {
      ttsData = { analyser, dataArray: new Uint8Array(analyser.fftSize) };
      setStatus('speaking');
      return;
    }
    ttsData = null;
    lastTTSVol = 0;
    if (sk === 'speaking' && !suspendedByMedia) setStatus(micActive ? 'listening' : 'idle');
  }

  function readTTSVol() {
    if (!ttsData) return 0;
    try {
      ttsData.analyser.getByteTimeDomainData(ttsData.dataArray);
      let sum = 0;
      for (const v of ttsData.dataArray) {
        const centered = (v - 128) / 128;
        sum += centered * centered;
      }
      const rms = Math.sqrt(sum / ttsData.dataArray.length);
      const level = Math.min(1, Math.max(0, rms * 3.2));
      lastTTSVol = lerp(lastTTSVol, level, 0.35);
      return lastTTSVol;
    } catch {
      return 0;
    }
  }

  function drawFrame(now) {
    const ts = now ?? performance.now();
    const ttsVol = sk === 'speaking' ? readTTSVol() : 0;

    // ── 每帧必跑：音量分析 + 状态机推进（一次 analyser 读取，便宜）。
    //    与下面的画面节流解耦：降帧期间 barge-in 检测、识别看门狗、状态切换零延迟。──
    if (micData) {
      micData.analyser.getByteFrequencyData(micData.dataArray);
      const sum = micData.dataArray.reduce((a, b) => a + b, 0);
      const vol = (sum / micData.dataArray.length) / 255;
      lastVol = vol;

      // 模式策略：barge-in 检测 + 活动计时（continuous）。core 只把 vol 抛出去，
      // 不含任何打断/自动发送逻辑。在视觉块之前调用，保持与原始顺序一致。
      onFrame?.(vol, {
        ttsActive: Boolean(ttsData),
        ttsVol,
        suspendedByMedia,
        status: sk,
      });

      // 看门狗：记录最近一次人声级音量的时刻（判断「用户是否还在说」）
      if (vol > WATCHDOG_SPEECH_VOL) lastLoudTs = Date.now();

      if (vol > QUIET_VOL) {
        lastVoiceTs = ts;
        // speaking 状态下用户开口 → 视觉反馈但不覆盖状态（等 barge-in 触发后自然切换）
        if (sk !== 'recognizing' && sk !== 'event' && sk !== 'speaking')
          setStatus(vol > 0.15 ? 'recognizing' : 'listening');
      } else if (sk !== 'idle' && sk !== 'event' && sk !== 'processing' && sk !== 'done' && sk !== 'speaking') {
        setStatus('idle');
      }
    } else {
      lastVol = 0;
    }

    // ── 画面节流 ──
    const fps = targetDrawFps(ts);
    if (fps && ts - lastDrawTs < 1000 / fps) {
      rafId = requestAnimationFrame(drawFrame);
      return;
    }
    lastDrawTs = ts;
    resizeCanvasToDisplay();
    const cfg = STATE_CFG[sk];
    const s = animState;
    const ls = 0.025;

    s.amp = lerp(s.amp, cfg.amp, ls * 8);
    s.spd = lerp(s.spd, cfg.spd, ls * 6);
    s.col = [
      lerpArr(s.col[0], cfg.r, ls * 1.5),
      lerpArr(s.col[1], cfg.g, ls * 1.5),
      lerpArr(s.col[2], cfg.b, ls * 1.5),
    ];

    // 有声时放大振幅/转速（音量来自上方分析段，可能比本绘制帧新）。
    // externalVol 已注入（悬浮球窗口）则优先用它——主窗口推来的真实音量。
    const visualVol = externalVol != null
      ? externalVol
      : (sk === 'speaking' ? ttsVol : (micData ? lastVol : 0));
    if (visualVol > QUIET_VOL) {
      s.amp = lerp(s.amp, 0.08 + visualVol * 1.2, 0.4);
      s.spd = lerp(s.spd, 1.0 + visualVol * 5.0, 0.2);
    }

    // 声音事件闪烁效果自动恢复
    if (sk === 'event') {
      eventFlashCount--;
      if (eventFlashCount <= 0) setStatus(micActive ? 'listening' : 'idle');
    }

    s.t    += 0.016 * s.spd;
    s.rotY += 0.008;
    s.rotX  = 0.22 + Math.sin(s.t * 0.15) * 0.06;

    ctx.clearRect(0, 0, W, H);

    const cY = Math.cos(s.rotY), sY = Math.sin(s.rotY);
    const cX = Math.cos(s.rotX), sX = Math.sin(s.rotX);

    const project = (orig) => {
      const d = 1.0 + sn(orig.x, orig.y, orig.z, s.t) * s.amp;
      const px = orig.x * d, py = orig.y * d, pz = orig.z * d;
      const rx  =  px * cY + pz * sY;
      const ry0 = py;
      const rz  = -px * sY + pz * cY;
      const ry  = ry0 * cX - rz * sX;
      const rz2 = ry0 * sX + rz * cX;
      return { sx: cx + rx * scale, sy: cy - ry * scale, z: rz2 };
    };

    const { outer, inner } = ptsForStride(strideForSize());
    const allPts = [
      ...outer.map(p => ({ ...project(p), inner: false })),
      ...inner.map(p => ({ ...project(p), inner: true  })),
    ];
    allPts.sort((a, b) => a.z - b.z);

    for (const pt of allPts) {
      const depth = (pt.z + 1.5) / 3.0;
      const r = Math.round(lerp(s.col[0][0], s.col[0][2], depth));
      const g = Math.round(lerp(s.col[1][0], s.col[1][2], depth));
      const b = Math.round(lerp(s.col[2][0], s.col[2][2], depth));
      const alpha = 0.25 + depth * 0.75;
      const dotR = pt.inner ? (0.4 + depth * 0.5) : (0.6 + depth * 0.8 + s.amp * 2);
      ctx.beginPath();
      ctx.arc(pt.sx, pt.sy, dotR, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(2)})`;
      ctx.fill();
    }

    rafId = requestAnimationFrame(drawFrame);
  }

  function startRenderLoop() {
    if (!rafId) drawFrame();
  }

  // 停止渲染循环（悬浮球退场后调用：隐藏窗口里没必要继续空转 rAF）。
  function stopRenderLoop() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }

  // ─── 会话运行时状态（两个模式共用的单一会话） ───
  let micData = null;
  let micActive = false;
  let userWantedMic = false;
  let suspendedByMedia = false;
  let ttsStartTime = 0;
  // Cloud 专用
  let cloudAudioCtx = null;
  let cloudProcessor = null;     // 回退路径：ScriptProcessorNode（AudioWorklet 不可用时）
  let cloudWorkletNode = null;   // 首选路径：AudioWorkletNode（独立音频线程采集）
  let cloudWs = null;
  let cloudWsIntentional = false; // stopCloudStream 主动关闭时置 true，避免触发重连

  // ─── 采集诊断（定位长语音丢字根因；localStorage 'jarvis-voice-diag'='0' 关闭，默认开） ───
  const DIAG_ON = localStorage.getItem('jarvis-voice-diag') !== '0';
  let diagTimer = null;
  let diagCaptureMode = 'none';   // 'worklet' | 'scriptprocessor'
  let diagChunks = 0, diagBytes = 0, diagReconnects = 0, diagMaxGapMs = 0, diagLastChunkTs = 0;
  let diagTranscripts = 0, diagLastTranscriptTs = 0; // 入站：收到转录的计数 / 最近时刻
  function diag(tag, info) { if (DIAG_ON) console.log('[asr-diag] ' + tag, info ?? ''); }
  function diagNoteTranscript() { diagTranscripts++; diagLastTranscriptTs = performance.now(); }
  function diagNoteChunk(byteLen) {
    if (!DIAG_ON) return;
    diagChunks++; diagBytes += byteLen;
    const now = performance.now();
    if (diagLastChunkTs) { const gap = now - diagLastChunkTs; if (gap > diagMaxGapMs) diagMaxGapMs = gap; }
    diagLastChunkTs = now;
  }
  function diagStart() {
    if (!DIAG_ON || diagTimer) return;
    diagLastChunkTs = 0; diagMaxGapMs = 0;
    diagTimer = setInterval(() => {
      // 期望：~7.8 块/s、~31 kB/s、maxGap≈128ms。maxGap 飙到 300ms+ = 采集被抢占丢帧；
      // reconnects>0 = 这段说话期间发生了云端/网络重连。
      // sinceTx = 距上次收到转录多久。若音频在送(chunks 正常)、ws=1、但 sinceTx 持续变大，
      // 就是云端静默停了识别——这正是"球变绿后不再出字"的指纹。
      const sinceTx = diagLastTranscriptTs ? (performance.now() - diagLastTranscriptTs).toFixed(0) : 'na';
      console.log('[asr-diag] mode=' + diagCaptureMode
        + ' chunks/s=' + (diagChunks / 3).toFixed(1)
        + ' kB/s=' + (diagBytes / 1024 / 3).toFixed(1)
        + ' maxGap=' + diagMaxGapMs.toFixed(0) + 'ms'
        + ' reconnects=' + diagReconnects
        + ' ws=' + (cloudWs ? cloudWs.readyState : 'null')
        + ' tx=' + diagTranscripts
        + ' sinceTx=' + sinceTx + 'ms'
        + ' reconBuf=' + reconnectBuffer.length);
      diagChunks = 0; diagBytes = 0; diagMaxGapMs = 0;
    }, 3000);
  }
  function diagStop() {
    if (diagTimer) { clearInterval(diagTimer); diagTimer = null; }
    diagLastChunkTs = 0; diagReconnects = 0;
    diagTranscripts = 0; diagLastTranscriptTs = 0;
  }

  // ─── 识别停滞看门狗（self-healing） ───
  // 兜底「云端静默停识别」：音频在正常送、WS 仍 OPEN、用户还在出声，却数秒收不到任何
  // 转录 → 主动关连接触发重连，把识别任务滚动重启接活。不依赖云端发任何结束/错误事件，
  // 也就修了「说到几十个字球变绿后不再出字」。localStorage 'jarvis-voice-watchdog'='0' 可关。
  const WATCHDOG_ON = localStorage.getItem('jarvis-voice-watchdog') !== '0';
  const STALL_RECONNECT_MS = 3500;   // 仍在说却这么久没转录 → 判定停滞
  const WATCHDOG_SPEECH_VOL = 0.05;  // 判定「人在说话」的音量阈值（与 continuous SPEECH_VOL 同量级）
  let watchdogTimer = null;
  let lastInboundTs = 0;             // 最近收到转录的时刻（Date.now）
  let lastLoudTs = 0;                // 最近听到人声级音量的时刻（Date.now，drawFrame 写）
  function startWatchdog() {
    if (!WATCHDOG_ON || watchdogTimer) return;
    lastInboundTs = Date.now();
    watchdogTimer = setInterval(() => {
      if (!micActive || suspendedByMedia) return;
      if (!cloudWs || cloudWs.readyState !== WebSocket.OPEN) return; // 重连窗口内不判
      const now = Date.now();
      if (now - lastLoudTs < 1200 && now - lastInboundTs > STALL_RECONNECT_MS) {
        diag('watchdog: stalled → force reconnect', 'sinceTx=' + (now - lastInboundTs) + 'ms');
        lastInboundTs = now;            // 防重连窗口内重复触发
        try { cloudWs.close(); } catch {} // onclose(!intentional) → commitPendingInterim + 重连续上
      }
    }, 1000);
  }
  function stopWatchdog() {
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
    lastInboundTs = 0; lastLoudTs = 0;
  }
  // 打断预缓冲：TTS 期间把 PCM 写入环形缓冲，打断后一并发给 ASR
  let bargeinBuffer = [];   // Int16Array 块的环形队列
  let bargeinBuffering = false; // true = 正在 TTS，写缓冲而非发 WS
  // 重连预缓冲：WS 断开/重连的死区里把 PCM 暂存，连上后立即补发，避免丢字。
  let reconnectBuffer = []; // Int16Array 块
  // PTT 按住期间禁用自动发送的门控位（PTT 写、continuous 读）
  let pttHolding = false;
  // PTT 松手已发送后的「吞尾」截止时刻：常开模式下 mic 不停，flushAsr 会让云端再吐一条
  // 属于同一句的尾随 final。这条若放行会被常开策略当作新内容二次发送 → 在此窗口内吞掉。
  let transcriptSuppressUntil = 0;

  function syncState() { onState?.(); }

  // ─── 转录累积 / 去重（两模式共用机制） ───
  let lastTranscriptText = '';
  // 多句累积：Paraformer 按句回调，需拼接完整段落
  let accumulatedText = '';
  // 已定稿句子列表 [{seg, text}]。seg 为云端给的句子唯一标识（如 begin_time）：
  // 同一句的多帧 final 共用同一 seg，据此去重，避免被反复追加成「X，X，X，…」。
  let committed = [];
  // 当前句尚未定稿的 interim 文本（只用于显示，未写入 committed）。保留它是为了在
  // 「长句说到一半 WS 重连」时把已识别的前半句提级保住——否则旧会话带着前半句状态
  // 死掉、新会话只 finalize 出尾巴，整个前半句会蒸发（见 commitPendingInterim）。
  let pendingInterim = '';
  const committedText = () => committed.map(s => s.text).join('，');
  function resetTranscriptAccumulation() {
    committed = [];
    accumulatedText = '';
    pendingInterim = '';
  }

  // 重连前兜底：把当前句尚未定稿的 interim 提级写入 committed，避免重连后被新会话的
  // 尾巴 final 覆盖丢失。新会话 begin_time 重新计数，seg 不会与历史句撞车，尾巴会作为
  // 新句追加在前半句之后。代价是接缝处可能与重连后重新识别的几个字轻微重叠——远好于
  // 整段前半句丢失。只在确有未定稿 interim 时执行。
  function commitPendingInterim() {
    const text = pendingInterim.trim();
    if (!text) return;
    const last = committed[committed.length - 1];
    if (!last || last.text !== text) committed.push({ seg: null, text });
    accumulatedText = committedText();
    lastTranscriptText = accumulatedText;
    if (transcript) transcript.textContent = accumulatedText;
    pendingInterim = '';
  }

  // 收到一条 transcript 消息：写入累积/显示，返回是否为 final。两条 WS 路径共用，
  // 保证去重逻辑只有一份。
  function applyTranscript(msg) {
    const text = (msg.text || '').trim();
    if (!text) return false;
    const seg = (msg.seg === undefined || msg.seg === null) ? null : msg.seg;
    if (msg.is_final) {
      // 按 seg 在【整个 committed】里查找同一句并替换——这是关键：火山 result_type=full 每帧都
      // 重发从头到现在的全部 utterances(v0…vN)，若只比对最后一条，下一帧的 v0 ≠ 末条 vN 就会把
      // 整段 v0…vN 整批再追加一遍 → 重复多次。全表按 seg 查找则就地替换、committed 稳定为一份。
      // seg 为空（讯飞等）时回退到原「与最后一条文本相同即替换」。对阿里云(seg 唯一)行为不变。
      let idx = -1;
      if (seg !== null) {
        idx = committed.findIndex(s => s.seg === seg);
      } else {
        const last = committed[committed.length - 1];
        if (last && last.text === text) idx = committed.length - 1;
      }
      let changed;
      if (idx >= 0) {
        changed = committed[idx].text !== text;
        committed[idx].text = text;
      } else {
        committed.push({ seg, text });
        changed = true;
      }
      accumulatedText = committedText();
      lastTranscriptText = accumulatedText;
      pendingInterim = ''; // 本句已定稿，清掉未定稿兜底
      // 只更新语音面板的 transcript 显示，不再往聊天输入框(msg-input)写草稿——
      // 语音完全不过输入框，最终由 sendRecognizedVoiceText 直接发送文本。
      if (transcript) transcript.textContent = accumulatedText;
      // 仅在内容真正变化时才算「新 final」：避免火山每帧重发同一批 utterances 触发绿灯狂闪/重复处理
      return changed;
    }
    // interim：仅用于实时显示，不写入 committed。但记下来供重连兜底提级（commitPendingInterim）
    pendingInterim = text;
    const base = committedText();
    lastTranscriptText = base ? base + '，' + text : text;
    if (transcript) transcript.textContent = lastTranscriptText;
    return false;
  }

  // ─── 语音识别结果发送（实际投递动作；何时调由模式策略决定） ───
  function sendRecognizedVoiceText() {
    if (!lastTranscriptText) return;
    // 直接把识别文本作为消息发送，完全不经过聊天输入框(msg-input)——不留草稿、不会被失焦误发。
    getSendMessage?.({ channel: '语音识别', label: 'You · 语音对话', text: lastTranscriptText });
    // 发出后清空累积：已发的内容不能再被后续语音追加/重发。
    // （此处只清文字层，reconnectBuffer 是尚未识别的原始音频，由音频层自管理）
    resetTranscriptAccumulation();
    lastTranscriptText = '';
    if (transcript) transcript.textContent = '';
  }

  // PTT 松手发送后，在 ms 毫秒内吞掉云端 flush 吐出的尾随 transcript（同一句的重复）。
  // 只在常开模式有意义：mic 不停，否则那条 final 会触发常开策略二次发送整条消息。
  function suppressIncomingTranscripts(ms) { transcriptSuppressUntil = Date.now() + ms; }

  // 收到一条 ASR 消息后的统一处理（connectCloudWs 与 resumeSession 的打断 WS 共用，
  // 保证去重 / 吞尾 / 钩子派发只有一份）。
  function handleAsrMessage(msg) {
    if (msg.type === 'transcript') {
      if (!(msg.text || '').trim()) return;
      diagNoteTranscript(); // 入站诊断：记一次收到转录（含 interim）
      lastInboundTs = Date.now(); // 看门狗：刷新「最近收到转录」时刻
      // PTT 刚发过这条话 → flush 的尾随 final 属于同一句，吞掉避免常开策略二次发送
      if (Date.now() < transcriptSuppressUntil) {
        resetTranscriptAccumulation();
        lastTranscriptText = '';
        if (transcript) transcript.textContent = '';
        return;
      }
      const isFinal = applyTranscript(msg);
      if (isFinal) triggerDone();
      onTranscript?.(msg, isFinal);
    } else if (msg.type === 'error') {
      diag('asr-error', msg.message);
      setStatus('error');
      if (transcript) transcript.textContent = msg.message || '云端识别错误';
    } else if (msg.type === 'diag') {
      // 后端转发的云端原始事件（task-started/finished/failed）
      diag('cloud-event=' + msg.event, msg.info || '');
    }
  }

  // ─── 麦克风捕获（两种模式共用） ───
  function getSelectedMicDeviceId() {
    return (localStorage.getItem(VOICE_MIC_DEVICE_KEY) || '').trim();
  }

  function makeAudioConstraints(deviceId = getSelectedMicDeviceId()) {
    return {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
      channelCount: 1,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    };
  }

  function attachMicStream(stream) {
    const actx = new (window.AudioContext || window.webkitAudioContext)();
    const src = actx.createMediaStreamSource(stream);
    const analyser = actx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.5;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    src.connect(analyser);
    micData = { analyser, dataArray, stream, actx, src };
    return stream;
  }

  async function startMic() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: makeAudioConstraints(),
      });
      return attachMicStream(stream);
    } catch (e) {
      const shouldFallbackToDefault = getSelectedMicDeviceId()
        && e?.name !== 'NotAllowedError'
        && e?.name !== 'SecurityError';
      if (shouldFallbackToDefault) {
        try {
          localStorage.removeItem(VOICE_MIC_DEVICE_KEY);
          const fallbackStream = await navigator.mediaDevices.getUserMedia({
            audio: makeAudioConstraints(''),
          });
          return attachMicStream(fallbackStream);
        } catch {}
      }
      // 权限拒绝时球体变红，不在 transcript 显示文字
      setStatus('error');
      return null;
    }
  }

  function stopMic() {
    micData?.stream.getTracks().forEach(t => t.stop());
    // 关闭分析用的 AudioContext，否则反复开关/媒体挂起会累积 AudioContext，
    // 触顶浏览器约 6 个的硬上限后麦克风彻底失灵。
    try { micData?.actx?.close(); } catch {}
    micData = null;
  }

  // ─── Cloud ASR 传输（后端代理） ───
  function connectCloudWs() {
    cloudWsIntentional = false; // 新连接建立时清除上一次主动关闭的标记
    const ws = new WebSocket(CLOUD_WS_URL);
    ws.binaryType = 'arraybuffer';
    cloudWs = ws;

    ws.onopen = () => {
      if (cloudWs !== ws) return;
      const provider = localStorage.getItem(VOICE_PROVIDER_KEY) || 'aliyun';
      const lang = getLang?.()?.split('-')[0] || 'zh';
      ws.send(JSON.stringify({ type: 'config', provider, lang }));
      setStatus('listening');
      lastInboundTs = Date.now(); // 看门狗：（重）连后给一个新鲜起点，避免连上瞬间误判停滞
      // 补发重连死区里暂存的音频，避免断连期间说的话丢失
      if (reconnectBuffer.length) {
        for (const chunk of reconnectBuffer) {
          if (ws.readyState === WebSocket.OPEN) ws.send(chunk.buffer);
        }
        reconnectBuffer = [];
      }
      // 注意：此处不重置 accumulatedText，由调用方在首次启动时负责清空
    };

    ws.onmessage = (ev) => {
      if (cloudWs !== ws) return;
      try { handleAsrMessage(JSON.parse(ev.data)); } catch {}
    };

    ws.onerror = () => { if (cloudWs === ws) setStatus('error'); };

    ws.onclose = () => {
      if (cloudWs !== ws) return; // 已被新连接取代，忽略旧连接的 close 事件
      cloudWs = null;
      if (!cloudWsIntentional && micActive) {
        // 非主动断开（超时/网络抖动）且用户仍在录音 → 自动重连，保留已识别文字。
        // 先把当前句未定稿的前半句提级保住，否则新会话只 finalize 尾巴会覆盖丢失。
        diagReconnects++;
        diag('ws-closed → reconnect in 800ms', 'reconnects=' + diagReconnects);
        commitPendingInterim();
        setTimeout(() => { if (micActive) connectCloudWs(); }, 800);
      } else {
        cloudWsIntentional = false;
        if (micActive) setStatus('idle');
      }
    };
  }

  async function startCloudStream(stream) {
    const targetSR = 16000;
    // 先装好采集节点再连 WS：worklet 模块加载是异步的，避免连上 WS 后采集还没就绪而漏掉开头。
    if (micData?.actx?.sampleRate !== targetSR) {
      cloudAudioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: targetSR });
      const src = cloudAudioCtx.createMediaStreamSource(stream);
      await setupCloudProcessor(src, cloudAudioCtx);
    } else {
      await setupCloudProcessor(micData.src, micData.actx);
    }

    // 首次启动清空累积文字；重连时由 connectCloudWs 直接调用，不经过此处
    resetTranscriptAccumulation();
    reconnectBuffer = [];
    if (transcript) transcript.textContent = '';
    diagStart();
    startWatchdog();
    connectCloudWs();
  }

  // 一块 PCM（Int16Array）的统一去向：TTS 期间写打断缓冲 / WS 未连写重连缓冲 / 否则直发。
  // worklet 与 ScriptProcessor 两条采集路径共用，保证缓冲/发送逻辑只有一份。
  function handlePcmChunk(i16) {
    diagNoteChunk(i16.byteLength);
    if (bargeinBuffering) {
      // TTS 播放中：写入环形缓冲而非发送，供打断时回放
      bargeinBuffer.push(i16);
      if (bargeinBuffer.length > BARGEIN_MAX_CHUNKS) bargeinBuffer.shift();
      return;
    }
    if (!cloudWs || cloudWs.readyState !== WebSocket.OPEN) {
      // WS 重连死区：暂存音频，连上后由 onopen 补发，绝不丢字
      reconnectBuffer.push(i16);
      if (reconnectBuffer.length > RECONNECT_MAX_CHUNKS) reconnectBuffer.shift();
      return;
    }
    cloudWs.send(i16.buffer);
  }

  // 懒加载 AudioWorklet 模块（Blob URL，避免 file:// 路径问题）。每个 AudioContext 需各自 addModule。
  let pcmWorkletUrl = null;
  async function ensurePcmWorkletModule(audioCtx) {
    if (!pcmWorkletUrl) {
      const blob = new Blob([PCM_WORKLET_SRC], { type: 'application/javascript' });
      pcmWorkletUrl = URL.createObjectURL(blob);
    }
    await audioCtx.audioWorklet.addModule(pcmWorkletUrl);
  }

  // 安装采集节点。首选 AudioWorklet（独立音频线程，不被主线程渲染抢占 → 根治长语音丢帧）；
  // 不可用时回退到旧的 ScriptProcessor。两者都把 PCM 块交给 handlePcmChunk。
  async function setupCloudProcessor(srcNode, audioCtx) {
    if (audioCtx.audioWorklet) {
      try {
        await ensurePcmWorkletModule(audioCtx);
        const node = new AudioWorkletNode(audioCtx, 'pcm-capture', {
          numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1,
          processorOptions: { chunk: PCM_CHUNK_SAMPLES },
        });
        node.port.onmessage = (ev) => { handlePcmChunk(new Int16Array(ev.data)); };
        srcNode.connect(node);
        // 接到 destination 以保证节点被音频图拉取（process 才会被调用）；
        // process 不写 output → 输出静音，不会回放到扬声器。镜像原 ScriptProcessor 的做法。
        node.connect(audioCtx.destination);
        cloudWorkletNode = node;
        diagCaptureMode = 'worklet';
        diag('capture=worklet', 'sr=' + audioCtx.sampleRate + ' chunk=' + PCM_CHUNK_SAMPLES);
        return;
      } catch (e) {
        diag('worklet-failed → fallback scriptprocessor', e?.message);
      }
    }
    // 回退：ScriptProcessorNode（已废弃、主线程，可能丢帧，仅兜底）
    cloudProcessor = audioCtx.createScriptProcessor(PCM_CHUNK_SAMPLES, 1, 1);
    srcNode.connect(cloudProcessor);
    cloudProcessor.connect(audioCtx.destination);
    cloudProcessor.onaudioprocess = (e) => {
      const f32 = e.inputBuffer.getChannelData(0);
      const i16 = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++) {
        i16[i] = Math.max(-32768, Math.min(32767, f32[i] * 32768));
      }
      handlePcmChunk(i16);
    };
    diagCaptureMode = 'scriptprocessor';
    diag('capture=scriptprocessor', 'sr=' + audioCtx.sampleRate);
  }

  function stopCloudStream({ preserveProcessor = false } = {}) {
    cloudWsIntentional = true; // 标记为主动关闭，防止 onclose 触发重连
    const ws = cloudWs;
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'flush' }));
        setTimeout(() => { try { ws.close(); } catch {} }, 200);
      } else {
        ws?.close();
      }
    } catch {}
    if (cloudWs === ws) cloudWs = null;

    if (!preserveProcessor) {
      try { cloudWorkletNode?.disconnect(); } catch {}
      cloudWorkletNode = null;
      try { cloudProcessor?.disconnect(); } catch {}
      cloudProcessor = null;
      try { if (cloudAudioCtx) { cloudAudioCtx.close(); cloudAudioCtx = null; } } catch {}
    }
  }

  // 向云端 ASR 请求立即给最终结果（PTT 松手 / 关闭时调用）
  function flushAsr() {
    try {
      if (cloudWs && cloudWs.readyState === WebSocket.OPEN) {
        cloudWs.send(JSON.stringify({ type: 'flush' }));
      }
    } catch {}
  }

  // ─── 会话生命周期 ───
  // 开启会话：开麦 + 接 ASR 流。返回 stream（失败返回 null）。
  async function startSession() {
    micActive = true;
    userWantedMic = true;
    suspendedByMedia = false;
    syncState();
    const stream = await startMic();
    if (!stream) {
      micActive = false;
      userWantedMic = false;
      syncState();
      return null;
    }
    await startCloudStream(stream);
    return stream;
  }

  // 停止会话（= 原 stopVoiceInput 的 core 部分）。模式自有的计时器/标志由 onSessionStop 清。
  function stopSession({ keepIntent = false } = {}) {
    if (doneTimer) { clearTimeout(doneTimer); doneTimer = null; }
    pttHolding = false;
    transcriptSuppressUntil = 0;
    onSessionStop?.(); // 各模式清理自己的计时器/检测状态
    lastTranscriptText = '';
    resetTranscriptAccumulation();
    reconnectBuffer = [];
    micActive = false;
    if (!keepIntent) userWantedMic = false;
    bargeinBuffer = [];
    bargeinBuffering = false;
    stopCloudStream();
    stopMic();
    diagStop();
    stopWatchdog();
    setStatus('idle');
    if (transcript) transcript.textContent = '';
    syncState();
  }

  // 视频/音乐模式：完全停止 mic（不需要打断能力），保留用户意图
  function suspendForMedia() {
    if (!micActive) return;
    suspendedByMedia = true;
    stopSession({ keepIntent: true });
  }

  // TTS 模式：只停云端 ASR WebSocket，保持 mic 硬件 + ScriptProcessor。
  // 开启预缓冲：打断时可回放最近 1.5s 的音频，避免开头几个字丢失。
  function suspendForTTS() {
    if (!micActive) return;
    suspendedByMedia = true;
    ttsStartTime = Date.now();
    onSuspendForTTS?.(); // 各模式重置自己的打断检测计数
    bargeinBuffer = [];
    bargeinBuffering = true;
    stopCloudStream({ preserveProcessor: true }); // 保留 Processor，只断 WS
    setStatus('speaking');
  }

  // 会话恢复（= 原 resumeVoiceInputFromMedia）。fromBargein=true 表示由打断检测触发。
  async function resumeSession(fromBargein = false) {
    if (!suspendedByMedia || !userWantedMic) return;
    suspendedByMedia = false;

    // 拿走缓冲区快照并立刻停止写入，避免 WS 重连期间继续堆积
    const bufferedChunks = bargeinBuffer.slice();
    bargeinBuffer = [];
    bargeinBuffering = false;

    onResume?.(fromBargein); // 各模式重置检测状态 / 启动续播计时

    if (micActive && micData && (cloudWorkletNode || cloudProcessor)) {
      // TTS 模式：采集节点仍存活，只需重连 WebSocket
      setStatus('listening');
      resetTranscriptAccumulation();
      if (transcript) transcript.textContent = '';
      cloudWsIntentional = false; // stopCloudStream(TTS) 留下的是旧连接标志，新连接要恢复自愈重连
      const bargeinWs = new WebSocket(CLOUD_WS_URL);
      bargeinWs.binaryType = 'arraybuffer';
      cloudWs = bargeinWs;
      bargeinWs.onopen = () => {
        if (cloudWs !== bargeinWs) return;
        const provider = localStorage.getItem(VOICE_PROVIDER_KEY) || 'aliyun';
        const lang = getLang?.()?.split('-')[0] || 'zh';
        bargeinWs.send(JSON.stringify({ type: 'config', provider, lang }));
        lastInboundTs = Date.now(); // 看门狗：打断重连后给新鲜起点
        // 先把预缓冲的历史音频一次性发出，补回打断前说的内容
        for (const chunk of bufferedChunks) {
          if (bargeinWs.readyState === WebSocket.OPEN) bargeinWs.send(chunk.buffer);
        }
      };
      bargeinWs.onmessage = (ev) => {
        if (cloudWs !== bargeinWs) return;
        try { handleAsrMessage(JSON.parse(ev.data)); } catch {}
      };
      bargeinWs.onerror = () => { if (cloudWs === bargeinWs) setStatus('error'); };
      bargeinWs.onclose = () => {
        if (cloudWs !== bargeinWs) return;
        cloudWs = null;
        if (!cloudWsIntentional && micActive) {
          diagReconnects++;
          diag('barge-in ws-closed → reconnect in 800ms', 'reconnects=' + diagReconnects);
          commitPendingInterim(); // 同 connectCloudWs：重连前保住当前句前半段
          setTimeout(() => { if (micActive) connectCloudWs(); }, 800);
        } else {
          cloudWsIntentional = false;
          if (micActive) setStatus('idle');
        }
      };
    } else {
      // 视频/音乐模式，或 Processor 已被销毁：完整重启
      micActive = true;
      syncState();
      const stream = await startMic();
      if (!stream) {
        micActive = false;
        userWantedMic = false;
        syncState();
        return;
      }
      await startCloudStream(stream);
    }
  }

  return {
    // 渲染 / 状态
    setStatus,
    getStatus,
    triggerDone,
    startRenderLoop,
    stopRenderLoop,
    setExternalVol,
    // 会话生命周期
    startSession,
    stopSession,
    suspendForMedia,
    suspendForTTS,
    resumeSession,
    flushAsr,
    sendRecognizedVoiceText,
    suppressIncomingTranscripts,
    resetTranscriptAccumulation,
    // 运行时状态访问
    get micActive() { return micActive; },
    get userWantedMic() { return userWantedMic; },
    set userWantedMic(v) { userWantedMic = v; },
    get suspendedByMedia() { return suspendedByMedia; },
    get ttsStartTime() { return ttsStartTime; },
    get pttHolding() { return pttHolding; },
    set pttHolding(v) { pttHolding = v; },
    hasLiveProcessor: () => Boolean(micActive && micData && (cloudWorkletNode || cloudProcessor)),
    getText: () => lastTranscriptText,
    setText: (v) => { lastTranscriptText = v; },
    setTTSAnalyser,
    // 清当前句未定稿 interim：PTT 开始新一轮说话时调用，避免上一段残留 interim
    // 在恰好重连时被 commitPendingInterim 提级进来。
    clearPendingInterim: () => { pendingInterim = ''; },
    // 模式钩子注册（编排层组装，支持组合多个模式）
    setOnFrame: (cb) => { onFrame = cb; },
    setOnTranscript: (cb) => { onTranscript = cb; },
    setOnSessionStop: (cb) => { onSessionStop = cb; },
    setOnSuspendForTTS: (cb) => { onSuspendForTTS = cb; },
    setOnResume: (cb) => { onResume = cb; },
    setOnState: (cb) => { onState = cb; },
  };
}
