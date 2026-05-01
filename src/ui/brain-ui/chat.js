import { createMarkdownBody } from "./markdown.js";

export function initChat({
  apiBase,
  maxHistory,
  activationWarmupKey,
  getAgentName,
  defaultInputPlaceholder,
} = {}) {
  const chatHistory = document.getElementById("chat-history");
  const chatMessages = document.getElementById("chat-messages");
  const msgInput = document.getElementById("msg-input");
  const chatArea = document.getElementById("chat-area");
  const sendBtn = document.getElementById("send-btn");

  let inputLocked = false;
  let closeTimer = null;
  let hasPendingJarvisMessage = false;
  let pendingMessageDismissed = false;
  let audioCtx = null;
  let warmupTimer = null;

  function setComposerLocked(locked, reason = "") {
    inputLocked = locked;
    msgInput.disabled = locked;
    sendBtn.disabled = locked;
    msgInput.placeholder = locked ? (reason || "系统正在准备中…") : defaultInputPlaceholder();
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
    setComposerLocked(true, `系统刚激活，正在准备模型…约 ${seconds}s`);
    if (warmupTimer) clearTimeout(warmupTimer);
    warmupTimer = setTimeout(releaseWarmupLock, remaining);
  }

  function isHoveringChat() {
    return chatArea.matches(":hover") || chatHistory.matches(":hover") || chatMessages.matches(":hover");
  }

  function ensureAudioContext() {
    if (!audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      try { audioCtx = new AudioCtx(); } catch { return null; }
    }
    return audioCtx;
  }

  function unlockAudioOnFirstGesture() {
    const unlock = () => {
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
    return document.activeElement === msgInput || msgInput.value.trim().length > 0;
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
          if (r.role === "user" && r.from_id && r.from_id !== "ID:000001") {
            return { role: "external", text: r.content, label: r.from_id };
          }
          return { role: r.role, text: r.content };
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
    const { alert = role === "jarvis", pending = true, label } = options;
    const defaultLabel = role === "user" ? "You" : role === "jarvis" ? getAgentName() : "Peer";
    const labelText = label || defaultLabel;
    const div = document.createElement("div");
    div.className = `msg msg-${role}`;
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
  }

  async function restoreChatHistory() {
    const history = await fetchChatHistory();
    history.forEach(i => addMsg(i.role, i.text, { persist: false, alert: false, pending: false, label: i.label }));
    if (history.length) {
      pendingMessageDismissed = true;
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
  }

  async function send() {
    if (inputLocked) return;
    const text = msgInput.value.trim();
    if (!text) return;
    msgInput.value = "";
    addMsg("user", text);
    openChat();
    scheduleClose(1000);

    try {
      await fetch(`${apiBase}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text, from_id: "ID:000001" }),
      });
    } catch (error) {
      console.warn("[send]", error.message);
      addMsg("jarvis", "消息发送失败，请检查本地服务是否启动。");
      openChat(true);
    }
  }

  chatArea.addEventListener("mouseenter", () => {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    openChat();
  });
  chatArea.addEventListener("mouseleave", () => scheduleClose());
  msgInput.addEventListener("focus", () => openChat());
  msgInput.addEventListener("blur", () => { if (!isTyping()) scheduleClose(); });
  msgInput.addEventListener("input", () => {
    if (isTyping()) openChat();
    else if (!hasPendingJarvisMessage || pendingMessageDismissed) scheduleClose();
  });
  msgInput.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  sendBtn.addEventListener("click", send);

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

  return {
    addMsg,
    applyActivationWarmupLock,
    isComposerLocked: () => inputLocked,
    isTyping,
    openChat,
    restoreChatHistory,
    unlockAudioOnFirstGesture,
  };
}

