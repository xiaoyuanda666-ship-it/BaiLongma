import { API } from './api-client.js';
// Status only. No webpage pixels, DOM mirroring or input forwarding.
const panel = document.createElement('details');
panel.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:1200;background:var(--bg,#20252b);color:var(--text,#eee);padding:12px;border:1px solid #777;border-radius:8px;max-width:430px;max-height:65vh;overflow:auto';
const title = document.createElement('summary');
title.textContent = 'Chrome 浏览器任务';
title.setAttribute('role','button');
title.tabIndex = 0;
panel.append(title);
const content = document.createElement('div');
panel.append(content);
export function initBrowserTasks() { document.body.append(panel); }
async function request(route, body) {
  const response = await fetch(`${API}/browser-backend/${route}`, body ? { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) } : {});
  const value = await response.json();
  if (!response.ok || value.ok === false) throw new Error(value.error || '连接失败');
  return value;
}
function text(value) { const p = document.createElement('p'); p.textContent = value; content.append(p); }
function button(label, action) {
  const b = document.createElement('button'); b.textContent = label; b.style.margin = '4px';
  b.onclick = async () => { b.disabled = true; try { await action(); await refresh(); } catch(e) { await refresh(); text(e.message); } finally { b.disabled = false; } };
  content.append(b);
  return b;
}
async function refresh() {
  content.replaceChildren();
  try {
    const data = await request('status');
    const state = data.browserskill;
    text(`连接状态：${state.state || state.code || '未连接'} · CLI ${state.cli_version || '未知'} · daemon ${state.daemon_version || '未知'}`);
    if (state.hint || state.error) text(state.error || state.hint);
    const guide = document.createElement('a'); guide.href = state.guide; guide.textContent = 'BrowserSkill 安装与扩展连接指南'; guide.target = '_blank'; guide.rel = 'noreferrer'; content.append(guide);
    text('网页、登录和验证码均在真实 Chrome 操作。请先接管并等待操作结束，再手动操作；恢复后请发送继续任务的消息。');
    const binary = document.createElement('input'); binary.placeholder = 'bsk CLI 绝对路径'; binary.value = state.binary || ''; binary.setAttribute('aria-label','bsk CLI 路径'); binary.style.width = '95%'; content.append(binary);
    const select = document.createElement('select'); select.setAttribute('aria-label','Chrome 配置实例');
    const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '请选择 Chrome 实例（在扩展弹窗核对 ID）'; select.append(placeholder);
    for (const b of state.browsers || []) { const o=document.createElement('option'); o.value=b.instance_id; o.textContent=`${b.label || 'Chrome'} · ${b.instance_id} · 扩展 ${b.extension_version}`; select.append(o); }
    select.value = state.selected_browser || ''; content.append(select);
    if (data.environment_override) text('配置由启动环境变量锁定。');
    else button('保存配置', () => request('settings',{binary:binary.value, browser:select.value})).disabled = !!data.tasks?.length;
    binary.disabled = select.disabled = !!data.environment_override || !!data.tasks?.length;
    for (const task of data.tasks || []) {
      text(`${task.session_id || '启动中'} · ${task.browser} · ${task.state}${task.pending ? '（已有操作执行中）' : ''}`);
      if (task.pause_message) text(task.pause_message);
      if (!task.session_id) continue;
      const actions = task.state === 'user_control' ? [['恢复 Agent','resume']] : task.state === 'waiting_for_idle' ? [['确认操作已结束','settle']] : task.state === 'closing' ? [] : [['接管 / 取消任务','takeover']];
      actions.push(['关闭此会话页面','close']);
      for (const [label, action] of actions) button(label, () => request('task',{session_id:task.session_id, action}));
    }
    if (!data.tasks?.length) text('当前没有白龙马浏览器会话。');
  } catch (error) { text(error.message); }
  button('刷新状态', async () => {});
}
panel.addEventListener('toggle', () => { if (panel.open) void refresh(); });
