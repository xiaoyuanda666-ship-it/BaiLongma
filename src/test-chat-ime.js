// Brain UI IME keyboard handling tests.
//
// Run: node src/test-chat-ime.js

import assert from 'node:assert/strict'
import { isImeComposing } from './ui/brain-ui/chat.js'

assert.equal(isImeComposing({ key: 'Enter', isComposing: true }), true,
  'Enter used to confirm IME composition must not send')
assert.equal(isImeComposing({ key: 'Enter', keyCode: 229 }), true,
  'legacy Chromium IME keyCode must not send')
assert.equal(isImeComposing({ key: 'Enter', which: 229 }), true,
  'legacy which=229 IME event must not send')
assert.equal(isImeComposing({ key: 'Enter' }, true), true,
  'tracked composition state must take precedence over the key event')
assert.equal(isImeComposing({ key: 'Enter', isComposing: false }), false,
  'ordinary Enter remains available for sending')

console.log('All chat IME keyboard tests passed.')
