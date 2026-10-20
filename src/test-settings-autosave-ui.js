import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Run the real browser handlers with isolated DOM/network boundaries. These
// tests never import config.js, open a database, or touch the user's settings.
const source = fs.readFileSync(new URL("./ui/brain-ui/settings.js", import.meta.url), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const settle = () => new Promise(resolve => setImmediate(resolve));
const response = data => ({ ok: true, json: async () => data });

function element(value = "") {
  const handlers = new Map();
  return {
    value, checked: false, disabled: false, style: {}, dataset: {}, textContent: "",
    addEventListener(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
    async dispatch(event) {
      await Promise.all((handlers.get(event) || []).map(handler => handler({ target: this })));
    },
    setAttribute() {},
  };
}

function autosaveContext(extra = {}) {
  const context = vm.createContext({
    Promise, Set, Map, Error,
    setTimeout: () => 1, clearTimeout() {},
    autosaveControllers: new Set(), autosaveErrors: new Map(), activeAutosaves: 0,
    showFeedback() {}, refreshAutosaveStatus() {},
    ...extra,
  });
  vm.runInContext(section("  function createSettingsAutosave(", "  function bindDebouncedAutosave("), context);
  return context;
}

// A caller waiting for a flush must wait for the running save and newer queued
// edits. Merely flushing an in-flight save must not cause an extra write.
{
  const context = autosaveContext();
  const first = deferred();
  const second = deferred();
  const values = [];
  let draft = "first";
  const controller = context.createSettingsAutosave(async () => {
    values.push(draft);
    await (values.length === 1 ? first.promise : second.promise);
  });
  const saving = controller.schedule({ immediate: true });
  let finished = false;
  const flushed = controller.flush().then(() => { finished = true; });
  draft = "latest";
  controller.schedule({ immediate: true });
  assert.deepEqual(values, ["first"]);
  first.resolve();
  await settle();
  assert.deepEqual(values, ["first", "latest"]);
  assert.equal(finished, false, "flush waits for queued edits");
  second.resolve();
  assert.equal(await saving, true);
  await flushed;
  assert.equal(context.activeAutosaves, 0);
  await controller.flush();
  assert.deepEqual(values, ["first", "latest"], "flush does not add a duplicate save");

  const failing = context.createSettingsAutosave(async () => { throw new Error("disk full"); });
  assert.equal(await failing.schedule({ immediate: true }), false, "callers can detect save failures");
}

// A late model catalog response must preserve the user's latest selection,
// including a new manual model or a manual field that is still empty.
for (const newModel of ["new-model", "__custom_model__"]) {
  const pending = deferred();
  const providerSelect = element("openai");
  const modelSelect = element("old-model");
  const customInput = element();
  const context = vm.createContext({
    API: "", CUSTOM_MODEL_VALUE: "__custom_model__", modelCatalogRequestId: 0,
    providerSelect, modelSelect, officialCustomModelInput: customInput,
    refreshModelsBtn: element(), modelCatalogStatus: element(), modelCatalogStatusRow: element(),
    llmKeyInput: element(), cachedProviders: { openai: { model: "old-model" } },
    t: key => key, fetch: () => pending.promise,
    populateModelSelect(_models, current) {
      modelSelect.value = current;
      customInput.value = "";
    },
    syncOfficialCustomModelRow() {},
  });
  vm.runInContext(section("  async function refreshProviderModels(", "  function setLlmKeyVisible("), context);
  const refresh = context.refreshProviderModels();
  modelSelect.value = newModel;
  pending.resolve(response({ ok: true, models: [{ id: "old-model" }, { id: "new-model" }] }));
  await refresh;
  assert.equal(modelSelect.value, newModel, "catalog refresh preserves edits made while loading");
  assert.equal(customInput.value, "");
}

// Changing provider saves the selected configuration without waiting for the
// optional network model catalog.
{
  const providerSelect = element("openai");
  const catalog = deferred();
  let saves = 0;
  const context = vm.createContext({
    providerSelect, applyCustomProviderUI() {},
    refreshProviderModels: () => catalog.promise,
    llmAutosave: { schedule() { saves += 1; } },
  });
  vm.runInContext(section('  if (providerSelect) {\n    providerSelect.addEventListener', '  refreshModelsBtn?.addEventListener'), context);
  providerSelect.dispatch("change");
  assert.equal(saves, 1, "provider selection is saved even if the catalog is slow");
  catalog.resolve();
}

// TTS preview must use the same full payload as autosave and abort on a failed
// save, instead of playing with a previous configuration.
async function ttsPreviewFixture({ failSave = false, createAutosave = true } = {}) {
  const elements = new Map([
    "tts-provider-select", "tts-voice-select", "tts-test-btn", "tts-test-status",
    "tts-openai-key", "tts-openai-baseurl",
  ].map(id => [id, element()]));
  const requests = [];
  const saveGate = deferred();
  const context = autosaveContext({
    API: "", document: { getElementById: id => elements.get(id) || null },
    getJarvisFxParams: () => ({}), isFxUnlocked: () => false, isFxEnabledForVoice: () => false,
    getTtsStreamingEnabled: () => true, setTtsStreamingEnabled() {},
    setTtsVoiceId() {}, getTtsVoiceId: () => "alloy", updateSecretVisibility() {},
    fetch: async (url, options = {}) => {
      requests.push({ url, body: options.body ? JSON.parse(options.body) : null });
      if (!options.method) return response({ tts: { ttsProvider: "openai", ttsVoiceId: "alloy" }, voices: {} });
      if (url === "/settings/tts") {
        await saveGate.promise;
        return failSave
          ? { ok: false, json: async () => ({ ok: false, error: "无法保存配置" }) }
          : response({ ok: true });
      }
      // Stop before media playback; only configuration sequencing is tested.
      return { ok: false, status: 400, json: async () => ({ error: "test synthesis response" }) };
    },
  });
  vm.runInContext(section("function initTTSSettings(", "// ── Settings modal"), context);
  context.initTTSSettings({ createAutosave: createAutosave ? context.createSettingsAutosave : undefined });
  await settle();
  elements.get("tts-openai-baseurl").value = "https://tts.example.invalid/v1";
  elements.get("tts-openai-key").value = "new-key";
  elements.get("tts-voice-select").value = "alloy";
  const clicked = elements.get("tts-test-btn").dispatch("click");
  await settle();
  const save = requests.find(request => request.body && request.url === "/settings/tts");
  assert.equal(save.body.openaiTtsBaseURL, "https://tts.example.invalid/v1");
  assert.equal(save.body.openaiTtsKey, "new-key");
  assert.equal(requests.some(request => request.url === "/tts/stream"), false, "preview waits for the save");
  saveGate.resolve();
  await clicked;
  assert.equal(requests.some(request => request.url === "/tts/stream"), !failSave);
  assert.equal(elements.get("tts-test-btn").disabled, false);
  if (failSave) assert.match(elements.get("tts-test-status").textContent, /保存失败|无法保存配置/);
}

await ttsPreviewFixture();
await ttsPreviewFixture({ failSave: true });
await ttsPreviewFixture({ createAutosave: false });

// A successful old network save must not overwrite a second toggle made while
// that request was in flight, otherwise the queued save sends the old value.
for (const failSave of [false, true]) {
  const pending = deferred();
  const lanAccessToggle = element();
  lanAccessToggle.checked = true;
  const context = vm.createContext({
    API: "", document: { querySelectorAll: () => [] },
    fileSandboxToggle: element(), execSandboxToggle: element(), lanAccessToggle,
    securityFeedback: null, restartSecurityBtn: null,
    createSettingsAutosave: save => ({ save }),
    fetch: () => pending.promise,
    applyLanNetworkSettings(network, { syncToggle } = {}) {
      if (syncToggle !== false) lanAccessToggle.checked = network.allowLanAccess === true;
    },
    loadSecuritySettings() { lanAccessToggle.checked = true; },
  });
  vm.runInContext(section("  const securityAutosave = ", "\n  [\n    fileSandboxToggle,"), context);
  const save = vm.runInContext("securityAutosave.save()", context);
  lanAccessToggle.checked = false;
  pending.resolve(response({ ok: !failSave, error: "cannot save", network: { allowLanAccess: true } }));
  if (failSave) await assert.rejects(save, /cannot save/);
  else await save;
  assert.equal(lanAccessToggle.checked, false, "new LAN preference survives an older save response");
}

// Closing and immediately reopening while a save is pending must wait for that
// save before reading server values back into the form.
for (const saveSucceeded of [true, false]) {
  const pending = deferred();
  let loads = 0;
  const overlay = { hidden: true };
  const context = vm.createContext({
    overlay, settingsOpenRequestId: 0, refreshAutosaveStatus() {},
    flushPendingAutosaves: () => pending.promise,
    loadSettings() { loads += 1; }, loadVoiceSettings() { loads += 1; },
    updateSecretVisibility() {}, mapKeyInput: null, mapKeyToggle: null,
    mapSecurityInput: null, mapSecurityToggle: null,
  });
  vm.runInContext(section("  async function openSettings(", "  // 暴露给 chat.js"), context);
  const opening = context.openSettings();
  assert.equal(overlay.hidden, false);
  assert.equal(loads, 0, "opening does not reload values while a write is pending");
  pending.resolve([saveSucceeded]);
  await opening;
  assert.equal(loads, saveSucceeded ? 2 : 0, "failed drafts are retained for correction");
}

{
  const pending = deferred();
  let loads = 0;
  const context = vm.createContext({
    overlay: { hidden: true }, settingsOpenRequestId: 0, refreshAutosaveStatus() {},
    flushPendingAutosaves: () => pending.promise,
    loadSettings() { loads += 1; }, loadVoiceSettings() { loads += 1; },
    updateSecretVisibility() {}, mapKeyInput: null, mapKeyToggle: null,
    mapSecurityInput: null, mapSecurityToggle: null,
  });
  vm.runInContext(section("  async function openSettings(", "  // 暴露给 chat.js"), context);
  const opening = context.openSettings();
  context.closeSettings();
  pending.resolve([true]);
  await opening;
  assert.equal(loads, 0, "closing cancels an opening that was waiting for saves");
}

console.log("Settings autosave UI race, provider selection, and TTS preview tests passed");
