const HIGH_SURROGATE_START = 0xD800
const HIGH_SURROGATE_END = 0xDBFF
const LOW_SURROGATE_START = 0xDC00
const LOW_SURROGATE_END = 0xDFFF
const REPLACEMENT_CHARACTER = '\uFFFD'

function isHighSurrogate(codeUnit) {
  return codeUnit >= HIGH_SURROGATE_START && codeUnit <= HIGH_SURROGATE_END
}

function isLowSurrogate(codeUnit) {
  return codeUnit >= LOW_SURROGATE_START && codeUnit <= LOW_SURROGATE_END
}

/**
 * Replace invalid UTF-16 code units while preserving valid surrogate pairs.
 *
 * JavaScript strings can contain lone surrogates. JSON.stringify serializes
 * them as values such as "\\ud800", which are valid JSON syntax but are not
 * valid Unicode scalar values and are rejected by some LLM API servers.
 */
export function replaceLoneSurrogates(value, onRepair = null) {
  const input = String(value)
  let output = ''
  let lastCopyStart = 0
  let repaired = 0

  for (let index = 0; index < input.length; index++) {
    const codeUnit = input.charCodeAt(index)

    if (isHighSurrogate(codeUnit)) {
      const nextCodeUnit = input.charCodeAt(index + 1)
      if (isLowSurrogate(nextCodeUnit)) {
        index++
        continue
      }
    } else if (!isLowSurrogate(codeUnit)) {
      continue
    }

    output += input.slice(lastCopyStart, index) + REPLACEMENT_CHARACTER
    lastCopyStart = index + 1
    repaired++
  }

  if (repaired === 0) return input
  output += input.slice(lastCopyStart)
  onRepair?.(repaired)
  return output
}

/**
 * Return a JSON-compatible copy whose string values and object keys contain
 * only valid Unicode scalar values. The source object is never mutated.
 */
export function sanitizeJsonForTransport(value, { onRepair } = {}) {
  let repairCount = 0
  const countRepair = count => { repairCount += count }
  const seen = new WeakMap()

  const visit = current => {
    if (typeof current === 'string') {
      return replaceLoneSurrogates(current, countRepair)
    }
    if (current === null || typeof current !== 'object') return current
    if (seen.has(current)) return seen.get(current)

    if (Array.isArray(current)) {
      const copy = new Array(current.length)
      seen.set(current, copy)
      for (let index = 0; index < current.length; index++) {
        if (index in current) copy[index] = visit(current[index])
      }
      return copy
    }

    const prototype = Object.getPrototypeOf(current)
    if (prototype !== Object.prototype && prototype !== null) return current

    const copy = Object.create(prototype)
    seen.set(current, copy)
    for (const key of Object.keys(current)) {
      const cleanKey = replaceLoneSurrogates(key, countRepair)
      Object.defineProperty(copy, cleanKey, {
        value: visit(current[key]),
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    return copy
  }

  const sanitized = visit(value)
  if (repairCount > 0) onRepair?.(repairCount)
  return sanitized
}

export function stringifyJsonForTransport(value, space) {
  return JSON.stringify(sanitizeJsonForTransport(value), null, space)
}
