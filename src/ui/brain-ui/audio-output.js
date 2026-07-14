// audio-output.js — Jarvis语音输出设备路由
//
// 背景 / 为什么需要这个模块：
//   Jarvis是"会说话"的助手，TTS 默认走 `new Audio()`，也就是听天由命跟着系统默认播放设备走。
//   而大众用户的机器上经常装着虚拟声卡（Steam 串流 / NVIDIA Virtual / VB-Audio / Pico VR 等），
//   或者拔掉耳机后 Windows 没有正确回退到内置扬声器 —— 系统默认就卡在一个"哑巴"虚拟设备上。
//   结果：Jarvis在说话，但用户什么都听不到，而且双方都不知道为什么。对语音产品这是致命的静默失败。
//
// 本模块做三件事（全部在 renderer 侧，不碰系统默认、不加任何 runtime 硬拦截）：
//   1) 自己掌握"从哪出声"：用 HTMLMediaElement.setSinkId() 把语音显式绑定到一个真实硬件设备。
//   2) 自动规避虚拟/已拔出设备：auto 模式跟随系统默认，但当默认是虚拟设备时自动落到真实硬件。
//   3) 真的无法出声时（没有任何真实设备、或用户钉的设备不在了）→ 通过可视化横幅 + 一键修复兜底。
//
// 公共 API：
//   getOutputPreference() / setOutputPreference(id)
//   listOutputDevices()            -> 设置面板下拉用
//   resolveSink()                  -> 计算应当使用的 sinkId 及原因
//   applyOutputSink(audioEl)       -> 对一个 <audio> 应用 sink（播放前调用）
//   initAudioOutputRouting(opts)   -> 启动 devicechange 监听 + 横幅兜底
//   refreshOutputStatus()          -> 重新评估并按需显示/隐藏横幅
//   isVirtualOutputLabel(label)

const OUTPUT_DEVICE_KEY = 'jarvis-voice-output-device-id'; // '' = 自动；否则为具体 deviceId
const BANNER_DISMISS_KEY = 'jarvis-voice-output-banner-dismissed'; // 用户主动忽略后本会话不再弹

// 虚拟 / 串流 / 回环声卡关键字黑名单（小写匹配）。命中即视为"不能直接出声给用户"的设备。
// 关键字而非精确名 → 通用覆盖各家产品和本地化名称。
const VIRTUAL_LABEL_PATTERNS = [
  'steam streaming',
  'nvidia virtual',
  'nvidia broadcast',
  'vb-audio', 'vb audio', 'vb-cable', 'cable output', 'cable input', 'voicemeeter',
  'pico ',           // Pico VR 串流（注意带空格，避免误伤含 "pico" 的真实型号；够用即可）
  'virtual',         // 通用兜底：各类虚拟声卡
  'streaming',       // 通用兜底：各类串流声卡
  '虚拟', '串流',
];

// 真实硬件优先级打分（auto 模式下默认是虚拟设备、需要自己挑一个真实设备时用）。
// 越大越优先：耳机/耳麦 > 扬声器 > 其它 > 显示器/HDMI（多半没接音箱）。
function realDeviceScore(label) {
  const l = (label || '').toLowerCase();
  if (/headphone|headset|耳机|耳麦|earphone/.test(l)) return 30;
  if (/speaker|扬声器|realtek|内置|internal/.test(l)) return 20;
  if (/hdmi|display|显示器|monitor|nvidia high definition/.test(l)) return 5;
  return 10;
}

export function isVirtualOutputLabel(label) {
  const l = (label || '').toLowerCase();
  if (!l) return false;
  return VIRTUAL_LABEL_PATTERNS.some(p => l.includes(p));
}

const supportsSetSinkId = typeof HTMLMediaElement !== 'undefined'
  && 'setSinkId' in HTMLMediaElement.prototype;

export function getOutputPreference() {
  try { return localStorage.getItem(OUTPUT_DEVICE_KEY) || ''; } catch { return ''; }
}

export function setOutputPreference(deviceId) {
  try {
    if (deviceId) localStorage.setItem(OUTPUT_DEVICE_KEY, deviceId);
    else localStorage.removeItem(OUTPUT_DEVICE_KEY);
  } catch {}
  // 选择变化后立即重评估横幅，并把当前在播元素切过去
  reapplyToCurrent();
  refreshOutputStatus();
}

// 枚举所有音频输出设备。注意：完整 label / deviceId 需要麦克风权限已授予
// （本应用用 ASR，正常使用后即已授权；未授权时 label 为空，此时退回系统默认即可，无害）。
export async function listOutputDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  let devices = [];
  try { devices = await navigator.mediaDevices.enumerateDevices(); } catch { return []; }
  return devices
    .filter(d => d.kind === 'audiooutput')
    .map(d => ({
      deviceId: d.deviceId,
      label: d.label,
      isDefault: d.deviceId === 'default' || d.deviceId === 'communications',
      isVirtual: isVirtualOutputLabel(d.label),
    }));
}

