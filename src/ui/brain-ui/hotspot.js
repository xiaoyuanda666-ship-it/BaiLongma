// 热点模式主逻辑 — 切换、热点数据、时钟、实时流

import { apiUrl } from './api-client.js';
import { HotspotEarth } from './hotspot-earth.js';
import { HotspotEarthLifecycle } from './hotspot-earth-lifecycle.js';
import { t, translateUiText } from './i18n/index.js';

// ── 实时热点数据由后端提供；前端不使用 mock 冒充真实数据 ─────────────────────

const PLATFORM_CONFIG = {
  douyin: { listId: 'hs-douyin-list', updateId: 'hs-douyin-update', style: 'heat', label: '抖音' },
  xiaohongshu: { listId: 'hs-xhs-list', updateId: 'hs-xhs-update', style: 'heat', label: '小红书' },
  wechat: { listId: 'hs-wechat-list', updateId: 'hs-wechat-update', style: 'label', label: '微信热点' },
  weibo: { listId: 'hs-weibo-list', updateId: 'hs-weibo-update', style: 'heat', label: '微博' },
};

const hotspotLists = {
  douyin: [],
  xiaohongshu: [],
  wechat: [],
  weibo: [],
};

let hotspotEvents = [];
let hotspotEventsMeta = {
  source: 'loading',
  sourceLabel: '',
  fetchedAt: null,
  checkedAt: null,
  stale: false,
  refreshMinutes: 15,
  error: '',
};

// ── 热点上下文构建（中性系统上下文，不强制 Agent 回复）──────────────────────────

let hotspotMeta = {
  source: 'loading',
  fetchedAt: null,
  stale: true,
  refreshMinutes: 30,
  status: {},
};

export function buildHotspotContext() {
  const top = (arr, n) => arr.slice(0, n).map((i, idx) => `${idx + 1}. ${i.text}`).join('；');
  const feedTop = hotspotEvents.slice(0, 3).map(i => `[${i.category}] ${i.title}`).join('；');
  const platformText = Object.entries(PLATFORM_CONFIG)
    .map(([platform, config]) => {
      const items = hotspotLists[platform] || [];
      if (!items.length) return '';
      return `${config.label} Top3：${top(items, 3)}`;
    })
    .filter(Boolean)
    .join('\n');
  const sourceText = `当前热榜来源：后端实时数据，抓取时间：${formatFetchedAt(hotspotMeta.fetchedAt)}${hotspotMeta.stale ? '（缓存数据）' : ''}`;
  return `## 热点上下文
来源：热点模式界面，系统自动采集。发送者：SYSTEM。用途：提供当前环境背景，不代表用户请求。

用户当前打开了热点面板。以下热点只作为上下文参考，不要求主动总结，不要把它当成用户消息，也不要因为它单独回复用户。

只有在满足任一条件时才可主动提及：
- 热点与用户当前问题、任务或正在讨论的话题直接相关；
- 热点包含明显需要用户注意的紧急风险、重大变化或高优先级信息；
- 用户明确询问“热点”“热搜”“现在发生什么”等内容。

${sourceText}

${platformText || '当前暂无可用实时热榜。'}
实时事件 Top3：${feedTop || '当前暂无可用真实事件。'}`;
}

// ── 状态 ──────────────────────────────────────────────────────────────────────

let hotspotActive = false;
let clockTimer    = null;
let feedAutoTimer = null;
let hotspotRefreshTimer = null;
let hotspotRefreshController = null;
let hotspotEventsRefreshTimer = null;
let hotspotEventsRefreshController = null;
let feedIndex     = 0;

// ── 语音球搬家：从 #panel-l1(有 transform)移走，让 fixed 定位/嵌入布局生效 ────
// 已被别的模式搬走时先回原位再搬，支持模式间直接交接（热点↔世界杯↔视频）

function moveVoicePanel(target, { prepend = false } = {}) {
  const vp = document.getElementById('voice-panel');
  if (!vp || !target || vp.parentElement === target) return;
  if (vp.dataset.vpMoved) restoreVoicePanel();
  vp._vpParent  = vp.parentElement;
  vp._vpSibling = vp.nextElementSibling;
  vp.dataset.vpMoved = '1';
  if (prepend && target.firstChild) target.insertBefore(vp, target.firstChild);
  else target.appendChild(vp);
}

