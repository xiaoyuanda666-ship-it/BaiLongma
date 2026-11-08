import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { buildMemoryGraphLinks } from './ui/brain-ui/memory-graph-data.js';

const source = fs.readFileSync(new URL('./ui/brain-ui/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function addNewNodes(memories)');
const end = source.indexOf('\nif (MEMORY_GRAPH_ENABLED)', start);
const context = vm.createContext({
  MEMORY_GRAPH_ENABLED: true,
  nodeData: [], linkData: [],
  graphLayout: { centerX: 0, centerY: 0, scale: 1 },
  findMemoryGraphAnchor: () => null,
  buildMemoryGraphLinks,
  renderGraph() {}, highlightNodes() {},
});
vm.runInContext(source.slice(start, end), context);
// Simulate incremental events while periodic refreshes are unavailable.
for (let batch = 0; batch < 100; batch++) {
  context.memories = Array.from({ length: 25 }, (_, index) => ({
    mem_id: String(batch * 25 + index + 1), content: 'memory',
  }));
  vm.runInContext('addNewNodes(memories)', context);
  assert.ok(context.nodeData.length <= 120);
}
assert.equal(context.nodeData.length, 120);
assert.equal(context.nodeData.at(-1)._nid, '2500');
assert.equal(context.nodeData[0]._nid, '2381');
vm.runInContext('addNewNodes(memories)', context);
assert.equal(context.nodeData.length, 120, 'replayed events must not duplicate nodes');
console.log('PASS graph stays within 120 nodes across 2500 incremental memories');
