const TOOL_ZH = {
  send_message: "发送消息",
  express: "表达",
  read_file: "读取文件",
  write_file: "写入文件",
  delete_file: "删除文件",
  make_dir: "创建目录",
  list_dir: "查看目录",
  exec_command: "执行命令",
  exec_quick_command: "快速命令",
  exec_task_command: "任务命令",
  exec_background_command: "后台命令",
  download_file: "下载文件",
  kill_process: "终止进程",
  list_processes: "列出进程",
  web_search: "搜索网页",
  fetch_url: "抓取网页",
  browser_read: "浏览器读取网页",
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
    this.thinkingLabel = options.thinkingLabel || "思考中";
    this.thinkingDoneLabel = options.thinkingDoneLabel || null;
    this.toolDetailLength = options.toolDetailLength || 160;
    this.startedAt = Date.now();
    this.curLine = null;
    this.thinkingEl = null;
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
    switch (name) {
      case "read_file":
      case "write_file":
      case "delete_file":
      case "make_dir":
      case "list_dir":
        return this.shortPath(a.path);
      case "exec_command":
        return this.shortCommand(a.command || parsed?.command);
      case "kill_process":
        return a.pid ? `pid ${a.pid}` : "";
      case "web_search":
        return this.compactText(a.query || parsed?.query || "", 60);
      case "fetch_url":
      case "browser_read":
        return this.hostFromUrl(a.url || parsed?.url) || this.compactText(a.url || "", 60);
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
        const reason = payload.policy?.reason || "策略拒绝";
        const riskLabel = risk === "high" ? "高风险" : risk === "medium" ? "中风险" : risk === "low" ? "低风险" : "受限";
        return `权限被拒绝（${riskLabel}）：${reason}`;
      }
      if (payload.timed_out) {
        return `命令超时（${Math.round((payload.timeout_ms || 0) / 1000)}s）${payload.stderr ? "；stderr：" + this.compactText(payload.stderr, 120) : ""}`;
      }
      if (payload.aborted) return "命令已被中断。";
      const code = payload.exit_code != null ? `退出码 ${payload.exit_code}` : "执行失败";
      const errOut = payload.stderr || payload.stdout || payload.error || "";
      return `命令失败（${code}）${errOut ? "：" + this.compactText(errOut.replace(/\s+/g, " "), 160) : ""}`;
    }

    if (payload.mode === "background") {
      return `已转入后台运行，pid ${payload.pid}。可用 list_processes 查看，kill_process 停止。`;
    }
    if (payload.mode === "promoted_to_background") {
      return `前台超时，已转入后台，pid ${payload.pid}。`;
    }

    const stdout = String(payload.stdout || "").trim();
    if (stdout) {
      const preview = this.compactText(stdout.replace(/\s+/g, " "), 180);
      return `输出：${preview}`;
    }
    if (payload.stderr) {
      return `stderr：${this.compactText(payload.stderr.replace(/\s+/g, " "), 160)}`;
    }
    return `命令完成（退出码 ${payload.exit_code ?? 0}）。`;
  }

  formatGenericPermissionDenied(payload) {
    const risk = payload.policy?.risk;
    const reason = payload.policy?.reason || "策略拒绝";
    const riskLabel = risk === "high" ? "高风险" : risk === "medium" ? "中风险" : risk === "low" ? "低风险" : "受限";
    return `权限被拒绝（${riskLabel}）：${reason}`;
  }

  formatSearchMemoryDetail(payload) {
    if (payload?.ok === false) return this.compactText(payload.error || "检索失败", 120);
    const hits = Array.isArray(payload?.hits) ? payload.hits
      : Array.isArray(payload?.results) ? payload.results
      : Array.isArray(payload?.memories) ? payload.memories : null;
    if (hits) {
      if (hits.length === 0) return "没有命中记忆。";
      const preview = hits.slice(0, 2).map(h => this.compactText(h.summary || h.content || h.text || "", 50)).filter(Boolean).join(" ｜ ");
      return `命中 ${hits.length} 条${preview ? "：" + preview : ""}`;
    }
    return "";
  }

  formatFileReadDetail(result) {
    const s = String(result || "").trim();
    if (!s) return "（空文件）";
    if (s.startsWith("错误")) return this.compactText(s, 160);
    return `内容预览：${this.compactText(s.replace(/\s+/g, " "), 160)}`;
  }

  formatGenericOkDetail(payload, raw) {
    if (payload?.ok === false) {
      return this.compactText(payload.error || "执行失败", 160);
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
      return "结果过长未展开。";
    }
    return this.compactText(trimmed.replace(/\s+/g, " "), this.toolDetailLength);
  }

  formatToolDetail(name, args, result) {
    const parsed = this.parseJsonResult(result);

    // Web tools 保留原有人类化格式器
    if (parsed?.tool === "web_search" || name === "web_search") return this.formatWebSearchDetail(parsed || {});
    if (parsed?.tool === "fetch_url" || name === "fetch_url") return this.formatFetchUrlDetail(parsed || {});
    if (parsed?.tool === "browser_read" || name === "browser_read") return this.formatBrowserReadDetail(parsed || {});

    // 通用 permission denied
    if (parsed?.ok === false && parsed.error === "permission denied") {
      return this.formatGenericPermissionDenied(parsed);
    }

    if (name === "exec_command") {
      if (parsed) return this.formatExecCommandDetail(parsed);
      // JSON 残缺时不展示原文，给个通用兜底
      return "命令已执行（结果过长未展开）。";
    }

    if (name === "search_memory") {
      return this.formatSearchMemoryDetail(parsed || {});
    }

    if (name === "read_file") {
      return this.formatFileReadDetail(result);
    }

    if (name === "write_file" || name === "delete_file" || name === "make_dir") {
      if (parsed?.ok === false) return this.compactText(parsed.error || "操作失败", 160);
      const raw = String(result || "").trim();
      if (raw.startsWith("错误")) return this.compactText(raw, 160);
      return ""; // 成功时不重复显示路径，subject 已经写明
    }

    if (name === "list_dir") {
      if (parsed?.ok === false) return this.compactText(parsed.error || "查看失败", 160);
      const items = Array.isArray(parsed?.entries) ? parsed.entries
                  : Array.isArray(parsed?.items) ? parsed.items
                  : Array.isArray(parsed?.files) ? parsed.files : null;
      if (items) {
        if (items.length === 0) return "（空目录）";
        const sample = items.slice(0, 6).map(it => typeof it === "string" ? it : (it.name || "")).filter(Boolean).join(" · ");
        return `${items.length} 项：${this.compactText(sample, 160)}`;
      }
      return "";
    }

    if (name === "send_message") {
      // 已在 subject 显示内容预览，detail 留空
      if (parsed?.ok === false) return this.compactText(parsed.error || "发送失败", 160);
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
    const zh = TOOL_ZH[name] || name;
    const icon = TOOL_ICON[name] || "🔧";
    return `${icon} ${zh}`;
  }

  tool(name, args, result, ok = undefined) {
    if (!this.curLine) this.newLine("工具调用");
    this.finalizeLastTool();
    this.clearStatus();

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
