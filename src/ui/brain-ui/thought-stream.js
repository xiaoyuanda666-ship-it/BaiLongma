import { t, translateUiText } from "./i18n/index.js";

const TOOL_ZH = {
  send_message: "发送消息",
  express: "表达",
  read_file: "读取文件",
  write_file: "写入文件",
  edit_file: "编辑文件",
  delete_file: "删除文件",
  make_dir: "创建目录",
  list_dir: "查看目录",
  run_command: "执行命令",
  exec_command: "执行命令（旧版）",
  exec_quick_command: "快速命令",
  exec_task_command: "任务命令",
  exec_background_command: "后台命令",
  download_file: "下载文件",
  kill_process: "终止进程",
  list_processes: "列出进程",
  web_search: "搜索网页",
  web_read: "读取网页",
  fetch_url: "抓取网页",
  browser_read: "浏览器读取网页",
  browser_navigate: "打开网页",
  browser_navigate_back: "返回上一页",
  browser_navigate_forward: "前进到下一页",
  browser_reload: "重新加载网页",
  browser_snapshot: "查看页面内容",
  browser_find: "查找页面内容",
  browser_click: "点击页面元素",
  browser_type: "输入内容",
  browser_fill_form: "填写表单",
  browser_select_option: "选择选项",
  browser_press_key: "操作键盘",
  browser_hover: "悬停页面元素",
  browser_drag: "拖动页面元素",
  browser_wait_for: "等待页面响应",
  browser_handle_dialog: "处理网页弹窗",
  browser_tabs: "管理浏览器标签页",
  browser_take_screenshot: "截取网页画面",
  browser_console_messages: "检查网页日志",
  browser_resize: "调整浏览器窗口",
  browser_close: "关闭网页",
  browser_clear_data: "清理浏览器数据",
  browser_set_display_mode: "切换浏览器大小",
  system_browser_open: "用电脑浏览器打开",
  search_memory: "检索记忆",
  probe_memory: "探测记忆",
  upsert_memory: "写入记忆",
  merge_memories: "合并记忆",
  downgrade_memory: "降级记忆",
  recall_memory: "唤起记忆",
  skip_recognition: "跳过识别",
  skip_consolidation: "跳过整理",
  set_tick_interval: "调整节奏",
  speak: "朗读",
  generate_lyrics: "生成歌词",
  generate_music: "生成音乐",
  generate_image: "生成图片",
  ui_set: "投影界面",
  focus_banner: "专注横幅",
  set_task: "启动任务",
  complete_task: "完成任务",
  update_task_step: "推进任务",
  schedule_reminder: "安排提醒",
  manage_reminder: "管理提醒",
  manage_prefetch_task: "预抓任务",
  set_location: "设置定位",
  set_agent_name: "设置代号",
  set_security: "设置权限",
  delegate_to_agent: "委派代理",
  grant_agent_delegation: "授权代理",
  complete_startup_self_check: "完成自检",
  install_tool: "安装工具",
  install_software: "安装软件",
  uninstall_tool: "卸载工具",
  list_tools: "列出工具",
  connect_wechat: "连接微信",
  connect_feishu: "连接飞书",
  media_mode: "媒体模式",
  hotspot_mode: "热点模式",
  open_doc_panel: "打开文档",
  person_card_mode: "人物名片",
  music: "播放音乐",
};

