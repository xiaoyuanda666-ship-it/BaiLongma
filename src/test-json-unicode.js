import assert from 'node:assert/strict'
import {
  replaceLoneSurrogates,
  sanitizeJsonForTransport,
  stringifyJsonForTransport,
} from './runtime/json-unicode.js'

const validText = 'ASCII 中文 😀 𠮷 끝'
assert.equal(replaceLoneSurrogates(validText), validText, 'valid Unicode is preserved')

assert.equal(replaceLoneSurrogates(`high:${'\uD83D'}!`), 'high:�!')
assert.equal(replaceLoneSurrogates(`low:${'\uDE00'}!`), 'low:�!')
assert.equal(replaceLoneSurrogates(`reversed:${'\uDE00\uD83D'}!`), 'reversed:��!')
assert.equal(
  replaceLoneSurrogates(`mixed:${'\uD83D\uDE00\uD83D'}!`),
  'mixed:😀�!',
  'a valid pair next to a lone surrogate is handled independently',
)

const source = {
  message: `keep 😀 and repair ${'\uD800'}`,
  nested: [`${'\uDC00'} tail`, { normal: '𠮷' }],
  [`bad-key-${'\uD801'}`]: 'value',
}
let repairCount = 0
const sanitized = sanitizeJsonForTransport(source, {
  onRepair: count => { repairCount = count },
})

assert.equal(repairCount, 3, 'reports repaired code units without exposing content')
assert.equal(sanitized.message, 'keep 😀 and repair �')
assert.equal(sanitized.nested[0], '� tail')
assert.equal(sanitized.nested[1].normal, '𠮷')
assert.equal(sanitized['bad-key-�'], 'value')
assert.equal(source.message.at(-1), '\uD800', 'does not mutate the source request')
assert(Object.hasOwn(source, `bad-key-${'\uD801'}`), 'does not mutate source object keys')

const wireBody = stringifyJsonForTransport({ messages: [source] })
assert(!/\\ud[89ab][0-9a-f]{2}|\\ud[c-f][0-9a-f]{2}/i.test(wireBody), 'wire JSON contains no surrogate escapes')
assert.deepEqual(JSON.parse(wireBody), { messages: [sanitized] }, 'sanitized JSON round-trips')

console.log('PASS LLM JSON transport repairs lone surrogates and preserves valid Unicode')
