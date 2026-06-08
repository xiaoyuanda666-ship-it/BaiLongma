/**
 * 热点面板 & 知识库面板
 * Ctrl+Shift+H → 热点面板（多平台热搜）
 * Ctrl+Shift+W → 知识库面板（Wiki检索）
 */

const HOTSPOT_TTL_MS = 60 * 60 * 1000; // 60分钟缓存

let hotspotCtx = null;
let wikiCtx    = null;

// ── 热点面板 ──────────────────────────────────────────────────────

function openHotspotPanel() {
  closeAllPanels();
  const panel = document.getElementById('hotspot-panel');
  if (panel) { panel.classList.add('active'); return; }

  const html = createHotspotPanel();
  document.body.insertAdjacentHTML('beforeend', html);
  loadHotspotData();
}

function closeHotspotPanel() {
  const panel = document.getElementById('hotspot-panel');
  if (panel) panel.remove();
}

function toggleHotspotPanel() {
  const panel = document.getElementById('hotspot-panel');
  if (panel && panel.classList.contains('active')) {
    panel.classList.remove('active');
  } else {
    openHotspotPanel();
  }
}

// ── 知识库面板 ────────────────────────────────────────────────────

function openWikiPanel() {
  document.body.classList.remove('hotspot-mode');
  const existing = document.getElementById('wiki-panel');
  if (existing) {
    existing.classList.add('active');
    document.body.classList.add('wiki-panel-mode');
    initWikiPanel();
    return;
  }

  const html = createWikiPanel();
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('wiki-panel')?.classList.add('active');
  document.body.classList.add('wiki-panel-mode');
  initWikiPanel();
}

function closeWikiPanel() {
  const panel = document.getElementById('wiki-panel');
  if (panel) panel.remove();
  document.body.classList.remove('wiki-panel-mode');
  if (wikiClockTimer) clearInterval(wikiClockTimer);
  wikiClockTimer = null;
}

function toggleWikiPanel() {
  const panel = document.getElementById('wiki-panel');
  if (panel && panel.classList.contains('active')) {
    closeWikiPanel();
  } else {
    openWikiPanel();
  }
}

function closeAllPanels() {
  closeHotspotPanel();
  closeWikiPanel();
}

// ── 热点数据加载 ──────────────────────────────────────────────────

async function loadHotspotData() {
  const container = document.getElementById('hs-platforms');
  if (!container) return;

  // 缓存命中
  if (hotspotCtx) {
    renderHotspotData(hotspotCtx);
    return;
  }

  container.innerHTML = '<div class="hs-loading">加载中...</div>';

  try {
    const [weibo, douyin, xhs, wechat] = await Promise.allSettled([
      fetchHotspot('weibo'),
      fetchHotspot('douyin'),
      fetchHotspot('xiaohongshu'),
      fetchHotspot('wechat'),
    ]).then(results => results.map(r => r.value));

    hotspotCtx = { weibo, douyin, xhs, wechat, ts: Date.now() };
    renderHotspotData(hotspotCtx);
  } catch (e) {
    container.innerHTML = `<div class="hs-error">加载失败: ${e.message}</div>`;
  }
}

async function fetchHotspot(platform) {
  const apis = {
    weibo:        'https://api.vv后天.com/weibo/top',
    douyin:       'https://api.vv后天.com/douyin/top',
    xiaohongshu:  'https://api.vv后天.com/xiaohongshu/top',
    wechat:       'https://api.vv后天.com/wechat/top',
  };
  const url = apis[platform];
  if (!url) return [];

  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();

  const map = {
    weibo:        () => (json.data || json.list || []).slice(0, 10).map(i => ({ title: i.word || i.title, hot: i.hot || i.count })),
    douyin:       () => (json.data || json.list || []).slice(0, 10).map(i => ({ title: i.word || i.title, hot: i.hot_value || i.count })),
    xiaohongshu:  () => (json.data || json.list || []).slice(0, 10).map(i => ({ title: i.word || i.title, hot: i.liked_count || i.count })),
    wechat:       () => (json.data || json.list || []).slice(0, 10).map(i => ({ title: i.word || i.title, hot: i.read_count || i.count })),
  };
  return (map[platform] || (() => []))();
}

function renderHotspotData(ctx) {
  const container = document.getElementById('hs-platforms');
  if (!container) return;

  const platforms = [
    { key: 'weibo',       label: '微博',       icon: '📨' },
    { key: 'douyin',      label: '抖音',       icon: '🎵' },
    { key: 'xiaohongshu', label: '小红书',     icon: '📕' },
    { key: 'wechat',      label: '微信',       icon: '💬' },
  ];

  container.innerHTML = platforms.map(p => {
    const items = ctx[p.key] || [];
    const list  = items.map((i, idx) =>
      `<li><span class="hs-rank">${idx + 1}</span><span class="hs-title">${escHtml(i.title)}</span><span class="hs-hot">${fmtHot(i.hot)}</span></li>`
    ).join('');
    return `
      <div class="hs-platform">
        <div class="hs-plat-header">${p.icon} ${p.label}</div>
        <ol class="hs-list">${list || '<li class="hs-empty">暂无数据</li>'}</ol>
      </div>`;
  }).join('');
}

