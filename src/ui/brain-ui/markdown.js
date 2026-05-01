function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(text) {
  return escapeHtml(text).replace(/`/g, "&#96;");
}

function safeHref(rawUrl) {
  const url = String(rawUrl ?? "").trim();
  if (!url) return "";
  if (/^(https?:|mailto:)/i.test(url)) return url;
  if (url.startsWith("/") || url.startsWith("#")) return url;
  return "";
}

function renderInlineMarkdown(text) {
  const codeTokens = [];
  let html = String(text ?? "").replace(/`([^`]+)`/g, (_, code) => {
    const token = `%%CODETOKEN${codeTokens.length}%%`;
    codeTokens.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });

  html = escapeHtml(html);
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, href) => {
    const safeUrl = safeHref(href);
    if (!safeUrl) return label;
    return `<a href="${escapeAttr(safeUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  html = html.replace(/(\*\*|__)(.+?)\1/g, "<strong>$2</strong>");
  html = html.replace(/(\*|_)(.+?)\1/g, "<em>$2</em>");

  codeTokens.forEach((token, index) => {
    html = html.replaceAll(`%%CODETOKEN${index}%%`, token);
  });

  return html;
}

export function renderMarkdown(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const parts = [];
  let paragraph = [];
  let listType = null;
  let listItems = [];
  let quoteLines = [];
  let codeFence = null;
  let codeLines = [];

  function flushParagraph() {
    if (!paragraph.length) return;
    parts.push(`<p>${paragraph.map(renderInlineMarkdown).join("<br>")}</p>`);
    paragraph = [];
  }

  function flushList() {
    if (!listType || !listItems.length) return;
    const tag = listType === "ol" ? "ol" : "ul";
    parts.push(`<${tag}>${listItems.map(item => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</${tag}>`);
    listType = null;
    listItems = [];
  }

  function flushQuote() {
    if (!quoteLines.length) return;
    parts.push(`<blockquote>${quoteLines.map(line => renderInlineMarkdown(line)).join("<br>")}</blockquote>`);
    quoteLines = [];
  }

  function flushCode() {
    if (codeFence === null) return;
    const langClass = codeFence ? ` class="language-${escapeAttr(codeFence)}"` : "";
    parts.push(`<pre><code${langClass}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
    codeFence = null;
    codeLines = [];
  }

  for (const line of lines) {
    const fenceMatch = line.match(/^```([\w-]+)?\s*$/);
    if (fenceMatch) {
      flushParagraph();
      flushList();
      flushQuote();
      if (codeFence !== null) flushCode();
      else codeFence = fenceMatch[1] || "";
      continue;
    }

    if (codeFence !== null) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      flushQuote();
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      flushQuote();
      const level = headingMatch[1].length;
      parts.push(`<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
      continue;
    }

    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quoteLines.push(quoteMatch[1]);
      continue;
    }
    flushQuote();

    const ulMatch = line.match(/^[-*+]\s+(.+)$/);
    if (ulMatch) {
      flushParagraph();
      if (listType && listType !== "ul") flushList();
      listType = "ul";
      listItems.push(ulMatch[1]);
      continue;
    }

    const olMatch = line.match(/^\d+\.\s+(.+)$/);
    if (olMatch) {
      flushParagraph();
      if (listType && listType !== "ol") flushList();
      listType = "ol";
      listItems.push(olMatch[1]);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  flushQuote();
  flushCode();

  return parts.join("");
}

export function createMarkdownBody(text) {
  const body = document.createElement("div");
  body.className = "msg-body";
  body.innerHTML = renderMarkdown(text);
  return body;
}

