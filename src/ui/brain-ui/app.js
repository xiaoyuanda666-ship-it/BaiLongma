import { renderBrainUiApp } from "./app-shell.js";
import { API } from "./api-client.js";
import { bootstrapACUI } from "./acui/bootstrap.js";
import { initChat, friendlyChannelLabel } from "./chat.js";
import { initPanelCollapse } from "./panel-collapse.js";
import { ThoughtStream } from "./thought-stream.js";
import { initVoicePanel } from "./voice-panel.js";
import { initHotspot, toggleHotspot, setHotspotMode, moveVoicePanelToBody, restoreVoicePanel } from "./hotspot.js";
import { enrichVisiblePersonCardFromText, initPersonCard, setPersonCardMode, showPersonCardByName } from "./person-card.js";
import { initDocPanel, setDocPanelMode } from "./doc.js";
import { initWechatPopup, showWechatPopup } from "./wechat-popup.js";
renderBrainUiApp(document.body);
const THEME_KEY = "jarvis-brain-ui-theme";
const PHYSICS_STORAGE_KEY = "jarvis-brain-ui-physics";
const ACTIVATION_WARMUP_KEY = "bailongma_activation_warmup_until";
const UI_ZOOM_STORAGE_KEY = "bailongma_ui_zoom_factor";
const MAX_CHAT_HISTORY = 60;
const DEFAULT_AGENT_NAME = "小白龙";
const DEFAULT_UI_ZOOM = 1.1;
const MIN_UI_ZOOM = 0.8;
const MAX_UI_ZOOM = 1.8;
const UI_ZOOM_STEP = 0.1;
const UI_ZOOM_WHEEL_STEP = 0.05;
const MEMORY_GRAPH_STORAGE_KEY = "bailongma-memory-graph-enabled";
const MEMORY_GRAPH_ENABLED = localStorage.getItem(MEMORY_GRAPH_STORAGE_KEY) !== "false";

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
const focusBlockEl = document.getElementById("focus-block");
const focusStackEl = document.getElementById("focus-stack");
const focusDepthEl = document.getElementById("focus-depth");

const IGNORED_VERSION_KEY = "bailongma_ignored_update_version";
const SUPPRESS_UPDATES_KEY = "bailongma_suppress_update_notifications";

let agentName = DEFAULT_AGENT_NAME;
let currentUiZoom = DEFAULT_UI_ZOOM;
let chat = null;

function addMsg(...args) { return chat?.addMsg(...args); }
function openChat(...args) { return chat?.openChat(...args); }
function updateLastJarvisMsg(...args) { return chat?.updateLastJarvisMsg(...args); }
function isTyping() { return chat?.isTyping() || false; }

function defaultInputPlaceholder() {
  return `向 ${agentName} 发消息…`;
}

function clampZoomFactor(factor) {
  return Math.min(MAX_UI_ZOOM, Math.max(MIN_UI_ZOOM, Number(factor) || DEFAULT_UI_ZOOM));
}

function saveUiZoom(factor) {
  try {
    localStorage.setItem(UI_ZOOM_STORAGE_KEY, String(factor));
  } catch {}
}

function loadSavedUiZoom() {
  try {
    const raw = Number(localStorage.getItem(UI_ZOOM_STORAGE_KEY));
    if (Number.isFinite(raw)) return clampZoomFactor(raw);
  } catch {}
  return DEFAULT_UI_ZOOM;
}

function applyUiZoom(factor, { persist = true } = {}) {
  const nextZoom = clampZoomFactor(factor);
  currentUiZoom = nextZoom;

  const bridge = window.bailongma;
  if (bridge?.isElectron && typeof bridge.setZoomFactor === "function") {
    bridge.setZoomFactor(nextZoom);
  } else {
    document.documentElement.style.zoom = String(nextZoom);
  }

  if (persist) saveUiZoom(nextZoom);
}

function stepUiZoom(delta) {
  const nextZoom = Math.round((currentUiZoom + delta) * 100) / 100;
  applyUiZoom(nextZoom);
}

function initUiZoom() {
  const bridge = window.bailongma;
  const initialZoom = loadSavedUiZoom();

  if (!bridge?.isElectron) {
    applyUiZoom(initialZoom, { persist: false });
  } else {
    try {
      const bridgeZoom = bridge.getZoomFactor?.();
      if (typeof bridgeZoom === "number" && Number.isFinite(bridgeZoom)) {
        currentUiZoom = clampZoomFactor(bridgeZoom);
      }
    } catch {}
    applyUiZoom(initialZoom, { persist: false });
  }

  window.addEventListener("wheel", (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    stepUiZoom(event.deltaY < 0 ? UI_ZOOM_WHEEL_STEP : -UI_ZOOM_WHEEL_STEP);
  }, { passive: false, capture: true });

  window.addEventListener("keydown", (event) => {
    if (!event.ctrlKey && !event.metaKey) return;

    const key = event.key;
    if (key === "+" || key === "=" || key === "Add") {
      event.preventDefault();
      stepUiZoom(UI_ZOOM_STEP);
      return;
    }

    if (key === "-" || key === "_" || key === "Subtract") {
      event.preventDefault();
      stepUiZoom(-UI_ZOOM_STEP);
      return;
    }

    if (key === "0") {
      event.preventDefault();
      applyUiZoom(DEFAULT_UI_ZOOM);
    }
  });
}

function setAgentName(nextName) {
  const normalized = String(nextName || "").trim() || DEFAULT_AGENT_NAME;
  agentName = normalized;
  document.title = `${normalized} · Cognitive Surface`;
  if (brandNameEl) brandNameEl.textContent = `${normalized} AI Agent`;
  if (graphEl) graphEl.setAttribute("aria-label", `${normalized} memory graph`);
  const input = document.getElementById("msg-input");
  if (input && !chat?.isComposerLocked?.()) input.placeholder = defaultInputPlaceholder();
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
    if (MEMORY_GRAPH_ENABLED && nodeSel && !nodeSel.empty()) {
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
  if (!MEMORY_GRAPH_ENABLED || !sim) return;
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

const sim = MEMORY_GRAPH_ENABLED
  ? d3.forceSimulation()
    .force("link", d3.forceLink().id(d => d._nid))
    .force("charge", d3.forceManyBody())
    .force("center", d3.forceCenter(W / 2, H / 2 - 10))
    .force("x", d3.forceX(W / 2))
    .force("y", d3.forceY(H / 2 - 10))
    .force("radial", d3.forceRadial(180, W / 2, H / 2 - 10))
    .force("collision", d3.forceCollide())
    .alphaDecay(0.028)
    .velocityDecay(0.3)
    .on("tick", tick)
  : null;

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
  if (!MEMORY_GRAPH_ENABLED || !sim) return;
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
  if (!MEMORY_GRAPH_ENABLED || !sim) {
    savePhysicsSettings();
    return;
  }
  updateSimulationForces();
  refreshNodeVisuals();
  sim.alpha(Math.max(sim.alpha(), restartAlpha)).restart();
  savePhysicsSettings();
}

function refreshNodeVisuals() {
  if (!MEMORY_GRAPH_ENABLED) return;
  if (!nodeSel || nodeSel.empty()) return;
  nodeSel
    .attr("r", nodeRadius)
    .attr("fill", nodeColor)
    .attr("filter", d => (d._core || isGlowing(d._nid) || nodeUseProgress(d._nid) > 0) ? "url(#neb-glow)" : null)
    .style("animation", d => nodeUseProgress(d._nid) > 0 ? "neb-node-use 10s ease-out" : null);
}

function dampTangentialMotion() {
  if (!MEMORY_GRAPH_ENABLED || !sim) return;
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
  if (!MEMORY_GRAPH_ENABLED || !sim) return;
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
  if (!MEMORY_GRAPH_ENABLED) return;
  dampTangentialMotion();

  linkSel
    .attr("x1", d => d.source.x)
    .attr("y1", d => d.source.y)
    .attr("x2", d => d.target.x)
    .attr("y2", d => d.target.y);

  nodeSel
    .attr("cx", d => d.x)
    .attr("cy", d => d.y);
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
    { name: "Constraint", count: 1, color: themeColors.warm },
    { name: "Memory", count: total, color: themeColors.nodeHigh },
    { name: "Knowledge", count: known, color: themeColors.cool },
    { name: "Decayed", count: decayed, color: themeColors.dim },
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
  if (!MEMORY_GRAPH_ENABLED || !sim) {
    updateStats();
    renderLegend();
    return;
  }
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
  if (!MEMORY_GRAPH_ENABLED) return;
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
    setConnectionState("未连接", false);
  }
}

