import { renderBrainUiApp } from "./app-shell.js";
import { API } from "./api-client.js";
import { bootstrapScene } from "../scene-shell/bootstrap.js";
import { initChat, friendlyChannelLabel } from "./chat.js";
import { initPanelCollapse } from "./panel-collapse.js";
import { ThoughtStream } from "./thought-stream.js";
import { initVoicePanel } from "./voice-panel.js";
import { initHotspot, toggleHotspot, setHotspotMode, moveVoicePanelToBody, restoreVoicePanel } from "./hotspot.js";
import { initWorldcup, toggleWorldcup, setWorldcupMode } from "./worldcup.js";
import { initTyphoon, toggleTyphoon, setTyphoonMode } from "./typhoon.js";
import { enrichVisiblePersonCardFromText, initPersonCard, setPersonCardMode, showPersonCardByName } from "./person-card.js";
import { initDocPanel, setDocPanelMode } from "./doc.js";
import { initWechatPopup, showWechatPopup } from "./wechat-popup.js";
import { initFeishuPopup, showFeishuPopup } from "./feishu-popup.js";
import { attachJarvisAudioGraph, attachJarvisFx, isFxEnabledForVoice, setFxEnabledForVoice, getJarvisFxParams, setJarvisFxParams, resetJarvisFxParams, isFxUnlocked, tryUnlockFx } from "./tts-fx.js";
import { initAudioOutputRouting, applyOutputSink, listOutputDevices, getOutputPreference, setOutputPreference } from "./audio-output.js";
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
// 由 initSettings() 内部赋值，供 chat.js 的斜杠命令打开设置面板
let openSettingsRef = null;

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
  if (input && !chat?.isComposerLocked?.() && document.activeElement === input) input.placeholder = defaultInputPlaceholder();
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
    .alphaMin(0.02) // 肉眼已静止后别再空烧 GPU（默认 0.001 要多跑约 2 秒）
    .velocityDecay(0.3)
    .on("tick", tick)
    .on("end", writeGraphDom)
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

function naturalTwitch(big = Math.random() < 0.3) {
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

  // 小抽动（常态）只动少数节点低热度；大波（偶发）才整片涌动
  const ratio = big ? 0.3 : 0.1;
  const twitchCount = Math.max(big ? 6 : 3, Math.floor(nodeData.length * ratio));
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

  sim.alpha(big ? 0.6 : 0.35).restart();
}

let tickParity = 0;
function tick() {
  if (!MEMORY_GRAPH_ENABLED) return;
  dampTangentialMotion();
  // 非拖拽时 DOM 写入降到 30fps：力计算照跑，重绘减半；拖拽（alphaTarget>0）保持满帧
  tickParity ^= 1;
  if (tickParity && sim.alphaTarget() === 0) return;
  writeGraphDom();
}

function writeGraphDom() {
  if (!MEMORY_GRAPH_ENABLED || !linkSel || !nodeSel) return;

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
  // 随机 5–9 秒一次抽动，比固定节拍更像活物；窗口不可见时休眠省 GPU
  const scheduleTwitch = () => {
    setTimeout(() => {
      if (!document.hidden) naturalTwitch();
      scheduleTwitch();
    }, 5000 + Math.random() * 4000);
  };
  scheduleTwitch();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) naturalTwitch(true); // 回到前台来一发大波当欢迎
  });
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

// 记忆系统观测（Memory-Optimization v0.1 Phase 0）：每 60s 拉一次近 1 小时的 audit stats。
// 显示"N 次（平均 K 条）"——次数代表系统活跃度，平均条数代表召回/抽取的健康度。
// 0 命中数会让数字变橙提醒（命中率低 = 可能有召回漏）；纯网络/服务失败保持 — 不告警。
const memRecallEl = document.getElementById("mem-recall-rate");
const memExtractEl = document.getElementById("mem-extract-rate");

// ── AI 当前正在做什么：派生展示 ────────────────────────────────
// 北极星（[[feedback-ai-be-itself]]）：通信问题靠界面侧派生可视化解决，不逼 AI 学人开口。
// 工作方式：纯被动接收 tool_call 事件流，按工具名归类统计最近 60s 活动，自动推导当前活动标签。
// AI 完全不需要为此多做任何动作；它只管干活，UI 自己把"在干什么"翻译给用户看。
const AI_ACTIVITY_WINDOW_MS = 60_000;
const AI_ACTIVITY_IDLE_AFTER_MS = 15_000;
const AI_TOOL_GROUPS = {
  "扫描文件": new Set(["read_file", "list_dir"]),
  "改动文件": new Set(["write_file", "make_dir", "delete_file"]),
  "执行命令": new Set(["exec_command", "exec_quick_command", "exec_task_command", "exec_background_command", "download_file", "kill_process", "list_processes"]),
  "上网": new Set(["fetch_url", "web_search", "browser_read"]),
  "调取记忆": new Set(["search_memory", "recall_memory", "probe_memory", "upsert_memory", "merge_memories", "downgrade_memory"]),
  "推送界面": new Set(["ui_set", "focus_banner"]),
  "处理多媒体": new Set(["speak", "generate_lyrics", "generate_music", "generate_image", "music", "media_mode"]),
  "回复用户": new Set(["send_message", "express"]),
};
const aiActivityLog = [];
let aiActivityFirstTs = 0;
let aiActivityTimer = null;
const aiActivityEl = document.getElementById("ai-activity");
const aiActivityLabelEl = document.getElementById("ai-activity-label");
const aiActivityDetailEl = document.getElementById("ai-activity-detail");

function classifyTool(name) {
  for (const [label, set] of Object.entries(AI_TOOL_GROUPS)) {
    if (set.has(name)) return label;
  }
  return "处理事务";
}

function recordAiActivity(name) {
  if (!name) return;
  const now = Date.now();
  if (aiActivityLog.length === 0) aiActivityFirstTs = now;
  aiActivityLog.push({ name, ts: now, group: classifyTool(name) });
  refreshAiActivity();
}

function refreshAiActivity() {
  if (!aiActivityEl) return;
  const now = Date.now();
  while (aiActivityLog.length && now - aiActivityLog[0].ts > AI_ACTIVITY_WINDOW_MS) {
    aiActivityLog.shift();
  }
  if (aiActivityLog.length === 0) {
    aiActivityEl.dataset.state = "idle";
    aiActivityLabelEl.textContent = "空闲";
    aiActivityDetailEl.textContent = "";
    aiActivityFirstTs = 0;
    return;
  }
  const lastTs = aiActivityLog[aiActivityLog.length - 1].ts;
  if (now - lastTs > AI_ACTIVITY_IDLE_AFTER_MS) {
    aiActivityEl.dataset.state = "idle";
    aiActivityLabelEl.textContent = "刚完成";
    const ago = Math.round((now - lastTs) / 1000);
    aiActivityDetailEl.textContent = `${ago}s 前停止`;
    return;
  }
  const counts = {};
  for (const e of aiActivityLog) counts[e.group] = (counts[e.group] || 0) + 1;
  let domGroup = "处理事务";
  let domCount = 0;
  for (const [g, c] of Object.entries(counts)) {
    if (c > domCount) { domCount = c; domGroup = g; }
  }
  aiActivityEl.dataset.state = "busy";
  aiActivityLabelEl.textContent = `正在${domGroup}`;
  const elapsed = Math.round((now - (aiActivityFirstTs || lastTs)) / 1000);
  aiActivityDetailEl.textContent = `· ${aiActivityLog.length} 次工具 · ${elapsed}s`;
}

if (aiActivityEl) {
  aiActivityEl.dataset.state = "idle";
  aiActivityTimer = setInterval(refreshAiActivity, 1000);
}

async function refreshMemoryAuditStats() {
  if (!memRecallEl || !memExtractEl) return;
  try {
    const res = await fetch("/audit/stats?hours=1", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    const r = data?.recall || {};
    const e = data?.extract || {};
    const rTotal = Number(r.total || 0);
    const rAvg = Number(r.avg_chosen || 0);
    const rZero = Number(r.zero_match_count || 0);
    const eTotal = Number(e.total || 0);
    const eAvg = Number(e.avg_extracted || 0);
    const eSkip = Number(e.skipped_count || 0);
    memRecallEl.textContent = rTotal ? `${rTotal}·${rAvg.toFixed(1)}` : "0";
    memExtractEl.textContent = eTotal ? `${eTotal}·${eAvg.toFixed(1)}` : "0";
    memRecallEl.style.color = (rTotal > 0 && rZero / rTotal > 0.2) ? "var(--warn, #e8a23a)" : "";
    memExtractEl.style.color = (eTotal > 0 && eSkip / eTotal > 0.5) ? "var(--warn, #e8a23a)" : "";
  } catch {
    // 静默：dev/build 早期 audit 表可能还没数据，保持 — 即可
  }
}
refreshMemoryAuditStats();
setInterval(refreshMemoryAuditStats, 60_000);

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
      // 兜底：上一轮若被打断、message/response 均未到达，实时气泡会成孤儿、流式会话可能还挂着麦克风
      // ——定稿气泡、收尾流式会话（恢复麦克风）、复位状态，再开新一轮。
      if (sttsActive) endStreamingTTS();
      if (chat.hasLiveJarvisMsg()) chat.finalizeLiveJarvisMsg(null);
      liveReplyActive = false;
      liveRawText = "";
      liveTurnSpeak = false;
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
      // 正文流（plainReply）：把 token 实时打进聊天气泡。一轮可能有多段正文（正文→工具→正文），
      // 只在尚未开始时建气泡，后续段累积进同一个。speak 轮（语音）额外开启逐句流式合成。
      if (data.mode === "text" && data.plainReply) {
        if (data.speak) liveTurnSpeak = true;
        if (!liveReplyActive) {
          liveReplyActive = true;
          liveRawText = "";
          chat.beginLiveJarvisMsg({ alert: true });
          if (liveTurnSpeak && isTTSStreamingEnabled()) beginStreamingTTS();
        }
      }
      break;
    case "stream_chunk":
      // 思考流：只驱动 token 速率指示器，不进聊天（保持 dashboard 纯净）
      currentStream().clearStatus();
      bumpTokens(data.text);
      // 正文流：累积 + 实时重渲染气泡（剥离协议标记 / 藏半截标记）；语音轮喂给逐句合成队列
      if (data.mode === "text" && liveReplyActive) {
        liveRawText += data.text;
        chat.updateLiveJarvisMsg(cleanStreamText(liveRawText));
        if (sttsActive) feedStreamingTTS(liveRawText);
      }
      break;
    case "stream_end":
      currentStream().stopThinking();
      // 正文段结束：把残句先送去合成，降低尾句延迟（不结束会话，可能还有后续正文段）
      if (data.mode === "text" && sttsActive) flushStreamingTTSBuf();
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
      stream.setTimedStatus(`正在执行 ${label}…`, "busy", {
        staleAfterMs: 45000,
        staleText: `执行 ${label} 时间偏长，仍在等结果…`,
      });
      break;
    }
    case "tool_call":
      currentStream().tool(data.name, data.args, data.result, data.ok);
      recordAiActivity(data.name);
      break;
    case "response":
      // Round complete — stop all animations
      currentStream().end();
      // 兜底：本轮结束时（response 必在 message 之后发）若流式合成会话仍开着——极少见，模型只调了工具
      // 没产出可投递正文、message 未到达——标记正文已尽让队列放完即恢复麦克风，避免麦克风一直挂起。
      // 正常情况 message 已 finalize 过，此处幂等无副作用，不会打断仍在播放的尾句。
      if (sttsActive) finalizeStreamingTTS();
      if (chat.hasLiveJarvisMsg()) chat.finalizeLiveJarvisMsg(null);
      liveReplyActive = false; liveRawText = ""; liveTurnSpeak = false;
      break;
    case "processing_preempted":
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
      } else {
        currentStream().stopThinking();
        currentStream().setStatus(data.error || "处理失败", "failed");
      }
      break;
    case "protocol_violation":
      currentStream().end();
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
        const shouldSpeakMessage = data.speak === true;
        const viaLabel = friendlyChannelLabel(data.channel);
        const content = viaLabel ? `_→ ${viaLabel}_  \n${data.content}` : data.content;
        const messageId = data.conversation_id || data.conversationId || "";
        // 若本轮正文已流式进了实时气泡：用权威全文定稿同一个气泡，避免新建重复气泡
        if (chat.hasLiveJarvisMsg()) {
          chat.finalizeLiveJarvisMsg(content, { messageId });
        } else {
          addMsg("jarvis", content, { messageId });
        }
        // 语音轮的 TTS 收尾：逐句会话进行中 → flush 尾句并收尾；若未走逐句（流式合成关闭）→ 整段播一次
        if (liveTurnSpeak) {
          if (sttsActive) finalizeStreamingTTS();
          else playTTSReply(toPlainSpeech(data.content));
        } else if (shouldSpeakMessage) {
          playTTSReplyIfReadable(data.content);
        }
        liveReplyActive = false;
        liveRawText = "";
        liveTurnSpeak = false;
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
        addMsg("external", data.content, { label, alert: false, messageId: data.conversation_id || data.conversationId || "" });
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
    case "aivideo_mode":
      window.dispatchEvent(new CustomEvent("bailongma:aivideo", { detail: data }));
      break;
    case "hotspot_mode":
      setHotspotMode(!!data.active || data.action === "show" || data.action === "open", { source: "agent_event" });
      break;
    case "worldcup_mode":
      setWorldcupMode(!!data.active || data.action === "show" || data.action === "open", { source: "agent_event" });
      break;
    case "typhoon_mode":
      setTyphoonMode(!!data.active || data.action === "show" || data.action === "open", { source: "agent_event" });
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
    case "show_feishu_popup":
      showFeishuPopup();
      break;
    case "audio_created":
      if (data.autoPlay && data.path) {
        const audioUrl = `${API}/${data.path}`;
        const audioEl = new Audio(audioUrl);
        applyOutputSink(audioEl).catch(() => {}); // 与 TTS 同路由，避开虚拟/已拔出设备
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
    default:
      break;
  }
}

