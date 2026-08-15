const $ = selector => document.querySelector(selector)
const STATES = ['DRAFT','VALIDATING','READY','STAGING','UPLOADING_ARTIFACTS','VERIFYING_ARTIFACTS','PUBLISHING_METADATA','VERIFYING_RELEASE','SUCCEEDED','FAILED','CANCELLED','UNCERTAIN']
const app = { token: '', bootstrap: null, snapshot: null, plan: null, preflight: null, task: null, logs: [] }

function esc(value) { return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' })[char]) }
function bytes(value = 0) { const units=['B','KiB','MiB','GiB']; let n=Number(value)||0,i=0; while(n>=1024&&i<units.length-1){n/=1024;i++} return `${n.toFixed(i?1:0)} ${units[i]}` }
function shortHash(value) { return value ? `${value.slice(0,14)}…${value.slice(-10)}` : '—' }
function date(value) { return value ? new Date(value).toLocaleString('zh-CN',{hour12:false}) : '—' }
function badge(ok, yes='通过', no='失败') { return `<span class="badge ${ok?'ok':'bad'}">${ok?'✓':'✕'} ${esc(ok?yes:no)}</span>` }
function toast(message) { const el=$('#toast'); el.textContent=message; el.classList.add('show'); clearTimeout(toast.timer); toast.timer=setTimeout(()=>el.classList.remove('show'),3500) }

async function api(path, { method='GET', body } = {}) {
  const response = await fetch(path, { method, headers: method === 'POST' ? { 'Content-Type':'application/json', 'X-Release-Session-Token':app.token } : {}, body: body == null ? undefined : JSON.stringify(body) })
  const result = await response.json().catch(()=>({error:`HTTP ${response.status}`}))
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`)
  return result
}

function requestFromForm(dryRun) {
  return {
    version: app.bootstrap.version,
    archs: [...document.querySelectorAll('input[name=arch]:checked')].map(input=>input.value),
    channel: $('#channel').value,
    stagingPercentage: Number($('#staging').value),
    releaseNotes: $('#releaseNotes').value,
    mode: $('#mode').value,
    testBuild: $('#testBuild').checked,
    dryRun,
    confirmed: $('#confirmCheckbox').checked,
    confirmationVersion: $('#confirmVersion').value,
  }
}

function renderSystem(system) {
  const cards = []
  for (const probe of system.probes || []) cards.push({label:probe.name,value:probe.ok?'可用':'异常',ok:probe.ok,detail:probe.ok?`${probe.detail} · ${probe.latencyMs} ms`:probe.error})
  cards.push({label:'Git 分支',value:system.git.branch,ok:true,detail:system.git.commit.slice(0,12)})
  cards.push({label:'Git 工作区',value:system.git.dirty?`Dirty · ${system.git.changedFiles} 项`:'Clean',ok:!system.git.dirty,detail:system.git.dirty?'发布记录会保留 dirty 状态':'无未提交修改'})
  cards.push({label:'package.json',value:`v${system.version}`,ok:true,detail:'只读发布版本'})
  for (const arch of ['x64','arm64']) {
    const state=system.remoteVersionStates?.[arch]||'unavailable', version=system.remoteVersions[arch]
    cards.push({label:`远端 macOS ${arch}`,value:state==='present'?`v${version}`:state==='absent'?'尚未发布':'未知',ok:state!=='unavailable',detail:state==='absent'?'远端清单确认不存在 · 将作为首次发布':'stable / latest-mac.yml'})
  }
  $('#systemGrid').classList.remove('skeleton')
  $('#systemGrid').innerHTML=cards.map(card=>`<div class="status-card"><div class="label">${esc(card.label)}</div><div class="value ${card.ok?'':'bad'}">${card.ok?'●':'▲'} ${esc(card.value)}</div><div class="detail">${esc(card.detail)}</div></div>`).join('')
}

function renderArtifacts(artifacts) {
  $('#artifactSummary').className=`badge ${artifacts.complete?'ok':'bad'}`
  $('#artifactSummary').textContent=`${artifacts.complete?'✓ 完整':'✕ 不完整'} · ${bytes(artifacts.totalBytes)}`
  $('#artifactRows').innerHTML=artifacts.records.map(record=>`<tr><td><code>${esc(record.arch)}</code></td><td>${esc(record.kind.toUpperCase())}</td><td><code>${esc(record.name)}</code></td><td>${bytes(record.size)}</td><td title="${esc(record.sha512||'')}"><span class="hash">${esc(shortHash(record.sha512))}</span></td><td>${date(record.mtime)}</td><td>${badge(record.exists, '存在', '缺失')}</td></tr>`).join('')
}

function checkItem(name, ok, detail='') { return `<div class="check-item">${ok?'✓':'✕'} <strong>${esc(name)}</strong>${detail?`<span>${esc(detail)}</span>`:''}</div>` }
function failureDetails(check) {
  const items = [
    ['codesign', check.codesign],
    ['Apple 公证', check.notarization],
    ['stapler', check.stapler],
    ['Gatekeeper app', { ok: check.gatekeeper?.ok, detail: check.gatekeeper?.app }],
    ['Gatekeeper DMG', { ok: check.gatekeeper?.ok, detail: check.gatekeeper?.dmg }],
    ['blockmap', check.blockmaps],
  ].filter(([, value]) => value && !value.ok && (value.detail || value.error))
  if (!items.length) return ''
  return `<details class="failure-details"><summary>查看失败详情（已脱敏）</summary>${items.map(([name,value])=>`<h4>${esc(name)}</h4><pre>${esc(value.detail||value.error)}</pre>`).join('')}</details>`
}
function renderPreflight(preflight) {
  app.preflight=preflight
  const container=$('#preflightGrid'); container.className='preflight-grid'
  container.innerHTML=(preflight?.checks||[]).map(check=>`<article class="arch-check"><div class="section-head"><h3>macOS ${esc(check.arch)}</h3><span class="badge ${check.stableEligible?'ok':'bad'}">${check.stableEligible?'STABLE READY':'STABLE BLOCKED'}</span></div><div class="check-grid">
    ${checkItem('文件完整',check.complete)}${checkItem('版本一致',check.versionMatch)}${checkItem(check.firstRelease?'首次发布':'高于远端',check.localVersionHigher,check.firstRelease?'远端清单确认不存在':check.remoteVersion?`远端 ${check.remoteVersion}`:'远端状态未知')}
    ${checkItem('CPU 架构',check.cpuArchitecture?.ok,check.cpuArchitecture?.actual||'未知')}${checkItem('codesign',check.codesign?.ok)}${checkItem('Developer Team',Boolean(check.developerTeam),check.developerTeam||'未识别')}
    ${checkItem('Hardened Runtime',check.hardenedRuntime)}${checkItem('Entitlements',check.entitlements?.ok)}${checkItem('Apple 公证',check.notarization?.ok)}
    ${checkItem('stapler validate',check.stapler?.ok)}${checkItem('Gatekeeper',check.gatekeeper?.ok)}${checkItem('blockmap',check.blockmaps?.ok)}
  </div>${check.errors?.length?`<p class="bad">${check.errors.map(esc).join('<br>')}</p>`:''}${failureDetails(check)}</article>`).join('') || '<div class="empty">没有检查结果</div>'
  updateActions()
}

function renderPlan(plan) {
  app.plan=plan
  $('#planSize').className='badge active'; $('#planSize').textContent=bytes(plan.totalUploadBytes)
  $('#planView').className='plan'
  $('#planView').innerHTML=`<div class="plan-group"><h3>本地读取 · ${plan.localFiles.length} 个文件</h3><ul>${plan.localFiles.map(item=>`<li><code>${esc(item)}</code></li>`).join('')}</ul></div>
  <div class="plan-group"><h3>检查</h3><ul>${plan.checks.map(item=>`<li>${esc(item)}</li>`).join('')}</ul></div>
  <div class="plan-group"><h3>香港源站目录</h3><ul>${plan.serverDirectories.map(item=>`<li><code>${esc(item)}</code></li>`).join('')}</ul></div>
  <div class="plan-group"><h3>OSS Objects · 不可变文件 ${plan.immutable.length} 个</h3><ul>${plan.ossObjects.map(item=>`<li><code>${esc(item)}</code></li>`).join('')}</ul></div>
  <div class="plan-group"><h3>latest-mac.yml · 灰度 ${plan.stagingPercentage}%</h3>${plan.manifests.map(item=>`<strong>${esc(item.arch)}</strong><pre>${esc(item.content)}</pre>`).join('')}</div>
  <div class="plan-group"><h3>正式切换点</h3><p>${esc(plan.metadataSwitch)}</p></div>`
  updateActions()
}

function renderHistory(histories=[]) {
  $('#historyRows').innerHTML=histories.map(record=>`<tr><td><code>${esc(record.releaseId)}</code></td><td>v${esc(record.version)}</td><td>${esc(record.architectures?.join(' + '))}</td><td>${record.dryRun?'DRY RUN':esc(record.mode)}</td><td><code>${esc((record.gitCommit||'').slice(0,10))}</code>${record.gitDirty?' · dirty':''}</td><td>${date(record.startedAt)}<br>${date(record.endedAt)}</td><td><span class="badge ${record.finalState==='SUCCEEDED'?'ok':record.finalState==='UNCERTAIN'?'warn':'bad'}">${esc(record.finalState)}</span></td></tr>`).join('') || '<tr><td colspan="7" class="muted">暂无发布历史</td></tr>'
}

function renderState(task) {
  if (task) app.task=task
  const current=app.task?.state||'DRAFT', index=STATES.indexOf(current)
  $('#taskState').className=`state state-${current}`; $('#taskState').textContent=current
  $('#stateRail').innerHTML=STATES.map((state,i)=>`<div class="state-node ${i<index?'done':i===index?'current':''}" title="${state}"></div>`).join('')
  const progress=app.task?.progress||{}; const total=Number(progress.totalBytes)||0, uploaded=Number(progress.uploadedBytes)||0
  $('#progressBar').style.width=`${total?Math.min(100,uploaded/total*100):current==='SUCCEEDED'?100:0}%`
  $('#progressStats').textContent=`${bytes(uploaded)} / ${bytes(total)} · ${bytes(progress.speed||0)}/s · ETA ${progress.etaSeconds==null?'—':`${progress.etaSeconds}s`}`
  const services=app.task?.services||{oss:'pending',hongKong:'pending',validation:'pending'}
  $('#serviceStatuses').innerHTML=`<span>OSS: ${esc(services.oss)}</span><span>香港源站: ${esc(services.hongKong)}</span><span>验证: ${esc(services.validation)}</span>`
  if (app.task?.preflight) renderPreflight(app.task.preflight)
  if (app.task?.logs) { app.logs=app.task.logs; renderLogs() }
  updateActions()
}

function renderLogs() {
  const logs=app.logs||[]; $('#logCount').textContent=logs.length
  $('#logs').textContent=logs.length?logs.map(log=>`${log.at||''} [${String(log.level||'info').toUpperCase()}] ${log.message||''}`).join('\n'):'等待任务…'
  if ($('#autoScroll').checked) $('#logs').scrollTop=$('#logs').scrollHeight
}

function updateActions() {
  const running=app.task&&!['SUCCEEDED','FAILED','CANCELLED','UNCERTAIN'].includes(app.task.state)
  const confirmed=$('#confirmCheckbox').checked&&$('#confirmVersion').value.trim()===app.bootstrap?.version
  const stableGate=app.preflight?.stableEligible || $('#mode').value==='build'
  $('#dryRunButton').disabled=Boolean(running)
  $('#publishButton').disabled=Boolean(running)||!confirmed||!app.plan||!stableGate||$('#testBuild').checked
  $('#cancelButton').disabled=!running||!app.task?.cancellable
}

async function refresh() {
  $('#refreshButton').disabled=true
  try {
    const result=await api('/api/refresh',{method:'POST',body:{}}); app.snapshot=result
    renderSystem(result.system); renderArtifacts(result.artifacts); renderHistory(result.histories); if(result.preflight)renderPreflight(result.preflight); if(result.activeTask)renderState(result.activeTask)
    $('#refreshedAt').textContent=`刷新于 ${date(result.refreshedAt)}`
  } catch(error){toast(error.message)} finally{$('#refreshButton').disabled=false}
}

async function makePlan() {
  $('#planButton').disabled=true
  try { const {plan}=await api('/api/plan',{method:'POST',body:requestFromForm(true)}); renderPlan(plan); toast('发布计划已生成') }
  catch(error){toast(error.message)} finally{$('#planButton').disabled=false}
}

async function preflight() {
  $('#preflightButton').disabled=true; $('#preflightGrid').className='preflight-grid empty'; $('#preflightGrid').textContent='正在挂载 DMG 并运行 Apple 安全检查，可能需要数分钟…'
  try { const result=await api('/api/preflight',{method:'POST',body:requestFromForm(true)}); renderPreflight(result.preflight); toast(result.preflight.stableEligible?'全部 stable 门禁通过':'检查完成：stable 仍被阻止') }
  catch(error){ $('#preflightGrid').textContent=error.message; toast(error.message) } finally{$('#preflightButton').disabled=false}
}

async function startTask(dryRun) {
  try { const {task}=await api('/api/tasks',{method:'POST',body:requestFromForm(dryRun)}); app.logs=[]; renderState(task); toast(dryRun?'Dry Run 已启动':'正式发布已启动') }
  catch(error){toast(error.message)}
}

function connectEvents() {
  const events=new EventSource('/api/events')
  events.addEventListener('ready',event=>{ $('#connectionBadge').className='badge ok'; $('#connectionBadge').textContent='● 本地已连接'; const data=JSON.parse(event.data); if(data.activeTask)renderState(data.activeTask) })
  events.addEventListener('task',event=>{ const data=JSON.parse(event.data); if(data.task)renderState(data.task); if(data.event?.type==='log'&&!data.task?.logs){app.logs.push(data.event);renderLogs()} })
  events.addEventListener('history',event=>{ const data=JSON.parse(event.data); if(data.history){const current=app.snapshot?.histories||[]; app.snapshot={...(app.snapshot||{}),histories:[data.history,...current.filter(item=>item.releaseId!==data.history.releaseId)]};renderHistory(app.snapshot.histories)} })
  events.onerror=()=>{ $('#connectionBadge').className='badge bad'; $('#connectionBadge').textContent='▲ SSE 断开' }
}

async function init() {
  try {
    app.bootstrap=await api('/api/bootstrap'); app.token=app.bootstrap.token
    $('#versionBadge').textContent=`v${app.bootstrap.version}`; $('#versionBadge').className='badge active'; $('#versionInput').value=app.bootstrap.version
    const result=await api('/api/status'); app.snapshot=result
    renderSystem(result.system); renderArtifacts(result.artifacts); renderHistory(result.histories); if(result.preflight)renderPreflight(result.preflight); renderState(result.activeTask)
    $('#refreshedAt').textContent=`刷新于 ${date(result.refreshedAt)}`; connectEvents(); makePlan()
  } catch(error){toast(error.message); $('#connectionBadge').className='badge bad'; $('#connectionBadge').textContent='▲ 启动失败'}
}

$('#refreshButton').addEventListener('click',refresh)
$('#planButton').addEventListener('click',makePlan)
$('#preflightButton').addEventListener('click',preflight)
$('#dryRunButton').addEventListener('click',()=>startTask(true))
$('#publishButton').addEventListener('click',()=>startTask(false))
$('#cancelButton').addEventListener('click',async()=>{try{const {task}=await api('/api/cancel',{method:'POST',body:{}});renderState(task)}catch(error){toast(error.message)}})
$('#copyLogs').addEventListener('click',event=>{event.preventDefault();navigator.clipboard.writeText($('#logs').textContent).then(()=>toast('日志已复制')).catch(()=>toast('复制失败'))})
for(const element of [$('#confirmCheckbox'),$('#confirmVersion'),$('#mode'),$('#testBuild')]) element.addEventListener('input',updateActions)
for(const element of document.querySelectorAll('#releaseForm input,#releaseForm select,#releaseForm textarea')) element.addEventListener('change',()=>{app.plan=null;$('#planSize').textContent='需更新';updateActions()})
renderState(null)
init()
