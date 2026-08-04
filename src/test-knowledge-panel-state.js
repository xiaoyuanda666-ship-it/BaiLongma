import assert from 'node:assert/strict'
import { getKnowledgePanelState, setKnowledgePanelState } from './knowledge/panel-state.js'

assert.equal(getKnowledgePanelState().active, false)
const opened = setKnowledgePanelState({
  active: true,
  source: 'test',
  regionId: 'product-docs',
  query: '发布验证',
  documentId: '42',
})
assert.equal(opened.active, true)
assert.equal(opened.regionId, 'product-docs')
assert.equal(opened.query, '发布验证')
assert.equal(opened.documentId, '42')
assert.ok(opened.updatedAt)
const closed = setKnowledgePanelState({ active: false, source: 'test' })
assert.equal(closed.active, false)
assert.equal(closed.regionId, 'product-docs')
assert.equal(closed.query, '发布验证')
console.log('knowledge panel state tests passed')
