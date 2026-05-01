// 用 Node 发一条天气查询给 Agent，避免 Windows curl 中文编码问题
const body = JSON.stringify({
  from_id: 'ID:000001',
  content: '帮我看一下北京今天的天气，用卡片显示',
  channel: 'API'
})

const res = await fetch('http://127.0.0.1:3721/message', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body
})
console.log('HTTP', res.status, await res.text())
