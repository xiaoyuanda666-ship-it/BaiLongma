// 文档面板控制器
// 类似 hotspot.js，负责面板的打开/关闭、内容加载、章节导航

import { API } from './api-client.js'
const apiUrl = (path) => `${API}${path}`

let docActive = false
let currentTopicId = null
let currentDoc = null

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
    content.innerHTML = `
      <div class="dp-section-title">${section.title}</div>
      <div class="dp-section-body">${formatContent(section.content)}</div>
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
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // URL 转链接
    .replace(/(https?:\/\/[^\s\)]+)/g, '<a href="$1" target="_blank" rel="noopener" class="dp-link">$1</a>')
    // ■ 分组标题
    .replace(/^■ (.+)$/gm, '<div class="dp-bullet">■ $1</div>')
    // → 箭头项
    .replace(/^→ (.+)$/gm, '<div class="dp-arrow-item">→ $1</div>')
    // · 子项（允许前导缩进，如工具清单），缩进一级
    .replace(/^\s*· (.+)$/gm, '<div class="dp-subitem"><span class="dp-subitem-mark">·</span> $1</div>')
    // - 子项（允许前导缩进，如架构说明），缩进一级
    .replace(/^[ \t]*- (.+)$/gm, '<div class="dp-subitem"><span class="dp-subitem-mark">–</span> $1</div>')
    // 数字列表
    .replace(/^(\d+)\. (.+)$/gm, '<div class="dp-list-item"><span class="dp-list-num">$1.</span> $2</div>')
    // ① ② 等圆圈数字
    .replace(/^([①②③④⑤⑥⑦⑧⑨]) (.+)$/gm, '<div class="dp-list-item"><span class="dp-list-num">$1</span> $2</div>')
    // 换行
    .replace(/\n/g, '<br>')
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
  renderInlineConfig(doc.id)
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

  const content = $('dp-content')
  if (content) content.innerHTML = '<div class="dp-loading">加载中...</div>'

  const doc = await fetchDoc(topicId)
  if (doc) renderDoc(doc)
}

// ── 状态上报 ─────────────────────────────────────────────────────────────────

function reportDocPanelState(visible, topicId, source = 'brain-ui') {
  fetch(apiUrl('/doc-panel-state'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active: !!visible, topicId: topicId || null, source }),
  }).catch(() => {})
}

// ── TTL 计时显示 ──────────────────────────────────────────────────────────────

let ttlTimer = null

function startTTLDisplay() {
  let remaining = 30 * 60 // 秒
  const el = $('dp-footer-ttl')
  if (ttlTimer) clearInterval(ttlTimer)
  ttlTimer = setInterval(() => {
    remaining = Math.max(0, remaining - 1)
    const min = Math.ceil(remaining / 60)
    if (el) el.textContent = remaining > 0 ? `上下文有效期 ${min} 分钟` : '上下文已过期'
    if (remaining === 0) clearInterval(ttlTimer)
  }, 1000)
}

function stopTTLDisplay() {
  if (ttlTimer) clearInterval(ttlTimer)
  ttlTimer = null
}

// ── 面板开关 ──────────────────────────────────────────────────────────────────

function setPanelVisible(visible, topicId, source = 'brain-ui') {
  docActive = visible
  document.body.classList.toggle('doc-panel-mode', visible)

  const panel = $('doc-panel')
  if (panel) panel.classList.toggle('dp-visible', visible)

  reportDocPanelState(visible, topicId, source)
}

export function setDocPanelMode(visible, { topicId = null, source = 'brain-ui' } = {}) {
  const nextVisible = !!visible

  if (!nextVisible) {
    setPanelVisible(false, currentTopicId, source)
    stopTTLDisplay()
    return
  }

  const topic = topicId || currentTopicId || 'voice_config'
  setPanelVisible(true, topic, source)
  startTTLDisplay()

  if (topic !== currentTopicId || !currentDoc) {
    loadTopic(topic)
  }
}

export function toggleDocPanel(topicId = null) {
  setDocPanelMode(!docActive, { topicId })
}

// ── 内联配置表单 ───────────────────────────────────────────────────────────────

const ASR_PROVIDER_DEFS = [
  { id: 'local', label: '本机识别（macOS）' },
  { id: 'aliyun',  label: '阿里云百炼' },
  { id: 'volcengine', label: '火山豆包' },
  { id: 'tencent', label: '腾讯云' },
  { id: 'xunfei',  label: '科大讯飞' },
]

const ASR_FIELDS = {
  local: [],
  aliyun:  [{ key: 'aliyunApiKey',   label: 'API Key',   type: 'password', ph: 'sk-xxxxxxxx...' }],
  volcengine: [
    { key: 'volcAsrApiKey', label: 'API Key', type: 'password', ph: '' },
  ],
  tencent: [
    { key: 'tencentSecretId',  label: 'SecretId',  type: 'password', ph: '' },
    { key: 'tencentSecretKey', label: 'SecretKey', type: 'password', ph: '' },
    { key: 'tencentAppId',     label: 'AppId',     type: 'text',     ph: '' },
  ],
  xunfei: [
    { key: 'xunfeiAppId',     label: 'AppID',     type: 'text',     ph: '' },
    { key: 'xunfeiApiKey',    label: 'APIKey',    type: 'password', ph: '' },
    { key: 'xunfeiApiSecret', label: 'APISecret', type: 'password', ph: '' },
  ],
}

const TTS_PROVIDER_DEFS = [
  { id: 'doubao',     label: '豆包方舟' },
  { id: 'minimax',    label: 'MiniMax' },
  { id: 'openai',     label: 'OpenAI' },
  { id: 'elevenlabs', label: 'ElevenLabs' },
  { id: 'volcano',    label: '火山引擎' },
]

const TTS_FIELDS = {
  doubao: [
    { key: 'doubaoKey',    label: 'API Key',       type: 'password', ph: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' },
    { key: 'doubaoResourceId', label: 'Resource ID', type: 'text',     ph: 'seed-tts-2.0' },
  ],
  minimax: [],
  openai: [
    { key: 'openaiTtsKey',    label: 'API Key',          type: 'password', ph: 'sk-...' },
    { key: 'openaiTtsBaseURL', label: 'Base URL（可选）', type: 'text',     ph: 'https://api.openai.com' },
  ],
  elevenlabs: [{ key: 'elevenLabsKey', label: 'API Key', type: 'password', ph: '' }],
  volcano: [
    { key: 'volcanoAppId', label: 'AppID', type: 'text',     ph: '' },
    { key: 'volcanoToken', label: 'Token', type: 'password', ph: '' },
  ],
}

let cfgAsrProvider = 'aliyun'
let cfgTtsProvider = 'doubao'
let cfgVoiceState  = {}
let cfgTtsState    = {}

async function fetchConfigState() {
  try {
    const [vRes, tRes] = await Promise.all([
      fetch(apiUrl('/settings/voice')),
      fetch(apiUrl('/settings/tts')),
    ])
    if (vRes.ok) {
      cfgVoiceState = (await vRes.json()).voice || {}
      if (cfgVoiceState.voiceProvider) cfgAsrProvider = cfgVoiceState.voiceProvider
    }
    if (tRes.ok) {
      const td = await tRes.json()
      cfgTtsState = td.tts || {}
      if (cfgTtsState.ttsProvider) cfgTtsProvider = cfgTtsState.ttsProvider
    }
  } catch {}
}

function isConfigured(state, key) {
  const v = state[key]
  if (!v) return false
  if (typeof v === 'object') return !!v.configured
  return !!v
}

function renderProviderTabs(defs, activeId, onSwitch) {
  return `<div class="dpc-tabs">${defs.map(p => `
    <button class="dpc-tab${p.id === activeId ? ' dpc-tab-active' : ''}" data-pid="${p.id}" type="button">${p.label}</button>
  `).join('')}</div>`
}

function renderFields(fields, state, emptyMessage = 'MiniMax TTS 使用与 LLM 相同的 API Key，无需额外配置。<br>确保 LLM 已设置 MiniMax 密钥即可。') {
  if (!fields || fields.length === 0) {
    return `<div class="dpc-info">${emptyMessage}</div>`
  }
  return fields.map(f => {
    const configured = isConfigured(state, f.key)
    const configuredBadge = configured ? '<span class="dpc-badge">✓ 已配置</span>' : ''
    if (f.type === 'select') {
      const val = state[f.key] || f.ph || f.options[0]
      return `<div class="dpc-field">
        <label class="dpc-label">${f.label}</label>
        <select class="dpc-select" data-key="${f.key}">
          ${f.options.map(o => `<option value="${o}"${o === val ? ' selected' : ''}>${o}</option>`).join('')}
        </select>
      </div>`
    }
    return `<div class="dpc-field">
      <label class="dpc-label">${f.label}${configuredBadge}</label>
      <input class="dpc-input${configured ? ' dpc-input-configured' : ''}" data-key="${f.key}"
        type="${f.type}" placeholder="${configured ? '（已配置，留空不修改）' : f.ph}" autocomplete="off">
    </div>`
  }).join('')
}

function renderAsrFields(providerId) {
  const emptyMessage = providerId === 'local'
    ? '使用 macOS 本地 Speech.framework，无需填写云端密钥。'
    : '当前识别服务商无需额外配置。'
  return renderFields(ASR_FIELDS[providerId], cfgVoiceState, emptyMessage)
}

function buildConfigHTML(topicId) {
  if (topicId === 'voice_asr') {
    return `
      <div class="dpc-section-title">⚡ 在此直接配置语音识别</div>
      ${renderProviderTabs(ASR_PROVIDER_DEFS, cfgAsrProvider)}
      <div class="dpc-fields" id="dpc-asr-fields">${renderAsrFields(cfgAsrProvider)}</div>
      <div class="dpc-actions">
        <button class="dpc-save-btn" id="dpc-save-btn" type="button">保存配置</button>
        <span class="dpc-status" id="dpc-status"></span>
      </div>`
  }
  if (topicId === 'voice_tts') {
    return `
      <div class="dpc-section-title">⚡ 在此直接配置语音合成</div>
      ${renderProviderTabs(TTS_PROVIDER_DEFS, cfgTtsProvider)}
      <div class="dpc-fields" id="dpc-tts-fields">${renderFields(TTS_FIELDS[cfgTtsProvider], cfgTtsState)}</div>
      <div class="dpc-actions">
        <button class="dpc-save-btn" id="dpc-save-btn" type="button">保存配置</button>
        <span class="dpc-status" id="dpc-status"></span>
      </div>`
  }
  if (topicId === 'voice_config') {
    return `
      <div class="dpc-section-title">⚡ 快速配置</div>
      <div class="dpc-dual">
        <div class="dpc-dual-col">
          <div class="dpc-dual-label">🎤 语音识别</div>
          ${renderProviderTabs(ASR_PROVIDER_DEFS, cfgAsrProvider)}
          <div class="dpc-fields" id="dpc-asr-fields">${renderAsrFields(cfgAsrProvider)}</div>
          <div class="dpc-actions">
            <button class="dpc-save-btn" id="dpc-asr-save-btn" type="button">保存 ASR</button>
            <span class="dpc-status" id="dpc-asr-status"></span>
          </div>
        </div>
        <div class="dpc-dual-col">
          <div class="dpc-dual-label">🔊 语音合成</div>
          ${renderProviderTabs(TTS_PROVIDER_DEFS, cfgTtsProvider)}
          <div class="dpc-fields" id="dpc-tts-fields">${renderFields(TTS_FIELDS[cfgTtsProvider], cfgTtsState)}</div>
          <div class="dpc-actions">
            <button class="dpc-save-btn" id="dpc-tts-save-btn" type="button">保存 TTS</button>
            <span class="dpc-status" id="dpc-tts-status"></span>
          </div>
        </div>
      </div>`
  }
  return ''
}

function collectFieldValues(containerEl) {
  const body = {}
  containerEl.querySelectorAll('[data-key]').forEach(el => {
    const val = el.value?.trim()
    if (val) body[el.dataset.key] = val
  })
  return body
}

async function saveConfig(endpoint, body, statusEl) {
  if (!statusEl) return
  if (Object.keys(body).length === 0) { statusEl.textContent = '没有填写内容'; return }
  statusEl.textContent = '保存中...'
  statusEl.className = 'dpc-status'
  try {
    const res = await fetch(apiUrl(endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (data.ok) {
      statusEl.textContent = '✓ 已保存'
      statusEl.className = 'dpc-status dpc-status-ok'
      await fetchConfigState()
    } else {
      statusEl.textContent = `✗ ${data.error || '保存失败'}`
      statusEl.className = 'dpc-status dpc-status-err'
    }
  } catch (e) {
    statusEl.textContent = '✗ 请求失败'
    statusEl.className = 'dpc-status dpc-status-err'
  }
  setTimeout(() => { if (statusEl) statusEl.textContent = '' }, 3000)
}

function bindConfigForm(topicId) {
  const cfgEl = $('dp-config')
  if (!cfgEl) return

  // 绑定 provider tab 切换
  cfgEl.querySelectorAll('.dpc-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const pid = btn.dataset.pid
      const isAsr = ASR_FIELDS[pid] !== undefined
      const isTts = TTS_FIELDS[pid] !== undefined

      if (isAsr && topicId === 'voice_asr') {
        cfgAsrProvider = pid
        const fieldsEl = $('dpc-asr-fields')
        if (fieldsEl) fieldsEl.innerHTML = renderAsrFields(pid)
      } else if (isTts && topicId === 'voice_tts') {
        cfgTtsProvider = pid
        const fieldsEl = $('dpc-tts-fields')
        if (fieldsEl) fieldsEl.innerHTML = renderFields(TTS_FIELDS[pid], cfgTtsState)
      } else if (topicId === 'voice_config') {
        if (isAsr) {
          cfgAsrProvider = pid
          const fieldsEl = $('dpc-asr-fields')
          if (fieldsEl) fieldsEl.innerHTML = renderAsrFields(pid)
        } else if (isTts) {
          cfgTtsProvider = pid
          const fieldsEl = $('dpc-tts-fields')
          if (fieldsEl) fieldsEl.innerHTML = renderFields(TTS_FIELDS[pid], cfgTtsState)
        }
      }
      cfgEl.querySelectorAll('.dpc-tab').forEach(b => {
        b.classList.toggle('dpc-tab-active', b.dataset.pid === pid)
      })
    })
  })

  // 绑定保存按钮
  const singleSave = $('dpc-save-btn')
  if (singleSave) {
    singleSave.addEventListener('click', async () => {
      const isAsr = topicId === 'voice_asr'
      const endpoint = isAsr ? '/settings/voice' : '/settings/tts'
      const fieldsId = isAsr ? 'dpc-asr-fields' : 'dpc-tts-fields'
      const fieldsEl = $(fieldsId)
      if (!fieldsEl) return
      const body = collectFieldValues(fieldsEl)
      if (isAsr) body.voiceProvider = cfgAsrProvider
      if (!isAsr) body.ttsProvider = cfgTtsProvider
      await saveConfig(endpoint, body, $('dpc-status'))
    })
  }

  const asrSave = $('dpc-asr-save-btn')
  if (asrSave) {
    asrSave.addEventListener('click', async () => {
      const fieldsEl = $('dpc-asr-fields')
      if (fieldsEl) {
        const body = collectFieldValues(fieldsEl)
        body.voiceProvider = cfgAsrProvider
        await saveConfig('/settings/voice', body, $('dpc-asr-status'))
      }
    })
  }

  const ttsSave = $('dpc-tts-save-btn')
  if (ttsSave) {
    ttsSave.addEventListener('click', async () => {
      const fieldsEl = $('dpc-tts-fields')
      if (fieldsEl) {
        const body = collectFieldValues(fieldsEl)
        body.ttsProvider = cfgTtsProvider
        await saveConfig('/settings/tts', body, $('dpc-tts-status'))
      }
    })
  }
}

async function renderInlineConfig(topicId) {
  const cfgEl = $('dp-config')
  if (!cfgEl) return
  await fetchConfigState()
  cfgEl.innerHTML = buildConfigHTML(topicId)
  bindConfigForm(topicId)
}

// ── 初始化 ────────────────────────────────────────────────────────────────────

// Tab 分组：把"配置类"（需要动手填 Key）与"关于Jarvis"（讲解型自知识）分开，
// 顺序即展示顺序。topic 不存在于 /docs 时自动跳过，无需手动同步。
const TAB_GROUPS = [
  { label: '配置', topics: ['model_config', 'voice_asr', 'voice_tts', 'voice_config', 'wechat_config'] },
  { label: '关于Jarvis', topics: ['self_architecture', 'ui_design'] },
]

// Tab 上的短标签（文档 title 太长，pill 放不下）；缺省回退到 title。
const TAB_SHORT_LABELS = {
  model_config: '模型',
  voice_asr: '语音识别',
  voice_tts: '语音合成',
  voice_config: '语音配置',
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

  // 数据化渲染 Tab（分组 + 自动包含新主题）
  await renderTabs()
}
