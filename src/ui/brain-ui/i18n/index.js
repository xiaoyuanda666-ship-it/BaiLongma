import zhCN from "./locales/zh-CN.js";
import enUS from "./locales/en-US.js";

export const DEFAULT_LOCALE = "zh-CN";
export const SUPPORTED_LOCALES = Object.freeze(["zh-CN", "en-US"]);
export const LANGUAGE_STORAGE_KEY = "bailongma-ui-language";

const catalogs = Object.freeze({
  "zh-CN": zhCN,
  "en-US": enUS,
});

const sourceTextToKey = new Map(
  Object.entries(zhCN)
    .filter(([, value]) => typeof value === "string" && !value.includes("{"))
    .map(([key, value]) => [value, key]),
);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const sourceTextPatterns = Object.entries(zhCN)
  .filter(([, value]) => typeof value === "string" && value.includes("{"))
  .map(([key, value]) => {
    const names = [];
    let cursor = 0;
    let expression = "^";
    for (const match of value.matchAll(/\{([A-Za-z0-9_]+)\}/g)) {
      expression += escapeRegExp(value.slice(cursor, match.index));
      expression += "(.*?)";
      names.push(match[1]);
      cursor = match.index + match[0].length;
    }
    expression += `${escapeRegExp(value.slice(cursor))}$`;
    return { key, names, regex: new RegExp(expression) };
  });

const PROTECTED_DYNAMIC_CONTENT = [
  "[data-i18n-ignore]",
  "#chat-messages",
  "#si-l1",
  "#si-l2",
  "#action-log",
  "#command-runs",
  "#browser-preview",
  "pre",
  "code",
  "script",
  "style",
].join(",");

const LOCALIZABLE_ATTRIBUTES = Object.freeze([
  "aria-label",
  "alt",
  "placeholder",
  "title",
]);

export function normalizeLocale(value) {
  const raw = String(value || "").trim().replaceAll("_", "-").toLowerCase();
  if (!raw) return null;
  if (raw === "en" || raw.startsWith("en-")) return "en-US";
  if (raw === "zh" || raw === "zh-cn" || raw === "zh-hans" || raw.startsWith("zh-hans-")) return "zh-CN";
  return null;
}

export function resolveLocale({ search, storage, languages } = {}) {
  let queryLocale = null;
  try {
    const query = search ?? globalThis.location?.search ?? "";
    queryLocale = normalizeLocale(new URLSearchParams(query).get("lang"));
  } catch {}
  if (queryLocale) return queryLocale;

  let storedLocale = null;
  try {
    const targetStorage = storage ?? globalThis.localStorage;
    storedLocale = normalizeLocale(targetStorage?.getItem?.(LANGUAGE_STORAGE_KEY));
  } catch {}
  if (storedLocale) return storedLocale;

  const candidates = languages
    ?? globalThis.navigator?.languages
    ?? [globalThis.navigator?.language];
  for (const candidate of Array.isArray(candidates) ? candidates : [candidates]) {
    const locale = normalizeLocale(candidate);
    if (locale) return locale;
  }
  return DEFAULT_LOCALE;
}

let activeLocale = resolveLocale();

export function getLocale() {
  return activeLocale;
}

export function setLocale(locale, { storage } = {}) {
  const normalized = normalizeLocale(locale);
  if (!normalized) throw new Error(`Unsupported UI locale: ${locale}`);
  activeLocale = normalized;
  try {
    const targetStorage = storage ?? globalThis.localStorage;
    targetStorage?.setItem?.(LANGUAGE_STORAGE_KEY, normalized);
  } catch {}
  applyDocumentLocale();
  return activeLocale;
}

export function getCatalog(locale = activeLocale) {
  return catalogs[normalizeLocale(locale) || DEFAULT_LOCALE];
}

export function getMissingTranslationKeys(locale = activeLocale) {
  const catalog = getCatalog(locale);
  return Object.keys(zhCN).filter(key => !Object.prototype.hasOwnProperty.call(catalog, key));
}

export function t(key, variables = {}, locale = activeLocale) {
  const normalized = normalizeLocale(locale) || DEFAULT_LOCALE;
  const template = catalogs[normalized]?.[key] ?? zhCN[key] ?? key;
  return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(variables, name) ? String(variables[name]) : match
  ));
}

export function formatDateTime(value, options = {}, locale = activeLocale) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat(normalizeLocale(locale) || DEFAULT_LOCALE, options).format(date);
}

export function applyDocumentLocale(doc = globalThis.document) {
  if (!doc?.documentElement) return;
  doc.documentElement.lang = activeLocale;
  doc.documentElement.dir = "ltr";
}

function translateSourceText(source) {
  if (activeLocale === DEFAULT_LOCALE) return source;
  const key = sourceTextToKey.get(source);
  if (key) return t(key);
  for (const pattern of sourceTextPatterns) {
    const match = pattern.regex.exec(source);
    if (!match) continue;
    const variables = Object.fromEntries(pattern.names.map((name, index) => [name, match[index + 1]]));
    return t(pattern.key, variables);
  }
  return source;
}

export function translateUiText(source) {
  return translateSourceText(String(source ?? ""));
}

function translateTextNode(node, { protectDynamicContent = false } = {}) {
  if (!node?.parentElement) return;
  if (protectDynamicContent && node.parentElement.closest(PROTECTED_DYNAMIC_CONTENT)) return;
  const value = String(node.nodeValue || "");
  const match = /^(\s*)(.*?)(\s*)$/s.exec(value);
  const core = match?.[2] || "";
  if (!core) return;
  const translated = translateSourceText(core);
  if (translated !== core) node.nodeValue = `${match[1]}${translated}${match[3]}`;
}

function translateElementAttributes(element, { protectDynamicContent = false } = {}) {
  if (!element?.getAttribute) return;
  if (protectDynamicContent && element.closest(PROTECTED_DYNAMIC_CONTENT)) return;
  for (const attribute of LOCALIZABLE_ATTRIBUTES) {
    if (!element.hasAttribute(attribute)) continue;
    const value = element.getAttribute(attribute);
    const translated = translateSourceText(value);
    if (translated !== value) element.setAttribute(attribute, translated);
  }
}

export function localizeDom(root = globalThis.document, options = {}) {
  applyDocumentLocale(root?.ownerDocument || root);
  if (!root || activeLocale === DEFAULT_LOCALE) return root;

  if (root.nodeType === 1) translateElementAttributes(root, options);
  const elements = root.querySelectorAll?.("*") || [];
  for (const element of elements) translateElementAttributes(element, options);

  const doc = root.ownerDocument || root;
  if (!doc?.createTreeWalker || !globalThis.NodeFilter) return root;
  const walker = doc.createTreeWalker(root, globalThis.NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    translateTextNode(node, options);
    node = walker.nextNode();
  }
  return root;
}

export function observeDomLocalization(root = globalThis.document?.body) {
  if (!root || !globalThis.MutationObserver) return () => {};
  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes") {
        translateElementAttributes(mutation.target, { protectDynamicContent: true });
        continue;
      }
      for (const node of mutation.addedNodes) {
        if (node.nodeType === 3) {
          translateTextNode(node, { protectDynamicContent: true });
        } else if (node.nodeType === 1) {
          localizeDom(node, { protectDynamicContent: true });
        }
      }
    }
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: LOCALIZABLE_ATTRIBUTES,
  });
  return () => observer.disconnect();
}

applyDocumentLocale();
