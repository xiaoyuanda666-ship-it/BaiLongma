import { renderBrainUiApp } from "./app-shell.js";
renderBrainUiApp(document.body);
const API = "http://localhost:3721";
const THEME_KEY = "jarvis-brain-ui-theme";
const PHYSICS_STORAGE_KEY = "jarvis-brain-ui-physics";
const MAX_CHAT_HISTORY = 60;
const DEFAULT_AGENT_NAME = "Longma";

const themeSwitcher = document.getElementById("theme-switcher");
const resetViewBtn = document.getElementById("reset-view-btn");
const physicsControl = document.getElementById("physics-control");
const physicsToggle = document.getElementById("physics-toggle");
const gravitySlider = document.getElementById("gravity-slider");
const repulsionSlider = document.getElementById("repulsion-slider");
const nodeSizeSlider = document.getElementById("node-size-slider");
const gravityValue = document.getElementById("gravity-value");
const repulsionValue = document.getElementById("repulsion-value");
const nodeSizeValue = document.getElementById("node-size-value");
const brandNameEl = document.getElementById("agent-brand-name");
const graphEl = document.getElementById("graph");

let agentName = DEFAULT_AGENT_NAME;

function setAgentName(nextName) {
  const normalized = String(nextName || "").trim() || DEFAULT_AGENT_NAME;
  agentName = normalized;
  document.title = `${normalized} · Cognitive Surface`;
  if (brandNameEl) brandNameEl.textContent = `${normalized} AI Agent`;
  if (graphEl) graphEl.setAttribute("aria-label", `${normalized} memory graph`);
  const input = document.getElementById("msg-input");
  if (input) input.placeholder = `向 ${normalized} 发送消息…`;
  document.querySelectorAll(".msg-jarvis .msg-label").forEach((el) => {
    el.textContent = normalized;
  });
}

async function loadAgentProfile() {
  try {
    const res = await fetch(`${API}/agent-profile`);
    if (!res.ok) return;
    const data = await res.json();
    setAgentName(data.name);
  } catch {}
}

const physicsSettings = {
  gravity: 1,
  repulsion: 1.35,
  nodeSize: 1,
};

requestAnimationFrame(() => {
  themeSwitcher.classList.add("visible");
  resetViewBtn.classList.add("visible");
  physicsControl.classList.add("visible");
});

function readCSSVar(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

function readPhysicsSettings() {
  try {
    const raw = localStorage.getItem(PHYSICS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.gravity === "number") physicsSettings.gravity = parsed.gravity;
      if (typeof parsed.repulsion === "number") physicsSettings.repulsion = parsed.repulsion;
      if (typeof parsed.nodeSize === "number") physicsSettings.nodeSize = parsed.nodeSize;
    }
  } catch {}
}

function savePhysicsSettings() {
  try {
    localStorage.setItem(PHYSICS_STORAGE_KEY, JSON.stringify(physicsSettings));
  } catch {}
}

function updatePhysicsReadout() {
  gravitySlider.value = String(physicsSettings.gravity);
  repulsionSlider.value = String(physicsSettings.repulsion);
  nodeSizeSlider.value = String(physicsSettings.nodeSize);
  gravityValue.textContent = `${physicsSettings.gravity.toFixed(2)}x`;
  repulsionValue.textContent = `${physicsSettings.repulsion.toFixed(2)}x`;
  nodeSizeValue.textContent = `${physicsSettings.nodeSize.toFixed(2)}x`;
}

let themeColors = {};
function refreshThemeColors() {
  themeColors = {
    cool: readCSSVar("--cool"),
    warm: readCSSVar("--warm"),
    nodeLow: readCSSVar("--node-low"),
    nodeHigh: readCSSVar("--node-high"),
    dim: readCSSVar("--dim"),
    ink2: readCSSVar("--ink2"),
    linkStroke: readCSSVar("--link-stroke"),
    bg0: readCSSVar("--bg0"),
  };
}

function applyTheme(theme) {
  document.body.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch {}
  document.querySelectorAll(".theme-dot").forEach(el => {
    el.classList.toggle("active", el.dataset.t === theme);
  });
  setTimeout(() => {
    refreshThemeColors();
    renderLegend();
    if (nodeSel && !nodeSel.empty()) {
      refreshNodeVisuals();
      linkSel.attr("stroke", themeColors.linkStroke);
    }
  }, 20);
}

(function initTheme() {
  let saved = "midnight";
  try { saved = localStorage.getItem(THEME_KEY) || "midnight"; } catch {}
  applyTheme(saved);
})();

themeSwitcher.querySelectorAll(".theme-dot").forEach(el => {
  el.addEventListener("click", () => applyTheme(el.dataset.t));
});

physicsToggle.addEventListener("click", () => {
  const nextOpen = !physicsControl.classList.contains("open");
  physicsControl.classList.toggle("open", nextOpen);
  physicsToggle.setAttribute("aria-expanded", String(nextOpen));
});

gravitySlider.addEventListener("input", () => {
  physicsSettings.gravity = Number(gravitySlider.value);
  applyPhysicsSettings();
});

repulsionSlider.addEventListener("input", () => {
  physicsSettings.repulsion = Number(repulsionSlider.value);
  applyPhysicsSettings();
});

nodeSizeSlider.addEventListener("input", () => {
  physicsSettings.nodeSize = Number(nodeSizeSlider.value);
  applyPhysicsSettings();
});

let W = window.innerWidth;
let H = window.innerHeight;

const svg = d3.select("#graph").attr("width", W).attr("height", H);
const tip = d3.select("#tip");

const defs = svg.append("defs");
defs.html(`
  <filter id="neb-glow" x="-70%" y="-70%" width="240%" height="240%">
    <feGaussianBlur stdDeviation="3.2" result="blur"/>
    <feMerge>
      <feMergeNode in="blur"/>
      <feMergeNode in="SourceGraphic"/>
    </feMerge>
  </filter>
`);

const world = svg.append("g");
const gLink = world.append("g").attr("stroke-linecap", "round");
const gNode = world.append("g");

const zoom = d3.zoom()
  .scaleExtent([0.1, 5])
  .filter(event => event.type === "wheel")
  .on("zoom", event => world.attr("transform", event.transform));

svg.call(zoom);
svg.on("wheel.zoom", null);
svg.on("dblclick.zoom", null);

svg.node().addEventListener("wheel", event => {
  event.preventDefault();
  const current = d3.zoomTransform(svg.node());
  const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
  const nextScale = Math.max(0.1, Math.min(5, current.k * factor));
  const k = nextScale / current.k;
  const px = W / 2, py = H / 2;
  const nextX = px - (px - current.x) * k;
  const nextY = py - (py - current.y) * k;
  svg.call(zoom.transform, d3.zoomIdentity.translate(nextX, nextY).scale(nextScale));
}, { passive: false });