const TOOL_ICON = {
  send_message: "💬",
  express: "🗣️",
  read_file: "📄",
  write_file: "✏️",
  edit_file: "📝",
  delete_file: "🗑️",
  make_dir: "📁",
  list_dir: "📂",
  run_command: "⚡",
  exec_command: "⚡",
  kill_process: "🛑",
  list_processes: "📋",
  web_search: "🔎",
  web_read: "🌐",
  fetch_url: "🌐",
  browser_read: "🧭",
  browser_navigate: "🌐",
  browser_navigate_back: "↩️",
  browser_navigate_forward: "↪️",
  browser_reload: "🔄",
  browser_snapshot: "👀",
  browser_find: "🔎",
  browser_click: "👆",
  browser_type: "⌨️",
  browser_fill_form: "📝",
  browser_select_option: "☑️",
  browser_press_key: "⌨️",
  browser_hover: "🖱️",
  browser_drag: "↔️",
  browser_wait_for: "⏳",
  browser_handle_dialog: "💬",
  browser_tabs: "🗂️",
  browser_take_screenshot: "📸",
  browser_console_messages: "🧪",
  browser_resize: "↔️",
  browser_close: "✕",
  browser_clear_data: "⌫",
  browser_set_display_mode: "↗️",
  system_browser_open: "🧭",
  search_memory: "🔍",
  probe_memory: "🩺",
  upsert_memory: "🧠",
  merge_memories: "🧬",
  downgrade_memory: "🌫️",
  recall_memory: "💭",
  skip_recognition: "⏭️",
  skip_consolidation: "⏭️",
  set_tick_interval: "⏱️",
  speak: "🔊",
  generate_lyrics: "🎵",
  generate_music: "🎼",
  generate_image: "🎨",
  ui_set: "🎴",
  focus_banner: "🎯",
  set_task: "📋",
  complete_task: "✅",
  update_task_step: "↳",
  schedule_reminder: "⏰",
  manage_reminder: "⏰",
  manage_prefetch_task: "📡",
  set_location: "📍",
  set_agent_name: "🪪",
  set_security: "🔐",
  delegate_to_agent: "🤝",
  grant_agent_delegation: "🤝",
  complete_startup_self_check: "🩺",
  install_tool: "🔧",
  install_software: "⬇️",
  uninstall_tool: "🔧",
  list_tools: "🧰",
  connect_wechat: "🔗",
  connect_feishu: "🪶",
  media_mode: "🎬",
  hotspot_mode: "🔥",
  open_doc_panel: "📖",
  person_card_mode: "🪪",
  music: "🎶",
};

function normalizeToolName(name) {
  const raw = String(name || "").trim();
  if (TOOL_ZH[raw]) return raw;
  if (raw.startsWith("mcp__")) {
    const remoteName = raw.split("__").at(-1) || "";
    if (TOOL_ZH[remoteName]) return remoteName;
  }
  return raw;
}

export function friendlyToolName(name, args = {}) {
  const normalized = normalizeToolName(name);
  if (normalized === "browser_press_key") {
    const key = String(args?.key || "").toLowerCase();
    if (["end", "home", "pagedown", "pageup", "space", "arrowdown", "arrowup"].includes(key)) {
      return t("tool.scrollPage");
    }
  }
  if (normalized === "browser_tabs") {
    if (args?.action === "new") return t("tool.openNewTab");
    if (args?.action === "select") return t("tool.selectTab");
    if (args?.action === "close") return t("tool.closeTab");
    if (args?.action === "list") return t("tool.listTabs");
  }
  if (normalized === "browser_set_display_mode") {
    if (args?.mode === "window") return t("tool.browserWindow");
    if (args?.mode === "card") return t("tool.browserCard");
    return t("tool.browserDisplay");
  }
  return TOOL_ZH[normalized] ? translateUiText(TOOL_ZH[normalized]) : t("tool.generic");
}

export function friendlyToolIcon(name) {
  return TOOL_ICON[normalizeToolName(name)] || "⚙️";
}

function isFailureResult(resultStr) {
  const t = (resultStr || "").trim();
  if (!t) return false;
  if (/^(错误|失败|异常)[：:]/.test(t) || /^Error\b/i.test(t) || /^ERROR\b/.test(t)) return true;
  try {
    const parsed = JSON.parse(t);
    if (parsed && typeof parsed === "object" && parsed.ok === false) return true;
  } catch {}
  return false;
}

export class ThoughtStream {
  constructor(innerId, color, options = {}) {
    this.el = document.getElementById(innerId);
    this.scroller = this.el?.parentElement || null;
    this.color = color;
    this.readCSSVar = options.readCSSVar || (() => "");
    this.thinkingLabel = options.thinkingLabel || t("thought.thinking");
    this.thinkingDoneLabel = options.thinkingDoneLabel || null;
    this.toolDetailLength = options.toolDetailLength || 160;
    this.startedAt = Date.now();
    this.curLine = null;
    this.thinkingEl = null;
    this.commentaryEl = null;
    this.lastToolEl = null;
    this.statusEl = null;
    this.statusTimer = null;
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

    // 保留对主题变量的引用，不把当前主题的解析色值固化到内联样式。
    // 否则从浅色切回暗色后，历史记录仍会残留浅色主题的深色文字。
    const color = `var(--${this.color})`;
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
    this.commentaryEl = null;

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
    this.clearStatusTimer();
    if (!this.curLine) this.newLine(this.thinkingLabel);
    if (!this.statusEl) {
      this.statusEl = document.createElement("div");
    }
    this.statusEl.className = `line-status ${kind}`.trim();
    this.statusEl.textContent = text;
    // 始终把状态条移到行末（最新工具的下方），避免被堆叠的工具顶出视口
    this.curLine.appendChild(this.statusEl);
    this.scrollToLatest();
  }