// 计算应当使用的 sink。返回：
//   { sinkId, chosenLabel, degraded, reason }
//   sinkId === '' 表示"跟随系统默认即可"（默认本身是真实设备）。
//   degraded === true 表示系统默认不可用、已自动改路到真实设备；或完全找不到真实设备。
export async function resolveSink() {
  if (!supportsSetSinkId) {
    return { sinkId: '', chosenLabel: '', degraded: false, reason: 'unsupported' };
  }
  const outs = await listOutputDevices();
  const pref = getOutputPreference();

  // 真实硬件候选（排除 default/communications 别名、虚拟设备、无名占位）
  const realDevices = outs.filter(
    d => !d.isDefault && d.label && !d.isVirtual
  );

  // 1) 用户钉了具体设备
  if (pref) {
    const pinned = outs.find(d => d.deviceId === pref);
    if (pinned && pinned.label) {
      return { sinkId: pinned.deviceId, chosenLabel: pinned.label, degraded: false, reason: 'pinned' };
    }
    // 钉的设备不在了 → 走自动兜底，并标记 degraded（横幅提示）
  }

  // 2) 自动模式：看系统默认是不是真实设备
  const defaultEntry = outs.find(d => d.deviceId === 'default');
  const defaultIsVirtual = defaultEntry ? isVirtualOutputLabel(defaultEntry.label) : false;
  const defaultHasLabel = !!(defaultEntry && defaultEntry.label);

  // 权限未授予 / 拿不到 label → 无法判断，老老实实跟随系统默认（无害回退）
  if (!defaultHasLabel && !realDevices.length) {
    return { sinkId: '', chosenLabel: '', degraded: false, reason: 'no-labels' };
  }

  // 系统默认是真实设备（含用户插着的耳机）→ 跟随它，这正是我们想要的
  if (defaultEntry && defaultHasLabel && !defaultIsVirtual) {
    const degraded = !!pref; // 只有"钉的设备没了才退到这"才算降级
    return {
      sinkId: '',
      chosenLabel: defaultEntry.label.replace(/^(默认|default)\s*-\s*/i, ''),
      degraded,
      reason: pref ? 'pinned-missing-fallback-default' : 'follow-default',
    };
  }

  // 系统默认是虚拟设备 / 不可用 → 自己挑一个最优真实设备改路过去
  if (realDevices.length) {
    const best = realDevices.slice().sort((a, b) => realDeviceScore(b.label) - realDeviceScore(a.label))[0];
    return {
      sinkId: best.deviceId,
      chosenLabel: best.label,
      degraded: true,
      reason: 'rerouted-from-virtual',
    };
  }

  // 实在没有任何真实设备可用
  return {
    sinkId: '',
    chosenLabel: defaultEntry?.label || '',
    degraded: true,
    reason: 'no-real-device',
  };
}

// 对一个 <audio> 元素应用 sink。播放前调用即可（setSinkId 在 play 前/后皆可，提前最稳）。
// 返回 resolveSink 的结果（含 degraded/reason），供调用方决定是否提示。
export async function applyOutputSink(audioEl) {
  const res = await resolveSink().catch(() => null);
  if (!res) return null;
  if (!supportsSetSinkId || !audioEl || typeof audioEl.setSinkId !== 'function') return res;
  try {
    // sinkId === '' 也要显式设一次：把可能残留的"钉死到旧设备"复位回系统默认
    await audioEl.setSinkId(res.sinkId || '');
  } catch (err) {
    // setSinkId 失败（设备刚拔掉/权限/不支持）→ 退回默认，不让语音直接哑掉
    try { if (res.sinkId) await audioEl.setSinkId(''); } catch {}
    res.sinkApplyError = String(err?.message || err);
  }
  return res;
}

// 对一个 AudioContext 应用 sink。
// 关键：Jarvis TTS 只要 AudioContext 在运行，就会经 createMediaElementSource 走 Web Audio，
// 此时声音从 ctx 的目的地输出，<audio> 元素上的 setSinkId 会被绕过。
// 因此 Web Audio 这条主路径必须把 sink 设在 AudioContext 上（Chromium 110+ 支持 ctx.setSinkId）。
let registeredCtx = null;
export async function applyContextSink(ctx) {
  if (!ctx) return null;
  registeredCtx = ctx; // 记下来，devicechange 时一并重路由
  const res = await resolveSink().catch(() => null);
  if (!res) return null;
  if (typeof ctx.setSinkId !== 'function') { res.ctxUnsupported = true; return res; }
  const want = res.sinkId || '';
  if (ctx.__blmSink === want) return res; // 未变化 → 跳过，避免播放中重复切换造成爆音
  try {
    await ctx.setSinkId(want);
    ctx.__blmSink = want;
  } catch (err) {
    try { if (want) { await ctx.setSinkId(''); ctx.__blmSink = ''; } } catch {}
    res.ctxApplyError = String(err?.message || err);
  }
  return res;
}