function resetZoom() {
  svg.transition().duration(420).call(
    zoom.transform,
    d3.zoomIdentity
  );
}

const glowSet = new Map();
const usePulseSet = new Map();
let linkData = [];
let nodeData = [];
let linkSel = gLink.selectAll("line");
let nodeSel = gNode.selectAll("circle");

const nodeCountEl = document.getElementById("node-count");
const linkCountEl = document.getElementById("link-count");
const connStateEl = document.getElementById("conn-state");

function updateStats() {
  nodeCountEl.textContent = String(nodeData.length);
  linkCountEl.textContent = String(linkData.length);
}

function setConnectionState(text, live = true) {
  connStateEl.innerHTML = live
    ? `<span class="live-dot"></span>${text}`
    : text;
  connStateEl.classList.toggle("live", live);
}

function isGlowing(nid) {
  const expiry = glowSet.get(nid);
  if (!expiry) return false;
  if (Date.now() > expiry) { glowSet.delete(nid); return false; }
  return true;
}

function highlightNodes(nids, duration = 2400) {
  if (!nids || !nids.length) return;
  const now = Date.now();
  const expiry = now + duration;
  nids.forEach(nid => {
    const key = String(nid);
    glowSet.set(key, expiry);
    usePulseSet.set(key, { start: now, end: expiry });
  });
  refreshNodeVisuals();
  sim.alpha(Math.max(sim.alpha(), 2)).restart();
  setTimeout(() => {
    nids.forEach(nid => {
      const key = String(nid);
      glowSet.delete(key);
      usePulseSet.delete(key);
    });
    refreshNodeVisuals();
  }, duration + 80);
}

function nodeUseProgress(nid) {
  const key = String(nid);
  const pulse = usePulseSet.get(key);
  if (!pulse) return 0;
  const now = Date.now();
  if (now >= pulse.end) {
    usePulseSet.delete(key);
    return 0;
  }
  const total = Math.max(1, pulse.end - pulse.start);
  return 1 - ((now - pulse.start) / total);
}

function nodeStrength(d) {
  if (typeof d._strength !== "number") {
    const deg = Math.min(1, (d._deg || 0) / 12);
    d._strength = 0.35 + deg * 0.55;
  }
  return d._strength;
}

function nodeColor(d) {
  if (d._core) return themeColors.warm || "#d39872";
  const age = (Date.now() - (d._ts || Date.now())) / 18000;
  const fade = Math.max(0.25, 1 - age);
  const t = 0.18 + nodeStrength(d) * 0.5 * fade;
  const interp = d3.interpolateRgb(themeColors.nodeLow || "#3a556e", themeColors.nodeHigh || "#cfe3f5");
  let color = interp(Math.min(1, t));
  const base = d3.color(color);
  if (base) color = base.darker(0.55) + "";
  const useBoost = nodeUseProgress(d._nid);
  if (isGlowing(d._nid) || useBoost > 0) {
    const c = d3.color(color);
    if (c) return c.brighter(2 + useBoost * 2) + "";
  }
  return color;
}

function nodeRadius(d) {
  const base = d._core ? 9 : 3.4 + Math.min((d._deg || 0) * 0.9, 5.4);
  const childScale = 1 + Math.min(1.5, (d._childCount || 0) * 0.18);
  const useBoost = nodeUseProgress(d._nid);
  const glowScale = isGlowing(d._nid) ? 1.08 : 1;
  const pulseScale = 1 + (Math.sin((1 - useBoost) * Math.PI * 3) * 0.04 + useBoost * 0.12);
  const scaledBase = base * physicsSettings.nodeSize;
  return Math.min(scaledBase * 2.5, scaledBase * childScale * glowScale * Math.max(1, pulseScale));
}

const sim = d3.forceSimulation()
  .force("link", d3.forceLink().id(d => d._nid))
  .force("charge", d3.forceManyBody())
  .force("center", d3.forceCenter(W / 2, H / 2 - 10))
  .force("x", d3.forceX(W / 2))
  .force("y", d3.forceY(H / 2 - 10))
  .force("radial", d3.forceRadial(180, W / 2, H / 2 - 10))
  .force("collision", d3.forceCollide())
  .alphaDecay(0.02)
  .velocityDecay(0.3)
  .on("tick", tick);

function linkDistance(link) {
  const countFactor = Math.min(34, Math.sqrt(Math.max(1, nodeData.length)) * 4.2);
  if (link._kind === "visual_parent") return 82 + countFactor * 0.45;
  if (link._kind === "visual_random") return 108 + countFactor;
  return 76 + countFactor * 0.55;
}

function linkStrength(link) {
  if (link._kind === "visual_parent") return 0.2;
  if (link._kind === "visual_random") return 0.035;
  return 0.16;
}

function chargeStrength(node) {
  const countBoost = Math.min(76, Math.sqrt(Math.max(1, nodeData.length)) * 3.5);
  const baseCharge = -92 - countBoost * 0.4 - (node._deg || 0) * 2.4 - (node._childCount || 0) * 1.2;
  return baseCharge * physicsSettings.repulsion;
}

function radialStrength() {
  const baseSpread = nodeData.length > 36 ? 0.1 : 0.1;
  return baseSpread * physicsSettings.gravity;
}

function centerPullStrength() {
  const basePull = nodeData.length > 36 ? 0.04 : 0.055;
  return basePull * physicsSettings.gravity;
}

function collisionRadius(node) {
  const countPadding = nodeData.length > 36 ? 6 : 4;
  return nodeRadius(node) + countPadding;
}

function updateSimulationForces() {
  sim.force("link")
    .distance(linkDistance)
    .strength(linkStrength);

  sim.force("charge")
    .strength(chargeStrength);

  sim.force("x")
    .x(W / 2)
    .strength(centerPullStrength());

  sim.force("y")
    .y(H / 2 - 10)
    .strength(centerPullStrength());

  sim.force("radial")
    .radius(Math.min(Math.max(24, Math.sqrt(Math.max(1, nodeData.length)) * 6), 64))
    .x(W / 2)
    .y(H / 2 - 10)
    .strength(radialStrength());

  sim.force("collision")
    .radius(collisionRadius)
    .strength(0.82)
    .iterations(nodeData.length > 40 ? 2 : 1);
}

function applyPhysicsSettings(restartAlpha = 2) {
  updatePhysicsReadout();
  updateSimulationForces();
  refreshNodeVisuals();
  sim.alpha(Math.max(sim.alpha(), restartAlpha)).restart();
  savePhysicsSettings();
}

function refreshNodeVisuals() {
  if (!nodeSel || nodeSel.empty()) return;
  nodeSel
    .attr("r", nodeRadius)
    .attr("fill", nodeColor)
    .attr("filter", d => (d._core || isGlowing(d._nid) || nodeUseProgress(d._nid) > 0) ? "url(#neb-glow)" : null)
    .style("animation", d => nodeUseProgress(d._nid) > 0 ? "neb-node-use 10s ease-out" : null);
}

