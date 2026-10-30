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
    modelCatalogController: null, AbortController,
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

// Switching provider cancels the previous read. Even a server response that
// races cancellation must not update the new provider's models or feedback.
{
  const requests = [];
  const rendered = [];
  const context = vm.createContext({
    API: "", CUSTOM_MODEL_VALUE: "__custom_model__", modelCatalogRequestId: 0,
    modelCatalogController: null, AbortController,
    providerSelect: element("openai"), modelSelect: element("selected"),
    officialCustomModelInput: element(), llmKeyInput: element("key-a"),
    refreshModelsBtn: element(), modelCatalogStatus: element(), modelCatalogStatusRow: element(),
    cachedProviders: { openai: {}, deepseek: {} }, t: key => key,
    populateModelSelect(models) { rendered.push(models); }, syncOfficialCustomModelRow() {},
    fetch(_url, options) {
      const gate = deferred();
      requests.push({ ...gate, signal: options.signal });
      return gate.promise;
    },
  });
  vm.runInContext(section("  async function refreshProviderModels(", "  function setLlmKeyVisible("), context);
  vm.runInContext(section('  llmKeyInput?.addEventListener("input",', "  bindDebouncedAutosave([\n    llmKeyInput,"), context);
  const oldRead = context.refreshProviderModels();
  context.providerSelect.value = "deepseek";
  const newRead = context.refreshProviderModels();
  assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve(response({ ok: false, error: "old request failed" }));
  await oldRead;
  assert.equal(context.refreshModelsBtn.disabled, true, "old response cannot re-enable a running refresh");
  assert.equal(context.modelCatalogStatus.textContent, "dynamic.modelCatalogLoading");
  requests[1].resolve(response({ ok: true, source: "dynamic", models: [{ id: "new" }] }));
  await newRead;
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0][0].id, "new");
  assert.equal(context.refreshModelsBtn.disabled, false);

  // A different credential on the same provider also invalidates old results.
  const oldKeyRead = context.refreshProviderModels();
  context.llmKeyInput.value = "key-b";
  await context.llmKeyInput.dispatch("input");
  assert.equal(requests[2].signal.aborted, true);
  assert.equal(context.refreshModelsBtn.disabled, false);
  assert.equal(context.modelCatalogStatus.textContent, "");
  requests[2].resolve(response({ ok: true, source: "dynamic", models: [{ id: "key-a-only" }] }));
  await oldKeyRead;
  assert.equal(rendered.length, 1);
  assert.equal(context.cachedProviders.deepseek.models[0].id, "new");

  const closingRead = context.refreshProviderModels();
  context.providerSelect.value = "auto";
  await context.refreshProviderModels();
  assert.equal(requests[3].signal.aborted, true);
  requests[3].resolve(response({ ok: true, models: [{ id: "obsolete" }] }));
  await closingRead;
  assert.equal(rendered.length, 1);
}

