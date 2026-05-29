import { API } from './api-client.js';

let overlay = null;
let pollTimer = null;

const STATUS_LABELS = {
  idle:        { text: '○ 未连接',   color: 'var(--dim)' },
  qr_pending:  { text: '◌ 生成二维码中…', color: 'var(--cool)' },
  qr_ready:    { text: '◎ 等待扫码…', color: 'var(--warm)' },
  connected:   { text: '● 已连接',   color: '#4caf82' },
  session_expired: { text: '○ 会话已过期', color: 'var(--warm)' },
  error:       { text: '✕ 连接失败',  color: '#e05555' },
};

function createPopupEl() {
  const el = document.createElement('div');
  el.id = 'wechat-popup-overlay';
  el.className = 'settings-overlay';
  el.setAttribute('hidden', '');
  el.innerHTML = `
    <div class="settings-modal" style="width:340px;height:auto;max-height:calc(100vh - 80px);">
      <div class="settings-header">
        <span class="settings-title">微信 ClawBot</span>
        <button class="settings-close" id="wechat-popup-close" type="button" title="关闭">✕</button>
      </div>
      <div style="padding:18px 20px 20px;display:flex;flex-direction:column;gap:14px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:11px;color:var(--ink2);font-family:'JetBrains Mono',ui-monospace,monospace;letter-spacing:.08em;">状态</span>
          <span id="wechat-popup-status" style="font-size:11px;font-family:'JetBrains Mono',ui-monospace,monospace;color:var(--dim);">○ 未连接</span>
        </div>

        <div id="wechat-popup-qr-wrap" style="display:none;text-align:center;padding:4px 0 2px;">
          <p style="font-size:11px;color:var(--ink2);margin:0 0 10px;">用微信扫描下方二维码：</p>
          <img id="wechat-popup-qr-img" src="" alt="微信二维码"
               style="width:200px;height:200px;border:1px solid var(--line-strong);border-radius:6px;display:block;margin:0 auto;">
          <p id="wechat-popup-qr-hint" style="font-size:11px;color:var(--dim);margin:8px 0 0;">等待扫码…</p>
        </div>

        <p id="wechat-popup-hint" style="font-size:11px;color:var(--dim);margin:0;line-height:1.6;">
          连接后可通过微信向白龙马发送消息，凭证保存在本地，重启后无需重新扫码。
        </p>

        <div style="display:flex;gap:8px;">
          <button id="wechat-popup-connect-btn" class="settings-save-btn"
                  style="flex:1;padding:0 12px;height:32px;font-size:11px;" type="button">
            连接微信
          </button>
          <button id="wechat-popup-logout-btn" class="settings-save-btn"
                  style="flex:1;padding:0 12px;height:32px;font-size:11px;background:color-mix(in srgb,#c0392b 70%,var(--bg1));display:none;" type="button">
            断开连接
          </button>
        </div>
        <span id="wechat-popup-feedback" class="settings-feedback"></span>
      </div>
    </div>
  `;
  return el;
}

function getEls() {
  return {
    statusEl:     document.getElementById('wechat-popup-status'),
    qrWrap:       document.getElementById('wechat-popup-qr-wrap'),
    qrImg:        document.getElementById('wechat-popup-qr-img'),
    qrHint:       document.getElementById('wechat-popup-qr-hint'),
    hintEl:       document.getElementById('wechat-popup-hint'),
    connectBtn:   document.getElementById('wechat-popup-connect-btn'),
    logoutBtn:    document.getElementById('wechat-popup-logout-btn'),
    feedbackEl:   document.getElementById('wechat-popup-feedback'),
  };
}