function dampTangentialMotion() {
  const cx = W / 2;
  const cy = H / 2 - 10;
  const twitching = sim.alpha() > 0.45;

  nodeData.forEach(node => {
    if (!node || node.fx != null || node.fy != null) return;

    const dx = (node.x ?? cx) - cx;
    const dy = (node.y ?? cy) - cy;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.001) return;

    const rx = dx / dist;
    const ry = dy / dist;
    const tx = -ry;
    const ty = rx;
    const vx = node.vx || 0;
    const vy = node.vy || 0;
    const radialVelocity = vx * rx + vy * ry;
    const tangentialVelocity = vx * tx + vy * ty;
    const tangentialDamping = twitching ? 0.14 : 0.24;

    node.vx = radialVelocity * rx + tangentialVelocity * tangentialDamping * tx;
    node.vy = radialVelocity * ry + tangentialVelocity * tangentialDamping * ty;
  });
}

function naturalTwitch() {
  if (nodeData.length < 2) {
    sim.alpha(1).restart();
    return;
  }

  const nodeById = new Map(nodeData.map(node => [String(node._nid), node]));
  const anchorMap = new Map();
  linkData.forEach(link => {
    if (link._kind !== "visual_parent" && link._kind !== "visual_random") return;
    const sourceId = typeof link.source === "object" ? String(link.source._nid) : String(link.source);
    const targetId = typeof link.target === "object" ? String(link.target._nid) : String(link.target);
    if (!anchorMap.has(sourceId) && nodeById.has(targetId)) {
      anchorMap.set(sourceId, nodeById.get(targetId));
    }
  });

  const twitchCount = Math.max(6, Math.floor(nodeData.length * 0.3));
  const candidates = shuffleArray(nodeData.filter(node => !node._core)).slice(0, twitchCount);

  candidates.forEach(node => {
    const anchor = anchorMap.get(String(node._nid)) || nodeData[deterministicIndex(node._nid, nodeData.length)];
    if (!anchor) return;

    const anchorX = anchor.x ?? (W / 2);
    const anchorY = anchor.y ?? (H / 2 - 10);
    const angle = Math.random() * Math.PI * 2;
    const offset = 36 + Math.random() * 52;
    const nextX = anchorX + Math.cos(angle) * offset;
    const nextY = anchorY + Math.sin(angle) * offset;
    const currentX = node.x ?? nextX;
    const currentY = node.y ?? nextY;

    node.x = currentX * 0.7 + nextX * 0.3;
    node.y = currentY * 0.7 + nextY * 0.3;
    node.vx = (node.vx || 0) + (nextX - currentX) * 0.14;
    node.vy = (node.vy || 0) + (nextY - currentY) * 0.14;
  });

  sim.alpha(0.85).restart();
}

function tick() {
  dampTangentialMotion();

  linkSel
    .attr("x1", d => d.source.x)
    .attr("y1", d => d.source.y)
    .attr("x2", d => d.target.x)
    .attr("y2", d => d.target.y);

  nodeSel
    .attr("cx", d => d.x)
    .attr("cy", d => d.y);

  refreshNodeVisuals();
}

function computeDegrees() {
  const nodeById = new Map(nodeData.map(n => [n._nid, n]));
  nodeData.forEach(n => {
    n._deg = 0;
    n._childCount = 0;
  });
  linkData.forEach(l => {
    const s = typeof l.source === "object" ? l.source : nodeById.get(String(l.source));
    const t = typeof l.target === "object" ? l.target : nodeById.get(String(l.target));
    if (s) s._deg = (s._deg || 0) + 1;
    if (t) t._deg = (t._deg || 0) + 1;
  });

  nodeData.forEach(node => {
    const childTargets = semanticChildTargets(node);
    if (childTargets.size) {
      node._childCount = childTargets.size;
      return;
    }

    const selfId = String(node._nid || "");
    node._childCount = nodeData.reduce((count, candidate) => (
      candidate.parent_id != null && String(candidate.parent_id) === selfId ? count + 1 : count
    ), 0);
  });
}

function showTip(event, d) {
  const label = d.title || (d.content || "").slice(0, 120) || d._nid;
  const type = d._core ? "self" : (d.event_type || "memory");
  tip
    .style("display", "block")
    .style("left", `${event.clientX + 14}px`)
    .style("top", `${event.clientY + 12}px`)
    .html(`<span class="tip-type">${type}</span><div>${label}</div>`);
}

function parseEntities(raw) {
  try {
    const p = typeof raw === "string" ? JSON.parse(raw || "[]") : (raw || []);
    return Array.isArray(p) ? p : [];
  } catch { return []; }
}

function parseLinks(raw) {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw || "[]") : (raw || []);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function semanticChildTargets(node) {
  const targets = new Set();
  parseLinks(node.links).forEach(link => {
    if (!link || typeof link !== "object") return;
    const relation = String(link.relation || "").toLowerCase();
    const targetId = String(link.target_id || link.targetId || "").trim();
    if (relation === "parent_of" && targetId) targets.add(targetId);
  });
  return targets;
}

function markCore() {
  nodeData.forEach(n => { n._core = false; });
  const core = nodeData.find(n => parseEntities(n.entities).includes("agent:jarvis"))
    || nodeData[0];
  if (core) core._core = true;
}

function renderLegend() {
  const el = document.getElementById("legend");
  if (!el) return;
  const total = nodeData.length;
  const active = nodeData.filter(n => (Date.now() - (n._ts || 0)) < 15000).length;
  const known = Math.max(0, total - active - 1);
  const decayed = nodeData.filter(n => (Date.now() - (n._ts || 0)) > 60000).length;

  const items = [
    { name: "限制", count: 1, color: themeColors.warm },
    { name: "记忆", count: active, color: themeColors.nodeHigh },
    { name: "知识", count: known, color: themeColors.cool },
    { name: "衰减", count: decayed, color: themeColors.dim },
  ];

  el.innerHTML = items.map(i =>
    `<div class="legend-item">
      <span class="legend-dot" style="background:${i.color}"></span>
      <span class="legend-name">${i.name}</span>
      <span class="legend-count">${i.count}</span>
    </div>`
  ).join("");
}

