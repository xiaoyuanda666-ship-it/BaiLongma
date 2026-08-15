// scene-shell 的核心:applyScene —— scene 状态的纯投影器。
//
// 唯一职责:把一份 scene(surfaces 数组)忠实地变成屏幕,并让帧间变化好看。
//   新 id          → 挂载 + enter 入场
//   消失的 id      → exit 出场,动画结束后移除
//   同 id、data 变 → morph(el, prev, next) 原地过渡
//   同 id、data 同 → 不动
// 同一 id 跨帧视为同一元素 → 转场是"一个元素在动",而非淡出+淡入(SCENE-PROTOCOL §7)。
//
// 这里没有任何业务逻辑、没有 fetch、不执行任何远端代码。它只读 scene、写 DOM、把 intent 上报。

import { getKind } from './kinds/index.js'

const EXIT_FALLBACK_MS = 1200   // 兜底:动画事件没触发时也要清理,避免幽灵元素

export class Shell {
  // root:舞台容器元素;onIntent({surface,name,data}):用户意图回调(上行)。
  constructor(root, { onIntent } = {}) {
    this.root = root
    this.onIntent = onIntent || (() => {})
    this.current = []                 // 上一帧的 surfaces(顺序后的)
    this.els = new Map()              // 顶层 id -> { el, surface }
  }

  // ── 公开入口:投影一份新 scene ───────────────────────────────────────
  applyScene(scene) {
    const next = orderSurfaces(scene && scene.surfaces ? scene.surfaces : [])
    const prevById = this.els
    const nextById = new Map(next.map(s => [s.id, s]))

    // 1) 消失的 id → 出场
    for (const [id, rec] of [...prevById]) {
      if (!nextById.has(id)) {
        this._exit(rec.el)
        prevById.delete(id)
      }
    }

    // 2) 按 next 顺序:新增 enter / 变化 morph / 不变跳过,并维持 DOM 顺序
    let anchor = null
    let enterIndex = 0
    for (const surface of next) {
      const prevRec = prevById.get(surface.id)
      let el
      if (!prevRec) {
        // 新增:建元素 + 错峰 enter
        el = this._mount(surface, enterIndex++)
        prevById.set(surface.id, { el, surface })
      } else {
        el = prevRec.el
        this._applyShell(el, surface)   // intent/focus 等外壳属性可能变,先更新
        if (!dataEqual(prevRec.surface.data, surface.data) || prevRec.surface.kind !== surface.kind) {
          if (prevRec.surface.kind !== surface.kind) {
            // kind 变了:无法 morph,整卡替换(罕见)。
            const fresh = this._mount(surface, enterIndex++)
            el.replaceWith(fresh)
            el = fresh
          } else {
            this._morph(el, prevRec.surface, surface)
          }
        }
        prevById.set(surface.id, { el, surface })
      }
      // 维持顺序:把 el 放到 anchor 之后
      if (anchor) { if (anchor.nextSibling !== el) this.root.insertBefore(el, anchor.nextSibling) }
      else if (this.root.firstChild !== el) this.root.insertBefore(el, this.root.firstChild)
      anchor = el
    }

    // 3) confront 在场时压暗背景(舞台层面的戏剧调度)
    const hasConfront = next.some(s => s.intent === 'confront')
    this.root.classList.toggle('has-confront', hasConfront)

    this.current = next
  }

  // ── 挂载一个顶层 surface:外壳 + kind 内容 + enter ───────────────────
  _mount(surface, staggerIndex = 0, { dismissible = true } = {}) {
    const el = this._buildSurface(surface, { dismissible })
    el.classList.add('is-entering')
    el.style.setProperty('--stagger', `${staggerIndex * 90}ms`)
    el.addEventListener('animationend', () => el.classList.remove('is-entering'), { once: true })
    getKind(surface.kind).enter(el)
    return el
  }

