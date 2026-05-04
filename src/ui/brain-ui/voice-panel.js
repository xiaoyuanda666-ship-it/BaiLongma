// 声波点云球 + 双模式语音输入面板
// 模式 A：browser — 使用浏览器内置 SpeechRecognition（默认）
// 模式 B：whisper — 通过 WebSocket 连接本地 Whisper 服务（高精度，需先启动服务）
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
const STATE_CFG = {
  idle:        { amp: 0.003, spd: 0.10, r: [50,68,80],    g: [50,68,80],    b: [55,73,85]   },
  listening:   { amp: 0.055, spd: 0.75, r: [185,215,245], g: [185,215,245], b: [195,225,255] },
  recognizing: { amp: 0.55,  spd: 4.50, r: [25,75,165],   g: [95,155,230],  b: [195,230,255] },
  done:        { amp: 0.10,  spd: 1.20, r: [30,105,65],   g: [145,200,135], b: [45,90,60]   },
  processing:  { amp: 0.15,  spd: 1.10, r: [100,60,200],  g: [80,60,180],   b: [220,190,255] },
  error:       { amp: 0.10,  spd: 0.70, r: [200,240,255], g: [20,30,40],    b: [20,30,40]   },
  event:       { amp: 0.60,  spd: 4.00, r: [255,200,50],  g: [200,160,30],  b: [50,80,150]   },
};

// ─── 声音事件图标映射 ───
const SOUND_EVENT_ICONS = {
  clapping:        '👏',
  finger_snapping: '🤌',
  keyboard_typing: '⌨️',
  typing:          '⌨️',
  writing:         '✍️',
  footsteps:       '👟',
  walking:         '🚶',
  running:         '🏃',
  knock:           '🚪',
  knock_door:      '🚪',
};

const VOICE_WS_PORT = 3723;
const VOICE_WS_URL  = `ws://127.0.0.1:${VOICE_WS_PORT}`;
const CLOUD_WS_URL  = 'ws://127.0.0.1:3721/voice/cloud';
const VOICE_THRESHOLD_KEY = 'bailongma-voice-threshold';
const VOICE_MODE_KEY     = 'bailongma-voice-mode';
const VOICE_PROVIDER_KEY = 'bailongma-voice-provider';

// 从 localStorage 读取灵敏度阈值，支持运行时动态修改
function getVoiceThreshold() {
  return parseFloat(localStorage.getItem(VOICE_THRESHOLD_KEY) || '0.008');
}

// 派生阈值（ambient = near/2.67，和原始比例保持一致）
function getAmbientThreshold() { return getVoiceThreshold() * 0.375; }

