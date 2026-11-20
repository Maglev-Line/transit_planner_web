/* Render the small, safe Markdown subset used by the home-page guide. */
(() => {
  "use strict";

  const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));

  function renderInline(source) {
    const token = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
    return String(source).split(token).map((part) => {
      if (part.startsWith("`") && part.endsWith("`")) return `<code>${esc(part.slice(1, -1))}</code>`;
      if (part.startsWith("**") && part.endsWith("**")) return `<strong>${esc(part.slice(2, -2))}</strong>`;
      if (part.startsWith("*") && part.endsWith("*")) return `<em>${esc(part.slice(1, -1))}</em>`;
      const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (!link) return esc(part);
      try {
        const url = new URL(link[2], window.location.href);
        if (!["http:", "https:", "mailto:"].includes(url.protocol)) return esc(link[1]);
        const external = url.protocol !== "mailto:" && url.origin !== window.location.origin;
        return `<a href="${esc(link[2])}"${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${esc(link[1])}</a>`;
      } catch {
        return esc(link[1]);
      }
    }).join("");
  }

  function cells(line) {
    return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  }

  function isTable(lines, index) {
    return index + 1 < lines.length
      && lines[index].includes("|")
      && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1]);
  }

  function isBlockStart(lines, index) {
    const line = lines[index] || "";
    return /^\s*$/.test(line)
      || /^\s*#{1,6}\s/.test(line)
      || /^\s*```/.test(line)
      || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)
      || /^\s*>/.test(line)
      || /^\s*(?:[-+*]|\d+\.)\s+/.test(line)
      || isTable(lines, index);
  }

  function render(markdown) {
    const lines = String(markdown).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i += 1; continue; }

      const fence = line.match(/^\s*```([a-zA-Z0-9_-]*)/);
      if (fence) {
        const code = [];
        i += 1;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++]);
        if (i < lines.length) i += 1;
        const language = fence[1] ? ` class="language-${esc(fence[1])}"` : "";
        out.push(`<pre><code${language}>${esc(code.join("\n"))}</code></pre>`);
        continue;
      }

      const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        const level = heading[1].length;
        out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
        i += 1;
        continue;
      }
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        out.push("<hr>");
        i += 1;
        continue;
      }

      if (isTable(lines, i)) {
        const headers = cells(lines[i]);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
        out.push(`<div class="readme-table-wrap"><table><thead><tr>${headers.map((cell) => `<th>${renderInline(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => (
          `<tr>${headers.map((_, col) => `<td>${renderInline(row[col] || "")}</td>`).join("")}</tr>`
        )).join("")}</tbody></table></div>`);
        continue;
      }

      if (/^\s*>/.test(line)) {
        const quote = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ""));
        out.push(`<blockquote><p>${renderInline(quote.join(" "))}</p></blockquote>`);
        continue;
      }

      const list = line.match(/^\s*([-+*]|\d+\.)\s+(.+)$/);
      if (list) {
        const ordered = /^\d/.test(list[1]);
        const tag = ordered ? "ol" : "ul";
        const items = [];
        while (i < lines.length) {
          const item = lines[i].match(/^\s*([-+*]|\d+\.)\s+(.+)$/);
          if (!item || /^\d/.test(item[1]) !== ordered) break;
          items.push(`<li>${renderInline(item[2])}</li>`);
          i += 1;
        }
        out.push(`<${tag}>${items.join("")}</${tag}>`);
        continue;
      }

      const paragraph = [line.trim()];
      i += 1;
      while (i < lines.length && !isBlockStart(lines, i)) paragraph.push(lines[i++].trim());
      out.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
    }

    return out.join("\n");
  }

  window.MarkdownPreview = { render };
})();
