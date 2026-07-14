import { createMarkdownBody } from "./markdown.js";
import { isAlertEnabled } from "./alert-sound-pref.js";

// 把数据库/事件里的细粒度 channel 名转成 UI 友好的简化标签
export function friendlyChannelLabel(channel) {
  if (!channel) return "";
  const c = String(channel).toUpperCase();
  if (c === "WECHAT_CLAWBOT" || c === "WECHAT_OFFICIAL" || c === "WECHAT") return "WeChat";
  if (c === "WECOM") return "WeCom";
  if (c === "DISCORD") return "Discord";
  if (c === "FEISHU") return "Feishu";
  return "";
}

export function shouldAttachSystemScreenshot() {
  return false;
}

export function initChat({
  apiBase,
  maxHistory,
  activationWarmupKey,
  getAgentName,
  defaultInputPlaceholder,
  onUserMessage = null,
  openSettings = null,
} = {}) {
  const chatHistory = document.getElementById("chat-history");
  const chatMessages = document.getElementById("chat-messages");
  const msgInput = document.getElementById("msg-input");
  const chatArea = document.getElementById("chat-area");
  const sendBtn = document.getElementById("send-btn");
  const pasteAttachments = document.getElementById("paste-attachments");

  let inputLocked = false;
  const pendingLocalSends = new Set();
  const pendingPastedImages = [];
  let closeTimer = null;
  let hasPendingJarvisMessage = false;
  let pendingMessageDismissed = false;
  let liveEl = null;  // 正在流式输出的 jarvis 气泡（边收 token 边重渲染），message 事件到达后定稿
  let audioCtx = null;
  let audioUnlocked = false;
  let warmupTimer = null;
  const renderedMessageIds = new Set();
  const recentRenderedKeys = new Map();
  const RENDER_DEDUPE_TTL_MS = 2 * 60 * 1000;

  const PUSH_TO_TALK_PLACEHOLDER = "按住空格键开始说话";
  const MAX_PASTED_IMAGES = 8;
  const MAX_PASTED_IMAGE_BYTES = 12 * 1024 * 1024;

  function normalizeMessageId(value) {
    if (value === undefined || value === null || value === "") return "";
    return String(value);
  }

  function renderedKey(role, text, label) {
    const cleanText = String(text || "").replace(/\s+/g, " ").trim();
    if (!cleanText) return "";
    return `${role || ""}\n${label || ""}\n${cleanText}`;
  }

  function pruneRenderedKeys(now = Date.now()) {
    for (const [key, ts] of recentRenderedKeys) {
      if (now - ts > RENDER_DEDUPE_TTL_MS) recentRenderedKeys.delete(key);
    }
  }

  function claimRenderedMessage({ messageId, role, text, label, source = "event", dedupe = true } = {}) {
    const id = normalizeMessageId(messageId);
    const now = Date.now();
    pruneRenderedKeys(now);
    if (id && renderedMessageIds.has(id)) return false;
    const key = renderedKey(role, text, label);
    const allowContentDedupe = source === "history" || !id;
    if (dedupe && allowContentDedupe && key && recentRenderedKeys.has(key)) {
      if (id) renderedMessageIds.add(id);
      return false;
    }
    if (id) renderedMessageIds.add(id);
    if (key && (!id || dedupe === false)) recentRenderedKeys.set(key, now);
    return true;
  }

  // 多行输入：每次内容变化时把高度重置为内容实际高度（上限由 CSS max-height 接管、超出后内部滚动）。
  function autoGrowInput() {
    msgInput.style.height = "auto";
    msgInput.style.height = msgInput.scrollHeight + "px";
  }

  // 聚焦输入框时提示发消息，未聚焦时提示语音输入
  function idlePlaceholder() {
    return document.activeElement === msgInput ? defaultInputPlaceholder() : PUSH_TO_TALK_PLACEHOLDER;
  }

  function setComposerLocked(locked, reason = "") {
    inputLocked = locked;
    msgInput.disabled = locked;
    sendBtn.disabled = locked;
    msgInput.placeholder = locked ? (reason || "系统准备中…") : idlePlaceholder();
  }

  function releaseWarmupLock() {
    if (warmupTimer) {
      clearTimeout(warmupTimer);
      warmupTimer = null;
    }
    try { sessionStorage.removeItem(activationWarmupKey); } catch {}
    setComposerLocked(false);
  }

  function applyActivationWarmupLock() {
    let until = 0;
    try {
      until = Number(sessionStorage.getItem(activationWarmupKey) || 0);
    } catch {}

    const remaining = until - Date.now();
    if (remaining <= 0) {
      releaseWarmupLock();
      return;
    }

    const seconds = Math.max(1, Math.ceil(remaining / 1000));
    setComposerLocked(true, `刚激活 — 模型预热中… ~${seconds}s`);
    if (warmupTimer) clearTimeout(warmupTimer);
    warmupTimer = setTimeout(releaseWarmupLock, remaining);
  }

  function isHoveringChat() {
    return chatArea.matches(":hover") || chatHistory.matches(":hover") || chatMessages.matches(":hover");
  }

  function ensureAudioContext() {
    if (!audioCtx) {
      if (!audioUnlocked) return null;  // Don't create before a user gesture — avoids Chrome autoplay warning
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      try { audioCtx = new AudioCtx(); } catch { return null; }
    }
    return audioCtx;
  }

  function unlockAudioOnFirstGesture() {
    const unlock = () => {
      if (audioUnlocked) return;
      audioUnlocked = true;
      // Create/resume AudioContext only after the first user gesture — avoids Chrome autoplay policy warning
      const ctx = ensureAudioContext();
      if (ctx && ctx.state === "suspended") {
        ctx.resume().catch(() => {});
      }
      window.removeEventListener("pointerdown", unlock, true);
      window.removeEventListener("keydown", unlock, true);
      window.removeEventListener("touchstart", unlock, true);
    };
    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("keydown", unlock, true);
    window.addEventListener("touchstart", unlock, true);
  }

  async function playJarvisAlert() {
    // 回复提示音开关（默认开）：用户可在设置里关闭。深夜工作可静音，TTS 朗读不受影响。
    if (!isAlertEnabled()) return;
    const ctx = ensureAudioContext();
    if (!ctx) return;
    try { if (ctx.state === "suspended") await ctx.resume(); } catch { return; }
    if (ctx.state !== "running") return;
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.3, now + 0.02);
    master.gain.exponentialRampToValueAtTime(0.18, now + 0.28);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
    master.connect(ctx.destination);

    const oscA = ctx.createOscillator();
    oscA.type = "sine";
    oscA.frequency.setValueAtTime(740, now);
    oscA.frequency.exponentialRampToValueAtTime(880, now + 0.18);
    oscA.connect(master);

    const oscB = ctx.createOscillator();
    oscB.type = "triangle";
    oscB.frequency.setValueAtTime(1110, now + 0.12);
    oscB.frequency.exponentialRampToValueAtTime(1320, now + 0.34);
    oscB.connect(master);

    oscA.start(now); oscA.stop(now + 0.32);
    oscB.start(now + 0.12); oscB.stop(now + 0.5);

    oscA.addEventListener("ended", () => oscA.disconnect(), { once: true });
    oscB.addEventListener("ended", () => oscB.disconnect(), { once: true });
    setTimeout(() => master.disconnect(), 700);
  }

  function isTyping() {
    return document.activeElement === msgInput || msgInput.value.trim().length > 0 || pendingPastedImages.length > 0;
  }

  async function fetchChatHistory() {
    try {
      const res = await fetch(`${apiBase}/conversations?limit=${maxHistory}`);
      if (!res.ok) return [];
      const rows = await res.json();
      if (!Array.isArray(rows)) return [];
      return rows
        .filter(r => r && (r.role === "user" || r.role === "jarvis") && typeof r.content === "string")
        .map(r => {
          // 外部渠道判定：channel 非空且不是本地（TUI/API），或 from_id 仍带外部前缀（兼容历史数据）
          const channel = (r.channel || "").toUpperCase();
          const isExternal =
            r.role === "user"
            && ((channel && channel !== "TUI" && channel !== "API" && channel !== "SYSTEM" && channel !== "REMINDER" && channel !== "APP_SIGNAL" && channel !== "VOICE" && channel !== "语音识别")
                || /^(wechat|discord|feishu|wecom):/i.test(r.from_id || ""));
          if (isExternal) {
            const label = friendlyChannelLabel(r.channel) || r.from_id;
            return { role: "external", text: r.content, label, messageId: r.id };
          }
          return { role: r.role, text: r.content, messageId: r.id };
        });
    } catch { return []; }
  }

  function openChat(autoClose = false) {
    chatHistory.classList.add("open");
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    if (autoClose && (!hasPendingJarvisMessage || pendingMessageDismissed) && !isTyping()) scheduleClose(4500);
  }

  function closeChat() {
    if ((hasPendingJarvisMessage && !pendingMessageDismissed) || isTyping() || isHoveringChat()) return;
    chatHistory.classList.remove("open");
  }

  function scheduleClose(ms = 100) {
    if ((hasPendingJarvisMessage && !pendingMessageDismissed) || isTyping() || isHoveringChat()) return;
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(closeChat, ms);
  }

  function addMsg(role, text, options = {}) {
    const { alert = role === "jarvis", pending = true, label, messageId, source = "event", dedupe = true } = options;
    const defaultLabel = role === "user" ? "You" : role === "jarvis" ? getAgentName() : "Peer";
    const labelText = label || defaultLabel;
    if (!claimRenderedMessage({ messageId, role, text, label: labelText, source, dedupe })) return false;
    const div = document.createElement("div");
    div.className = `msg msg-${role}`;
    const normalizedId = normalizeMessageId(messageId);
    if (normalizedId) div.dataset.messageId = normalizedId;
    const labelSpan = document.createElement("span");
    labelSpan.className = "msg-label";
    labelSpan.textContent = labelText;
    div.appendChild(labelSpan);
    div.appendChild(createMarkdownBody(text));
    chatMessages.appendChild(div);

    while (chatMessages.children.length > maxHistory) {
      chatMessages.removeChild(chatMessages.firstChild);
    }

    if (role === "jarvis") {
      hasPendingJarvisMessage = pending;
      pendingMessageDismissed = !pending;
      if (alert) playJarvisAlert();
      if (pending) openChat();
    } else if (role === "user") {
      hasPendingJarvisMessage = false;
      pendingMessageDismissed = false;
    }

    chatMessages.scrollTop = chatMessages.scrollHeight;
    return true;
  }

  async function restoreChatHistory() {
    const history = await fetchChatHistory();
    history.forEach(i => addMsg(i.role, i.text, {
      persist: false,
      alert: false,
      pending: false,
      label: i.label,
      messageId: i.messageId,
      source: "history",
    }));
    if (history.length) {
      pendingMessageDismissed = true;
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
  }

  // text 显式传入时直接发送、不经过输入框（语音识别用：voice 完全不在 msg-input 留草稿）；
  // 不传 text 则保持原行为，从输入框读取并清空。
  function newClientMessageId() {
    const cryptoObj = globalThis.crypto;
    if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
    const rand = Math.random().toString(36).slice(2, 10);
    return `local-${Date.now().toString(36)}-${rand}`;
  }

  function localSendKey(channel, text, attachments = []) {
    const mediaKey = attachments
      .map(item => `${item.id || ""}:${item.name || ""}:${String(item.data_url || "").length}`)
      .join("|");
    return `${String(channel || "TUI").toUpperCase()}\n${String(text || "").trim()}\n${mediaKey}`;
  }

  function safeMarkdownAlt(value, fallback = "image") {
    return String(value || fallback).replace(/[\]\r\n]/g, " ").trim() || fallback;
  }

  function markdownImage(dataUrl, alt = "image") {
    return `![${safeMarkdownAlt(alt)}](${dataUrl})`;
  }

  function appendAttachmentMarkdown(content = "", attachments = []) {
    const images = attachments
      .filter(item => item?.data_url)
      .map(item => markdownImage(item.data_url, item.alt || item.name || "image"));
    return [images.join("\n"), String(content || "").trim()].filter(Boolean).join("\n\n");
  }

  function imageExtFromMime(mime = "") {
    const type = String(mime || "").split(";")[0].trim().toLowerCase();
    if (type === "image/jpeg" || type === "image/jpg") return ".jpg";
    if (type === "image/gif") return ".gif";
    if (type === "image/webp") return ".webp";
    if (type === "image/bmp") return ".bmp";
    return ".png";
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("failed to read pasted image"));
      reader.readAsDataURL(file);
    });
  }

  function collectClipboardImageFiles(event) {
    const data = event.clipboardData;
    if (!data) return [];
    const files = [];
    const seen = new Set();
    const pushFile = (file) => {
      if (!file || !String(file.type || "").startsWith("image/")) return;
      const key = `${file.name || ""}:${file.type || ""}:${file.size || 0}:${file.lastModified || 0}`;
      if (seen.has(key)) return;
      seen.add(key);
      files.push(file);
    };

    for (const item of Array.from(data.items || [])) {
      if (item?.kind === "file" && String(item.type || "").startsWith("image/")) {
        pushFile(item.getAsFile());
      }
    }
    for (const file of Array.from(data.files || [])) pushFile(file);
    return files;
  }

  function renderPastedImages() {
    if (!pasteAttachments) return;
    pasteAttachments.replaceChildren();
    pasteAttachments.hidden = pendingPastedImages.length === 0;
    pendingPastedImages.forEach((item, index) => {
      const shell = document.createElement("div");
      shell.className = "paste-attachment";

      const img = document.createElement("img");
      img.src = item.data_url;
      img.alt = item.alt || "pasted image";
      img.draggable = false;
      shell.appendChild(img);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "paste-attachment-remove";
      remove.setAttribute("aria-label", "Remove image");
      remove.title = "Remove image";
      remove.textContent = "\u00d7";
      remove.addEventListener("click", (event) => {
        event.preventDefault();
        pendingPastedImages.splice(index, 1);
        renderPastedImages();
        try { msgInput.focus(); } catch {}
      });
      shell.appendChild(remove);

      pasteAttachments.appendChild(shell);
    });
  }

  function clearPastedImages() {
    pendingPastedImages.length = 0;
    renderPastedImages();
  }

  function snapshotPastedImages() {
    return pendingPastedImages.map(item => ({
      id: item.id,
      data_url: item.data_url,
      alt: item.alt || "pasted image",
      name: item.name || "pasted-image.png",
      source: "paste",
    }));
  }

  async function addPastedImageFiles(files = []) {
    const slots = Math.max(0, MAX_PASTED_IMAGES - pendingPastedImages.length);
    if (slots <= 0) return;
    const accepted = files
      .filter(file => {
        if (!file || file.size > MAX_PASTED_IMAGE_BYTES) {
          console.warn("[paste image] ignored oversized image");
          return false;
        }
        return true;
      })
      .slice(0, slots);
    if (!accepted.length) return;

    const images = await Promise.all(accepted.map(async (file, offset) => {
      try {
        const dataUrl = await readFileAsDataUrl(file);
        if (!/^data:image\//i.test(dataUrl)) return null;
        const ext = imageExtFromMime(file.type);
        return {
          id: newClientMessageId(),
          data_url: dataUrl,
          alt: "pasted image",
          name: file.name || `pasted-image-${pendingPastedImages.length + offset + 1}${ext}`,
        };
      } catch (error) {
        console.warn("[paste image]", error?.message || error);
        return null;
      }
    }));

    // Chromium/Electron may expose one pasted image through both clipboardData.items
    // and clipboardData.files. File metadata can differ, so dedupe after reading bytes.
    const seenDataUrls = new Set();
    for (const image of images) {
      if (!image || seenDataUrls.has(image.data_url)) continue;
      seenDataUrls.add(image.data_url);
      pendingPastedImages.push(image);
    }
    renderPastedImages();
    openChat();
  }

  async function send({ channel = null, label = null, text = null } = {}) {
    if (inputLocked) return;
    const fromInput = (text == null);
    const rawContent = (fromInput ? msgInput.value : text).trim();
    const pastedAttachments = fromInput ? snapshotPastedImages() : [];
    if (!rawContent && pastedAttachments.length === 0) return;
    const pendingKey = localSendKey(channel, rawContent, pastedAttachments);
    if (pendingLocalSends.has(pendingKey)) return;
    pendingLocalSends.add(pendingKey);
    if (fromInput) {
      msgInput.value = "";
      clearPastedImages();
      autoGrowInput();
    }
    const prepared = { content: rawContent, displayContent: rawContent, attachments: [] };
    prepared.attachments = [...(prepared.attachments || []), ...pastedAttachments];
    prepared.displayContent = appendAttachmentMarkdown(prepared.displayContent || prepared.content, pastedAttachments);
    const content = prepared.content;
    if (!content && !prepared.attachments.length) {
      pendingLocalSends.delete(pendingKey);
      return;
    }
    // If onUserMessage returns a string, use it as the backend payload; if it returns false, skip the backend call
    const override = onUserMessage?.(content);
    addMsg("user", prepared.displayContent || content, { label: label || undefined, dedupe: false });
    openChat();
    scheduleClose(1000);
    if (override === false) {
      pendingLocalSends.delete(pendingKey);
      return;
    }

    try {
      const backendText = (typeof override === "string") ? override : content;
      const payload = { content: backendText, from_id: "ID:000001", client_message_id: newClientMessageId() };
      if (prepared.attachments.length && backendText === content) payload.attachments = prepared.attachments;
      if (channel) payload.channel = channel;
      const resp = await fetch(`${apiBase}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        let message = `HTTP ${resp.status}`;
        try {
          const body = await resp.json();
          message = body.error || body.message || message;
        } catch {}
        throw new Error(message);
      }
    } catch (error) {
      console.warn("[send]", error.message);
      addMsg("jarvis", "发送失败 — 请检查本地服务是否运行。");
      openChat(true);
    } finally {
      pendingLocalSends.delete(pendingKey);
    }
  }

  chatArea.addEventListener("mouseenter", () => {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    openChat();
  });
  chatArea.addEventListener("mouseleave", () => scheduleClose());
  msgInput.addEventListener("focus", () => {
    openChat();
    if (!inputLocked) msgInput.placeholder = defaultInputPlaceholder();
  });
  msgInput.addEventListener("blur", () => {
    if (!inputLocked) msgInput.placeholder = PUSH_TO_TALK_PLACEHOLDER;
    if (!isTyping()) scheduleClose();
    // 延迟关闭，让命令项的 mousedown 先触发
    setTimeout(hideSlashMenu, 120);
  });
  msgInput.addEventListener("input", () => {
    autoGrowInput();
    updateSlashMenu();
    if (isTyping()) openChat();
    else if (!hasPendingJarvisMessage || pendingMessageDismissed) scheduleClose();
  });
  msgInput.addEventListener("paste", (event) => {
    const imageFiles = collectClipboardImageFiles(event);
    if (imageFiles.length) {
      addPastedImageFiles(imageFiles);
      openChat();
    }
  });
  msgInput.addEventListener("keydown", event => {
    if (handleSlashKeydown(event)) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  sendBtn.addEventListener("click", () => send());

  // 初始未聚焦：显示语音输入提示
  if (!inputLocked) msgInput.placeholder = idlePlaceholder();

  // ── 斜杠命令 ────────────────────────────────────────────────
  // 输入框以 "/" 开头时弹出命令菜单。ASR/TTS/LLM 直接打开对应设置面板；
  // 视频生成无独立面板，预填一句配置请求由 Agent 引导。
  const slashMenu = document.getElementById("slash-menu");
  const SLASH_COMMANDS = [
    {
      cmd: "/llm", keys: ["llm", "模型", "model"],
      label: "配置 LLM 模型", desc: "选择大模型服务商并填入 API Key",
      run: () => openSettings?.("llm"),
    },
    {
      cmd: "/voice", keys: ["voice", "asr", "语音对话", "语音识别", "shibie"],
      label: "配置语音对话", desc: "麦克风转文字 + 回复转语音",
      run: () => openSettings?.("voice"),
    },
    {
      cmd: "/tts", keys: ["tts", "语音合成", "hecheng"],
      label: "配置语音合成", desc: "Agent 回复转语音 · 豆包/MiniMax/OpenAI",
      run: openVoiceTTS,
    },
    {
      cmd: "/video", keys: ["video", "视频", "视频生成", "seedance", "huoshan"],
      label: "配置视频生成", desc: "AI 视频生成 · 火山方舟 Seedance",
      run: prefillVideoConfig,
    },
    {
      cmd: "/help", keys: ["help", "帮助", "命令"],
      label: "查看全部命令", desc: "列出所有可用斜杠命令",
      run: showSlashHelp,
    },
  ];

  let slashItems = [];    // 当前过滤后的命令
  let slashActive = -1;   // 当前高亮索引

  function slashQuery() {
    const v = msgInput.value;
    if (!v.startsWith("/")) return null;
    return v.slice(1).trim().toLowerCase();
  }

  function filterSlash(q) {
    if (!q) return SLASH_COMMANDS.slice();
    return SLASH_COMMANDS.filter(c =>
      c.cmd.slice(1).startsWith(q) ||
      c.keys.some(k => k.toLowerCase().includes(q)) ||
      c.label.includes(q)
    );
  }

  function renderSlashMenu() {
    slashMenu.innerHTML = "";
    if (!slashItems.length) {
      const empty = document.createElement("div");
      empty.className = "slash-empty";
      empty.textContent = "无匹配命令";
      slashMenu.appendChild(empty);
      return;
    }
    slashItems.forEach((c, i) => {
      const item = document.createElement("div");
      item.className = "slash-item" + (i === slashActive ? " active" : "");
      item.setAttribute("role", "option");
      item.innerHTML =
        '<span class="slash-cmd"></span>' +
        '<span class="slash-text"><div class="slash-label"></div><div class="slash-desc"></div></span>';
      item.querySelector(".slash-cmd").textContent = c.cmd;
      item.querySelector(".slash-label").textContent = c.label;
      item.querySelector(".slash-desc").textContent = c.desc;
      // 用 mousedown 而非 click：抢在输入框 blur 之前执行，保留焦点
      item.addEventListener("mousedown", (e) => { e.preventDefault(); runSlash(c); });
      item.addEventListener("mouseenter", () => { slashActive = i; highlightSlash(); });
      slashMenu.appendChild(item);
    });
  }

  function highlightSlash() {
    Array.from(slashMenu.children).forEach((el, i) =>
      el.classList.toggle("active", i === slashActive));
  }

  function updateSlashMenu() {
    const q = slashQuery();
    if (q === null) { hideSlashMenu(); return; }
    slashItems = filterSlash(q);
    slashActive = slashItems.length ? 0 : -1;
    renderSlashMenu();
    slashMenu.hidden = false;
  }

  function hideSlashMenu() {
    slashMenu.hidden = true;
    slashItems = [];
    slashActive = -1;
  }

  function handleSlashKeydown(event) {
    if (slashMenu.hidden) return false;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (slashItems.length) { slashActive = (slashActive + 1) % slashItems.length; highlightSlash(); }
        return true;
      case "ArrowUp":
        event.preventDefault();
        if (slashItems.length) { slashActive = (slashActive - 1 + slashItems.length) % slashItems.length; highlightSlash(); }
        return true;
      case "Tab":
      case "Enter":
        if (slashActive >= 0 && slashItems[slashActive]) {
          event.preventDefault();
          runSlash(slashItems[slashActive]);
          return true;
        }
        return false;
      case "Escape":
        event.preventDefault();
        hideSlashMenu();
        return true;
      default:
        return false;
    }
  }

  function runSlash(c) {
    hideSlashMenu();
    msgInput.value = "";   // 清掉已输入的 "/xxx"
    autoGrowInput();
    try { c.run(); } catch (e) { console.warn("[slash]", c.cmd, e); }
  }

  function openVoiceTTS() {
    openSettings?.("voice");
    setTimeout(() => {
      document.getElementById("settings-tts-section")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
  }

  function prefillVideoConfig() {
    // 视频生成（火山方舟 Seedance）没有独立设置面板，靠对话引导配置
    msgInput.value = "我想配置视频生成（火山方舟 Seedance），请告诉我怎么申请 API Key 以及如何填入";
    openChat();
    autoGrowInput();
    try { msgInput.focus(); } catch {}
  }

  function showSlashHelp() {
    const lines = SLASH_COMMANDS.map(c => `· \`${c.cmd}\` — ${c.label}：${c.desc}`).join("\n");
    addMsg("jarvis", `可用命令（在输入框输入 \`/\` 调出菜单）：\n\n${lines}`, { alert: false, pending: false });
    openChat();
  }

  document.addEventListener("pointerdown", event => {
    if (chatArea.contains(event.target)) return;
    if (hasPendingJarvisMessage && !isTyping()) {
      pendingMessageDismissed = true;
      closeChat();
      return;
    }
    if (!isTyping()) {
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
      chatHistory.classList.remove("open");
    }
  });

  function deleteLastUserMsg() {
    const msgs = chatMessages.querySelectorAll('.msg-user')
    if (!msgs.length) return
    const last = msgs[msgs.length - 1]
    last.style.transition = 'opacity 0.3s ease'
    last.style.opacity = '0'
    setTimeout(() => last.remove(), 300)
  }

  // ── 流式回复气泡 ───────────────────────────────────────────────
  // 后端 LLM 边生成边通过 stream_chunk 推 token；这里先建一个空的 jarvis 气泡，
  // 随 token 到达不断重渲染，等权威的 message 事件到达再 finalize 成最终干净全文。
  // 该气泡始终是最后一个 .msg-jarvis，所以打断 ✋（updateLastJarvisMsg）照常作用其上。
  function beginLiveJarvisMsg({ alert = true } = {}) {
    if (liveEl) finalizeLiveJarvisMsg(null);  // 兜底：上一轮孤儿气泡先定稿
    const div = document.createElement("div");
    div.className = "msg msg-jarvis msg-live";
    const labelSpan = document.createElement("span");
    labelSpan.className = "msg-label";
    labelSpan.textContent = getAgentName();
    div.appendChild(labelSpan);
    div.appendChild(createMarkdownBody(""));
    chatMessages.appendChild(div);
    while (chatMessages.children.length > maxHistory) {
      chatMessages.removeChild(chatMessages.firstChild);
    }
    liveEl = div;
    hasPendingJarvisMessage = true;
    pendingMessageDismissed = false;
    if (alert) playJarvisAlert();
    openChat();
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function updateLiveJarvisMsg(text) {
    if (!liveEl) return;
    const children = Array.from(liveEl.children);
    for (let i = 1; i < children.length; i++) children[i].remove();
    liveEl.appendChild(createMarkdownBody(text));
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // text 为字符串则替换为权威全文；为 null 仅去掉 live 标记（保留已流出的内容）
  function finalizeLiveJarvisMsg(text, options = {}) {
    if (!liveEl) return false;
    if (typeof text === "string") {
      const labelText = getAgentName();
      if (!claimRenderedMessage({ messageId: options.messageId, role: "jarvis", text, label: labelText, source: options.source || "event" })) {
        liveEl.remove();
        liveEl = null;
        return false;
      }
      const normalizedId = normalizeMessageId(options.messageId);
      if (normalizedId) liveEl.dataset.messageId = normalizedId;
      const children = Array.from(liveEl.children);
      for (let i = 1; i < children.length; i++) children[i].remove();
      liveEl.appendChild(createMarkdownBody(text));
    }
    liveEl.classList.remove("msg-live");
    liveEl = null;
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return true;
  }

  function hasLiveJarvisMsg() { return !!liveEl; }

  function updateLastJarvisMsg(newText) {
    const msgs = chatMessages.querySelectorAll('.msg-jarvis');
    if (!msgs.length) return;
    const last = msgs[msgs.length - 1];
    // Remove the original markdown body (all child nodes after the label span)
    const children = Array.from(last.children);
    for (let i = 1; i < children.length; i++) children[i].remove();
    last.appendChild(createMarkdownBody(newText));
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  return {
    addMsg,
    deleteLastUserMsg,
    updateLastJarvisMsg,
    beginLiveJarvisMsg,
    updateLiveJarvisMsg,
    finalizeLiveJarvisMsg,
    hasLiveJarvisMsg,
    applyActivationWarmupLock,
    isComposerLocked: () => inputLocked,
    isTyping,
    openChat,
    restoreChatHistory,
    send,
    unlockAudioOnFirstGesture,
  };
}
