const INTERACTIVE_SELECTOR = [
  'a[href]', 'button', 'input', 'textarea', 'select', 'summary',
  '[role]', '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])',
].join(',')

function cssEscape(value) {
  return String(value).replace(/["\\]/g, '\\$&')
}

export async function clearPageRefs(pageState) {
  const handles = new Set([
    ...[...pageState.refs.values()].map(entry => entry.handle).filter(Boolean),
    ...(pageState.retiredRefs || []),
  ])
  pageState.refs.clear()
  pageState.retiredRefs?.clear()
  await Promise.allSettled([...handles].map(handle => handle.dispose()))
}

export async function extractReadablePage(page, { maxChars = 20_000 } = {}) {
  return page.evaluate(({ maxChars }) => {
    const clean = value => String(value || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
    const candidates = [
      ...document.querySelectorAll('article, main, [role="main"], .article, .post, .content, .entry-content, #content, #main'),
    ]
    const best = candidates
      .map(element => ({ text: clean(element.innerText) }))
      .sort((a, b) => b.text.length - a.text.length)[0]
    const bodyText = clean(document.body?.innerText)
    const text = best?.text?.length > 300 ? best.text : bodyText
    return {
      title: String(document.title || '').trim(),
      text: text.slice(0, maxChars),
      textLength: text.length,
    }
  }, { maxChars })
}

export async function inspectPage(pageState, { maxChars, maxElements }) {
  const documentEpoch = pageState.documentEpoch
  const prefix = `${pageState.refToken}-${documentEpoch}-`
  const snapshot = await pageState.page.evaluate(({ selector, maxChars, maxElements, prefix }) => {
    const bodyText = String(document.body?.innerText || '').replace(/\s+/g, ' ').trim()
    const allElements = [...document.querySelectorAll('*')]
    const refCounts = new Map()
    let nextRef = [...document.querySelectorAll('[data-bailongma-ref]')].reduce((next, element) => {
      const ref = element.getAttribute?.('data-bailongma-ref') || ''
      if (!ref.startsWith(prefix)) return next
      refCounts.set(ref, (refCounts.get(ref) || 0) + 1)
      const number = Number(ref.slice(prefix.length))
      return Number.isInteger(number) ? Math.max(next, number + 1) : next
    }, 1)

    const styleCache = new WeakMap()
    const styleFor = element => {
      let style = styleCache.get(element)
      if (!style) {
        style = getComputedStyle(element)
        styleCache.set(element, style)
      }
      return style
    }
    const isVisible = element => {
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return false
      if (typeof element.checkVisibility === 'function' && !element.checkVisibility({
        checkOpacity: true,
        checkVisibilityCSS: true,
        contentVisibilityAuto: true,
      })) return false
      for (let current = element; current instanceof HTMLElement; current = current.parentElement) {
        const style = styleFor(current)
        if (
          current.hidden || current.getAttribute('aria-hidden') === 'true' ||
          style.visibility === 'hidden' || style.visibility === 'collapse' ||
          style.display === 'none' || Number(style.opacity) === 0
        ) return false
      }
      return true
    }
    const isDisabled = element => (
      Boolean(element.closest(':disabled, [inert], [aria-disabled="true"]')) ||
      styleFor(element).pointerEvents === 'none'
    )
    const isUnsupported = element => (
      element instanceof HTMLInputElement && element.type.toLowerCase() === 'file'
    )
    const activationProperties = [
      'onclick', 'ondblclick', 'onmousedown', 'onmouseup',
      'onpointerdown', 'onpointerup', 'ontouchend',
    ]
    const activationPropNames = [
      'onClick', 'onClickCapture', 'onDoubleClick', 'onDoubleClickCapture',
      'onMouseDown', 'onMouseUp', 'onPointerDown', 'onPointerUp', 'onTouchEnd',
    ]
    const domActivationGetters = new Map(activationProperties.map(property => {
      for (let prototype = HTMLElement.prototype; prototype; prototype = Object.getPrototypeOf(prototype)) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, property)
        if (typeof descriptor?.get === 'function') return [property, descriptor.get]
      }
      return [property, null]
    }))
    const valueHasActivationHandler = value => {
      if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false
      return activationPropNames.some(name => {
        const descriptor = Object.getOwnPropertyDescriptor(value, name)
        return typeof descriptor?.value === 'function'
      })
    }
    const hasFrameworkActivationHandler = element => {
      for (const key of Object.getOwnPropertyNames(element)) {
        const descriptor = Object.getOwnPropertyDescriptor(element, key)
        const value = descriptor?.value
        if (/^__react(?:Props|EventHandlers)\$/.test(key) && valueHasActivationHandler(value)) return true
        if (/^__react(?:Fiber|InternalInstance)\$/.test(key)) {
          const props = value && Object.getOwnPropertyDescriptor(value, 'memoizedProps')?.value
          if (valueHasActivationHandler(props)) return true
        }
        if (key === '_vei' && valueHasActivationHandler(value)) return true
      }
      return false
    }
    const hasDomActivationHandler = element => activationProperties.some(property => {
      if (element.hasAttribute(property)) return true
      const nativeGetter = domActivationGetters.get(property)
      if (!nativeGetter) return false
      try {
        // Calling the prototype's DOM accessor directly bypasses a hostile own
        // getter installed with Object.defineProperty(element, property, ...).
        return typeof Reflect.apply(nativeGetter, element, []) === 'function'
      } catch {
        return false
      }
    })
    const isPointerBoundary = element => {
      if (styleFor(element).cursor !== 'pointer') return false
      const parent = element.parentElement
      return !(parent instanceof HTMLElement) || styleFor(parent).cursor !== 'pointer'
    }

    // Frameworks commonly attach handlers through private per-node props rather
    // than attributes. Read only known handler slots and never invoke page code.
    const candidateKinds = new WeakMap()
    const candidates = allElements.filter(element => {
      if (!(element instanceof HTMLElement) || !isVisible(element) || isDisabled(element) || isUnsupported(element)) return false
      const standard = element.matches(selector)
      const heuristic = (
        hasDomActivationHandler(element) ||
        hasFrameworkActivationHandler(element) ||
        isPointerBoundary(element)
      )
      if (!standard && !heuristic) return false
      candidateKinds.set(element, { heuristic })
      return true
    })

    // If both a container and a descendant are independently clickable, the
    // descendant is the more precise target. Cursor inheritance is collapsed
    // above to its first pointer boundary, avoiding refs on every nested div.
    const candidateSet = new Set(candidates)
    const shadowedAncestors = new Set()
    for (const candidate of candidates) {
      for (let ancestor = candidate.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (candidateSet.has(ancestor)) shadowedAncestors.add(ancestor)
      }
    }
    const deduplicatedCandidates = candidates.filter(element => !shadowedAncestors.has(element))

    const elements = []
    const claimedRefs = new Set()
    for (const element of deduplicatedCandidates) {
      if (elements.length >= maxElements) break
      let ref = element.getAttribute('data-bailongma-ref') || ''
      if (!ref.startsWith(prefix) || refCounts.get(ref) !== 1 || claimedRefs.has(ref)) {
        ref = `${prefix}${nextRef++}`
        element.setAttribute('data-bailongma-ref', ref)
      }
      claimedRefs.add(ref)
      const tag = element.tagName.toLowerCase()
      const type = element.getAttribute('type')?.toLowerCase() || null
      // File inputs are deliberately absent from the agent ref surface: this
      // browser capability does not expose uploads.
      if (tag === 'input' && type === 'file') continue
      const inputRole = tag === 'input' ? ({
        button: 'button', submit: 'button', reset: 'button', image: 'button', file: 'button',
        checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox',
      }[type] || 'textbox') : null
      const role = element.getAttribute('role') || inputRole || ({
        a: 'link', button: 'button', textarea: 'textbox',
        select: element.multiple ? 'listbox' : 'combobox', summary: 'button',
      }[tag] || (candidateKinds.get(element)?.heuristic ? 'button' : null))
      const labelledBy = element.getAttribute('aria-labelledby')
      const labelledText = labelledBy
        ? labelledBy.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim()
        : ''
      const associatedLabelText = 'labels' in element
        ? [...(element.labels || [])].map(label => label.innerText || label.textContent || '').join(' ').trim()
        : ''
      const wrappingLabelText = element.closest('label')?.innerText?.trim() || ''
      const name = (
        element.getAttribute('aria-label') || labelledText || associatedLabelText || wrappingLabelText ||
        element.getAttribute('alt') || element.getAttribute('title') ||
        element.getAttribute('placeholder') || element.innerText || ''
      ).replace(/\s+/g, ' ').trim().slice(0, 240)
      elements.push({
        ref, role, tag, name, type,
        disabled: false,
        checked: typeof element.checked === 'boolean' ? element.checked : undefined,
      })
    }
    return {
      title: document.title || '',
      text: bodyText.slice(0, maxChars),
      textLength: bodyText.length,
      elements,
    }
  }, { selector: INTERACTIVE_SELECTOR, maxChars, maxElements, prefix })

  const assertSameDocument = () => {
    if (pageState.documentEpoch === documentEpoch) return
    const error = new Error('Page document changed while browser_inspect was creating element refs')
    error.code = 'DOCUMENT_CHANGED'
    throw error
  }
  assertSameDocument()

  const nextRefs = new Map()
  const createdHandles = new Set()
  try {
    for (const element of snapshot.elements) {
      assertSameDocument()
      const existing = pageState.refs.get(element.ref)
      if (existing?.handle) {
        nextRefs.set(element.ref, existing)
        continue
      }
      const handle = await pageState.page.locator(`[data-bailongma-ref="${cssEscape(element.ref)}"]`).first().elementHandle()
      if (handle) createdHandles.add(handle)
      assertSameDocument()
      if (handle) nextRefs.set(element.ref, { handle, epoch: documentEpoch })
    }
    assertSameDocument()
  } catch (error) {
    await Promise.allSettled([...createdHandles].map(handle => handle.dispose()))
    throw error
  }
  for (const [ref, entry] of pageState.refs) {
    if (!nextRefs.has(ref)) entry.handle?.dispose().catch(() => {})
  }
  pageState.refs = nextRefs
  return snapshot
}