function moveVoicePanelToBody() {
  moveVoicePanel(document.body);
}

function restoreVoicePanel() {
  const vp = document.getElementById('voice-panel');
  if (!vp || !vp.dataset.vpMoved) return;
  const parent  = vp._vpParent;
  const sibling = vp._vpSibling;
  if (parent) {
    if (sibling && sibling.parentElement === parent) parent.insertBefore(vp, sibling);
    else parent.appendChild(vp);
  }
  delete vp.dataset.vpMoved;
  delete vp._vpParent;
  delete vp._vpSibling;
}

export { moveVoicePanel, moveVoicePanelToBody, restoreVoicePanel };

// ── DOM 工具 ──────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

function renderEarthState(state) {
  const container = $('hs-earth-container');
  const message = $('hs-earth-status-message');
  const retryButton = $('hs-earth-retry');
  if (!container) return;

  container.dataset.earthState = state;
  container.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
  if (message) {
    message.textContent = state === 'failed'
      ? t('hotspot.earthFailed')
      : t('hotspot.earthLoading');
  }
  if (retryButton) retryButton.textContent = t('hotspot.earthRetry');
}

const earthLifecycle = new HotspotEarthLifecycle({
  createEarth: () => {
    const canvas = $('hs-earth-canvas');
    if (!canvas) throw new Error('3D earth canvas is unavailable');
    return new HotspotEarth(canvas);
  },
  onStateChange: renderEarthState,
  onError: (error) => {
    console.warn('[HotspotEarth] 生命周期操作失败:', error);
  },
});

// ── 热榜列表渲染 ──────────────────────────────────────────────────────────────

const TREND_ICONS = { up: '↑', down: '↓', same: '—' };
const TREND_CLASSES = { up: 'hs-trend-up', down: 'hs-trend-dn', same: 'hs-trend-same' };

function renderList(listId, items, style = 'heat') {
  const ul = $(listId);
  if (!ul) return;
  if (!items.length) {
    ul.innerHTML = `<li class="hs-item hs-item-empty">
      <span class="hs-rank">--</span>
      <span class="hs-item-text">${t('hotspot.sourceUnavailable')}</span>
      <span class="hs-heat">--</span>
      <span class="hs-trend hs-trend-same">—</span>
    </li>`;
    return;
  }
  ul.innerHTML = items.map(({ rank, text, heat, trend, isNew }) => {
    const rankCls = rank <= 3 ? `hs-rank-top${rank}` : '';
    const trendIcon = TREND_ICONS[trend] || '';
    const trendCls  = TREND_CLASSES[trend] || '';
    const newBadge  = isNew ? `<span class="hs-new-badge">${t('hotspot.new')}</span>` : '';
    const heatLabel = style === 'heat'
      ? `<span class="hs-heat">${heat}</span>`
      : `<span class="hs-label-badge">${heat}</span>`;
    return `<li class="hs-item">
      <span class="hs-rank ${rankCls}">${rank}</span>
      <span class="hs-item-text">${text}${newBadge}</span>
      ${heatLabel}
      <span class="hs-trend ${trendCls}">${trendIcon}</span>
    </li>`;
  }).join('');
}

function renderAllLists() {
  for (const [platform, config] of Object.entries(PLATFORM_CONFIG)) {
    renderList(config.listId, hotspotLists[platform] || [], config.style);
  }
}

