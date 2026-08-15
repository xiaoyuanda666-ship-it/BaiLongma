// 排版原语 kind:stack(纵向) / row(横向) / col(网格列)。
// data: { children: [Surface...], gap?: sm|md|lg, align?: start|center|end }
//   children 是内联的 surface(含 id/kind/data),由 shell 递归渲染。
// 上行 intent:透传子级意图(子级 surface 字段仍为子级自身 id)。
//
// 容器自身不画内容,只负责布局 + 把子 surface 的生命周期(enter/morph/exit)递归驱动起来,
// 让嵌套内容同样享有三段动画。递归渲染依赖注入进来的 ctx.renderChild / ctx.morphChild。

import { el } from './dom.js'

function classes(name, data = {}) {
  const gap = ['sm', 'md', 'lg'].includes(data.gap) ? data.gap : 'md'
  const align = ['start', 'center', 'end'].includes(data.align) ? data.align : 'stretch'
  return `k-layout lay-${name} gap-${gap} align-${align}`
}

// 把子 surface 数组渲染进 box,并记录 id→{el, data} 以便后续 morph diff。
function mountChildren(box, children, ctx) {
  const map = new Map()
  ;(children || []).forEach((child, i) => {
    if (!child || !child.id) return
    const childEl = ctx.renderChild(child, i)   // 由 shell 注入:建带外壳 + enter 的子元素
    if (childEl) { box.appendChild(childEl); map.set(child.id, { el: childEl, data: child.data, surface: child }) }
  })
  box._children = map
  return box
}

function makeKind(name) {
  return {
    render(data = {}, ctx = {}) {
      const box = el('div', { class: classes(name, data) })
      return mountChildren(box, data.children, ctx)
    },

    enter() {},
    exit() {},

    // morph:对 children 按 id 做一层 diff —— 新增子 enter、消失子 exit、留存子递归 morph。
    // 这让"容器里的某张卡变了"也走原地过渡,而不是整容器重建。
    morph(el_, prev = {}, next = {}, ctx = {}) {
      const box = el_.querySelector(':scope > .k-layout')
      if (!box) return
      box.className = classes(name, next)
      const prevMap = box._children || new Map()
      const nextChildren = Array.isArray(next.children) ? next.children : []
      const nextIds = new Set(nextChildren.map(c => c && c.id).filter(Boolean))
      const newMap = new Map()

      // 消失的子:出场后移除。
      for (const [id, rec] of prevMap) {
        if (!nextIds.has(id)) ctx.exitChild(rec.el)
      }

      // 按 next 顺序重排 / 新增 / morph。
      let anchor = null
      nextChildren.forEach((child, i) => {
        if (!child || !child.id) return
        const prevRec = prevMap.get(child.id)
        let childEl
        if (!prevRec) {
          childEl = ctx.renderChild(child, i)            // 新增 → enter
        } else {
          childEl = prevRec.el
          if (JSON.stringify(prevRec.data) !== JSON.stringify(child.data)) {
            ctx.morphChild(childEl, prevRec.surface, child)   // 数据变 → 递归 morph
          }
        }
        if (!childEl) return
        // 维持 DOM 顺序与 next 一致。
        if (anchor && anchor.nextSibling !== childEl) box.insertBefore(childEl, anchor.nextSibling)
        else if (!anchor && box.firstChild !== childEl) box.insertBefore(childEl, box.firstChild)
        anchor = childEl
        newMap.set(child.id, { el: childEl, data: child.data, surface: child })
      })
      box._children = newMap
    },
  }
}

export const stack = makeKind('stack')
export const row = makeKind('row')
export const col = makeKind('col')