// ---- 当前在播元素的回调钩子（由 app.js 注入），用于 devicechange 时把声音切到新设备 ----
let getCurrentAudioEl = () => null;

function reapplyToCurrent() {
  const el = getCurrentAudioEl();
  if (el) applyOutputSink(el).catch(() => {});
  if (registeredCtx) applyContextSink(registeredCtx).catch(() => {}); // Web Audio 主路径
}

// ---- 可视化横幅兜底：仅在"真的可能没声音"时出现，带一键修复 ----
let bannerEl = null;

function ensureBanner() {
  if (bannerEl) return bannerEl;
  const el = document.createElement('div');
  el.id = 'audio-output-banner';
  el.style.cssText = [
    'position:fixed', 'left:50%', 'bottom:18px', 'transform:translateX(-50%)',
    'z-index:99999', 'display:none', 'align-items:center', 'gap:12px',
    'max-width:min(92vw,640px)', 'padding:9px 14px', 'border-radius:10px',
    'background:var(--panel,rgba(20,22,28,.92))', 'color:var(--ink2,#e8e8ea)',
    'border:1px solid var(--warm,#e0a64d)', 'box-shadow:0 6px 24px rgba(0,0,0,.35)',
    'font-size:13px', 'line-height:1.4', 'backdrop-filter:blur(8px)',
  ].join(';');
  el.innerHTML = `
    <span style="flex:0 0 auto;">🔇</span>
    <span id="audio-output-banner-msg" style="flex:1 1 auto;"></span>
    <button id="audio-output-banner-fix" type="button"
      style="flex:0 0 auto;cursor:pointer;border:none;border-radius:6px;padding:4px 12px;
             font-size:12px;background:var(--cool,#4a90d9);color:#fff;">切到这里</button>
    <button id="audio-output-banner-close" type="button" aria-label="忽略"
      style="flex:0 0 auto;cursor:pointer;border:none;background:transparent;color:var(--dim,#9aa);font-size:16px;">×</button>
  `;
  document.body.appendChild(el);
  el.querySelector('#audio-output-banner-close').addEventListener('click', () => {
    try { sessionStorage.setItem(BANNER_DISMISS_KEY, '1'); } catch {}
    hideBanner();
  });
  bannerEl = el;
  return el;
}

function hideBanner() {
  if (bannerEl) bannerEl.style.display = 'none';
}

function showBanner(msg, fixDeviceId, fixLabel) {
  try { if (sessionStorage.getItem(BANNER_DISMISS_KEY) === '1') return; } catch {}
  const el = ensureBanner();
  el.querySelector('#audio-output-banner-msg').textContent = msg;
  const fixBtn = el.querySelector('#audio-output-banner-fix');
  if (fixDeviceId && fixLabel) {
    fixBtn.style.display = '';
    fixBtn.textContent = `切到「${fixLabel}」`;
    fixBtn.onclick = () => {
      setOutputPreference(fixDeviceId); // 钉到这个真实设备
      hideBanner();
    };
  } else {
    fixBtn.style.display = 'none';
  }
  el.style.display = 'flex';
}

// 重新评估输出状态，决定是否需要弹兜底横幅。
export async function refreshOutputStatus() {
  const res = await resolveSink().catch(() => null);
  if (!res) { hideBanner(); return res; }

  if (res.reason === 'no-real-device') {
    showBanner('没有检测到可用的扬声器或耳机，听不到语音。请插入耳机或连接音箱。', null, null);
    return res;
  }
  if (res.reason === 'rerouted-from-virtual') {
    // 已自动改路到真实设备（声音其实有了）→ 不打扰用户，仅控制台留痕
    hideBanner();
    return res;
  }
  if (res.reason === 'pinned-missing-fallback-default') {
    // 用户钉的设备没了，已临时回到系统默认 → 轻提示，可一键改钉
    hideBanner();
    return res;
  }
  hideBanner();
  return res;
}

// 启动：注入"取当前在播元素"的钩子，监听设备插拔，并做一次初始评估。
export function initAudioOutputRouting(opts = {}) {
  if (typeof opts.getCurrentAudioEl === 'function') getCurrentAudioEl = opts.getCurrentAudioEl;

  let debounce = null;
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      try { sessionStorage.removeItem(BANNER_DISMISS_KEY); } catch {} // 设备一变，重新允许提示
      reapplyToCurrent();       // 把正在播的语音切到新解析出的设备（拔耳机即时回到扬声器）
      refreshOutputStatus();    // 重新评估横幅
    }, 250);
  });

  // 暴露给控制台诊断
  try {
    window.__audioOutput = { resolveSink, listOutputDevices, refreshOutputStatus, getOutputPreference };
  } catch {}

  refreshOutputStatus();
}
