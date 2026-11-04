import { API } from './api-client.js'
import { getLocale } from './i18n/index.js'

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
export function initSearchSettings() {
  const root = document.getElementById('search-settings-root')
  let state, dirty = false, busy = false
  const tr = (zh, en) => getLocale() === 'en-US' ? en : zh
  const options = (items, selected) => items.map(([value, label]) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`).join('')
  async function request(path, body) {
    const response = await fetch(`${API}${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
    const data = await response.json()
    if (!response.ok || !data.ok) throw new Error(data.error || tr('请求失败', 'Request failed'))
    return data
  }
  function feedback(text) { root.querySelector('[data-feedback]').textContent = text }
  function render() {
    const targets = state.connections.filter(item => item.enabled).map(item => [item.id, item.name])
    root.innerHTML = `<div class="settings-section"><div class="settings-section-label">${tr('搜索服务', 'Search services')}</div>
      <p>${tr('搜索独立于聊天模型。本页修改需要点击“保存搜索设置”。空白 Key 保留已保存的密钥。', 'Search is independent of the chat model. Use Save search settings to apply changes. A blank key preserves the saved key.')}</p>
      <div data-connections>${state.connections.map(item => `<fieldset data-id="${esc(item.id)}" style="margin:12px 0;padding:12px;display:grid;gap:8px">
        <legend>${esc(item.id)}</legend>
        <label><input data-field="enabled" type="checkbox" ${item.enabled ? 'checked' : ''}> ${tr('启用', 'Enabled')}</label>
        <label>${tr('名称', 'Name')} <input class="settings-input" data-field="name" value="${esc(item.name)}"></label>
        <span>${esc(item.adapter)} · ${item.configured ? tr('凭证已配置', 'Credentials configured') : tr('缺少凭证', 'Credentials missing')}</span>
        <label>${tr('凭证来源', 'Credentials')} <select class="settings-select" data-field="credentialSource">${options([['secret', tr('专用 API Key', 'Dedicated API key')], ...(item.adapter !== 'tencent-yuanbao' ? [['llm', tr('复用同厂商模型凭证', 'Reuse official model credentials')]] : [])], item.credentialSource)}</select></label>
        ${item.credentialSource === 'secret' ? `<label>API Key <input class="settings-input" type="password" autocomplete="new-password" data-field="apiKey" value="${esc(item.apiKey || '')}"></label>` : ''}
        ${item.adapter === 'openai' ? `<label>${tr('搜索模型', 'Search model')} <input class="settings-input" data-field="model" value="${esc(item.model)}"></label>` : ''}
        <div><button type="button" class="settings-btn" data-test="${esc(item.id)}">${tr('测试已保存连接（会发起搜索）', 'Test saved connection (runs a search)')}</button>
        <button type="button" class="settings-btn" data-remove="${esc(item.id)}">${tr('移除', 'Remove')}</button></div>
      </fieldset>`).join('')}</div>
      <select class="settings-select" data-adapter>${options(state.adapters.map(item => [item.id, item.name]), 'tencent-yuanbao')}</select>
      <button type="button" class="settings-btn" data-add>${tr('添加搜索连接', 'Add connection')}</button></div>
      <div class="settings-section"><label>${tr('默认搜索服务', 'Default search service')} <select class="settings-select" data-default>${options([['auto', tr('自动（第一个启用连接）', 'Auto (first enabled connection)')], ...targets], state.defaultProvider)}</select></label></div>
      <div class="settings-section"><div class="settings-section-label">${tr('场景偏好（按顺序匹配第一条）', 'Preferences (first matching rule wins)')}</div>
      ${state.rules.map((rule, index) => `<div data-rule="${index}" style="display:flex;gap:6px;margin:8px 0;flex-wrap:wrap">
        <select class="settings-select" data-rule-field="field">${options([['language', tr('语言 zh / en', 'Language zh / en')], ['topic', tr('主题 general / news / technical / academic', 'Topic general / news / technical / academic')], ['domain', tr('目标域名', 'Target domain')]], rule.field)}</select>
        <input class="settings-input" aria-label="${tr('匹配值', 'Match value')}" data-rule-field="value" value="${esc(rule.value)}">
        <select class="settings-select" data-rule-field="provider">${options(targets, rule.provider)}</select>
        <button type="button" class="settings-btn" data-delete-rule="${index}">×</button></div>`).join('')}
      <button type="button" class="settings-btn" data-add-rule>${tr('添加规则', 'Add rule')}</button></div>
      <div class="settings-section"><label><input type="checkbox" data-fallback ${state.fallback.enabled ? 'checked' : ''}> ${tr('遇到超时、限流或服务错误时尝试备用服务', 'Use fallbacks on timeout, rate limit or service errors')}</label>
      <label>${tr('备用连接 ID，逗号分隔，按顺序尝试（最多 5 个）', 'Fallback connection IDs, comma separated, in order (max 5)')}<input class="settings-input" data-fallback-ids value="${esc(state.fallback.providers.join(', '))}"></label></div>
      <button type="button" class="settings-btn" data-save>${tr('保存搜索设置', 'Save search settings')}</button>
      <span class="settings-feedback" role="status" data-feedback></span>`
  }
  async function load() {
    if (!root || dirty || busy) return
    busy = true
    try { state = (await request('/settings/search')).search; render() }
    catch (error) { root.textContent = error.message }
    finally { busy = false }
  }
  root?.addEventListener('input', event => {
    const target = event.target
    const row = target.closest('[data-id]')
    if (row && target.dataset.field) {
      const item = state.connections.find(item => item.id === row.dataset.id)
      item[target.dataset.field] = target.type === 'checkbox' ? target.checked : target.value
      if (target.dataset.field === 'credentialSource') item.llmProvider = item.adapter
      if (target.dataset.field === 'enabled' && !item.enabled) {
        if (state.defaultProvider === item.id) state.defaultProvider = 'auto'
        state.rules = state.rules.filter(rule => rule.provider !== item.id)
        state.fallback.providers = state.fallback.providers.filter(id => id !== item.id)
      }
    }
    const ruleRow = target.closest('[data-rule]')
    if (ruleRow && target.dataset.ruleField) state.rules[Number(ruleRow.dataset.rule)][target.dataset.ruleField] = target.value
    if (target.matches('[data-default]')) state.defaultProvider = target.value
    if (target.matches('[data-fallback]')) state.fallback.enabled = target.checked
    if (target.matches('[data-fallback-ids]')) state.fallback.providers = target.value.split(',').map(value => value.trim()).filter(Boolean)
    if (target.matches('[data-adapter]')) return
    dirty = true
    if (target.dataset.field === 'credentialSource' || target.dataset.field === 'enabled') render()
    feedback(tr('尚未保存', 'Unsaved changes'))
  })
  root?.addEventListener('click', async event => {
    const button = event.target.closest('button')
    if (!button || !state || busy) return
    if (button.hasAttribute('data-add')) {
      const adapter = state.adapters.find(item => item.id === root.querySelector('[data-adapter]').value)
      state.connections.push({ id: `search-${crypto.randomUUID().slice(0, 8)}`, adapter: adapter.id, name: adapter.name, enabled: true, credentialSource: 'secret', baseURL: adapter.baseURL, model: adapter.model })
    } else if (button.dataset.remove) {
      const id = button.dataset.remove
      state.connections = state.connections.filter(item => item.id !== id)
      if (state.defaultProvider === id) state.defaultProvider = 'auto'
      state.rules = state.rules.filter(rule => rule.provider !== id)
      state.fallback.providers = state.fallback.providers.filter(value => value !== id)
    } else if (button.hasAttribute('data-add-rule')) {
      const target = state.connections.find(item => item.enabled)
      if (!target) return
      state.rules.push({ field: 'language', value: 'zh', provider: target.id })
    } else if (button.hasAttribute('data-delete-rule')) state.rules.splice(Number(button.dataset.deleteRule), 1)
    else if (button.hasAttribute('data-save') || button.dataset.test) {
      if (button.dataset.test && dirty) { feedback(tr('请先保存，再测试连接', 'Save changes before testing')); return }
      busy = true
      const controls = [...root.querySelectorAll('input, select, button')]
      controls.forEach(control => { control.disabled = true })
      feedback(tr('处理中…', 'Working…'))
      try {
        if (button.hasAttribute('data-save')) {
          state = (await request('/settings/search', state)).search; dirty = false; render(); feedback(tr('已保存', 'Saved'))
        } else {
          const result = await request('/settings/search/test', { provider: button.dataset.test })
          feedback(tr(`连接正常，返回 ${result.resultCount} 条结果`, `Connected; ${result.resultCount} results`))
        }
      } catch (error) { feedback(error.message) }
      finally { busy = false; controls.forEach(control => { control.disabled = false }) }
      return
    } else return
    dirty = true; render(); feedback(tr('尚未保存', 'Unsaved changes'))
  })
  return { load }
}
