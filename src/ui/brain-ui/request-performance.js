// Client-only monotonic measurements. No text, prompt, URL or credential is kept.
// A DOM update and a subsequent animation-frame opportunity are not proof of
// compositor presentation; keep those names distinct from server first token.
const safeId = value => typeof value === "string" && /^[\w.:-]{1,160}$/.test(value) ? value : "";
const rounded = value => Math.round(value * 100) / 100;

function visibleText(element) {
  const doc = element?.ownerDocument;
  if (!element?.isConnected || doc?.hidden || !element.textContent?.trim()) return false;
  if (typeof element.checkVisibility === "function"
    && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
  const rect = element.getBoundingClientRect();
  const view = doc?.defaultView;
  return rect.width > 0 && rect.height > 0
    && rect.bottom > 0 && rect.right > 0
    && rect.top < (view?.innerHeight || Infinity) && rect.left < (view?.innerWidth || Infinity);
}

export function createClientRequestPerformance({
  now = () => performance.now(),
  frame = callback => globalThis.requestAnimationFrame?.(callback),
  isVisible = visibleText,
  report = value => console.info("[performance-visible]", value),
  limit = 80,
} = {}) {
  const records = new Map();
  const byRequest = new Map();
  const byTurn = new Map();
  const snapshot = record => {
    const elapsed = name => record[name] == null ? null : rounded(record[name] - record.startedAt);
    const between = (a, b) => record[a] == null || record[b] == null ? null : rounded(record[a] - record[b]);
    return {
      clientMessageId: record.clientMessageId, requestId: record.requestId || null, turnId: record.turnId || null,
      failed: record.failed === true,
      sendToDispatchMs: elapsed("dispatchedAt"),
      sendToAcceptedHeadersMs: elapsed("acceptedAt"),
      sendToFirstTextReceivedMs: elapsed("receivedAt"),
      sendToFirstTextDomMs: elapsed("domAt"),
      sendToFirstTextFrameOpportunityMs: elapsed("frameAt"),
      receivedToDomMs: between("domAt", "receivedAt"),
      domToFrameOpportunityMs: between("frameAt", "domAt"),
    };
  };
  const emit = record => { try { report(snapshot(record)); } catch {} };
  const bind = (metadata = {}) => {
    const clientId = safeId(metadata.client_message_id || metadata.clientMessageId);
    const requestId = safeId(metadata.request_id || metadata.requestId);
    const turnId = safeId(metadata.turn_id || metadata.turnId);
    const record = records.get(clientId) || byRequest.get(requestId) || byTurn.get(turnId);
    if (!record || records.get(record.clientMessageId) !== record) return null;
    if (requestId) { record.requestId = requestId; byRequest.set(requestId, record); }
    if (turnId) { record.turnId = turnId; byTurn.set(turnId, record); }
    return record;
  };
  return Object.freeze({
    begin(clientMessageId, startedAt = now()) {
      const id = safeId(clientMessageId);
      if (!id || !Number.isFinite(startedAt) || records.has(id)) return;
      records.set(id, { clientMessageId: id, startedAt });
      while (records.size > Math.max(1, limit)) {
        const oldest = records.values().next().value;
        records.delete(oldest.clientMessageId);
        for (const [key, value] of byRequest) if (value === oldest) byRequest.delete(key);
        for (const [key, value] of byTurn) if (value === oldest) byTurn.delete(key);
        oldest.element = null;
      }
    },
    dispatched(metadata) { const record = bind(metadata); if (record) record.dispatchedAt ??= now(); },
    accepted(metadata) {
      const record = bind(metadata);
      if (!record) return;
      record.acceptedAt ??= now();
      // A very fast SSE reply may beat the POST acknowledgement.
      if (record.domAt != null) emit(record);
    },
    correlate(metadata) { bind(metadata); },
    failed(metadata) { const record = bind(metadata); if (record) record.failed = true; },
    textReceived(metadata) {
      const record = bind(metadata);
      if (record && !record.failed) record.receivedAt ??= now();
    },
    textRendered(metadata, element) {
      const record = bind(metadata);
      if (!record || record.failed || record.frameAt != null || !element?.textContent?.trim()) return;
      if (element.isConnected === false) return;
      if (record.domAt == null) { record.domAt = now(); emit(record); }
      record.element = element;
      if (record.framePending) return;
      record.framePending = true;
      // Two frames allow a paint opportunity after insertion. Check visibility
      // again; a hidden window, removed bubble or superseded turn is not visible.
      frame(() => frame(() => {
        record.framePending = false;
        if (records.get(record.clientMessageId) !== record || record.failed) return;
        try {
          if (record.element && isVisible(record.element)) {
            record.frameAt = now();
            emit(record);
          }
        } catch {}
        record.element = null;
      }));
    },
    snapshots() { return [...records.values()].map(snapshot); },
  });
}

export const clientRequestPerformance = createClientRequestPerformance();
export const getClientRequestPerformance = () => clientRequestPerformance.snapshots();