function fmtHot(v) {
  if (!v && v !== 0) return '';
  v = Number(v);
  if (v >= 100000000) return (v / 100000000).toFixed(1) + '亿';
  if (v >= 10000)     return (v / 10000).toFixed(1) + '万';
  return v;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

// ── 知识库面板初始化 ─────────────────────────────────────────────

let wikiClockTimer = null;

function initWikiSeedGraph() {
  const panel = document.getElementById('wiki-panel');
  const detail = document.getElementById('wiki-seed-detail');
  if (!panel || !detail) return;

  const focusNode = (node) => {
    const id = node.dataset.seedId;
    const label = node.dataset.seedLabel || node.textContent || id;
    const group = node.dataset.seedGroup || 'seed';
    const related = (node.dataset.seedRelated || '').split(',').filter(Boolean);
    const relatedSet = new Set([id, ...related]);

    panel.querySelectorAll('.wiki-node').forEach((el) => {
      const nodeId = el.dataset.seedId;
      el.classList.toggle('wiki-node-active', nodeId === id);
      el.classList.toggle('wiki-node-related', nodeId !== id && relatedSet.has(nodeId));
      el.classList.toggle('wiki-node-dimmed', !relatedSet.has(nodeId));
    });

    panel.querySelectorAll('.wiki-graph-lines line').forEach((line) => {
      const source = line.dataset.source;
      const target = line.dataset.target;
      const connected = source === id || target === id;
      line.classList.toggle('wiki-graph-line-active', connected);
      line.classList.toggle('wiki-graph-line-dimmed', !connected);
    });

    detail.innerHTML = `
      <div class="wiki-seed-detail-kicker">${escHtml(group)} · ${escHtml(id)}</div>
      <div class="wiki-seed-detail-title">${escHtml(label)}</div>
      <div class="wiki-seed-detail-body">${escHtml(SEED_GRAPH_DETAILS[id] || '该节点来自种子记忆，点击相邻节点继续查看演进路径。')}</div>
      <div class="wiki-seed-detail-links">${related.length ? related.map(item => `<span>${escHtml(item)}</span>`).join('') : '<span>root</span>'}</div>`;
  };

  panel.querySelectorAll('.wiki-node').forEach((node) => {
    node.addEventListener('click', () => focusNode(node));
  });

  const initial = panel.querySelector('.wiki-node[data-seed-id="system_architecture"]');
  if (initial) focusNode(initial);
}

function initWikiPanel() {
  const exitBtn = document.getElementById('wiki-exit-btn');
  if (exitBtn) exitBtn.addEventListener('click', closeWikiPanel, { once: true });
  initWikiSeedGraph();
  loadWikiStats();

  const updateClock = () => {
    const el = document.getElementById('wiki-clock');
    if (!el) return;
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    el.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  };

  updateClock();
  if (wikiClockTimer) clearInterval(wikiClockTimer);
  wikiClockTimer = setInterval(updateClock, 1000);
}

async function loadWikiStats() {
  try {
    const res = await fetch('/wiki-stats');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const stats = await res.json();
    renderWikiStats(stats);
  } catch {
    renderWikiStats({ ok: false, totalFiles: 0, updatedToday: 0, updated7d: 0, directories: [], recent: [] });
  }
}

function formatWikiDate(iso) {
  if (!iso) return '暂无更新';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '暂无更新';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderWikiStats(stats = {}) {
  const total = Number(stats.totalFiles || 0);
  const today = Number(stats.updatedToday || 0);
  const updated7d = Number(stats.updated7d || 0);
  const dirs = Array.isArray(stats.directories) ? stats.directories : [];
  const recent = Array.isArray(stats.recent) ? stats.recent : [];

  const setText = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  setText('wiki-total-count', String(total));
  setText('wiki-stat-concepts', String(dirs.find(d => d.name === 'concepts')?.count ?? total));
  setText('wiki-stat-life', String(dirs.find(d => d.name === 'life')?.count ?? updated7d));
  setText('wiki-stat-articles', String(dirs.find(d => d.name === 'articles')?.count ?? recent.length));
  setText('wiki-stat-other', String(Math.max(0, dirs.length - 3)));
  setText('wiki-concepts-update', `${dirs.find(d => d.name === 'concepts')?.count ?? 0}篇`);
  setText('wiki-life-update', `${dirs.find(d => d.name === 'life')?.count ?? 0}条`);
  setText('wiki-articles-update', `${recent.length}条`);
  setText('wiki-other-update', `${dirs.length}类`);
  setText('wiki-stat-concepts-delta', `总文件 ${total} · 7日更新 ${updated7d}`);
  setText('wiki-stat-life-delta', `今日更新 ${today}`);
  setText('wiki-stat-articles-delta', `最近 ${recent.length} 条`);
  setText('wiki-stat-other-delta', `目录 ${dirs.length} 个`);
  setText('wiki-recent-num', String(today));
  setText('wiki-recent-delta', `7日 ${updated7d} · 最新 ${formatWikiDate(stats.latestAt)}`);

  const rootEl = document.querySelector('#wiki-panel .hs-feed-desc');
  if (rootEl && stats.root) rootEl.textContent = `${stats.root} · ${total} files`;

  const distList = document.getElementById('wiki-dist-list');
  if (distList) {
    const max = Math.max(1, ...dirs.map(d => Number(d.count || 0)));
    distList.innerHTML = (dirs.length ? dirs : [{ name: 'empty', count: 0 }]).slice(0, 4).map(d => {
      const count = Number(d.count || 0);
      const pct = Math.max(4, Math.round((count / max) * 100));
      return `<div class="hs-region-row"><span class="hs-region-name">${escHtml(d.name)}/</span><div class="hs-bar-track"><div class="hs-bar-fill" style="width:${pct}%"></div></div><span class="hs-region-pct">${count}</span></div>`;
    }).join('');
  }

  const track = document.getElementById('wiki-feed-track');
  if (track) {
    track.innerHTML = (recent.length ? recent : [{ path: '暂无最新更新', updatedAt: null }]).slice(0, 8).map(file =>
      `<span class="hs-feed-item"><span class="wiki-update-path">${escHtml(file.path || file.name || 'untitled')}</span><span class="wiki-update-time">${escHtml(formatWikiDate(file.updatedAt))}</span></span>`
    ).join('');
  }

  const latestList = document.getElementById('wiki-articles-list');
  if (latestList) {
    latestList.innerHTML = (recent.length ? recent : [{ path: '暂无最新更新', dir: 'wiki', updatedAt: null }]).slice(0, 6).map(file =>
      `<li class="hs-list-item hs-list-item--wiki-update"><span class="wiki-list-file">${escHtml(file.path || file.name || 'untitled')}</span><span class="wiki-list-time">${escHtml(formatWikiDate(file.updatedAt))}</span></li>`
    ).join('');
  }
}

function doWikiSearch() {
  const q = document.getElementById('wiki-search')?.value?.trim();
  const out = document.getElementById('wiki-results');
  if (!q || !out) return;

  out.innerHTML = '<div class="wiki-loading">🔍 搜索中...</div>';

  // 模拟异步搜索
  setTimeout(() => {
    const hits = searchWiki(q);
    if (!hits.length) {
      out.innerHTML = '<div class="wiki-empty">没有找到相关内容，可以试试其他关键词。</div>';
      return;
    }
    out.innerHTML = '<ul class="wiki-hits">' + hits.map(h =>
      `<li class="wiki-hit"><div class="wiki-hit-title">${escHtml(h.title)}</div><div class="wiki-hit-excerpt">${escHtml(h.excerpt)}</div></li>`
    ).join('') + '</ul>';
  }, 200);
}

function searchWiki(q) {
  // 模拟 wiki 全文搜索
  const corpus = [
    { title: 'Agent 执行循环', excerpt: '感知→规划→执行→反馈的闭环架构...' },
    { title: 'Skill 双触发机制', excerpt: '用户触发+系统触发，结构化生成新技能...' },
    { title: '五层记忆系统', excerpt: '感觉记忆→工作记忆→情节记忆→语义记忆→长期记忆...' },
    { title: 'MCP 协议', excerpt: 'Model Context Protocol，模型上下文协议...' },
    { title: '多智能体协作', excerpt: '子 Agent 委托、状态共享、冲突仲裁...' },
    { title: '自我进化训练', excerpt: 'RL闭环反馈、reward shaping、自动错误修正...' },
  ];
  q = q.toLowerCase();
  return corpus.filter(c => c.title.includes(q) || c.excerpt.includes(q));
}

// ── 面板 HTML 模板 ───────────────────────────────────────────────

export function createHotspotPanel() {
  return `
<div class="hotspot-panel" id="hotspot-panel" aria-label="热点模式面板">
  <header class="hs-header">
    <div class="hs-brand">
      <span class="hs-brand-name">HOTSPOT RADAR</span>
      <span class="hs-brand-dot">●</span>
      <span class="hs-brand-status">LIVE</span>
    </div>
    <div class="hs-title-block">
      <div class="hs-title-en">GLOBAL ATTENTION SURFACE</div>
      <div class="hs-title-zh">多平台实时热点态势</div>
    </div>
    <div class="hs-header-right">
      <div class="hs-header-meta">
        <div class="hs-header-tag"><span class="hs-tag-icon">SRC</span><br><span class="hs-tag-status">API</span></div>
        <div class="hs-header-tag"><span class="hs-tag-icon">TTL</span><br><span class="hs-tag-status">30M</span></div>
      </div>
      <div class="hs-clock-block">
        <div class="hs-clock" id="hs-clock">--:--:--</div>
        <div class="hs-live-dot">● LIVE</div>
      </div>
      <button class="hs-exit-btn" id="hs-exit-btn" type="button" title="退出热点模式">×</button>
    </div>
  </header>

  <section class="hs-stats-bar">
    <div class="hs-stat hs-stat--warn">
      <div class="hs-stat-icon">!</div>
      <div class="hs-stat-body"><div class="hs-stat-label">风险</div><div class="hs-stat-value">3</div><div class="hs-stat-delta hs-delta-up">+12%</div></div>
    </div>
    <div class="hs-stat hs-stat--hot">
      <div class="hs-stat-icon">#</div>
      <div class="hs-stat-body"><div class="hs-stat-label">热度</div><div class="hs-stat-value">87</div><div class="hs-stat-delta hs-delta-up">趋势上升</div></div>
    </div>
    <div class="hs-stat hs-stat--data">
      <div class="hs-stat-icon">∑</div>
      <div class="hs-stat-body"><div class="hs-stat-label">数据</div><div class="hs-stat-value" id="hs-stat-data">0</div><div class="hs-stat-delta" id="hs-stat-data-delta">四平台热榜</div></div>
    </div>
    <div class="hs-stat hs-stat--ai">
      <div class="hs-stat-icon">AI</div>
      <div class="hs-stat-body"><div class="hs-stat-label">Agent</div><div class="hs-stat-value">ON</div><div class="hs-stat-delta">上下文注入</div></div>
    </div>
  </section>

  <main class="hs-body">
    <section class="hs-col hs-col-left">
      ${createPlatformCard('hs-douyin-card', 'douyin', '抖音', '短视频热榜', 'hs-douyin-list', 'hs-douyin-update')}
      ${createPlatformCard('hs-xhs-card', 'xhs', '小红书', '生活方式热榜', 'hs-xhs-list', 'hs-xhs-update')}
    </section>

    <section class="hs-col hs-col-center">
      <div class="hs-earth-container">
        <canvas id="hs-earth-canvas"></canvas>
        <div class="hs-earth-label">ATTENTION GLOBE</div>
        <div class="hs-earth-hint">拖拽旋转 · 滚轮缩放</div>
      </div>
      <div class="hs-center-aux">
        <div class="hs-aux-box">
          <div class="hs-aux-title">区域关注 <span class="hs-aux-sub">REGION</span></div>
          <div class="hs-region-list">
            ${createRegionRow('华东', 72)}
            ${createRegionRow('华北', 58)}
            ${createRegionRow('华南', 44)}
            ${createRegionRow('西南', 31)}
          </div>
        </div>
        <div class="hs-aux-box">
          <div class="hs-aux-title">舆情情绪 <span class="hs-aux-sub">SENTIMENT</span></div>
          <div class="hs-sentiment">
            <div class="hs-sentiment-ring">
              <svg class="hs-ring-svg" viewBox="0 0 80 80" aria-hidden="true">
                <circle cx="40" cy="40" r="32" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="7" />
                <circle cx="40" cy="40" r="32" fill="none" stroke="var(--cool)" stroke-width="7" stroke-linecap="round" stroke-dasharray="142 201" transform="rotate(-90 40 40)" />
              </svg>
              <div class="hs-ring-label"><div class="hs-ring-num">71</div><div class="hs-ring-text">neutral+</div></div>
            </div>
            <div class="hs-sentiment-delta">+4.8 / 24h</div>
          </div>
        </div>
      </div>
    </section>

    <section class="hs-col hs-col-right">
      ${createPlatformCard('hs-wechat-card', 'wechat', '微信热点', '公众号热议', 'hs-wechat-list', 'hs-wechat-update')}
      ${createPlatformCard('hs-weibo-card', 'weibo', '微博', '实时热搜', 'hs-weibo-list', 'hs-weibo-update')}
    </section>
  </main>

  <section class="hs-feed-bar">
    <div class="hs-feed-label">
      <span class="hs-feed-live-dot">●</span>
      <span>EVENTS</span>
      <span class="hs-feed-subtitle">实时事件流</span>
      <span class="hs-feed-desc">自动轮播重点事件</span>
    </div>
    <div class="hs-feed-viewport" id="hs-feed-viewport"><div class="hs-feed-track" id="hs-feed-track"></div></div>
    <div class="hs-feed-controls">
      <button class="hs-feed-nav" id="hs-feed-prev" type="button" title="上一条">‹</button>
      <div class="hs-feed-auto-label">AUTO</div>
      <button class="hs-feed-nav" id="hs-feed-next" type="button" title="下一条">›</button>
    </div>
  </section>

  <footer class="hs-ticker-bar"><div class="hs-ticker-inner" id="hs-ticker-inner"></div></footer>
</div>`;
}

function createPlatformCard(id, dot, name, badge, listId, updateId) {
  return `
    <article class="hs-list-card" id="${id}">
      <div class="hs-card-header">
        <span class="hs-platform-dot hs-dot-${dot}"></span>
        <span class="hs-platform-name">${name}</span>
        <span class="hs-card-badge">${badge}</span>
        <span class="hs-card-update" id="${updateId}">加载中</span>
      </div>
      <ol class="hs-list" id="${listId}"></ol>
    </article>`;
}

function createRegionRow(name, pct) {
  return `<div class="hs-region-row"><span class="hs-region-name">${name}</span><span class="hs-bar-track"><span class="hs-bar-fill" style="width:${pct}%"></span></span><span class="hs-region-pct">${pct}%</span></div>`;
}

const SEED_GRAPH_NODES = [
  ['system_architecture', '系统核心架构', 50, 15, 1.10, 'core'],
  ['tick', 'TICK', 31, 25, .82, 'system'],
  ['recognizer', '识别器', 50, 29, .82, 'system'],
  ['injector', '注入器', 69, 25, .82, 'system'],
  ['tools_system', '工具系统', 50, 49, 1.02, 'core'],
  ['tool_send_message', 'send_message', 24, 46, .66, 'tool'],
  ['tool_fetch_url', 'fetch_url', 36, 58, .66, 'tool'],
  ['tool_write_read_file', 'file IO', 50, 62, .66, 'tool'],
  ['tool_exec_command', 'exec', 64, 58, .66, 'tool'],
  ['tool_search_memory', 'search_memory', 76, 46, .66, 'tool'],
  ['tool_list_dir', 'list_dir', 20, 61, .55, 'tool'],
  ['tool_delete_file', 'delete_file', 30, 70, .55, 'tool'],
  ['tool_make_dir', 'make_dir', 42, 74, .55, 'tool'],
  ['tool_kill_process', 'kill_process', 58, 74, .55, 'tool'],
  ['tool_list_processes', 'list_processes', 70, 70, .55, 'tool'],
  ['tool_speak', 'speak', 80, 61, .55, 'tool'],
  ['tool_web_search', 'web_search', 85, 53, .58, 'tool'],
  ['tool_browser_read', 'browser_read', 88, 68, .52, 'tool'],
  ['tool_upsert_memory', 'upsert_memory', 14, 52, .55, 'tool'],
  ['behavior_rules', '行为规范', 18, 17, .84, 'rule'],
  ['rule_no_repeat', '不重复', 13, 30, .58, 'rule'],
  ['rule_idle_ok', '安静等待', 24, 33, .58, 'rule'],
  ['my_definition', '自我定义', 82, 16, .72, 'identity'],
  ['ui_skills', 'ACUI', 22, 84, .80, 'skill'],
  ['skill_weather_card', 'WeatherCard', 35, 88, .58, 'skill'],
  ['task_system', '任务系统', 63, 88, .74, 'task'],
  ['tool_marketplace', 'install_tool', 80, 84, .66, 'tool'],
];

const SEED_GRAPH_LINKS = [
  ['system_architecture', 'tick'], ['system_architecture', 'recognizer'], ['system_architecture', 'injector'],
  ['tick', 'rule_no_repeat'], ['tick', 'tool_send_message'], ['recognizer', 'injector'], ['injector', 'tool_search_memory'],
  ['tools_system', 'tool_send_message'], ['tools_system', 'tool_fetch_url'], ['tools_system', 'tool_write_read_file'], ['tools_system', 'tool_exec_command'],
  ['tools_system', 'tool_list_dir'], ['tools_system', 'tool_delete_file'], ['tools_system', 'tool_make_dir'], ['tools_system', 'tool_kill_process'],
  ['tools_system', 'tool_list_processes'], ['tools_system', 'tool_search_memory'], ['tools_system', 'tool_speak'], ['tools_system', 'tool_web_search'],
  ['tool_web_search', 'tool_fetch_url'], ['tool_browser_read', 'tool_fetch_url'], ['tool_upsert_memory', 'recognizer'],
  ['behavior_rules', 'rule_no_repeat'], ['behavior_rules', 'rule_idle_ok'], ['rule_no_repeat', 'rule_idle_ok'],
  ['my_definition', 'system_architecture'], ['ui_skills', 'skill_weather_card'], ['skill_weather_card', 'tool_fetch_url'],
  ['task_system', 'tick'], ['task_system', 'behavior_rules'], ['tool_marketplace', 'tools_system'],
];

const SEED_GRAPH_DETAILS = {
  system_architecture: 'TICK、识别器、注入器构成系统核心循环，让 Agent 能感知、积累、调用。',
  tick: '时间心跳驱动无消息时的自发行动，有消息时约束第一步必须回复。',
  recognizer: '每次经历结束后自动识别值得保留的内容并写入记忆。',
  injector: '处理开始前让相关记忆被动浮现，进入当前上下文。',
  tools_system: '内置工具让 Agent 与消息、网页、文件、命令、记忆、语音等外部系统交互。',
  tool_send_message: '向已知目标发送消息，是收到外部消息后的第一优先工具。',
  tool_fetch_url: '获取网页内容并带缓存，用于天气、百科、新闻等外部信息。',
  tool_write_read_file: '在 sandbox 内读写任务产物，不用于记录想法或感受。',
  tool_exec_command: '在 sandbox 内执行命令，支持前台和后台进程。',
  tool_search_memory: '查询记忆库，辅助主动检索相关记忆。',
  behavior_rules: '约束 Agent 行为边界，保证不重复、有节奏地自主行动。',
  rule_no_repeat: 'TICK 中避免重复上一轮已完成的行动。',
  rule_idle_ok: '无必要行动时允许安静等待，避免空转。',
  my_definition: 'Agent 对自我结构、能力和边界的定义。',
  ui_skills: 'ACUI 技能让 Agent 能通过 UI 卡片展示结构化信息。',
  skill_weather_card: '天气卡片是 ACUI 技能的典型示例。',
  task_system: '任务系统把长期目标拆成可执行、可追踪的步骤。',
  tool_marketplace: '工具市场用于发现、安装和扩展新工具。',
};

function createSeedGraphMarkup() {
  const nodeMap = new Map(SEED_GRAPH_NODES.map(([id, label, x, y, scale, group]) => [id, { id, label, x, y, scale, group }]));
  const getRelated = (id) => SEED_GRAPH_LINKS
    .filter(([source, target]) => source === id || target === id)
    .map(([source, target]) => source === id ? target : source);
  const lines = SEED_GRAPH_LINKS.map(([source, target]) => {
    const a = nodeMap.get(source);
    const b = nodeMap.get(target);
    if (!a || !b) return '';
    const soft = source !== 'system_architecture' && source !== 'tools_system' && source !== 'behavior_rules' && source !== 'ui_skills';
    return `<line data-source="${escHtml(source)}" data-target="${escHtml(target)}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"${soft ? ' class="wiki-graph-line-soft"' : ''} />`;
  }).join('');
  const nodes = SEED_GRAPH_NODES.map(([id, label, x, y, scale, group]) => {
    const related = getRelated(id);
    return `<button class="wiki-tag wiki-node wiki-node-${group}" type="button" data-seed-id="${escHtml(id)}" data-seed-label="${escHtml(label)}" data-seed-group="${escHtml(group)}" data-seed-related="${escHtml(related.join(','))}" style="--x:${x}%;--y:${y}%;--s:${scale}" title="${escHtml(id)}">${escHtml(label)}</button>`;
  }).join('');
  return `
    <svg class="wiki-graph-lines wiki-seed-graph-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${lines}</svg>
    <div id="wiki-tag-cloud" class="wiki-tag-cloud wiki-graph-nodes wiki-seed-graph-nodes">${nodes}</div>
    <div class="wiki-graph-stats"><span>${SEED_GRAPH_NODES.length} seed nodes</span><span>${SEED_GRAPH_LINKS.length} links</span><span>点击节点查看演进关系</span></div>`;
}

function createSeedDetailMarkup() {
  return `
    <div class="wiki-seed-detail" id="wiki-seed-detail" aria-live="polite">
      <div class="wiki-seed-detail-kicker">Seed Memory Focus</div>
      <div class="wiki-seed-detail-title">点击任一节点</div>
      <div class="wiki-seed-detail-body">查看它如何从种子记忆连接到工具、规则、技能和任务系统。</div>
    </div>`;
}

function createWikiPanel() {
  return `
<div class="wiki-panel" id="wiki-panel">
  <div class="hs-header">
    <div class="hs-brand">
      <span class="hs-brand-name">知识库 v1.0</span>
      <span class="hs-brand-dot">●</span>
      <span class="hs-brand-status">Obsidian Vault</span>
    </div>
    <div class="hs-title-block">
      <div class="hs-title-en">Personal Knowledge Base</div>
      <div class="hs-title-zh">个人知识管理系统</div>
    </div>
    <div class="hs-header-right">
      <div class="hs-header-meta">
        <div class="hs-header-tag"><span class="hs-tag-icon">◈</span>本地存储<br><span class="hs-tag-status">/Users/merry/wiki</span></div>
        <div class="hs-header-tag"><span class="hs-tag-icon">≡</span>文件总数<br><span class="hs-tag-status" id="wiki-total-count">--</span></div>
        <div class="hs-header-tag"><span class="hs-tag-icon">⬡</span>索引状态<br><span class="hs-tag-status">就绪</span></div>
      </div>
      <div class="hs-clock-block">
        <div class="hs-clock" id="wiki-clock">--:--:--</div>
        <div class="hs-live-dot">● 在线</div>
      </div>
      <button class="hs-exit-btn" id="wiki-exit-btn" type="button" title="关闭知识库面板">×</button>
    </div>
  </div>

  <div class="hs-stats-bar">
    <div class="hs-stat hs-stat--hot">
      <div class="hs-stat-icon">◈</div>
      <div class="hs-stat-body">
        <div class="hs-stat-label">核心概念</div>
        <div class="hs-stat-value" id="wiki-stat-concepts">66</div>
        <div class="hs-stat-delta" id="wiki-stat-concepts-delta">Agent / Memory / Skill</div>
      </div>
    </div>
    <div class="hs-stat hs-stat--data">
      <div class="hs-stat-icon">◈</div>
      <div class="hs-stat-body">
        <div class="hs-stat-label">个人笔记</div>
        <div class="hs-stat-value" id="wiki-stat-life">251</div>
        <div class="hs-stat-delta" id="wiki-stat-life-delta">收集/阅读/学习/项目</div>
      </div>
    </div>
    <div class="hs-stat hs-stat--warn">
      <div class="hs-stat-icon">◈</div>
      <div class="hs-stat-body">
        <div class="hs-stat-label">分析报告</div>
        <div class="hs-stat-value" id="wiki-stat-articles">18</div>
        <div class="hs-stat-delta" id="wiki-stat-articles-delta">articles/ 研究文档</div>
      </div>
    </div>
    <div class="hs-stat hs-stat--ai">
      <div class="hs-stat-icon">◈</div>
      <div class="hs-stat-body">
        <div class="hs-stat-label">实体与对比</div>
        <div class="hs-stat-value" id="wiki-stat-other">11</div>
        <div class="hs-stat-delta" id="wiki-stat-other-delta">entities / comparisons</div>
      </div>
    </div>
  </div>

  <div class="hs-body">
    <div class="hs-col hs-col-left">
      <div class="hs-list-card" id="wiki-concepts-card">
        <div class="hs-card-header">
          <span class="hs-platform-dot hs-dot-douyin"></span>
          <span class="hs-platform-name">核心概念</span>
          <span class="hs-card-badge">concepts/</span>
          <span class="hs-card-update" id="wiki-concepts-update">66篇</span>
        </div>
        <ul class="hs-list" id="wiki-concepts-list">
          <li class="hs-list-item hs-list-item--stub">Agent 执行循环</li>
          <li class="hs-list-item hs-list-item--stub">Skill 双触发机制</li>
          <li class="hs-list-item hs-list-item--stub">五层记忆系统</li>
          <li class="hs-list-item hs-list-item--stub">MCP 协议</li>
        </ul>
      </div>

      <div class="hs-list-card" id="wiki-life-card">
        <div class="hs-card-header">
          <span class="hs-platform-dot hs-dot-xhs"></span>
          <span class="hs-platform-name">个人笔记</span>
          <span class="hs-card-badge">life/</span>
          <span class="hs-card-update" id="wiki-life-update">251条</span>
        </div>
        <ul class="hs-list" id="wiki-life-list">
          <li class="hs-list-item hs-list-item--stub">学习笔记</li>
          <li class="hs-list-item hs-list-item--stub">阅读摘录</li>
          <li class="hs-list-item hs-list-item--stub">项目记录</li>
          <li class="hs-list-item hs-list-item--stub">灵感收集</li>
        </ul>
      </div>
    </div>

    <div class="hs-col hs-col-center">
      <div class="hs-earth-container wiki-graph-container" id="wiki-graph-container">
        <div class="hs-earth-label">种子记忆图谱</div>
        ${createSeedGraphMarkup()}
        <div class="hs-earth-hint">来自 scripts/seed-memories.js · 节点 = 种子记忆 · 连线 = links / parent</div>
      </div>
      ${createSeedDetailMarkup()}

      <div class="hs-center-aux">
        <div class="hs-aux-box">
          <div class="hs-aux-title">内容分布 <span class="hs-aux-sub">各目录文件数</span></div>
          <div class="hs-region-list" id="wiki-dist-list">
            <div class="hs-region-row"><span class="hs-region-name">concepts/</span><div class="hs-bar-track"><div class="hs-bar-fill" style="width:60%"></div></div><span class="hs-region-pct">66</span></div>
            <div class="hs-region-row"><span class="hs-region-name">life/</span><div class="hs-bar-track"><div class="hs-bar-fill" style="width:85%"></div></div><span class="hs-region-pct">251</span></div>
            <div class="hs-region-row"><span class="hs-region-name">articles/</span><div class="hs-bar-track"><div class="hs-bar-fill" style="width:15%"></div></div><span class="hs-region-pct">18</span></div>
            <div class="hs-region-row"><span class="hs-region-name">entities/</span><div class="hs-bar-track"><div class="hs-bar-fill" style="width:5%"></div></div><span class="hs-region-pct">5</span></div>
          </div>
        </div>

        <div class="hs-aux-box">
          <div class="hs-aux-title">最近更新 <span class="hs-aux-sub">当日活跃文件</span></div>
          <div class="hs-sentiment" id="wiki-recent-box">
            <div class="hs-sentiment-ring">
              <svg viewBox="0 0 80 80" class="hs-ring-svg" aria-hidden="true">
                <circle cx="40" cy="40" r="28" fill="none" stroke="var(--line-strong)" stroke-width="5"/>
                <circle cx="40" cy="40" r="28" fill="none" stroke="var(--cool)" stroke-width="5" stroke-dasharray="175.9" stroke-dashoffset="120" stroke-linecap="round" transform="rotate(-90 40 40)"/>
              </svg>
              <div class="hs-ring-label">
                <div class="hs-ring-num" id="wiki-recent-num">--</div>
                <div class="hs-ring-text">今日更新</div>
              </div>
            </div>
            <div class="hs-sentiment-delta" id="wiki-recent-delta">扫描中...</div>
          </div>
        </div>
      </div>
    </div>

    <div class="hs-col hs-col-right">
      <div class="hs-list-card" id="wiki-articles-card">
        <div class="hs-card-header">
          <span class="hs-platform-dot hs-dot-wechat"></span>
          <span class="hs-platform-name">最近更新</span>
          <span class="hs-card-badge">latest/</span>
          <span class="hs-card-update" id="wiki-articles-update">扫描中</span>
        </div>
        <ul class="hs-list" id="wiki-articles-list">
          <li class="hs-list-item hs-list-item--stub">agent-base-architecture-report.md</li>
          <li class="hs-list-item hs-list-item--stub">hermes-comparison.md</li>
          <li class="hs-list-item hs-list-item--stub">skill-evolution.md</li>
        </ul>
      </div>

      <div class="hs-list-card" id="wiki-other-card">
        <div class="hs-card-header">
          <span class="hs-platform-dot hs-dot-weibo"></span>
          <span class="hs-platform-name">实体与对比</span>
          <span class="hs-card-badge">entities/ + comparisons/</span>
          <span class="hs-card-update" id="wiki-other-update">12个</span>
        </div>
        <ul class="hs-list" id="wiki-other-list">
          <li class="hs-list-item hs-list-item--stub">hermes-agent.md</li>
          <li class="hs-list-item hs-list-item--stub">openclaw.md</li>
          <li class="hs-list-item hs-list-item--stub">bailongma-vs-hermes.md</li>
        </ul>
      </div>
    </div>
  </div>

  <div class="hs-feed-bar">
    <div class="hs-feed-label">
      <span class="hs-feed-live-dot">●</span>
      <span>知识</span>
      <span class="hs-feed-subtitle">Recent Updates</span>
      <span class="hs-feed-desc">/Users/merry/wiki · Obsidian Vault</span>
    </div>
    <div class="hs-feed-viewport" id="wiki-feed-viewport">
      <div class="hs-feed-track" id="wiki-feed-track">
        <span class="hs-feed-item">concepts/agent-base-architecture.md</span>
        <span class="hs-feed-item">concepts/skill-double-trigger.md</span>
        <span class="hs-feed-item">life/学习笔记/</span>
        <span class="hs-feed-item">articles/agent-base-architecture-report.md</span>
        <span class="hs-feed-item">entities/hermes-agent.md</span>
      </div>
    </div>
    <div class="hs-feed-controls">
      <span class="hs-feed-auto-label">知识库索引</span>
      <button class="hs-feed-nav" id="wiki-search-btn" type="button" title="搜索">⌕</button>
    </div>
  </div>

  <div class="hs-ticker-bar">
    <div class="hs-ticker-inner" id="wiki-ticker-inner">
      Hermes · OpenClaw · nanobot · opencode · Agent架构 · Memory体系 · Skill机制 · 多智能体 · RL训练 · MCP/A2A/AGUI
    </div>
  </div>
</div>`;
}

// ── 导出（供热键调用） ─────────────────────────────────────────
window.openHotspotPanel = openHotspotPanel;
window.closeHotspotPanel = closeHotspotPanel;
window.toggleHotspotPanel = toggleHotspotPanel;
window.openWikiPanel = openWikiPanel;
window.closeWikiPanel = closeWikiPanel;
window.toggleWikiPanel = toggleWikiPanel;
window.closeAllPanels = closeAllPanels;
window.loadHotspotData = loadHotspotData;
window.doWikiSearch = doWikiSearch;