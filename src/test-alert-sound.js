// 测回复提示音开关的解析逻辑（纯函数，不依赖 localStorage/DOM）。
// 镜像 test-tool-protocol.js：import + node:assert/strict + console.log。
// Run: node src/test-alert-sound.js

import assert from 'node:assert/strict'
import { parseAlertEnabled } from './ui/brain-ui/alert-sound-pref.js'

// 默认开（保留现状）
assert.equal(parseAlertEnabled(null), true, 'null → 默认开（保留现状）')
assert.equal(parseAlertEnabled(undefined), true, 'undefined → 默认开')

// '0' = 关
assert.equal(parseAlertEnabled('0'), false, "'0' → 关")

// '1' 及其他 → 开
assert.equal(parseAlertEnabled('1'), true, "'1' → 开")
assert.equal(parseAlertEnabled('anything-else'), true, '其他非 0 值 → 开')

console.log('test-alert-sound passed')