function renderGraph(restartAlpha = 2) {
  computeDegrees();
  markCore();
  updateStats();
  renderLegend();

  linkSel = linkSel.data(linkData, d => d._lid);
  linkSel.exit().remove();
  linkSel = linkSel.enter().append("line")
    .attr("stroke", themeColors.linkStroke || "rgba(143,182,216,0.18)")
    .attr("stroke-width", 0.6)
    .merge(linkSel);

  nodeSel = nodeSel.data(nodeData, d => d._nid);
  nodeSel.exit().transition().duration(280).attr("r", 0).remove();

  const enter = nodeSel.enter().append("circle")
    .attr("r", 0)
    .attr("fill", nodeColor)
    .style("cursor", "pointer")
    .call(d3.drag()
      .on("start", (event, d) => {
        if (!event.active) sim.alphaTarget(2).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on("drag", (event, d) => {
        d.fx = event.x; d.fy = event.y;
      })
      .on("end", (event, d) => {
        if (!event.active) sim.alphaTarget(0);
        d.fx = null; d.fy = null;
      }))
    .on("mouseover", showTip)
    .on("mousemove", event => {
      tip.style("left", `${event.clientX + 14}px`)
         .style("top", `${event.clientY + 12}px`);
    })
    .on("mouseout", () => tip.style("display", "none"))
    .on("click", (event, d) => {
      d._ts = Date.now();
      d._strength = Math.min(1, (d._strength || 0.5) + 0.25);
      highlightNodes([d._nid], 900);
    });

  enter.transition().duration(360).attr("r", nodeRadius);
  nodeSel = enter.merge(nodeSel);

  sim.nodes(nodeData);
  sim.force("link").links(linkData);
  updateSimulationForces();
  sim.alpha(0.5).restart();
  refreshNodeVisuals();
}

function deterministicIndex(seed, mod) {
  let hash = 2166136261;
  const text = String(seed);
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0) % mod;
}

function shuffleArray(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function createVisualOrder(nodes) {
  const coreNode = nodes.find(n => n._core || parseEntities(n.entities).includes("agent:jarvis")) || null;
  const rest = shuffleArray(nodes.filter(n => !coreNode || n._nid !== coreNode._nid));
  return coreNode ? [coreNode, ...rest] : rest;
}

function chooseVisualParent(child, candidates, childCounts) {
  if (!candidates.length) return null;
  const weighted = [];
  candidates.forEach(candidate => {
    const currentChildren = childCounts.get(candidate._nid) || 0;
    const maxChildren = maxVisualChildren(candidate);
    const recencyBias = Math.max(0, 400000 - Math.abs((child._ts || 0) - (candidate._ts || 0))) / 100000;
    const coreBias = candidate._core ? 1.4 : 0;
    const strengthBias = (candidate._strength || 0.4) * 0.8;
    const remainingCapacity = Math.max(0, maxChildren - currentChildren);
    const capacityBias = currentChildren === 0 ? 1.2 : 0.35 + remainingCapacity * 0.25;
    const entryCount = 1 + Math.max(0, Math.round((recencyBias + coreBias + strengthBias + capacityBias) * 2));
    for (let w = 0; w < entryCount; w++) {
      weighted.push(candidate);
    }
  });
  if (!weighted.length) return candidates[Math.floor(Math.random() * candidates.length)] || null;
  return weighted[Math.floor(Math.random() * weighted.length)] || null;
}

function getCurrentVisualChildCounts(nodes) {
  const counts = new Map(nodes.map(n => [n._nid, 0]));
  linkData.forEach(link => {
    if (link._kind !== "visual_parent") return;
    const parentId = typeof link.target === "object" ? String(link.target._nid) : String(link.target);
    counts.set(parentId, (counts.get(parentId) || 0) + 1);
  });
  return counts;
}

function maxVisualChildren(node) {
  if (!node) return 2;
  if (node._core) return 4;
  const degree = node._deg || 0;
  const strength = node._strength || 0;
  return (degree >= 4 || strength >= 0.72) ? 4 : 2;
}

function addSupplementalVisualLinks(linkSet, childCounts) {
  const ordered = createVisualOrder(nodeData);
  const extraLinks = Math.min(18, Math.max(2, Math.floor(nodeData.length / 5)));
  let added = 0;

  for (let i = 1; i < ordered.length && added < extraLinks; i++) {
    const source = ordered[i];
    const candidates = shuffleArray(
      ordered.slice(0, i).filter(node => {
        if (node._nid === source._nid) return false;
        return (childCounts.get(node._nid) || 0) < maxVisualChildren(node);
      })
    );

    const target = candidates[0];
    if (!target) continue;

    const lid = `visual-extra:${source._nid}=>${target._nid}`;
    const rev = `visual-extra:${target._nid}=>${source._nid}`;
    const base = `visual:${source._nid}=>${target._nid}`;
    const baseRev = `visual:${target._nid}=>${source._nid}`;
    if (linkSet.has(lid) || linkSet.has(rev) || linkSet.has(base) || linkSet.has(baseRev)) continue;

    linkSet.add(lid);
    linkData.push({ source: source._nid, target: target._nid, _lid: lid, _kind: "visual_random" });
    childCounts.set(target._nid, (childCounts.get(target._nid) || 0) + 1);
    added += 1;
  }
}

function addRandomVisualLinks(linkSet) {
  if (nodeData.length < 2) return;

  const ordered = createVisualOrder(nodeData);
  const childCounts = new Map(ordered.map(n => [n._nid, 0]));

  for (let i = 1; i < ordered.length; i++) {
    const child = ordered[i];
    const candidates = ordered
      .slice(0, i)
      .filter(node => (childCounts.get(node._nid) || 0) < maxVisualChildren(node));

    const parent = chooseVisualParent(child, candidates, childCounts);
    if (!parent || parent._nid === child._nid) continue;

    const lid = `visual:${child._nid}=>${parent._nid}`;
    const rev = `visual:${parent._nid}=>${child._nid}`;
    if (linkSet.has(lid) || linkSet.has(rev)) continue;

    linkSet.add(lid);
    linkData.push({ source: child._nid, target: parent._nid, _lid: lid, _kind: "visual_parent" });
    childCounts.set(parent._nid, (childCounts.get(parent._nid) || 0) + 1);
  }

  addSupplementalVisualLinks(linkSet, childCounts);
}

function findAnchorNode(memory, nodeMap) {
  const nodes = Array.from(nodeMap.values());
  const childCounts = getCurrentVisualChildCounts(nodes);
  const candidates = createVisualOrder(nodes)
    .filter(node => (childCounts.get(node._nid) || 0) < maxVisualChildren(node));
  return chooseVisualParent(memory, candidates, childCounts)
    || nodeData.find(n => n._core)
    || nodeData[0]
    || null;
}

async function loadMemories() {
  try {
    const rows = await fetch(`${API}/memories?limit=120`).then(r => r.json());
    if (!Array.isArray(rows)) return;

    const prevPositions = new Map(nodeData.map(n => [n._nid, {
      x: n.x, y: n.y, vx: n.vx, vy: n.vy, fx: n.fx, fy: n.fy,
    }]));

    nodeData = rows.map(row => {
      const nid = row.mem_id || String(row.id);
      const prev = prevPositions.get(nid);
      return {
        ...row,
        _nid: nid,
        _ts: prev ? Date.now() : Date.now() - Math.random() * 8000,
        x: prev ? prev.x : W / 2 + (Math.random() - 0.5) * 180,
        y: prev ? prev.y : H / 2 + (Math.random() - 0.5) * 180,
        vx: prev ? prev.vx : 0,
        vy: prev ? prev.vy : 0,
        fx: prev ? prev.fx : null,
        fy: prev ? prev.fy : null,
      };
    });

    const linkSet = new Set();
    linkData = [];
    addRandomVisualLinks(linkSet);

    renderGraph(1.1);
  } catch (error) {
    console.warn("[graph] load failed:", error.message);
    setConnectionState("Offline", false);
  }
}

function addNewNodes(memories) {
  const nodeMap = new Map(nodeData.map(n => [n._nid, n]));
  const newNids = [];
  memories.forEach(memory => {
    const nid = memory.id || memory.mem_id;
    if (!nid || nodeMap.has(String(nid))) return;
    const anchor = findAnchorNode(memory, nodeMap);
    const anchorX = anchor?.x ?? W / 2;
    const anchorY = anchor?.y ?? (H / 2 - 10);
    const node = {
      ...memory,
      _nid: String(nid),
      mem_id: String(nid),
      event_type: memory.event_type || memory.type || "fact",
      _ts: Date.now(),
      _strength: 0.85,
      x: anchorX + (Math.random() - 0.5) * 72,
      y: anchorY + (Math.random() - 0.5) * 72,
      vx: 0, vy: 0,
    };
    nodeData.push(node);
    nodeMap.set(node._nid, node);
    newNids.push(node._nid);
  });
  if (!newNids.length) return;

  const linkSet = new Set();
  linkData = [];
  addRandomVisualLinks(linkSet);
  renderGraph(2);
  highlightNodes(newNids, 10000);
}

setInterval(() => naturalTwitch(), 3000);
setInterval(() => { nodeData.forEach(n => { if (n._strength) n._strength *= 0.97; }); }, 2500);

const TOOL_ZH = {
  send_message: "发送消息",
  express: "表达",
  read_file: "读取文件",
  write_file: "写入文件",
  delete_file: "删除文件",
  make_dir: "创建目录",
  list_dir: "查看目录",
  exec_command: "执行命令",
  kill_process: "终止进程",
  list_processes: "列出进程",
  fetch_url: "抓取网页",
  search_memory: "检索记忆",
  set_tick_interval: "调整节奏",
  speak: "朗读",
  generate_lyrics: "生成歌词",
  generate_music: "生成音乐",
  generate_image: "生成图片",
};

const TOOL_ICON = {
  send_message: "💬",
  express: "🗣️",
  read_file: "📄",
  write_file: "✏️",
  delete_file: "🗑️",
  make_dir: "📁",
  list_dir: "📂",
  exec_command: "⚡",
  kill_process: "🛑",
  list_processes: "📋",
  fetch_url: "🌐",
  search_memory: "🔍",
  set_tick_interval: "⏱️",
  speak: "🔊",
  generate_lyrics: "🎵",
  generate_music: "🎼",
  generate_image: "🎨",
};

function parseUserMessageInput(raw) {
  const text = String(raw || "");
  const match = text.match(/^\[([^\]]+)\]\s+(\S+)\s+\[([^\]]+)\]\s+([\s\S]*)$/);
  if (!match) return { content: text.trim(), time: null };
  return { fromId: match[1], timestamp: match[2], channel: match[3], content: match[4].trim(), time: formatMsgTime(match[2]) };
}