// ── TTS reply playback ────────────────────────────────────────────────────────
let ttsAudioEl = null;
let ttsCurrentText = '';
let activeTTSVoiceId = null; // 后端当前配置的 TTS 音色，用于决定播放时是否叠加机器人音效
let ttsInterruptedRemaining = '';
let lastJarvisContent = '';
let ttsInterruptedOriginalContent = '';
let ttsInterruptionApplied = false;
let ttsInterruptionDbTimer = null;
let ttsStreamReader = null; // 当前流式合成的网络读取器；打断/重播时取消，避免旧流继续占用
let ttsAudioGraph = null;   // 当前 TTS <audio> 的 Web Audio 图，用于音效和语音球可视化

// ── 边出文字边逐句流式合成（streaming sentence TTS）─────────────────────────────
// 正文 token 边到边按句末标点切句入队，一个顺序播放队列逐句 /tts/stream 播放——第一句在
// 后面还在生成时就出声。麦克风的挂起/恢复由队列在首段/末段统一各做一次（不可每段反复，
// 否则 ttsStartTime/bargein 缓冲会被反复重置）。
let ttsStreamingMode = false; // 本轮 TTS 走逐句队列（true）还是单段整段（false）；stopTTS 据此分支
let sttsActive = false;       // 逐句会话进行中
let sttsConsumed = 0;         // liveRawText 已喂入切句器的「干净文本」长度
let sttsBuf = '';             // 尚未凑成整句的残句缓冲
let sttsQueue = [];           // 已切出、待合成播放的句子
let sttsPlaying = false;      // 当前有一段正在 fetch / 播放
let sttsSpoken = '';          // 已完整播放过的句子拼接（打断时算"已说到哪"）
let sttsCurSeg = '';          // 当前正在播放的句子文本
let sttsStreamDone = false;   // 正文已全部到达（message 定稿），队列放完即收尾
let sttsMicSuspended = false; // 已对麦克风做过一次 suspendForTTS

const STTS_SENTENCE_RE = /[^。！？!?\n]*[。！？!?\n]+/g;
function sttsHasReadable(s) { return /[\p{L}\p{N}]/u.test(s); }

// 本轮流式回复状态：是否正在把正文打进实时气泡 / 累积的原始正文 / 本轮是否语音播报
let liveReplyActive = false;
let liveRawText = '';
let liveTurnSpeak = false;

// 流式语音合成：边下边播，首包到达即出声（后端 /tts/stream 本就分块返回，
// 这里用 MediaSource 消费，省去"等整段下载完再播"的延迟）。默认开启，可在设置关闭。
const TTS_STREAMING_KEY = 'bailongma.tts.streaming';
function isTTSStreamingEnabled() {
  try { return localStorage.getItem(TTS_STREAMING_KEY) !== '0'; } catch { return true; } // 默认开启
}
function setTTSStreamingEnabled(on) {
  try { localStorage.setItem(TTS_STREAMING_KEY, on ? '1' : '0'); } catch {}
}
// 仅当开启 + 浏览器支持 MSE 流式 MP3 时才走流式，否则退回整段 blob 播放（绝不让声音变哑）
function ttsCanStream() {
  if (!isTTSStreamingEnabled()) return false;
  if (typeof window.MediaSource === 'undefined') return false;
  try { return MediaSource.isTypeSupported('audio/mpeg'); } catch { return false; }
}

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
  if (ttsStreamingMode && sttsActive) { stopStreamingTTS(); return; }
  if (!ttsAudioEl) return;
  const { remaining, spokenUpTo } = calcRemainingText(
    ttsCurrentText,
    ttsAudioEl.currentTime,
    ttsAudioEl.duration,
  );
  // When duration is not yet loaded (NaN): spokenUpTo=0, remaining='', falls back to full text
  ttsInterruptedRemaining = remaining || ttsCurrentText;
  applyTTSInterruption(spokenUpTo);
  clearTTSAudioGraph();
  ttsAudioEl.pause();
  try { URL.revokeObjectURL(ttsAudioEl.src); } catch {}
  if (ttsStreamReader) { try { ttsStreamReader.cancel(); } catch {} ttsStreamReader = null; }
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

function activateTTSAudioGraph(graph) {
  if (ttsAudioGraph && ttsAudioGraph !== graph) {
    try { ttsAudioGraph.teardown?.(); } catch {}
  }
  ttsAudioGraph = graph || null;
  window.bailongmaVoice?.setTTSAnalyser?.(ttsAudioGraph?.analyser || null);
}

function clearTTSAudioGraph(graph) {
  if (arguments.length > 0) {
    if (!graph) return;
    if (graph !== ttsAudioGraph) {
      try { graph.teardown?.(); } catch {}
      return;
    }
  }
  if (ttsAudioGraph) {
    try { ttsAudioGraph.teardown?.(); } catch {}
    ttsAudioGraph = null;
  }
  window.bailongmaVoice?.setTTSAnalyser?.(null);
}

// 接管一个 <audio> 元素开始播放：叠加音色音效、挂起 ASR、注册结束/出错清理。
// revokeUrl 为该元素 src 的 objectURL（播放结束/出错时回收）。多条播放路径共用。
// opts.manageMic：是否由本函数挂起/恢复麦克风（单段播放=true；逐句队列由队列在首尾统一管，传 false）。
// opts.onComplete：播放正常/出错收尾时的回调（队列用它推进下一段）；不传则走默认收尾（恢复麦克风）。
function startTTSAudio(audioEl, revokeUrl, opts = {}) {
  const { manageMic = true, onComplete = null } = opts;
  ttsAudioEl = audioEl;
  audioEl.volume = 1.0; // ensure full volume (avoid residual duck state from previous play)
  const audioGraph = attachJarvisAudioGraph(audioEl, activeTTSVoiceId);
  activateTTSAudioGraph(audioGraph);
  // Suspend cloud ASR but keep the mic hardware open for interruption detection
  if (manageMic) window.bailongmaVoice?.suspendForTTS?.();
  // 结束/出错收尾。注意：被新一轮播放替换掉的旧元素，其 onerror 可能在 pause/revoke 后迟到触发；
  // 此时全局已指向新元素，必须用 ttsAudioEl===audioEl 守卫，否则会误杀新播放的流读取器和状态。
  const finish = () => {
    clearTTSAudioGraph(audioGraph);
    if (revokeUrl) { try { URL.revokeObjectURL(revokeUrl); } catch {} } // 释放本元素 URL（无论是否当前）
    if (ttsAudioEl !== audioEl) return; // 已不是当前播放对象：仅回收 URL，不动全局
    if (ttsStreamReader) { try { ttsStreamReader.cancel(); } catch {} ttsStreamReader = null; }
    ttsAudioEl = null;
    if (onComplete) { onComplete(); return; } // 队列段：交回队列推进，麦克风/收尾由队列统一管
    ttsCurrentText = '';
    if (manageMic) window.bailongmaVoice?.resumeAfterMedia();
  };
  audioEl.onended = finish;
  audioEl.onerror = finish;
  // 把这段语音显式路由到真实输出设备（规避被系统默认占用的虚拟/已拔出声卡）。
  // setSinkId 是异步的，但对流式 TTS，首个音频样本要等网络首包到达才流出，
  // 这点路由耗时（毫秒级）远在出声之前完成 → 不必 await，也不会让首音漏到默认设备。
  applyOutputSink(audioEl).catch(() => {});
  audioEl.play().catch(() => {
    clearTTSAudioGraph(audioGraph);
    if (ttsAudioEl !== audioEl) return;
    if (onComplete) { ttsAudioEl = null; onComplete(); return; }
    if (manageMic) window.bailongmaVoice?.resumeAfterMedia();
  });
}

// 流式播放：把 /tts/stream 的分块响应喂进 MediaSource，首包到达即出声。
function playTTSViaMediaSource(resp, opts = {}) {
  const mediaSource = new MediaSource();
  const url = URL.createObjectURL(mediaSource);
  const audioEl = new Audio(url);
  const isCurrentAudio = () => ttsAudioEl === audioEl;
  startTTSAudio(audioEl, url, opts); // play() 会在缓冲到首包后自动开始
  mediaSource.addEventListener('sourceopen', () => {
    if (!isCurrentAudio()) { try { mediaSource.endOfStream(); } catch {} return; }
    let sb;
    try { sb = mediaSource.addSourceBuffer('audio/mpeg'); }
    catch { try { mediaSource.endOfStream(); } catch {} return; }
    const reader = resp.body.getReader();
    if (!isCurrentAudio()) { try { reader.cancel(); } catch {} return; }
    ttsStreamReader = reader;
    const queue = [];
    let finished = false;
    // appendBuffer 是异步的，更新中不能再次 append；用队列在 updateend 时串行送入
    const flush = () => {
      if (sb.updating) return;
      if (queue.length) { try { sb.appendBuffer(queue.shift()); } catch {} return; }
      if (finished && mediaSource.readyState === 'open') { try { mediaSource.endOfStream(); } catch {} }
    };
    sb.addEventListener('updateend', flush);
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (!isCurrentAudio()) {
            if (ttsStreamReader === reader) ttsStreamReader = null;
            try { reader.cancel(); } catch {}
            break;
          }
          if (done) {
            if (ttsStreamReader === reader) ttsStreamReader = null;
            finished = true; flush(); break;
          }
          if (value && value.byteLength) { queue.push(value); flush(); }
        }
      } catch {
        if (ttsStreamReader === reader) ttsStreamReader = null;
        finished = true; flush();
      } // 被取消/网络中断：收尾，已播部分照常结束
    })();
  }, { once: true });
}

async function playTTSReply(text) {
  ttsStreamingMode = false; // 单段整段播放：stopTTS 走原有进度估算分支
  ttsCurrentText = text;
  ttsInterruptedRemaining = '';
  ttsInterruptionApplied = false;
  ttsInterruptedOriginalContent = '';
  // 取消上一段仍在进行的流式读取，避免旧网络流继续占用
  if (ttsStreamReader) { try { ttsStreamReader.cancel(); } catch {} ttsStreamReader = null; }
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
    if (ttsAudioEl) { clearTTSAudioGraph(); ttsAudioEl.pause(); try { URL.revokeObjectURL(ttsAudioEl.src); } catch {} }
    // 默认流式：边下边播；不支持 MSE / 已关闭流式 → 退回整段 blob 播放
    if (ttsCanStream() && resp.body) {
      playTTSViaMediaSource(resp);
    } else {
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      startTTSAudio(new Audio(url), url);
    }
  } catch {
    clearTTSAudioGraph();
    ttsCurrentText = '';
    window.bailongmaVoice?.resumeAfterMedia();
  }
}