function formatFetchedAt(value) {
  if (!value) return t('hotspot.unknown');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t('hotspot.unknown');
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function normalizeHotspotItem(item, idx) {
  const text = item?.text || item?.title || item?.word || '';
  return {
    rank: Number(item?.rank || idx + 1),
    text,
    heat: item?.heat || '',
    trend: item?.trend || 'same',
    isNew: !!item?.isNew,
  };
}

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function updateHotspotMeta() {
  let total = 0;
  for (const [platform, config] of Object.entries(PLATFORM_CONFIG)) {
    const items = hotspotLists[platform] || [];
    const status = hotspotMeta.status?.[platform] || {};
    total += items.length;
    const source = status.ok
      ? `${translateUiText(status.source || t('hotspot.realtime'))} · ${t(hotspotMeta.stale ? 'hotspot.cache' : 'hotspot.data')}`
      : t('hotspot.notConfigured');
    setText(config.updateId, `${source} · ${formatFetchedAt(hotspotMeta.fetchedAt)}`);
  }
  setText('hs-stat-data', String(total));
  setText('hs-stat-data-delta', t('hotspot.statsDelta', { minutes: hotspotMeta.refreshMinutes || 30 }));
}

async function refreshHotspots({ force = false } = {}) {
  // 同一面板只保留一个请求；关闭时会由 stopHotspotRefresh 主动取消。
  if (hotspotRefreshController) return;
  const controller = new AbortController();
  hotspotRefreshController = controller;
  try {
    const params = new URLSearchParams();
    if (force) params.set('refresh', '1');
    if (hotspotActive) params.set('viewed', '1');
    const query = params.toString();
    const res = await fetch(apiUrl(`/hotspots${query ? `?${query}` : ''}`), { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // 请求返回前面板已关闭，无需再更新隐藏 DOM 或延长后端的 viewed 状态。
    if (!hotspotActive) return;
    for (const platform of Object.keys(PLATFORM_CONFIG)) {
      const list = data?.platforms?.[platform] || [];
      hotspotLists[platform] = Array.isArray(list)
        ? list.map(normalizeHotspotItem).filter(item => item.text).slice(0, 10)
        : [];
    }
    hotspotMeta = {
      source: 'hotspot-api',
      fetchedAt: data.fetchedAt,
      stale: !!data.stale,
      refreshMinutes: data.refreshMinutes || 30,
      status: data.status || {},
    };
    renderAllLists();
    updateHotspotMeta();
  } catch (err) {
    if (err.name === 'AbortError') return;
    hotspotMeta = {
      ...hotspotMeta,
      stale: true,
    };
    updateHotspotMeta();
    console.warn('[Hotspot] 热榜刷新失败:', err.message);
  } finally {
    if (hotspotRefreshController === controller) hotspotRefreshController = null;
  }
}

function startHotspotRefresh() {
  if (hotspotRefreshTimer) clearInterval(hotspotRefreshTimer);
  hotspotRefreshTimer = setInterval(() => {
    refreshHotspots().catch(() => {});
  }, (hotspotMeta.refreshMinutes || 30) * 60 * 1000);
}

function stopHotspotRefresh() {
  if (hotspotRefreshTimer) clearInterval(hotspotRefreshTimer);
  hotspotRefreshTimer = null;
  hotspotRefreshController?.abort();
  hotspotRefreshController = null;
}

// ── 实时事件流 ───────────────────────────────────────────────────────────────

const CAT_COLORS = {
  '自然灾害':'#e05c5c', '科技':'#5c9ee0', '财经':'#c97d30',
  '体育':'#4eaa6e', '社会':'#9b6bc4', '政策':'#6bbfbf', '旅游':'#c4a030',
  '健康':'#55b8a8', '文娱':'#d071a8',
};

function safeHttpUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}

function normalizeHotspotEvent(item) {
  const title = String(item?.title || '').trim();
  if (!title) return null;
  return {
    id: String(item?.id || title),
    title,
    summary: String(item?.summary || '').trim(),
    category: String(item?.category || t('hotspot.eventCategoryFallback')).trim(),
    categoryDerived: !!item?.categoryDerived,
    publishedAt: item?.publishedAt || null,
    fetchedAt: item?.fetchedAt || null,
    location: item?.location ? String(item.location).trim() : '',
    source: String(item?.source || t('hotspot.unknown')).trim(),
    sourceUrl: safeHttpUrl(item?.sourceUrl),
    hotness: String(item?.hotness || '').trim(),
  };
}

function eventTimeLabel(item, { withKind = true } = {}) {
  const published = item?.publishedAt;
  const raw = published || item?.fetchedAt;
  const date = raw ? new Date(raw) : null;
  if (!date || Number.isNaN(date.getTime())) return t('hotspot.unknown');
  const pad = (n) => String(n).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (!withKind) return time;
  return published
    ? t('hotspot.eventPublishedAt', { time })
    : t('hotspot.eventFetchedAt', { time });
}

function appendTextElement(parent, tagName, className, text) {
  const el = document.createElement(tagName);
  el.className = className;
  el.textContent = text;
  parent.appendChild(el);
  return el;
}

function createFeedCard(item) {
  const card = document.createElement(item.sourceUrl ? 'a' : 'div');
  card.className = 'hs-feed-card';
  if (item.sourceUrl) {
    card.href = item.sourceUrl;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
    card.setAttribute('aria-label', `${item.title} · ${item.source}`);
  }

  const top = document.createElement('div');
  top.className = 'hs-feed-card-top';
  appendTextElement(top, 'span', 'hs-feed-time', eventTimeLabel(item));
  const color = CAT_COLORS[item.category] || '#8fb6d8';
  const category = appendTextElement(top, 'span', 'hs-feed-cat', translateUiText(item.category));
  category.style.background = `${color}22`;
  category.style.color = color;
  category.style.borderColor = `${color}44`;
  if (item.categoryDerived) category.title = t('hotspot.eventCategoryDerived');
  card.appendChild(top);

  appendTextElement(card, 'div', 'hs-feed-title', item.title);
  if (item.summary) appendTextElement(card, 'div', 'hs-feed-desc', item.summary);
  const detail = [item.location, item.source, item.hotness ? t('hotspot.eventHotness', { value: item.hotness }) : '']
    .filter(Boolean)
    .join(' · ');
  appendTextElement(card, 'div', 'hs-feed-source', detail || t('hotspot.unknown'));
  return card;
}

function renderFeed() {
  const track = $('hs-feed-track');
  if (!track) return;
  track.replaceChildren();
  if (!hotspotEvents.length) {
    const empty = appendTextElement(
      track,
      'div',
      'hs-feed-card hs-feed-card-empty',
      hotspotEventsMeta.error ? t('hotspot.sourceUnavailable') : t('hotspot.eventLoading'),
    );
    empty.setAttribute('role', 'status');
    return;
  }
  const fragment = document.createDocumentFragment();
  hotspotEvents.slice(0, 12).forEach(item => fragment.appendChild(createFeedCard(item)));
  track.appendChild(fragment);
}

function scrollFeedTo(idx) {
  const track    = $('hs-feed-track');
  const viewport = $('hs-feed-viewport');
  if (!track || !viewport) return;
  const cards = track.querySelectorAll('.hs-feed-card');
  if (!cards.length) return;
  feedIndex = ((idx % cards.length) + cards.length) % cards.length;
  const cardW   = cards[0].offsetWidth + 12; // gap
  const maxScroll = track.scrollWidth - viewport.offsetWidth;
  const target  = Math.min(feedIndex * cardW, maxScroll);
  viewport.scrollTo({ left: target, behavior: 'smooth' });
}

function startFeedAuto() {
  if (feedAutoTimer) clearInterval(feedAutoTimer);
  feedAutoTimer = setInterval(() => {
    scrollFeedTo(feedIndex + 1);
  }, 4000);
  updateHotspotEventsMeta();
}

function stopFeedAuto({ updateLabel = false } = {}) {
  if (feedAutoTimer) clearInterval(feedAutoTimer);
  feedAutoTimer = null;
  if (updateLabel) updateHotspotEventsMeta();
}

// ── 底部跑马灯（与事件卡片同源，不单独制造内容）─────────────────────────────

function renderTicker() {
  const el = $('hs-ticker-inner');
  if (!el) return;
  el.replaceChildren();
  const tickerItems = hotspotEvents.length > 12 ? hotspotEvents.slice(12, 32) : hotspotEvents;
  if (!tickerItems.length) {
    el.classList.add('hs-ticker-inner-empty');
    el.textContent = hotspotEventsMeta.error ? t('hotspot.sourceUnavailable') : t('hotspot.eventLoading');
    return;
  }
  el.classList.remove('hs-ticker-inner-empty');
  const appendItems = () => {
    tickerItems.forEach((item, index) => {
      const entry = document.createElement('span');
      entry.className = 'hs-ticker-item';
      appendTextElement(entry, 'span', 'hs-ticker-time', eventTimeLabel(item, { withKind: false }));
      entry.appendChild(document.createTextNode(item.title));
      el.appendChild(entry);
      if (index < tickerItems.length - 1) appendTextElement(el, 'span', 'hs-ticker-sep', '●');
    });
  };
  appendItems();
  appendTextElement(el, 'span', 'hs-ticker-sep', '●');
  appendItems();
}

function updateHotspotEventsMeta() {
  const bar = document.querySelector('.hs-feed-bar');
  const state = $('hs-feed-state');
  const description = $('hs-feed-description');
  const autoLabel = $('hs-feed-auto');
  const unavailable = !hotspotEvents.length && !!hotspotEventsMeta.error;
  const loading = !hotspotEvents.length && !hotspotEventsMeta.error && hotspotEventsMeta.source === 'loading';
  bar?.classList.toggle('hs-feed-stale', !!hotspotEventsMeta.stale && !unavailable);
  bar?.classList.toggle('hs-feed-unavailable', unavailable);
  if (state) state.textContent = loading
    ? t('hotspot.eventLoadingShort')
    : (unavailable
      ? t('hotspot.eventUnavailableShort')
      : t(hotspotEventsMeta.stale ? 'hotspot.cache' : 'hotspot.realtime'));
  if (description) {
    description.textContent = loading
      ? t('hotspot.eventLoading')
      : (unavailable
        ? t('hotspot.sourceUnavailable')
        : t('hotspot.eventSourceStatus', {
          source: translateUiText(hotspotEventsMeta.sourceLabel || hotspotEventsMeta.source),
          time: formatFetchedAt(hotspotEventsMeta.fetchedAt),
        }));
  }
  if (autoLabel) autoLabel.textContent = loading
    ? t('hotspot.eventLoadingShort')
    : (unavailable || !feedAutoTimer
      ? t('hotspot.eventPaused')
      : t(hotspotEventsMeta.stale ? 'hotspot.cache' : 'hotspot.autoScrolling'));
}

function scheduleHotspotEventsRefresh() {
  if (hotspotEventsRefreshTimer) clearTimeout(hotspotEventsRefreshTimer);
  hotspotEventsRefreshTimer = null;
  if (!hotspotActive) return;
  const minutes = Math.max(5, Number(hotspotEventsMeta.refreshMinutes) || 15);
  hotspotEventsRefreshTimer = setTimeout(() => {
    refreshHotspotEvents().catch(() => {});
  }, minutes * 60 * 1000);
}

async function refreshHotspotEvents({ force = false } = {}) {
  if (hotspotEventsRefreshController) return;
  const controller = new AbortController();
  hotspotEventsRefreshController = controller;
  try {
    const query = force ? '?refresh=1' : '';
    const res = await fetch(apiUrl(`/hotspot-events${query}`), { signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${res.status}`);
    if (!hotspotActive) return;
    hotspotEvents = Array.isArray(data?.events)
      ? data.events.map(normalizeHotspotEvent).filter(Boolean)
      : [];
    hotspotEventsMeta = {
      source: data.source || 'hotspot-events',
      sourceLabel: data.sourceLabel || data.source || 'hotspot-events',
      fetchedAt: data.fetchedAt || null,
      checkedAt: data.checkedAt || null,
      stale: !!data.stale,
      refreshMinutes: data.refreshMinutes || 15,
      error: hotspotEvents.length ? '' : t('hotspot.sourceUnavailable'),
    };
    feedIndex = Math.min(feedIndex, Math.max(0, hotspotEvents.length - 1));
    renderFeed();
    renderTicker();
    updateHotspotEventsMeta();
  } catch (err) {
    if (err.name === 'AbortError') return;
    hotspotEventsMeta = {
      ...hotspotEventsMeta,
      stale: hotspotEvents.length > 0,
      error: err.message,
    };
    renderFeed();
    renderTicker();
    updateHotspotEventsMeta();
    console.warn('[Hotspot] 实时事件刷新失败:', err.message);
  } finally {
    if (hotspotEventsRefreshController === controller) hotspotEventsRefreshController = null;
    scheduleHotspotEventsRefresh();
  }
}

function stopHotspotEventsRefresh() {
  if (hotspotEventsRefreshTimer) clearTimeout(hotspotEventsRefreshTimer);
  hotspotEventsRefreshTimer = null;
  hotspotEventsRefreshController?.abort();
  hotspotEventsRefreshController = null;
}

// ── 实时时钟 ─────────────────────────────────────────────────────────────────

function updateClock() {
  const el = $('hs-clock');
  if (!el) return;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  el.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function startClock() {
  updateClock();
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = setInterval(updateClock, 1000);
}

function stopClock() {
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = null;
}

function replayHotspotBoot() {
  const panel = $('hotspot-panel');
  if (!panel) return;
  panel.classList.remove('hs-booting');
  void panel.offsetWidth;
  panel.classList.add('hs-booting');
}

// ── 模式切换 ─────────────────────────────────────────────────────────────────

function reportHotspotState(visible, source = 'brain-ui') {
  fetch(apiUrl('/hotspot-state'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active: !!visible, source }),
  }).catch(() => {});
}

function setPanelVisible(visible, source = 'brain-ui') {
  hotspotActive = visible;
  document.body.classList.toggle('hotspot-mode', visible);
  if (!visible) $('hotspot-panel')?.classList.remove('hs-booting');

  const btn = document.getElementById('hotspot-btn');
  if (btn) btn.classList.toggle('active', visible);

  window.dispatchEvent(new CustomEvent('bailongma:hotspot-mode', {
    detail: { active: visible },
  }));
  reportHotspotState(visible, source);
}

export function setHotspotMode(visible, { source = 'brain-ui' } = {}) {
  const nextVisible = !!visible;
  if (hotspotActive === nextVisible) {
    reportHotspotState(nextVisible, source);
    return;
  }

  if (!nextVisible) {
    setPanelVisible(false, source);
    stopClock();
    stopFeedAuto();
    stopHotspotRefresh();
    stopHotspotEventsRefresh();
    earthLifecycle.close();
    restoreVoicePanel();
  } else {
    // 关闭其他媒体模式（互斥）
    if (document.body.classList.contains('video-mode'))
      document.body.classList.remove('video-mode');
    if (document.body.classList.contains('image-mode'))
      document.body.classList.remove('image-mode');
    if (document.body.classList.contains('music-mode'))
      document.body.classList.remove('music-mode');

    setPanelVisible(true, source);
    // 同步进入 loading/ready，保证热点面板第一次可见绘制时中央区域已有反馈。
    earthLifecycle.open();
    replayHotspotBoot();
    startClock();
    startFeedAuto();
    startHotspotRefresh();
    refreshHotspots().catch(() => {});
    refreshHotspotEvents().catch(() => {});
    moveVoicePanelToBody();
  }
}

export function toggleHotspot(source = 'brain-ui') {
  setHotspotMode(!hotspotActive, { source });
}

// ── 初始化 ───────────────────────────────────────────────────────────────────

export async function initHotspot() {
  // 填充静态内容
  renderAllLists();
  updateHotspotMeta();
  renderFeed();
  renderTicker();
  updateHotspotEventsMeta();

  // 绑定关闭按钮
  const exitBtn = $('hs-exit-btn');
  if (exitBtn) exitBtn.addEventListener('click', () => toggleHotspot());

  // 绑定实时流控制按钮
  const prevBtn = $('hs-feed-prev');
  const nextBtn = $('hs-feed-next');
  const earthRetryBtn = $('hs-earth-retry');
  if (prevBtn) prevBtn.addEventListener('click', () => { stopFeedAuto({ updateLabel: true }); scrollFeedTo(feedIndex - 1); });
  if (nextBtn) nextBtn.addEventListener('click', () => { stopFeedAuto({ updateLabel: true }); scrollFeedTo(feedIndex + 1); });
  if (earthRetryBtn) earthRetryBtn.addEventListener('click', () => { earthLifecycle.retry(); });

  // 地球不在这里初始化：WebGL 场景只在热点模式首次打开时由生命周期控制器创建，
  // 避免应用一启动就有一个 60fps 的 3D 渲染循环在隐藏面板里空转烧 GPU。

  // 页面不可见（最小化/切走/收进托盘）时显式停掉地球渲染，回来且面板开着才恢复
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) earthLifecycle.pause();
    else earthLifecycle.resume();
  });
}
