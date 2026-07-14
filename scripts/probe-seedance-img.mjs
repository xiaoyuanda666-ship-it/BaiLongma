// 测试 Seedance 图生视频是否接受 base64 data: URL 作为 image_url。
// 只看 create 返回（200=接受 / 4xx=拒绝），不等完整生成，省额度。
import fs from 'fs'
import path from 'path'

const CONFIG = path.join(process.env.APPDATA, 'Jarvis', 'config.json')
const seed = JSON.parse(fs.readFileSync(CONFIG, 'utf-8')).seedance || {}
const apiKey = String(seed.apiKey || '').trim()
const model = String(seed.model || '').trim() || 'doubao-seedance-2-0-260128'
const baseURL = String(seed.baseURL || '').trim() || 'https://ark.cn-beijing.volces.com/api/v3'

const imgPath = process.argv[2] || 'src/ui/brain-ui/vendor/earth/earth_atmos_2048.jpg'
const abs = path.resolve('D:/claude/BaiLongma', imgPath)
const bytes = fs.readFileSync(abs)
const ext = path.extname(abs).slice(1).toLowerCase().replace('jpg', 'jpeg')
const dataUrl = `data:image/${ext};base64,${bytes.toString('base64')}`
console.log('image    :', imgPath, `(${(bytes.length/1024).toFixed(0)} KB → dataURL ${(dataUrl.length/1024).toFixed(0)} KB)`)

const body = {
  model,
  content: [
    { type: 'text', text: '镜头缓慢拉远，云层流动，电影感' },
    { type: 'image_url', image_url: { url: dataUrl } },
  ],
  ratio: '16:9', resolution: '720p', duration: 5,
}

const res = await fetch(`${baseURL}/contents/generations/tasks`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(60000),
})
const data = await res.json().catch(() => ({}))
console.log('create   : HTTP', res.status)
console.log(JSON.stringify(data, null, 2))
if (res.ok && (data.id || data.task_id)) {
  console.log('\n>>> base64 data: URL 被接受 ✓（task', data.id || data.task_id, '已创建，不等生成）')
} else {
  console.log('\n>>> base64 被拒绝或出错 ✗ —— 看上面 error.message')
}