function formatMsgTime(stamp) {
  if (!stamp) return null;
  const m = String(stamp).match(/T(\d{2}):(\d{2}):(\d{2})/);
  if (m) return `${m[1]}:${m[2]}:${m[3]}`;
  const m2 = String(stamp).match(/(\d{2}):(\d{2}):(\d{2})/);
  if (m2) return `${m2[1]}:${m2[2]}:${m2[3]}`;
  return null;
}

function isFailureResult(resultStr) {
  const t = (resultStr || "").trim();
  if (!t) return false;
  return /^(错误|失败|异常)[：:]/.test(t) || /^Error\b/i.test(t) || /^ERROR\b/.test(t);
}

class ThoughtStream {
  constructor(innerId, color, options = {}) {
    this.el = document.getElementById(innerId);
    this.scroller = this.el?.parentElement || null;
    this.color = color;
    this.thinkingLabel = options.thinkingLabel || "思考中";
    this.thinkingDoneLabel = options.thinkingDoneLabel || null;
    this.toolDetailLength = options.toolDetailLength || 160;
    this.MAX = 8;
    this.startedAt = Date.now();
    this.curLine = null;
    this.thinkingEl = null;
    this.lastToolEl = null;
    this.statusEl = null;
    this.hadToolCall = false;
    this.toolFailed = false;
  }