  setTimedStatus(text, kind = "busy", options = {}) {
    this.setStatus(text, kind);
    const staleAfterMs = Number(options.staleAfterMs || 0);
    if (!staleAfterMs) return;
    const statusEl = this.statusEl;
    const staleText = options.staleText || text;
    this.statusTimer = setTimeout(() => {
      if (!statusEl || statusEl !== this.statusEl || !statusEl.parentElement) return;
      statusEl.className = "line-status stale";
      statusEl.textContent = staleText;
    }, staleAfterMs);
  }

  clearStatusTimer() {
    if (this.statusTimer) {
      clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
  }

  clearStatus() {
    this.clearStatusTimer();
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
    el.style.color = `var(--${this.color})`;
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

  appendCommentary(text) {
    const chunk = String(text || "");
    if (!chunk) return;
    if (!this.curLine) {
      this.newLine(this.thinkingLabel);
      this.thinkingLine = this.curLine;
    }
    if (!this.commentaryEl || !this.commentaryEl.parentElement) {
      this.commentaryEl = document.createElement("div");
      this.commentaryEl.className = "line-text line-commentary";
      this.curLine.appendChild(this.commentaryEl);
    }
    this.commentaryEl.textContent += chunk;
    this.trim();
    this.scrollToLatest();
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
      return t("thought.webSearchFailed", {
        error: payload.error || t("thought.noResult"),
        query: payload.query || t("thought.notProvided"),
      });
    }

    const lines = [t("thought.webSearchResults", {
      query: payload.query || t("thought.notProvided"),
      count: results.length,
    })];
    results.slice(0, 3).forEach((item, index) => {
      const host = this.hostFromUrl(item.url);
      const title = this.compactText(item.title || item.url || t("thought.untitledResult"), 70);
      const snippet = this.compactText(item.snippet || "", 90);
      lines.push(`${index + 1}. ${title}${host ? t("thought.host", { host }) : ""}${snippet ? `: ${snippet}` : ""}`);
    });
    return lines.join(" ");
  }

  formatFetchUrlDetail(payload) {
    const host = this.hostFromUrl(payload.url);
    if (payload.ok === false) {
      const status = payload.status ? `HTTP ${payload.status}` : (payload.error || t("thought.requestFailed"));
      if (payload.error === "no readable content extracted") {
        return t("thought.noReadableContent", { host: host ? t("thought.host", { host }) : "" });
      }
      return t("thought.readFailed", {
        status,
        host: host ? t("thought.sourceHost", { host }) : "",
        hint: payload.hint ? this.compactText(payload.hint, 90) : t("thought.tryAnotherSource"),
      });
    }

    const title = this.compactText(payload.title || host || payload.url || t("thought.webpage"), 80);
    const content = this.compactText(payload.content || "", 220);
    return t("thought.readSuccess", {
      title,
      host: host ? t("thought.host", { host }) : "",
      content: content || t("thought.noExtractedContent"),
    });
  }

  formatBrowserReadDetail(payload) {
    const host = this.hostFromUrl(payload.final_url || payload.url);
    if (payload.ok === false) {
      if (payload.error === "no readable content rendered") {
        return t("thought.browserNoReadableContent", { host: host ? t("thought.host", { host }) : "" });
      }
      return t("thought.browserReadFailed", {
        host: host ? t("thought.host", { host }) : "",
        error: this.compactText(payload.error || t("thought.pageRenderFailed"), 120),
      });
    }

    const title = this.compactText(payload.title || host || payload.final_url || payload.url || t("thought.webpage"), 80);
    const content = this.compactText(payload.content || "", 240);
    return t("thought.browserReadSuccess", {
      title,
      host: host ? t("thought.host", { host }) : "",
      content: content || t("thought.noRenderedContent"),
    });
  }

  shortPath(p, max = 48) {
    const s = String(p || "").trim();
    if (!s) return "";
    if (s.length <= max) return s;
    const norm = s.replace(/\\/g, "/");
    const segs = norm.split("/").filter(Boolean);
    if (segs.length >= 3) {
      const tail = segs.slice(-2).join("/");
      const head = segs[0];
      const candidate = `${head}/…/${tail}`;
      if (candidate.length <= max) return candidate;
      return `…/${tail.slice(-max + 2)}`;
    }
    return s.slice(0, max - 1) + "…";
  }

  shortCommand(cmd, max = 60) {
    return this.compactText(String(cmd || "").replace(/\s+/g, " ").trim(), max);
  }

  formatToolSubject(name, args = {}, parsed) {
    const a = args || {};
    switch (normalizeToolName(name)) {
      case "read_file":
      case "write_file":
      case "edit_file":
      case "delete_file":
      case "make_dir":
      case "list_dir":
        return this.shortPath(a.path);
      case "run_command":
      case "exec_command":
        return this.shortCommand(a.command || parsed?.command);
      case "kill_process":
        return a.pid ? `pid ${a.pid}` : "";
      case "web_search":
        return this.compactText(a.query || parsed?.query || "", 60);
      case "web_read":
      case "fetch_url":
      case "browser_read":
        return this.hostFromUrl(a.url || parsed?.url) || this.compactText(a.url || "", 60);
      case "browser_navigate":
        return this.hostFromUrl(a.url) || this.compactText(a.url || "", 60);
      case "browser_find":
        return this.compactText(a.text || "", 60);
      case "browser_click":
      case "browser_type":
      case "browser_hover":
        return this.compactText(a.element || a.name || "", 50);
      case "browser_fill_form":
        return Array.isArray(a.fields) ? t("thought.items", { count: a.fields.length }) : "";
      case "browser_select_option":
        return this.compactText(a.element || a.name || "", 50);
      case "browser_press_key":
        return this.compactText(a.key || "", 24);
      case "browser_drag": {
        const from = this.compactText(a.startElement || a.source || "", 24);
        const to = this.compactText(a.endElement || a.target || "", 24);
        return from && to ? `${from} → ${to}` : from || to;
      }
      case "browser_wait_for":
        return a.time != null ? t("thought.seconds", { count: a.time }) : this.compactText(a.text || a.textGone || "", 40);
      case "browser_handle_dialog":
        return a.accept === false ? t("thought.cancel") : t("thought.confirm");
      case "browser_tabs":
        return a.index != null ? t("thought.tabNumber", { count: Number(a.index) + 1 }) : "";
      case "browser_take_screenshot":
        return this.shortPath(a.filename || "", 48);
      case "browser_set_display_mode":
        if (a.mode === "window") return t("thought.largeWindow");
        if (a.mode === "card") return t("thought.smallCard");
        return "";
      case "browser_clear_data": {
        const types = Array.isArray(a.data_types) ? a.data_types.length : 0;
        return types ? t("thought.categories", { count: types, range: a.time_range || "" }) : this.compactText(a.time_range || "", 24);
      }
      case "system_browser_open":
        try {
          return new URL(a.url || "").hostname;
        } catch {
          return this.compactText(a.url || "", 48);
        }
      case "browser_console_messages":
        return this.compactText(a.level || "", 20);
      case "browser_resize":
        return a.width && a.height ? `${a.width} × ${a.height}` : "";
      case "search_memory":
        return Array.isArray(a.keywords) ? a.keywords.slice(0, 4).join(" / ") : "";
      case "upsert_memory":
      case "merge_memories":
      case "downgrade_memory":
      case "recall_memory":
        return this.compactText(a.summary || a.note || a.reason || "", 50);
      case "send_message":
        return this.compactText(a.content || "", 60);
      case "speak":
        return this.compactText(a.text || "", 50);
      case "generate_lyrics":
      case "generate_music":
      case "generate_image":
        return this.compactText(a.prompt || "", 50);
      case "set_tick_interval":
        return a.seconds ? `${a.seconds}s · ttl ${a.ttl || 10}` : "";
      case "ui_set":
        return this.compactText(String(a.id || a.surface?.kind || ""), 30);
      case "focus_banner":
        return a.action ? `${a.action}${a.task ? " · " + this.compactText(a.task, 30) : ""}` : "";
      case "set_task":
      case "complete_task":
      case "update_task_step":
        return this.compactText(a.description || a.step || a.note || "", 50);
      case "schedule_reminder":
      case "manage_reminder":
        return this.compactText(a.content || a.action || "", 50);
      case "set_location":
        return this.compactText(a.location || a.city || "", 40);
      case "set_agent_name":
        return this.compactText(a.name || "", 30);
      case "delegate_to_agent":
      case "grant_agent_delegation":
        return this.compactText(a.agent_id || a.target_id || "", 30);
      case "install_tool":
      case "uninstall_tool":
        return this.compactText(a.tool_name || a.name || "", 40);
      case "install_software":
        return this.compactText(a.software || a.brew_name || a.url || "", 50);
      case "music":
        return this.compactText(a.title || a.action || "", 40);
      case "media_mode":
      case "hotspot_mode":
      case "person_card_mode":
        return this.compactText(a.mode || a.action || "", 30);
      default:
        return "";
    }
  }

  formatExecCommandDetail(payload) {
    if (payload.ok === false) {
      if (payload.error === "permission denied") {
        const risk = payload.policy?.risk;
        const reason = payload.policy?.reason || t("thought.policyDenied");
        const riskLabel = risk === "high" ? t("thought.riskHigh") : risk === "medium" ? t("thought.riskMedium") : risk === "low" ? t("thought.riskLow") : t("thought.riskRestricted");
        return t("thought.permissionDenied", { risk: riskLabel, reason });
      }
      if (payload.timed_out) {
        return t("thought.commandTimeout", {
          seconds: Math.round((payload.timeout_ms || 0) / 1000),
          stderr: payload.stderr ? `; stderr: ${this.compactText(payload.stderr, 120)}` : "",
        });
      }
      if (payload.aborted) return t("thought.commandAborted");
      const code = payload.exit_code != null ? t("thought.exitCode", { code: payload.exit_code }) : t("thought.executionFailed");
      const errOut = payload.stderr || payload.stdout || payload.error || "";
      return t("thought.commandFailed", {
        code,
        detail: errOut ? `: ${this.compactText(errOut.replace(/\s+/g, " "), 160)}` : "",
      });
    }

    if (payload.mode === "background") {
      return t("thought.backgroundProcess", { pid: payload.pid });
    }
    if (payload.mode === "promoted_to_background") {
      return t("thought.promotedBackground", { pid: payload.pid });
    }

    const stdout = String(payload.stdout || "").trim();
    if (stdout) {
      const preview = this.compactText(stdout.replace(/\s+/g, " "), 180);
      return t("thought.output", { output: preview });
    }
    if (payload.stderr) {
      return `stderr：${this.compactText(payload.stderr.replace(/\s+/g, " "), 160)}`;
    }
    return t("thought.commandCompleted", { code: payload.exit_code ?? 0 });
  }

  formatGenericPermissionDenied(payload) {
    const risk = payload.policy?.risk;
    const reason = payload.policy?.reason || t("thought.policyDenied");
    const riskLabel = risk === "high" ? t("thought.riskHigh") : risk === "medium" ? t("thought.riskMedium") : risk === "low" ? t("thought.riskLow") : t("thought.riskRestricted");
    return t("thought.permissionDenied", { risk: riskLabel, reason });
  }

  formatSearchMemoryDetail(payload) {
    if (payload?.ok === false) return this.compactText(payload.error || t("thought.searchFailed"), 120);
    const hits = Array.isArray(payload?.hits) ? payload.hits
      : Array.isArray(payload?.results) ? payload.results
      : Array.isArray(payload?.memories) ? payload.memories : null;
    if (hits) {
      if (hits.length === 0) return t("thought.noMemoryHits");
      const preview = hits.slice(0, 2).map(h => this.compactText(h.summary || h.content || h.text || "", 50)).filter(Boolean).join(" ｜ ");
      return t("thought.memoryHits", { count: hits.length, preview: preview ? `: ${preview}` : "" });
    }
    return "";
  }

  formatFileReadDetail(result) {
    const s = String(result || "").trim();
    if (!s) return t("thought.emptyFile");
    if (s.startsWith("错误")) return this.compactText(s, 160);
    return t("thought.contentPreview", { content: this.compactText(s.replace(/\s+/g, " "), 160) });
  }

  formatGenericOkDetail(payload, raw) {
    if (payload?.ok === false) {
      return this.compactText(payload.error || t("thought.executionFailed"), 160);
    }
    if (payload?.ok === true) {
      const meaningful = payload.summary || payload.message || payload.detail || payload.hint;
      if (meaningful) return this.compactText(String(meaningful), 160);
      return ""; // 已知成功且无额外信息，不显示 detail
    }
    // 非 JSON：避免把 JSON 残片或类 JSON 文本糊到 UI 上，先识别再决定
    const trimmed = String(raw ?? "").trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      // 看起来是 JSON 但解析失败（多半是后端截断了）
      return t("thought.resultTooLong");
    }
    return this.compactText(trimmed.replace(/\s+/g, " "), this.toolDetailLength);
  }