export function initVoicePanel({
  btnId, panelId, canvasId, statusId, transcriptId,
  getChatInput, getSendBtn, getSendMessage, getLang, getAutoSend,
}) {
  const btn        = document.getElementById(btnId);
  const panel      = document.getElementById(panelId);
  const canvas     = document.getElementById(canvasId);
  const transcript = document.getElementById(transcriptId);

  if (!panel || !canvas) return;

  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, cx = 0, cy = 0, scale = 0;

  function resizeCanvasToDisplay() {
    const rect = canvas.getBoundingClientRect();
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

  function setStatus(newSk) { sk = newSk; }

  function triggerDone() {
    setStatus('done');
    if (doneTimer) clearTimeout(doneTimer);
    doneTimer = setTimeout(() => {
      doneTimer = null;
      if (sk === 'done') setStatus(micActive ? 'listening' : 'idle');
    }, 2000);
  }

  function drawFrame() {
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

    if (micData) {
      micData.analyser.getByteFrequencyData(micData.dataArray);
      const sum = micData.dataArray.reduce((a, b) => a + b, 0);
      const vol = (sum / micData.dataArray.length) / 255;
      if (vol > 0.02) {
        s.amp = lerp(s.amp, 0.08 + vol * 1.2, 0.4);
        s.spd = lerp(s.spd, 1.0 + vol * 5.0, 0.2);
        if (sk !== 'recognizing' && sk !== 'event') setStatus(vol > 0.15 ? 'recognizing' : 'listening');
      } else if (sk !== 'idle' && sk !== 'event' && sk !== 'processing' && sk !== 'done') {
        setStatus('idle');
      }
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

    const allPts = [
      ...BASE_PTS.map(p  => ({ ...project(p), inner: false })),
      ...BASE_PTS2.map(p => ({ ...project(p), inner: true  })),
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

  // ─── 麦克风捕获（共用于两种模式） ───
  let micData = null;
  let micActive = false;
  let userWantedMic = false;
  let suspendedByMedia = false;
  let nearFieldGate = {
    noiseFloor: getAmbientThreshold(),
    nearChunks: 0,
    tailChunks: 0,
    ambientChunks: 0,
  };
  // Whisper 专用：音频处理节点
  let whisperAudioCtx = null;
  let whisperProcessor = null;
  let whisperWs = null;
  // Cloud 专用
  let cloudAudioCtx = null;
  let cloudProcessor = null;
  let cloudWs = null;
  // Browser 模式
  let recognition = null;

  // ─── 模式检测 ───
  // 优先 Whisper（服务已完全就绪才切换），否则回退 browser
  let mode = 'browser';

  async function detectMode() {
    const stored = localStorage.getItem(VOICE_MODE_KEY);
    if (stored === 'cloud') { mode = 'cloud'; return; }
    if (stored === 'browser') { mode = 'browser'; return; }

    // local：尝试连接本地 Whisper 服务，若未运行则回退到 browser
    try {
      const resp = await fetch('http://127.0.0.1:3721/voice/status');
      if (resp.ok) {
        const data = await resp.json();
        const voiceStatus = data?.voice?.status;
        if (voiceStatus === 'running') { mode = 'whisper'; return; }
        if (voiceStatus === 'starting') { mode = 'browser'; return; }
      }
    } catch {}
    // 状态 API 不可达时：直接探测 WebSocket 端口
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${VOICE_WS_PORT}`);
      await new Promise((resolve) => {
        ws.onopen = () => { try { ws.close(); } catch {} mode = 'whisper'; resolve(); };
        ws.onerror = () => { mode = 'browser'; resolve(); };
        setTimeout(() => { try { ws.close(); } catch {} mode = 'browser'; resolve(); }, 1500);
      });
      return;
    } catch {}
    mode = 'browser';
  }

  async function startMic() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
          channelCount: 1,
        },
      });
      const actx = new (window.AudioContext || window.webkitAudioContext)();
      const src = actx.createMediaStreamSource(stream);
      const analyser = actx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.5;
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      src.connect(analyser);
      micData = { analyser, dataArray, stream, actx, src };
      nearFieldGate = { noiseFloor: getAmbientThreshold(), nearChunks: 0, tailChunks: 0, ambientChunks: 0 };
      return stream;
    } catch (e) {
      // 权限拒绝时球体变红，不在 transcript 显示文字
      setStatus('error');
      return null;
    }
  }

  function stopMic() {
    micData?.stream.getTracks().forEach(t => t.stop());
    micData = null;
  }

  // ─── Browser SpeechRecognition 模式 ───
  function startBrowserRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      if (transcript) transcript.textContent = '浏览器不支持语音识别';
      return;
    }
    recognition = new SR();
    recognition.lang = getLang?.() || 'zh-CN';
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onresult = (e) => {
      let interim = '', final = '';
      for (const result of e.results) {
        if (result.isFinal) final += result[0].transcript;
        else interim += result[0].transcript;
      }
      if (transcript) transcript.textContent = final || interim;
      if (final) {
        const input = getChatInput?.();
        if (input) input.value = final;
        triggerDone();
        if (getAutoSend?.()) {
          setStatus('processing');
          setTimeout(sendRecognizedVoiceText, 100);
        }
      }
    };

    recognition.onerror = () => {
      setStatus('error');
      if (transcript) transcript.textContent = '';
    };

    let recognitionActive = false;

    recognition.onstart = () => {
      recognitionActive = true;
      setStatus('listening');
      if (transcript) transcript.textContent = '';
    };

    recognition.onend = () => {
      recognitionActive = false;
      if (!micActive) { setStatus('idle'); return; }
      const delay = sk === 'error' ? 2000 : 300;
      setTimeout(() => {
        if (!micActive || recognitionActive) return;
        try { recognition.start(); } catch {}
      }, delay);
    };

    recognitionActive = false;
    recognition.start();
  }

  function stopBrowserRecognition() {
    try { recognition?.stop(); recognition?.abort(); } catch {}
    recognition = null;
  }

  // ─── Whisper WebSocket 模式 ───
  function sendRecognizedVoiceText() {
    const sent = getSendMessage?.({ channel: '语音识别', label: 'You · 语音识别' });
    if (!sent) getSendBtn?.()?.click();
  }

  function startWhisperStream(stream) {
    // 创建 16kHz AudioContext（若当前 actx 采样率不同，则重新创建）
    const targetSR = 16000;

    let audioCtx;
    if (micData?.actx?.sampleRate !== targetSR) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: targetSR });
      const src = audioCtx.createMediaStreamSource(stream);
      whisperAudioCtx = audioCtx;
      setupWhisperProcessor(src, audioCtx);
    } else {
      setupWhisperProcessor(micData.src, micData.actx);
    }

    whisperWs = new WebSocket(VOICE_WS_URL);
    whisperWs.binaryType = 'arraybuffer';

    whisperWs.onopen = () => {
      const lang = getLang?.()?.split('-')[0] || 'zh';
      whisperWs.send(JSON.stringify({ type: 'config', lang }));
      setStatus('listening');
      // 不显示"正在聆听"等状态文字，保持 transcript 区域只显示识别结果
      if (transcript) transcript.textContent = '';
    };

    whisperWs.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'transcript') {
          const text = (msg.text || '').trim();
          if (!text) return;
          if (transcript) transcript.textContent = text;
          if (msg.is_final) {
            const input = getChatInput?.();
            if (input) input.value = text;
            triggerDone();
            if (getAutoSend?.()) {
              setStatus('processing');
              setTimeout(sendRecognizedVoiceText, 100);
            }
          }
        } else if (msg.type === 'sound_event') {
          const icon = SOUND_EVENT_ICONS[msg.event] || '🔊';
          const label = msg.label_cn || msg.event;
          const conf = msg.confidence ? ` (${Math.round(msg.confidence * 100)}%)` : '';
          if (transcript) transcript.textContent = `${icon} ${label}${conf}`;
          // 球体变色闪烁 ~1.5s（约 90 帧）
          setStatus('event');
          eventFlashCount = 90;
        } else if (msg.type === 'ambient_voice') {
          if (transcript) transcript.textContent = '环境人声（已忽略）';
          setStatus('event');
          eventFlashCount = 45;
        } else if (msg.type === 'config_ok') {
          console.log('[Voice] Whisper 配置确认:', msg.lang);
        }
      } catch {}
    };

    whisperWs.onerror = () => {
      // 连接失败时只改变球体状态色，不在 transcript 显示文字
      setStatus('error');
    };

    whisperWs.onclose = () => {
      if (micActive) setStatus('idle');
    };
  }

  function setupWhisperProcessor(srcNode, audioCtx) {
    // ScriptProcessorNode：每 4096 样本（~256ms @16kHz）向 WebSocket 发一次 PCM
    const bufferSize = 4096;
    whisperProcessor = audioCtx.createScriptProcessor(bufferSize, 1, 1);
    srcNode.connect(whisperProcessor);
    whisperProcessor.connect(audioCtx.destination);

    whisperProcessor.onaudioprocess = (e) => {
      if (!whisperWs || whisperWs.readyState !== WebSocket.OPEN) return;
      const f32 = e.inputBuffer.getChannelData(0);
      let sumSquares = 0;
      let peak = 0;
      for (let i = 0; i < f32.length; i++) {
        const sample = Math.abs(f32[i]);
        sumSquares += sample * sample;
        if (sample > peak) peak = sample;
      }
      const rms = Math.sqrt(sumSquares / Math.max(1, f32.length));
      const gate = nearFieldGate;
      if (rms < gate.noiseFloor * 1.8) {
        gate.noiseFloor = gate.noiseFloor * 0.98 + rms * 0.02;
      }
      const dynamicThreshold = Math.max(getVoiceThreshold(), gate.noiseFloor * 2.2);
      const isNearVoice = rms >= dynamicThreshold || (rms >= dynamicThreshold * 0.72 && peak >= 0.05);

      if (!isNearVoice) {
        if (gate.nearChunks >= 2 && gate.tailChunks < 10) {
          gate.tailChunks += 1;
        } else {
          gate.nearChunks = 0;
          gate.tailChunks = 0;
          if (rms >= getAmbientThreshold()) {
            gate.ambientChunks += 1;
            if (gate.ambientChunks >= 4) {
              whisperWs.send(JSON.stringify({ type: 'ambient_voice', rms: Number(rms.toFixed(4)) }));
              gate.ambientChunks = 0;
            }
          }
          // Keep streaming; Python VAD decides whether the sound is speech or ambience.
        }
      } else {
        gate.nearChunks += 1;
        gate.tailChunks = 0;
        gate.ambientChunks = 0;
      }

      // Non-near chunks that reach here are the short quiet tail used to flush server-side VAD.
      // Float32 → Int16
      const i16 = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++) {
        i16[i] = Math.max(-32768, Math.min(32767, f32[i] * 32768));
      }
      whisperWs.send(i16.buffer);
    };
  }

  function stopWhisperStream() {
    try {
      if (whisperWs && whisperWs.readyState === WebSocket.OPEN) {
        whisperWs.send(JSON.stringify({ type: 'flush' }));
        setTimeout(() => { try { whisperWs?.close(); } catch {} }, 200);
      } else {
        whisperWs?.close();
      }
    } catch {}
    whisperWs = null;

    try { whisperProcessor?.disconnect(); } catch {}
    whisperProcessor = null;

    try { if (whisperAudioCtx) { whisperAudioCtx.close(); whisperAudioCtx = null; } } catch {}
  }

  // ─── Cloud ASR 模式（后端代理） ───
  function startCloudStream(stream) {
    const targetSR = 16000;
    if (micData?.actx?.sampleRate !== targetSR) {
      cloudAudioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: targetSR });
      const src = cloudAudioCtx.createMediaStreamSource(stream);
      setupCloudProcessor(src, cloudAudioCtx);
    } else {
      setupCloudProcessor(micData.src, micData.actx);
    }

    cloudWs = new WebSocket(CLOUD_WS_URL);
    cloudWs.binaryType = 'arraybuffer';

    cloudWs.onopen = () => {
      const provider = localStorage.getItem(VOICE_PROVIDER_KEY) || 'aliyun';
      const lang = getLang?.()?.split('-')[0] || 'zh';
      cloudWs.send(JSON.stringify({ type: 'config', provider, lang }));
      setStatus('listening');
      if (transcript) transcript.textContent = '';
    };

    cloudWs.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'transcript') {
          const text = (msg.text || '').trim();
          if (!text) return;
          if (transcript) transcript.textContent = text;
          if (msg.is_final) {
            const input = getChatInput?.();
            if (input) input.value = text;
            triggerDone();
            if (getAutoSend?.()) {
              setStatus('processing');
              setTimeout(sendRecognizedVoiceText, 100);
            }
          }
        } else if (msg.type === 'error') {
          setStatus('error');
          if (transcript) transcript.textContent = msg.message || '云端识别错误';
        }
      } catch {}
    };

    cloudWs.onerror = () => { setStatus('error'); };
    cloudWs.onclose = () => { if (micActive) setStatus('idle'); };
  }

  function setupCloudProcessor(srcNode, audioCtx) {
    const bufferSize = 4096;
    cloudProcessor = audioCtx.createScriptProcessor(bufferSize, 1, 1);
    srcNode.connect(cloudProcessor);
    cloudProcessor.connect(audioCtx.destination);

    cloudProcessor.onaudioprocess = (e) => {
      if (!cloudWs || cloudWs.readyState !== WebSocket.OPEN) return;
      const f32 = e.inputBuffer.getChannelData(0);
      const i16 = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++) {
        i16[i] = Math.max(-32768, Math.min(32767, f32[i] * 32768));
      }
      cloudWs.send(i16.buffer);
    };
  }

  function stopCloudStream() {
    try {
      if (cloudWs && cloudWs.readyState === WebSocket.OPEN) {
        cloudWs.send(JSON.stringify({ type: 'flush' }));
        setTimeout(() => { try { cloudWs?.close(); } catch {} }, 200);
      } else {
        cloudWs?.close();
      }
    } catch {}
    cloudWs = null;

    try { cloudProcessor?.disconnect(); } catch {}
    cloudProcessor = null;

    try { if (cloudAudioCtx) { cloudAudioCtx.close(); cloudAudioCtx = null; } } catch {}
  }

  // ─── 统一开关 ───
  async function toggleVoice() {
    if (!micActive) {
      micActive = true;
      userWantedMic = true;
      suspendedByMedia = false;
      btn?.classList.add('active');
      await detectMode();
      const stream = await startMic();
      if (!stream) { micActive = false; userWantedMic = false; btn?.classList.remove('active'); return; }

      if (mode === 'whisper') {
        startWhisperStream(stream);
      } else if (mode === 'cloud') {
        startCloudStream(stream);
      } else {
        startBrowserRecognition();
      }
    } else {
      stopVoiceInput();
    }
  }

  function stopVoiceInput({ keepIntent = false, reason = '' } = {}) {
    if (doneTimer) { clearTimeout(doneTimer); doneTimer = null; }
    micActive = false;
    if (!keepIntent) userWantedMic = false;
    btn?.classList.toggle('active', Boolean(keepIntent && userWantedMic));

    if (mode === 'whisper') {
      stopWhisperStream();
    } else if (mode === 'cloud') {
      stopCloudStream();
    } else {
      stopBrowserRecognition();
    }

    stopMic();
    setStatus('idle');
    if (transcript) transcript.textContent = '';
  }

  async function resumeVoiceInputFromMedia() {
    if (!suspendedByMedia || !userWantedMic || micActive) return;
    suspendedByMedia = false;
    micActive = true;
    btn?.classList.add('active');
    await detectMode();
    const stream = await startMic();
    if (!stream) {
      micActive = false;
      userWantedMic = false;
      btn?.classList.remove('active');
      return;
    }
    if (mode === 'whisper') {
      startWhisperStream(stream);
    } else if (mode === 'cloud') {
      startCloudStream(stream);
    } else {
      startBrowserRecognition();
    }
  }

  window.bailongmaVoice = {
    isActive: () => micActive,
    suspendForMedia: () => {
      if (!micActive) return;
      suspendedByMedia = true;
      stopVoiceInput({ keepIntent: true, reason: '视频模式中，语音已暂停' });
    },
    resumeAfterMedia: resumeVoiceInputFromMedia,
    stop: () => stopVoiceInput(),
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

  // 阈值实时更新（设置面板保存后立即生效，无需重启语音）
  window.addEventListener('bailongma:voice-threshold', (event) => {
    const t = Number(event.detail?.threshold);
    if (!isNaN(t) && t > 0) {
      nearFieldGate.noiseFloor = t * 0.375;
    }
  });

  // 语音模式切换（local/cloud），下次点击麦克风时生效
  window.addEventListener('bailongma:voice-mode', (event) => {
    const newMode = event.detail?.mode;
    if (newMode === 'cloud' || newMode === 'local') {
      localStorage.setItem(VOICE_MODE_KEY, newMode);
    }
    // 若麦克风正在运行，停止后重新启动以切换模式
    if (micActive) {
      stopVoiceInput({ keepIntent: true });
      setTimeout(async () => {
        await detectMode();
        micActive = true;
        const stream = await startMic();
        if (!stream) { micActive = false; userWantedMic = false; btn?.classList.remove('active'); return; }
        if (mode === 'whisper') startWhisperStream(stream);
        else if (mode === 'cloud') startCloudStream(stream);
        else startBrowserRecognition();
      }, 200);
    }
  });

  // ─── 面板初始化 ───
  function openPanel() {
    panel.hidden = false;
    if (!rafId) drawFrame();
  }

  btn?.addEventListener('click', toggleVoice);
  canvas.addEventListener('click', toggleVoice);

  setStatus('idle');
  openPanel();
  // 不再自动启动麦克风：Whisper 模型加载需要数秒至数十秒，
  // 过早连接会在模型未就绪时失败，或错误地回退到浏览器识别模式。
  // 用户点击麦克风按钮或声波球时才启动。
}
