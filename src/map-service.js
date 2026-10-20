import { getSecret, hasSecret, updateSecrets } from './capabilities/secret-store.js'

const PROVIDER = 'amap'
const KEY_REF = 'map-service:amap:js-key'
const SECURITY_REF = 'map-service:amap:security-code'

export function getMapServiceSettings() {
  const keyConfigured = hasSecret(KEY_REF)
  const securityConfigured = hasSecret(SECURITY_REF)
  return {
    provider: PROVIDER,
    configured: keyConfigured && securityConfigured,
    keyConfigured,
    securityConfigured,
  }
}

export function setMapServiceSettings({ jsKey, securityCode, clear = false } = {}) {
  if (clear) {
    updateSecrets([{ ref: KEY_REF, value: '' }, { ref: SECURITY_REF, value: '' }])
    return getMapServiceSettings()
  }

  const key = String(jsKey || '').trim()
  const code = String(securityCode || '').trim()
  const updates = []
  if (key) updates.push({ ref: KEY_REF, value: key })
  if (code) updates.push({ ref: SECURITY_REF, value: code })
  updateSecrets(updates)
  return getMapServiceSettings()
}

export function getMapRuntimeConfig() {
  const settings = getMapServiceSettings()
  return {
    provider: PROVIDER,
    configured: settings.configured,
    jsKey: settings.configured ? getSecret(KEY_REF) : '',
    servicePath: '/_AMapService',
  }
}

export function getAmapSecurityCode() {
  return getSecret(SECURITY_REF)
}