// ── 流式回复文本工具 ───────────────────────────────────────────────────────────
// 协议标记（[RECALL:…]/[SET_TASK:…]/[CLEAR_TASK]/[UPDATE_PERSONA:…]）剥离。与后端 markers.js 等价；
// 流式场景额外把"末尾尚未闭合的标记起始"整段藏起，避免半截标记被显示或念出来（等 ] 到了再放出）。
const MARKER_STRIP_RE = /\[(?:RECALL:[\s\S]*?|SET_TASK:[\s\S]*?|CLEAR_TASK|UPDATE_PERSONA:[\s\S]*?)\]/g;
function cleanStreamText(raw) {
  let s = String(raw || '').replace(MARKER_STRIP_RE, '');
  const lastOpen = s.lastIndexOf('[');
  if (lastOpen >= 0 && s.indexOf(']', lastOpen) === -1) {
    // 仅当 '[' 后看起来是协议标记关键字（全大写/下划线，可带 ":..."）才藏；不误伤 [链接](url) 等普通括号
    if (/^\[[A-Z_]*(:[\s\S]*)?$/.test(s.slice(lastOpen))) s = s.slice(0, lastOpen);
  }
  return s;
}

// markdown → 朗读用纯文本（与后端 autoSpeakForVoiceReply 的剥离一致）
function toPlainSpeech(md) {
  return String(md || '').trim()
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/#{1,6}\s+/g, '')
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
    .replace(/!\[[^\]]*\]\([^\)]+\)/g, '')
    .replace(/\n+/g, ' ')
    .trim();
}

function playTTSReplyIfReadable(text) {
  const plain = toPlainSpeech(text);
  if (plain && sttsHasReadable(plain)) playTTSReply(plain);
}

// ── 逐句流式 TTS 队列 ──────────────────────────────────────────────────────────
function beginStreamingTTS() {
  // 停掉上一段仍在进行的单段播放 / 流读取
  if (ttsStreamReader) { try { ttsStreamReader.cancel(); } catch {} ttsStreamReader = null; }
  if (ttsAudioEl) { clearTTSAudioGraph(); try { ttsAudioEl.pause(); URL.revokeObjectURL(ttsAudioEl.src); } catch {} ttsAudioEl = null; }
  ttsStreamingMode = true;
  sttsActive = true;
  sttsConsumed = 0; sttsBuf = ''; sttsQueue = []; sttsPlaying = false;
  sttsSpoken = ''; sttsCurSeg = ''; sttsStreamDone = false; sttsMicSuspended = false;
  ttsCurrentText = '';
}

// 喂入到目前为止的全部原始正文，内部只取新增的干净尾巴做切句
function feedStreamingTTS(rawFull) {
  if (!sttsActive) return;
  const cleaned = cleanStreamText(rawFull);
  if (cleaned.length <= sttsConsumed) return;
  sttsBuf += cleaned.slice(sttsConsumed);
  sttsConsumed = cleaned.length;
  extractSttsSentences({});
}

function extractSttsSentences({ flushPartial = false, markDone = false } = {}) {
  let lastIdx = 0, m;
  STTS_SENTENCE_RE.lastIndex = 0;
  while ((m = STTS_SENTENCE_RE.exec(sttsBuf)) !== null) {
    const s = m[0].trim();
    lastIdx = STTS_SENTENCE_RE.lastIndex;
    if (s && sttsHasReadable(s)) sttsQueue.push(s);
  }
  sttsBuf = sttsBuf.slice(lastIdx);
  if (flushPartial) {
    const tail = sttsBuf.trim();
    sttsBuf = '';
    if (tail && sttsHasReadable(tail)) sttsQueue.push(tail);
  }
  if (markDone) sttsStreamDone = true;
  pumpSttsQueue();
}

