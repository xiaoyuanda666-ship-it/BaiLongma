// 把后台「安装软件」job 的状态投影成 Scene 的 progress surface(声明式 UI)。
//
// 安装能力本身不认识界面——这里是唯一的「job 状态 → 屏幕」翻译层,挂在 software-install.js
// 的咽喉点 updateJob 上。安装是异步后台跑的(不在 Agent 回合里),所以由 core 直接驱动
// 投影,而非 Agent 逐 tick 调 ui_set(同 execSetSecurity 的安全确认先例)。
//
// 进度走「阶段里程碑」:winget 装包用 --disable-interactivity,拿不到可靠百分比,
// 故让用户看到流水线在推进即可;唯独不定长的 installing 阶段用 progress 的不定量滑动条。

import { sceneStore } from '../../scene/scene-store.js'

// 每个 job 一张独立卡(可并发安装多个软件)。
function surfaceId(jobId) {
  return `install-${jobId}`
}

// 阶段 → 里程碑百分比。终态失败类不在表内,保留上一帧的进度(停在哪失败,就在哪变红)。
const PHASE_PERCENT = {
  started: 5,
  checking_winget: 12,
  searching: 30,
  inspecting: 55,
  installing: 82,
  succeeded: 100,
}

// 阶段 → progress kind 的 status(决定填充色)。缺省 active(蓝)。
const PHASE_STATUS = {
  succeeded: 'done',          // 绿
  failed: 'error',            // 红
  cancelled: 'error',         // 红
  needs_attention: 'paused',  // 灰
}

// 阶段 → 一句中文副文本。
const PHASE_NOTE = {
  started: '准备中…',
  checking_winget: '检查 winget…',
  searching: '搜索软件源…',
  inspecting: '核对安装包…',
  installing: '正在安装…',
  succeeded: '安装完成',
  failed: '安装失败',
  needs_attention: '需要你确认',
  cancelled: '已取消',
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'needs_attention'])
const REMOVE_DELAY = { succeeded: 5000 }   // 成功:扫一眼绿色 100% 即退场
const REMOVE_DELAY_DEFAULT = 9000          // 失败/取消/需确认:留久一点
const pendingRemoval = new Set()           // 已排退场定时器的 surface id,避免重复

function friendlyLabel(snapshot) {
  const name = snapshot.query || snapshot.selected_package_id || snapshot.package_id || '软件'
  return `安装 ${name}`
}

// 投影一次 job 状态。幂等:只改元数据、不改 status 的 updateJob 会产生相同 surface → SceneStore 当 no-op。
export function projectInstallJobToScene(snapshot) {
  if (!snapshot || !snapshot.job_id) return
  const id = surfaceId(snapshot.job_id)
  const status = snapshot.status

  const data = {
    label: friendlyLabel(snapshot),
    status: PHASE_STATUS[status] || 'active',
    note: PHASE_NOTE[status] || '',
  }

  if (status === 'installing') {
    // 不定长:用滑动条表「正在安装、时长未知」,比一根定死的 82% 条诚实。
    data.indeterminate = true
    data.value = PHASE_PERCENT.installing
  } else {
    let value = PHASE_PERCENT[status]
    if (value == null) {
      // 终态失败类:沿用当前 surface 的进度,停在失败处变红。
      const existing = sceneStore.get(id)
      value = existing && typeof existing.data?.value === 'number' ? existing.data.value : 0
    }
    data.value = value
  }

  sceneStore.set(id, { kind: 'progress', data, intent: 'ambient' })

  // 终态:稍后自动退场(成功快、失败慢)。
  if (TERMINAL.has(status) && !pendingRemoval.has(id)) {
    pendingRemoval.add(id)
    const delay = REMOVE_DELAY[status] || REMOVE_DELAY_DEFAULT
    const t = setTimeout(() => {
      pendingRemoval.delete(id)
      sceneStore.set(id, null)
    }, delay)
    t.unref?.()
  }
}
