import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyActionContract, actionContractCompletionIssue } from './runtime/action-contract.js'

test('real capture-and-read request preserves navigation and discovery', () => {
  const contract = classifyActionContract('使用 browser 工具打开 https://example.com，读取标题和正文，截图并在聊天里展示。不要使用命令行。完成后报告实际结果。')
  assert.equal(contract.id, 'browser_screenshot')
  assert.notEqual(contract.restrictTools, true)
  assert.ok(contract.requiredTools.includes('browser_navigate'))
  assert.ok(contract.requiredTools.includes('browser_snapshot'))
  assert.ok(contract.requiredTools.includes('browser_take_screenshot'))
  assert.match(actionContractCompletionIssue(contract, '截图已发送。', {
    successfulToolEvidence: [{ name: 'browser_take_screenshot', result: JSON.stringify({ ok: true, screenshot: { image_path: '/tmp/capture.png' } }) }],
  }), /not delivered/i)
})

test('negated screenshot never mandates screenshot capture', () => {
  for (const text of [
    '请只用 browser_navigate 打开 https://example.com，然后用 browser_snapshot 读取页面标题和正文，不截图。',
    '不截图', '不要截图', '不用截屏', '请读取网页，不要截图',
    "read this page, don't take a screenshot",
  ]) assert.notEqual(classifyActionContract(text)?.id, 'browser_screenshot', text)
})

test('standalone screenshot retains narrow scope and combined opening does not', () => {
  for (const text of ['把当前页面截张图发给我看看', '截图并在聊天里展示', 'take a screenshot']) {
    const contract = classifyActionContract(text)
    assert.equal(contract.id, 'browser_screenshot', text)
    assert.equal(contract.restrictTools, true, text)
    assert.deepEqual(contract.requiredTools, ['browser_take_screenshot'])
  }
  assert.notEqual(classifyActionContract('打开 https://example.com，然后截图').restrictTools, true)
  assert.notEqual(classifyActionContract('截图之后解释页面主要内容').restrictTools, true)
})