  formatToolDetail(name, args, result) {
    name = normalizeToolName(name);
    const parsed = this.parseJsonResult(result);

    // Web tools 保留原有人类化格式器
    if (parsed?.tool === "web_search" || name === "web_search") return this.formatWebSearchDetail(parsed || {});
    if (parsed?.tool === "web_read" || name === "web_read") return this.formatFetchUrlDetail(parsed || {});
    if (parsed?.tool === "fetch_url" || name === "fetch_url") return this.formatFetchUrlDetail(parsed || {});
    if (parsed?.tool === "browser_read" || name === "browser_read") return this.formatBrowserReadDetail(parsed || {});

    // 通用 permission denied
    if (parsed?.ok === false && parsed.error === "permission denied") {
      return this.formatGenericPermissionDenied(parsed);
    }

    if (name === "run_command" || name === "exec_command") {
      if (parsed) return this.formatExecCommandDetail(parsed);
      // JSON 残缺时不展示原文，给个通用兜底
      return t("thought.commandResultTooLong");
    }

    if (name === "search_memory") {
      return this.formatSearchMemoryDetail(parsed || {});
    }

    if (name === "read_file") {
      return this.formatFileReadDetail(result);
    }

    if (name === "write_file" || name === "edit_file" || name === "delete_file" || name === "make_dir") {
      if (parsed?.ok === false) return this.compactText(parsed.error || t("thought.operationFailed"), 160);
      const raw = String(result || "").trim();
      if (raw.startsWith("错误")) return this.compactText(raw, 160);
      return ""; // 成功时不重复显示路径，subject 已经写明
    }

    if (name === "list_dir") {
      if (parsed?.ok === false) return this.compactText(parsed.error || t("thought.viewFailed"), 160);
      const items = Array.isArray(parsed?.entries) ? parsed.entries
                  : Array.isArray(parsed?.items) ? parsed.items
                  : Array.isArray(parsed?.files) ? parsed.files : null;
      if (items) {
        if (items.length === 0) return t("thought.emptyDirectory");
        const sample = items.slice(0, 6).map(it => typeof it === "string" ? it : (it.name || "")).filter(Boolean).join(" · ");
        return t("thought.directoryItems", { count: items.length, sample: this.compactText(sample, 160) });
      }
      return "";
    }

    if (name === "send_message") {
      // 已在 subject 显示内容预览，detail 留空
      if (parsed?.ok === false) return this.compactText(parsed.error || t("thought.sendFailed"), 160);
      return "";
    }

    return this.formatGenericOkDetail(parsed, result);
  }

