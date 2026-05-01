// ACUI Renderer
// 三种执行模式：A 注册组件 / B 内联模板 / C 内联组件
// 优先级 A > B > C 由 Agent 在 prompt 里把握，前端只负责按 mode 路由。
// hint.placement 决定形态：notification（右上堆叠） / center（居中带遮罩） / floating（自由浮动可拖）

let COMPONENTS = {}

async function loadRegistry() {
  const url = `./registry.js?t=${Date.now()}`
  const mod = await import(url)
  COMPONENTS = mod.COMPONENTS || {}
}

const instances = new Map()

// 三个独立的 layer，分别承担三种 placement。client.js 传进来的 rootEl 用作 notification 层，
// 另外两层在 init 时自动挂到 document.body，互不干扰。
let notificationHost = null
let centerHost = null
let floatingHost = null
let stageHost = null
let signalSink = null

// 全局 App 上下文注册表：{ [id]: { emit, onPatch } }
// 生成的组件在 connectedCallback 里通过 this._app = window.__acuiApps?.[this.id] 取到
window.__acuiApps = window.__acuiApps || {}

export async function initRenderer(rootEl, sink) {
  notificationHost = rootEl
  signalSink = sink

  centerHost = document.getElementById('acui-center-host')
  if (!centerHost) {
    centerHost = document.createElement('div')
    centerHost.id = 'acui-center-host'
    document.body.appendChild(centerHost)
  }

  floatingHost = document.getElementById('acui-floating-host')
  if (!floatingHost) {
    floatingHost = document.createElement('div')
    floatingHost.id = 'acui-floating-host'
    document.body.appendChild(floatingHost)
  }

  stageHost = document.getElementById('acui-stage-host')
  if (!stageHost) {
    stageHost = document.createElement('div')
    stageHost.id = 'acui-stage-host'
    document.body.appendChild(stageHost)
  }

  await loadRegistry()
}

export async function reloadRegistry() {
  try {
    await loadRegistry()
    console.log('[ACUI] registry 已热重载，可用组件：', Object.keys(COMPONENTS).join(', '))
  } catch (e) {
    console.warn('[ACUI] registry 重载失败：', e)
  }
}

export function mount(msg) {
  if (!notificationHost) return

  if (msg.mode === 'inline-template') {
    return mountInlineTemplate(msg)
  }
  if (msg.mode === 'inline-script') {
    return mountInlineScript(msg)
  }
  return mountRegistered(msg)
}

// ── 模式 A：注册组件 ──────────────────────────────────────────
function mountRegistered({ id, component, props, hint }) {
  const Cls = COMPONENTS[component]
  if (!Cls) {
    signalSink?.({ type: 'card.error', target: id, payload: { phase: 'mount', message: `unknown_component:${component}` } })
    return
  }

  const el = document.createElement(Cls.tagName)
  attachLifecycle(el, id, component, hint)
  el.props = props
  appendAndAnimate(el, id, component, hint)
}

// ── 模式 B：内联模板 ────────────────────────────────────────
const inlineTplCache = new Map()

function escapeHtml(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function hashStr(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0
  }
  return Math.abs(h).toString(36)
}

function buildInlineTplClass(template, styles) {
  return class extends HTMLElement {
    constructor() {
      super()
      this.attachShadow({ mode: 'open' })
      this._props = {}
    }
    set props(v) {
      this._props = v || {}
      this._render()
    }
    get props() { return this._props }
    connectedCallback() { this._render() }
    _render() {
      // 第一步：替换顶层 ${字段名}（只对非数组、非对象字段生效；对象/数组字段如果直接被替换会出现 [object Object]）
      const html = template.replace(/\$\{(\w+)\}/g, (m, name) => {
        const v = this._props?.[name]
        if (v == null) return ''
        if (typeof v === 'object') return '' // 数组/对象字段不在顶层模板里直接展开，请用 data-acui-each
        return escapeHtml(v)
      })
      const styleBlock = styles ? `<style>${styles}</style>` : ''
      const closeBtn = `<button class="acui-inline-close" aria-label="close" style="position:absolute;top:8px;right:8px;background:transparent;border:0;color:rgba(255,255,255,.55);cursor:pointer;font-size:16px;padding:4px 8px;z-index:2">✕</button>`
      this.shadowRoot.innerHTML = `${styleBlock}<div style="position:relative">${html}${closeBtn}</div>`
      // 第二步：处理 data-acui-each="字段名" 元素 —— 取数组，按元素自身作为模板克隆 N 份，用 item 替换内部 ${...}
      expandEach(this.shadowRoot, this._props)
      const btn = this.shadowRoot.querySelector('.acui-inline-close')
      if (btn) btn.onclick = () => this.dispatchEvent(new CustomEvent('acui:dismiss', { detail: { by: 'user' }, bubbles: true, composed: true }))
      bindDataActions(this, this.shadowRoot)
    }
  }
}

