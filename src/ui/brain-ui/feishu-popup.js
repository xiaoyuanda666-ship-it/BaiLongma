import { API } from './api-client.js';

// 飞书长连接配置弹窗。由 connect_feishu 工具经 SSE 事件 show_feishu_popup 触发。
// 与 wechat-popup.js 同构：init 挂载一次，show 时按真实状态渲染，SSE social_status 实时同步。
// 长连接模式只需 App ID + App Secret，无需公网回调地址。

const FEISHU_CONSOLE_URL = 'https://open.feishu.cn/app';

let overlay = null;
let pollTimer = null;
let pollDeadline = 0;

const STATUS_LABELS = {
  idle:         { text: '○ 未连接',   color: 'var(--dim)' },
  connecting:   { text: '◌ 连接中…',  color: 'var(--cool)' },
  reconnecting: { text: '◎ 重连中…',  color: 'var(--warm)' },
  connected:    { text: '● 已连接',   color: '#4caf82' },
  error:        { text: '✕ 连接失败', color: '#e05555' },
};

function createPopupEl() {
  const el = document.createElement('div');
  el.id = 'feishu-popup-overlay';
  el.className = 'settings-overlay';
  el.setAttribute('hidden', '');
  el.innerHTML = `
    <div class="settings-modal" style="width:360px;height:auto;max-height:calc(100vh - 80px);">
      <div class="settings-header">
        <span class="settings-title">飞书 · 长连接</span>
        <button class="settings-close" id="feishu-popup-close" type="button" title="关闭">✕</button>
      </div>
      <div style="padding:16px 20px 20px;display:flex;flex-direction:column;gap:13px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:11px;color:var(--ink2);font-family:'JetBrains Mono',ui-monospace,monospace;letter-spacing:.08em;">状态</span>
          <span id="feishu-popup-status" style="font-size:11px;font-family:'JetBrains Mono',ui-monospace,monospace;color:var(--dim);">○ 未连接</span>
        </div>

        <ol style="margin:0;padding-left:18px;font-size:11px;color:var(--ink2);line-height:1.75;">
          <li>打开飞书开放平台，创建「企业自建应用」</li>
          <li>添加「机器人」能力，权限里加 <code>im:message</code></li>
          <li>「事件订阅」选<strong>使用长连接接收事件</strong>，订阅 <code>im.message.receive_v1</code>（不要开加密推送）</li>
          <li>「凭证与基础信息」里复制 App ID / App Secret 填到下方</li>
        </ol>

        <button id="feishu-popup-open-console" class="settings-save-btn" type="button"
                style="padding:0 12px;height:30px;font-size:11px;background:color-mix(in srgb,var(--cool) 26%,var(--bg1));">
          打开飞书开放平台 ↗
        </button>

        <div id="feishu-popup-form" style="display:flex;flex-direction:column;gap:8px;">
          <input id="feishu-popup-appid" type="text" placeholder="App ID（cli_ 开头）" autocomplete="off" spellcheck="false"
                 style="height:32px;padding:0 10px;font-size:12px;font-family:'JetBrains Mono',ui-monospace,monospace;background:var(--bg1);border:1px solid var(--line-strong);border-radius:6px;color:var(--ink);">
          <input id="feishu-popup-secret" type="password" placeholder="App Secret" autocomplete="off" spellcheck="false"
                 style="height:32px;padding:0 10px;font-size:12px;font-family:'JetBrains Mono',ui-monospace,monospace;background:var(--bg1);border:1px solid var(--line-strong);border-radius:6px;color:var(--ink);">
        </div>

        <p id="feishu-popup-hint" style="font-size:11px;color:var(--dim);margin:0;line-height:1.6;">
          长连接模式无需公网地址；凭据保存在本地，重启后自动连接。
        </p>

        <div style="display:flex;gap:8px;">
          <button id="feishu-popup-connect-btn" class="settings-save-btn"
                  style="flex:1;padding:0 12px;height:32px;font-size:11px;" type="button">
            连接飞书
          </button>
          <button id="feishu-popup-disconnect-btn" class="settings-save-btn"
                  style="flex:1;padding:0 12px;height:32px;font-size:11px;background:color-mix(in srgb,#c0392b 70%,var(--bg1));display:none;" type="button">
            断开连接
          </button>
        </div>
        <span id="feishu-popup-feedback" class="settings-feedback"></span>
      </div>
    </div>
  `;
  return el;
}

function getEls() {
  return {
    statusEl:      document.getElementById('feishu-popup-status'),
    formEl:        document.getElementById('feishu-popup-form'),
    appIdEl:       document.getElementById('feishu-popup-appid'),
    secretEl:      document.getElementById('feishu-popup-secret'),
    hintEl:        document.getElementById('feishu-popup-hint'),
    connectBtn:    document.getElementById('feishu-popup-connect-btn'),
    disconnectBtn: document.getElementById('feishu-popup-disconnect-btn'),
    feedbackEl:    document.getElementById('feishu-popup-feedback'),
  };
}