// Successful auto-detection opens the real provider's model picker, but a late
// detection must preserve a newer provider/key/protocol draft for its next save.
for (const changed of [null, "provider", "key", "format"]) {
  const gate = deferred();
  let refreshes = 0;
  const fields = new Map([
    "settings-custom-llm-section", "settings-model-row", "settings-official-custom-model-row",
  ].map(id => [id, element()]));
  fields.get("settings-model-row").style.display = "none";
  const context = vm.createContext({
    API: "", CUSTOM_MODEL_VALUE: "__custom_model__",
    providerSelect: element("auto"), apiFormatSelect: element("responses"),
    llmKeyInput: element("original-key"), modelSelect: element(), officialCustomModelInput: element(),
    customReasoningSelect: null, thinkingToggle: null, thinkingHint: null,
    cachedProviders: { deepseek: { defaultModel: "default-model", models: [] } },
    cachedLlm: null, cachedMinimax: {}, llmFeedback: null,
    document: { getElementById: id => fields.get(id) || null },
    createSettingsAutosave: save => ({ save }), fetch: () => gate.promise,
    refreshConfigSummary() {}, setLlmKeyVisible() {},
    populateModelSelect(_models, current) { context.modelSelect.value = current; },
    refreshProviderModels() { refreshes++; },
  });
  vm.runInContext(section("  function getProviderConfigForUI(", "  async function loadSettings("), context);
  vm.runInContext(section("  const llmAutosave = ", "\n  bindDebouncedAutosave([\n    llmKeyInput,"), context);
  const save = vm.runInContext("llmAutosave.save()", context);
  if (changed === "provider") context.providerSelect.value = "custom";
  if (changed === "key") context.llmKeyInput.value = "newer-key";
  if (changed === "format") context.apiFormatSelect.value = "chat-completions";
  gate.resolve(response({
    ok: true, provider: "deepseek", model: "detected-model", apiFormat: "responses",
    models: [{ id: "detected-model" }],
  }));
  await save;
  assert.equal(context.cachedLlm.provider, "deepseek");
  assert.equal(context.cachedProviders.deepseek.configured, true);
  if (!changed) {
    assert.equal(context.providerSelect.value, "deepseek");
    assert.equal(context.modelSelect.value, "detected-model");
    assert.equal(fields.get("settings-model-row").style.display, "");
    assert.equal(refreshes, 1);
  } else {
    assert.equal(refreshes, 0);
    assert.equal(context.providerSelect.value, changed === "provider" ? "custom" : "auto");
    assert.equal(context.llmKeyInput.value, changed === "key" ? "newer-key" : "original-key");
    assert.equal(context.apiFormatSelect.value, changed === "format" ? "chat-completions" : "responses");
  }
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
{
  const fields = new Map([
    ["settings-custom-baseurl", element("https://gateway.invalid/v1")],
    ["settings-custom-model", element("custom-model")],
  ]);
  const reasoningSelect = element("effort");
  const apiFormatSelect = element("responses");
  let saves = 0;
  const context = vm.createContext({
    document: { getElementById: id => fields.get(id) || null },
    apiFormatSelect, customReasoningSelect: reasoningSelect,
    cachedLlm: { provider: "custom", apiFormat: "responses", reasoningControl: "omit" },
    thinkingToggle: element(), thinkingHint: element(), t: key => key,
    llmAutosave: { schedule() { saves += 1; } },
  });
  vm.runInContext(section("  function syncThinkingApiFormatUI(", "  function applyCustomProviderUI("), context);
  vm.runInContext(section('  apiFormatSelect?.addEventListener("change"', "  const agentNameAutosave = "), context);
  context.syncThinkingApiFormatUI();
  assert.equal(context.thinkingToggle.disabled, true, "unknown custom endpoint does not claim the thinking toggle works");
  context.cachedLlm.reasoningControl = "effort";
  context.syncThinkingApiFormatUI();
  assert.equal(context.thinkingToggle.disabled, false);
  assert.equal(context.thinkingHint.textContent, "settings.customThinkingEffortHint");
  for (const id of fields.keys()) {
    reasoningSelect.value = "effort";
    await fields.get(id).dispatch("input");
    assert.equal(reasoningSelect.value, "omit", "editing endpoint/model resets the capability draft");
  }
  reasoningSelect.value = "effort";
  await reasoningSelect.dispatch("change");
  assert.equal(saves, 1, "explicit capability selection is saved immediately");
  apiFormatSelect.value = "chat-completions";
  await apiFormatSelect.dispatch("change");
  assert.equal(reasoningSelect.disabled, true, "Responses capability is unavailable for Chat Completions");
}

{
  const requests = [];
  const fields = new Map([
    ["settings-custom-baseurl", element("https://gateway.invalid/v1")],
    ["settings-custom-model", element("custom-model")],
  ]);
  const context = vm.createContext({
    API: "", document: { getElementById: id => fields.get(id) || null },
    providerSelect: element("custom"), apiFormatSelect: element("responses"),
    customReasoningSelect: element("effort"), llmKeyInput: element("saved-key"),
    cachedProviders: { custom: { apiKey: "saved-key" } }, cachedLlm: {},
    cachedMinimax: {}, llmFeedback: null,
    createSettingsAutosave: save => ({ save }),
    refreshConfigSummary() {}, syncThinkingApiFormatUI() {},
    fetch: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return response({ ok: true, provider: "custom", reasoningControl: "effort" });
    },
  });
  vm.runInContext(section("  const llmAutosave = ", "\n  bindDebouncedAutosave([\n    llmKeyInput,"), context);
  await vm.runInContext("llmAutosave.save()", context);
  assert.equal(requests[0].reasoningControl, "effort");
  assert.equal(requests[0].apiKey, undefined, "capability-only UI save does not resend an unchanged key");
  assert.equal(context.cachedProviders.custom.reasoningControl, "effort");
}

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
    modelCatalogRequestId: 0, modelCatalogController: null,
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
    modelCatalogRequestId: 0, modelCatalogController: new AbortController(),
    flushPendingAutosaves: () => pending.promise,
    loadSettings() { loads += 1; }, loadVoiceSettings() { loads += 1; },
    updateSecretVisibility() {}, mapKeyInput: null, mapKeyToggle: null,
    mapSecurityInput: null, mapSecurityToggle: null,
  });
  vm.runInContext(section("  async function openSettings(", "  // 暴露给 chat.js"), context);
  const opening = context.openSettings();
  const catalogController = context.modelCatalogController;
  context.closeSettings();
  assert.equal(catalogController.signal.aborted, true);
  assert.equal(context.modelCatalogRequestId, 1);
  assert.equal(context.modelCatalogController, null);
  pending.resolve([true]);
  await opening;
  assert.equal(loads, 0, "closing cancels an opening that was waiting for saves");
}

