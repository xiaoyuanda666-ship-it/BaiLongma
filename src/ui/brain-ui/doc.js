// 文档面板控制器
// 类似 hotspot.js，负责面板的打开/关闭、内容加载、章节导航

import { API } from './api-client.js'
const apiUrl = (path) => `${API}${path}`

let docActive = false
let currentTopicId = null
let currentDoc = null
let previousFocus = null

const $ = (id) => document.getElementById(id)

// ── 内容渲染 ────────────────────────────────────────────────────────────────

function renderProviders(providers) {
  const el = $('dp-providers')
  if (!el) return
  if (!providers || providers.length === 0) {
    el.style.display = 'none'
    return
  }
  el.style.display = 'flex'
  el.innerHTML = providers.map(p => `
    <a class="dp-provider-chip${p.free ? ' dp-provider-free' : ''}" href="${p.url}" target="_blank" rel="noopener" title="${p.note}">
      <span class="dp-chip-name">${p.name}</span>
      ${p.free ? '<span class="dp-chip-badge">免费</span>' : ''}
      <span class="dp-chip-arrow">↗</span>
    </a>
  `).join('')
}

function renderNav(sections, activeIdx = 0) {
  const nav = $('dp-nav')
  if (!nav) return
  nav.innerHTML = sections.map((s, i) => `
    <button class="dp-nav-item${i === activeIdx ? ' dp-nav-active' : ''}" data-idx="${i}" type="button">
      <span class="dp-nav-num">${String(i + 1).padStart(2, '0')}</span>
      <span class="dp-nav-label">${s.title}</span>
    </button>
  `).join('')

  nav.querySelectorAll('.dp-nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10)
      renderSection(idx)
    })
  })
}

function renderSection(idx) {
  if (!currentDoc || !currentDoc.sections[idx]) return

  const section = currentDoc.sections[idx]
  const content = $('dp-content')
  if (content) {
    content.scrollTop = 0
    content.innerHTML = `
      <div class="dp-section-kicker">使用指南 / ${String(idx + 1).padStart(2, '0')}</div>
      <div class="dp-section-title">${section.title}</div>
      <div class="dp-section-body">${formatContent(section.content)}</div>
      ${section.image ? `<figure class="dp-figure"><img src="${section.image}" alt="${section.imageAlt || section.title}" loading="lazy"><figcaption>${section.imageAlt || section.title} · 界面示意，未使用真实账号</figcaption></figure>` : ''}
    `
  }

  // 更新导航高亮
  const nav = $('dp-nav')
  if (nav) {
    nav.querySelectorAll('.dp-nav-item').forEach((btn, i) => {
      btn.classList.toggle('dp-nav-active', i === idx)
    })
  }
}

function formatContent(text) {
  if (!text) return ''
  const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  return text.split(/\n\s*\n/).map(block => `<div class="dp-paragraph">${block.split('\n').map(line => {
    const safe = escape(line).replace(/(https?:\/\/[^\s)]+)/g, '<a href="$1" target="_blank" rel="noopener" class="dp-link">$1</a>')
    if (/^■ /.test(line)) return `<div class="dp-bullet">${safe.slice(2)}</div>`
    const step = safe.match(/^(\d+\.|[①②③④⑤⑥⑦⑧⑨]) (.+)$/)
    if (step) return `<div class="dp-list-item"><span class="dp-list-num">${step[1]}</span><span>${step[2]}</span></div>`
    return `<div>${safe}</div>`
  }).join('')}</div>`).join('')
}

function renderDoc(doc) {
  currentDoc = doc

  const title = $('dp-title')
  const subtitle = $('dp-subtitle')
  const icon = $('dp-icon')
  const summary = $('dp-summary')

  if (title) title.textContent = doc.title
  if (subtitle) subtitle.textContent = doc.subtitle
  if (icon) icon.textContent = doc.icon
  if (summary) summary.textContent = doc.summary

  // 更新 Tab 高亮
  const tabs = $('dp-tabs')
  if (tabs) {
    tabs.querySelectorAll('.dp-tab').forEach(btn => {
      btn.classList.toggle('dp-tab-active', btn.dataset.topic === doc.id)
    })
  }

  renderNav(doc.sections, 0)
  renderSection(0)
  renderProviders(doc.providers)
}

// ── 数据获取 ─────────────────────────────────────────────────────────────────

async function fetchDoc(topicId) {
  try {
    const res = await fetch(apiUrl(`/docs/${topicId}`))
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    return data.doc || null
  } catch (err) {
    console.warn('[DocPanel] 获取文档失败:', err.message)
    return null
  }
}

