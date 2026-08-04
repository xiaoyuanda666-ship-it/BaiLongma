import assert from "node:assert/strict";
import {
  buildMemoryGraphLinks,
  findMemoryGraphAnchor,
  markGraphCore,
  semanticChildTargets,
} from "./ui/brain-ui/memory-graph-data.js";

const fixedRandom = () => 0;
const nodes = [
  { _nid: "agent", entities: '["agent:jarvis"]', _ts: 1 },
  { _nid: "a", _ts: 2, _strength: 0.8 },
  { _nid: "b", _ts: 3 },
  { _nid: "c", _ts: 4 },
];

assert.equal(markGraphCore(nodes)?._nid, "agent");
const links = buildMemoryGraphLinks(nodes, { random: fixedRandom });
assert.ok(links.length >= nodes.length - 1, "the visual graph should connect each non-core node");
assert.equal(new Set(links.map(link => link._lid)).size, links.length, "link ids must remain unique");
assert.ok(links.every(link => link.source !== link.target), "self links are not valid visual links");
assert.ok(findMemoryGraphAnchor({ _nid: "new", _ts: 5 }, nodes, links, { random: fixedRandom }));
assert.deepEqual(
  [...semanticChildTargets({ links: '[{"relation":"parent_of","target_id":"child"}]' })],
  ["child"],
);

console.log("Memory graph data tests passed");