// Exercise the actual app-to-settings dependency boundary without a global
// applyHeartbeatConfig: both the caller and the settings parameter must wire it.
{
  const appSource = fs.readFileSync(new URL("./ui/brain-ui/app.js", import.meta.url), "utf8");
  const applied = [];
  let settingsOptions;
  const wiring = vm.createContext({
    initSettings(options) { settingsOptions = options; },
    DEFAULT_AGENT_NAME: "test", agentName: "test", setAgentName() {},
    isTTSStreamingEnabled() {}, setTTSStreamingEnabled() {},
    activeTTSVoiceId: "test", openSettingsRef: null,
    applyHeartbeatConfig(config) { applied.push(config); },
  });
  const callStart = appSource.indexOf("initSettings({");
  vm.runInContext(appSource.slice(callStart, appSource.indexOf("\n});", callStart) + 4), wiring);

  const heartbeatToggle = element();
  const heartbeatInterval = element("20");
  const feedback = [];
  const requests = [];
  let rejectSave = false;
  const context = autosaveContext({
    API: "", heartbeatToggle, heartbeatInterval, heartbeatFeedback: element(),
    settingsOptions,
    showFeedback(_element, message, error) { feedback.push({ message, error }); },
    async fetch(url, options) {
      requests.push({ url, options });
      if (!options) return response({ ok: true, heartbeat: { enabled: false, defaultIntervalMinutes: 37 } });
      if (rejectSave) return response({ ok: false, error: "write failed" });
      return response({ ok: true, heartbeat: JSON.parse(options.body) });
    },
  });
  const signature = section("export function initSettings(", "const themeSwitcher").replace("export ", "");
  vm.runInContext(signature
    + section("  function syncHeartbeatControls(", "  function applyVoiceConfigStatus(")
    + section("  async function loadHeartbeatSettings(", "  const mapAutosave =")
    + "return { loadHeartbeatSettings, heartbeatAutosave }; }\nglobalThis.heartbeatSettings = initSettings(settingsOptions);", context);
  const { loadHeartbeatSettings, heartbeatAutosave } = context.heartbeatSettings;
  await loadHeartbeatSettings();
  assert.equal(heartbeatToggle.checked, false);
  assert.equal(heartbeatInterval.value, "37");
  assert.equal(applied.length, 1, "loading updates the heartbeat monitor");
  assert.equal(feedback.some(item => item.error), false);

  heartbeatToggle.checked = true;
  heartbeatInterval.value = "45";
  await heartbeatToggle.dispatch("change");
  await heartbeatAutosave.flush();
  assert.equal(context.autosaveErrors.size, 0, "successful server save must not be reported as failed");
  assert.equal(applied.at(-1).defaultIntervalMinutes, 45);
  assert.equal(applied.at(-1).enabled, true);

  rejectSave = true;
  assert.equal(await heartbeatAutosave.schedule({ immediate: true }), false);
  assert.equal(context.autosaveErrors.size, 1);
  assert.equal(applied.length, 2, "failed saves do not update the monitor");
  rejectSave = false;
  heartbeatToggle.checked = false;
  assert.equal(await heartbeatAutosave.schedule({ immediate: true }), true);
  assert.equal(context.autosaveErrors.size, 0, "retry clears the save error");
  assert.equal(applied.at(-1).enabled, false);

  const beforeInvalid = requests.length;
  heartbeatInterval.value = "0";
  assert.equal(await heartbeatAutosave.schedule({ immediate: true }), false);
  assert.equal(requests.length, beforeInvalid, "invalid interval does not reach the server");
}

console.log("Settings autosave UI race, provider selection, and TTS preview tests passed");
