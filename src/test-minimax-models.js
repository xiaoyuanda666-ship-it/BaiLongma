// 最小单测：MiniMax-M3 模型条目存在、默认模型未变。
// 镜像 test-tool-protocol.js 模式：import + node:assert/strict + console.log。
// Run: node src/test-minimax-models.js

import assert from 'node:assert/strict'
import { MINIMAX_MODELS, DEFAULT_MINIMAX_MODEL } from './config.js'

const m3 = MINIMAX_MODELS.find(m => m.id === 'MiniMax-M3')

assert.ok(m3, 'MINIMAX_MODELS should contain MiniMax-M3')
assert.equal(m3.deprecated, false, 'MiniMax-M3 should not be marked deprecated')
assert.equal(
  m3.label,
  'MiniMax-M3',
  'MiniMax-M3 label should match its id (naming convention)',
)

// 加 M3 不能误改默认模型（M3 是可选项，默认仍是 M2.7）
assert.equal(
  DEFAULT_MINIMAX_MODEL,
  'MiniMax-M2.7',
  'default MiniMax model must remain MiniMax-M2.7 (M3 is opt-in only)',
)

console.log('test-minimax-models passed')