function addNewNodes(memories) {
  if (!MEMORY_GRAPH_ENABLED) return;
  const nodeMap = new Map(nodeData.map(n => [n._nid, n]));
  const newNids = [];
  memories.forEach(memory => {
    const nid = memory.mem_id || memory.id;
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

if (MEMORY_GRAPH_ENABLED) {
  setInterval(() => naturalTwitch(), 6000);
  setInterval(() => { nodeData.forEach(n => { if (n._strength) n._strength *= 0.97; }); }, 2500);
}

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

const L1 = new ThoughtStream("si-l1", "cool", {
  readCSSVar,
  thinkingLabel: "思考中…",
  thinkingDoneLabel: "思考完成",
  toolDetailLength: 140,
});
const L2 = new ThoughtStream("si-l2", "warm", {
  readCSSVar,
  thinkingLabel: "思考中",
  thinkingDoneLabel: "思考完成",
  toolDetailLength: 220,
});

// L1 = processing flow triggered by user messages; L2 = processing flow triggered by TICK.
// stream_*/tool_call events emitted by the backend carry no path tag;
// routing to the correct panel is determined by the most recent message_received / tick event.
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

// ── 专注帧观察面板 (focus stack) ────────────────────────────────
// 设计文档 7.5：用户必须看得见 Agent 此刻在专注什么。
// 纯事件驱动：focus_frame → 全量重渲染；focus_compressed → 在栈顶尾部追加 conclusion 并淡入。

function escapeFocusText(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncateConclusion(text, max = 60) {
  const s = String(text || "").trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trim() + "…";
}

function renderFocusFrame(frame, { isTop }) {
  const conclusions = Array.isArray(frame?.conclusions) ? frame.conclusions : [];

  // 主行显示策略（progressive disclosure）：
  //   1. 有 conclusion → 显示最新一条（这是子帧 pop 时压缩出的 1-2 句话结论）
  //   2. 无 conclusion 但有 topic → 显示 topic（v0 是 ngram，几百 ms 后被 LLM refine 成人类可读短语）
  //   3. 都没 → 返回空主行（上层 renderFocusStack 会进一步过滤）
  // 早期 conclusion 作为弱化辅助行（栈顶帧才显示，避免视觉过载）
  const latest = conclusions.length > 0 ? conclusions[conclusions.length - 1] : "";
  const earlier = conclusions.length > 1 ? conclusions.slice(0, -1) : [];
  const topicSummary = Array.isArray(frame?.topic) && frame.topic.length > 0
    ? frame.topic.slice(0, 3).join(" · ")
    : "";

  let mainHTML = "";
  if (latest) {
    mainHTML = `<div class="focus-frame-main">${escapeFocusText(truncateConclusion(latest, isTop ? 120 : 80))}</div>`;
  } else if (topicSummary) {
    mainHTML = `<div class="focus-frame-main focus-frame-main-fallback">${escapeFocusText(truncateConclusion(topicSummary, isTop ? 60 : 40))}</div>`;
  }

  const earlierHTML = earlier.map((c) =>
    `<div class="focus-frame-conclusion focus-frame-conclusion-earlier">${escapeFocusText(truncateConclusion(c, isTop ? 100 : 60))}</div>`
  ).join("");

  // 该帧既无 conclusion 也无 topic（极短暂的"刚 push 还没赋 topic"状态），不渲染外层壳
  if (!mainHTML && !earlierHTML) return "";

  return (
    `<div class="focus-frame${isTop ? " top" : ""}">` +
      mainHTML +
      earlierHTML +
    `</div>`
  );
}

function renderFocusStack(stack) {
  if (!focusStackEl || !focusBlockEl) return;
  const list = Array.isArray(stack) ? stack : [];
  if (focusDepthEl) focusDepthEl.textContent = String(list.length);

  if (list.length === 0) {
    focusBlockEl.dataset.state = "empty";
    focusStackEl.innerHTML = `<div class="focus-empty">无专注</div>`;
    return;
  }

  focusBlockEl.dataset.state = "active";
  // 渲染策略：只渲染"有 conclusion 的帧 + 栈顶帧"。
  // 非栈顶 + 无 conclusion 的帧静默隐藏——这种帧是"已 push 但还没 pop"的活帧，
  // conclusion 永远空着，渲染出来只是占位文字（"…"），堆叠多了视觉很噪。
  // depth 数字仍然显示真实栈深度，让用户知道还有未压缩的帧挂着。
  // 栈底 → 栈顶；视觉上栈顶在最下（最近一次最强），跟终端 / 思考流方向一致。
  const html = list.map((frame, i) => {
    const isTop = i === list.length - 1;
    const hasConclusion = Array.isArray(frame?.conclusions) && frame.conclusions.length > 0;
    if (!isTop && !hasConclusion) return "";
    return renderFocusFrame(frame, { isTop });
  }).filter(Boolean).join("");
  focusStackEl.innerHTML = html;
}

function flashFocusCompressed() {
  if (!focusBlockEl) return;
  // 让栈顶帧的主行（最新 conclusion）走淡入动画；同时整块做一次柔和高光。
  focusBlockEl.classList.remove("focus-compress-pulse");
  // 强制 reflow 让动画重启
  void focusBlockEl.offsetWidth;
  focusBlockEl.classList.add("focus-compress-pulse");

  const topFrame = focusStackEl?.querySelector(".focus-frame.top");
  const mainEl = topFrame?.querySelector(".focus-frame-main");
  if (mainEl) {
    mainEl.classList.remove("just-added");
    void mainEl.offsetWidth;
    mainEl.classList.add("just-added");
  }
}

function connectSSE() {
  setConnectionState("连接中", true);
  const es = new EventSource(`${API}/events`);

  es.onopen = () => setConnectionState("已连接", true);

  es.onmessage = event => {
    try { handle(JSON.parse(event.data)); } catch (_) {}
  };

  es.onerror = () => {
    setConnectionState("重连中", false);
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
      L1.beginRound();
      const parsed = parseUserMessageInput(data.input);
      L1.newLine("user message received", {
        content: parsed.content,
        time: parsed.time || undefined,
      });
      // Immediately show a "thinking" indicator so the gap between message_received
      // and the first stream_start (injector + LLM TTFT, often 3–30s) doesn't look frozen.
      L1.startThinkingSession();
      break;
    }
    case "tick":
      currentPath = "l2";
      L2.beginRound();
      L2.newLine("heartbeat tick");
      L2.startThinkingSession();
      break;
    case "stream_start":
      currentStream().startThinkingSession();
      break;
    case "stream_chunk":
      // No longer rendering thought content — only drives the token-rate indicator
      currentStream().clearStatus();
      bumpTokens(data.text);
      break;
    case "stream_end":
      currentStream().stopThinking();
      break;
    case "tool_preparing": {
      // 思考动画已停，但工具尚未真正执行 —— 给一个占位状态避免 UI 死寂
      const stream = currentStream();
      const label = data.name ? stream.toolLabel(data.name) : "";
      stream.setStatus(label ? `准备调用 ${label}…` : "准备工具调用…", "busy");
      break;
    }
    case "tool_executing": {
      const stream = currentStream();
      const label = data.name ? stream.toolLabel(data.name) : "工具";
      stream.setStatus(`正在执行 ${label}…`, "busy");
      break;
    }
    case "tool_call":
      currentStream().tool(data.name, data.args, data.result, data.ok);
      break;
    case "response":
      // Round complete — stop all animations
      currentStream().end();
      break;
    case "llm_retry": {
      currentStream().startThinkingSession();
      const nextAttempt = Number(data.nextAttempt || 2);
      const delayText = formatRetryDelay(Number(data.delayMs || 0));
      currentStream().setStatus("LLM 繁忙，第 " + nextAttempt + " 次重试将于 " + delayText + " 后开始", "busy");
      break;
    }
    case "message_requeued": {
      currentStream().startThinkingSession();
      const retryCount = Number(data.retryCount || 1);
      currentStream().setStatus("LLM 繁忙，已入队重试 " + retryCount + "/3", "busy");
      break;
    }
    case "message_dropped":
      currentStream().startThinkingSession();
      currentStream().setStatus("LLM 繁忙，重试次数已达上限", "failed");
      break;
    case "error":
      if (isBusyErrorMessage(data.error)) {
        currentStream().startThinkingSession();
        currentStream().setStatus("LLM 繁忙，请稍后重试", "busy");
      }
      break;
    case "injector_result": {
      const nids = [...extractNids(data.matchedMemories), ...extractNids(data.recallMemories)];
      if (nids.length) highlightNodes(nids, 10000);
      break;
    }
    case "focus_frame": {
      renderFocusStack(data.focusStack);
      break;
    }
    case "focus_compressed": {
      // 后端 emit 顺序：先 focus_frame（栈已 pop 完）→ 异步压缩完再 focus_compressed。
      // 触发时栈顶帧的 conclusions 数组在后端已被追加，但前端 DOM 里还是旧的。
      // 新布局：把新 conclusion 写入「主行」(.focus-frame-main)；
      // 若主行原本是 fallback（暂无沉淀结论），就把它升级为正常主行。
      // 若主行已有旧 conclusion，把旧值降级追加到「早期 conclusion」列表里，再覆盖主行。
      // 下一次 focus_frame 事件会带最新 conclusions 全量覆盖，所以即使错位也很快收敛。
      const topFrame = focusStackEl?.querySelector(".focus-frame.top");
      if (topFrame && data.conclusion) {
        const mainEl = topFrame.querySelector(".focus-frame-main");
        const newText = truncateConclusion(data.conclusion, 120);
        if (mainEl) {
          const wasFallback = mainEl.classList.contains("focus-frame-main-fallback");
          if (!wasFallback && mainEl.textContent) {
            const earlier = document.createElement("div");
            earlier.className = "focus-frame-conclusion focus-frame-conclusion-earlier";
            earlier.textContent = mainEl.textContent;
            topFrame.appendChild(earlier);
          }
          mainEl.classList.remove("focus-frame-main-fallback");
          mainEl.innerHTML = "";
          mainEl.textContent = newText;
        }
      }
      flashFocusCompressed();
      break;
    }
    case "memories_written":
      if (Array.isArray(data.memories) && data.memories.length) {
        addNewNodes(data.memories);
      }
      break;
    case "message":
      if (data.from === "consciousness") {
        lastJarvisContent = data.content;
        const viaLabel = friendlyChannelLabel(data.channel);
        const content = viaLabel ? `_→ ${viaLabel}_  \n${data.content}` : data.content;
        addMsg("jarvis", content);
        enrichVisiblePersonCardFromText(data.content, { source: 'assistant_message' });
        openChat(true);
      }
      break;
    case "message_in": {
      // 外部渠道判定：channel 非空且非本地，或 from_id 仍带外部前缀（兼容连接器直接 emit 的事件）
      const ch = String(data.channel || "").toUpperCase();
      const isExternal =
        (ch && ch !== "TUI" && ch !== "API" && ch !== "SYSTEM" && ch !== "REMINDER" && ch !== "APP_SIGNAL" && ch !== "VOICE" && ch !== "语音识别")
        || (data.from_id && /^(wechat|discord|feishu|wecom):/i.test(data.from_id));
      if (isExternal) {
        const label = friendlyChannelLabel(data.channel) || data.from_id || "External";
        addMsg("external", data.content, { label, alert: false });
        openChat(true);
      }
      break;
    }
    case "agent_name_updated":
      setAgentName(data.name);
      break;
    case "media_mode":
      window.dispatchEvent(new CustomEvent("bailongma:media", { detail: data }));
      break;
    case "hotspot_mode":
      setHotspotMode(!!data.active || data.action === "show" || data.action === "open", { source: "agent_event" });
      break;
    case "doc_panel_mode":
      setDocPanelMode(!!data.active || data.action === "open", { topicId: data.topic || null, source: "agent_event" });
      break;
    case "person_card_mode":
      setPersonCardMode(!!data.active || data.action === "show" || data.action === "open" || data.action === "update", { source: "agent_event", card: data.card || null });
      break;
    case "social_status":
      window.dispatchEvent(new CustomEvent("bailongma:social_status", { detail: data }));
      break;
    case "show_wechat_popup":
      showWechatPopup();
      break;
    case "audio_created":
      if (data.autoPlay && data.path) {
        const audioUrl = `${API}/${data.path}`;
        const audioEl = new Audio(audioUrl);
        audioEl.play().catch(() => {});
      }
      break;
    case "tts_reply":
      if (data.text) playTTSReply(data.text);
      break;
    case "key_configured":
      chat.deleteLastUserMsg();
      if (data.service === 'tts' && data.ttsText) playTTSReply(data.ttsText);
      break;
    case "startup_self_check_started":
      playJarvisStartupSound();
      setTimeout(() => playTTSReply("System starting, running self-check"), 1500);
      break;
    default:
      break;
  }
}

// ── Jarvis-style startup self-check sound ────────────────────────────────────
function playJarvisStartupSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    const t = ctx.currentTime;

    // Layer 1: low-frequency mechanical hum (sawtooth, simulates power-on)
    const drone = ctx.createOscillator();
    const droneGain = ctx.createGain();
    const droneFilter = ctx.createBiquadFilter();
    drone.type = "sawtooth";
    drone.frequency.setValueAtTime(50, t);
    drone.frequency.linearRampToValueAtTime(90, t + 0.5);
    droneFilter.type = "lowpass";
    droneFilter.frequency.value = 350;
    droneFilter.Q.value = 3;
    droneGain.gain.setValueAtTime(0, t);
    droneGain.gain.linearRampToValueAtTime(0.09, t + 0.06);
    droneGain.gain.linearRampToValueAtTime(0.06, t + 0.4);
    droneGain.gain.linearRampToValueAtTime(0, t + 0.65);
    drone.connect(droneFilter);
    droneFilter.connect(droneGain);
    droneGain.connect(ctx.destination);
    drone.start(t);
    drone.stop(t + 0.7);

    // Layer 2: system-online frequency sweep (sine, low to high)
    const sweep = ctx.createOscillator();
    const sweepGain = ctx.createGain();
    sweep.type = "sine";
    sweep.frequency.setValueAtTime(280, t + 0.12);
    sweep.frequency.exponentialRampToValueAtTime(2800, t + 1.0);
    sweepGain.gain.setValueAtTime(0, t + 0.12);
    sweepGain.gain.linearRampToValueAtTime(0.13, t + 0.22);
    sweepGain.gain.exponentialRampToValueAtTime(0.001, t + 1.05);
    sweep.connect(sweepGain);
    sweepGain.connect(ctx.destination);
    sweep.start(t + 0.12);
    sweep.stop(t + 1.1);

    // Layer 3: three confirmation beeps (square wave, self-check passed)
    [[880, 1.15], [1100, 1.28], [1320, 1.41]].forEach(([freq, bt]) => {
      const beep = ctx.createOscillator();
      const beepGain = ctx.createGain();
      const beepFilter = ctx.createBiquadFilter();
      beep.type = "square";
      beep.frequency.value = freq;
      beepFilter.type = "bandpass";
      beepFilter.frequency.value = freq;
      beepFilter.Q.value = 8;
      beepGain.gain.setValueAtTime(0.14, t + bt);
      beepGain.gain.exponentialRampToValueAtTime(0.001, t + bt + 0.075);
      beep.connect(beepFilter);
      beepFilter.connect(beepGain);
      beepGain.connect(ctx.destination);
      beep.start(t + bt);
      beep.stop(t + bt + 0.09);
    });

    setTimeout(() => ctx.close().catch(() => {}), 2500);
  } catch (_) {
    // silently ignore if browser does not support AudioContext
  }
}

// ── TTS reply playback ────────────────────────────────────────────────────────
let ttsAudioEl = null;
let ttsCurrentText = '';
let ttsInterruptedRemaining = '';
let lastJarvisContent = '';
let ttsInterruptedOriginalContent = '';
let ttsInterruptionApplied = false;
let ttsInterruptionDbTimer = null;

// Estimate spoken char count from audio progress, snapping to a sentence boundary
function calcRemainingText(text, currentTime, duration) {
  if (!text || !duration || duration <= 0) return { remaining: '', spokenUpTo: 0 };
  const progress = Math.min(1, currentTime / duration);
  const spokenChars = Math.floor(text.length * progress);
  const BOUNDARIES = /[。！？，.!?,\n]/g;
  let bestPos = spokenChars;
  let match;
  BOUNDARIES.lastIndex = Math.max(0, spokenChars - 10);
  while ((match = BOUNDARIES.exec(text)) !== null) {
    if (match.index >= spokenChars) {
      bestPos = match.index + 1;
      break;
    }
  }
  return { remaining: text.slice(bestPos).trim(), spokenUpTo: bestPos };
}

// Estimate cut position in original markdown based on spoken ratio in TTS plain text
function findMarkdownCutPos(markdown, ttsFullLen, ttsSpokenUpTo) {
  if (!markdown || ttsFullLen <= 0) return 0;
  const ratio = ttsSpokenUpTo / ttsFullLen;
  const approxPos = Math.floor(markdown.length * ratio);
  const BOUNDARIES = /[。！？\n.!?]/g;
  let bestPos = approxPos;
  BOUNDARIES.lastIndex = Math.max(0, approxPos - 15);
  let match;
  while ((match = BOUNDARIES.exec(markdown)) !== null) {
    if (match.index >= approxPos) { bestPos = match.index + 1; break; }
  }
  return bestPos;
}

// Apply interruption marker to chat UI; delay DB write so false triggers can be undone
function applyTTSInterruption(spokenUpTo) {
  const originalContent = lastJarvisContent || ttsCurrentText;
  if (!originalContent) return;
  ttsInterruptedOriginalContent = originalContent;
  ttsInterruptionApplied = true;

  const cutPos = findMarkdownCutPos(originalContent, ttsCurrentText.length, spokenUpTo);
  const spokenMarkdown = originalContent.slice(0, cutPos).trimEnd();
  const displayText = spokenMarkdown ? spokenMarkdown + ' ✋' : '✋';
  const dbContent = spokenMarkdown || '✋';

  updateLastJarvisMsg(displayText);

  if (ttsInterruptionDbTimer) clearTimeout(ttsInterruptionDbTimer);
  ttsInterruptionDbTimer = setTimeout(() => {
    ttsInterruptionDbTimer = null;
    fetch(`${API}/tts/interrupted`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spokenContent: dbContent }),
    }).catch(() => {});
  }, 4000);
}