  finalizeLastTool() {
    this.clearStatusTimer();
    if (this.lastToolEl) {
      this.lastToolEl.classList.add("done");
      this.lastToolEl = null;
    }
  }

  toolLabel(name) {
    return `${friendlyToolIcon(name)} ${friendlyToolName(name)}`;
  }

  toolAction(name, args = {}) {
    return friendlyToolName(name, args);
  }

  tool(name, args, result, ok = undefined) {
    if (!this.curLine) this.newLine(t("thought.processing"));
    this.finalizeLastTool();
    this.clearStatus();

    const action = friendlyToolName(name, args);
    const icon = friendlyToolIcon(name);
    const resultStr = result == null ? "" : String(result);
    const failure = ok === false || (ok !== true && isFailureResult(resultStr));
    this.hadToolCall = true;
    this.toolFailed = this.toolFailed || failure;
    const statusCls = failure ? "failed" : "success";
    const statusIcon = failure ? "✗" : "✓";
    const statusLabel = failure ? t("thought.failed") : t("thought.success");

    const toolEl = document.createElement("div");
    toolEl.className = `line-tool done tool-${statusCls}`;
    toolEl.style.color = `var(--${this.color})`;

    const iconSpan = document.createElement("span");
    iconSpan.className = "tool-icon";
    iconSpan.textContent = icon;
    const nameSpan = document.createElement("span");
    nameSpan.className = "tool-name";
    nameSpan.textContent = action;

    const parsedResult = this.parseJsonResult(resultStr);
    const subjectText = this.formatToolSubject(name, args, parsedResult);

    const statusSpan = document.createElement("span");
    statusSpan.className = `tool-status ${statusCls}`;
    statusSpan.textContent = `${statusIcon} ${statusLabel}`;
    toolEl.appendChild(iconSpan);
    toolEl.appendChild(nameSpan);

    if (subjectText) {
      const sepSpan = document.createElement("span");
      sepSpan.className = "tool-sep";
      sepSpan.textContent = "·";
      const subjectSpan = document.createElement("span");
      subjectSpan.className = "tool-subject";
      subjectSpan.textContent = subjectText;
      subjectSpan.title = subjectText;
      toolEl.appendChild(sepSpan);
      toolEl.appendChild(subjectSpan);
    }

    toolEl.appendChild(statusSpan);

    // 展开按钮：始终占一列保证图标对齐，仅当本行有 detail 时填充 ▸ 并可点击。
    // 默认折叠——工具行只展示"大概"（图标+名称+对象+状态），点击整行展开 detail，
    // ▸ 旋转成 ▾（向下）。再点收起。
    const chevron = document.createElement("span");
    chevron.className = "tool-chevron";
    toolEl.insertBefore(chevron, toolEl.firstChild);

    const detailText = this.formatToolDetail(name, args, resultStr);
    let detail = null;
    if (detailText) {
      chevron.textContent = "▸";
      toolEl.classList.add("expandable");
      detail = document.createElement("div");
      detail.className = "line-tool-detail collapsed";
      detail.textContent = detailText;
      toolEl.addEventListener("click", () => {
        const open = toolEl.classList.toggle("expanded");
        detail.classList.toggle("collapsed", !open);
        if (open) this.scrollToLatest();
      });
    }

    this.curLine.appendChild(toolEl);
    if (detail) this.curLine.appendChild(detail);

    this.scrollToLatest();
    this.lastToolEl = null;
  }

