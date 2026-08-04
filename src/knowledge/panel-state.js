// UI state only.  Knowledge evidence and automatic retrieval stay in the
// retrieval pipeline; opening this surface must never alter either of them.
let panelState = {
  active: false,
  updatedAtMs: 0,
  source: 'startup',
  regionId: '',
  query: '',
  documentId: '',
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function setKnowledgePanelState({ active, source = 'unknown', regionId, query, documentId } = {}) {
  panelState = {
    active: typeof active === 'boolean' ? active : panelState.active,
    updatedAtMs: Date.now(),
    source: text(source) || 'unknown',
    regionId: regionId === undefined ? panelState.regionId : text(regionId),
    query: query === undefined ? panelState.query : text(query),
    documentId: documentId === undefined ? panelState.documentId : text(documentId),
  }
  return getKnowledgePanelState()
}

export function getKnowledgePanelState() {
  return {
    ...panelState,
    updatedAt: panelState.updatedAtMs ? new Date(panelState.updatedAtMs).toISOString() : null,
  }
}