// Called by voice-panel interruption detection: stop current TTS and record cut point
window.stopTTS = () => {
  if (!ttsAudioEl) return;
  const { remaining, spokenUpTo } = calcRemainingText(
    ttsCurrentText,
    ttsAudioEl.currentTime,
    ttsAudioEl.duration,
  );
  // When duration is not yet loaded (NaN): spokenUpTo=0, remaining='', falls back to full text
  ttsInterruptedRemaining = remaining || ttsCurrentText;
  applyTTSInterruption(spokenUpTo);
  ttsAudioEl.pause();
  try { URL.revokeObjectURL(ttsAudioEl.src); } catch {}
  ttsAudioEl = null;
};

// Called by voice-panel on impact noise: duck TTS volume without stopping
window.duckTTS = () => {
  if (ttsAudioEl) ttsAudioEl.volume = 0.15;
};

// Called by voice-panel after confirming noise: restore original volume
window.unduckTTS = () => {
  if (ttsAudioEl) ttsAudioEl.volume = 1.0;
};

// Called by voice-panel on false-positive noise: resume TTS from interruption point and restore chat
window.resumeTTSIfNoSpeech = () => {
  const text = ttsInterruptedRemaining;
  ttsInterruptedRemaining = '';
  if (!text) return;
  // Cancel the pending DB write and restore chat UI
  if (ttsInterruptionDbTimer) { clearTimeout(ttsInterruptionDbTimer); ttsInterruptionDbTimer = null; }
  if (ttsInterruptionApplied && ttsInterruptedOriginalContent) {
    updateLastJarvisMsg(ttsInterruptedOriginalContent);
  }
  ttsInterruptionApplied = false;
  ttsInterruptedOriginalContent = '';
  playTTSReply(text);
};

async function playTTSReply(text) {
  ttsCurrentText = text;
  ttsInterruptedRemaining = '';
  ttsInterruptionApplied = false;
  ttsInterruptedOriginalContent = '';
  try {
    const resp = await fetch(`${API}/tts/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!resp.ok) {
      let errMsg = `HTTP ${resp.status}`;
      try { const j = await resp.json(); errMsg = j.error || errMsg; } catch {}
      throw new Error(errMsg);
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    if (ttsAudioEl) { ttsAudioEl.pause(); URL.revokeObjectURL(ttsAudioEl.src); }
    ttsAudioEl = new Audio(url);
    ttsAudioEl.volume = 1.0; // ensure full volume (avoid residual duck state from previous play)
    // Suspend cloud ASR but keep the mic hardware open for interruption detection
    window.bailongmaVoice?.suspendForTTS?.();
    ttsAudioEl.onended = () => {
      URL.revokeObjectURL(url);
      ttsAudioEl = null;
      ttsCurrentText = '';
      window.bailongmaVoice?.resumeAfterMedia();
    };
    ttsAudioEl.onerror = () => {
      ttsAudioEl = null;
      ttsCurrentText = '';
      window.bailongmaVoice?.resumeAfterMedia();
    };
    ttsAudioEl.play().catch(() => {
      window.bailongmaVoice?.resumeAfterMedia();
    });
  } catch {
    ttsCurrentText = '';
    window.bailongmaVoice?.resumeAfterMedia();
  }
}

resetViewBtn.addEventListener("click", resetZoom);

document.querySelectorAll(".panel, .console, .theme-switcher, .reset-view").forEach(el => {
  el.addEventListener("wheel", event => event.stopPropagation(), { passive: true });
});

physicsControl.addEventListener("wheel", event => event.stopPropagation(), { passive: true });

window.addEventListener("resize", () => {
  W = window.innerWidth;
  H = window.innerHeight;
  svg.attr("width", W).attr("height", H);
  if (!MEMORY_GRAPH_ENABLED || !sim) return;
  sim.force("center", d3.forceCenter(W / 2, H / 2 - 10))
     .force("x", d3.forceX(W / 2))
     .force("y", d3.forceY(H / 2 - 10))
     .force("radial", d3.forceRadial(180, W / 2, H / 2 - 10));
  updateSimulationForces();
  sim.alpha(5).restart();
});

let _lastVisualRefresh = 0;
d3.timer(() => {
  if (!MEMORY_GRAPH_ENABLED) return true;
  if (glowSet.size === 0 && usePulseSet.size === 0) return;
  const now = Date.now();
  if (now - _lastVisualRefresh < 48) return;
  _lastVisualRefresh = now;
  refreshNodeVisuals();
});

function extractPersonCardQuery(text = "") {
  const value = String(text || "").trim();
  if (!value || /热点|热搜/.test(value)) return "";

  const patterns = [
    /^谁是\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9·.\-\s]{1,40})[？?]?$/,
    /^([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9·.\-\s]{1,40})\s*(?:是谁|是誰|是什么人|是什麼人|是干嘛的|简介|介绍|资料|履历)[？?]?$/,
    /^(?:介绍一下|介绍下|查一下|了解一下|认识一下)\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9·.\-\s]{1,40})[？?]?$/,
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    const name = match?.[1]?.trim();
    if (name) return name.replace(/[，,。.!！：:；;]+$/g, "").trim();
  }
  return "";
}

setAgentName(DEFAULT_AGENT_NAME);
initUiZoom();
readPhysicsSettings();
updatePhysicsReadout();
refreshThemeColors();
chat = initChat({
  apiBase: API,
  maxHistory: MAX_CHAT_HISTORY,
  activationWarmupKey: ACTIVATION_WARMUP_KEY,
  getAgentName: () => agentName,
  defaultInputPlaceholder,
  onUserMessage: (text) => {
    if (document.body.classList.contains('hotspot-mode') && /关闭|退出|关掉|隐藏/.test(text)) {
      toggleHotspot();
      return;
    }
    if (document.body.classList.contains('person-card-mode') && /关闭|退出|关掉|隐藏/.test(text)) {
      setPersonCardMode(false, { source: 'chat_input' });
      return;
    }
    if (/热点|热搜/.test(text) && !document.body.classList.contains('hotspot-mode')) {
      toggleHotspot();
    }
    const personQuery = extractPersonCardQuery(text);
    if (personQuery) {
      showPersonCardByName(personQuery, { source: 'chat_input' });
    }
  },
});
chat.applyActivationWarmupLock();
if (MEMORY_GRAPH_ENABLED) {
  if (graphEl) graphEl.style.display = "block";
  loadMemories();
  setInterval(() => {
    loadMemories();
  }, 5 * 60 * 1000);
}
connectSSE();
loadAgentProfile();
initPersonCard();
initDocPanel().catch((err) => console.warn('[DocPanel] init failed:', err));
chat.restoreChatHistory();
chat.unlockAudioOnFirstGesture();

bootstrapACUI();
initPanelCollapse();
initWechatPopup();

// ── TTS settings panel init ───────────────────────────────────────────────────
function initTTSSettings() {
  const providerSel = document.getElementById("tts-provider-select");
  const voiceSel    = document.getElementById("tts-voice-select");
  const testBtn     = document.getElementById("tts-test-btn");
  const testStatus  = document.getElementById("tts-test-status");
  if (!providerSel) return;

  let allVoices = {};

  const credSections = {
    doubao:     document.getElementById("tts-creds-doubao"),
    minimax:    document.getElementById("tts-creds-minimax"),
    openai:     document.getElementById("tts-creds-openai"),
    elevenlabs: document.getElementById("tts-creds-elevenlabs"),
    volcano:    document.getElementById("tts-creds-volcano"),
  };

  function showCredSection(provider) {
    Object.entries(credSections).forEach(([k, el]) => {
      if (el) el.style.display = k === provider ? "" : "none";
    });
  }

  function updateVoiceOptions(provider, savedId) {
    if (!voiceSel) return;
    const voices = allVoices[provider] || [];
    voiceSel.innerHTML = voices.map(v =>
      `<option value="${v.id}">${v.label}</option>`
    ).join("");
    if (savedId && voices.some(v => v.id === savedId)) {
      voiceSel.value = savedId;
    }
  }

  providerSel.addEventListener("change", () => {
    showCredSection(providerSel.value);
    updateVoiceOptions(providerSel.value);
  });

  fetch(`${API}/settings/tts`).then(r => r.json()).then(({ tts, voices }) => {
    if (voices) allVoices = voices;
    const provider = tts?.ttsProvider || "doubao";
    if (tts?.ttsProvider) providerSel.value = tts.ttsProvider;
    else providerSel.value = "doubao";
    updateVoiceOptions(provider, tts?.ttsVoiceId);
    const appidEl = document.getElementById("tts-volcano-appid");
    if (appidEl && tts?.volcanoAppId?.value) appidEl.value = tts.volcanoAppId.value;
    const baseurlEl = document.getElementById("tts-openai-baseurl");
    if (baseurlEl && tts?.openaiTtsBaseURL) baseurlEl.value = tts.openaiTtsBaseURL;
    showCredSection(provider);
  }).catch(() => {});

  showCredSection(providerSel.value);

  const origSaveBtn = document.getElementById("settings-save-voice");
  if (origSaveBtn) {
    origSaveBtn.addEventListener("click", () => {
      const ttsBody = { ttsProvider: providerSel.value };
      const voiceId  = voiceSel?.value?.trim();
      if (voiceId) ttsBody.ttsVoiceId = voiceId;
      const minimaxKey = document.getElementById("tts-minimax-key")?.value?.trim();
      if (minimaxKey) ttsBody.minimaxKey = minimaxKey;
      const doubaoKey = document.getElementById("tts-doubao-key")?.value?.trim();
      if (doubaoKey) ttsBody.doubaoKey = doubaoKey;
      const openaiKey = document.getElementById("tts-openai-key")?.value?.trim();
      if (openaiKey) ttsBody.openaiTtsKey = openaiKey;
      const baseURL = document.getElementById("tts-openai-baseurl")?.value?.trim();
      if (baseURL) ttsBody.openaiTtsBaseURL = baseURL;
      const elevenKey = document.getElementById("tts-elevenlabs-key")?.value?.trim();
      if (elevenKey) ttsBody.elevenLabsKey = elevenKey;
      const volcanoAppId = document.getElementById("tts-volcano-appid")?.value?.trim();
      if (volcanoAppId) ttsBody.volcanoAppId = volcanoAppId;
      const volcanoToken = document.getElementById("tts-volcano-token")?.value?.trim();
      if (volcanoToken) ttsBody.volcanoToken = volcanoToken;

      fetch(`${API}/settings/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ttsBody),
      }).then(() => {
        ["tts-minimax-key", "tts-doubao-key", "tts-openai-key", "tts-elevenlabs-key", "tts-volcano-token"].forEach(id => {
          const el = document.getElementById(id);
          if (el) el.value = "";
        });
      }).catch(() => {});
    });
  }

  if (testBtn) {
    testBtn.addEventListener("click", async () => {
      testBtn.disabled = true;
      if (testStatus) testStatus.textContent = "保存配置中…";
      try {
        const preBody = { ttsProvider: providerSel.value };
        const currentVoice = voiceSel?.value?.trim();
        if (currentVoice) preBody.ttsVoiceId = currentVoice;
        const minimaxKey2 = document.getElementById("tts-minimax-key")?.value?.trim();
        if (minimaxKey2) preBody.minimaxKey = minimaxKey2;
        const doubaoKey = document.getElementById("tts-doubao-key")?.value?.trim();
        if (doubaoKey) preBody.doubaoKey = doubaoKey;
        const openaiKey = document.getElementById("tts-openai-key")?.value?.trim();
        if (openaiKey) preBody.openaiTtsKey = openaiKey;
        const elevenKey = document.getElementById("tts-elevenlabs-key")?.value?.trim();
        if (elevenKey) preBody.elevenLabsKey = elevenKey;
        const volcanoAppId = document.getElementById("tts-volcano-appid")?.value?.trim();
        if (volcanoAppId) preBody.volcanoAppId = volcanoAppId;
        const volcanoToken = document.getElementById("tts-volcano-token")?.value?.trim();
        if (volcanoToken) preBody.volcanoToken = volcanoToken;
        await fetch(`${API}/settings/tts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(preBody),
        });
        if (testStatus) testStatus.textContent = "合成中…";
        const ttsResp = await fetch(`${API}/tts/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "你好，这是一段语音合成测试，听起来清晰自然吗？" }),
        });
        if (!ttsResp.ok) {
          let errMsg = `合成失败（HTTP ${ttsResp.status}）`;
          try { const j = await ttsResp.json(); errMsg = j.error || errMsg; } catch {}
          if (testStatus) testStatus.textContent = errMsg;
          return;
        }
        const ttsBlob = await ttsResp.blob();
        if (ttsBlob.size === 0) {
          if (testStatus) testStatus.textContent = "合成失败：接口返回空数据，请检查 API Key 和账户配置。";
          return;
        }
        const ttsUrl = URL.createObjectURL(ttsBlob);
        const ttsAudio = new Audio(ttsUrl);
        ttsAudio.onended = () => { URL.revokeObjectURL(ttsUrl); if (testStatus) testStatus.textContent = ""; };
        ttsAudio.onerror = () => { URL.revokeObjectURL(ttsUrl); if (testStatus) testStatus.textContent = "播放失败"; };
        await ttsAudio.play();
        if (testStatus) testStatus.textContent = "播放中";
        setTimeout(() => { if (testStatus && testStatus.textContent === "播放中") testStatus.textContent = ""; }, 8000);
      } catch {
        if (testStatus) testStatus.textContent = "失败 — 请检查配置和 API Key";
      } finally {
        testBtn.disabled = false;
      }
    });
  }
}