  // 构建 surface 外壳 + 内容(不含 enter class)。供顶层与递归子级共用。
  _buildSurface(surface, { dismissible = true } = {}) {
    const el = document.createElement('div')
    el.className = 'surface'
    el.dataset.id = surface.id
    el.dataset.kind = surface.kind
    this._applyShell(el, surface)
    const kind = getKind(surface.kind)
    const ctx = this._ctx(surface)
    if (dismissible) {
      el.classList.add('is-dismissible')
      const close = document.createElement('button')
      close.type = 'button'
      close.className = 'surface-close'
      close.title = '关闭卡片'
      close.setAttribute('aria-label', '关闭卡片')
      close.addEventListener('click', (event) => {
        event.stopPropagation()
        ctx.emit('dismiss', {})
      })
      el.appendChild(close)
    }
    el.appendChild(kind.render(surface.data || {}, ctx))
    return el
  }

  // 把 intent / focus 投影到外壳 data 属性,CSS 据此决定呈现强度与落位。
  _applyShell(el, surface) {
    el.dataset.intent = surface.intent || 'inform'
    el.dataset.focus = surface.focus ? 'true' : 'false'
  }

  // ── morph:同一元素原地过渡 ─────────────────────────────────────────
  _morph(el, prev, next) {
    el.classList.remove('is-morphing')
    void el.offsetWidth                 // 强制 reflow,允许同名动画重放
    el.classList.add('is-morphing')
    el.addEventListener('animationend', () => el.classList.remove('is-morphing'), { once: true })
    getKind(next.kind).morph(el, prev.data || {}, next.data || {}, this._ctx(next))
  }

  // ── exit:出场后移除 ────────────────────────────────────────────────
  _exit(el) {
    if (el._exiting) return
    el._exiting = true
    getKind(el.dataset.kind).exit(el)
    el.classList.remove('is-entering', 'is-morphing')
    el.classList.add('is-exiting')
    const done = () => { el.remove() }
    el.addEventListener('animationend', done, { once: true })
    setTimeout(done, EXIT_FALLBACK_MS)   // 兜底清理
  }

  // ── 渲染上下文:给 kind 的 emit(意图上报)+ 布局原语的递归生命周期钩子 ─
  // 关键:布局原语的 children 也是 surface,需要享有 enter/morph/exit。
  // 这里把 shell 的能力以函数注入,递归在 shell 内闭合,kind 不直接依赖 shell。
  _ctx(surface) {
    const self = this
    return {
      kind: surface.kind,
      // 意图上行:surface 字段始终是触发意图的 surface 自身 id(子级也用子级 id)。
      emit(name, data) {
        self.onIntent({ surface: surface.id, name, data: data || {} })
      },
      // 递归渲染一个子 surface(带外壳 + enter),供 layout 使用。
      renderChild(child, staggerIndex = 0) {
        // 子 surface 不是 SceneStore 里的独立顶层项，不放置无法独立关闭的重复按钮。
        return self._mount(child, staggerIndex, { dismissible: false })
      },
      // 递归 morph 一个已存在的子元素。
      morphChild(childEl, prevChild, nextChild) {
        self._applyShell(childEl, nextChild)
        self._morph(childEl, prevChild, nextChild)
      },
      // 递归出场一个子元素。
      exitChild(childEl) {
        self._exit(childEl)
      },
    }
  }
}

// ── 纯函数:排序与相等判定 ─────────────────────────────────────────────

// 按 order 升序(无 order 视为 0),order 相同保持数组顺序(稳定)。
// store 已排过序,这里再排一次以保证离线/手造 scene 也正确(纯投影应自洽)。
export function orderSurfaces(surfaces) {
  return surfaces
    .filter(s => s && typeof s.id === 'string' && typeof s.kind === 'string')
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const oa = typeof a.s.order === 'number' ? a.s.order : 0
      const ob = typeof b.s.order === 'number' ? b.s.order : 0
      return oa !== ob ? oa - ob : a.i - b.i
    })
    .map(x => x.s)
}

// data 是不可分割整体(SCENE-PROTOCOL §3.2):JSON 序列化比较即可判断是否需 morph。
export function dataEqual(a, b) {
  return JSON.stringify(a == null ? {} : a) === JSON.stringify(b == null ? {} : b)
}
