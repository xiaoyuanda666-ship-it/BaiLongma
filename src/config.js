// LLM Provider 配置
//
// 通过 LLM_PROVIDER 环境变量切换（默认 minimax）：
//   LLM_PROVIDER=minimax   → MiniMax-M2.7
//   LLM_PROVIDER=deepseek  → DeepSeek-V3.2 思考模式（deepseek-reasoner）
//   LLM_PROVIDER=openai    → OpenAI gpt-5.4
//
// 如需临时切换，在 .env 里写 LLM_PROVIDER=xxx 即可，所有 API KEY 都保留。

const PROVIDERS = {
  minimax: {
    model: 'MiniMax-M2.7',
    apiKey: process.env.MINIMAX_API_KEY,
    baseURL: 'https://api.minimax.chat/v1',
  },
  deepseek: {
    // deepseek-reasoner = DeepSeek-V3.2 思考模式；thinking=false 时会自动切到 deepseek-chat
    model: 'deepseek-reasoner',
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: 'https://api.deepseek.com/v1',
  },
  openai: {
    model: 'gpt-5.4',
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: 'https://api.openai.com/v1',
  },
}

const provider = (process.env.LLM_PROVIDER || 'minimax').toLowerCase()
const current = PROVIDERS[provider]
if (!current) {
  throw new Error(`未知 LLM_PROVIDER: "${provider}"，可选: ${Object.keys(PROVIDERS).join(', ')}`)
}
if (!current.apiKey) {
  const envVar = { minimax: 'MINIMAX_API_KEY', deepseek: 'DEEPSEEK_API_KEY', openai: 'OPENAI_API_KEY' }[provider]
  throw new Error(`缺少 ${provider} 的 API KEY 环境变量（${envVar}）`)
}

export const config = {
  // Tick 间隔（毫秒）- 二层思考器系统 TICK 固定 5 分钟
  tickInterval: 5 * 60 * 1000,

  // LLM 配置（根据 LLM_PROVIDER 选择）
  provider,
  model: current.model,
  apiKey: current.apiKey,
  baseURL: current.baseURL,
}
