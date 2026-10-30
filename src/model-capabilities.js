// Never change the conversation model merely because an image is attached.
export function supportsImageInput({ provider = '', model = '' } = {}) {
  const id = String(model).toLowerCase()
  if (/^(?:o3-mini|gpt-5-search-api)/.test(id)) return false
  if (provider === 'deepseek' || id.startsWith('deepseek-')) {
    return ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(id)
  }
  return /^(?:gpt-4o(?:-|$)|gpt-4\.1(?:-|$)|gpt-[56](?:[.-]|$)|o[34](?:-|$)|kimi-k2\.[56](?:-|$))/.test(id)
    || /(?:vision|(?:^|[-_.])vl(?:[-_.]|$)|^glm-4(?:\.\d+)?v)/.test(id)
}

export function builtinVisionConnection(connection = {}) {
  if (!connection.apiKey || !connection.baseURL) return null
  if (supportsImageInput(connection)) return { ...connection }
  if (connection.provider === 'deepseek') return { ...connection, model: 'deepseek-flash' }
  return null
}

export function supportsModelWebSearch(connection = {}) {
  if (!connection.apiKey || !connection.baseURL) return false
  return connection.provider === 'deepseek'
    || (connection.provider === 'openai' && /^(?:gpt-[56](?:[.-]|$)|gpt-4\.1(?:-|$))/.test(connection.model || '')
      && !/(?:nano|search-api)/.test(connection.model || ''))
}
