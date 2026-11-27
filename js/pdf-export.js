/* 导出 PDF（下载文件，不弹出打印预览）
 *
 * 做法：把打印版页面（#print-view / #rec-print-view）在屏幕外按 A4 宽度排版，
 * 用 html2canvas 截图后按 A4 分页，再把每页 JPEG 直接写进一个最小 PDF 文件，
 * 最后以 Blob 下载。这样无需嵌入中文字体，也不会打断用户去操作打印对话框。
 *
 * 依赖 js/vendor/html2canvas.min.js；缺失时由调用方退回 window.print()。
 */
(() => {
  "use strict";

  const A4 = { width: 595.28, height: 841.89 };  // pt
  const MARGIN = 24;                              // pt
  const PT_PER_PX = 0.75;                         // 96dpi → 72dpi
  const CONTENT_WIDTH_PT = A4.width - MARGIN * 2;
  const CONTENT_WIDTH_PX = Math.round(CONTENT_WIDTH_PT / PT_PER_PX);
  const PAGE_HEIGHT_PX = Math.floor((A4.height - MARGIN * 2) / PT_PER_PX);
  const RENDER_SCALE = 2;
  const BREAK_SELECTOR = [
    ".seg", ".zone", ".tl", ".sum", ".sub",
    ".rec-row", ".rec-table tr", ".rec-fields-print", ".rec-note-print", ".rec-foot",
  ].join(",");

  let loading = null;

  function ensureHtml2Canvas() {
    if (typeof window.html2canvas === "function") return Promise.resolve(window.html2canvas);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "js/vendor/html2canvas.min.js";
      script.onload = () => {
        if (typeof window.html2canvas === "function") resolve(window.html2canvas);
        else reject(new Error("PDF 组件不可用"));
      };
      script.onerror = () => {
        loading = null;
        reject(new Error("PDF 组件加载失败"));
      };
      document.head.appendChild(script);
    });
    return loading;
  }

  /** 分页位置（CSS px）：优先在段/表格行边界分页，单块超高时再硬切。 */
  function pageSlices(element, totalHeight) {
    const top = element.getBoundingClientRect().top;
    const candidates = [...element.querySelectorAll(BREAK_SELECTOR)]
      .map((node) => Math.round(node.getBoundingClientRect().top - top))
      .filter((y) => y > 0 && y < totalHeight)
      .sort((a, b) => a - b);

    const anchors = [0];
    for (const y of candidates) {
      if (y - anchors[anchors.length - 1] > PAGE_HEIGHT_PX) anchors.push(y);
    }
    anchors.push(totalHeight);

    const slices = [];
    for (let i = 0; i < anchors.length - 1; i += 1) {
      let start = anchors[i];
      const end = anchors[i + 1];
      while (end - start > PAGE_HEIGHT_PX) {
        slices.push([start, start + PAGE_HEIGHT_PX]);
        start += PAGE_HEIGHT_PX;
      }
      if (end > start) slices.push([start, end]);
    }
    return slices;
  }

  function sliceToJpeg(source, sx, sy, sw, sh) {
    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, sw, sh);
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return { bytes, width: canvas.width, height: canvas.height };
  }

  /** 组装最小 PDF：每页一张 JPEG（DCTDecode），无需嵌入字体。 */
  function buildPdf(pages) {
    const encoder = new TextEncoder();
    const chunks = [];
    const offsets = [];
    let length = 0;

    const push = (data) => {
      const bytes = typeof data === "string" ? encoder.encode(data) : data;
      chunks.push(bytes);
      length += bytes.length;
    };
    const addObject = (id, parts) => {
      offsets[id] = length;
      push(`${id} 0 obj\n`);
      parts.forEach(push);
      push("\nendobj\n");
    };

    push("%PDF-1.4\n");
    push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

    const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(" ");
    addObject(1, ["<< /Type /Catalog /Pages 2 0 R >>"]);
    addObject(2, [`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`]);

    pages.forEach((page, i) => {
      const pageId = 3 + i * 3;
      const imageId = pageId + 1;
      const contentId = pageId + 2;
      const drawWidth = CONTENT_WIDTH_PT;
      const drawHeight = (page.height / page.width) * CONTENT_WIDTH_PT;
      const x = MARGIN;
      const y = A4.height - MARGIN - drawHeight;
      const content = `q ${drawWidth.toFixed(2)} 0 0 ${drawHeight.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im0 Do Q`;

      addObject(pageId, [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width} ${A4.height}]`
        + ` /Resources << /XObject << /Im0 ${imageId} 0 R >> /ProcSet [/PDF /ImageC] >>`
        + ` /Contents ${contentId} 0 R >>`,
      ]);
      addObject(imageId, [
        `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height}`
        + ` /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.bytes.length} >>\nstream\n`,
        page.bytes,
        "\nendstream",
      ]);
      addObject(contentId, [
        `<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`,
      ]);
    });

    const totalObjects = 3 + pages.length * 3 - 1;
    const xrefOffset = length;
    let xref = `xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`;
    for (let id = 1; id <= totalObjects; id += 1) {
      xref += `${String(offsets[id] || 0).padStart(10, "0")} 00000 n \n`;
    }
    push(xref);
    push(`trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

    const out = new Uint8Array(length);
    let offset = 0;
    chunks.forEach((chunk) => {
      out.set(chunk, offset);
      offset += chunk.length;
    });
    return out;
  }

  function safeFileName(name, fallback = "运转计划") {
    const cleaned = String(name || "").replace(/[\\/:*?"<>|\r\n]/g, "_").trim();
    return cleaned || fallback;
  }

  function triggerDownload(bytes, filename) {
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename.endsWith(".pdf") ? filename : `${filename}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /**
   * 把元素内容导出为 PDF 并下载。
   * @param {HTMLElement} element 打印版容器（内部为已渲染好的表格 / 段落）
   * @param {{ filename?: string }} options
   */
  async function download(element, { filename = "运转计划" } = {}) {
    const html2canvas = await ensureHtml2Canvas();
    const restore = { hidden: element.hidden, className: element.className, width: element.style.width };
    element.hidden = false;
    element.classList.add("pdf-render");
    element.style.width = `${CONTENT_WIDTH_PX}px`;
    try {
      if (document.fonts?.ready) await document.fonts.ready;
      const totalHeight = Math.ceil(element.getBoundingClientRect().height) || element.scrollHeight;
      const canvas = await html2canvas(element, {
        scale: RENDER_SCALE,
        backgroundColor: "#ffffff",
        useCORS: true,
        logging: false,
        width: CONTENT_WIDTH_PX,
        windowWidth: CONTENT_WIDTH_PX,
      });
      const slices = pageSlices(element, totalHeight);
      const pages = slices.map(([start, end]) => sliceToJpeg(
        canvas,
        0,
        Math.round(start * RENDER_SCALE),
        canvas.width,
        Math.max(1, Math.round((end - start) * RENDER_SCALE)),
      ));
      triggerDownload(buildPdf(pages), safeFileName(filename));
      return pages.length;
    } finally {
      element.hidden = restore.hidden;
      element.className = restore.className;
      element.style.width = restore.width;
    }
  }

  window.PDFExport = { download, buildPdf };
})();