async function loadTopic(topicId) {
  if (!topicId) return
  currentTopicId = topicId
  currentDoc = null
  if ($('dp-nav')) $('dp-nav').innerHTML = ''
  renderProviders([])

  const content = $('dp-content')
  if (content) content.innerHTML = '<div class="dp-loading">加载中...</div>'

  const doc = await fetchDoc(topicId)
  if (currentTopicId !== topicId) return
  if (doc) renderDoc(doc)
  else if (content) content.innerHTML = '<div class="dp-loading">暂时无法加载说明，请稍后重新选择主题。</div>'
}

// ── 状态上报 ─────────────────────────────────────────────────────────────────

function reportDocPanelState(visible, topicId, source = 'brain-ui') {
  fetch(apiUrl('/doc-panel-state'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active: !!visible, topicId: topicId || null, source }),
  }).catch(() => {})
}

// ── 面板开关 ──────────────────────────────────────────────────────────────────

function setPanelVisible(visible, topicId, source = 'brain-ui') {
  if (visible && !docActive) previousFocus = document.activeElement
  docActive = visible
  document.body.classList.toggle('doc-panel-mode', visible)

  const panel = $('doc-panel')
  if (panel) {
    panel.classList.toggle('dp-visible', visible)
    panel.inert = !visible
    panel.setAttribute('aria-hidden', String(!visible))
    if (visible) $('dp-close-btn')?.focus({ preventScroll: true })
    else if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
  }

  reportDocPanelState(visible, topicId, source)
}

export function setDocPanelMode(visible, { topicId = null, source = 'brain-ui' } = {}) {
  const nextVisible = !!visible

  if (!nextVisible) {
    setPanelVisible(false, currentTopicId, source)
    return
  }

  const topic = topicId || currentTopicId || 'voice_config'
  setPanelVisible(true, topic, source)

  if (topic !== currentTopicId || !currentDoc) {
    loadTopic(topic)
  }
}

export function toggleDocPanel(topicId = null) {
  setDocPanelMode(!docActive, { topicId })
}

// ── 初始化 ────────────────────────────────────────────────────────────────────

// 使用指南与关于白龙马按主题分组，
// 顺序即展示顺序。topic 不存在于 /docs 时自动跳过，无需手动同步。
const TAB_GROUPS = [
  { label: '使用指南', topics: ['model_config', 'voice_asr', 'voice_tts', 'voice_config', 'wechat_config'] },
  { label: '关于白龙马', topics: ['self_architecture', 'ui_design'] },
]

// Tab 上的短标签（文档 title 太长，pill 放不下）；缺省回退到 title。
const TAB_SHORT_LABELS = {
  model_config: '模型',
  voice_asr: '语音识别',
  voice_tts: '语音合成',
  voice_config: '语音入门',
  wechat_config: '微信',
  self_architecture: '架构机制',
  ui_design: '界面设计',
}

// 从 /docs 拉取主题列表，按分组渲染 Tab 并绑定点击。组间插一条细分隔。
async function renderTabs() {
  const tabsEl = $('dp-tabs')
  if (!tabsEl) return

  let topics = []
  try {
    const res = await fetch(apiUrl('/docs'))
    if (res.ok) topics = (await res.json()).topics || []
  } catch (err) {
    console.warn('[DocPanel] 获取主题列表失败:', err.message)
  }
  const byId = Object.fromEntries(topics.map(t => [t.id, t]))

  const parts = []
  for (const group of TAB_GROUPS) {
    const present = group.topics.filter(id => byId[id])
    if (!present.length) continue
    if (parts.length) parts.push('<span class="dp-tab-divider" aria-hidden="true"></span>')
    for (const id of present) {
      const icon = byId[id].icon || ''
      const label = TAB_SHORT_LABELS[id] || byId[id].title
      const active = id === currentTopicId ? ' dp-tab-active' : ''
      parts.push(`<button class="dp-tab${active}" data-topic="${id}" type="button" title="${byId[id].title}">${icon} ${label}</button>`)
    }
  }
  tabsEl.innerHTML = parts.join('')

  tabsEl.querySelectorAll('.dp-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const topic = btn.dataset.topic
      if (topic) {
        loadTopic(topic)
        reportDocPanelState(true, topic, 'tab_switch')
      }
    })
  })
}

export async function initDocPanel() {
  // 绑定关闭按钮
  const closeBtn = $('dp-close-btn')
  if (closeBtn) closeBtn.addEventListener('click', () => setDocPanelMode(false, { source: 'user_close' }))

  $('doc-panel')?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && docActive) {
      event.stopPropagation()
      setDocPanelMode(false, { source: 'user_close' })
    }
  })

  // 数据化渲染 Tab（分组 + 自动包含新主题）
  await renderTabs()
}
