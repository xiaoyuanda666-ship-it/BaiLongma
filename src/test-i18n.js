import assert from "node:assert/strict";
import {
  DEFAULT_LOCALE,
  LANGUAGE_STORAGE_KEY,
  formatDateTime,
  getMissingTranslationKeys,
  normalizeLocale,
  resolveLocale,
  setLocale,
  t,
  translateUiText,
} from "./ui/brain-ui/i18n/index.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

assert.equal(normalizeLocale("en"), "en-US");
assert.equal(normalizeLocale("en_GB"), "en-US");
assert.equal(normalizeLocale("zh-Hans"), "zh-CN");
assert.equal(normalizeLocale("fr-FR"), null);

assert.equal(resolveLocale({ search: "?lang=en-US", storage: memoryStorage(), languages: ["zh-CN"] }), "en-US");
assert.equal(resolveLocale({ storage: memoryStorage({ [LANGUAGE_STORAGE_KEY]: "en-US" }), languages: ["zh-CN"] }), "en-US");
assert.equal(resolveLocale({ storage: memoryStorage(), languages: ["fr-FR", "en-GB"] }), "en-US");
assert.equal(resolveLocale({ storage: memoryStorage(), languages: ["fr-FR"] }), DEFAULT_LOCALE);

const storage = memoryStorage();
setLocale("en-US", { storage });
assert.equal(storage.getItem(LANGUAGE_STORAGE_KEY), "en-US");
assert.equal(t("common.settings"), "Settings");
assert.equal(t("format.warmup", { seconds: 8 }), "Just activated — warming up the model… ~8s");
assert.equal(t("runtime.activityWorking", { activity: t("runtime.activityScanFiles") }), "Currently scanning files");
assert.equal(translateUiText("正在准备本地端口"), "Preparing the local port");
assert.equal(translateUiText("本地端口 3721 已准备"), "Local port 3721 is ready");
assert.match(formatDateTime(new Date("2026-08-10T08:05:00Z"), { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hour12: false }), /08:05|08:05/);
assert.deepEqual(getMissingTranslationKeys("en-US"), []);

setLocale(DEFAULT_LOCALE, { storage });
assert.equal(t("common.settings"), "设置");

console.log("i18n tests passed");