  tStamp() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }

  trim() {
    while (this.el.children.length > this.MAX) {
      const old = this.el.firstChild;
      old.classList.add("fading");
      setTimeout(() => old.remove(), 520);
      break;
    }
  }

  newLine(type = "stream", options = {}) {
    // 关闭上一条工具的旋转动画
    this.finalizeLastTool();
    this.thinkingLine = null;
    this.statusEl = null;
    this.hadToolCall = false;
    this.toolFailed = false;

    this.curLine = document.createElement("div");
    this.curLine.className = "stream-line";

    const color = readCSSVar(`--${this.color}`);
    const timeLabel = options.time || this.tStamp();

    const header = document.createElement("div");
    header.className = "line-header";
    header.innerHTML = `
      <span class="line-dot" style="background:${color}"></span>
      <span class="line-type" style="color:${color}"></span>
      <span class="line-time"></span>
    `;
    header.querySelector(".line-type").textContent = type;
    header.querySelector(".line-time").textContent = timeLabel;
    this.curLine.appendChild(header);

    if (options.content) {
      const textEl = document.createElement("div");
      textEl.className = "line-text";
      textEl.textContent = options.content;
      this.curLine.appendChild(textEl);
    }

    this.thinkingEl = null;

    this.el.appendChild(this.curLine);
    this.trim();
    this.scrollToLatest();
  }

  scrollToLatest() {
    if (!this.scroller) return;
    requestAnimationFrame(() => {
      this.scroller.scrollTop = this.scroller.scrollHeight;
    });
  }

  setStatus(text, kind = "busy") {
    if (!this.curLine) this.newLine(this.thinkingLabel);
    const header = this.curLine.querySelector(".line-header");
    if (!header) return;
    if (!this.statusEl || !this.statusEl.parentElement) {
      this.statusEl = document.createElement("span");
      this.statusEl.className = "line-status";
      const timeEl = header.querySelector(".line-time");
      header.insertBefore(this.statusEl, timeEl || null);
    }
    this.statusEl.className = `line-status ${kind}`.trim();
    this.statusEl.textContent = text;
  }

  clearStatus() {
    if (this.statusEl && this.statusEl.parentElement) {
      this.statusEl.remove();
    }
    this.statusEl = null;
  }

  // 开启一轮思考：若本轮已有思考行，则复用该行并恢复动画
  startThinkingSession() {
    if (this.thinkingLine && this.thinkingLine.parentElement) {
      this.curLine = this.thinkingLine;
      const typeSpan = this.curLine.querySelector(".line-type");
      if (typeSpan) typeSpan.textContent = this.thinkingLabel;
      const timeSpan = this.curLine.querySelector(".line-time");
      if (timeSpan) timeSpan.textContent = this.tStamp();
    } else {
      this.newLine(this.thinkingLabel);
      this.thinkingLine = this.curLine;
    }
    this.clearStatus();
    this.startThinking();
  }

  // 思考中动画：仅显示动画圆点；标签通过 line-type 呈现
  startThinking() {
    if (!this.curLine) {
      this.newLine(this.thinkingLabel);
      this.thinkingLine = this.curLine;
    }
    if (this.thinkingEl) return;
    const el = document.createElement("div");
    el.className = "line-thinking";
    el.style.color = readCSSVar(`--${this.color}`);
    el.innerHTML = `<span class="dot"></span><span class="dot"></span><span class="dot"></span>`;
    this.curLine.appendChild(el);
    this.thinkingEl = el;
    this.scrollToLatest();
  }

  stopThinking() {
    if (this.thinkingEl) {
      this.thinkingEl.classList.add("done");
      if (this.thinkingDoneLabel) {
        const line = this.thinkingEl.parentElement;
        const typeSpan = line && line.querySelector(".line-type");
        if (typeSpan) typeSpan.textContent = this.thinkingDoneLabel;
      }
    }
    this.thinkingEl = null;
    this.clearStatus();
  }

  finalizeLastTool() {
    if (this.lastToolEl) {
      this.lastToolEl.classList.add("done");
      this.lastToolEl = null;
    }
  }

  // 显示中文工具名 + 图标 + 成功/失败状态 + 结果摘要
  tool(name, args, result) {
    if (!this.curLine) this.newLine("工具调用");
    this.finalizeLastTool();

    const zh = TOOL_ZH[name] || name;
    const icon = TOOL_ICON[name] || "🔧";
    const resultStr = result == null ? "" : String(result);
    const failure = isFailureResult(resultStr);
    this.hadToolCall = true;
    this.toolFailed = this.toolFailed || failure;
    const statusCls = failure ? "failed" : "success";
    const statusIcon = failure ? "✗" : "✓";
    const statusLabel = failure ? "失败" : "成功";

    const toolEl = document.createElement("div");
    toolEl.className = `line-tool done tool-${statusCls}`;
    toolEl.style.color = readCSSVar(`--${this.color}`);

    const iconSpan = document.createElement("span");
    iconSpan.className = "tool-icon";
    iconSpan.textContent = icon;
    const nameSpan = document.createElement("span");
    nameSpan.className = "tool-name";
    nameSpan.textContent = zh;
    const statusSpan = document.createElement("span");
    statusSpan.className = `tool-status ${statusCls}`;
    statusSpan.textContent = `${statusIcon} ${statusLabel}`;
    toolEl.appendChild(iconSpan);
    toolEl.appendChild(nameSpan);
    toolEl.appendChild(statusSpan);
    this.curLine.appendChild(toolEl);

    const trimmed = resultStr.trim();
    if (trimmed) {
      const detail = document.createElement("div");
      detail.className = "line-tool-detail";
      const snippet = trimmed.replace(/\s+/g, " ");
      detail.textContent = snippet.length > this.toolDetailLength
        ? snippet.slice(0, this.toolDetailLength) + "…"
        : snippet;
      this.curLine.appendChild(detail);
    }

    this.scrollToLatest();
    this.lastToolEl = null;
  }

  appendToolCycleEnd() {
    if (!this.curLine || !this.hadToolCall) return;

    const toolEl = document.createElement("div");
    const statusCls = this.toolFailed ? "failed" : "ended";
    toolEl.className = `line-tool done tool-${statusCls}`;
    toolEl.style.color = readCSSVar(`--${this.color}`);

    const iconSpan = document.createElement("span");
    iconSpan.className = "tool-icon";
    iconSpan.textContent = this.toolFailed ? "⚠" : "◎";

    const nameSpan = document.createElement("span");
    nameSpan.className = "tool-name";
    nameSpan.textContent = "工具调用结束";

    const statusSpan = document.createElement("span");
    statusSpan.className = `tool-status ${statusCls}`;
    statusSpan.textContent = this.toolFailed ? "已结束" : "完成";

    toolEl.appendChild(iconSpan);
    toolEl.appendChild(nameSpan);
    toolEl.appendChild(statusSpan);
    this.curLine.appendChild(toolEl);
    this.scrollToLatest();
  }

  end() {
    this.stopThinking();
    this.finalizeLastTool();
    this.clearStatus();
    this.appendToolCycleEnd();
    this.curLine = null;
    this.thinkingLine = null;
    this.hadToolCall = false;
    this.toolFailed = false;
  }
}

const L1 = new ThoughtStream("si-l1", "cool", {
  thinkingLabel: "正在思考中",
  thinkingDoneLabel: "思考完成",
  toolDetailLength: 140,
});
const L2 = new ThoughtStream("si-l2", "warm", {
  thinkingLabel: "思考中",
  thinkingDoneLabel: "思考完成",
  toolDetailLength: 220,
});

// L1 = 用户消息触发的处理流；L2 = TICK 触发的处理流。
// 后端 emit 的 stream_*/tool_call 事件不带路径标记，
// 通过最近一次 message_received / tick 事件来决定路由到哪块面板。
let currentPath = "l2";
function currentStream() { return currentPath === "l1" ? L1 : L2; }

function isBusyErrorMessage(message = "") {
  return /(429|rate limit|too many requests|busy|overload|temporarily unavailable|server busy|resource exhausted)/i.test(String(message || ""));
}

