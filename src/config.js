export const config = {
  // Tick 间隔（毫秒）
  tickInterval: 300000,

  // LLM 配置
  model: 'MiniMax-M2.7',
  apiKey: process.env.MINIMAX_API_KEY,
  baseURL: 'https://api.minimax.chat/v1',
}
