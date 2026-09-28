export function createModelConnection({ readConfig, transport } = {}) {
  if (typeof readConfig !== 'function' || typeof transport?.openStream !== 'function') {
    throw new TypeError('Model connection requires readConfig and transport.openStream ports')
  }
  return Object.freeze({
    openStream({ protocol, params, signal }) {
      // Read on each request: activation and provider/key/endpoint switches may
      // happen after module load, including between tool rounds or retries.
      const { provider, baseURL, apiKey } = readConfig()
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

