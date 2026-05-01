const TOOL_ZH = {
  send_message: "发送消息",
  express: "表达",
  read_file: "读取文件",
  write_file: "写入文件",
  delete_file: "删除文件",
  make_dir: "创建目录",
  list_dir: "查看目录",
  exec_command: "执行命令",
  kill_process: "终止进程",
  list_processes: "列出进程",
  web_search: "搜索网页",
  fetch_url: "抓取网页",
  browser_read: "浏览器读取网页",
  search_memory: "检索记忆",
  set_tick_interval: "调整节奏",
  speak: "朗读",
  generate_lyrics: "生成歌词",
  generate_music: "生成音乐",
  generate_image: "生成图片",
};

const TOOL_ICON = {
  send_message: "💬",
  express: "🗣️",
  read_file: "📄",
  write_file: "✏️",
  delete_file: "🗑️",
  make_dir: "📁",
  list_dir: "📂",
  exec_command: "⚡",
  kill_process: "🛑",
  list_processes: "📋",
  web_search: "🔎",
  fetch_url: "🌐",
  browser_read: "🧭",
  search_memory: "🔍",
  set_tick_interval: "⏱️",
  speak: "🔊",
  generate_lyrics: "🎵",
  generate_music: "🎼",
  generate_image: "🎨",
};

function isFailureResult(resultStr) {
  const t = (resultStr || "").trim();
  if (!t) return false;
  return /^(错误|失败|异常)[：:]/.test(t) || /^Error\b/i.test(t) || /^ERROR\b/.test(t);
}

export class ThoughtStream {
  constructor(innerId, color, options = {}) {
    this.el = document.getElementById(innerId);
    this.scroller = this.el?.parentElement || null;
    this.color = color;
    this.readCSSVar = options.readCSSVar || (() => "");
    this.thinkingLabel = options.thinkingLabel || "思考中";
    this.thinkingDoneLabel = options.thinkingDoneLabel || null;
    this.toolDetailLength = options.toolDetailLength || 160;
    this.startedAt = Date.now();
    this.curLine = null;
    this.thinkingEl = null;
    this.lastToolEl = null;
    this.statusEl = null;
    this.hadToolCall = false;
    this.toolFailed = false;
  }

