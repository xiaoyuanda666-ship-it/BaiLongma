// kind: selfcheck —— 启动能力自检。单个 surface 走完全程:
//   running 态(逐步推进,扫描动画)→ done 态(结果清单 + 总体结论)。
// 同一 id 反复 ui_set,shell 原地 morph —— 正是"共享元素转场"的展示位(SCENE-PROTOCOL §7)。
//
// data: {
//   phase: 'running' | 'done',
//   // running:
//   step: 1, total: 3, name: '文件读写', icon: '📁',
//   // done:
//   results: [{ name, status: 'ok'|'error'|'skipped', note? }], overall: 'ok'|'degraded'|'error'
// }
// 上行 intent:无(纯展示)。

import { el, setText } from './dom.js'

const STATUS = {
  ok:      { icon: '✓', cls: 'is-ok' },
  error:   { icon: '✗', cls: 'is-error' },
  skipped: { icon: '—', cls: 'is-skipped' },
}
const OVERALL = {
  ok:       { label: '系统就绪',     icon: '⚡', cls: 'is-ok' },
  degraded: { label: '部分能力受限', icon: '⚠', cls: 'is-degraded' },
  error:    { label: '检测到问题',   icon: '✗', cls: 'is-error' },
}

function inferOverall(results = []) {
  if (results.some(r => r.status === 'error'))   return 'error'
  if (results.some(r => r.status === 'skipped')) return 'degraded'
  return 'ok'
}

function isDone(data = {}) {
  return data.phase === 'done' || Array.isArray(data.results)
}

// running 态:头部计数 + 脉冲点 + "正在检查{name}" + 扫描条。
function renderRunning(data = {}) {
  const { step = 1, total = 3, name = '', icon = '🔍' } = data
  return el('div', { class: 'k-selfcheck' }, [
    el('div', { class: 'sc-head' }, [
      el('span', { class: 'sc-icon', text: icon }),
      el('span', { class: 'sc-title', text: '能力自检' }),
      el('span', { class: 'sc-counter', text: `${step} / ${total}` }),
    ]),
    el('div', { class: 'sc-running' }, [
      el('span', { class: 'sc-dot' }),
      el('span', { class: 'sc-name', text: `正在检查${name}` }),
    ]),
    el('div', { class: 'sc-scan' }, [el('div', { class: 'sc-scan-bar' })]),
  ])
}

// done 态:结果清单 + 总体结论。
function renderDone(data = {}) {
  const results = Array.isArray(data.results) ? data.results : []
  const overall = OVERALL[data.overall] || OVERALL[inferOverall(results)]
  const rows = results.map(r => {
    const s = STATUS[r.status] || STATUS.skipped
    return el('div', { class: `sc-row ${s.cls}` }, [
      el('span', { class: 'sc-row-icon', text: s.icon }),
      el('span', { class: 'sc-row-name', text: r.name || '' }),
      r.note ? el('span', { class: 'sc-row-note', text: r.note }) : null,
    ])
  })
  return el('div', { class: 'k-selfcheck' }, [
    el('div', { class: 'sc-head' }, [
      el('span', { class: 'sc-icon', text: overall.icon }),
      el('span', { class: 'sc-title', text: '自检完成' }),
    ]),
    el('div', { class: 'sc-results' }, rows),
    el('div', { class: `sc-foot ${overall.cls}` }, [
      el('span', { class: 'sc-overall-icon', text: overall.icon }),
      el('span', { class: 'sc-overall', text: overall.label }),
    ]),
  ])
}

export const selfcheck = {
  render(data = {}) {
    return isDone(data) ? renderDone(data) : renderRunning(data)
  },

  enter() {},
  exit() {},

  // morph:running→running 原地更新计数/名称(扫描条不断);跨态(→done)整块交叉淡化重建。
  morph(el_, prev = {}, next = {}) {
    const root = el_.querySelector(':scope > .k-selfcheck')
    if (!root) return
    const same = isDone(prev) === isDone(next)
    if (same && !isDone(next)) {
      const icon = root.querySelector('.sc-icon')
      const counter = root.querySelector('.sc-counter')
      const name = root.querySelector('.sc-name')
      if (icon) setText(icon, next.icon || '🔍')
      if (counter) setText(counter, `${next.step || 1} / ${next.total || 3}`)
      if (name) setText(name, `正在检查${next.name || ''}`)
      return
    }
    // 结构变了(running↔done 或 done→done):交叉淡化后整块重建。
    root.classList.add('fade-swap')
    root.style.opacity = '0'
    requestAnimationFrame(() => {
      const fresh = selfcheck.render(next)
      root.replaceWith(fresh)
      requestAnimationFrame(() => { fresh.style.opacity = '' })
    })
  },
}
