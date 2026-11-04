export function selectSearchRoute(settings, args = {}, context = {}) {
  const enabled = settings.connections.filter(item => item.enabled)
  const find = id => enabled.find(item => item.id === id) || enabled.find(item => item.adapter === id)
  const explicit = args.provider && args.provider !== 'auto'
  let selected, reason
  if (explicit) { selected = find(args.provider); reason = 'explicit' }
  else if (context.searchProvider) { selected = find(context.searchProvider); reason = 'task_preference' }
  else {
    const language = args.language || (/\p{Script=Han}/u.test(args.query || '') ? 'zh' : 'en')
    const topic = args.topic || 'general'
    const rule = settings.rules.find(rule => rule.field === 'language' ? rule.value === language
      : rule.field === 'topic' ? rule.value === topic
      : (args.domains || []).some(domain => domain.toLowerCase() === rule.value || domain.toLowerCase().endsWith(`.${rule.value}`)))
    if (rule) { selected = find(rule.provider); reason = `matched_rule:${rule.id}` }
    else if (settings.defaultProvider !== 'auto') { selected = find(settings.defaultProvider); reason = 'default' }
    else { selected = enabled.find(item => item.configured !== false); reason = 'auto' }
  }
  if (!selected) return { connections: [], reason: reason || 'not_configured' }
  const candidates = [selected]
  if (!explicit && !context.searchProvider && settings.fallback.enabled) {
    for (const id of settings.fallback.providers) {
      const item = find(id)
      if (item && !candidates.some(other => other.id === item.id)) candidates.push(item)
    }
  }
  return { connections: candidates, reason }
}
