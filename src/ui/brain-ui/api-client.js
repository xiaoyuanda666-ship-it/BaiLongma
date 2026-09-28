const API_TOKEN_STORAGE_KEY = "bailongma-api-token";
const UI_CLIENT_ID_SESSION_KEY = "bailongma-ui-client-id";
const HTTP_PROTOCOL = /^https?:$/;
const browserWindow = globalThis.window;
const browserStorage = globalThis.localStorage;
const browserSessionStorage = globalThis.sessionStorage;

export const API = HTTP_PROTOCOL.test(browserWindow?.location?.protocol || "")
  ? browserWindow.location.origin
  : "http://localhost:3721";

function stripTokenFromLocation(url, source) {
  if (!browserWindow?.history?.replaceState) return;
  if (source === "hash") {
    const params = new URLSearchParams(url.hash.slice(1));
    params.delete("token");
    url.hash = params.toString() ? `#${params}` : "";
  } else {
    url.searchParams.delete("token");
  }
  browserWindow.history.replaceState(browserWindow.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function captureApiToken() {
  if (!HTTP_PROTOCOL.test(browserWindow?.location?.protocol || "") || !browserStorage) return "";
  const url = new URL(browserWindow.location.href);
  const hashToken = new URLSearchParams(url.hash.slice(1)).get("token")?.trim() || "";
  const queryToken = url.searchParams.get("token")?.trim() || "";
  const token = hashToken || queryToken;
  if (token) {
    browserStorage.setItem(API_TOKEN_STORAGE_KEY, token);
    stripTokenFromLocation(url, hashToken ? "hash" : "query");
    return token;
  }
  return browserStorage.getItem(API_TOKEN_STORAGE_KEY)?.trim() || "";
}

let apiToken = captureApiToken();
let fallbackUiClientId = "";
let cachedUiClientId = "";

function createUiClientId() {
  const randomId = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `ui-${randomId}`;
}

export function getUiClientId() {
  if (cachedUiClientId) return cachedUiClientId;
  try {
    const stored = browserSessionStorage?.getItem(UI_CLIENT_ID_SESSION_KEY)?.trim();
    if (stored) {
      cachedUiClientId = stored;
      return cachedUiClientId;
    }
    const created = createUiClientId();
    browserSessionStorage?.setItem(UI_CLIENT_ID_SESSION_KEY, created);
    fallbackUiClientId = created;
    cachedUiClientId = created;
    return cachedUiClientId;
  } catch {
    if (!fallbackUiClientId) fallbackUiClientId = createUiClientId();
    cachedUiClientId = fallbackUiClientId;
    return cachedUiClientId;
  }
}

export function isUiClientTarget(data = {}) {
  const target = String(
    data.target_client_id
      || data.targetClientId
      || data.reply_client_id
      || data.replyClientId
      || "",
  ).trim();
  return !target || target === getUiClientId();
}

export function getApiToken() {
  apiToken = browserStorage?.getItem(API_TOKEN_STORAGE_KEY)?.trim() || apiToken;
  return apiToken;
}

export function setApiToken(token) {
  apiToken = String(token || "").trim();
  if (!browserStorage) return;
  if (apiToken) browserStorage.setItem(API_TOKEN_STORAGE_KEY, apiToken);
  else browserStorage.removeItem(API_TOKEN_STORAGE_KEY);
}

function isApiRequest(input) {
  try {
    const raw = input instanceof Request ? input.url : String(input);
    return new URL(raw, browserWindow?.location?.href || `${API}/`).origin === API;
  } catch {
    return false;
  }
}

if (browserWindow?.fetch) {
  const nativeFetch = browserWindow.fetch.bind(browserWindow);
  browserWindow.fetch = function authenticatedFetch(input, init = {}) {
    const token = getApiToken();
    if (!isApiRequest(input)) return nativeFetch(input, init);

    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers || {}).forEach((value, key) => headers.set(key, value));
    if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
    if (!headers.has("X-Bailongma-Client-ID")) {
      headers.set("X-Bailongma-Client-ID", getUiClientId());
    }
    return nativeFetch(input, { ...init, headers });
  };
}

export function apiUrl(path) {
  return `${API}${path}`;
}

export function apiWebSocketUrl(path) {
  const url = new URL(path, `${API}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function base64UrlEncode(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function apiWebSocketProtocols() {
  const protocols = ["bailongma.v1"];
  const token = getApiToken();
  if (token) protocols.push(`bailongma.auth.${base64UrlEncode(token)}`);
  return protocols;
}

// Complete pairing before dependent modules open SSE, WebSocket or media URLs.
async function renewApiSession() {
  if (!getApiToken()) return;
  try {
    const response = await browserWindow.fetch(`${API}/auth/session`, { method: "POST" });
    if (!response.ok) throw new Error("连接口令无效，请重新打开设备配对链接。");
    browserWindow.document?.getElementById("api-pairing-error")?.remove();
  } catch (error) {
    // Desktop loopback access does not require a saved pairing token.
    if (["localhost", "127.0.0.1", "[::1]"].includes(browserWindow.location.hostname)) return;
    const showError = () => {
      const doc = browserWindow.document;
      if (!doc?.body || doc.getElementById("api-pairing-error")) return;
      const notice = doc.createElement("div");
      notice.id = "api-pairing-error";
      notice.setAttribute("role", "alert");
      notice.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:12px;background:#7f1d1d;color:white;text-align:center";
      notice.textContent = error.message || "连接失败，请检查网络后刷新页面。";
      doc.body.appendChild(notice);
    };
    if (browserWindow.document?.body) showError();
    else browserWindow.document?.addEventListener("DOMContentLoaded", showError, { once: true });
  }
}

if (browserWindow?.fetch && HTTP_PROTOCOL.test(browserWindow.location.protocol)) {
  await renewApiSession();
  // Refresh before the 12-hour cookie expiry, including after laptop sleep.
  const refreshTimer = setInterval(renewApiSession, 4 * 60 * 60 * 1000);
  refreshTimer.unref?.();
  browserWindow.addEventListener?.("focus", renewApiSession);
  browserWindow.addEventListener?.("online", renewApiSession);
}
