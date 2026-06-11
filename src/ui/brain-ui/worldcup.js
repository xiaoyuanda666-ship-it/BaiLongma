// 世界杯模式控制 — 开关 iframe 大屏、与其他全屏模式互斥、状态上报。
// 赛况内容本体在 worldcup-broadcast-v2.html（自带 /worldcup 取数、自动刷新、1080p 缩放），
// 这里不做任何数据渲染。

import { apiUrl } from './api-client.js';
import { setHotspotMode, moveVoicePanel, restoreVoicePanel } from './hotspot.js';

const FRAME_SRC = apiUrl('/src/ui/brain-ui/worldcup-broadcast-v2.html');

const $ = (id) => document.getElementById(id);
let worldcupActive = false;
let closeTimer = null;

// ── 悬浮聊天窗折叠：非悬停且未聚焦时收成语音球小坞，不挡大屏右下角 ─────────────

const COLLAPSE_DELAY_MS = 1600;   // 鼠标离开/失焦后缓一拍再折叠，防擦边误触
const OPEN_GRACE_MS = 3000;       // 刚进世界杯模式先完整亮相一会
const MESSAGE_PEEK_MS = 6000;     // 新消息先展开给用户看，看完自动收

let collapseTimer = null;

function consoleEngaged() {
  const el = $('chat-area');
  if (!el) return false;
  return el.matches(':hover') || el.contains(document.activeElement);
}

function expandConsole() {
  if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
  $('chat-area')?.classList.remove('wc-collapsed');
}

function scheduleConsoleCollapse(delay = COLLAPSE_DELAY_MS) {
  if (!worldcupActive) return;
  if (collapseTimer) clearTimeout(collapseTimer);
  collapseTimer = setTimeout(() => {
    collapseTimer = null;
    if (!worldcupActive || consoleEngaged()) return;
    $('chat-area')?.classList.add('wc-collapsed');
  }, delay);
}

function initConsoleCollapse() {
  const area = $('chat-area');
  if (!area) return;
  area.addEventListener('mouseenter', () => { if (worldcupActive) expandConsole(); });
  area.addEventListener('mouseleave', () => scheduleConsoleCollapse());
  area.addEventListener('focusin', () => { if (worldcupActive) expandConsole(); });
  area.addEventListener('focusout', () => scheduleConsoleCollapse());
  // 新消息（含流式逐字）到达 → 展开亮一会再收；engaged 时 schedule 自己会放弃折叠
  const messages = $('chat-messages');
  if (messages) {
    new MutationObserver(() => {
      if (!worldcupActive) return;
      expandConsole();
      scheduleConsoleCollapse(MESSAGE_PEEK_MS);
    }).observe(messages, { childList: true, subtree: true, characterData: true });
  }
  // 按住空格说话（PTT 在输入框外触发）→ 展开看实时识别文字
  document.addEventListener('keydown', (e) => {
    if (!worldcupActive || e.code !== 'Space') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    expandConsole();
    scheduleConsoleCollapse(MESSAGE_PEEK_MS);
  });
}

// 退场动画时长：iframe 内 wcb-glitch-out 420ms + 最大错峰 300ms，面板淡出与尾段重叠
const EXIT_ANIMATION_MS = 680;

function reportWorldcupState(visible, source = 'brain-ui') {
  fetch(apiUrl('/worldcup-state'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active: !!visible, source }),
  }).catch(() => {});
}

export function setWorldcupMode(visible, { source = 'brain-ui' } = {}) {
  const nextVisible = !!visible;
  if (worldcupActive === nextVisible) {
    reportWorldcupState(nextVisible, source);
    return;
  }
  worldcupActive = nextVisible;

  const frame = $('worldcup-frame');
  if (nextVisible) {
    // 取消可能还在等退场动画的卸载（快速关了又开）
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    // 与其他全屏模式互斥
    setHotspotMode(false, { source: 'worldcup_open' });
    for (const mode of ['video-mode', 'image-mode', 'music-mode']) {
      document.body.classList.remove(mode);
    }
    if (frame) frame.src = FRAME_SRC;   // 重新加载即重播出场动画
    // 语音球+识别文字并入右下角悬浮聊天窗顶部一行（CSS 见 body.worldcup-mode .console）
    moveVoicePanel(document.getElementById('chat-area'), { prepend: true });
    document.body.classList.add('worldcup-mode');
    scheduleConsoleCollapse(OPEN_GRACE_MS); // 亮相后自动折叠，悬停/聚焦时展开
  } else {
    expandConsole(); // 退出世界杯模式时把折叠态摘干净，不影响正常布局
    // 语音球同步归位：若是热点模式抢开触发的关闭，hotspot 紧接着要把它搬到 body，
    // 留到 finishClose 延迟归位会把它从热点模式手里拽回左栏（交接 bug）。
    // 只在球还在自己手里（chat-area）时归位——已被视频等其他模式接管时不抢
    const vp = document.getElementById('voice-panel');
    if (vp && vp.parentElement === document.getElementById('chat-area')) restoreVoicePanel();
    // 先让 iframe 播退场动画，再淡出面板并卸载页面
    // （卸载停掉 iframe 内的轮询，避免 viewed 状态被无限续期）
    const frameLoaded = !!(frame && frame.src && !frame.src.includes('about:blank'));
    if (frameLoaded) {
      try { frame.contentWindow?.postMessage({ type: 'worldcup-exit' }, '*'); } catch {}
    }
    const finishClose = () => {
      closeTimer = null;
      if (frame) frame.src = 'about:blank';
      document.body.classList.remove('worldcup-mode');
    };
    if (frameLoaded) closeTimer = setTimeout(finishClose, EXIT_ANIMATION_MS);
    else finishClose();
  }

  window.dispatchEvent(new CustomEvent('bailongma:worldcup-mode', {
    detail: { active: nextVisible },
  }));
  reportWorldcupState(nextVisible, source);
}

export function toggleWorldcup(source = 'brain-ui') {
  setWorldcupMode(!worldcupActive, { source });
}

export async function initWorldcup() {
  const exitBtn = $('wc-exit-btn');
  if (exitBtn) exitBtn.addEventListener('click', () => toggleWorldcup());
  initConsoleCollapse();

  // 热点面板打开时让位（事件解耦，避免 hotspot.js 反向 import 形成循环）
  window.addEventListener('bailongma:hotspot-mode', (event) => {
    if (event?.detail?.active && worldcupActive) setWorldcupMode(false, { source: 'hotspot_open' });
  });

  // 大屏 iframe 持有键盘焦点时空格到不了本窗口，由 iframe 转发 PTT
  // （worldcup-broadcast-v2.html 发 worldcup-ptt；与 app.js 的全局空格监听互斥——
  //   键盘事件只会落在其中一个 document，不会双触发）
  window.addEventListener('message', (event) => {
    if (event?.data?.type !== 'worldcup-ptt' || !worldcupActive) return;
    const { phase } = event.data;
    if (phase === 'down') {
      try { window.stopTTS?.(); } catch {}   // 与 app.js PTT 同语义：按下即打断播报
      window.bailongmaVoice?.pttStart?.();
      expandConsole();                        // 说话时展开看实时识别文字
    } else if (phase === 'up') {
      window.bailongmaVoice?.pttEnd?.();
      scheduleConsoleCollapse(MESSAGE_PEEK_MS);
    } else if (phase === 'cancel') {
      window.bailongmaVoice?.pttEnd?.({ send: false });
      scheduleConsoleCollapse();
    }
  });
}
