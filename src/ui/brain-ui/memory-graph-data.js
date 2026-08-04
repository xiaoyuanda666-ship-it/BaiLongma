// Pure memory-graph data helpers. Keeping link construction outside the D3
// surface makes the layout policy testable without a browser or simulation.

export function parseGraphEntities(raw) {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw || "[]") : (raw || []);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export function parseGraphLinks(raw) {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw || "[]") : (raw || []);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export function semanticChildTargets(node) {
  const targets = new Set();
  parseGraphLinks(node?.links).forEach(link => {
    if (!link || typeof link !== "object") return;
    const relation = String(link.relation || "").toLowerCase();
    const targetId = String(link.target_id || link.targetId || "").trim();
    if (relation === "parent_of" && targetId) targets.add(targetId);
  });
  return targets;
}

export function deterministicIndex(seed, mod) {
  let hash = 2166136261;
  const text = String(seed);
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0) % mod;
}

export function shuffleGraphItems(items, random = Math.random) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function markGraphCore(nodes) {
  nodes.forEach(node => { node._core = false; });
  const core = nodes.find(node => parseGraphEntities(node.entities).includes("agent:jarvis")) || nodes[0];
  if (core) core._core = true;
  return core || null;
}

function maxVisualChildren(node) {
  if (!node) return 2;
  if (node._core) return 4;
  return (node._deg >= 4 || node._strength >= 0.72) ? 4 : 2;
}

function createVisualOrder(nodes, random) {
  const core = nodes.find(node => node._core || parseGraphEntities(node.entities).includes("agent:jarvis")) || null;
  const rest = shuffleGraphItems(nodes.filter(node => !core || node._nid !== core._nid), random);
  return core ? [core, ...rest] : rest;
}

function chooseVisualParent(child, candidates, childCounts, random) {
  if (!candidates.length) return null;
  const weighted = [];
  candidates.forEach(candidate => {
    const currentChildren = childCounts.get(candidate._nid) || 0;
    const recencyBias = Math.max(0, 400000 - Math.abs((child._ts || 0) - (candidate._ts || 0))) / 100000;
    const coreBias = candidate._core ? 1.4 : 0;
    const strengthBias = (candidate._strength || 0.4) * 0.8;
    const remainingCapacity = Math.max(0, maxVisualChildren(candidate) - currentChildren);
    const capacityBias = currentChildren === 0 ? 1.2 : 0.35 + remainingCapacity * 0.25;
    const entries = 1 + Math.max(0, Math.round((recencyBias + coreBias + strengthBias + capacityBias) * 2));
    for (let index = 0; index < entries; index++) weighted.push(candidate);
  });
  const choices = weighted.length ? weighted : candidates;
  return choices[Math.floor(random() * choices.length)] || null;
}

function visualChildCounts(nodes, links) {
  const counts = new Map(nodes.map(node => [node._nid, 0]));
  links.forEach(link => {
    if (link._kind !== "visual_parent") return;
    const parentId = typeof link.target === "object" ? String(link.target._nid) : String(link.target);
    counts.set(parentId, (counts.get(parentId) || 0) + 1);
  });
  return counts;
}

export function buildMemoryGraphLinks(nodes, { random = Math.random } = {}) {
  if (nodes.length < 2) return [];
  const links = [];
  const linkSet = new Set();
  const ordered = createVisualOrder(nodes, random);
  const childCounts = new Map(ordered.map(node => [node._nid, 0]));

  for (let index = 1; index < ordered.length; index++) {
    const child = ordered[index];
    const candidates = ordered.slice(0, index)
      .filter(node => (childCounts.get(node._nid) || 0) < maxVisualChildren(node));
    const parent = chooseVisualParent(child, candidates, childCounts, random);
    if (!parent || parent._nid === child._nid) continue;
    const lid = `visual:${child._nid}=>${parent._nid}`;
    const reverse = `visual:${parent._nid}=>${child._nid}`;
    if (linkSet.has(lid) || linkSet.has(reverse)) continue;
    linkSet.add(lid);
    links.push({ source: child._nid, target: parent._nid, _lid: lid, _kind: "visual_parent" });
    childCounts.set(parent._nid, (childCounts.get(parent._nid) || 0) + 1);
  }

  const extraLinks = Math.min(18, Math.max(2, Math.floor(nodes.length / 5)));
  let added = 0;
  for (let index = 1; index < ordered.length && added < extraLinks; index++) {
    const source = ordered[index];
    const target = shuffleGraphItems(ordered.slice(0, index).filter(node => (
      node._nid !== source._nid && (childCounts.get(node._nid) || 0) < maxVisualChildren(node)
    )), random)[0];
    if (!target) continue;
    const lid = `visual-extra:${source._nid}=>${target._nid}`;
    const reverse = `visual-extra:${target._nid}=>${source._nid}`;
    const base = `visual:${source._nid}=>${target._nid}`;
    const baseReverse = `visual:${target._nid}=>${source._nid}`;
    if (linkSet.has(lid) || linkSet.has(reverse) || linkSet.has(base) || linkSet.has(baseReverse)) continue;
    linkSet.add(lid);
    links.push({ source: source._nid, target: target._nid, _lid: lid, _kind: "visual_random" });
    childCounts.set(target._nid, (childCounts.get(target._nid) || 0) + 1);
    added += 1;
  }
  return links;
}

export function findMemoryGraphAnchor(memory, nodes, links, { random = Math.random } = {}) {
  const childCounts = visualChildCounts(nodes, links);
  const candidates = createVisualOrder(nodes, random)
    .filter(node => (childCounts.get(node._nid) || 0) < maxVisualChildren(node));
  return chooseVisualParent(memory, candidates, childCounts, random)
    || nodes.find(node => node._core)
    || nodes[0]
    || null;
}
