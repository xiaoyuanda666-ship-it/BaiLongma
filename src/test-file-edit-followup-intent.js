import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyActionContract } from './runtime/action-contract.js'

const messages = [
  '最终表单验收：打开 https://httpbin.org/forms/post，把 Customer name 先替换成 Test，再追加 123，确认 Test123，再替换成 Final140。电话填 0000000000，邮箱填 test@example.com。只填测试数据，不提交表单。完成后截图发到聊天。',
  '用 browser_navigate 打开 https://httpbin.org/forms/post。用 browser_type 将 Customer name 替换为 Test，再追加 123，再替换为 Final140；用 browser_fill_form 填电话 0000000000 和邮箱 test@example.com。不要提交表单。最后截图发给我。',
]

test('real form requests keep browser tools after JSON page results', () => {
  const conversationWindow = [{ role: 'assistant', content: '两个都打开了，按顺序走的。https://httpbin.org/delay/10?test=140cancel 等满 10 秒后正常返回，回显 JSON 里 args.test = "140cancel"，说明没被取消。' }]
  for (const message of messages) {
    const contract = classifyActionContract(message, { conversationWindow })
    assert.equal(contract.id, 'browser_screenshot')
    assert.notEqual(contract.restrictTools, true)
    assert.ok(contract.requiredTools.includes('browser_navigate'))
    assert.ok(contract.requiredTools.includes('browser_take_screenshot'))
  }
})

test('explicit browser form work overrides unrelated prior local file evidence', () => {
  for (const content of ['read_file 已读取 self_check.txt', '已保存 sandbox/page.html']) {
    for (const message of messages) assert.notEqual(classifyActionContract(message, {
      conversationWindow: [{ role: 'assistant', content }],
    })?.id, 'file_edit')
  }
})

test('bare formats and remote URLs do not establish local files', () => {
  for (const content of ['页面返回 JSON 回显', '这里展示 HTML 和 CSS', '打开了 https://example.com/index.html']) {
    assert.equal(classifyActionContract('把按钮改成绿色，其他别动。', {
      conversationWindow: [{ role: 'assistant', content }],
    }), null)
  }
})

test('real file continuation still accepts concrete paths and file-tool evidence', () => {
  for (const content of ['已经保存为个人主页.html。', '已读取 /tmp/project/page.html', 'read_file 成功读取内容']) {
    const contract = classifyActionContract('把按钮改成绿色，其他别动。', {
      conversationWindow: [{ role: 'assistant', content }],
    })
    assert.equal(contract.id, 'file_edit')
    assert.deepEqual(contract.requiredTools, ['read_file', 'edit_file'])
    assert.equal(contract.restrictTools, true)
  }
  assert.equal(classifyActionContract('再追加一句说明', { runtimeContext: 'edit_file' }).id, 'file_edit')
  assert.equal(classifyActionContract('帮我修改 src/app.js 文件里的一个函数').id, 'file_edit')
})