function setStatus(status, extra = {}) {
  const { statusEl, formEl, hintEl, connectBtn, disconnectBtn } = getEls();
  if (!statusEl) return;

  const info = STATUS_LABELS[status] || STATUS_LABELS.idle;
  statusEl.textContent = info.text;
  statusEl.style.color = info.color;

  const isConnected = status === 'connected';
  const isBusy = status === 'connecting' || status === 'reconnecting';

  formEl.style.display = isConnected ? 'none' : 'flex';
  connectBtn.style.display = isConnected ? 'none' : 'inline-flex';
  disconnectBtn.style.display = isConnected ? 'inline-flex' : 'none';
  connectBtn.disabled = isBusy;
  connectBtn.textContent = isBusy ? '连接中…' : '连接飞书';

  if (isConnected) {
    hintEl.textContent = '飞书已连接，可以通过飞书向Jarvis发送消息。';
  } else if (status === 'error') {
    hintEl.textContent = extra.error ? `连接失败：${extra.error}` : '连接失败，请检查 App ID / Secret 后重试。';
  } else {
    hintEl.textContent = '长连接模式无需公网地址；凭据保存在本地，重启后自动连接。';
  }
}

function showFeedback(msg, isErr = false) {
  const el = document.getElementById('feishu-popup-feedback');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isErr ? '#e05555' : '#4caf82';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.textContent = ''; }, 3000);
}

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// 轮询后端真实状态。返回 true=继续轮询，false=已终止（connected / error / 超时）。
// SSE social_status 也会并行推状态，两条路径都会收敛到同一终态。
async function pollStatus() {
  try {
    const data = await fetch(`${API}/social/feishu/status`).then(r => r.json());
    if (data.status === 'connected') {
      stopPoll();
      setStatus('connected');
      showFeedback('飞书连接成功！');
      return false;
    }
    if (data.status === 'error') {
      stopPoll();
      setStatus('error', { error: data.error });
      return false;
    }
    setStatus(data.status || 'connecting');
  } catch { /* silent，下一拍重试 */ }
  if (Date.now() > pollDeadline) {
    stopPoll();
    showFeedback('连接握手较慢，请稍候或检查网络', true);
    return false;
  }
  return true;
}

async function triggerConnect() {
  const { appIdEl, secretEl } = getEls();
  const appId = (appIdEl?.value || '').trim();
  const appSecret = (secretEl?.value || '').trim();
  if (!appId || !appSecret) {
    showFeedback('请填写 App ID 和 App Secret', true);
    return;
  }
  setStatus('connecting');
  try {
    await fetch(`${API}/settings/social`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ FEISHU_APP_ID: appId, FEISHU_APP_SECRET: appSecret }),
    });
  } catch {
    setStatus('error', { error: '保存请求失败' });
    return;
  }
  stopPoll();
  pollDeadline = Date.now() + 15000;
  if (await pollStatus()) pollTimer = setInterval(pollStatus, 1500);
}

async function triggerDisconnect() {
  stopPoll();
  try {
    await fetch(`${API}/settings/social`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ FEISHU_APP_ID: '', FEISHU_APP_SECRET: '', _feishu_disconnect: '1' }),
    });
    setStatus('idle');
    const { appIdEl, secretEl } = getEls();
    if (appIdEl) appIdEl.value = '';
    if (secretEl) secretEl.value = '';
    showFeedback('已断开飞书连接');
  } catch {
    showFeedback('请求失败', true);
  }
}

export function initFeishuPopup() {
  overlay = createPopupEl();
  document.body.appendChild(overlay);

  document.getElementById('feishu-popup-close').addEventListener('click', hideFeishuPopup);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) hideFeishuPopup(); });
  document.getElementById('feishu-popup-connect-btn').addEventListener('click', triggerConnect);
  document.getElementById('feishu-popup-disconnect-btn').addEventListener('click', triggerDisconnect);
  document.getElementById('feishu-popup-open-console').addEventListener('click', () => {
    // Electron 主进程 setWindowOpenHandler 把 http(s) 转交系统浏览器
    window.open(FEISHU_CONSOLE_URL, '_blank');
  });

  // SSE 实时同步
  window.addEventListener('jarvis:social_status', (e) => {
    const d = e.detail;
    if (d?.platform !== 'feishu') return;
    if (d.status === 'connected') {
      stopPoll();
      setStatus('connected');
      if (!overlay.hasAttribute('hidden')) showFeedback('飞书连接成功！');
    } else if (d.status === 'error') {
      stopPoll();
      setStatus('error', { error: d.error });
    } else if (d.status === 'reconnecting') {
      setStatus('reconnecting');
    } else if (d.status === 'connecting') {
      setStatus('connecting');
    } else if (d.status === 'idle') {
      setStatus('idle');
    }
  });
}

export async function showFeishuPopup() {
  if (!overlay) return;
  overlay.removeAttribute('hidden');
  try {
    const data = await fetch(`${API}/social/feishu/status`).then(r => r.json());
    setStatus(data.status || 'idle');
    if ((data.status === 'connecting' || data.status === 'reconnecting')) {
      stopPoll();
      pollDeadline = Date.now() + 15000;
      pollTimer = setInterval(pollStatus, 1500);
    }
  } catch {
    setStatus('idle');
  }
}

export function hideFeishuPopup() {
  if (!overlay) return;
  overlay.setAttribute('hidden', '');
  stopPoll();
}
