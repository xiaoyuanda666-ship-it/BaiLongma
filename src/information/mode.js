const LEGACY_MODE = 'legacy'

export function isLegacyInformationMode(env = process.env) {
  return String(env.BAILONGMA_INFORMATION_MODE || '').trim().toLowerCase() === LEGACY_MODE
}

export function configuredInformationDomains({
  env = process.env,
  key,
  defaults = [],
} = {}) {
  if (isLegacyInformationMode(env)) return new Set()

  const hasOverride = Object.prototype.hasOwnProperty.call(env, key)
  const raw = hasOverride ? String(env[key] || '').trim().toLowerCase() : ''
  if (!hasOverride) return new Set(defaults)

  return new Set(raw
    .split(/[\s,;]+/)
    .filter(Boolean))
}
