// 复刻 downloadGeneratedVideo：按 task id 重新取 video_url 并下载到 sandbox/videos。
import fs from 'fs'
import path from 'path'

const CONFIG = path.join(process.env.APPDATA, 'Jarvis', 'config.json')
const seed = JSON.parse(fs.readFileSync(CONFIG, 'utf-8')).seedance || {}
const apiKey = String(seed.apiKey || '').trim()
const baseURL = String(seed.baseURL || '').trim() || 'https://ark.cn-beijing.volces.com/api/v3'
const taskId = process.argv[2]
if (!taskId) { console.error('usage: node probe-seedance-download.mjs <taskId>'); process.exit(1) }

const pRes = await fetch(`${baseURL}/contents/generations/tasks/${taskId}`, {
  headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20000),
})
const pData = await pRes.json()
const videoUrl = pData?.content?.video_url
console.log('status   :', pData.status)
console.log('video_url:', videoUrl ? videoUrl.slice(0, 80) + '...' : '(none)')
if (!videoUrl) process.exit(1)

const outDir = path.resolve(process.env.APPDATA, 'Jarvis', 'sandbox', 'videos')
fs.mkdirSync(outDir, { recursive: true })
const dRes = await fetch(videoUrl, { signal: AbortSignal.timeout(120000) })
console.log('download HTTP:', dRes.status, 'content-type:', dRes.headers.get('content-type'))
const buf = Buffer.from(await dRes.arrayBuffer())
const outFile = path.join(outDir, `${taskId}.mp4`)
fs.writeFileSync(outFile, buf)

// 校验 mp4 文件头：偏移 4 起应为 'ftyp'
const magic = buf.slice(4, 8).toString('ascii')
console.log('saved    :', outFile)
console.log('size     :', (buf.length / 1024 / 1024).toFixed(2), 'MB')
console.log('mp4 magic:', magic, magic === 'ftyp' ? '(✓ 合法 mp4)' : '(✗ 不是 mp4)')