// ── Settings modal ──
(function initSettings() {
  const settingsBtn     = document.getElementById("settings-btn");
  const overlay         = document.getElementById("settings-overlay");
  const closeBtn        = document.getElementById("settings-close");
  const providerSelect  = document.getElementById("settings-provider-select");
  const modelSelect     = document.getElementById("settings-model-select");
  const llmKeyInput     = document.getElementById("settings-llm-key");
  const saveLlmBtn      = document.getElementById("settings-save-llm");
  const llmFeedback     = document.getElementById("settings-llm-feedback");
  const tempSlider      = document.getElementById("settings-temperature");
  const tempVal         = document.getElementById("settings-temperature-val");
  const saveTempBtn     = document.getElementById("settings-save-temperature");
  const tempFeedback    = document.getElementById("settings-temperature-feedback");
  const minimaxKeyInput = document.getElementById("settings-minimax-key");
  const saveMinimaxBtn  = document.getElementById("settings-save-minimax");
  const minimaxFeedback = document.getElementById("settings-minimax-feedback");
  const saveSocialBtn   = document.getElementById("settings-save-social");
  const socialFeedback  = document.getElementById("settings-social-feedback");
  const saveVoiceBtn    = document.getElementById("settings-save-voice");
  const voiceFeedback   = document.getElementById("settings-voice-feedback");
  const voiceThreshSlider = document.getElementById("settings-voice-threshold");
  const voiceThreshVal    = document.getElementById("settings-voice-threshold-val");

  if (!settingsBtn || !overlay) return;

  let cachedProviders = null;

  overlay.querySelectorAll(".settings-nav-item").forEach(btn => {
    btn.addEventListener("click", () => {
      overlay.querySelectorAll(".settings-nav-item").forEach(b => b.classList.remove("active"));
      overlay.querySelectorAll(".settings-tab").forEach(t => t.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      overlay.querySelector(`.settings-tab[data-tab="${tab}"]`)?.classList.add("active");
      if (tab === "social") loadSocialSettings();
      if (tab === "security") loadSecuritySettings();
      if (tab === "web-search") loadWebSearchSettings();
      if (tab === "update") loadUpdateSettings();
    });
  });

  function showFeedback(el, msg, isError = false) {
    if (!el) return;
    el.textContent = msg;
    el.className = "settings-feedback" + (isError ? " error" : "");
    setTimeout(() => { el.textContent = ""; el.className = "settings-feedback"; }, 3000);
  }

  function refreshConfigSummary({ llm, minimax }) {
    const cfgLlm = document.getElementById("settings-cfg-llm");
    const cfgLlmDot = document.getElementById("settings-cfg-llm-dot");
    const cfgMedia = document.getElementById("settings-cfg-media");
    const cfgMediaDot = document.getElementById("settings-cfg-media-dot");
    if (cfgLlm) cfgLlm.textContent = `${llm.provider || "—"} · ${llm.model || "—"}`;
    if (cfgLlmDot) {
      cfgLlmDot.textContent = "●";
      cfgLlmDot.className = `settings-config-dot ${llm.activated ? "active" : "inactive"}`;
      cfgLlmDot.title = llm.activated ? "Running" : "Inactive";
    }
    if (cfgMedia) cfgMedia.textContent = `minimax · ${minimax.configured ? "configured" : "not configured"}`;
    if (cfgMediaDot) {
      cfgMediaDot.textContent = "●";
      cfgMediaDot.className = `settings-config-dot ${minimax.configured ? "active" : "inactive"}`;
    }
  }

  function populateModelSelect(models, current) {
    if (!modelSelect || !models) return;
    modelSelect.innerHTML = models
      .map(m => `<option value="${m.id}"${m.deprecated ? " data-deprecated" : ""}>${m.label}</option>`)
      .join("");
    if (current) modelSelect.value = current;
  }

  function populateProviderSelect(providers, current) {
    if (!providerSelect || !providers) return;
    const selected = current || providerSelect.value || "auto";
    const options = [`<option value="auto">Auto-detect</option>`]
      .concat(Object.entries(providers).map(([id, provider]) => {
        const label = provider.label || id;
        return `<option value="${id}">${label}</option>`;
      }));
    providerSelect.innerHTML = options.join("");
    providerSelect.value = providers[selected] || selected === "auto" ? selected : "auto";
  }

  function applyCustomProviderUI(llm) {
    const customSection = document.getElementById("settings-custom-llm-section");
    const modelRow = document.getElementById("settings-model-row");
    if (llm?.provider === "custom") {
      if (customSection) customSection.style.display = "";
      if (modelRow) modelRow.style.display = "none";
      const baseUrlEl = document.getElementById("settings-custom-baseurl");
      const modelEl = document.getElementById("settings-custom-model");
      if (baseUrlEl && llm.baseURL) baseUrlEl.value = llm.baseURL;
      if (modelEl && llm.model) modelEl.value = llm.model;
    } else {
      if (customSection) customSection.style.display = "none";
      if (modelRow) modelRow.style.display = "";
    }
  }

  async function loadSettings() {
    try {
      const data = await fetch(`${API}/settings`).then(r => r.json());
      const { llm, minimax, providers } = data;
      if (providers) cachedProviders = providers;
      refreshConfigSummary({ llm, minimax });
      populateProviderSelect(providers, llm.provider || "auto");
      if (providerSelect && llm.provider) providerSelect.value = llm.provider;
      applyCustomProviderUI(llm);
      if (llm.provider !== "custom") populateModelSelect(llm.models, llm.model);
      if (typeof llm.temperature === "number" && tempSlider) {
        tempSlider.value = String(llm.temperature);
        if (tempVal) tempVal.textContent = llm.temperature.toFixed(2);
      }
    } catch {}
  }

  const SOCIAL_FIELD_MAP = {
    "social-discord-token":  "DISCORD_BOT_TOKEN",
    "social-feishu-appid":   "FEISHU_APP_ID",
    "social-feishu-secret":  "FEISHU_APP_SECRET",
    "social-feishu-token":   "FEISHU_VERIFICATION_TOKEN",
    "social-wechat-appid":   "WECHAT_OFFICIAL_APP_ID",
    "social-wechat-secret":  "WECHAT_OFFICIAL_APP_SECRET",
    "social-wechat-token":   "WECHAT_OFFICIAL_TOKEN",
    "social-wecom-botkey":   "WECOM_BOT_KEY",
    "social-wecom-token":    "WECOM_INCOMING_TOKEN",
  };

  const SOCIAL_PLATFORM_STATUS = {
    "social-status-discord": ["DISCORD_BOT_TOKEN"],
    "social-status-feishu":  ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_VERIFICATION_TOKEN"],
    "social-status-wechat":  ["WECHAT_OFFICIAL_APP_ID", "WECHAT_OFFICIAL_APP_SECRET", "WECHAT_OFFICIAL_TOKEN"],
    "social-status-wecom":   ["WECOM_BOT_KEY", "WECOM_INCOMING_TOKEN"],
  };

  async function loadSocialSettings() {
    try {
      const { social } = await fetch(`${API}/settings/social`).then(r => r.json());
      for (const [statusId, keys] of Object.entries(SOCIAL_PLATFORM_STATUS)) {
        const el = document.getElementById(statusId);
        if (!el) continue;
        const configuredCount = keys.filter(k => social[k]?.configured).length;
        if (configuredCount === keys.length) {
          el.textContent = "● 已配置";
          el.className = "settings-platform-status ok";
        } else if (configuredCount > 0) {
          el.textContent = `● 部分配置 (${configuredCount}/${keys.length})`;
          el.className = "settings-platform-status miss";
        } else {
          el.textContent = "○ 未配置";
          el.className = "settings-platform-status miss";
        }
      }
    } catch {}
  }

  const fileSandboxToggle = document.getElementById("security-file-sandbox");
  const execSandboxToggle = document.getElementById("security-exec-sandbox");
  const saveSecurityBtn   = document.getElementById("settings-save-security");
  const securityFeedback  = document.getElementById("settings-security-feedback");

  async function loadWebSearchSettings() {
    try {
      const { webSearch } = await fetch(`${API}/settings/web-search`).then(r => r.json());
      const urlEl = document.getElementById("websearch-searxng-url");
      if (urlEl) urlEl.value = webSearch?.searxngUrl || "";
      const setStatus = (id, configured, fromEnv, extra) => {
        const el = document.getElementById(id);
        if (!el) return;
        const truncated = extra && extra.length > 60 ? extra.slice(0, 60) + "…" : extra;
        if (configured) {
          el.textContent = `已配置${fromEnv ? "（环境变量）" : ""}${truncated ? ` · ${truncated}` : ""}`;
          el.style.color = "var(--ok, #4caf50)";
        } else {
          el.textContent = "未配置（兜底链中跳过）";
          el.style.color = "var(--ink2)";
        }
      };
      setStatus("websearch-status-serper",  !!webSearch?.serperConfigured, !!webSearch?.serperFromEnv);
      setStatus("websearch-status-jina",    !!webSearch?.jinaConfigured,   !!webSearch?.jinaFromEnv);
      const searxngConfigured = !!webSearch?.searxngUrl || !!webSearch?.searxngFromEnv;
      setStatus("websearch-status-searxng", searxngConfigured, !!webSearch?.searxngFromEnv, webSearch?.effectiveSearxngUrl || "");
    } catch {}
  }

  const saveWebSearchBtn = document.getElementById("settings-save-web-search");
  const webSearchFeedback = document.getElementById("settings-web-search-feedback");
  if (saveWebSearchBtn) {
    saveWebSearchBtn.addEventListener("click", async () => {
      const updates = {};
      const serperEl  = document.getElementById("websearch-serper-key");
      const jinaEl    = document.getElementById("websearch-jina-key");
      const searxngEl = document.getElementById("websearch-searxng-url");
      const serperVal  = serperEl?.value?.trim();
      const jinaVal    = jinaEl?.value?.trim();
      const searxngVal = searxngEl?.value?.trim();
      if (serperVal)  updates.serperKey  = serperVal;
      if (jinaVal)    updates.jinaKey    = jinaVal;
      // SearXNG URL：空字符串也要传，让用户能清掉
      if (searxngEl)  updates.searxngUrl = searxngVal || "";
      saveWebSearchBtn.disabled = true;
      try {
        const res = await fetch(`${API}/settings/web-search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updates),
        });
        const data = await res.json();
        if (data.ok) {
          showFeedback(webSearchFeedback, "已保存");
          if (serperEl) serperEl.value = "";
          if (jinaEl)   jinaEl.value = "";
          loadWebSearchSettings();
        } else {
          showFeedback(webSearchFeedback, data.error || "保存失败", true);
        }
      } catch {
        showFeedback(webSearchFeedback, "请求失败", true);
      } finally {
        saveWebSearchBtn.disabled = false;
      }
    });
  }

  async function loadSecuritySettings() {
    try {
      const { security } = await fetch(`${API}/settings/security`).then(r => r.json());
      if (fileSandboxToggle) fileSandboxToggle.checked = security.fileSandbox !== false;
      if (execSandboxToggle) execSandboxToggle.checked = security.execSandbox !== false;
      document.querySelectorAll(".security-blocked-tool").forEach(cb => {
        cb.checked = (security.blockedTools || []).includes(cb.value);
      });
    } catch {}
  }

  if (saveSecurityBtn) {
    saveSecurityBtn.addEventListener("click", async () => {
      const blockedTools = [...document.querySelectorAll(".security-blocked-tool")]
        .filter(cb => cb.checked)
        .map(cb => cb.value);
      const body = {
        fileSandbox: fileSandboxToggle ? fileSandboxToggle.checked : true,
        execSandbox: execSandboxToggle ? execSandboxToggle.checked : true,
        blockedTools,
      };
      saveSecurityBtn.disabled = true;
      try {
        const res = await fetch(`${API}/settings/security`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (data.ok) {
          showFeedback(securityFeedback, "已保存 — 立即生效");
        } else {
          showFeedback(securityFeedback, data.error || "保存失败", true);
        }
      } catch {
        showFeedback(securityFeedback, "请求失败", true);
      } finally {
        saveSecurityBtn.disabled = false;
      }
    });
  }

  if (saveSocialBtn) {
    saveSocialBtn.addEventListener("click", async () => {
      const updates = {};
      for (const [fieldId, envKey] of Object.entries(SOCIAL_FIELD_MAP)) {
        const val = document.getElementById(fieldId)?.value?.trim() || "";
        if (val) updates[envKey] = val;
      }
      saveSocialBtn.disabled = true;
      try {
        const res = await fetch(`${API}/settings/social`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updates),
        });
        const data = await res.json();
        if (data.ok) {
          showFeedback(socialFeedback, "已保存");
          Object.keys(SOCIAL_FIELD_MAP).forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = "";
          });
          loadSocialSettings();
        } else {
          showFeedback(socialFeedback, data.error || "保存失败", true);
        }
      } catch {
        showFeedback(socialFeedback, "请求失败", true);
      } finally {
        saveSocialBtn.disabled = false;
      }
    });
  }

  if (tempSlider && tempVal) {
    tempSlider.addEventListener("input", () => {
      tempVal.textContent = parseFloat(tempSlider.value).toFixed(2);
    });
  }
  if (saveTempBtn) {
    saveTempBtn.addEventListener("click", async () => {
      const temperature = parseFloat(tempSlider?.value ?? "0.5");
      saveTempBtn.disabled = true;
      try {
        const res = await fetch(`${API}/settings/temperature`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ temperature }),
        });
        const data = await res.json();
        if (data.ok) {
          showFeedback(tempFeedback, `已设为 ${data.temperature.toFixed(2)}`);
        } else {
          showFeedback(tempFeedback, data.error || "保存失败", true);
        }
      } catch { showFeedback(tempFeedback, "请求失败", true); }
      finally { saveTempBtn.disabled = false; }
    });
  }

  const VOICE_LANG_KEY       = "bailongma-voice-lang";
  const VOICE_AUTO_SEND_KEY  = "bailongma-voice-auto-send";
  const VOICE_AUTO_MIC_KEY   = "bailongma-voice-auto-mic";
  const VOICE_THRESHOLD_KEY  = "bailongma-voice-threshold";
  const VOICE_PROVIDER_KEY   = "bailongma-voice-provider";

  function applyVoiceProviderUI(provider) {
    const panels = { aliyun: "voice-cred-aliyun", tencent: "voice-cred-tencent", xunfei: "voice-cred-xunfei" };
    for (const [key, id] of Object.entries(panels)) {
      const el = document.getElementById(id);
      if (el) el.style.display = key === provider ? "" : "none";
    }
  }

  const voiceProviderSelect = document.getElementById("voice-provider-select");
  if (voiceProviderSelect) {
    voiceProviderSelect.addEventListener("change", () => applyVoiceProviderUI(voiceProviderSelect.value));
  }

  async function loadVoiceSettings() {
    const langSelect = document.getElementById("voice-lang-select");
    const autoSend   = document.getElementById("voice-auto-send");
    if (langSelect) langSelect.value = localStorage.getItem(VOICE_LANG_KEY) || "zh-CN";
    if (autoSend) autoSend.checked = localStorage.getItem(VOICE_AUTO_SEND_KEY) !== "false";
    const autoMic = document.getElementById("voice-auto-mic");
    if (autoMic) autoMic.checked = localStorage.getItem(VOICE_AUTO_MIC_KEY) === "true";
    const savedThresh = parseFloat(localStorage.getItem(VOICE_THRESHOLD_KEY) || "0.008");
    if (voiceThreshSlider) voiceThreshSlider.value = String(savedThresh);
    if (voiceThreshVal)    voiceThreshVal.textContent = savedThresh.toFixed(3);

    const savedProvider = localStorage.getItem(VOICE_PROVIDER_KEY) || "aliyun";
    if (voiceProviderSelect) voiceProviderSelect.value = savedProvider;
    applyVoiceProviderUI(savedProvider);
  }

  if (voiceThreshSlider && voiceThreshVal) {
    voiceThreshSlider.addEventListener("input", () => {
      voiceThreshVal.textContent = parseFloat(voiceThreshSlider.value).toFixed(3);
    });
  }


  if (saveVoiceBtn) {
    saveVoiceBtn.addEventListener("click", async () => {
      const lang      = document.getElementById("voice-lang-select")?.value || "zh-CN";
      const autoSend  = document.getElementById("voice-auto-send")?.checked ?? true;
      const autoMic   = document.getElementById("voice-auto-mic")?.checked ?? false;
      const threshold = parseFloat(voiceThreshSlider?.value ?? "0.008");
      const provider  = voiceProviderSelect?.value || "aliyun";

      localStorage.setItem(VOICE_LANG_KEY,      lang);
      localStorage.setItem(VOICE_AUTO_SEND_KEY,  String(autoSend));
      localStorage.setItem(VOICE_AUTO_MIC_KEY,   String(autoMic));
      localStorage.setItem(VOICE_THRESHOLD_KEY,  String(threshold));
      localStorage.setItem(VOICE_PROVIDER_KEY,   provider);

      window.dispatchEvent(new CustomEvent("bailongma:voice-threshold", { detail: { threshold } }));

      const body = {};
      const aliyunKey = document.getElementById("voice-aliyun-key")?.value?.trim();
      if (aliyunKey) body.aliyunApiKey = aliyunKey;
      const tencentSid = document.getElementById("voice-tencent-sid")?.value?.trim();
      if (tencentSid) body.tencentSecretId = tencentSid;
      const tencentSkey = document.getElementById("voice-tencent-skey")?.value?.trim();
      if (tencentSkey) body.tencentSecretKey = tencentSkey;
      const tencentAppid = document.getElementById("voice-tencent-appid")?.value?.trim();
      if (tencentAppid) body.tencentAppId = tencentAppid;
      const xunfeiAppid = document.getElementById("voice-xunfei-appid")?.value?.trim();
      if (xunfeiAppid) body.xunfeiAppId = xunfeiAppid;
      const xunfeiApikey = document.getElementById("voice-xunfei-apikey")?.value?.trim();
      if (xunfeiApikey) body.xunfeiApiKey = xunfeiApikey;

      if (Object.keys(body).length > 0) {
        try {
          saveVoiceBtn.disabled = true;
          const resp = await fetch("http://127.0.0.1:3721/settings/voice", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          if (!resp.ok) throw new Error("保存失败");
          ["voice-aliyun-key","voice-tencent-sid","voice-tencent-skey","voice-xunfei-apikey"].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = "";
          });
          showFeedback(voiceFeedback, "已保存");
        } catch { showFeedback(voiceFeedback, "保存失败", true); }
        finally { saveVoiceBtn.disabled = false; }
      } else {
        showFeedback(voiceFeedback, "已保存");
      }
    });
  }

  initTTSSettings();

  const memoryGraphToggle = document.getElementById("settings-memory-graph-toggle");
  const memoryGraphFeedback = document.getElementById("settings-memory-graph-feedback");
  if (memoryGraphToggle) {
    memoryGraphToggle.checked = localStorage.getItem(MEMORY_GRAPH_STORAGE_KEY) !== "false";
    memoryGraphToggle.addEventListener("change", () => {
      localStorage.setItem(MEMORY_GRAPH_STORAGE_KEY, String(memoryGraphToggle.checked));
      if (memoryGraphFeedback) {
        memoryGraphFeedback.textContent = "下次刷新页面后生效";
        memoryGraphFeedback.className = "settings-feedback";
        setTimeout(() => { memoryGraphFeedback.textContent = ""; }, 3000);
      }
    });
  }

  function openSettings(tab = null) {
    overlay.hidden = false;
    loadSettings();
    loadVoiceSettings();
    if (tab) {
      overlay.querySelectorAll(".settings-nav-item").forEach(b => {
        b.classList.toggle("active", b.dataset.tab === tab);
      });
      overlay.querySelectorAll(".settings-tab").forEach(t => {
        t.classList.toggle("active", t.dataset.tab === tab);
      });
      if (tab === "social") loadSocialSettings();
      if (tab === "web-search") loadWebSearchSettings();
      if (tab === "update") loadUpdateSettings();
    }
  }

  function closeSettings() {
    overlay.hidden = true;
    if (llmKeyInput) llmKeyInput.value = "";
    if (minimaxKeyInput) minimaxKeyInput.value = "";
  }

  settingsBtn.addEventListener("click", () => openSettings());
  closeBtn.addEventListener("click", closeSettings);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeSettings(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !overlay.hidden) closeSettings(); });

  if (providerSelect) {
    providerSelect.addEventListener("change", () => {
      const provider = providerSelect.value;
      const customSection = document.getElementById("settings-custom-llm-section");
      const modelRow = document.getElementById("settings-model-row");
      if (provider === "custom") {
        if (customSection) customSection.style.display = "";
        if (modelRow) modelRow.style.display = "none";
      } else {
        if (customSection) customSection.style.display = "none";
        if (modelRow) modelRow.style.display = "";
        if (cachedProviders?.[provider]) populateModelSelect(cachedProviders[provider].models, null);
      }
    });
  }

  saveLlmBtn?.addEventListener("click", async () => {
    const provider = providerSelect?.value || "auto";
    const apiKey = llmKeyInput.value.trim();
    saveLlmBtn.disabled = true;

    if (provider === "custom") {
      const baseURL = document.getElementById("settings-custom-baseurl")?.value?.trim();
      const model   = document.getElementById("settings-custom-model")?.value?.trim();
      if (!baseURL || !model) {
        showFeedback(llmFeedback, "请填入 Base URL 和模型名称", true);
        saveLlmBtn.disabled = false;
        return;
      }
      try {
        const res = await fetch(`${API}/activate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "custom", baseURL, model, apiKey: apiKey || "none" }),
        });
        const data = await res.json();
        if (data.ok) {
          showFeedback(llmFeedback, `已连接：${data.model}`);
          llmKeyInput.value = "";
          loadSettings();
        } else {
          showFeedback(llmFeedback, data.error || "连接失败", true);
        }
      } catch { showFeedback(llmFeedback, "请求失败", true); }
      finally { saveLlmBtn.disabled = false; }
      return;
    }

    const model = modelSelect.value;
    try {
      const body = apiKey
        ? { provider, apiKey, ...(provider === "auto" ? {} : { model }) }
        : { model };
      const res = await fetch(apiKey ? `${API}/activate` : `${API}/settings/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) {
        showFeedback(llmFeedback, "已保存");
        llmKeyInput.value = "";
        loadSettings();
      } else {
        showFeedback(llmFeedback, data.error || "保存失败", true);
      }
    } catch { showFeedback(llmFeedback, "请求失败", true); }
    finally { saveLlmBtn.disabled = false; }
  });

  saveMinimaxBtn?.addEventListener("click", async () => {
    const apiKey = minimaxKeyInput.value.trim();
    if (!apiKey) { showFeedback(minimaxFeedback, "API Key 不能为空", true); return; }
    saveMinimaxBtn.disabled = true;
    try {
      const res = await fetch(`${API}/settings/minimax`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      const data = await res.json();
      if (data.ok) {
        showFeedback(minimaxFeedback, "已保存");
        minimaxKeyInput.value = "";
        loadSettings();
      } else {
        showFeedback(minimaxFeedback, data.error || "保存失败", true);
      }
    } catch { showFeedback(minimaxFeedback, "请求失败", true); }
    finally { saveMinimaxBtn.disabled = false; }
  });

  const clawbotConnectBtn = document.getElementById("clawbot-connect-btn");
  const clawbotLogoutBtn  = document.getElementById("clawbot-logout-btn");
  const clawbotQrArea     = document.getElementById("clawbot-qr-area");
  const clawbotQrImg      = document.getElementById("clawbot-qr-img");
  const clawbotQrHint     = document.getElementById("clawbot-qr-hint");
  const clawbotFeedback   = document.getElementById("clawbot-feedback");
  const clawbotStatus     = document.getElementById("social-status-clawbot");
  let clawbotPollTimer    = null;

  function setClawbotStatus(text, ok) {
    if (!clawbotStatus) return;
    clawbotStatus.textContent = ok ? `● ${text}` : `○ ${text}`;
    clawbotStatus.className = `settings-platform-status ${ok ? "ok" : "miss"}`;
  }

  function stopClawbotPoll() {
    if (clawbotPollTimer) { clearInterval(clawbotPollTimer); clawbotPollTimer = null; }
  }

  async function pollClawbotQR() {
    try {
      const data = await fetch(`${API}/social/wechat-clawbot/qr`).then(r => r.json());
      if (data.status === "connected") {
        stopClawbotPoll();
        if (clawbotQrArea) clawbotQrArea.style.display = "none";
        setClawbotStatus("已连接", true);
        if (clawbotFeedback) showFeedback(clawbotFeedback, "微信绑定成功！");
        loadSocialSettings();
      } else if (data.status === "qr_ready" && data.qr_url) {
        if (clawbotQrImg) clawbotQrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(data.qr_url)}`;
        if (clawbotQrArea) clawbotQrArea.style.display = "block";
        if (clawbotQrHint) clawbotQrHint.textContent = "等待扫码…";
        setClawbotStatus("等待扫码", false);
      } else if (data.status === "qr_pending") {
        if (clawbotQrHint) clawbotQrHint.textContent = "正在生成二维码…";
      } else if (data.status === "error") {
        stopClawbotPoll();
        if (clawbotQrArea) clawbotQrArea.style.display = "none";
        setClawbotStatus("连接失败", false);
        if (clawbotFeedback) showFeedback(clawbotFeedback, data.error || "连接失败", true);
      }
    } catch {}
  }

  if (clawbotConnectBtn) {
    pollClawbotQR();
  }

  clawbotConnectBtn?.addEventListener("click", async () => {
    if (clawbotQrArea) clawbotQrArea.style.display = "none";
    setClawbotStatus("启动中…", false);
    stopClawbotPoll();
    try {
      await fetch(`${API}/settings/social`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ _clawbot_connect: "1" }),
      });
    } catch {}
    await pollClawbotQR();
    clawbotPollTimer = setInterval(pollClawbotQR, 2000);
  });

  clawbotLogoutBtn?.addEventListener("click", async () => {
    stopClawbotPoll();
    if (clawbotQrArea) clawbotQrArea.style.display = "none";
    try {
      await fetch(`${API}/social/wechat-clawbot/logout`, { method: "POST" });
      setClawbotStatus("已断开", false);
      showFeedback(clawbotFeedback, "微信已断开");
    } catch {
      showFeedback(clawbotFeedback, "请求失败", true);
    }
  });

  window.addEventListener("bailongma:social_status", (e) => {
    const d = e.detail;
    if (d?.platform !== "wechat-clawbot") return;
    if (d.status === "connected") {
      stopClawbotPoll();
      if (clawbotQrArea) clawbotQrArea.style.display = "none";
      setClawbotStatus("已连接", true);
    } else if (d.status === "qr_ready") {
      if (!clawbotPollTimer) clawbotPollTimer = setInterval(pollClawbotQR, 2000);
      pollClawbotQR();
    } else if (d.status === "session_expired") {
      stopClawbotPoll();
      setClawbotStatus("会话已过期 — 请重新扫码", false);
    } else if (d.status === "idle") {
      setClawbotStatus("未连接", false);
    }
  });

  const settingsCheckUpdateBtn     = document.getElementById("settings-check-update-btn");
  const settingsDownloadUpdateBtn  = document.getElementById("settings-download-update-btn");
  const settingsInstallUpdateBtn   = document.getElementById("settings-install-update-btn");
  const settingsIgnoreUpdateBtn    = document.getElementById("settings-ignore-update-btn");
  const settingsUpdateStatusEl     = document.getElementById("settings-update-status");
  const settingsUpdateFeedback     = document.getElementById("settings-update-feedback");
  const settingsCurrentVersion     = document.getElementById("settings-current-version");
  const settingsSuppressToggle     = document.getElementById("settings-suppress-updates");
  const settingsIgnoredSection     = document.getElementById("settings-ignored-section");
  const settingsIgnoredVersionEl   = document.getElementById("settings-ignored-version-val");
  const settingsClearIgnoredBtn    = document.getElementById("settings-clear-ignored-btn");

  let pendingUpdateVersion = null;
  let removeUpdaterListener = null;

  function setUpdateStatusText(text, state = "idle") {
    if (!settingsUpdateStatusEl) return;
    settingsUpdateStatusEl.textContent = text;
    settingsUpdateStatusEl.dataset.state = state;
  }

  function setUpdateFeedback(text, isError = false) {
    if (!settingsUpdateFeedback) return;
    settingsUpdateFeedback.textContent = text || "";
    settingsUpdateFeedback.className = isError ? "settings-feedback error" : "settings-feedback";
  }

  function showUpdateButtons({ check = true, checkDisabled = false, checkLabel = "检查更新", download = false, install = false, ignore = false } = {}) {
    if (settingsCheckUpdateBtn) {
      settingsCheckUpdateBtn.classList.toggle("hidden", !check);
      settingsCheckUpdateBtn.disabled = checkDisabled;
      settingsCheckUpdateBtn.textContent = checkLabel;
    }
    settingsDownloadUpdateBtn?.classList.toggle("hidden", !download);
    settingsInstallUpdateBtn?.classList.toggle("hidden", !install);
    settingsIgnoreUpdateBtn?.classList.toggle("hidden", !ignore);
  }

  function syncUpdateSettings() {
    const ignored = localStorage.getItem(IGNORED_VERSION_KEY) || null;
    const suppressed = localStorage.getItem(SUPPRESS_UPDATES_KEY) === "true";
    if (settingsSuppressToggle) settingsSuppressToggle.checked = suppressed;
    if (settingsIgnoredSection) settingsIgnoredSection.style.display = ignored ? "" : "none";
    if (settingsIgnoredVersionEl && ignored) settingsIgnoredVersionEl.textContent = ignored;
  }

  async function loadUpdateSettings() {
    syncUpdateSettings();
    const bridge = window.bailongma;
    if (!bridge?.isElectron) {
      if (settingsCurrentVersion) settingsCurrentVersion.textContent = "仅桌面端可用";
      if (settingsCheckUpdateBtn) settingsCheckUpdateBtn.disabled = true;
      setUpdateStatusText("仅桌面端可用", "muted");
      return;
    }
    try {
      const ver = await bridge.getVersion?.();
      if (settingsCurrentVersion && ver) settingsCurrentVersion.textContent = ver;
    } catch {}

    removeUpdaterListener = bridge.onUpdaterStatus?.((payload = {}) => {
      const stage = payload.stage || "idle";
      const ver = payload.version || "";
      const percent = typeof payload.percent === "number" ? Math.round(payload.percent) : null;

      switch (stage) {
        case "checking":
          setUpdateStatusText("正在检查更新…", "checking");
          showUpdateButtons({ checkDisabled: true, checkLabel: "检查中…" });
          break;
        case "available":
          pendingUpdateVersion = ver;
          setUpdateStatusText(`发现新版本 ${ver}`, "available");
          showUpdateButtons({ check: false, download: true, ignore: true });
          break;
        case "downloading":
          setUpdateStatusText(`下载中${percent !== null ? ` ${percent}%` : "…"}`, "downloading");
          showUpdateButtons({ check: false });
          break;
        case "downloaded":
          setUpdateStatusText(`版本 ${ver} 已就绪 — 重启后安装`, "ready");
          showUpdateButtons({ check: false, install: true });
          break;
        case "up-to-date":
          setUpdateStatusText(`已是最新版本 ${ver}`, "idle");
          showUpdateButtons({ checkLabel: "检查更新" });
          break;
        case "error":
          setUpdateStatusText(`更新失败：${payload.message || "请稍后再试"}`, "error");
          showUpdateButtons({ checkLabel: "重试" });
          break;
        case "dev":
          setUpdateStatusText("开发模式不检查更新", "muted");
          showUpdateButtons({ checkDisabled: true, checkLabel: "开发模式" });
          break;
        default:
          showUpdateButtons({});
          break;
      }
    }) || null;
  }

  window.addEventListener("beforeunload", () => {
    if (typeof removeUpdaterListener === "function") {
      removeUpdaterListener();
      removeUpdaterListener = null;
    }
  });

  settingsSuppressToggle?.addEventListener("change", () => {
    localStorage.setItem(SUPPRESS_UPDATES_KEY, settingsSuppressToggle.checked ? "true" : "false");
    syncUpdateSettings();
  });

  settingsClearIgnoredBtn?.addEventListener("click", () => {
    localStorage.removeItem(IGNORED_VERSION_KEY);
    syncUpdateSettings();
  });

  settingsCheckUpdateBtn?.addEventListener("click", async () => {
    const bridge = window.bailongma;
    if (!bridge?.isElectron) return;
    setUpdateStatusText("正在检查更新…", "checking");
    setUpdateFeedback("");
    showUpdateButtons({ checkDisabled: true, checkLabel: "检查中…" });
    try {
      const result = await bridge.checkForUpdates?.();
      if (result?.ok === false && result?.message) {
        setUpdateStatusText(`更新失败：${result.message}`, "error");
        showUpdateButtons({ checkLabel: "重试" });
      }
    } catch (err) {
      setUpdateStatusText(`更新失败：${err?.message || "请稍后再试"}`, "error");
      showUpdateButtons({ checkLabel: "重试" });
    }
  });

  settingsDownloadUpdateBtn?.addEventListener("click", async () => {
    const bridge = window.bailongma;
    if (!bridge?.isElectron) return;
    setUpdateStatusText("开始下载…", "downloading");
    showUpdateButtons({ check: false });
    try {
      await bridge.startDownload?.();
    } catch (err) {
      setUpdateStatusText(`下载失败：${err?.message || "请稍后再试"}`, "error");
      showUpdateButtons({ checkLabel: "重试" });
    }
  });

  settingsInstallUpdateBtn?.addEventListener("click", () => {
    window.bailongma?.quitAndInstall?.();
  });

  settingsIgnoreUpdateBtn?.addEventListener("click", () => {
    if (pendingUpdateVersion) {
      localStorage.setItem(IGNORED_VERSION_KEY, pendingUpdateVersion);
      syncUpdateSettings();
    }
    setUpdateStatusText("已忽略此版本", "muted");
    showUpdateButtons({ checkLabel: "检查更新" });
  });
})();

