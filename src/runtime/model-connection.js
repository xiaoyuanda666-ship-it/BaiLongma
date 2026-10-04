export function createModelConnection({ readConfig, transport } = {}) {
  if (typeof readConfig !== 'function' || typeof transport?.openStream !== 'function') {
    throw new TypeError('Model connection requires readConfig and transport.openStream ports')
  }
  return Object.freeze({
    openStream({ protocol, params, signal, connection }) {
      // Keep turn-scoped snapshots stable through a tool chain. Callers without
      // a snapshot use current settings. Revocation takes effect immediately.
      const current = readConfig()
      if (!current.apiKey) throw new Error('LLM 尚未激活，请先通过激活页填入 API Key')
      const { provider, baseURL, apiKey } = connection || current
      if (!apiKey) throw new Error('LLM 尚未激活，请先通过激活页填入 API Key')
      return transport.openStream({
        connection: { provider, baseURL, apiKey },
        protocol,
        params,
        signal,
      })
    },
  })
}