function formatRetryDelay(ms) {
  if (!ms || ms < 1000) return `${ms || 0}ms`;
  return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`;
}

let tokenAccum = 0;
let tokenWindow = Date.now();
const tokRateEl = document.getElementById("tok-rate");

function bumpTokens(text) {
  tokenAccum += (text || "").length / 3.4;
  const now = Date.now();
  if (now - tokenWindow > 700) {
    const rate = tokenAccum / ((now - tokenWindow) / 1000);
    tokRateEl.textContent = rate.toFixed(1);
    tokenAccum = 0;
    tokenWindow = now;
    setTimeout(() => { if (tokRateEl.textContent !== "—" && tokenAccum === 0) tokRateEl.textContent = "—"; }, 4000);
  }
}

function connectSSE() {
  setConnectionState("connecting", true);
  const es = new EventSource(`${API}/events`);

  es.onopen = () => setConnectionState("已连接", true);

  es.onmessage = event => {
    try { handle(JSON.parse(event.data)); } catch (_) {}
  };

  es.onerror = () => {
    setConnectionState("reconnect", false);
    es.close();
    setTimeout(connectSSE, 3000);
  };
}

function extractNids(memList) {
  return (memList || [])
    .map(m => m.mem_id || (m.id != null ? String(m.id) : null))
    .filter(Boolean);
}

function handle({ type, data = {} }) {
  switch (type) {
    case "message_received": {
      currentPath = "l1";
      const parsed = parseUserMessageInput(data.input);
      L1.newLine("收到用户消息", {
        content: parsed.content,
        time: parsed.time || undefined,
      });
      break;
    }
    case "tick":
      currentPath = "l2";
      L2.newLine("心跳 tick");
      break;
    case "stream_start":
      currentStream().startThinkingSession();
      break;
    case "stream_chunk":
      // 不再显示具体思考内容，仅用于驱动 token 速率指示
      currentStream().clearStatus();
      bumpTokens(data.text);
      break;
    case "stream_end":
      currentStream().stopThinking();
      break;
    case "tool_call":
      currentStream().tool(data.name, data.args, data.result);
      break;
    case "response":
      // 一轮完成：停所有动画
      currentStream().end();
      break;
    case "llm_retry": {
      currentStream().startThinkingSession();
      const nextAttempt = Number(data.nextAttempt || 2);
      const delayText = formatRetryDelay(Number(data.delayMs || 0));
      currentStream().setStatus("LLM busy, retry " + nextAttempt + " in " + delayText, "busy");
      break;
    }
    case "message_requeued": {
      currentStream().startThinkingSession();
      const retryCount = Number(data.retryCount || 1);
      currentStream().setStatus("LLM busy, queued retry " + retryCount + "/3", "busy");
      break;
    }
    case "message_dropped":
      currentStream().startThinkingSession();
      currentStream().setStatus("LLM busy, retry limit reached", "failed");
      break;
    case "error":
      if (isBusyErrorMessage(data.error)) {
        currentStream().startThinkingSession();
        currentStream().setStatus("LLM busy, please retry shortly", "busy");
      }
      break;
    case "injector_result": {
      const nids = [...extractNids(data.matchedMemories), ...extractNids(data.recallMemories)];
      if (nids.length) highlightNodes(nids, 10000);
      break;
    }
    case "memories_written":
      if (Array.isArray(data.memories) && data.memories.length) {
        addNewNodes(data.memories);
      }
      break;
    case "message":
      if (data.from === "consciousness") {
        addMsg("jarvis", data.content);
        openChat(true);
      }
      break;
    case "message_in":
      if (data.from_id && data.from_id !== "ID:000001") {
        addMsg("external", data.content, { label: data.from_id, alert: false });
        openChat(true);
      }
      break;
    case "agent_name_updated":
      setAgentName(data.name);
      break;
    default:
      break;
  }
}

const chatHistory = document.getElementById("chat-history");
const chatMessages = document.getElementById("chat-messages");
const msgInput = document.getElementById("msg-input");
const chatArea = document.getElementById("chat-area");
const sendBtn = document.getElementById("send-btn");

let closeTimer = null;
let hasPendingJarvisMessage = false;
let pendingMessageDismissed = false;
let audioCtx = null;

function isHoveringChat() {
  return chatArea.matches(":hover") || chatHistory.matches(":hover") || chatMessages.matches(":hover");
}

function ensureAudioContext() {
  if (!audioCtx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    audioCtx = new AudioCtx();
  }
  return audioCtx;
}

async function playJarvisAlert() {
  const ctx = ensureAudioContext();
  if (!ctx) return;
  try { if (ctx.state === "suspended") await ctx.resume(); } catch { return; }
  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, now);
  master.gain.exponentialRampToValueAtTime(0.055, now + 0.02);
  master.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
  master.connect(ctx.destination);

  const oscA = ctx.createOscillator();
  oscA.type = "sine";
  oscA.frequency.setValueAtTime(740, now);
  oscA.frequency.exponentialRampToValueAtTime(880, now + 0.18);
  oscA.connect(master);

  const oscB = ctx.createOscillator();
  oscB.type = "triangle";
  oscB.frequency.setValueAtTime(1110, now + 0.12);
  oscB.frequency.exponentialRampToValueAtTime(1320, now + 0.34);
  oscB.connect(master);

  oscA.start(now); oscA.stop(now + 0.22);
  oscB.start(now + 0.12); oscB.stop(now + 0.36);

  oscA.addEventListener("ended", () => oscA.disconnect(), { once: true });
  oscB.addEventListener("ended", () => oscB.disconnect(), { once: true });
  setTimeout(() => master.disconnect(), 500);
}

function isTyping() {
  return document.activeElement === msgInput || msgInput.value.trim().length > 0;
}

async function fetchChatHistory() {
  try {
    const res = await fetch(`${API}/conversations?limit=${MAX_CHAT_HISTORY}`);
    if (!res.ok) return [];
    const rows = await res.json();
    if (!Array.isArray(rows)) return [];
    return rows
      .filter(r => r && (r.role === "user" || r.role === "jarvis") && typeof r.content === "string")
      .map(r => {
        if (r.role === "user" && r.from_id && r.from_id !== "ID:000001") {
          return { role: "external", text: r.content, label: r.from_id };
        }
        return { role: r.role, text: r.content };
      });
  } catch { return []; }
}

function openChat(autoClose = false) {
  chatHistory.classList.add("open");
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  if (autoClose && (!hasPendingJarvisMessage || pendingMessageDismissed) && !isTyping()) scheduleClose(4500);
}

function closeChat() {
  if ((hasPendingJarvisMessage && !pendingMessageDismissed) || isTyping() || isHoveringChat()) return;
  chatHistory.classList.remove("open");
}

function scheduleClose(ms = 100) {
  if ((hasPendingJarvisMessage && !pendingMessageDismissed) || isTyping() || isHoveringChat()) return;
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = setTimeout(closeChat, ms);
}

chatArea.addEventListener("mouseenter", () => {
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  openChat();
});
chatArea.addEventListener("mouseleave", () => scheduleClose());
msgInput.addEventListener("focus", () => openChat());
msgInput.addEventListener("blur", () => { if (!isTyping()) scheduleClose(); });
msgInput.addEventListener("input", () => {
  if (isTyping()) openChat();
  else if (!hasPendingJarvisMessage || pendingMessageDismissed) scheduleClose();
});

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(text) {
  return escapeHtml(text).replace(/`/g, "&#96;");
}

