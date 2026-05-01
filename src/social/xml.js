export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function parseSimpleXml(xml) {
  const out = {}
  const text = String(xml || '')
  const re = /<([A-Za-z0-9_:-]+)><!\[CDATA\[([\s\S]*?)\]\]><\/\1>|<([A-Za-z0-9_:-]+)>([^<]*)<\/\3>/g
  let match
  while ((match = re.exec(text))) {
    const key = match[1] || match[3]
    out[key] = match[2] ?? match[4] ?? ''
  }
  return out
}
