/**
 * Provider 基类
 *
 * 每个具体 Provider 需实现：
 *   - canDo(capability): boolean
 *   - call(capability, params): Promise<result>
 *   - getQuotaStatus(): object
 */
export class BaseProvider {
  constructor({ name, apiKey, baseURL }) {
    this.name = name
    this.apiKey = apiKey
    this.baseURL = baseURL
  }

  // 是否支持某项能力
  canDo(capability) {
    throw new Error(`${this.name}.canDo() not implemented`)
  }

  // 调用某项能力
  async call(capability, params) {
    throw new Error(`${this.name}.call() not implemented`)
  }

  // 返回各能力的配额状态
  getQuotaStatus() {
    return {}
  }

  // 通用 HTTP 请求辅助
  async request(path, body) {
    const url = `${this.baseURL}${path}`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
    return res.json()
  }
}
