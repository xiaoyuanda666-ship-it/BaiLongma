const $ = selector => document.querySelector(selector)
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))
const labels = { scan: '产物扫描', preflight: '完整本地检查', 'dry-run': '本地 Dry Run' }
let token = ''
let polling = false
async function api(method='GET', body) {
  const response = await fetch('/api/japlos-v2', { method, headers: method === 'POST' ? {'Content-Type':'application/json','X-Release-Session-Token':token} : {}, body: body ? JSON.stringify(body) : undefined })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error)
  return result.job
}
function render(job) {
  const busy = job?.state === 'running'
  for (const element of document.querySelectorAll('button,input')) element.disabled = busy
  $('#state').textContent = busy ? `${labels[job.action]}进行中…` : job?.state === 'failed' ? '检查出错' : '本地已连接'
  if (job?.error) { $('#checks').textContent = job.error; $('#summary').textContent = '检查失败'; return }
  if (busy) { $('#checks').textContent = `${labels[job.action]}进行中，请稍候…`; $('#summary').textContent = '检查中'; return }
  const result = job?.result
  if (!result) return
  $('#version').textContent = `VERSION · ${result.version}`
  $('#root').textContent = result.root
  $('#summary').className = `badge ${result.passed?'ok':'bad'}`
  $('#summary').textContent = `${labels[job.action]} · ${result.passed?'通过':'有未通过项'}`
  $('#time').textContent = new Date(job.endedAt).toLocaleString('zh-CN')
  $('#files').innerHTML = result.records.map(file => `<tr><td>${escape(file.arch)}</td><td title="${escape(file.path)}">${escape(file.name)}</td><td>${(file.size/1024/1024).toFixed(2)} MiB</td><td title="${escape(file.sha512)}">${escape(file.sha512.slice(0,18)) || '—'}</td><td>${file.exists?'✓ 存在':'✕ 缺失'}</td></tr>`).join('')
  $('#checks').innerHTML = result.checks.map(check => `<details class="arch-check" ><summary class="${check.ok?'':'bad'}">${check.ok?'✓':'✕'} ${escape(check.arch)} · ${escape(check.name)}</summary><pre>${escape(check.detail)}</pre></details>`).join('')
}
async function follow(job) {
  render(job)
  if (job?.state !== 'running') { polling = false; return }
  polling = true
  setTimeout(async () => {
    try { await follow(await api()) } catch(error) { fail(error) }
  }, 1500)
}
function fail(error) {
  polling = false
  for (const element of document.querySelectorAll('button,input')) element.disabled = false
  $('#state').textContent = '操作失败'
  $('#checks').textContent = error.message
}
async function start(action) {
  if (polling) return
  try {
    const archs = [...document.querySelectorAll('#architectures input:checked')].map(input => input.value)
    if (!archs.length) throw new Error('请至少选择一个架构')
    polling = true
    render({state:'running',action})
    await follow(await api('POST', {action, archs}))
  } catch(error) { fail(error) }
}
for (const button of document.querySelectorAll('[data-action]')) button.addEventListener('click', () => start(button.dataset.action))
try {
  const response = await fetch('/api/bootstrap')
  if (!response.ok) throw new Error('无法连接本地服务')
  token = (await response.json()).token
  const job = await api()
  if (job) await follow(job)
  else await start('scan')
} catch(error) { fail(error) }