function setStatus(status, extra = {}) {
  const { statusEl, qrWrap, qrImg, qrHint, hintEl, connectBtn, logoutBtn } = getEls();
  if (!statusEl) return;

  const info = STATUS_LABELS[status] || STATUS_LABELS.idle;
  statusEl.textContent = extra.text || info.text;
  statusEl.style.color = info.color;

  const isConnected = status === 'connected';
  const isQrReady   = status === 'qr_ready';

  qrWrap.style.display = isQrReady ? 'block' : 'none';
  connectBtn.style.display = isConnected ? 'none' : 'inline-flex';
  logoutBtn.style.display  = isConnected ? 'inline-flex' : 'none';
  connectBtn.disabled = status === 'qr_pending' || status === 'qr_ready';

  if (isConnected) {
    hintEl.textContent = '微信已绑定，可以通过个人微信向白龙马发送消息。';
  } else if (status === 'error') {
    hintEl.textContent = extra.error || '连接失败，请重试。';
  } else {
    hintEl.textContent = '连接后可通过微信向白龙马发送消息，凭证保存在本地，重启后无需重新扫码。';
  }

  if (isQrReady && extra.qr_url && qrImg) {
    qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(extra.qr_url)}`;
    if (qrHint) qrHint.textContent = '等待扫码…';
  }
}

function showFeedback(msg, isErr = false) {
  const el = document.getElementById('wechat-popup-feedback');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isErr ? '#e05555' : '#4caf82';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.textContent = ''; }, 3000);
}

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// 返回 true 表示应继续轮询，false 表示已终止（connected / error）
async function pollQR() {
  try {
    const data = await fetch(`${API}/social/wechat-clawbot/qr`).then(r => r.json());
    if (data.status === 'connected') {
      stopPoll();
      setStatus('connected');
      showFeedback('微信绑定成功！');
      return false;
    } else if (data.status === 'error') {
      stopPoll();
      setStatus('error', { error: data.error });
      return false;
    } else if (data.status === 'qr_ready' && data.qr_url) {
      setStatus('qr_ready', { qr_url: data.qr_url });
    } else {
      setStatus(data.status || 'qr_pending');
    }
  } catch {
    // silent
  }
  return true;
}

async function triggerConnect() {
  const { connectBtn } = getEls();
  setStatus('qr_pending');
  if (connectBtn) connectBtn.disabled = true;
  try {
    await fetch(`${API}/settings/social`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _clawbot_connect: '1' }),
    });
  } catch (err) { console.warn('[WechatPopup] 微信连接失败:', err?.message) }
  stopPoll();
  // 先立即轮询一次，等返回后再决定是否启动 interval
  const shouldContinue = await pollQR();
  if (shouldContinue) pollTimer = setInterval(pollQR, 1500);
}

async function triggerLogout() {
  stopPoll();
  const { qrWrap } = getEls();
  if (qrWrap) qrWrap.style.display = 'none';
  try {
    await fetch(`${API}/social/wechat-clawbot/logout`, { method: 'POST' });
    setStatus('idle');
    showFeedback('已断开微信连接');
  } catch {
    showFeedback('请求失败', true);
  }
}

export function initWechatPopup() {
  overlay = createPopupEl();
  document.body.appendChild(overlay);

  document.getElementById('wechat-popup-close').addEventListener('click', hideWechatPopup);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) hideWechatPopup(); });
  document.getElementById('wechat-popup-connect-btn').addEventListener('click', triggerConnect);
  document.getElementById('wechat-popup-logout-btn').addEventListener('click', triggerLogout);

  // sync state from SSE
  window.addEventListener('bailongma:social_status', (e) => {
    const d = e.detail;
    if (d?.platform !== 'wechat-clawbot') return;
    if (d.status === 'connected') {
      stopPoll();
      setStatus('connected');
      if (!overlay.hasAttribute('hidden')) showFeedback('微信绑定成功！');
    } else if (d.status === 'qr_ready' && d.qr_url) {
      setStatus('qr_ready', { qr_url: d.qr_url });
    } else if (d.status === 'session_expired') {
      setStatus('session_expired');
    } else if (d.status === 'error') {
      stopPoll();
      setStatus('error', { error: d.error });
    }
  });
}

export async function showWechatPopup() {
  if (!overlay) return;
  overlay.removeAttribute('hidden');

  // 先查询当前状态，按实际状态渲染
  try {
    const data = await fetch(`${API}/social/wechat-clawbot/qr`).then(r => r.json());
    if (data.status === 'connected') {
      setStatus('connected');
    } else if (data.status === 'qr_ready' && data.qr_url) {
      setStatus('qr_ready', { qr_url: data.qr_url });
      stopPoll();
      pollTimer = setInterval(pollQR, 1500);
    } else if (data.status === 'qr_pending') {
      setStatus('qr_pending');
      stopPoll();
      pollTimer = setInterval(pollQR, 1500);
    } else {
      setStatus('idle');
    }
  } catch {
    setStatus('idle');
  }
}

export function hideWechatPopup() {
  if (!overlay) return;
  overlay.setAttribute('hidden', '');
  stopPoll();
}