  tStamp() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }

  trim() {
    if (!this.scroller) return;
    while (this.el.children.length > 1 && this.scroller.scrollHeight > this.scroller.clientHeight + 4) {
      this.el.firstChild?.remove();
    }
  }

  newLine(type = "stream", options = {}) {
    this.finalizeLastTool();
    this.thinkingLine = null;
    this.statusEl = null;
    this.hadToolCall = false;
    this.toolFailed = false;

    this.curLine = document.createElement("div");
    this.curLine.className = "stream-line";

    const color = this.readCSSVar(`--${this.color}`);
    const timeLabel = options.time || this.tStamp();

    const header = document.createElement("div");
    header.className = "line-header";
    header.innerHTML = `
      <span class="line-dot" style="background:${color}"></span>
      <span class="line-type" style="color:${color}"></span>
      <span class="line-time"></span>
    `;
    header.querySelector(".line-type").textContent = type;
    header.querySelector(".line-time").textContent = timeLabel;
    this.curLine.appendChild(header);

    if (options.content) {
      const textEl = document.createElement("div");
      textEl.className = "line-text";
      textEl.textContent = options.content;
      this.curLine.appendChild(textEl);
    }

    this.thinkingEl = null;

    this.el.appendChild(this.curLine);
    this.trim();
    this.scrollToLatest();
  }

  scrollToLatest() {
    if (!this.scroller) return;
    requestAnimationFrame(() => {
      this.scroller.scrollTop = this.scroller.scrollHeight;
    });
  }

  setStatus(text, kind = "busy") {
    if (!this.curLine) this.newLine(this.thinkingLabel);
    const header = this.curLine.querySelector(".line-header");
    if (!header) return;
    if (!this.statusEl || !this.statusEl.parentElement) {
      this.statusEl = document.createElement("span");
      this.statusEl.className = "line-status";
      const timeEl = header.querySelector(".line-time");
      header.insertBefore(this.statusEl, timeEl || null);
    }
    this.statusEl.className = `line-status ${kind}`.trim();
    this.statusEl.textContent = text;
  }

  clearStatus() {
    if (this.statusEl && this.statusEl.parentElement) {
      this.statusEl.remove();
    }
    this.statusEl = null;
  }

  startThinkingSession() {
    if (this.thinkingLine && this.thinkingLine.parentElement) {
      this.curLine = this.thinkingLine;
      const typeSpan = this.curLine.querySelector(".line-type");
      if (typeSpan) typeSpan.textContent = this.thinkingLabel;
      const timeSpan = this.curLine.querySelector(".line-time");
      if (timeSpan) timeSpan.textContent = this.tStamp();
    } else {
      this.newLine(this.thinkingLabel);
      this.thinkingLine = this.curLine;
    }
    this.clearStatus();
    this.startThinking();
  }

  startThinking() {
    if (!this.curLine) {
      this.newLine(this.thinkingLabel);
      this.thinkingLine = this.curLine;
    }
    if (this.thinkingEl) return;
    const el = document.createElement("div");
    el.className = "line-thinking";
    el.style.color = this.readCSSVar(`--${this.color}`);
    el.innerHTML = `<span class="dot"></span><span class="dot"></span><span class="dot"></span>`;
    this.curLine.appendChild(el);
    this.thinkingEl = el;
    this.scrollToLatest();
  }

  stopThinking() {
    if (this.thinkingEl) {
      this.thinkingEl.classList.add("done");
      if (this.thinkingDoneLabel) {
        const line = this.thinkingEl.parentElement;
        const typeSpan = line && line.querySelector(".line-type");
        if (typeSpan) typeSpan.textContent = this.thinkingDoneLabel;
      }
    }
    this.thinkingEl = null;
    this.clearStatus();
  }

  parseJsonResult(result) {
    try {
      const parsed = JSON.parse(String(result || ""));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  hostFromUrl(url) {
    try {
      return new URL(String(url || "")).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  }

  compactText(text, max = 180) {
    const compact = String(text || "").replace(/\s+/g, " ").trim();
    return compact.length > max ? compact.slice(0, max) + "…" : compact;
  }

  formatWebSearchDetail(payload) {
    const results = Array.isArray(payload.results) ? payload.results : [];
    if (payload.ok === false) {
      return `搜索失败：${payload.error || "没有拿到结果"}。关键词：${payload.query || "未提供"}`;
    }

    const lines = [`关键词：${payload.query || "未提供"}；找到 ${results.length} 条结果。`];
    results.slice(0, 3).forEach((item, index) => {
      const host = this.hostFromUrl(item.url);
      const title = this.compactText(item.title || item.url || "未命名结果", 70);
      const snippet = this.compactText(item.snippet || "", 90);
      lines.push(`${index + 1}. ${title}${host ? `（${host}）` : ""}${snippet ? `：${snippet}` : ""}`);
    });
    return lines.join(" ");
  }

  formatFetchUrlDetail(payload) {
    const host = this.hostFromUrl(payload.url);
    if (payload.ok === false) {
      const status = payload.status ? `HTTP ${payload.status}` : (payload.error || "请求失败");
      if (payload.error === "no readable content extracted") {
        return `未读到正文：页面能打开${host ? `（${host}）` : ""}，但只拿到空白、等待页或反爬验证内容。建议换一个可直接访问的来源。`;
      }
      return `读取失败：${status}${host ? `；来源：${host}` : ""}。${payload.hint ? this.compactText(payload.hint, 90) : "可以换一个可访问来源。"}`;
    }

    const title = this.compactText(payload.title || host || payload.url || "网页", 80);
    const content = this.compactText(payload.content || "", 220);
    return `已读取：${title}${host ? `（${host}）` : ""}。${content || "页面能打开，但没有提取到可用正文。"}`;
  }

  formatBrowserReadDetail(payload) {
    const host = this.hostFromUrl(payload.final_url || payload.url);
    if (payload.ok === false) {
      if (payload.error === "no readable content rendered") {
        return `浏览器已打开页面${host ? `（${host}）` : ""}，但仍未读到正文；可能需要登录、验证码或阻止自动化访问。建议换来源。`;
      }
      return `浏览器读取失败${host ? `（${host}）` : ""}：${this.compactText(payload.error || "页面无法渲染", 120)}`;
    }

    const title = this.compactText(payload.title || host || payload.final_url || payload.url || "网页", 80);
    const content = this.compactText(payload.content || "", 240);
    return `浏览器已读取：${title}${host ? `（${host}）` : ""}。${content || "页面已渲染，但没有提取到可用正文。"}`;
  }

  formatToolDetail(name, result) {
    const parsed = this.parseJsonResult(result);
    if (parsed?.tool === "web_search" || name === "web_search") return this.formatWebSearchDetail(parsed || {});
    if (parsed?.tool === "fetch_url" || name === "fetch_url") return this.formatFetchUrlDetail(parsed || {});
    if (parsed?.tool === "browser_read" || name === "browser_read") return this.formatBrowserReadDetail(parsed || {});

    const trimmed = String(result ?? "").trim();
    return this.compactText(trimmed.replace(/\s+/g, " "), this.toolDetailLength);
  }

  finalizeLastTool() {
    if (this.lastToolEl) {
      this.lastToolEl.classList.add("done");
      this.lastToolEl = null;
    }
  }

  tool(name, args, result, ok = undefined) {
    if (!this.curLine) this.newLine("工具调用");
    this.finalizeLastTool();

    const zh = TOOL_ZH[name] || name;
    const icon = TOOL_ICON[name] || "🔧";
    const resultStr = result == null ? "" : String(result);
    const failure = ok === false || (ok !== true && isFailureResult(resultStr));
    this.hadToolCall = true;
    this.toolFailed = this.toolFailed || failure;
    const statusCls = failure ? "failed" : "success";
    const statusIcon = failure ? "✗" : "✓";
    const statusLabel = failure ? "失败" : "成功";

    const toolEl = document.createElement("div");
    toolEl.className = `line-tool done tool-${statusCls}`;
    toolEl.style.color = this.readCSSVar(`--${this.color}`);

    const iconSpan = document.createElement("span");
    iconSpan.className = "tool-icon";
    iconSpan.textContent = icon;
    const nameSpan = document.createElement("span");
    nameSpan.className = "tool-name";
    nameSpan.textContent = zh;
    const statusSpan = document.createElement("span");
    statusSpan.className = `tool-status ${statusCls}`;
    statusSpan.textContent = `${statusIcon} ${statusLabel}`;
    toolEl.appendChild(iconSpan);
    toolEl.appendChild(nameSpan);
    toolEl.appendChild(statusSpan);
    this.curLine.appendChild(toolEl);

    const detailText = this.formatToolDetail(name, resultStr);
    if (detailText) {
      const detail = document.createElement("div");
      detail.className = "line-tool-detail";
      detail.textContent = detailText;
      this.curLine.appendChild(detail);
    }

    this.scrollToLatest();
    this.lastToolEl = null;
  }

  appendToolCycleEnd() {
    if (!this.curLine) return;

    const toolEl = document.createElement("div");
    const statusCls = this.toolFailed ? "failed" : "ended";
    toolEl.className = `line-tool done tool-${statusCls}`;
    toolEl.style.color = this.readCSSVar(`--${this.color}`);

    const iconSpan = document.createElement("span");
    iconSpan.className = "tool-icon";
    iconSpan.textContent = this.toolFailed ? "⚠" : "◎";

    const nameSpan = document.createElement("span");
    nameSpan.className = "tool-name";
    nameSpan.textContent = this.hadToolCall ? "工具调用结束" : "本轮结束";

    const statusSpan = document.createElement("span");
    statusSpan.className = `tool-status ${statusCls}`;
    statusSpan.textContent = this.toolFailed ? "已结束" : "完成";

    toolEl.appendChild(iconSpan);
    toolEl.appendChild(nameSpan);
    toolEl.appendChild(statusSpan);
    this.curLine.appendChild(toolEl);
    this.scrollToLatest();
  }

  end() {
    this.stopThinking();
    this.finalizeLastTool();
    this.clearStatus();
    this.appendToolCycleEnd();
    this.curLine = null;
    this.thinkingLine = null;
    this.hadToolCall = false;
    this.toolFailed = false;
  }
}

