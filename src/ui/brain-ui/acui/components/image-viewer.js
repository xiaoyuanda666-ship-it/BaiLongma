// ImageViewer — ACUI 注册组件（模式 A）
// hint.placement 推荐用 'stage' 或 'center'
// props: { url: string, title?: string }

export class ImageViewer extends HTMLElement {
  static get tagName() { return 'acui-image-viewer' }

  constructor() {
    super()
    this.attachShadow({ mode: 'open' })
    this._props = {}
    this._scale = 1
    this._pan = { x: 0, y: 0 }
    this._dragging = false
    this._dragStart = null
    this._didDrag = false
  }

  set props(v) { this._props = v || {}; this._render() }
  get props() { return this._props }
  connectedCallback() { this._render() }

  _esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  _render() {
    const { url = '', title = '图片' } = this._props
    this.shadowRoot.innerHTML = `<style>
:host {
  display: flex;
  flex-direction: column;
  max-width: min(92vw, 1100px);
  max-height: min(90vh, 920px);
  border-radius: 14px;
  overflow: hidden;
  background: rgba(6,10,16,0.97);
  border: 1px solid rgba(138,168,200,0.22);
  box-shadow: 0 32px 96px rgba(0,0,0,0.65);
}
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: rgba(15,24,34,0.82);
  border-bottom: 1px solid rgba(138,168,200,0.1);
  flex-shrink: 0;
}
.title {
  flex: 1;
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  color: rgba(215,226,238,0.6);
  letter-spacing: 0.06em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.zoom-info {
  font-family: "JetBrains Mono", monospace;
  font-size: 10px;
  color: rgba(215,226,238,0.38);
  min-width: 38px;
  text-align: right;
}
button {
  background: transparent;
  border: 1px solid rgba(138,168,200,0.2);
  border-radius: 7px;
  color: rgba(215,226,238,0.55);
  cursor: pointer;
  font-size: 14px;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.15s, background 0.15s, border-color 0.15s;
  padding: 0;
  line-height: 1;
}
button:hover { color: #d7e2ee; background: rgba(138,168,200,0.1); border-color: rgba(138,168,200,0.35); }
.wrap {
  flex: 1;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(4,8,13,0.96);
  cursor: zoom-in;
  min-height: 200px;
  position: relative;
}
.wrap.zoomed { cursor: grab; }
.wrap.grabbing { cursor: grabbing !important; }
img {
  max-width: 100%;
  max-height: min(82vh, 860px);
  object-fit: contain;
  display: block;
  user-select: none;
  -webkit-user-drag: none;
  transform-origin: center;
  will-change: transform;
}
</style>
<div class="bar">
  <span class="title">${this._esc(title)}</span>
  <span class="zoom-info" id="zlbl">100%</span>
  <button id="zi" title="放大">＋</button>
  <button id="zo" title="缩小">－</button>
  <button id="zr" title="还原 1:1">⊡</button>
  <button id="cl" title="关闭">✕</button>
</div>
<div class="wrap" id="wrap">
  <img id="img" src="${this._esc(url)}" draggable="false">
</div>`
    this._bind()
  }

  _applyTransform() {
    const img = this.shadowRoot.getElementById('img')
    const zlbl = this.shadowRoot.getElementById('zlbl')
    const wrap = this.shadowRoot.getElementById('wrap')
    if (!img) return
    img.style.transform = `translate(${this._pan.x}px,${this._pan.y}px) scale(${this._scale})`
    zlbl.textContent = `${Math.round(this._scale * 100)}%`
    wrap.classList.toggle('zoomed', this._scale > 1.05)
  }

  _bind() {
    const sr = this.shadowRoot
    const wrap = sr.getElementById('wrap')
    const img = sr.getElementById('img')
    const dismiss = () => this.dispatchEvent(new CustomEvent('acui:dismiss', { detail: { by: 'user' }, bubbles: true, composed: true }))

    sr.getElementById('cl').onclick = dismiss
    sr.getElementById('zi').onclick = e => { e.stopPropagation(); this._scale = Math.min(8, this._scale * 1.3); this._applyTransform() }
    sr.getElementById('zo').onclick = e => { e.stopPropagation(); this._scale = Math.max(0.15, this._scale / 1.3); if (this._scale <= 1) this._pan = { x: 0, y: 0 }; this._applyTransform() }
    sr.getElementById('zr').onclick = e => { e.stopPropagation(); this._scale = 1; this._pan = { x: 0, y: 0 }; this._applyTransform() }

    wrap.addEventListener('click', () => {
      if (this._didDrag) { this._didDrag = false; return }
      this._scale = this._scale > 1.05 ? 1 : 2.2
      if (this._scale <= 1) this._pan = { x: 0, y: 0 }
      this._applyTransform()
    })

    wrap.addEventListener('wheel', e => {
      e.preventDefault()
      this._scale = Math.min(8, Math.max(0.15, this._scale * (e.deltaY < 0 ? 1.12 : 0.9)))
      if (this._scale <= 1) this._pan = { x: 0, y: 0 }
      this._applyTransform()
    }, { passive: false })

    // 缩放后支持拖拽平移
    img.addEventListener('mousedown', e => {
      if (this._scale <= 1.05 || e.button !== 0) return
      e.preventDefault()
      this._dragging = true
      this._didDrag = false
      this._dragStart = { x: e.clientX - this._pan.x, y: e.clientY - this._pan.y }
      wrap.classList.add('grabbing')
    })
    const onMove = e => {
      if (!this._dragging) return
      this._pan.x = e.clientX - this._dragStart.x
      this._pan.y = e.clientY - this._dragStart.y
      this._didDrag = true
      this._applyTransform()
    }
    const onUp = () => {
      if (!this._dragging) return
      this._dragging = false
      wrap.classList.remove('grabbing')
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)

    // 组件卸载时清理全局事件
    new MutationObserver(() => {
      if (!this.isConnected) {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
    }).observe(this.parentNode || document.body, { childList: true })
  }
}
