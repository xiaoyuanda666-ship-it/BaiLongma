import { getLocalResourcesBlock } from '../local-resources-scanner.js'
import { getInstalledSoftwareBlock } from '../installed-software-scanner.js'
import { buildWeatherRuntimeContext } from '../weather.js'
import { loadContextRules } from './rule-store.js'

function ruleMatches(rule, text) {
  for (const pattern of rule.patterns || []) {
    try {
      if (new RegExp(pattern, 'i').test(text)) return true
    } catch {
      if (text.toLowerCase().includes(String(pattern || '').toLowerCase())) return true
    }
  }
  return false
}

async function providerBlock(rule, text) {
  if (rule.provider === 'local_resources') {
    const block = getLocalResourcesBlock()
    if (!block) return ''
    return `${block}

This block was injected because the current message matched a local-resource rule. Use it to act without asking for credentials, but do not quote hostnames, IP addresses, key names, or connection details back to the user unless they explicitly ask for those exact details.`
  }
  if (rule.provider === 'installed_software') {
    const block = getInstalledSoftwareBlock()
    if (!block) return ''
    return `${block}

This block was injected because the current message mentioned software, apps, clients, VPN/proxy tools, or a likely local application. Use it as local evidence before guessing.`
  }
  if (rule.provider === 'static_text') {
    return String(rule.context || rule.action?.context || '').trim()
  }
  if (rule.provider === 'weather') {
    return await buildWeatherRuntimeContext(text)
  }
  return ''
}

function shouldDedupeProvider(provider = '') {
  return ['local_resources', 'installed_software', 'weather'].includes(provider)
}

export async function runContextRuleEngine(message = '', { excludedProviders = [] } = {}) {
  const text = String(message || '')
  if (!text.trim()) return ''

  const matchedBlocks = []
  const seenProviders = new Set()
  const excluded = new Set((Array.isArray(excludedProviders) ? excludedProviders : []).map(String))

  for (const rule of loadContextRules()) {
    if (!rule.enabled || rule.status === 'draft') continue
    if (excluded.has(rule.provider)) continue
    if (!ruleMatches(rule, text)) continue
    if (shouldDedupeProvider(rule.provider) && seenProviders.has(rule.provider)) continue
    const block = await providerBlock(rule, text)
    if (!block) continue
    if (shouldDedupeProvider(rule.provider)) seenProviders.add(rule.provider)
    matchedBlocks.push(`<rule-context id="${rule.id}" provider="${rule.provider}">
${block}
</rule-context>`)
  }

  return matchedBlocks.join('\n\n')
}
