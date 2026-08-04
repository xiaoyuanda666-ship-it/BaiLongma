import { apiUrl } from './api-client.js'

let active = false
let state = { regionId: '', query: '', documentId: '' }
const $ = (id) => document.getElementById(id)

function request(path) {
  return fetch(apiUrl(path)).then(async (response) => {
    const data = await response.json().catch(() => ({}))
    if (!response.ok || data.ok === false) throw new Error(data.error || `请求失败 (${response.status})`)
    return data
  })
}

function setStatus(text) {
  const el = $('kc-status')
  if (el) el.textContent = text
}

function empty(target, message) {
  if (!target) return
  target.replaceChildren()
  const el = document.createElement('div')
  el.className = 'kc-empty'
  el.textContent = message
  target.appendChild(el)
}

function text(value) { return String(value || '').trim() }

function report(source = 'brain-ui') {
  fetch(apiUrl('/knowledge-panel-state'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active, source, region_id: state.regionId, query: state.query, document_id: state.documentId }),
  }).catch(() => {})
}

function renderRegions(regions = []) {
  const target = $('kc-region-list')
  const count = $('kc-region-count')
  if (count) count.textContent = String(regions.length)
  if (!target) return
  target.replaceChildren()
  if (!regions.length) return empty(target, '暂无启用中的知识区域。请先导入资料。')
  for (const region of regions) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `kc-region${region.id === state.regionId ? ' is-active' : ''}`
    const name = document.createElement('strong')
    name.textContent = region.name || region.id
    const description = document.createElement('span')
    description.textContent = region.description || region.scope || region.id
    button.append(name, description)
    button.addEventListener('click', () => selectRegion(region.id))
    target.appendChild(button)
  }
}

function renderDocuments(documents = []) {
  const target = $('kc-document-list')
  const count = $('kc-document-count')
  if (count) count.textContent = String(documents.length)
  if (!target) return
  target.replaceChildren()
  if (!documents.length) return empty(target, '这个区域还没有可浏览的当前版本文档。')
  for (const document of documents) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `kc-document${String(document.id) === state.documentId ? ' is-active' : ''}`
    const title = document.createElement('strong')
    title.textContent = document.title || '未命名文档'
    const meta = document.createElement('span')
    meta.textContent = `v${document.version || 1} · ${document.mime_type || 'text'}`
    button.append(title, meta)
    button.addEventListener('click', () => loadDocument(document.id))
    target.appendChild(button)
  }
}

function renderResults(hits = []) {
  const target = $('kc-result-list')
  const count = $('kc-result-count')
  if (count) count.textContent = String(hits.length)
  if (!target) return
  target.replaceChildren()
  if (!hits.length) return empty(target, state.query ? '没有匹配证据。可换一种描述再试。' : '输入问题，查看可引用的证据片段。')
  for (const hit of hits) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'kc-result'
    const title = document.createElement('strong')
    title.textContent = hit.document_title || '未命名文档'
    const excerpt = document.createElement('p')
    excerpt.textContent = text(hit.text || hit.chunk_text).slice(0, 260)
    const meta = document.createElement('span')
    meta.textContent = `${hit.citation_id || '证据'} · ${hit.retrieval_method || '检索'}`
    button.append(title, excerpt, meta)
    button.addEventListener('click', () => loadDocument(hit.document_id))
    target.appendChild(button)
  }
}

function renderDocument(document) {
  const target = $('kc-detail')
  if (!target) return
  target.replaceChildren()
  if (!document) return empty(target, '选择一份文档或检索结果以查看来源和版本。')
  const title = document.createElement('h2')
  title.textContent = document.title || '未命名文档'
  const items = [
    ['知识区域', document.region_name || document.region_id || '--'],
    ['版本', `v${document.version || 1}`],
    ['格式', document.mime_type || 'text'],
    ['来源', document.source_uri || '--'],
  ]
  const list = document.createElement('dl')
  for (const [label, value] of items) {
    const dt = document.createElement('dt'); dt.textContent = label
    const dd = document.createElement('dd'); dd.textContent = value
    list.append(dt, dd)
  }
  target.append(title, list)
}

async function refreshDocuments() {
  if (!active) return
  const query = state.regionId ? `?region_id=${encodeURIComponent(state.regionId)}` : ''
  const data = await request(`/knowledge/documents${query}`)
  renderDocuments(data.documents || [])
}

async function search() {
  const query = text($('kc-search-input')?.value || state.query)
  state.query = query
  if (!query) { renderResults([]); report('brain-ui'); return }
  setStatus('正在检索可追溯证据…')
  try {
    const params = new URLSearchParams({ q: query, limit: '12' })
    if (state.regionId) params.set('region_id', state.regionId)
    const data = await request(`/knowledge/search?${params}`)
    renderResults(data.hits || [])
    setStatus(`已找到 ${data.count || 0} 条可引用证据`)
  } catch (err) {
    empty($('kc-result-list'), err.message)
    setStatus('检索失败')
  }
  report('brain-ui')
}

async function loadDocument(documentId) {
  if (!documentId) return
  state.documentId = String(documentId)
  try {
    const data = await request(`/knowledge/documents/${encodeURIComponent(state.documentId)}`)
    renderDocument(data.document)
    await refreshDocuments()
    report('brain-ui')
  } catch (err) {
    empty($('kc-detail'), err.message)
  }
}

async function selectRegion(regionId) {
  state.regionId = String(regionId || '')
  state.documentId = ''
  renderDocument(null)
  try {
    const data = await request('/knowledge/regions')
    renderRegions(data.regions || [])
    await refreshDocuments()
    if (state.query) await search()
    else report('brain-ui')
  } catch (err) { setStatus(err.message) }
}

async function refresh() {
  setStatus('正在加载知识区域…')
  try {
    const data = await request('/knowledge/regions')
    const regions = data.regions || []
    if (state.regionId && !regions.some(region => region.id === state.regionId)) state.regionId = ''
    if (!state.regionId && regions[0]) state.regionId = regions[0].id
    renderRegions(regions)
    await refreshDocuments()
    if (state.query) {
      const input = $('kc-search-input'); if (input) input.value = state.query
      await search()
    } else setStatus(regions.length ? '选择文档，或检索可引用证据' : '暂无启用中的知识区域')
    if (state.documentId) await loadDocument(state.documentId)
  } catch (err) {
    setStatus('无法加载知识脑区')
    empty($('kc-region-list'), err.message)
  }
}

export function setKnowledgeCortexMode(visible, { source = 'brain-ui', regionId, query, documentId } = {}) {
  active = Boolean(visible)
  if (regionId !== undefined) state.regionId = text(regionId)
  if (query !== undefined) state.query = text(query)
  if (documentId !== undefined) state.documentId = text(documentId)
  const panel = $('knowledge-cortex-panel')
  document.body.classList.toggle('knowledge-cortex-mode', active)
  panel?.setAttribute('aria-hidden', String(!active))
  if (active) refresh()
  report(source)
}

export function initKnowledgePanel() {
  $('kc-close')?.addEventListener('click', () => setKnowledgeCortexMode(false))
  $('kc-search-form')?.addEventListener('submit', (event) => { event.preventDefault(); search() })
}