// data-acui-each="forecast" → 取 props.forecast（数组），把当前元素当行模板克隆 length 份。
// 行内可写 ${day}、${high}、${low} 等子字段；item 是对象就按字段查，是字符串就用 ${item}。
function expandEach(root, props) {
  const eachEls = root.querySelectorAll('[data-acui-each]')
  eachEls.forEach((tplEl) => {
    const name = tplEl.getAttribute('data-acui-each')
    if (!name) return
    const list = props?.[name]
    if (!Array.isArray(list)) {
      tplEl.remove()
      return
    }
    const parent = tplEl.parentNode
    if (!parent) return

    const rawHtml = tplEl.outerHTML.replace(/\sdata-acui-each="[^"]*"/g, '')
    const out = []
    for (let i = 0; i < list.length; i++) {
      const item = list[i]
      const itemProps = (item && typeof item === 'object' && !Array.isArray(item))
        ? { ...item, item, index: i }
        : { item, index: i }
      const filled = rawHtml.replace(/\$\{(\w+)\}/g, (_, key) => {
        const v = itemProps[key]
        if (v == null) return ''
        if (typeof v === 'object') return ''
        return escapeHtml(v)
      })
      out.push(filled)
    }

    const tmp = document.createElement('template')
    tmp.innerHTML = out.join('')
    parent.insertBefore(tmp.content, tplEl)
    tplEl.remove()
  })
}

// 给模板里 data-acui-action / data-acui-bind 元素自动绑事件，
// 让模式 B 也能上报交互信号到 Agent，避免被迫升级到模式 C。
function bindDataActions(host, root) {
  // 1) data-acui-action="<name>"：click → 派发 acui:action
  //    所有以 data-payload-* 开头的属性都作为 payload 字段（kebab-case 自动转 snake/原样）
  const actionables = root.querySelectorAll('[data-acui-action]')
  actionables.forEach((el) => {
    if (el.__acuiBound) return
    el.__acuiBound = true
    el.addEventListener('click', () => {
      const action = el.getAttribute('data-acui-action')
      const payload = {}
      for (const attr of el.attributes) {
        if (attr.name.startsWith('data-payload-')) {
          const key = attr.name.slice('data-payload-'.length)
          payload[key] = attr.value
        }
      }
      // 同时收集当前所有 data-acui-bind 字段，方便表单类卡片一键提交
      const binds = root.querySelectorAll('[data-acui-bind]')
      const fields = {}
      binds.forEach((b) => {
        const k = b.getAttribute('data-acui-bind')
        if (k) fields[k] = b.value ?? b.textContent ?? ''
      })
      if (Object.keys(fields).length) payload.fields = fields

      host.dispatchEvent(new CustomEvent('acui:action', {
        bubbles: true, composed: true,
        detail: { action, payload },
      }))
    })
  })
}

function mountInlineTemplate({ id, template, styles, props, hint }) {
  if (!template) {
    signalSink?.({ type: 'card.error', target: id, payload: { phase: 'mount', message: 'missing_template' } })
    return
  }
  try {
    const key = hashStr(template + '|' + (styles || ''))
    let tag = inlineTplCache.get(key)
    if (!tag) {
      tag = `acui-inline-tpl-${key}`
      if (!customElements.get(tag)) {
        customElements.define(tag, buildInlineTplClass(template, styles || ''))
      }
      inlineTplCache.set(key, tag)
    }
    const el = document.createElement(tag)
    attachLifecycle(el, id, '__inline_template__', hint)
    el.props = props || {}
    appendAndAnimate(el, id, '__inline_template__', hint)
  } catch (e) {
    signalSink?.({ type: 'card.error', target: id, payload: { phase: 'mount', message: String(e?.message || e) } })
  }
}

