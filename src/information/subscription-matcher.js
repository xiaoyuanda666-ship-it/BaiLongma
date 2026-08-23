function valueAtPath(root, path = '') {
  const segments = String(path || '').split('.').map(part => part.trim()).filter(Boolean)
  let value = root
  for (const segment of segments) {
    if (value == null || typeof value !== 'object') return undefined
    value = value[segment]
  }
  return value
}

export function informationTopicMatches(pattern = '', topic = '') {
  const patternParts = String(pattern || '').toLowerCase().split('.').filter(Boolean)
  const topicParts = String(topic || '').toLowerCase().split('.').filter(Boolean)
  if (patternParts.length === 0 || topicParts.length === 0) return false

  for (let index = 0; index < patternParts.length; index++) {
    const expected = patternParts[index]
    if (expected === '**') return index === patternParts.length - 1
    if (index >= topicParts.length) return false
    if (expected !== '*' && expected !== topicParts[index]) return false
  }
  return patternParts.length === topicParts.length
}

function scalarEquals(left, right) {
  if (left == null || right == null) return left === right
  if (typeof left === 'number' && typeof right === 'number') return left === right
  if (typeof left === 'boolean' && typeof right === 'boolean') return left === right
  return String(left) === String(right)
}

export function informationFilterMatches(filter = {}, item = {}) {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return false
  if (Object.keys(filter).length === 0) return true

  if (Array.isArray(filter.all)) return filter.all.every(child => informationFilterMatches(child, item))
  if (Array.isArray(filter.any)) return filter.any.some(child => informationFilterMatches(child, item))
  if (filter.not && typeof filter.not === 'object') return !informationFilterMatches(filter.not, item)

  const op = String(filter.op || '').trim().toLowerCase()
  const actual = valueAtPath(item, filter.path)
  if (op === 'exists') return filter.value === false ? actual === undefined : actual !== undefined
  if (op === 'eq') return scalarEquals(actual, filter.value)
  if (op === 'neq') return !scalarEquals(actual, filter.value)
  if (op === 'in') return Array.isArray(filter.values) && filter.values.some(value => scalarEquals(actual, value))
  if (op === 'prefix') return typeof actual === 'string' && actual.startsWith(String(filter.value || ''))
  if (op === 'contains') {
    if (typeof actual === 'string') return actual.includes(String(filter.value || ''))
    if (Array.isArray(actual)) return actual.some(value => scalarEquals(value, filter.value))
    return false
  }
  return false
}

function informationScopeMatches(scope = {}, item = {}) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return false
  for (const [key, expected] of Object.entries(scope)) {
    if (expected === '' || expected == null) continue
    const actual = valueAtPath(item.subject || {}, key)
    if (Array.isArray(expected)) {
      if (!expected.some(value => scalarEquals(actual, value))) return false
    } else if (!scalarEquals(actual, expected)) {
      return false
    }
  }
  return true
}

export function informationRouteMatches(route = {}, item = {}) {
  if (route.enabled === false) return false
  if (route.activation?.type && route.activation.type !== 'event') return false
  if (!informationTopicMatches(route.topicPattern, item.topic)) return false
  if (!informationScopeMatches(route.scope || {}, item)) return false
  return informationFilterMatches(route.filter || {}, item)
}
