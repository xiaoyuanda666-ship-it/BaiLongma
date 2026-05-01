const STORAGE_L1 = "bailongma-panel-l1-collapsed";
const STORAGE_L2 = "bailongma-panel-l2-collapsed";

function storageKeyForSide(side) {
  return side === "l1" ? STORAGE_L1 : STORAGE_L2;
}

function classForSide(side) {
  return side === "l1" ? "l1-collapsed" : "l2-collapsed";
}

export function initPanelCollapse() {
  function setPanel(side, collapsed) {
    document.body.classList.toggle(classForSide(side), collapsed);
    try { localStorage.setItem(storageKeyForSide(side), collapsed ? "1" : "0"); } catch {}
  }

  function togglePanel(side) {
    const cls = classForSide(side);
    setPanel(side, !document.body.classList.contains(cls));
  }

  try {
    if (localStorage.getItem(STORAGE_L1) === "1") document.body.classList.add("l1-collapsed");
    if (localStorage.getItem(STORAGE_L2) === "1") document.body.classList.add("l2-collapsed");
  } catch {}

  document.getElementById("panel-l1-tab")?.addEventListener("click", () => togglePanel("l1"));
  document.getElementById("panel-l2-tab")?.addEventListener("click", () => togglePanel("l2"));

  window.addEventListener("keydown", (event) => {
    if (event.target && (event.target.tagName === "INPUT" || event.target.tagName === "TEXTAREA" || event.target.isContentEditable)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "[") { event.preventDefault(); togglePanel("l1"); }
    if (event.key === "]") { event.preventDefault(); togglePanel("l2"); }
  });
}

