/* 运转记录：按时间记录一次真实运转，自动保存草稿，导出 JSON / PDF。 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad2 = (n) => String(n).padStart(2, "0");
  const D = window.TPDrafts;

  const DEFAULT_TITLE = "我的运转记录";

  const TYPE_COLORS = {
    "地铁": "#2f6feb",
    "metro": "#2f6feb",
    "市域铁路": "#0f9b8e",
    "国铁": "#8a5a2b",
    "高铁": "#c0392b",
    "城际铁路": "#d05a1e",
    "公交": "#e08a1e",
    "有轨电车": "#7a4fd0",
    "磁浮": "#0aa3c2",
    "轮渡": "#1f8a4c",
    "步行": "#8d96a5",
    "其他": "#5b6472",
  };

  const state = {
    draftId: "",
    record: D.empty("record"),
    editing: -1,
    dialogExtras: [],
  };

  // ---------------- 小工具 ----------------

  function timeToMinutes(value) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }

  function durationOfTimes(start, end) {
    const a = timeToMinutes(start);
    const b = timeToMinutes(end);
    if (a == null || b == null) return null;
    return b >= a ? b - a : b + 24 * 60 - a;
  }

  function durationOf(segment) {
    return durationOfTimes(segment?.start, segment?.end);
  }

  function isOvernight(segment) {
    const a = timeToMinutes(segment?.start);
    const b = timeToMinutes(segment?.end);
    return a != null && b != null && b < a;
  }

  function formatDuration(minutes) {
    if (minutes == null || !Number.isFinite(minutes)) return "—";
    const total = Math.max(0, Math.round(minutes));
    if (total < 60) return `${total} 分钟`;
    const h = Math.floor(total / 60);
    const m = total % 60;
    return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
  }

  function typeColor(type) {
    const key = String(type || "").trim();
    if (TYPE_COLORS[key]) return TYPE_COLORS[key];
    let hash = 0;
    for (const ch of key || "其他") hash = (hash * 31 + ch.charCodeAt(0)) % 360;
    return `hsl(${hash} 62% 45%)`;
  }

  function toast(msg) {
    const el = $("rec-toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { el.hidden = true; }, 2200);
  }

  // ---------------- 数据规范化 ----------------

  function normalizeField(field) {
    return {
      label: String(field?.label ?? ""),
      value: String(field?.value ?? ""),
    };
  }

  function normalizeSegment(segment) {
    const s = segment && typeof segment === "object" ? segment : {};
    return {
      type: String(s.type ?? ""),
      line: String(s.line ?? s.line_name ?? ""),
      train: String(s.train ?? s.train_no ?? ""),
      model: String(s.model ?? s.train_model ?? ""),
      from: String(s.from ?? s.from_station ?? ""),
      start: String(s.start ?? s.start_time ?? ""),
      to: String(s.to ?? s.to_station ?? ""),
      end: String(s.end ?? s.end_time ?? ""),
      price: s.price == null ? "" : String(s.price),
      note: String(s.note ?? ""),
      extras: (Array.isArray(s.extras) ? s.extras : []).map(normalizeField),
    };
  }

  // ---------------- 草稿读写 ----------------

  function initDraft() {
    D.migrateLegacy();
    const params = new URLSearchParams(location.search);
    const requestedId = params.get("id");
    let draft = requestedId ? D.get("record", requestedId) : null;
    if (!draft) draft = D.list("record")[0] || null;
    if (!draft) {
      const data = D.empty("record");
      draft = D.create("record", { title: DEFAULT_TITLE, summary: D.summarize("record", data), data });
    }

    state.draftId = draft.id;
    const data = draft.data && typeof draft.data === "object" ? draft.data : D.empty("record");
    state.record = {
      ...D.empty("record"),
      ...data,
      title: String(data.title ?? draft.title ?? DEFAULT_TITLE),
      date: String(data.date ?? ""),
      note: String(data.note ?? ""),
      fields: (Array.isArray(data.fields) ? data.fields : []).map(normalizeField),
      segments: (Array.isArray(data.segments) ? data.segments : []).map(normalizeSegment),
    };
    if (!state.record.date) state.record.date = D.todayISO();

    $("rec-title").value = state.record.title;
    $("rec-date").value = state.record.date;
    $("rec-note").value = state.record.note;

    markSaved(draft.updatedAt);
    renderAll();
  }

  let saveTimer = null;

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 350);
  }

  function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!state.draftId) return;
    const saved = D.save("record", {
      id: state.draftId,
      title: state.record.title.trim() || DEFAULT_TITLE,
      summary: D.summarize("record", state.record),
      data: state.record,
    });
    markSaved(saved.updatedAt);
  }

  function markSaved(iso) {
    const el = $("rec-save-state");
    const d = iso ? new Date(iso) : new Date();
    if (!Number.isNaN(d.getTime())) {
      el.textContent = `已自动保存 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    }
    document.title = `${state.record.title.trim() || DEFAULT_TITLE} · 运转记录 · 运转计划助手`;
  }

  function touch() {
    scheduleSave();
    renderAll();
  }

  // ---------------- 渲染 ----------------

  function renderAll() {
    renderList();
    renderStats();
    renderTimeline();
    renderTripFields();
  }

  function renderList() {
    const segments = state.record.segments;
    if (!segments.length) {
      $("rec-list").innerHTML = `
        <div class="rec-empty">
          <p><b>还没有记录。</b>点击下方「＋ 添加一段行程」开始记录这次运转。</p>
          <p class="hint">每一段可以填写交通类型、线路、起止站与时间、车型，以及任意自定义字段。</p>
        </div>`;
      return;
    }
    $("rec-list").innerHTML = segments.map(segmentCardHtml).join("");
  }

  function segmentCardHtml(segment, index) {
    const duration = durationOf(segment);
    const color = typeColor(segment.type);
    const lineText = [segment.line, segment.train].filter(Boolean).join(" · ") || "未命名线路";
    const extras = (segment.extras || []).filter((f) => f.label || f.value);
    const hasMeta = segment.price !== "" || segment.note || extras.length;

    return `
      <article class="rec-card" data-i="${index}">
        <div class="rec-ribbon" style="background:${color}"></div>
        <div class="body">
          <div class="rec-head">
            <span class="rec-seq">${pad2(index + 1)}</span>
            <span class="rec-type" style="background:${color}">${esc(segment.type || "未填写类型")}</span>
            <span class="rec-line">${esc(lineText)}</span>
            ${segment.model ? `<span class="rec-train">${esc(segment.model)}</span>` : ""}
            <span class="rec-actions">
              <button type="button" class="ghost" data-act="up" data-i="${index}" title="上移" ${index === 0 ? "disabled" : ""}>↑</button>
              <button type="button" class="ghost" data-act="down" data-i="${index}" title="下移" ${index === state.record.segments.length - 1 ? "disabled" : ""}>↓</button>
              <button type="button" class="ghost" data-act="edit" data-i="${index}">编辑</button>
              <button type="button" class="ghost" data-act="del" data-i="${index}">删除</button>
            </span>
          </div>

          <div class="rec-route">
            <div class="rec-end">
              <div class="t">${esc(segment.start || "--:--")}</div>
              <div class="s">${esc(segment.from || "未填写起始站")}</div>
            </div>
            <div class="rec-arrow">
              <span class="dur">${duration == null ? "用时未填" : esc(formatDuration(duration))}${isOvernight(segment) ? " · 跨天" : ""}</span>
              <div class="bar" style="background:${color}"></div>
              <span class="line">${esc(segment.line || segment.train || "—")}</span>
            </div>
            <div class="rec-end right">
              <div class="t">${esc(segment.end || "--:--")}</div>
              <div class="s">${esc(segment.to || "未填写到达站")}</div>
            </div>
          </div>

          ${hasMeta ? `<div class="rec-meta">
            ${segment.price !== "" ? `<span class="rec-price">票价 ¥${esc(segment.price)}</span>` : ""}
            ${segment.note ? `<span>${esc(segment.note)}</span>` : ""}
            ${extras.map((f) => `<span class="rec-chip">${esc(f.label || "字段")}：${esc(f.value || "")}</span>`).join("")}
          </div>` : ""}
        </div>
      </article>`;
  }

  function computeStats(segments) {
    let totalRun = 0;
    let price = 0;
    let missing = 0;
    let day = 0;
    let prevEnd = null;
    let firstAbs = null;
    let lastAbs = null;
    const types = new Set();

    segments.forEach((segment) => {
      if (segment.type) types.add(segment.type);
      const p = segment.price === "" ? NaN : Number(segment.price);
      if (Number.isFinite(p)) price += p;

      const a = timeToMinutes(segment.start);
      const b = timeToMinutes(segment.end);
      if (a == null || b == null) {
        missing += 1;
        return;
      }

      let startAbs = day * 1440 + a;
      if (prevEnd != null && startAbs < prevEnd) {
        day += 1;
        startAbs += 1440;
      }
      let endAbs = startAbs - a + b;
      if (endAbs < startAbs) endAbs += 1440;

      totalRun += endAbs - startAbs;
      if (firstAbs == null) firstAbs = startAbs;
      lastAbs = endAbs;
      prevEnd = endAbs;
    });

    return {
      count: segments.length,
      types: [...types],
      totalRun,
      span: firstAbs == null ? null : lastAbs - firstAbs,
      price,
      missing,
    };
  }

  function renderStats() {
    const stats = computeStats(state.record.segments);
    const cells = [
      ["记录段数", `${stats.count} 段`],
      ["交通类型", stats.types.length ? stats.types.join(" / ") : "—"],
      ["总乘车时长", stats.totalRun ? formatDuration(stats.totalRun) : "—"],
      ["全程跨度", stats.span != null ? formatDuration(stats.span) : "—"],
      ["票价合计", stats.price ? `¥${Number(stats.price.toFixed(2))}` : "—"],
      ["待补时间", stats.missing ? `${stats.missing} 段` : "无"],
    ];
    $("rec-stats").innerHTML = cells
      .map(([k, v]) => `<div class="cell"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`)
      .join("");
  }

  function renderTimeline() {
    const timed = state.record.segments
      .map((segment) => ({ segment, duration: durationOf(segment) }))
      .filter((item) => item.duration != null && item.duration > 0);

    if (!timed.length) {
      $("rec-timeline").innerHTML = '<p class="hint">填写起止时间后，这里按用时比例显示彩色时间轴。</p>';
      return;
    }

    const total = timed.reduce((sum, item) => sum + item.duration, 0) || 1;
    const bars = timed.map(({ segment, duration }) => {
      const color = typeColor(segment.type);
      const label = `${segment.line || segment.type || "未命名"} ${formatDuration(duration)}`;
      return `<div style="flex:${duration};background:${color}" title="${esc(label)}"></div>`;
    }).join("");
    const legend = timed.map(({ segment, duration }) => {
      const color = typeColor(segment.type);
      return `<span><i class="dot" style="background:${color}"></i>${esc(segment.line || segment.type || "—")} ${esc(formatDuration(duration))}</span>`;
    }).join("");

    const firstStart = state.record.segments.find((s) => s.start)?.start || "";
    const lastEnd = [...state.record.segments].reverse().find((s) => s.end)?.end || "";
    const range = firstStart && lastEnd
      ? `${esc(firstStart)} → ${esc(lastEnd)} · 乘车合计 ${esc(formatDuration(total))}`
      : `乘车合计 ${esc(formatDuration(total))}`;

    $("rec-timeline").innerHTML = `
      <div class="tl-bar">${bars}</div>
      <div class="tl-legend">${legend}</div>
      <p class="hint" style="margin:4px 0 0">${range}</p>`;
  }

  function renderTripFields() {
    const fields = state.record.fields;
    if (!fields.length) {
      $("rec-fields").innerHTML = '<p class="hint" style="margin:0">可添加「天气」「同行人」等整次运转的字段。</p>';
      return;
    }
    $("rec-fields").innerHTML = fields.map((field, index) => `
      <div class="extra-row">
        <input type="text" data-field-label="${index}" value="${esc(field.label)}" placeholder="字段名">
        <input type="text" data-field-value="${index}" value="${esc(field.value)}" placeholder="内容">
        <button type="button" class="ghost" data-field-del="${index}" title="删除字段">✕</button>
      </div>`).join("");
  }

  // ---------------- 顶栏与侧栏交互 ----------------

  $("rec-title").addEventListener("input", (ev) => {
    state.record.title = ev.target.value;
    scheduleSave();
    document.title = `${state.record.title.trim() || DEFAULT_TITLE} · 运转记录 · 运转计划助手`;
  });

  $("rec-date").addEventListener("change", (ev) => {
    state.record.date = ev.target.value;
    scheduleSave();
  });

  $("rec-note").addEventListener("input", (ev) => {
    state.record.note = ev.target.value;
    scheduleSave();
  });

  $("btn-rec-field-add").addEventListener("click", () => {
    state.record.fields.push({ label: "", value: "" });
    renderTripFields();
    scheduleSave();
    const inputs = $("rec-fields").querySelectorAll("[data-field-label]");
    inputs[inputs.length - 1]?.focus();
  });

  $("rec-fields").addEventListener("input", (ev) => {
    const el = ev.target;
    if (el.dataset.fieldLabel != null) {
      state.record.fields[Number(el.dataset.fieldLabel)].label = el.value;
      scheduleSave();
    } else if (el.dataset.fieldValue != null) {
      state.record.fields[Number(el.dataset.fieldValue)].value = el.value;
      scheduleSave();
    }
  });

  $("rec-fields").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-field-del]");
    if (!btn) return;
    state.record.fields.splice(Number(btn.dataset.fieldDel), 1);
    renderTripFields();
    scheduleSave();
  });

  // ---------------- 行程卡片交互 ----------------

  $("rec-list").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-act]");
    if (!btn) return;
    const index = Number(btn.dataset.i);
    const segments = state.record.segments;
    const act = btn.dataset.act;

    if (act === "edit") {
      openDialog(index);
      return;
    }
    if (act === "del") {
      const label = segments[index]?.line || segments[index]?.type || `第 ${index + 1} 段`;
      if (!confirm(`确定删除「${label}」这条记录吗？`)) return;
      segments.splice(index, 1);
    } else if (act === "up" && index > 0) {
      [segments[index - 1], segments[index]] = [segments[index], segments[index - 1]];
    } else if (act === "down" && index < segments.length - 1) {
      [segments[index + 1], segments[index]] = [segments[index], segments[index + 1]];
    } else {
      return;
    }
    touch();
  });

  // ---------------- 添加 / 编辑弹窗 ----------------

  function setDialogError(msg) {
    $("seg-error").hidden = !msg;
    $("seg-error").textContent = msg || "";
  }

  function renderSegExtras() {
    const box = $("seg-extras");
    if (!state.dialogExtras.length) {
      box.innerHTML = '<p class="hint" style="margin:0 0 4px">可为本段添加专属字段，如座位号、编组、拍摄位置。</p>';
      return;
    }
    box.innerHTML = state.dialogExtras.map((field, index) => `
      <div class="extra-row">
        <input type="text" data-extra-label="${index}" value="${esc(field.label)}" placeholder="字段名">
        <input type="text" data-extra-value="${index}" value="${esc(field.value)}" placeholder="内容">
        <button type="button" class="ghost" data-extra-del="${index}" title="删除字段">✕</button>
      </div>`).join("");
  }

  function updateDurationHint() {
    const start = $("seg-start").value;
    const end = $("seg-end").value;
    const hint = $("seg-duration-hint");
    if (!start || !end) {
      hint.textContent = "填写起始与到达时间后自动计算用时";
      return;
    }
    const duration = durationOfTimes(start, end);
    if (duration == null) {
      hint.textContent = "时间格式无法识别";
      return;
    }
    hint.textContent = `本段用时 ${formatDuration(duration)}${end < start ? "（跨天）" : ""}`;
  }

  function openDialog(index = -1) {
    state.editing = index;
    const segment = index >= 0 ? state.record.segments[index] : null;

    $("rec-dlg-title").textContent = segment ? `编辑第 ${index + 1} 段行程` : "添加行程记录";
    $("rec-dlg-subtitle").textContent = state.record.title || DEFAULT_TITLE;

    $("seg-type").value = segment?.type || "地铁";
    $("seg-line").value = segment?.line || "";
    $("seg-train").value = segment?.train || "";
    $("seg-model").value = segment?.model || "";
    $("seg-from").value = segment?.from || "";
    $("seg-start").value = segment?.start || "";
    $("seg-to").value = segment?.to || "";
    $("seg-end").value = segment?.end || "";
    $("seg-price").value = segment?.price || "";
    $("seg-note").value = segment?.note || "";

    if (!segment && state.record.segments.length) {
      // 连续记录时，自动带入上一段的到达站与到达时间
      const prev = state.record.segments[state.record.segments.length - 1];
      if (!$("seg-from").value) $("seg-from").value = prev.to || "";
      if (!$("seg-start").value) $("seg-start").value = prev.end || "";
    }

    state.dialogExtras = (segment?.extras || []).map((f) => ({ label: f.label || "", value: f.value || "" }));
    renderSegExtras();
    setDialogError("");
    updateDurationHint();
    $("rec-dialog").showModal();
    setTimeout(() => $("seg-type").focus(), 0);
  }

  function closeDialog() {
    state.editing = -1;
    $("rec-dialog").close();
  }

  function collectDialog() {
    return normalizeSegment({
      type: $("seg-type").value.trim(),
      line: $("seg-line").value.trim(),
      train: $("seg-train").value.trim(),
      model: $("seg-model").value.trim(),
      from: $("seg-from").value.trim(),
      start: $("seg-start").value,
      to: $("seg-to").value.trim(),
      end: $("seg-end").value,
      price: $("seg-price").value.trim(),
      note: $("seg-note").value.trim(),
      extras: state.dialogExtras
        .map((f) => ({ label: f.label.trim(), value: f.value.trim() }))
        .filter((f) => f.label || f.value),
    });
  }

  function saveDialog() {
    const segment = collectDialog();
    if (!segment.from || !segment.to) {
      setDialogError("请填写起始站与到达站");
      return;
    }
    const wasEdit = state.editing >= 0;
    if (wasEdit) state.record.segments[state.editing] = segment;
    else state.record.segments.push(segment);

    const savedIndex = wasEdit ? state.editing : state.record.segments.length - 1;
    $("rec-dialog").close();
    state.editing = -1;
    touch();
    toast(wasEdit ? "已更新行程" : "已添加行程");
    requestAnimationFrame(() => {
      document.querySelector(`.rec-card[data-i="${savedIndex}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }

  $("btn-rec-add").addEventListener("click", () => openDialog(-1));
  $("btn-rec-dlg-close").addEventListener("click", closeDialog);
  $("btn-rec-dlg-cancel").addEventListener("click", closeDialog);
  $("btn-rec-dlg-save").addEventListener("click", saveDialog);
  $("rec-dialog").addEventListener("submit", (ev) => {
    ev.preventDefault();
    saveDialog();
  });
  $("rec-dialog").addEventListener("click", (ev) => {
    if (ev.target === $("rec-dialog")) closeDialog();
  });
  $("rec-dialog").addEventListener("close", () => { state.editing = -1; });

  $("seg-start").addEventListener("input", updateDurationHint);
  $("seg-end").addEventListener("input", updateDurationHint);

  $("btn-seg-extra-add").addEventListener("click", () => {
    state.dialogExtras.push({ label: "", value: "" });
    renderSegExtras();
    const inputs = $("seg-extras").querySelectorAll("[data-extra-label]");
    inputs[inputs.length - 1]?.focus();
  });

  $("seg-extras").addEventListener("input", (ev) => {
    const el = ev.target;
    if (el.dataset.extraLabel != null) {
      state.dialogExtras[Number(el.dataset.extraLabel)].label = el.value;
    } else if (el.dataset.extraValue != null) {
      state.dialogExtras[Number(el.dataset.extraValue)].value = el.value;
    }
  });

  $("seg-extras").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-extra-del]");
    if (!btn) return;
    state.dialogExtras.splice(Number(btn.dataset.extraDel), 1);
    renderSegExtras();
  });

  // ---------------- 导出 JSON ----------------

  function exportData() {
    return {
      kind: "record",
      version: 1,
      exportedAt: new Date().toISOString(),
      title: state.record.title.trim() || DEFAULT_TITLE,
      date: state.record.date || "",
      note: state.record.note,
      fields: state.record.fields.filter((f) => f.label || f.value),
      segments: state.record.segments,
    };
  }

  $("btn-rec-export").addEventListener("click", () => {
    flushSave();
    if (!state.record.segments.length) {
      toast("还没有可导出的行程记录");
      return;
    }
    D.downloadJSON(D.safeFileName(state.record.title, DEFAULT_TITLE), exportData());
    toast("已导出 JSON");
  });

  // ---------------- 导出 PDF（打印） ----------------

  $("btn-rec-print").addEventListener("click", () => {
    flushSave();
    if (!state.record.segments.length) {
      toast("还没有可导出的行程记录");
      return;
    }
    $("rec-print-view").innerHTML = buildPrintSheet();
    $("rec-print-view").hidden = false;

    const savedTitle = document.title;
    document.title = D.safeFileName(state.record.title, DEFAULT_TITLE);
    window.addEventListener("afterprint", () => {
      $("rec-print-view").hidden = true;
      document.title = savedTitle;
    }, { once: true });
    window.print();
  });

  function buildPrintSheet() {
    const record = state.record;
    const stats = computeStats(record.segments);
    const fields = record.fields.filter((f) => f.label || f.value);

    const rows = record.segments.map((segment, index) => {
      const duration = durationOf(segment);
      const extras = (segment.extras || [])
        .filter((f) => f.label || f.value)
        .map((f) => `${f.label || "字段"}：${f.value || ""}`)
        .join("；");
      const detail = [segment.note, extras].filter(Boolean).join("；");
      return `<tr>
        <td>${index + 1}</td>
        <td>${esc(segment.type || "")}</td>
        <td><b>${esc(segment.line || "")}</b>${segment.train ? `<br>${esc(segment.train)}` : ""}</td>
        <td>${esc(segment.from || "")}</td>
        <td>${esc(segment.start || "")}</td>
        <td>${esc(segment.to || "")}</td>
        <td>${esc(segment.end || "")}</td>
        <td>${duration == null ? "—" : esc(formatDuration(duration))}${isOvernight(segment) ? "<br>跨天" : ""}</td>
        <td>${esc(segment.model || "")}</td>
        <td>${segment.price !== "" ? esc(segment.price) : ""}</td>
        <td>${esc(detail)}</td>
      </tr>`;
    }).join("");

    const summary = [
      `共 ${stats.count} 段`,
      `乘车 ${formatDuration(stats.totalRun)}`,
      stats.span != null ? `全程 ${formatDuration(stats.span)}` : "",
      stats.price ? `票价 ¥${Number(stats.price.toFixed(2))}` : "",
    ].filter(Boolean).join(" · ");

    return `
      <div class="rec-sheet">
        <h1>${esc(record.title || DEFAULT_TITLE)}</h1>
        <div class="rec-sub">${esc(record.date || "")}${record.date ? " · " : ""}生成于 ${esc(new Date().toLocaleString("zh-CN"))}</div>
        <div class="rec-sum">${esc(summary)}</div>
        ${fields.length ? `<div class="rec-fields-print">${fields.map((f) => `<span><b>${esc(f.label || "字段")}</b>：${esc(f.value || "")}</span>`).join("　")}</div>` : ""}
        <table class="rec-table">
          <thead>
            <tr>
              <th>#</th><th>交通类型</th><th>线路 / 车次</th><th>起始站</th><th>起始时间</th>
              <th>到达站</th><th>到达时间</th><th>用时</th><th>车型</th><th>票价</th><th>备注 / 自定义</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        ${record.note ? `<div class="rec-note-print"><b>备注</b>：${esc(record.note)}</div>` : ""}
        <div class="rec-foot">由《运转计划助手 · Web》记录 · 时间为手动录入，请以实际乘车为准</div>
      </div>`;
  }

  // ---------------- 自动保存兜底 ----------------

  window.addEventListener("pagehide", flushSave);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSave();
  });

  initDraft();
})();