async function pumpSttsQueue() {
  if (!sttsActive || sttsPlaying) return;
  const seg = sttsQueue.shift();
  if (!seg) {
    if (sttsStreamDone) endStreamingTTS(); // 正文已尽且队列放完 → 收尾
    return;
  }
  sttsPlaying = true;
  sttsCurSeg = seg;
  // 麦克风只在首段挂起一次（后续段之间保持挂起，避免反复重置 bargein 缓冲/预热计时）
  if (!sttsMicSuspended) { sttsMicSuspended = true; window.bailongmaVoice?.suspendForTTS?.(); }
  const onComplete = () => {
    sttsSpoken += seg;
    sttsCurSeg = '';
    sttsPlaying = false;
    pumpSttsQueue();
  };
  try {
    const resp = await fetch(`${API}/tts/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: seg }),
    });
    if (!sttsActive) return; // 期间被打断/收尾
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    if (ttsCanStream() && resp.body) {
      playTTSViaMediaSource(resp, { manageMic: false, onComplete });
    } else {
      const blob = await resp.blob();
      if (!sttsActive) return;
      const url = URL.createObjectURL(blob);
      startTTSAudio(new Audio(url), url, { manageMic: false, onComplete });
    }
  } catch {
    onComplete(); // 本句合成失败：跳过，继续下一句，绝不卡住队列
  }
}

// 正文段落结束（stream_end text）：把残句也凑成一段送出，但不结束会话（可能还有后续正文段）
function flushStreamingTTSBuf() {
  if (sttsActive) extractSttsSentences({ flushPartial: true });
}

// message 定稿：flush 残句并标记正文已尽，队列放完即收尾
function finalizeStreamingTTS() {
  if (sttsActive) extractSttsSentences({ flushPartial: true, markDone: true });
}

function endStreamingTTS() {
  sttsActive = false;
  ttsStreamingMode = false;
  clearTTSAudioGraph();
  if (sttsMicSuspended) { sttsMicSuspended = false; window.bailongmaVoice?.resumeAfterMedia(); }
  sttsQueue = []; sttsBuf = ''; sttsCurSeg = ''; sttsSpoken = ''; sttsPlaying = false;
}

// 打断（barge-in）：停当前句、清队列，算出"已说到哪"标 ✋，并把剩余文本留给 resumeTTSIfNoSpeech 续播。
// 麦克风的恢复由 voice-panel 在调用 stopTTS 后自己 resumeVoiceInputFromMedia(true) 负责（与单段路径一致），
// 这里只置 sttsMicSuspended=false 防止重复恢复。
function stopStreamingTTS() {
  let curSpoken = '', curRemain = '';
  if (ttsAudioEl && sttsCurSeg) {
    const r = calcRemainingText(sttsCurSeg, ttsAudioEl.currentTime, ttsAudioEl.duration);
    curSpoken = sttsCurSeg.slice(0, r.spokenUpTo);
    curRemain = r.remaining || sttsCurSeg; // duration 未加载(NaN) → 整句视为未说
  }
  const spokenPlain = sttsSpoken + curSpoken;
  const remainingPlain = [curRemain, sttsQueue.join(''), sttsBuf].filter(Boolean).join('').trim();
  const fullPlain = (spokenPlain + remainingPlain) || (lastJarvisContent || '');
  ttsCurrentText = fullPlain;                       // 让 ✋/续播的文本计算有一致的全文基准
  ttsInterruptedRemaining = remainingPlain || fullPlain;
  applyTTSInterruption(spokenPlain.length);
  if (ttsAudioEl) { clearTTSAudioGraph(); try { ttsAudioEl.pause(); URL.revokeObjectURL(ttsAudioEl.src); } catch {} }
  if (ttsStreamReader) { try { ttsStreamReader.cancel(); } catch {} ttsStreamReader = null; }
  ttsAudioEl = null;
  sttsActive = false; ttsStreamingMode = false;
  sttsQueue = []; sttsBuf = ''; sttsCurSeg = ''; sttsSpoken = ''; sttsPlaying = false;
  sttsMicSuspended = false; // 麦克风恢复交给 voice-panel 的 resumeVoiceInputFromMedia(true)
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

const PERSON_CARD_NON_PERSON_SUBJECT_RE = /(?:项目|功能|系统|工具|代码|文件|文档|文章|报告|方案|计划|任务|流程|架构|设计|页面|网站|应用|app|接口|api|正则|问题|bug|卡片|面板|按钮|图片|视频|音乐|游戏|天气|热点|热搜)/i;
const PERSON_CARD_GENERIC_SUBJECT_RE = /^(?:这个人|那个人|这人|那人|这位|那位|某个人|某位|有人|谁|哪位|什么人|人物|人物卡|人物卡片)$/;

function cleanPersonCardCandidate(value = "") {
  return String(value || "")
    .trim()
    .replace(/^["'“”‘’「」『』《》]+|["'“”‘’「」『』《》]+$/g, "")
    .replace(/[，,。.!！：:；;、]+$/g, "")
    .replace(/\s*(?:是谁|是誰|是什么人|是什麼人|是个什么人|是個什麼人|是干嘛的|是幹嘛的)$/g, "")
    .replace(/(?:的)?(?:生平|资料|資料|背景|简介|簡介|履历|履歷|故事|百科|个人资料|個人資料)$/g, "")
    .trim();
}

function looksLikePersonCardName(value = "") {
  const name = cleanPersonCardCandidate(value);
  if (!name || name.length > 32) return false;
  if (PERSON_CARD_NON_PERSON_SUBJECT_RE.test(name)) return false;
  if (PERSON_CARD_GENERIC_SUBJECT_RE.test(name)) return false;
  if (/[?？]/.test(name)) return false;
  if (/(?:帮我|给我|请|麻烦|写|做|生成|打开|关闭|修|改|看下|看看|一下)/.test(name)) return false;

  const compact = name.replace(/\s+/g, "");
  if (/^[\u4e00-\u9fa5·]{2,8}$/.test(compact)) return true;

  const latinName = name.replace(/[·]/g, " ").replace(/\s+/g, " ").trim();
  const latinTokens = latinName.split(" ").filter(Boolean);
  if (latinTokens.length >= 2 && latinTokens.length <= 4) {
    return latinTokens.every(token => /^[A-Za-z][A-Za-z.'-]{1,24}$/.test(token));
  }
  return false;
}

function extractPersonCardQuery(text = "") {
  const value = String(text || "").trim();
  if (!value || /热点|热搜/.test(value)) return "";

  const patterns = [
    /^谁是\s*(.+?)[？?]?$/,
    /^(.+?)\s*(?:是谁|是誰|是什么人|是什麼人|是干嘛的|简介|介绍|资料|履历)[？?]?$/,
    /^(?:介绍一下|介绍下|查一下|了解一下|认识一下)\s*(.+?)[？?]?$/,
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    const name = cleanPersonCardCandidate(match?.[1]);
    if (looksLikePersonCardName(name)) return name;
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
  openSettings: (tab) => openSettingsRef?.(tab),
  onUserMessage: (text) => {
    if (document.body.classList.contains('hotspot-mode') && /关闭|退出|关掉|隐藏/.test(text)) {
      toggleHotspot();
      return;
    }
    if (document.body.classList.contains('worldcup-mode') && /关闭|退出|关掉|隐藏/.test(text)) {
      toggleWorldcup();
      return;
    }
    if (document.body.classList.contains('typhoon-mode') && /关闭|退出|关掉|隐藏/.test(text)) {
      toggleTyphoon();
      return;
    }
    if (document.body.classList.contains('person-card-mode') && /关闭|退出|关掉|隐藏/.test(text)) {
      setPersonCardMode(false, { source: 'chat_input' });
      return;
    }
    if (/热点|热搜/.test(text) && !document.body.classList.contains('hotspot-mode')) {
      toggleHotspot();
    }
    if (/世界杯/.test(text) && !document.body.classList.contains('worldcup-mode')) {
      toggleWorldcup();
    }
    if (/台风|热带气旋/.test(text) && !document.body.classList.contains('typhoon-mode')) {
      toggleTyphoon();
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

bootstrapScene();  // Scene 架构 shell(/scene):声明式 Agent-UI 投影层。
initPanelCollapse();
initWechatPopup();
initFeishuPopup();

// ── TTS settings panel init ───────────────────────────────────────────────────
function initTTSSettings() {
  const providerSel = document.getElementById("tts-provider-select");
  const voiceSel    = document.getElementById("tts-voice-select");
  const testBtn     = document.getElementById("tts-test-btn");
  const testStatus  = document.getElementById("tts-test-status");
  const fxToggle    = document.getElementById("tts-fx-toggle");
  const doubaoKeyInput = document.getElementById("tts-doubao-key");
  const doubaoKeyToggle = document.getElementById("tts-doubao-key-toggle");
  if (!providerSel) return;

  let doubaoKeyVisible = false;
  function setDoubaoKeyVisible(visible) {
    doubaoKeyVisible = Boolean(visible);
    if (doubaoKeyInput) doubaoKeyInput.type = doubaoKeyVisible ? "text" : "password";
    if (doubaoKeyToggle) {
      doubaoKeyToggle.setAttribute("aria-label", doubaoKeyVisible ? "隐藏 API Key" : "显示 API Key");
      doubaoKeyToggle.title = doubaoKeyVisible ? "隐藏 API Key" : "显示 API Key";
    }
  }
  doubaoKeyToggle?.addEventListener("click", () => setDoubaoKeyVisible(!doubaoKeyVisible));

  // 流式合成开关（默认开）：纯播放行为，存在 localStorage
  const streamingToggle = document.getElementById("tts-streaming-toggle");
  if (streamingToggle) {
    streamingToggle.checked = isTTSStreamingEnabled();
    streamingToggle.addEventListener("change", () => setTTSStreamingEnabled(streamingToggle.checked));
  }

  let allVoices = {};

  // ── 机器人音效：开关 + 滑块面板 ──
  const fxSlidersBox = document.getElementById("tts-fx-sliders");
  // 滑块对应的参数键，及数值显示精度
  const FX_SLIDERS = [
    { key: "wet",              digits: 2 },
    { key: "reverbSeconds",    digits: 1 },
    { key: "driveMix",         digits: 2 },
    { key: "metallic",         digits: 2 },
    { key: "ring",             digits: 2 },
    { key: "chorus",           digits: 2 },
    { key: "metallicFeedback", digits: 2 },
    { key: "metallicDelayMs",  digits: 1 },
    { key: "ringHz",           digits: 0 },
  ];

  function loadFxSliders() {
    const p = getJarvisFxParams();
    for (const s of FX_SLIDERS) {
      const el = document.getElementById(`tts-fx-${s.key}`);
      const val = document.getElementById(`tts-fx-${s.key}-val`);
      const v = Number(p[s.key] ?? 0);
      if (el) el.value = v;
      if (val) val.textContent = v.toFixed(s.digits);
    }
  }

  for (const s of FX_SLIDERS) {
    const el = document.getElementById(`tts-fx-${s.key}`);
    const val = document.getElementById(`tts-fx-${s.key}-val`);
    if (!el) continue;
    el.addEventListener("input", () => {
      const v = parseFloat(el.value);
      setJarvisFxParams({ [s.key]: v });
      if (val) val.textContent = v.toFixed(s.digits);
    });
  }

  const fxReset = document.getElementById("tts-fx-reset");
  if (fxReset) {
    fxReset.addEventListener("click", () => { resetJarvisFxParams(); loadFxSliders(); });
  }

  // 语速滑块（豆包 speech_rate，-50~100，0=正常）：显示更新；存档走保存/试听
  const fmtRate = (r) => (r === 0 ? "正常" : (r > 0 ? "+" + r : String(r)));
  const doubaoRateEl = document.getElementById("tts-doubao-rate");
  const doubaoRateVal = document.getElementById("tts-doubao-rate-val");
  if (doubaoRateEl) {
    doubaoRateEl.addEventListener("input", () => {
      if (doubaoRateVal) doubaoRateVal.textContent = fmtRate(parseInt(doubaoRateEl.value, 10) || 0);
    });
  }

  // 付费解锁
  const fxLockBox = document.getElementById("tts-fx-lock");
  const fxPwInput = document.getElementById("tts-fx-pw");
  const fxUnlockBtn = document.getElementById("tts-fx-unlock");
  const fxUnlockMsg = document.getElementById("tts-fx-unlock-msg");

  // 机器人音效开关跟随当前选中的音色；未解锁则禁用开关+显示付费提示；解锁且开启时展开滑块
  function syncFxToggle() {
    const unlocked = isFxUnlocked();
    const on = unlocked && isFxEnabledForVoice(voiceSel?.value);
    if (fxToggle) { fxToggle.checked = on; fxToggle.disabled = !unlocked; }
    if (fxSlidersBox) fxSlidersBox.style.display = on ? "flex" : "none";
    if (fxLockBox) fxLockBox.style.display = unlocked ? "none" : "flex";
  }
  if (fxToggle) {
    fxToggle.addEventListener("change", () => {
      if (!isFxUnlocked()) { fxToggle.checked = false; syncFxToggle(); return; }
      setFxEnabledForVoice(voiceSel?.value, fxToggle.checked);
      if (fxSlidersBox) fxSlidersBox.style.display = fxToggle.checked ? "flex" : "none";
    });
  }
  if (fxUnlockBtn) {
    fxUnlockBtn.addEventListener("click", () => {
      const res = tryUnlockFx(fxPwInput?.value?.trim() || "");
      if (fxUnlockMsg) {
        fxUnlockMsg.textContent = res.ok ? "已解锁 ✓ 现在可以开启机器人音效了" : res.reason;
        fxUnlockMsg.style.color = res.ok ? "#3ba55d" : "#e05050";
      }
      if (res.ok) syncFxToggle();
    });
  }
  if (voiceSel) {
    voiceSel.addEventListener("change", syncFxToggle);
  }
  loadFxSliders();
  syncFxToggle();

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
    syncFxToggle();
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
    activeTTSVoiceId = voiceSel?.value || tts?.ttsVoiceId || null;
    const appidEl = document.getElementById("tts-volcano-appid");
    if (appidEl && tts?.volcanoAppId?.value) appidEl.value = tts.volcanoAppId.value;
    if (doubaoKeyInput) doubaoKeyInput.value = typeof tts?.doubaoKey?.value === "string" ? tts.doubaoKey.value : "";
    const doubaoResourceEl = document.getElementById("tts-doubao-resource");
    if (doubaoResourceEl && tts?.doubaoResourceId) doubaoResourceEl.value = tts.doubaoResourceId;
    const rateEl = document.getElementById("tts-doubao-rate");
    if (rateEl) {
      const r = Number(tts?.doubaoSpeechRate || 0) || 0;
      rateEl.value = r;
      const rv = document.getElementById("tts-doubao-rate-val");
      if (rv) rv.textContent = r === 0 ? "正常" : (r > 0 ? "+" + r : String(r));
    }
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
      if (voiceId) { ttsBody.ttsVoiceId = voiceId; activeTTSVoiceId = voiceId; }
      const minimaxKey = document.getElementById("tts-minimax-key")?.value?.trim();
      if (minimaxKey) ttsBody.minimaxKey = minimaxKey;
      const doubaoKey = document.getElementById("tts-doubao-key")?.value?.trim();
      if (doubaoKey) ttsBody.doubaoKey = doubaoKey;
      const doubaoResource = document.getElementById("tts-doubao-resource")?.value?.trim();
      if (doubaoResource) ttsBody.doubaoResourceId = doubaoResource;
      const rateEl2 = document.getElementById("tts-doubao-rate");
      if (rateEl2) ttsBody.doubaoSpeechRate = rateEl2.value;
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
        ["tts-minimax-key", "tts-openai-key", "tts-elevenlabs-key", "tts-volcano-token"].forEach(id => {
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
        if (currentVoice) { preBody.ttsVoiceId = currentVoice; activeTTSVoiceId = currentVoice; }
        const minimaxKey2 = document.getElementById("tts-minimax-key")?.value?.trim();
        if (minimaxKey2) preBody.minimaxKey = minimaxKey2;
        const doubaoKey = document.getElementById("tts-doubao-key")?.value?.trim();
        if (doubaoKey) preBody.doubaoKey = doubaoKey;
        const doubaoResource = document.getElementById("tts-doubao-resource")?.value?.trim();
        if (doubaoResource) preBody.doubaoResourceId = doubaoResource;
        const rateEl3 = document.getElementById("tts-doubao-rate");
        if (rateEl3) preBody.doubaoSpeechRate = rateEl3.value;
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
        attachJarvisFx(ttsAudio, voiceSel?.value || activeTTSVoiceId); // 试听按当前选中音色的开关决定是否叠加
        ttsAudio.onended = () => { URL.revokeObjectURL(ttsUrl); if (testStatus) testStatus.textContent = ""; };
        ttsAudio.onerror = () => { URL.revokeObjectURL(ttsUrl); if (testStatus) testStatus.textContent = "播放失败"; };
        await applyOutputSink(ttsAudio).catch(() => {}); // 试听也走同一输出路由
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
  const officialCustomModelInput = document.getElementById("settings-official-custom-model");
  const llmKeyInput     = document.getElementById("settings-llm-key");
  const llmKeyToggle    = document.getElementById("settings-llm-key-toggle");
  const saveLlmBtn      = document.getElementById("settings-save-llm");
  const llmFeedback     = document.getElementById("settings-llm-feedback");
  const agentNameInput  = document.getElementById("settings-agent-name");
  const saveAgentNameBtn = document.getElementById("settings-save-agent-name");
  const agentNameFeedback = document.getElementById("settings-agent-name-feedback");
  const tempSlider      = document.getElementById("settings-temperature");
  const tempVal         = document.getElementById("settings-temperature-val");
  const saveTempBtn     = document.getElementById("settings-save-temperature");
  const tempFeedback    = document.getElementById("settings-temperature-feedback");
  const thinkingToggle  = document.getElementById("settings-thinking");
  const thinkingFeedback = document.getElementById("settings-thinking-feedback");
  const minimaxKeyInput = document.getElementById("settings-minimax-key");
  const saveMinimaxBtn  = document.getElementById("settings-save-minimax");
  const minimaxFeedback = document.getElementById("settings-minimax-feedback");
  const saveSocialBtn   = document.getElementById("settings-save-social");
  const socialFeedback  = document.getElementById("settings-social-feedback");
  const saveVoiceBtn    = document.getElementById("settings-save-voice");
  const voiceFeedback   = document.getElementById("settings-voice-feedback");
  const voiceThreshSlider = document.getElementById("settings-voice-threshold");
  const voiceThreshVal    = document.getElementById("settings-voice-threshold-val");
  const voiceMicSelect    = document.getElementById("voice-mic-select");
  const voiceRefreshMicsBtn = document.getElementById("voice-refresh-mics");
  const voiceMicStatus    = document.getElementById("voice-mic-status");
  const voiceOutputSelect    = document.getElementById("voice-output-select");
  const voiceRefreshOutputsBtn = document.getElementById("voice-refresh-outputs");
  const voiceOutputStatus    = document.getElementById("voice-output-status");
  const volcAsrKeyInput      = document.getElementById("voice-volc-apikey");
  const volcAsrKeyToggle     = document.getElementById("voice-volc-apikey-toggle");
  const mapKeyInput          = document.getElementById("settings-amap-key");
  const mapSecurityInput     = document.getElementById("settings-amap-security");
  const saveMapBtn           = document.getElementById("settings-save-map");
  const clearMapBtn          = document.getElementById("settings-clear-map");
  const mapFeedback          = document.getElementById("settings-map-feedback");
  const heartbeatToggle      = document.getElementById("settings-heartbeat-enabled");
  const heartbeatInterval    = document.getElementById("settings-heartbeat-interval");
  const saveHeartbeatBtn     = document.getElementById("settings-save-heartbeat");
  const heartbeatFeedback    = document.getElementById("settings-heartbeat-feedback");

  if (!settingsBtn || !overlay) return;

  let cachedProviders = null;
  let cachedLlm = null;
  let llmKeyVisible = false;
  let volcAsrKeyVisible = false;
  let volcAsrSaveTimer = null;
  let volcAsrSaveRequest = 0;
  const agentNameRe = /^[一-龥A-Za-z0-9 _-]+$/;
  const CUSTOM_MODEL_VALUE = "__custom_model__";

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
      if (tab === "advanced") {
        loadHeartbeatSettings();
        loadMapSettings();
      }
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

  function escapeHtml(text) {
    return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function syncOfficialCustomModelRow() {
    const customRow = document.getElementById("settings-official-custom-model-row");
    if (!customRow || !modelSelect) return;
    customRow.style.display = modelSelect.value === CUSTOM_MODEL_VALUE ? "" : "none";
  }

  function populateModelSelect(models, current) {
    if (!modelSelect || !models) return;
    const list = Array.isArray(models) ? models.filter(m => m?.id) : [];
    const currentModel = String(current || "").trim();
    const hasCurrent = currentModel && list.some(m => m.id === currentModel);
    modelSelect.innerHTML = list
      .map(m => `<option value="${escapeHtml(m.id)}"${m.deprecated ? " data-deprecated" : ""}>${escapeHtml(m.label || m.id)}</option>`)
      .concat(`<option value="${CUSTOM_MODEL_VALUE}">手动输入模型名…</option>`)
      .join("");
    if (hasCurrent) {
      modelSelect.value = currentModel;
      if (officialCustomModelInput) officialCustomModelInput.value = "";
    } else if (currentModel) {
      modelSelect.value = CUSTOM_MODEL_VALUE;
      if (officialCustomModelInput) officialCustomModelInput.value = currentModel;
    }
    syncOfficialCustomModelRow();
  }

  function populateProviderSelect(providers, current) {
    if (!providerSelect || !providers) return;
    const selected = current || providerSelect.value || "auto";
    const options = [`<option value="auto">Auto-detect</option>`]
      .concat(Object.entries(providers).map(([id, provider]) => {
        const label = provider.label || id;
        return `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`;
      }));
    providerSelect.innerHTML = options.join("");
    providerSelect.value = providers[selected] || selected === "auto" ? selected : "auto";
  }

  function setLlmKeyVisible(visible) {
    llmKeyVisible = Boolean(visible);
    if (llmKeyInput) llmKeyInput.type = llmKeyVisible ? "text" : "password";
    if (llmKeyToggle) {
      llmKeyToggle.setAttribute("aria-label", llmKeyVisible ? "隐藏 API Key" : "显示 API Key");
      llmKeyToggle.title = llmKeyVisible ? "隐藏 API Key" : "显示 API Key";
    }
  }

  function getProviderConfigForUI(provider, llm = cachedLlm) {
    const summary = cachedProviders?.[provider] || {};
    if (llm && provider === llm.provider) {
      return {
        ...summary,
        ...llm,
        apiKey: llm.apiKey ?? summary.apiKey ?? "",
      };
    }
    return summary;
  }

  function applyCustomProviderUI(providerOrLlm) {
    const provider = typeof providerOrLlm === "string"
      ? providerOrLlm
      : (providerOrLlm?.provider || "auto");
    const providerCfg = getProviderConfigForUI(provider, typeof providerOrLlm === "object" ? providerOrLlm : cachedLlm);
    const customSection = document.getElementById("settings-custom-llm-section");
    const modelRow = document.getElementById("settings-model-row");
    const officialCustomModelRow = document.getElementById("settings-official-custom-model-row");
    if (provider === "auto") {
      if (customSection) customSection.style.display = "none";
      if (modelRow) modelRow.style.display = "none";
      if (officialCustomModelRow) officialCustomModelRow.style.display = "none";
      if (llmKeyInput) llmKeyInput.value = "";
      setLlmKeyVisible(false);
      return;
    }
    if (provider === "custom") {
      if (customSection) customSection.style.display = "";
      if (modelRow) modelRow.style.display = "none";
      if (officialCustomModelRow) officialCustomModelRow.style.display = "none";
      const baseUrlEl = document.getElementById("settings-custom-baseurl");
      const modelEl = document.getElementById("settings-custom-model");
      if (baseUrlEl) baseUrlEl.value = providerCfg.baseURL || "";
      if (modelEl) modelEl.value = providerCfg.model || "";
    } else {
      if (customSection) customSection.style.display = "none";
      if (modelRow) modelRow.style.display = "";
      if (cachedProviders?.[provider]) {
        populateModelSelect(
          cachedProviders[provider].models,
          providerCfg.model || cachedProviders[provider].defaultModel,
        );
      }
    }
    if (llmKeyInput) llmKeyInput.value = providerCfg.apiKey || "";
    setLlmKeyVisible(false);
  }

  async function loadSettings() {
    try {
      const data = await fetch(`${API}/settings`).then(r => r.json());
      const { llm, minimax, providers } = data;
      if (providers) cachedProviders = providers;
      cachedLlm = llm;
      if (agentNameInput) agentNameInput.value = data.agent_name || agentName || DEFAULT_AGENT_NAME;
      refreshConfigSummary({ llm, minimax });
      populateProviderSelect(providers, llm.provider || "auto");
      if (providerSelect && llm.provider) providerSelect.value = llm.provider;
      applyCustomProviderUI(llm);
      if (typeof llm.temperature === "number" && tempSlider) {
        tempSlider.value = String(llm.temperature);
        if (tempVal) tempVal.textContent = llm.temperature.toFixed(2);
      }
      if (thinkingToggle) thinkingToggle.checked = llm.thinking === true;
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
  const lanAccessToggle   = document.getElementById("security-lan-access");
  const saveSecurityBtn   = document.getElementById("settings-save-security");
  const restartSecurityBtn = document.getElementById("settings-restart-security");
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
      setStatus("websearch-status-brave",   !!webSearch?.braveConfigured,  !!webSearch?.braveFromEnv);
      setStatus("websearch-status-tavily",  !!webSearch?.tavilyConfigured, !!webSearch?.tavilyFromEnv);
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
      const braveEl   = document.getElementById("websearch-brave-key");
      const tavilyEl  = document.getElementById("websearch-tavily-key");
      const jinaEl    = document.getElementById("websearch-jina-key");
      const searxngEl = document.getElementById("websearch-searxng-url");
      const serperVal  = serperEl?.value?.trim();
      const braveVal   = braveEl?.value?.trim();
      const tavilyVal  = tavilyEl?.value?.trim();
      const jinaVal    = jinaEl?.value?.trim();
      const searxngVal = searxngEl?.value?.trim();
      if (serperVal)  updates.serperKey  = serperVal;
      if (braveVal)   updates.braveKey   = braveVal;
      if (tavilyVal)  updates.tavilyKey  = tavilyVal;
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
          if (braveEl)  braveEl.value = "";
          if (tavilyEl) tavilyEl.value = "";
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
      const { security, network } = await fetch(`${API}/settings/security`).then(r => r.json());
      if (fileSandboxToggle) fileSandboxToggle.checked = security.fileSandbox !== false;
      if (execSandboxToggle) execSandboxToggle.checked = security.execSandbox !== false;
      if (lanAccessToggle) lanAccessToggle.checked = network?.allowLanAccess === true;
      restartSecurityBtn?.classList.add("hidden");
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
        allowLanAccess: lanAccessToggle ? lanAccessToggle.checked : false,
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
          if (data.network?.restartRequired) {
            showFeedback(securityFeedback, "已保存 — 重启后生效");
            restartSecurityBtn?.classList.remove("hidden");
          } else {
            showFeedback(securityFeedback, "已保存 — 立即生效");
          }
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

  if (restartSecurityBtn) {
    restartSecurityBtn.addEventListener("click", async () => {
      restartSecurityBtn.disabled = true;
      try {
        await fetch(`${API}/admin/restart`, { method: "POST" });
        showFeedback(securityFeedback, "正在重启…");
      } catch {
        showFeedback(securityFeedback, "重启请求失败，请手动重启应用", true);
        restartSecurityBtn.disabled = false;
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

  if (thinkingToggle) {
    thinkingToggle.addEventListener("change", async () => {
      const thinking = thinkingToggle.checked;
      thinkingToggle.disabled = true;
      try {
        const res = await fetch(`${API}/settings/thinking`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ thinking }),
        });
        const data = await res.json();
        if (data.ok) {
          showFeedback(thinkingFeedback, data.thinking ? "已开启 — 下一轮生效" : "已关闭 — 下一轮生效");
        } else {
          thinkingToggle.checked = !thinking;
          showFeedback(thinkingFeedback, data.error || "保存失败", true);
        }
      } catch {
        thinkingToggle.checked = !thinking;
        showFeedback(thinkingFeedback, "请求失败", true);
      } finally { thinkingToggle.disabled = false; }
    });
  }

  const VOICE_LANG_KEY       = "bailongma-voice-lang";
  const VOICE_AUTO_SEND_KEY  = "bailongma-voice-auto-send";
  const VOICE_AUTO_MIC_KEY   = "bailongma-voice-auto-mic";
  const VOICE_THRESHOLD_KEY  = "bailongma-voice-threshold";
  const VOICE_PROVIDER_KEY   = "bailongma-voice-provider";
  const VOICE_MIC_DEVICE_KEY = "bailongma-voice-mic-device-id";

  function applyVoiceProviderUI(provider) {
    const panels = {
      aliyun: "voice-cred-aliyun",
      volcengine: "voice-cred-volcengine",
      tencent: "voice-cred-tencent",
      xunfei: "voice-cred-xunfei",
      local: null,
    };
    for (const [key, id] of Object.entries(panels)) {
      if (!id) continue;
      const el = document.getElementById(id);
      if (el) el.style.display = key === provider ? "" : "none";
    }
  }

  function detectVoiceProviderFromKey(key) {
    const value = (key || "").trim();
    if (!value) return null;
    if (/^sk-[A-Za-z0-9_\-.]{20,}$/.test(value)) {
      return { provider: "aliyun", label: "阿里云 ASR", fieldId: "voice-aliyun-key" };
    }
    if (/^AKID/i.test(value)) {
      return { provider: "tencent", label: "腾讯云 ASR", fieldId: "voice-tencent-sid" };
    }
    if (/^\d{6,10}$/.test(value)) {
      return { provider: "xunfei", label: "科大讯飞", fieldId: "voice-xunfei-appid" };
    }
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      return {
        provider: "volcengine",
        label: "火山豆包 ASR",
        fieldId: "voice-volc-apikey",
      };
    }
    return null;
  }

  function setVoiceMicStatus(message, isError = false) {
    if (!voiceMicStatus) return;
    voiceMicStatus.textContent = message;
    voiceMicStatus.style.color = isError ? "var(--warm)" : "var(--dim)";
  }

  async function loadMicrophoneDevices({ requestPermission = false } = {}) {
    if (!voiceMicSelect) return;
    if (!navigator.mediaDevices?.enumerateDevices) {
      voiceMicSelect.disabled = true;
      setVoiceMicStatus("当前环境不支持麦克风设备枚举，将使用系统默认麦克风。", true);
      return;
    }

    const savedDeviceId = localStorage.getItem(VOICE_MIC_DEVICE_KEY) || "";
    const preferredDeviceId = voiceMicSelect.value || savedDeviceId;
    let permissionError = null;

    voiceMicSelect.disabled = true;
    if (voiceRefreshMicsBtn) voiceRefreshMicsBtn.disabled = true;

    try {
      if (requestPermission && navigator.mediaDevices.getUserMedia) {
        try {
          const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          permissionStream.getTracks().forEach(track => track.stop());
        } catch (err) {
          permissionError = err;
        }
      }

      const devices = (await navigator.mediaDevices.enumerateDevices())
        .filter(device => device.kind === "audioinput");

      voiceMicSelect.innerHTML = "";
      const defaultOption = document.createElement("option");
      defaultOption.value = "";
      defaultOption.textContent = "系统默认麦克风";
      voiceMicSelect.appendChild(defaultOption);

      devices.forEach((device, index) => {
        const option = document.createElement("option");
        option.value = device.deviceId;
        option.textContent = device.label || `麦克风 ${index + 1}`;
        voiceMicSelect.appendChild(option);
      });

      const selectedStillExists = !preferredDeviceId || devices.some(device => device.deviceId === preferredDeviceId);
      voiceMicSelect.value = selectedStillExists ? preferredDeviceId : "";
      if (!selectedStillExists && savedDeviceId) localStorage.removeItem(VOICE_MIC_DEVICE_KEY);

      const hasLabels = devices.some(device => device.label);
      if (permissionError) {
        setVoiceMicStatus("未获得麦克风权限，仍可使用系统默认麦克风；点刷新可重新授权。", true);
      } else if (!devices.length) {
        setVoiceMicStatus("未检测到独立麦克风，将使用系统默认麦克风。");
      } else if (!hasLabels) {
        setVoiceMicStatus(`已检测到 ${devices.length} 个麦克风；点刷新并授权后可显示完整名称。`);
      } else {
        setVoiceMicStatus(`已检测到 ${devices.length} 个麦克风。更换后重新开启语音对话生效。`);
      }
    } catch {
      setVoiceMicStatus("麦克风列表读取失败，将使用系统默认麦克风。", true);
    } finally {
      voiceMicSelect.disabled = false;
      if (voiceRefreshMicsBtn) voiceRefreshMicsBtn.disabled = false;
    }
  }

  function setVoiceOutputStatus(message, isError = false) {
    if (!voiceOutputStatus) return;
    voiceOutputStatus.textContent = message;
    voiceOutputStatus.style.color = isError ? "var(--warm)" : "var(--dim)";
  }

  // 填充"语音输出设备"下拉。结构对齐麦克风选择器：第一项=自动，其余=具体设备；
  // 虚拟/串流设备打标提示用户它们不会真正出声。
  async function loadOutputDevices({ requestPermission = false } = {}) {
    if (!voiceOutputSelect) return;
    if (!('setSinkId' in HTMLMediaElement.prototype)) {
      voiceOutputSelect.disabled = true;
      setVoiceOutputStatus("当前环境不支持指定输出设备，将使用系统默认。", true);
      return;
    }
    const savedDeviceId = getOutputPreference();
    const preferred = voiceOutputSelect.value || savedDeviceId;
    voiceOutputSelect.disabled = true;
    if (voiceRefreshOutputsBtn) voiceRefreshOutputsBtn.disabled = true;
    try {
      // label/deviceId 需要媒体权限；点"刷新"时主动请求一次，平时静默枚举
      if (requestPermission && navigator.mediaDevices?.getUserMedia) {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ audio: true });
          s.getTracks().forEach(t => t.stop());
        } catch {}
      }
      const outs = await listOutputDevices();
      // 只列真实可选设备（隐藏 default/communications 别名，避免和"自动"重复）
      const selectable = outs.filter(d => !d.isDefault && d.label);
      voiceOutputSelect.innerHTML = "";
      const autoOpt = document.createElement("option");
      autoOpt.value = "";
      autoOpt.textContent = "自动（跟随系统，避开虚拟设备）";
      voiceOutputSelect.appendChild(autoOpt);
      selectable.forEach((d, i) => {
        const opt = document.createElement("option");
        opt.value = d.deviceId;
        opt.textContent = (d.label || `输出设备 ${i + 1}`) + (d.isVirtual ? "（虚拟，可能没声音）" : "");
        voiceOutputSelect.appendChild(opt);
      });
      const stillExists = !preferred || selectable.some(d => d.deviceId === preferred);
      voiceOutputSelect.value = stillExists ? preferred : "";
      if (!stillExists && savedDeviceId) setOutputPreference(""); // 钉的设备没了 → 回到自动

      const hasLabels = selectable.some(d => d.label);
      if (!selectable.length) {
        setVoiceOutputStatus("未检测到独立扬声器/耳机，点刷新并授权后可显示。");
      } else if (!hasLabels) {
        setVoiceOutputStatus("点刷新并授权后可显示设备完整名称。");
      } else {
        setVoiceOutputStatus("语音从这里发声。默认自动；拔耳机会自动切回扬声器，不被虚拟声卡占用。");
      }
    } catch {
      setVoiceOutputStatus("输出设备列表读取失败，将使用系统默认。", true);
    } finally {
      voiceOutputSelect.disabled = false;
      if (voiceRefreshOutputsBtn) voiceRefreshOutputsBtn.disabled = false;
    }
  }

  voiceRefreshOutputsBtn?.addEventListener("click", () => loadOutputDevices({ requestPermission: true }));
  // 选择即时生效（无需点保存）：写偏好 → 模块自动把在播语音切过去并复评横幅
  voiceOutputSelect?.addEventListener("change", () => {
    setOutputPreference(voiceOutputSelect.value || "");
    setVoiceOutputStatus(voiceOutputSelect.value ? "已切换，立即生效。" : "已设为自动，立即生效。");
  });

  const voiceProviderSelect = document.getElementById("voice-provider-select");
  if (voiceProviderSelect) {
    voiceProviderSelect.addEventListener("change", () => applyVoiceProviderUI(voiceProviderSelect.value));
  }

  const voiceAutoKey = document.getElementById("voice-auto-key");
  const voiceAutoDetect = document.getElementById("voice-auto-detect");
  if (voiceAutoKey) {
    voiceAutoKey.addEventListener("input", () => {
      const detected = detectVoiceProviderFromKey(voiceAutoKey.value);
      if (!detected) {
        if (voiceAutoDetect) voiceAutoDetect.textContent = voiceAutoKey.value.trim() ? "未识别" : "";
        return;
      }
      if (voiceProviderSelect) voiceProviderSelect.value = detected.provider;
      applyVoiceProviderUI(detected.provider);
      const target = document.getElementById(detected.fieldId);
      if (target) target.value = voiceAutoKey.value.trim();
      for (const [id, value] of Object.entries(detected.defaults || {})) {
        const el = document.getElementById(id);
        if (el && !el.value.trim()) el.value = value;
      }
      if (voiceAutoDetect) voiceAutoDetect.textContent = detected.label;
    });
  }

  async function loadMapSettings() {
    const status = document.getElementById("settings-map-status");
    const dot = document.getElementById("settings-map-status-dot");
    try {
      const data = await fetch(`${API}/settings/map`).then(r => r.json());
      const map = data?.map || {};
      if (status) {
        status.textContent = map.configured
          ? "高德地图 · 已配置"
          : `高德地图 · Key ${map.keyConfigured ? "已配置" : "未配置"} / 安全密钥 ${map.securityConfigured ? "已配置" : "未配置"}`;
      }
      if (dot) {
        dot.textContent = "●";
        dot.className = `settings-config-dot ${map.configured ? "active" : "inactive"}`;
      }
    } catch {
      if (status) status.textContent = "读取配置失败";
      if (dot) dot.className = "settings-config-dot inactive";
    }
  }

  function syncHeartbeatControls() {
    if (heartbeatInterval) {
      heartbeatInterval.setAttribute(
        "aria-label",
        heartbeatToggle?.checked === false ? "重新启用心跳后使用的默认间隔（分钟）" : "默认心跳间隔（分钟）",
      );
    }
  }

  async function loadHeartbeatSettings() {
    try {
      const response = await fetch(`${API}/settings/heartbeat`);
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "读取失败");
      const heartbeat = data.heartbeat || {};
      if (heartbeatToggle) heartbeatToggle.checked = heartbeat.enabled !== false;
      if (heartbeatInterval) heartbeatInterval.value = String(heartbeat.defaultIntervalMinutes || 20);
      syncHeartbeatControls();
    } catch (err) {
      showFeedback(heartbeatFeedback, err.message || "读取心跳设置失败", true);
    }
  }

  heartbeatToggle?.addEventListener("change", syncHeartbeatControls);

  saveHeartbeatBtn?.addEventListener("click", async () => {
    const defaultIntervalMinutes = Number(heartbeatInterval?.value);
    if (!Number.isInteger(defaultIntervalMinutes) || defaultIntervalMinutes < 1 || defaultIntervalMinutes > 1440) {
      showFeedback(heartbeatFeedback, "请输入 1–1440 之间的整数分钟", true);
      return;
    }
    saveHeartbeatBtn.disabled = true;
    try {
      const response = await fetch(`${API}/settings/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: heartbeatToggle?.checked !== false,
          defaultIntervalMinutes,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "保存失败");
      showFeedback(heartbeatFeedback, data.heartbeat?.enabled ? "心跳设置已生效" : "心跳已关闭");
      syncHeartbeatControls();
    } catch (err) {
      showFeedback(heartbeatFeedback, err.message || "保存失败", true);
    } finally {
      saveHeartbeatBtn.disabled = false;
    }
  });

  if (saveMapBtn) {
    saveMapBtn.addEventListener("click", async () => {
      const jsKey = mapKeyInput?.value?.trim() || "";
      const securityCode = mapSecurityInput?.value?.trim() || "";
      if (!jsKey && !securityCode) {
        showFeedback(mapFeedback, "请输入 Key 或安全密钥", true);
        return;
      }
      saveMapBtn.disabled = true;
      try {
        const response = await fetch(`${API}/settings/map`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsKey, securityCode }),
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || "保存失败");
        if (mapKeyInput) mapKeyInput.value = "";
        if (mapSecurityInput) mapSecurityInput.value = "";
        showFeedback(mapFeedback, data.map?.configured ? "地图服务已启用" : "已保存，请补全配置");
        loadMapSettings();
      } catch (err) {
        showFeedback(mapFeedback, err.message || "保存失败", true);
      } finally {
        saveMapBtn.disabled = false;
      }
    });
  }

  if (clearMapBtn) {
    clearMapBtn.addEventListener("click", async () => {
      clearMapBtn.disabled = true;
      try {
        const response = await fetch(`${API}/settings/map`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clear: true }),
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || "清除失败");
        if (mapKeyInput) mapKeyInput.value = "";
        if (mapSecurityInput) mapSecurityInput.value = "";
        showFeedback(mapFeedback, "地图配置已清除");
        loadMapSettings();
      } catch (err) {
        showFeedback(mapFeedback, err.message || "清除失败", true);
      } finally {
        clearMapBtn.disabled = false;
      }
    });
  }

  function setVolcAsrKeyVisible(visible) {
    volcAsrKeyVisible = Boolean(visible);
    if (volcAsrKeyInput) volcAsrKeyInput.type = volcAsrKeyVisible ? "text" : "password";
    if (volcAsrKeyToggle) {
      volcAsrKeyToggle.setAttribute("aria-label", volcAsrKeyVisible ? "隐藏 API Key" : "显示 API Key");
      volcAsrKeyToggle.title = volcAsrKeyVisible ? "隐藏 API Key" : "显示 API Key";
    }
  }

  async function saveVolcAsrKeyAutomatically() {
    if (!volcAsrKeyInput) return;
    const apiKey = volcAsrKeyInput.value.trim();
    const request = ++volcAsrSaveRequest;
    try {
      const resp = await fetch("http://127.0.0.1:3721/settings/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voiceProvider: "volcengine", volcAsrApiKey: apiKey }),
      });
      if (!resp.ok) throw new Error("保存失败");
      if (request !== volcAsrSaveRequest) return;
      volcAsrKeyInput.value = apiKey;
      localStorage.setItem(VOICE_PROVIDER_KEY, "volcengine");
      showFeedback(voiceFeedback, apiKey ? "已自动保存" : "已清除");
    } catch {
      if (request === volcAsrSaveRequest) showFeedback(voiceFeedback, "自动保存失败", true);
    }
  }

  volcAsrKeyToggle?.addEventListener("click", () => {
    setVolcAsrKeyVisible(!volcAsrKeyVisible);
  });

  volcAsrKeyInput?.addEventListener("input", () => {
    if (volcAsrSaveTimer) clearTimeout(volcAsrSaveTimer);
    volcAsrSaveTimer = setTimeout(() => {
      volcAsrSaveTimer = null;
      saveVolcAsrKeyAutomatically();
    }, 500);
  });

  voiceRefreshMicsBtn?.addEventListener("click", () => {
    loadMicrophoneDevices({ requestPermission: true });
  });

  voiceMicSelect?.addEventListener("change", () => {
    setVoiceMicStatus("保存后，重新开启语音对话生效。");
  });

  navigator.mediaDevices?.addEventListener?.("devicechange", () => {
    if (!overlay.hidden) { loadMicrophoneDevices(); loadOutputDevices(); }
  });

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
    await loadMicrophoneDevices();
    await loadOutputDevices();

    let savedProvider = localStorage.getItem(VOICE_PROVIDER_KEY) || "aliyun";
    try {
      const resp = await fetch("http://127.0.0.1:3721/settings/voice");
      const data = await resp.json().catch(() => ({}));
      if (resp.ok && data?.voice?.voiceProvider) {
        savedProvider = data.voice.voiceProvider;
        localStorage.setItem(VOICE_PROVIDER_KEY, savedProvider);
      }
      const savedVolcAsrKey = data?.voice?.volcAsrApiKey?.value;
      if (volcAsrKeyInput) volcAsrKeyInput.value = typeof savedVolcAsrKey === "string" ? savedVolcAsrKey : "";
    } catch {}
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
      const micDeviceId = voiceMicSelect?.value || "";

      localStorage.setItem(VOICE_LANG_KEY,      lang);
      localStorage.setItem(VOICE_AUTO_SEND_KEY,  String(autoSend));
      localStorage.setItem(VOICE_AUTO_MIC_KEY,   String(autoMic));
      localStorage.setItem(VOICE_THRESHOLD_KEY,  String(threshold));
      localStorage.setItem(VOICE_PROVIDER_KEY,   provider);
      if (micDeviceId) localStorage.setItem(VOICE_MIC_DEVICE_KEY, micDeviceId);
      else localStorage.removeItem(VOICE_MIC_DEVICE_KEY);

      window.dispatchEvent(new CustomEvent("bailongma:voice-threshold", { detail: { threshold } }));
      const micLabel = voiceMicSelect?.selectedOptions?.[0]?.textContent || "系统默认麦克风";
      setVoiceMicStatus(`当前麦克风：${micLabel}。重新开启语音对话生效。`);

      const body = { voiceProvider: provider };
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
      const volcApiKey = document.getElementById("voice-volc-apikey")?.value?.trim();
      if (volcApiKey) body.volcAsrApiKey = volcApiKey;

      if (Object.keys(body).length > 0) {
        try {
          saveVoiceBtn.disabled = true;
          const resp = await fetch("http://127.0.0.1:3721/settings/voice", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          if (!resp.ok) throw new Error("保存失败");
          [
            "voice-aliyun-key",
            "voice-auto-key",
            "voice-tencent-sid",
            "voice-tencent-skey",
            "voice-xunfei-apikey",
          ].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = "";
          });
          if (voiceAutoDetect) voiceAutoDetect.textContent = "";
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
      if (tab === "advanced") {
        loadHeartbeatSettings();
        loadMapSettings();
      }
      if (tab === "update") loadUpdateSettings();
    }
  }

  function closeSettings() {
    overlay.hidden = true;
    if (llmKeyInput) llmKeyInput.value = "";
    if (minimaxKeyInput) minimaxKeyInput.value = "";
  }

  // 暴露给 chat.js 的斜杠命令使用
  openSettingsRef = openSettings;

  settingsBtn.addEventListener("click", () => openSettings());
  closeBtn.addEventListener("click", closeSettings);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeSettings(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !overlay.hidden) closeSettings(); });

  if (providerSelect) {
    providerSelect.addEventListener("change", () => {
      applyCustomProviderUI(providerSelect.value);
    });
  }

  if (modelSelect) {
    modelSelect.addEventListener("change", syncOfficialCustomModelRow);
  }

  saveAgentNameBtn?.addEventListener("click", async () => {
    const nextName = agentNameInput?.value?.trim() || "";
    if (nextName.length > 32) {
      showFeedback(agentNameFeedback, "AI 名字不能超过 32 个字符", true);
      return;
    }
    if (nextName && !agentNameRe.test(nextName)) {
      showFeedback(agentNameFeedback, "AI 名字只允许中文、英文字母、数字、空格、下划线、短横线", true);
      return;
    }
    saveAgentNameBtn.disabled = true;
    try {
      const res = await fetch(`${API}/settings/agent-name`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentName: nextName }),
      });
      const data = await res.json();
      if (data.ok) {
        const savedName = data.agent_name || DEFAULT_AGENT_NAME;
        if (agentNameInput) agentNameInput.value = savedName;
        setAgentName(savedName);
        showFeedback(agentNameFeedback, "已保存");
      } else {
        showFeedback(agentNameFeedback, data.error || "保存失败", true);
      }
    } catch {
      showFeedback(agentNameFeedback, "请求失败", true);
    } finally {
      saveAgentNameBtn.disabled = false;
    }
  });

  llmKeyToggle?.addEventListener("click", () => {
    setLlmKeyVisible(!llmKeyVisible);
  });

  saveLlmBtn?.addEventListener("click", async () => {
    const provider = providerSelect?.value || "auto";
    const apiKey = llmKeyInput.value.trim();
    saveLlmBtn.disabled = true;
    try {
      const selectedCfg = cachedProviders?.[provider] || {};
      const body = { provider };
      if (provider === "custom") {
        body.baseURL = document.getElementById("settings-custom-baseurl")?.value?.trim();
        body.model = document.getElementById("settings-custom-model")?.value?.trim();
        if (!body.baseURL || !body.model) {
          showFeedback(llmFeedback, "请填入 Base URL 和模型名称", true);
          saveLlmBtn.disabled = false;
          return;
        }
        if (apiKey !== (selectedCfg.apiKey || "")) body.apiKey = apiKey || "none";
      } else if (provider === "auto") {
        if (!apiKey) {
          showFeedback(llmFeedback, "自动识别需要填入 API Key", true);
          saveLlmBtn.disabled = false;
          return;
        }
        body.apiKey = apiKey;
      } else {
        if (modelSelect.value === CUSTOM_MODEL_VALUE) {
          body.model = officialCustomModelInput?.value?.trim();
          if (!body.model) {
            showFeedback(llmFeedback, "请填入模型名称", true);
            saveLlmBtn.disabled = false;
            return;
          }
        } else {
          body.model = modelSelect.value;
        }
        if (apiKey && apiKey !== (selectedCfg.apiKey || "")) body.apiKey = apiKey;
      }

      const res = await fetch(`${API}/settings/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) {
        showFeedback(llmFeedback, "已保存");
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

// ── 语音输出设备路由 ──
// 监听设备插拔：拔耳机/虚拟设备占用系统默认时，把正在播的语音即时切到真实硬件；
// 完全无设备时弹一键修复横幅。getCurrentAudioEl 回传当前在播 TTS 元素。
initAudioOutputRouting({ getCurrentAudioEl: () => ttsAudioEl });

// ── Hotspot mode ──
initHotspot().catch((err) => console.warn('[Hotspot] init failed:', err));

// ── Worldcup mode ──
initWorldcup().catch((err) => console.warn('[Worldcup] init failed:', err));
initTyphoon();

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
    url = "", title = "Video", autoplay = true,
    muted = false, volume = null, currentTime = null, camera = false,
  } = {}) {
    if (camera) { showCamera({ title, autoplay }); return; }

    const source = normalizeUrl(url);
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

    // 切到后台/失焦（如点开 DevTools、切窗口）时如果还按着，强制释放 PTT，避免 mic 永远不关。
    // 关键：用 send:false —— 失焦不是"主动松手发送"，不能把没说完的半句误发出去。
    window.addEventListener("blur", () => {
      if (!pttHeld) return;
      pttHeld = false;
      window.bailongmaVoice?.pttEnd?.({ send: false });
    });
  })();

  videoBtn?.addEventListener("click", toggleVideoPanelVisibility);
  videoExitBtn?.addEventListener("click", closeAndDestroyVideo);
  imageExitBtn?.addEventListener("click", () => setImageModeActive(false));

  window.addEventListener("keydown", (e) => {
    if (e.target?.tagName === "INPUT" || e.target?.tagName === "TEXTAREA" || e.target?.isContentEditable) return;
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


// ── AI 视频生成模式（Seedance · 生成工作台）──
// 三段式：生成栏(多任务队列) + 播放区 + 输入区。全程由 aivideo_mode SSE 事件驱动。
(function initAIVideoMode(){
  var el = function(id){ return document.getElementById(id); };
  var panel = el("aivideo-panel");
  if (!panel) return;
  var queueEl=el("aivideo-queue"), stage=el("aivideo-stage"), stageEmpty=el("aivideo-stage-empty"),
      feed=el("aivideo-feed"), dlBtn=el("aivideo-dl"), playerMeta=el("aivideo-player-meta"),
      dropzone=el("aivideo-dropzone"), modeTag=el("aivideo-modetag"), modeHint=el("aivideo-modehint"),
      promptInput=el("aivideo-prompt-input"), ratioSel=el("aivideo-ratio"), resSel=el("aivideo-resolution"),
      durSel=el("aivideo-duration"), submitBtn=el("aivideo-submit"), composeErr=el("aivideo-compose-err"),
      fileInput=el("aivideo-file-input"), newBtn=el("aivideo-new-btn"), exitBtn=el("aivideo-exit-btn");

  var active=false, jobs=[], selId=null, images=[], submitting=false;

  var toastEl=document.createElement("div"); toastEl.className="aivideo-toast"; document.body.appendChild(toastEl);
  var toastTimer=null;
  function showToast(html){ toastEl.innerHTML=html; toastEl.classList.add("show"); clearTimeout(toastTimer); toastTimer=setTimeout(function(){ toastEl.classList.remove("show"); },3200); }

  function mediaUrl(u){ var s=String(u||""); if(!s) return ""; return s.charAt(0)==="/" ? (API+s) : s; }
  function modeLabel(m){ return m==="flf"?"首尾帧":(m==="image"?"图生视频":"文生视频"); }
  function jobById(id){ for(var i=0;i<jobs.length;i++){ if(jobs[i].id===id) return jobs[i]; } return null; }

  // —— 感知同步：把「面板开关 + 提示词草稿」实时回传后端，让 agent 能直接看到用户在框里写了什么 ——
  var draftTimer=null, lastDraftSent=null;
  function syncDraft(immediate){
    clearTimeout(draftTimer);
    var doSync=function(){
      var payload=JSON.stringify({ open:active, prompt:(promptInput.value||"") });
      if(payload===lastDraftSent) return;            // 没变化就不发，省流量
      lastDraftSent=payload;
      try{ fetch(API+"/aivideo/draft",{method:"POST",headers:{"Content-Type":"application/json"},body:payload}).catch(function(){}); }catch(e){}
    };
    if(immediate) doSync(); else draftTimer=setTimeout(doSync,400);
  }

  function setActive(on){
    active=!!on; document.body.classList.toggle("aivideo-mode", active);
    if(active){ try{ window.bailongmaMedia&&window.bailongmaMedia.controlVideo&&window.bailongmaMedia.controlVideo({action:"pause"}); }catch(e){} document.body.classList.remove("video-mode"); }
    syncDraft(true);   // 开/关状态立即同步
  }

  // —— 生成栏 ——
  function renderQueue(){
    queueEl.innerHTML="";
    if(!jobs.length){ var em=document.createElement("div"); em.className="aivideo-queue-empty"; em.textContent="还没有生成任务"; queueEl.appendChild(em); return; }
    jobs.forEach(function(j){
      var t=document.createElement("div");
      t.className="av-tile "+(j.status==="gen"?"gen":j.status==="fail"?"fail":"")+(j.id===selId?" sel":"");
      var fr=document.createElement("div"); fr.className="frame";
      if(j.status==="done"){
        var v=document.createElement("video"); v.className="thumb"; v.src=mediaUrl(j.videoUrl); v.muted=true; v.playsInline=true; v.preload="metadata"; fr.appendChild(v);
        var pl=document.createElement("div"); pl.className="play"; pl.textContent="▶"; fr.appendChild(pl);
        if(j.dur){ var d=document.createElement("div"); d.className="dur"; d.textContent=j.dur+"s"; fr.appendChild(d); }
      } else if(j.status==="gen"){
        var orb=document.createElement("div"); orb.className="av-orb"; orb.innerHTML="<i></i><i></i>"; fr.appendChild(orb);
        var gb=document.createElement("div"); gb.className="genbadge"; gb.textContent="生成中"; fr.appendChild(gb);
        var gt=document.createElement("div"); gt.className="gentime"; gt.dataset.start=String(j.start||Date.now()); gt.textContent="0:00"; fr.appendChild(gt);
      } else {
        var x=document.createElement("div"); x.className="x"; x.textContent="!"; fr.appendChild(x);
      }
      if(j.status!=="gen"){ var rm=document.createElement("button"); rm.className="rm"; rm.textContent="×"; rm.onclick=function(e){ e.stopPropagation(); removeJob(j.id); }; fr.appendChild(rm); }
      t.appendChild(fr);
      var lb=document.createElement("div"); lb.className="label";
      lb.textContent = j.status==="fail" ? ("失败 · "+(j.error||"")) : (j.prompt || modeLabel(j.mode));
      t.appendChild(lb);
      t.onclick=function(){ if(j.status==="done") loadPlayer(j); };
      queueEl.appendChild(t);
    });
  }
  function tickTimers(){ var now=Date.now(); var list=queueEl.querySelectorAll(".gentime"); for(var i=0;i<list.length;i++){ var s=Math.floor((now-Number(list[i].dataset.start))/1000); if(s<0)s=0; list[i].textContent=Math.floor(s/60)+":"+String(s%60).padStart(2,"0"); } }
  setInterval(tickTimers,500);
  function removeJob(id){ jobs=jobs.filter(function(j){ return j.id!==id; }); if(selId===id){ selId=null; clearPlayer(); } renderQueue(); }

  // —— 重建历史：从后端拉已完成视频（newest-first），合并进 jobs。 ——
  // 修复「面板关闭重开 / app 重启后队列空了」：jobs[] 原本纯内存，重载即丢，
  // 而视频其实还在磁盘。这里按 id 去重，不覆盖本会话进行中的瓦片。
  function hydrateHistory(){
    fetch(API+"/aivideo/history").then(function(r){ return r.json(); }).then(function(d){
      if(!d||!d.ok||!Array.isArray(d.jobs)) return;
      var changed=false;
      d.jobs.forEach(function(h){
        if(!h||!h.id) return;
        var ex=jobById(h.id);
        if(ex){
          if(ex.status!=="done"&&h.videoUrl){ ex.status="done"; ex.videoUrl=h.videoUrl; ex.mode=ex.mode||h.mode; ex.prompt=ex.prompt||h.prompt; ex.res=ex.res||h.res; ex.ratio=ex.ratio||h.ratio; ex.dur=ex.dur||h.dur; changed=true; }
          return;
        }
        jobs.push({ id:h.id, status:"done", videoUrl:h.videoUrl, mode:h.mode, prompt:h.prompt, res:h.res, ratio:h.ratio, dur:h.dur });
        changed=true;
      });
      if(changed) renderQueue();
    }).catch(function(){});
  }

  // —— 播放区 ——
  function clearPlayer(){ try{ feed.pause(); }catch(e){} feed.removeAttribute("src"); if(feed.load) feed.load(); feed.hidden=true; dlBtn.hidden=true; stageEmpty.hidden=false; if(stage) stage.classList.add("is-empty"); playerMeta.textContent=""; }
  function loadPlayer(j){
    selId=j.id; feed.src=mediaUrl(j.videoUrl); feed.hidden=false; feed.muted=false; dlBtn.hidden=false; stageEmpty.hidden=true; if(stage) stage.classList.remove("is-empty");
    playerMeta.innerHTML="<b>"+modeLabel(j.mode)+"</b>"+(j.res?" · "+j.res:"")+(j.ratio?" · "+j.ratio:"")+(j.dur?" · "+j.dur+"s":"");
    if(feed.play) feed.play().catch(function(){}); renderQueue();
  }
  function download(){
    if(!selId) return; dlBtn.disabled=true; var old=dlBtn.textContent; dlBtn.textContent="保存中…";
    fetch(API+"/aivideo/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jobId:selId})})
      .then(function(r){ return r.json(); })
      .then(function(d){ if(d&&d.ok){ showToast('已保存到　<span class="mono">'+(d.path||"")+'</span>'); } else { showToast('保存失败：'+((d&&d.error)||"未知错误")); } })
      .catch(function(e){ showToast('保存失败：'+e.message); })
      .then(function(){ dlBtn.disabled=false; dlBtn.textContent=old; });
  }
  dlBtn.addEventListener("click", download);

  // —— 输入区：加图（点击/拖拽/粘贴，最多 2 张）——
  function renderDropzone(){
    dropzone.innerHTML="";
    images.forEach(function(src,i){
      var cell=document.createElement("div"); cell.className="av-imgcell";
      var im=document.createElement("img"); im.src=src; cell.appendChild(im);
      var r=document.createElement("div"); r.className="role"; r.textContent=images.length===2?(i===0?"首帧":"尾帧"):"参考图"; cell.appendChild(r);
      var rm=document.createElement("button"); rm.className="rm"; rm.textContent="×"; rm.onclick=function(e){ e.stopPropagation(); images.splice(i,1); renderDropzone(); updateMode(); }; cell.appendChild(rm);
      dropzone.appendChild(cell);
    });
    if(images.length<2){ var add=document.createElement("div"); add.className="av-addcell"; add.innerHTML='<span class="plus">+</span><span>图片</span><small>点击/拖拽/粘贴</small>'; add.onclick=function(){ fileInput.click(); }; dropzone.appendChild(add); }
  }
  var hadImages=false;
  function updateMode(){
    var m=images.length>=2?"flf":(images.length===1?"image":"text");
    // 进入图生/首尾帧默认「适配图片」(输出比例跟随上传图)；退回文生时恢复 16:9。仅在边界切换，尊重用户在同一模式内的手动选择
    if(images.length>0 && !hadImages){ ratioSel.value="adaptive"; }
    else if(images.length===0 && hadImages && ratioSel.value==="adaptive"){ ratioSel.value="16:9"; }
    hadImages=images.length>0;
    modeTag.textContent=modeLabel(m); modeTag.classList.toggle("flf", m==="flf");
    modeHint.textContent = m==="text" ? "不加图 = 文生视频 · 1 张 = 图生视频 · 2 张 = 首尾帧"
      : m==="image" ? "已加 1 张参考图 → 图生视频（比例已设为「适配图片」）"
      : "已加 2 张 → 首尾帧：第 1 张为「首帧」，第 2 张为「尾帧」";
  }
  function addImage(src){ if(images.length>=2) return; images.push(src); renderDropzone(); updateMode(); }
  fileInput.addEventListener("change", function(e){ var f=e.target.files&&e.target.files[0]; if(f){ var rd=new FileReader(); rd.onload=function(){ addImage(String(rd.result||"")); }; rd.readAsDataURL(f); } e.target.value=""; });
  ["dragenter","dragover"].forEach(function(ev){ dropzone.addEventListener(ev,function(e){ e.preventDefault(); dropzone.classList.add("dragover"); }); });
  ["dragleave","drop"].forEach(function(ev){ dropzone.addEventListener(ev,function(e){ e.preventDefault(); dropzone.classList.remove("dragover"); }); });
  dropzone.addEventListener("drop", function(e){ var f=e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0]; if(f&&f.type.indexOf("image/")===0){ var rd=new FileReader(); rd.onload=function(){ addImage(String(rd.result||"")); }; rd.readAsDataURL(f); } });
  document.addEventListener("paste", function(e){
    if(!active) return; var cd=e.clipboardData||window.clipboardData; var items=cd&&cd.items; if(!items) return;
    for(var i=0;i<items.length;i++){ if(items[i].type.indexOf("image")===0){ var blob=items[i].getAsFile(); var rd=new FileReader(); rd.onload=function(){ addImage(String(rd.result||"")); }; rd.readAsDataURL(blob); e.preventDefault(); break; } }
  });

  var PROMPT_MIN=46, PROMPT_MAX=160;
  function autoGrow(){
    if(!promptInput.clientWidth){ promptInput.style.height=""; return; } // 面板隐藏(宽0)时测量会拿到错误的 scrollHeight，跳过，交给 CSS min-height
    promptInput.style.height="auto";
    var b=promptInput.offsetHeight-promptInput.clientHeight;
    promptInput.style.height=Math.min(PROMPT_MAX, Math.max(PROMPT_MIN, promptInput.scrollHeight+b))+"px";
  }
  promptInput.addEventListener("input", function(){ autoGrow(); syncDraft(); });

  // —— 提交生成 ——
  function submitGenerate(){
    if(submitting) return;
    var prompt=(promptInput.value||"").trim();
    if(!prompt && images.length===0){ composeErr.textContent="请至少输入一段画面描述（或加一张参考图）"; composeErr.hidden=false; return; }
    composeErr.hidden=true; submitting=true; submitBtn.disabled=true; submitBtn.textContent="提交中…";
    fetch(API+"/aivideo/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ prompt:prompt, images:images.slice(0,2), ratio:ratioSel.value, resolution:resSel.value, duration:Number(durSel.value)||5 })})
      .then(function(r){ return r.json().then(function(d){ return {ok:r.ok,d:d}; }); })
      .then(function(res){
        submitting=false; submitBtn.disabled=false; submitBtn.textContent="生成";
        if(!res.ok || !res.d || !res.d.ok){ var d=res.d||{}; composeErr.textContent=d.guide||d.error||"提交失败"; composeErr.hidden=false; return; }
        promptInput.value=""; autoGrow(); images=[]; renderDropzone(); updateMode(); syncDraft(true);
      })
      .catch(function(e){ submitting=false; submitBtn.disabled=false; submitBtn.textContent="生成"; composeErr.textContent="网络错误："+e.message; composeErr.hidden=false; });
  }
  submitBtn.addEventListener("click", submitGenerate);
  promptInput.addEventListener("keydown", function(e){ if((e.ctrlKey||e.metaKey)&&e.key==="Enter"){ e.preventDefault(); submitGenerate(); } });

  // —— 打开/关闭 ——
  function openPanel(configured){
    setActive(true);
    hydrateHistory();   // 每次打开都拉一次历史，重建之前生成的视频队列
    if(configured===false){ composeErr.textContent="尚未配置火山方舟（Seedance）API Key —— 把 key 发给小白龙即可（例如「火山视频 你的APIKey」），配置后就能在这里生成。"; composeErr.hidden=false; }
    else composeErr.hidden=true;
    setTimeout(function(){ try{ promptInput.focus(); }catch(e){} },60);
  }
  function closePanel(){ setActive(false); try{ feed.pause(); }catch(e){} }
  newBtn.addEventListener("click", function(){ images=[]; renderDropzone(); updateMode(); promptInput.value=""; autoGrow(); composeErr.hidden=true; syncDraft(true); try{ promptInput.focus(); }catch(e){} });
  exitBtn.addEventListener("click", closePanel);
  window.addEventListener("keydown", function(e){ if(!active) return; if(e.key==="Escape"){ if(document.activeElement===promptInput){ promptInput.blur(); return; } e.preventDefault(); closePanel(); } });

  // —— SSE 事件 ——
  function handle(data){
    data=data||{}; var action=data.action||"show";
    if(action==="hide"||action==="close"){ closePanel(); return; }
    if(action==="open"){ openPanel(data.configured); return; }
    if(action==="set_prompt"){
      // agent 在用户确认采用后，把优化好的提示词写回输入框（覆盖草稿）
      if(!active) setActive(true);
      promptInput.value=String(data.prompt||""); autoGrow(); syncDraft(true);
      showToast("已采用优化后的提示词，检查后点「生成」即可");
      try{ promptInput.focus(); }catch(e){}
      return;
    }
    if(action==="show"){
      setActive(true);
      var j=jobById(data.jobId);
      if(!j){ j={ id:data.jobId, status:"gen", start:Date.now() }; jobs.unshift(j); }
      j.status="gen"; j.prompt=data.prompt||j.prompt||""; j.mode=data.mode||j.mode||"text";
      j.res=data.resolution||j.res; j.ratio=data.ratio||j.ratio; j.dur=data.duration||j.dur;
      if(!j.start) j.start=Date.now();
      renderQueue(); return;
    }
    var job=jobById(data.jobId); if(!job) return;
    if(action==="progress"){ job.status="gen"; return; }
    if(action==="ready"){ job.status="done"; job.videoUrl=data.videoUrl; renderQueue(); if(!active) setActive(true); loadPlayer(job); return; }
    if(action==="error"){ job.status="fail"; job.error=data.message||"生成失败"; renderQueue(); return; }
  }
  window.addEventListener("bailongma:aivideo", function(e){ handle(e.detail||{}); });
  window.bailongmaAIVideo={ handle:handle, open:openPanel, close:closePanel };

  renderDropzone(); updateMode(); renderQueue(); autoGrow();
  hydrateHistory();   // 初始化即重建一次（覆盖 app 重启/渲染进程重载后的历史恢复）
})();
