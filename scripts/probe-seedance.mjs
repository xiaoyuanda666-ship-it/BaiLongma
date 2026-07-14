// 独立探针：用已配置的 Seedance key 直接打火山方舟 API，验证 model id / 请求体 / 轮询。
// 复刻 src/capabilities/tools/media.js 的 execGenerateVideo 请求结构。不依赖应用其它模块。
import fs from 'fs'
import path from 'path'

const CONFIG = path.join(process.env.APPDATA, 'Jarvis', 'config.json')
const DEFAULT_BASE = 'https://ark.cn-beijing.volces.com/api/v3'
const DEFAULT_MODEL = 'doubao-seedance-2-0-260128'

const seed = JSON.parse(fs.readFileSync(CONFIG, 'utf-8')).seedance || {}
const apiKey = String(seed.apiKey || '').trim()
const model = String(seed.model || '').trim() || DEFAULT_MODEL
const baseURL = String(seed.baseURL || '').trim() || DEFAULT_BASE
if (!apiKey) { console.error('no apiKey'); process.exit(1) }

const prompt = process.argv[2] || '一只橘猫在窗台上伸懒腰，阳光洒进来，电影感，镜头缓慢推近'
const body = { model, content: [{ type: 'text', text: prompt }], ratio: '16:9', resolution: '720p', duration: 5 }

console.log('=== 请求 ===')
console.log('baseURL:', baseURL)
console.log('model  :', model)
console.log('body   :', JSON.stringify(body))
console.log('')

const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }

console.log('=== 创建任务 ===')
const cRes = await fetch(`${baseURL}/contents/generations/tasks`, {
  method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
})
const cData = await cRes.json().catch(() => ({}))
console.log('HTTP', cRes.status)
console.log(JSON.stringify(cData, null, 2))

const taskId = cData.id || cData.task_id
if (!cRes.ok || !taskId) {
  console.log('\n>>> 创建失败，停止。看上面的 error.message 判断是 model id 还是 body 格式问题。')
  process.exit(0)
}

console.log('\n=== 轮询任务', taskId, '===')
const deadline = Date.now() + 6 * 60 * 1000
let n = 0
while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 5000))
  n++
  const pRes = await fetch(`${baseURL}/contents/generations/tasks/${taskId}`, {
    headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20000),
  })
  const pData = await pRes.json().catch(() => ({}))
  const status = String(pData.status || '').toLowerCase()
  console.log(`[#${n} +${n*5}s] HTTP ${pRes.status} status=${status}`)
  if (status === 'succeeded') {
    console.log('\n>>> 成功！完整返回：')
    console.log(JSON.stringify(pData, null, 2))
    console.log('\nvideo_url =', pData?.content?.video_url)
    process.exit(0)
  }
  if (['failed', 'cancelled', 'expired'].includes(status)) {
    console.log('\n>>> 失败：')
    console.log(JSON.stringify(pData, null, 2))
    process.exit(0)
  }
}
console.log('\n>>> 6 分钟超时未完成')
