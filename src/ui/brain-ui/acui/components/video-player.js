// VideoPlayer — ACUI 注册组件（模式 A）
// hint.placement 推荐用 'stage' 或 'center'
// props: { url: string, title?: string, autoplay?: boolean, poster?: string }
// 支持浏览器原生 Picture-in-Picture（PiP）

export class VideoPlayer extends HTMLElement {
  static get tagName() { return 'acui-video-player' }

  constructor() {
    super()
    this.attachShadow({ mode: 'open' })
    this._props = {}
  }

  set props(v) { this._props = v || {}; this._render() }
  get props() { return this._props }
  connectedCallback() { this._render() }

  _esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  _render() {
    const { url = '', title = '视频', autoplay = false, poster = '' } = this._props
    const pipSupported = document.pictureInPictureEnabled

    this.shadowRoot.innerHTML = `<style>
:host {
  display: flex;
  flex-direction: column;
  width: min(90vw, 960px);
  border-radius: 14px;
  overflow: hidden;
  background: #000;
  border: 1px solid rgba(138,168,200,0.2);
  box-shadow: 0 32px 96px rgba(0,0,0,0.7);
}
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: rgba(10,16,22,0.92);
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
button {
  background: transparent;
  border: 1px solid rgba(138,168,200,0.2);
  border-radius: 7px;
  color: rgba(215,226,238,0.55);
  cursor: pointer;
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  height: 28px;
  padding: 0 10px;
  display: flex;
  align-items: center;
  gap: 5px;
  transition: color 0.15s, background 0.15s, border-color 0.15s;
  white-space: nowrap;
  letter-spacing: 0.04em;
}
button:hover { color: #d7e2ee; background: rgba(138,168,200,0.1); border-color: rgba(138,168,200,0.35); }
.cl { width: 28px; padding: 0; justify-content: center; font-size: 14px; }
video {
  width: 100%;
  max-height: min(80vh, 740px);
  display: block;
  background: #000;
  outline: none;
}
.no-url {
  padding: 48px 24px;
  text-align: center;
  font-family: "JetBrains Mono", monospace;
  font-size: 12px;
  color: rgba(215,226,238,0.35);
  letter-spacing: 0.06em;
}
</style>
<div class="bar">
  <span class="title">${this._esc(title)}</span>
  ${pipSupported ? `<button id="pip-btn">⧉ 画中画</button>` : ''}
  <button class="cl" id="close-btn" title="关闭">✕</button>
</div>
${url
  ? `<video id="vid" controls${autoplay ? ' autoplay' : ''}${poster ? ` poster="${this._esc(poster)}"` : ''}>
       <source src="${this._esc(url)}">
       您的浏览器不支持 HTML5 视频。
     </video>`
  : `<div class="no-url">未提供视频地址</div>`
}`
    this._bind()
  }

  _bind() {
    const sr = this.shadowRoot
    const vid = sr.getElementById('vid')
    const dismiss = () => this.dispatchEvent(new CustomEvent('acui:dismiss', { detail: { by: 'user' }, bubbles: true, composed: true }))

    sr.getElementById('close-btn').onclick = dismiss

    const pipBtn = sr.getElementById('pip-btn')
    if (pipBtn && vid) {
      pipBtn.onclick = async () => {
        try {
          if (document.pictureInPictureElement) {
            await document.exitPictureInPicture()
          } else {
            await vid.requestPictureInPicture()
            dismiss()  // 进入 PiP 后关闭卡片，视频在系统层继续播放
          }
        } catch (e) {
          console.warn('[VideoPlayer] PiP 请求失败:', e)
        }
      }
    }
  }
}
