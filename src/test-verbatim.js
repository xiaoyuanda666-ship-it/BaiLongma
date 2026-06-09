import assert from 'assert/strict'
import {
  extractVerbatimPayload,
  findRecentVerbatimPayload,
  hasInlineVerbatimPayload,
  isVerbatimOutputRequest,
  isVerbatimSetup,
  isVerbatimStart,
} from './runtime/verbatim.js'

const original = '安装了白龙马智能体的朋友危险了，今天发现了一个很严重的问题。 数据安全永远第一。'
const originalWithSpacing = '第一句。  第二句。\n第三句。'
const setup = `帮我读一段文字，我要录音，用严肃的声音：${original}一会你要一字不差的repect这句话，明白吗，我说开始你才开始`

assert.equal(extractVerbatimPayload(setup), original)
assert.equal(extractVerbatimPayload(`帮我读一段文字：${originalWithSpacing}一会你要一字不差地 repeat`), originalWithSpacing)
assert.equal(isVerbatimSetup(setup), true)
assert.equal(isVerbatimSetup('你看到上面那段话了吗？回复出来，一字不差'), false)
assert.equal(isVerbatimStart('开始'), true)
assert.equal(isVerbatimStart('开始。'), true)
assert.equal(isVerbatimOutputRequest('你看到上面那段话了吗？回复出来，一字不差'), true)
assert.equal(hasInlineVerbatimPayload('请原样输出：第一句。'), true)
assert.equal(hasInlineVerbatimPayload('你看到上面那段话了吗？回复出来，一字不差'), false)

const rows = [
  { role: 'user', from_id: 'user', timestamp: '1', content: original },
  { role: 'jarvis', content: '收到' },
  { role: 'user', from_id: 'user', timestamp: '2', content: '你看到上面那段话了吗？回复出来，一字不差' },
]
assert.equal(findRecentVerbatimPayload(rows, { fromId: 'user', timestamp: '2', content: rows[2].content }), original)

console.log('test-verbatim ok')