// ── 模式 C：内联组件 ───────────────────────────────────────
async function mountInlineScript({ id, code, props, hint }) {
  if (!code) {
    signalSink?.({ type: 'card.error', target: id, payload: { phase: 'mount', message: 'missing_code' } })
    return
  }

  const safeCode = `
    var customElements = { define: () => {}, get: () => undefined, whenDefined: () => Promise.resolve() }
    ${code}
  `

  let url = null
  try {
    const blob = new Blob([safeCode], { type: 'text/javascript' })
    url = URL.createObjectURL(blob)
    const mod = await import(/* @vite-ignore */ url)
    const Cls = mod.default
    if (typeof Cls !== 'function' || !(Cls.prototype instanceof HTMLElement)) {
      throw new Error('not_html_element')
    }
    const tag = `acui-inline-${id}`
    if (!customElements.get(tag)) customElements.define(tag, Cls)
    const el = document.createElement(tag)
    attachLifecycle(el, id, '__inline_script__', hint)
    el.props = props || {}
    appendAndAnimate(el, id, '__inline_script__', hint)
  } catch (e) {
    signalSink?.({ type: 'card.error', target: id, payload: { phase: 'load', message: String(e?.message || e) } })
  } finally {
    if (url) URL.revokeObjectURL(url)
  }
}

// ── 公共：生命周期 + 入场 ─────────────────────────────────────
function attachLifecycle(el, id, component, hint) {
  el.id = id
  el.dataset.component = component

  const placement = hint?.placement || 'notification'
  el.dataset.placement = placement

  const defaultEnter = { center: 'scale-up', stage: 'stage-up', floating: 'fade-up' }
  const defaultExit  = { center: 'scale-down', stage: 'stage-down', floating: 'fade-down' }
  el.dataset.enter = hint?.enter || defaultEnter[placement] || 'slide-from-right'
  el.dataset.exit  = hint?.exit  || defaultExit[placement]  || 'slide-to-right'

  applySize(el, hint?.size)

  el.addEventListener('acui:dismiss', (e) => {
    unmount(id, e.detail?.by || 'unknown')
  })
  el.addEventListener('acui:action', (e) => {
    signalSink?.({ type: 'card.action', target: id, payload: e.detail || {} })
  })

  // 注册 App 上下文，供生成的组件在 connectedCallback 里通过
  // this._app = window.__acuiApps?.[this.id] 取到
  window.__acuiApps[id] = {
    emit(action, payload = {}) {
      signalSink?.({ type: 'card.action', target: id, payload: { action, payload } })
    },
    onPatch(handler) {
      document.addEventListener('acui:patch', (e) => {
        if (e.detail?.id === id) handler(e.detail)
      })
    },
  }
}

const SIZE_PRESETS = {
  sm: { w: 320 },
  md: { w: 420 },
  lg: { w: 600 },
  xl: { w: 820 },
}

function applySize(el, size) {
  let cfg = null
  if (typeof size === 'string' && SIZE_PRESETS[size]) cfg = SIZE_PRESETS[size]
  else if (size && typeof size === 'object') cfg = size

  if (!cfg) return
  if (cfg.w != null) el.style.width = typeof cfg.w === 'number' ? `${cfg.w}px` : cfg.w
  if (cfg.h != null) el.style.height = typeof cfg.h === 'number' ? `${cfg.h}px` : cfg.h
}