// ── Voice panel ──
initVoicePanel({
  btnId:      "voice-btn",
  panelId:    "voice-panel",
  canvasId:   "voice-canvas",
  statusId:   "voice-status",
  transcriptId: "voice-transcript",
  getChatInput:  () => document.getElementById("msg-input"),
  getSendBtn:    () => document.getElementById("send-btn"),
  getSendMessage: (options) => chat?.send?.(options),
  getLang:       () => localStorage.getItem("bailongma-voice-lang") || "zh-CN",
  getAutoSend:   () => localStorage.getItem("bailongma-voice-auto-send") !== "false",
  getAutoMic:    () => localStorage.getItem("bailongma-voice-auto-mic") === "true",
});

// ── Hotspot mode ──
initHotspot().catch((err) => console.warn('[Hotspot] init failed:', err));

// ── Media modes (video / image) ──
(function initMediaModes() {
  const videoBtn      = document.getElementById("video-btn");
  const videoExitBtn  = document.getElementById("video-exit-btn");
  const videoFeed     = document.getElementById("video-feed");
  const videoFrame    = document.getElementById("video-frame");
  const videoSurface  = document.getElementById("video-surface");
  const videoBackdrop = document.getElementById("video-backdrop");
  const videoTitle    = document.getElementById("video-title");
  const imageExitBtn  = document.getElementById("image-exit-btn");
  const imageDisplay  = document.getElementById("image-display");
  const imageSurface  = document.getElementById("image-surface");
  const imageTitle    = document.getElementById("image-title");

  let videoStream = null;
  let videoActive = false;
  let imageActive = false;
  let videoKind   = "empty";
  let currentVideoSource = "";
  let currentVideoStart = null;
  // wall-clock ms when current play started/resumed; used to estimate elapsed
  // for cross-origin iframes (bilibili) where we can't read currentTime.
  let playResumeAt = null;

  function normalizeUrl(url = "") {
    return String(url || "").trim();
  }

  function localPathToUrl(src) {
    const s = String(src || "").trim();
    if (!s) return "";
    if (/^https?:\/\//i.test(s)) return s;
    // Local path (file:// or absolute) → backend HTTP media endpoint to avoid file:// CORS restriction
    let resolved = s;
    if (/^file:\/\//i.test(s)) {
      resolved = decodeURIComponent(s.replace(/^file:\/\/\//i, "").replace(/^file:\/\//i, ""));
    }
    const filename = resolved.split(/[\\/]/).filter(Boolean).pop() || "";
    if (!filename) return s;
    return "/media/music/" + encodeURIComponent(filename);
  }

  function extractYoutubeId(url) {
    return normalizeUrl(url).match(
      /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([A-Za-z0-9_-]{6,})/
    )?.[1] || null;
  }

  function youtubeEmbedUrl(url, { autoplay = false, start = null } = {}) {
    const id = extractYoutubeId(url);
    if (!id) return null;
    const params = new URLSearchParams({
      enablejsapi: "1",
      playsinline: "1",
      rel: "0",
      autoplay: autoplay ? "1" : "0",
    });
    if (Number.isFinite(Number(start))) params.set("start", String(Math.max(0, Math.round(Number(start)))));
    return `https://www.youtube.com/embed/${id}?${params.toString()}`;
  }

  function extractBilibiliId(url) {
    const raw = normalizeUrl(url);
    return raw.match(/\/video\/(BV[A-Za-z0-9]+)/i)?.[1]
        || raw.match(/\b(BV[A-Za-z0-9]+)\b/i)?.[1]
        || null;
  }

  function bilibiliEmbedUrl(url, { autoplay = false, start = null } = {}) {
    const bvid = extractBilibiliId(url);
    if (!bvid) return null;
    const params = new URLSearchParams({
      bvid,
      autoplay: autoplay ? "1" : "0",
      high_quality: "1",
    });
    if (Number.isFinite(Number(start))) params.set("t", String(Math.max(0, Math.round(Number(start)))));
    return `https://player.bilibili.com/player.html?${params.toString()}`;
  }

  function iframeUrlFor(url, options) {
    return youtubeEmbedUrl(url, options) || bilibiliEmbedUrl(url, options);
  }

  function saveMediaHistory({ url, title, kind, videoId = null, platform = null }) {
    fetch(`${API}/media/history`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, title: title || "", kind, videoId, platform }),
    }).catch(() => {});
  }

  async function validateYoutubeUrl(url) {
    try {
      const oembed = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
      const res = await fetch(oembed, { signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch {
      return null; // network failure — don't block, allow playback to proceed
    }
  }

  function stopCamera() {
    videoStream?.getTracks().forEach(t => t.stop());
    videoStream = null;
  }

  function setPanelVisible(visible) {
    videoActive = Boolean(visible);
    document.body.classList.toggle("video-mode", videoActive);
    videoBtn?.classList.toggle("active", videoActive);
    if (videoActive) moveVoicePanelToBody();
    else restoreVoicePanel();
    window.dispatchEvent(new CustomEvent("bailongma:video-mode", {
      detail: { active: videoActive, kind: videoKind },
    }));
  }

  function pauseCurrentVideo() {
    if (videoKind === "youtube") {
      postFrameCommand("pauseVideo");
      playResumeAt = null;
    } else if (videoKind === "bilibili") {
      // bilibili iframe 跨域读不到 currentTime，用 wall-clock 估算累计进度
      if (playResumeAt) {
        const elapsed = (Date.now() - playResumeAt) / 1000;
        currentVideoStart = (Number(currentVideoStart) || 0) + elapsed;
      }
      playResumeAt = null;
      reloadFrameAutoplay(false);
    } else if (videoKind === "file") {
      try { videoFeed?.pause?.(); } catch {}
      playResumeAt = null;
    }
  }

  function resumeCurrentVideo() {
    if (videoKind === "youtube") {
      postFrameCommand("playVideo");
      playResumeAt = Date.now();
    } else if (videoKind === "bilibili") {
      reloadFrameAutoplay(true);
      playResumeAt = Date.now();
    } else if (videoKind === "file") {
      videoFeed?.play?.().catch(() => {});
      playResumeAt = Date.now();
    }
  }

  function resetVideoSurface() {
    stopCamera();
    if (videoFeed) {
      try { videoFeed.pause(); } catch {}
      videoFeed.removeAttribute("src");
      videoFeed.srcObject = null;
      videoFeed.hidden = true;
      videoFeed.load?.();
    }
    if (videoFrame) {
      videoFrame.src = "about:blank";
      videoFrame.hidden = true;
    }
    if (videoBackdrop) videoBackdrop.style.backgroundImage = "";
    videoSurface?.classList.remove("has-media");
    videoKind = "empty";
    currentVideoSource = "";
    currentVideoStart = null;
    playResumeAt = null;
  }

  function toggleVideoPanelVisibility() {
    if (videoActive) {
      pauseCurrentVideo();
      setPanelVisible(false);
    } else {
      if (musicActive) closeMusicPanel();
      setPanelVisible(true);
      if (videoKind !== "empty") resumeCurrentVideo();
    }
  }

  function closeAndDestroyVideo() {
    setPanelVisible(false);
    resetVideoSurface();
  }

  function setVideoModeActive(active) {
    if (!active) {
      closeAndDestroyVideo();
    } else {
      setPanelVisible(true);
    }
  }

  function setBackdrop(kind, url) {
    if (!videoBackdrop) return;
    if (kind === "youtube") {
      const id = extractYoutubeId(url);
      if (id) {
        videoBackdrop.style.backgroundImage =
          `url(https://img.youtube.com/vi/${id}/maxresdefault.jpg)`;
        return;
      }
    }
    // Bilibili / file / camera: solid color fallback (CSS already sets #000 background)
    videoBackdrop.style.backgroundImage = "";
  }

  async function showCamera({ title = "Camera", autoplay = true } = {}) {
    setPanelVisible(true);
    resetVideoSurface();
    if (videoTitle) videoTitle.textContent = title;
    try {
      videoStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      if (videoFeed) {
        videoFeed.hidden = false;
        videoFeed.muted = true;
        videoFeed.srcObject = videoStream;
        if (autoplay) videoFeed.play?.().catch(() => {});
      }
      videoSurface?.classList.add("has-media");
      videoKind = "camera";
    } catch (e) {
      console.warn("Camera access failed:", e);
    }
  }

  async function showVideo({
    url = "", src = "", title = "Video", autoplay = true,
    muted = false, volume = null, currentTime = null, camera = false,
  } = {}) {
    if (camera) { showCamera({ title, autoplay }); return; }

    const source = normalizeUrl(url || src);
    if (musicActive) closeMusicPanel();
    setPanelVisible(true);
    resetVideoSurface();
    currentVideoSource = source;
    currentVideoStart = Number.isFinite(Number(currentTime)) ? Math.max(0, Number(currentTime)) : null;
    if (videoTitle) videoTitle.textContent = title || "Video";

    const embedUrl = iframeUrlFor(source, { autoplay, start: currentTime });
    if (embedUrl && videoFrame) {
      videoFrame.hidden = false;
      videoFrame.src = embedUrl;
      videoSurface?.classList.add("has-media");
      videoKind = embedUrl.includes("youtube.com") ? "youtube" : "bilibili";
      if (autoplay) playResumeAt = Date.now();

      setBackdrop(videoKind, source);
      saveMediaHistory({
        url: source,
        title,
        kind: videoKind,
        videoId: videoKind === "youtube" ? extractYoutubeId(source) : extractBilibiliId(source),
        platform: videoKind,
      });

      if (videoKind === "youtube") {
        validateYoutubeUrl(source).then(ok => {
          if (ok === false) console.warn("[Media] YouTube video may not play (region block / private / deleted):", source);
        });
      }
      return;
    }

    if (videoFeed && source) {
      videoFeed.hidden = false;
      videoFeed.src = source;
      videoFeed.muted = Boolean(muted);
      if (Number.isFinite(Number(volume))) videoFeed.volume = Math.max(0, Math.min(1, Number(volume)));
      if (Number.isFinite(Number(currentTime))) videoFeed.currentTime = Math.max(0, Number(currentTime));
      videoSurface?.classList.add("has-media");
      videoKind = "file";
      saveMediaHistory({ url: source, title, kind: "file" });
      if (autoplay) {
        videoFeed.play?.().catch(() => {});
        playResumeAt = Date.now();
      }
    }
  }

  function postFrameCommand(command, args = []) {
    if (!videoFrame?.contentWindow || videoFrame.hidden) return;
    if (videoKind === "youtube") {
      videoFrame.contentWindow.postMessage(JSON.stringify({
        event: "command",
        func: command,
        args,
      }), "*");
    }
  }

  function reloadFrameAutoplay(autoplay) {
    if (!videoFrame || videoFrame.hidden || !currentVideoSource) return;
    const nextUrl = iframeUrlFor(currentVideoSource, {
      autoplay,
      start: currentVideoStart,
    });
    if (nextUrl) videoFrame.src = nextUrl;
  }

  function controlVideo({ action, volume, currentTime, autoplay } = {}) {
    const op = action || (autoplay ? "play" : null);
    if (op === "hide" || op === "close") { closeAndDestroyVideo(); return; }
    if (op === "play") resumeCurrentVideo();
    if (op === "pause") pauseCurrentVideo();
    if (Number.isFinite(Number(volume))) {
      const v = Math.max(0, Math.min(1, Number(volume)));
      if (videoFeed) { videoFeed.volume = v; videoFeed.muted = v === 0; }
      postFrameCommand("setVolume", [Math.round(v * 100)]);
    }
    if (Number.isFinite(Number(currentTime))) {
      const t = Math.max(0, Number(currentTime));
      currentVideoStart = t;
      if (videoFeed) videoFeed.currentTime = t;
      postFrameCommand("seekTo", [t, true]);
      // seek 后重置 elapsed 基线，下次 pause 时累计才正确
      if (playResumeAt) playResumeAt = Date.now();
    }
  }

  function setImageModeActive(active) {
    imageActive = Boolean(active);
    document.body.classList.toggle("image-mode", imageActive);
    if (!imageActive && imageDisplay) {
      imageDisplay.removeAttribute("src");
      imageDisplay.alt = "";
      imageSurface?.classList.remove("has-media");
    }
  }

  function showImage({ url = "", title = "Image", alt = "" } = {}) {
    const source = normalizeUrl(url);
    setImageModeActive(true);
    if (imageTitle) imageTitle.textContent = title || "Image";
    if (imageDisplay && source) {
      imageDisplay.src = source;
      imageDisplay.alt = alt || title || "";
      imageSurface?.classList.add("has-media");
    }
  }

  function handleMediaCommand(payload = {}) {
    const mode   = payload.mode || payload.kind;
    const action = payload.action || "show";
    if (mode === "image") {
      if (action === "hide" || action === "close") setImageModeActive(false);
      else showImage(payload);
      return { ok: true, mode: "image", action };
    }
    if (mode === "camera") {
      if (action === "hide" || action === "close") closeAndDestroyVideo();
      else showCamera(payload);
      return { ok: true, mode: "camera", action };
    }
    if (mode === "video") {
      if (action === "show" || payload.url || payload.camera) showVideo(payload);
      else controlVideo(payload);
      return { ok: true, mode: "video", action };
    }
    if (mode === "music") {
      if (action === "show" || payload.src || payload.playlist) showMusic(payload);
      else controlMusic(payload);
      return { ok: true, mode: "music", action };
    }
    return { ok: false, error: "unknown media mode" };
  }

  // ── Music mode ────────────────────────────────────────────────────────────
  const musicBtn       = document.getElementById("music-btn");
  const musicExitBtn   = document.getElementById("music-exit-btn");
  const musicAudio     = document.getElementById("music-audio");
  const musicPlayBtn   = document.getElementById("music-play");
  const musicPrevBtn   = document.getElementById("music-prev");
  const musicNextBtn   = document.getElementById("music-next");
  const musicSeek      = document.getElementById("music-seek");
  const musicVolInput  = document.getElementById("music-vol");
  const musicTimeCur   = document.getElementById("music-time-cur");
  const musicTimeTotal = document.getElementById("music-time-total");
  const musicMetaTitle  = document.getElementById("music-meta-title");
  const musicMetaArtist = document.getElementById("music-meta-artist");
  const musicCoverEl    = document.getElementById("music-cover");
  const musicCoverTitle = document.getElementById("music-cover-title");
  const musicCoverArtist = document.getElementById("music-cover-artist");
  const musicLyricsScroll = document.getElementById("music-lyrics-scroll");
  const musicNoLyrics     = document.getElementById("music-no-lyrics");

  let musicActive  = false;
  let musicPlaying = false;
  let musicWasPlayingBeforeHide = false;
  let lrcLines     = [];
  let playlist     = [];
  let playlistIdx  = 0;
  let isSeeking    = false;

  function parseLrc(text) {
    const lines = [];
    const re = /\[(\d+):(\d{1,2}(?:\.\d+)?)\](.*)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const t = parseInt(m[1], 10) * 60 + parseFloat(m[2]);
      const txt = m[3].trim();
      if (txt) lines.push({ time: t, text: txt });
    }
    return lines.sort((a, b) => a.time - b.time);
  }

  function fmtTime(s) {
    if (!isFinite(s) || s < 0) return "0:00";
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  }

  function setMusicPanelVisible(visible) {
    musicActive = Boolean(visible);
    document.body.classList.toggle("music-mode", musicActive);
    musicBtn?.classList.toggle("active", musicActive);
    window.dispatchEvent(new CustomEvent("bailongma:music-mode", {
      detail: { active: musicActive },
    }));
  }

  function setMusicPlaying(playing) {
    musicPlaying = Boolean(playing);
    document.body.classList.toggle("music-playing", musicPlaying);
    if (musicPlayBtn) musicPlayBtn.textContent = musicPlaying ? "⏸" : "▶";
    if (musicPlaying) {
      musicAudio?.play?.().catch(() => {});
    } else {
      musicAudio?.pause?.();
    }
  }

  function loadLrc(lrcText) {
    lrcLines = lrcText ? parseLrc(lrcText) : [];
    if (musicLyricsScroll) {
      musicLyricsScroll.innerHTML = lrcLines
        .map((l, i) => `<div class="lrc-line" data-idx="${i}">${l.text}</div>`)
        .join("");
    }
    if (musicNoLyrics) musicNoLyrics.hidden = lrcLines.length > 0;
  }

  function syncLyrics(currentTime) {
    if (!lrcLines.length || !musicLyricsScroll) return;
    let active = -1;
    for (let i = 0; i < lrcLines.length; i++) {
      if (lrcLines[i].time <= currentTime + 0.3) active = i;
      else break;
    }
    if (active < 0) return;
    const lines = musicLyricsScroll.querySelectorAll(".lrc-line");
    lines.forEach((el, i) => el.classList.toggle("active", i === active));
    const activeLine = lines[active];
    if (activeLine) {
      const pane = document.getElementById("music-lyrics-pane");
      if (pane) pane.scrollTo({ top: activeLine.offsetTop - pane.clientHeight / 2 + activeLine.clientHeight / 2, behavior: "smooth" });
    }
  }

  function loadTrack(index, autoplay = true) {
    const track = playlist[index];
    if (!track || !musicAudio) return;

    musicAudio.src = localPathToUrl(track.src || "");
    musicAudio.volume = parseFloat(musicVolInput?.value ?? "0.8");

    const title  = track.title  || "未知曲目";
    const artist = track.artist || "";
    if (musicMetaTitle)  musicMetaTitle.textContent  = title;
    if (musicMetaArtist) musicMetaArtist.textContent = artist;
    if (musicCoverTitle)  musicCoverTitle.textContent  = title.slice(0, 14);
    if (musicCoverArtist) musicCoverArtist.textContent = artist;
    if (musicTimeCur)   musicTimeCur.textContent   = "0:00";
    if (musicTimeTotal) musicTimeTotal.textContent = "0:00";
    if (musicSeek)      { musicSeek.value = "0"; musicSeek.max = "100"; }

    if (track.cover && musicCoverEl) {
      musicCoverEl.style.backgroundImage = `url(${track.cover})`;
      musicCoverEl.style.background = "";
    } else if (musicCoverEl) {
      musicCoverEl.style.backgroundImage = "";
      let hash = 0;
      for (const ch of title) hash = (hash * 31 + ch.charCodeAt(0)) & 0xffffffff;
      const hue = Math.abs(hash) % 360;
      musicCoverEl.style.background = `hsl(${hue}, 45%, 32%)`;
    }

    loadLrc(track.lrc || "");
    if (autoplay) setMusicPlaying(true);
  }

  function showMusic({
    src = "", title = "", artist = "", lrc = "", cover = "",
    autoplay = true, playlist: pl = null,
  } = {}) {
    if (videoActive) closeAndDestroyVideo();
    setMusicPanelVisible(true);
    if (pl && pl.length) {
      playlist = pl;
    } else {
      playlist = [{ src, title, artist, lrc, cover }];
    }
    playlistIdx = 0;
    loadTrack(0, autoplay);
  }

  function closeMusicPanel() {
    setMusicPlaying(false);
    setMusicPanelVisible(false);
    if (musicAudio) musicAudio.src = "";
    lrcLines = [];
    if (musicLyricsScroll) musicLyricsScroll.innerHTML = "";
    if (musicNoLyrics) musicNoLyrics.hidden = false;
  }

  function controlMusic({ action, volume, currentTime } = {}) {
    if (action === "hide" || action === "close") { closeMusicPanel(); return; }
    if (action === "play")  setMusicPlaying(true);
    if (action === "pause") setMusicPlaying(false);
    if (Number.isFinite(Number(volume))) {
      const v = Math.max(0, Math.min(1, Number(volume)));
      if (musicAudio) musicAudio.volume = v;
      if (musicVolInput) musicVolInput.value = String(v);
    }
    if (Number.isFinite(Number(currentTime)) && musicAudio) {
      musicAudio.currentTime = Math.max(0, Number(currentTime));
    }
  }

  function toggleMusicPanelVisibility() {
    if (musicActive) {
      musicWasPlayingBeforeHide = musicPlaying;
      setMusicPlaying(false);
      setMusicPanelVisible(false);
    } else if (musicAudio?.src) {
      if (videoActive) closeAndDestroyVideo();
      setMusicPanelVisible(true);
      if (musicWasPlayingBeforeHide) setMusicPlaying(true);
    }
  }

  if (musicAudio) {
    musicAudio.addEventListener("loadedmetadata", () => {
      if (musicTimeTotal) musicTimeTotal.textContent = fmtTime(musicAudio.duration);
      if (musicSeek) musicSeek.max = String(musicAudio.duration || 100);
    });
    musicAudio.addEventListener("timeupdate", () => {
      if (isSeeking) return;
      const t = musicAudio.currentTime;
      if (musicTimeCur) musicTimeCur.textContent = fmtTime(t);
      if (musicSeek && musicAudio.duration) musicSeek.value = String(t);
      syncLyrics(t);
    });
    musicAudio.addEventListener("ended", () => {
      setMusicPlaying(false);
      if (playlistIdx < playlist.length - 1) {
        playlistIdx++;
        loadTrack(playlistIdx, true);
      }
    });
  }

  musicPlayBtn?.addEventListener("click", () => setMusicPlaying(!musicPlaying));
  musicPrevBtn?.addEventListener("click", () => {
    if (playlistIdx > 0) { playlistIdx--; loadTrack(playlistIdx, musicPlaying); }
    else if (musicAudio) musicAudio.currentTime = 0;
  });
  musicNextBtn?.addEventListener("click", () => {
    if (playlistIdx < playlist.length - 1) { playlistIdx++; loadTrack(playlistIdx, musicPlaying); }
  });
  musicVolInput?.addEventListener("input", () => {
    if (musicAudio) musicAudio.volume = parseFloat(musicVolInput.value);
  });
  musicSeek?.addEventListener("mousedown", () => { isSeeking = true; });
  musicSeek?.addEventListener("input", () => {
    if (musicTimeCur) musicTimeCur.textContent = fmtTime(parseFloat(musicSeek.value));
  });
  musicSeek?.addEventListener("change", () => {
    if (musicAudio) musicAudio.currentTime = parseFloat(musicSeek.value);
    isSeeking = false;
  });
  musicExitBtn?.addEventListener("click", closeMusicPanel);
  musicBtn?.addEventListener("click", toggleMusicPanelVisibility);

  window.addEventListener("keydown", (e) => {
    if (e.target?.tagName === "INPUT" || e.target?.tagName === "TEXTAREA" || e.target?.isContentEditable) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "m" || e.key === "M") {
      e.preventDefault();
      toggleMusicPanelVisibility();
    }
  });

  window.bailongmaMedia = { handle: handleMediaCommand, showVideo, controlVideo, showImage, showCamera, showMusic, controlMusic };
  window.addEventListener("bailongma:media", (event) => handleMediaCommand(event.detail || {}));

  // Push-to-talk：按住空格说话；Agent 正在说话时按下空格直接打断
  (() => {
    let pttHeld = false;
    const isSpace = (e) => e.code === "Space" || e.key === " " || e.key === "Spacebar";
    const isTypingTarget = (t) =>
      !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);

    window.addEventListener("keydown", (e) => {
      if (!isSpace(e)) return;
      if (isTypingTarget(e.target)) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      e.preventDefault();
      if (e.repeat) return;
      if (pttHeld) return;
      pttHeld = true;
      // 不论是否在播，stopTTS 内部已做 no-op 守卫
      try { window.stopTTS?.(); } catch {}
      window.bailongmaVoice?.pttStart?.();
    }, { capture: true });

    window.addEventListener("keyup", (e) => {
      if (!isSpace(e)) return;
      if (!pttHeld) return;
      pttHeld = false;
      e.preventDefault();
      window.bailongmaVoice?.pttEnd?.();
    }, { capture: true });

    // 切到后台时如果还按着，强制释放，避免 mic 永远不关
    window.addEventListener("blur", () => {
      if (!pttHeld) return;
      pttHeld = false;
      window.bailongmaVoice?.pttEnd?.();
    });
  })();

  videoBtn?.addEventListener("click", toggleVideoPanelVisibility);
  videoExitBtn?.addEventListener("click", closeAndDestroyVideo);
  imageExitBtn?.addEventListener("click", () => setImageModeActive(false));

  window.addEventListener("keydown", (e) => {
    if (e.target?.tagName === "INPUT" || e.target?.tagName === "TEXTAREA" || e.target?.isContentEditable) return;

    const isWikiShortcutKey = e.code === "KeyW" || e.key === "W" || e.key === "w";
    if (
      (e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && isWikiShortcutKey) ||
      (e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey && isWikiShortcutKey)
    ) {
      e.preventDefault();
      setHotspotMode(false, { source: "keyboard" });
      toggleWikiPanel();
      return;
    }

    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "v" || e.key === "V") {
      e.preventDefault();
      toggleVideoPanelVisibility();
    }
    // H key: toggle hotspot mode
    if (e.key === "h" || e.key === "H") {
      e.preventDefault();
      toggleHotspot();
    }
  });
})();