function safeHref(rawUrl) {
  const url = String(rawUrl ?? "").trim();
  if (!url) return "";
  if (/^(https?:|mailto:)/i.test(url)) return url;
  if (url.startsWith("/") || url.startsWith("#")) return url;
  return "";
}

function renderInlineMarkdown(text) {
  const codeTokens = [];
  let html = String(text ?? "").replace(/`([^`]+)`/g, (_, code) => {
    const token = `@@CODE_${codeTokens.length}@@`;
    codeTokens.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });

  html = escapeHtml(html);
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, href) => {
    const safeUrl = safeHref(href);
    if (!safeUrl) return label;
    return `<a href="${escapeAttr(safeUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  html = html.replace(/(\*\*|__)(.+?)\1/g, "<strong>$2</strong>");
  html = html.replace(/(\*|_)(.+?)\1/g, "<em>$2</em>");

  codeTokens.forEach((token, index) => {
    html = html.replace(`@@CODE_${index}@@`, token);
  });

  return html;
}

function renderMarkdown(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const parts = [];
  let paragraph = [];
  let listType = null;
  let listItems = [];
  let quoteLines = [];
  let codeFence = null;
  let codeLines = [];

  function flushParagraph() {
    if (!paragraph.length) return;
    parts.push(`<p>${paragraph.map(renderInlineMarkdown).join("<br>")}</p>`);
    paragraph = [];
  }

  function flushList() {
    if (!listType || !listItems.length) return;
    const tag = listType === "ol" ? "ol" : "ul";
    parts.push(`<${tag}>${listItems.map(item => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</${tag}>`);
    listType = null;
    listItems = [];
  }

  function flushQuote() {
    if (!quoteLines.length) return;
    parts.push(`<blockquote>${quoteLines.map(line => renderInlineMarkdown(line)).join("<br>")}</blockquote>`);
    quoteLines = [];
  }

  function flushCode() {
    if (codeFence === null) return;
    const langClass = codeFence ? ` class="language-${escapeAttr(codeFence)}"` : "";
    parts.push(`<pre><code${langClass}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
    codeFence = null;
    codeLines = [];
  }

  for (const line of lines) {
    const fenceMatch = line.match(/^```([\w-]+)?\s*$/);
    if (fenceMatch) {
      flushParagraph();
      flushList();
      flushQuote();
      if (codeFence !== null) flushCode();
      else codeFence = fenceMatch[1] || "";
      continue;
    }

    if (codeFence !== null) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      flushQuote();
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      flushQuote();
      const level = headingMatch[1].length;
      parts.push(`<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
      continue;
    }

    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quoteLines.push(quoteMatch[1]);
      continue;
    }
    flushQuote();

    const ulMatch = line.match(/^[-*+]\s+(.+)$/);
    if (ulMatch) {
      flushParagraph();
      if (listType && listType !== "ul") flushList();
      listType = "ul";
      listItems.push(ulMatch[1]);
      continue;
    }

    const olMatch = line.match(/^\d+\.\s+(.+)$/);
    if (olMatch) {
      flushParagraph();
      if (listType && listType !== "ol") flushList();
      listType = "ol";
      listItems.push(olMatch[1]);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  flushQuote();
  flushCode();

  return parts.join("");
}

function createMarkdownBody(text) {
  const body = document.createElement("div");
  body.className = "msg-body";
  body.innerHTML = renderMarkdown(text);
  return body;
}

function addMsg(role, text, options = {}) {
  const { alert = role === "jarvis", pending = true, label } = options;
  const defaultLabel = role === "user" ? "You" : role === "jarvis" ? agentName : "Peer";
  const labelText = label || defaultLabel;
  const div = document.createElement("div");
  div.className = `msg msg-${role}`;
  const labelSpan = document.createElement("span");
  labelSpan.className = "msg-label";
  labelSpan.textContent = labelText;
  div.appendChild(labelSpan);
  div.appendChild(createMarkdownBody(text));
  chatMessages.appendChild(div);

  while (chatMessages.children.length > MAX_CHAT_HISTORY) {
    chatMessages.removeChild(chatMessages.firstChild);
  }

  if (role === "jarvis") {
    hasPendingJarvisMessage = pending;
    pendingMessageDismissed = !pending;
    if (alert) playJarvisAlert();
    if (pending) openChat();
  } else if (role === "user") {
    hasPendingJarvisMessage = false;
    pendingMessageDismissed = false;
  }

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function restoreChatHistory() {
  const history = await fetchChatHistory();
  history.forEach(i => addMsg(i.role, i.text, { persist: false, alert: false, pending: false, label: i.label }));
  if (history.length) {
    pendingMessageDismissed = true;
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}

async function send() {
  const text = msgInput.value.trim();
  if (!text) return;
  msgInput.value = "";
  addMsg("user", text);
  openChat();
  scheduleClose(1000);

  try {
    await fetch(`${API}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text, from_id: "ID:000001" }),
    });
  } catch (error) {
    console.warn("[send]", error.message);
    addMsg("jarvis", "消息发送失败，请检查本地服务是否启动。");
    openChat(true);
  }
}

sendBtn.addEventListener("click", send);
resetViewBtn.addEventListener("click", resetZoom);
msgInput.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    send();
  }
});

document.querySelectorAll(".panel, .console, .theme-switcher, .reset-view").forEach(el => {
  el.addEventListener("wheel", event => event.stopPropagation(), { passive: true });
});

physicsControl.addEventListener("wheel", event => event.stopPropagation(), { passive: true });

document.addEventListener("pointerdown", event => {
  if (chatArea.contains(event.target)) return;
  if (hasPendingJarvisMessage && !isTyping()) {
    pendingMessageDismissed = true;
    closeChat();
    return;
  }
  if (!isTyping()) {
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    chatHistory.classList.remove("open");
  }
});

window.addEventListener("resize", () => {
  W = window.innerWidth;
  H = window.innerHeight;
  svg.attr("width", W).attr("height", H);
  sim.force("center", d3.forceCenter(W / 2, H / 2 - 10))
     .force("x", d3.forceX(W / 2))
     .force("y", d3.forceY(H / 2 - 10))
     .force("radial", d3.forceRadial(180, W / 2, H / 2 - 10));
  updateSimulationForces();
  sim.alpha(5).restart();
});

d3.timer(() => {
  if (glowSet.size === 0 && usePulseSet.size === 0) return;
  refreshNodeVisuals();
});

setAgentName(DEFAULT_AGENT_NAME);
readPhysicsSettings();
updatePhysicsReadout();
refreshThemeColors();
loadMemories();
setInterval(() => {
  loadMemories();
}, 5 * 60 * 1000);
connectSSE();
loadAgentProfile();
restoreChatHistory();