// 选哪个 host 容器；center 还要套一层 backdrop
function appendAndAnimate(el, id, component, hint) {
  const placement = hint?.placement || 'notification'
  let host = notificationHost
  let backdrop = null

  if (placement === 'center') {
    host = centerHost
    if (hint?.modal !== false) {
      backdrop = document.createElement('div')
      backdrop.className = 'acui-backdrop'
      backdrop.dataset.for = id
      backdrop.addEventListener('click', () => unmount(id, 'user'))
      centerHost.appendChild(backdrop)
    }
    centerHost.appendChild(el)
  } else if (placement === 'stage') {
    host = stageHost
    backdrop = document.createElement('div')
    backdrop.className = 'acui-backdrop acui-stage-backdrop'
    backdrop.dataset.for = id
    backdrop.addEventListener('click', () => unmount(id, 'user'))
    stageHost.appendChild(backdrop)
    stageHost.appendChild(el)
  } else if (placement === 'floating') {
    host = floatingHost
    floatingHost.appendChild(el)
    placeFloating(el)
    if (hint?.draggable !== false) makeDraggable(el)
  } else {
    notificationHost.appendChild(el)
  }

  instances.set(id, { el, component, mountedAt: Date.now(), backdrop, host })

  requestAnimationFrame(() => {
    el.classList.add('acui-enter-active')
    if (backdrop) backdrop.classList.add('acui-enter-active')
  })

  el.addEventListener('transitionend', () => {
    const preview = (el.shadowRoot?.textContent || el.textContent || '').trim().slice(0, 300)
    signalSink?.({ type: 'card.mounted', target: id, payload: { render_preview: preview } })
  }, { once: true })
}

let floatingOffset = 0
function placeFloating(el) {
  // 错开堆叠，避免新卡完全压在旧卡上
  const baseTop = 80
  const baseLeft = 120
  const step = 28
  el.style.position = 'absolute'
  el.style.top = `${baseTop + (floatingOffset % 6) * step}px`
  el.style.left = `${baseLeft + (floatingOffset % 6) * step}px`
  floatingOffset++
}

function makeDraggable(el) {
  // 用 mousedown 在卡片任意位置按下开始拖；按在交互元素上时不拖
  const NON_DRAG_TAGS = new Set(['INPUT', 'TEXTAREA', 'BUTTON', 'SELECT', 'OPTION', 'A', 'LABEL'])

  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    // composedPath 第一个目标若是表单元素则放过
    const path = e.composedPath ? e.composedPath() : [e.target]
    for (const node of path) {
      if (node === el) break
      if (node.nodeType === 1 && NON_DRAG_TAGS.has(node.tagName)) return
      if (node.nodeType === 1 && node.getAttribute && node.getAttribute('contenteditable') === 'true') return
    }

    const rect = el.getBoundingClientRect()
    const offsetX = e.clientX - rect.left
    const offsetY = e.clientY - rect.top
    const onMove = (ev) => {
      const x = Math.max(0, ev.clientX - offsetX)
      const y = Math.max(0, ev.clientY - offsetY)
      el.style.left = `${x}px`
      el.style.top  = `${y}px`
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      el.classList.remove('acui-dragging')
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    el.classList.add('acui-dragging')
    e.preventDefault()
  })
}

export function patch({ id, patchOp, data }) {
  document.dispatchEvent(new CustomEvent('acui:patch', {
    detail: { id, op: patchOp, data: data || {} }
  }))
}

export function update({ id, props }) {
  const inst = instances.get(id)
  if (!inst) return
  inst.el.props = { ...(inst.el.props || {}), ...props }
}

export function unmount(id, by = 'agent') {
  const inst = instances.get(id)
  if (!inst) return
  const dwell = Date.now() - inst.mountedAt
  inst.el.classList.add('acui-exit-active')
  inst.el.classList.remove('acui-enter-active')
  if (inst.backdrop) {
    inst.backdrop.classList.add('acui-exit-active')
    inst.backdrop.classList.remove('acui-enter-active')
  }

  const finalize = () => {
    if (inst.el.parentNode) inst.el.remove()
    if (inst.backdrop && inst.backdrop.parentNode) inst.backdrop.remove()
    instances.delete(id)
    signalSink?.({
      type: 'card.dismissed',
      target: id,
      payload: { by, dwell_ms: dwell }
    })
  }

  delete window.__acuiApps[id]

  let done = false
  const finalizeOnce = () => { if (!done) { done = true; finalize() } }
  inst.el.addEventListener('transitionend', finalizeOnce, { once: true })
  setTimeout(finalizeOnce, 400)
}
