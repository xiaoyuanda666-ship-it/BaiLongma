import { deepseekWebAdapter } from './adapters/deepseek.js'
import { openaiWebAdapter } from './adapters/openai.js'
import { yuanbaoWebAdapter } from './adapters/tencent-yuanbao.js'

export const WEB_ADAPTERS = Object.freeze({ deepseek: deepseekWebAdapter, openai: openaiWebAdapter, 'tencent-yuanbao': yuanbaoWebAdapter })
export const SEARCH_PRESETS = Object.freeze({
  deepseek: { name: 'DeepSeek', baseURL: 'https://api.deepseek.com', model: '' },
  openai: { name: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-5.5' },
  'tencent-yuanbao': { name: '腾讯元宝', baseURL: 'https://api.wsa.cloud.tencent.com', model: '' },
})