  appendToolCycleEnd() {
    if (!this.curLine) return;

    const toolEl = document.createElement("div");
    const statusCls = this.toolFailed ? "failed" : "ended";
    toolEl.className = `line-tool done tool-${statusCls}`;
    toolEl.style.color = `var(--${this.color})`;

    const iconSpan = document.createElement("span");
    iconSpan.className = "tool-icon";
    iconSpan.textContent = this.toolFailed ? "⚠" : "◎";

    const nameSpan = document.createElement("span");
    nameSpan.className = "tool-name";
    nameSpan.textContent = this.hadToolCall ? t("thought.allOperations") : t("thought.thisRound");

    const statusSpan = document.createElement("span");
    statusSpan.className = `tool-status ${statusCls}`;
    statusSpan.textContent = this.toolFailed ? t("thought.ended") : t("thought.completed");

    // 空 chevron 占位，让收尾行与上面的工具行图标对齐（本行不可展开）。
    const chevron = document.createElement("span");
    chevron.className = "tool-chevron";

    toolEl.appendChild(chevron);
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

  // Called at the start of a new round (message_received / tick) to drop any
  // dangling state from a previous round that ended without an emit('response')
  // event — e.g. the round was aborted by a higher-priority message. Without
  // this, the next round's startThinkingSession() would reuse the old
  // thinkingLine in the wrong DOM position.
  beginRound() {
    this.stopThinking();
    this.clearStatus();
    this.curLine = null;
    this.thinkingLine = null;
    this.hadToolCall = false;
    this.toolFailed = false;
    this.lastToolEl = null;
  }
}
