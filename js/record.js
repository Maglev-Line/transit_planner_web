/* 运转记录：按时间记录一次真实运转，草稿自动保存，导出 JSON / PDF。
 *
 * 数据结构与「规划」完全一致（Trip）：顶层 name / date / city / note /
 * transfer_walk_default / paid_zone_mode / steps，每段使用 Step 的字段名，
 * 额外增加 start_time / end_time / train_no / train_model / extras 供记录使用。
 * 因此规划与记录的 JSON 可以互相导入（规划器会忽略记录专有字段）。
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad2 = (n) => String(n).padStart(2, "0");
  const numOrNull = (v) => (v === "" || v == null ? null : Number(v));
  const D = window.TPDrafts;

  const DEFAULT_TITLE = "我的运转记录";
  const MANUAL_TYPES = ["地铁", "市域铁路", "国铁", "高铁", "城际铁路", "公交", "有轨电车", "磁浮", "轮渡", "步行", "其他"];

  // 内置交通类型的中文名：内核未加载时也能把 metro / bus 等 key 显示成中文
  const BUILTIN_TYPE_LABELS = {
    metro: "地铁", suburban: "市域铁路", tram: "有轨电车", monorail: "单轨",
    cloudrail: "比亚迪云巴", bus: "公交", national_rail: "国家铁路", maglev: "磁浮",
    ferry: "轮渡", cableway: "索道", apm: "APM",
  };

  const TYPE_COLORS = {
    "地铁": "#2f6feb", "metro": "#2f6feb", "市域铁路": "#0f9b8e", "suburban": "#0f9b8e",
    "国铁": "#8a5a2b", "national_rail": "#8a5a2b", "高铁": "#c0392b", "城际铁路": "#d05a1e",
    "公交": "#e08a1e", "bus": "#e08a1e", "有轨电车": "#7a4fd0", "tram": "#7a4fd0",
    "磁浮": "#0aa3c2", "maglev": "#0aa3c2", "轮渡": "#1f8a4c", "ferry": "#1f8a4c",
    "步行": "#8d96a5", "其他": "#5b6472",
  };

  const state = {
    draftId: "",
    record: D.empty("record"),
    editing: -1,
    dialogExtras: [],
    kernel: { ready: false, loading: false, error: "", cities: [], typeLabels: {} },
    city: "",
    lines: [],
    lineDetail: new Map(),
    dialog: {
      mode: "manual", lineId: "", line: null, runMinutes: null, stops: [],
      type: "", color: "", color2: "", prefillFrom: "",
    },
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

  function isOvernight(step) {
    const a = timeToMinutes(step?.start_time);
    const b = timeToMinutes(step?.end_time);
    return a != null && b != null && b < a;
  }

  /** 本段用时：优先按实际时间，其次按线路 / 手动填写的运行时长。 */
  function durationOf(step) {
    const byTimes = durationOfTimes(step?.start_time, step?.end_time);
    if (byTimes != null) return byTimes;
    const run = step?.run_minutes;
    return run == null || !Number.isFinite(Number(run)) ? null : Number(run);
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

  function typeLabelOf(type) {
    const key = String(type || "").trim();
    return state.kernel.typeLabels[key] || BUILTIN_TYPE_LABELS[key] || key || "未填写类型";
  }

  function toast(msg) {
    const el = $("rec-toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { el.hidden = true; }, 2400);
  }

  function debounce(fn, ms = 260) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  // ---------------- 数据规范化（兼容规划方案与旧版记录） ----------------

  function normalizeField(field) {
    return { label: String(field?.label ?? ""), value: String(field?.value ?? "") };
  }

  /** 统一成规划方案的 Step 字段；同时接受旧版记录字段（from/to/start/end/line/train/model）。 */
  function normalizeStep(raw) {
    const s = raw && typeof raw === "object" ? raw : {};
    const num = (v) => (v == null || v === "" ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
    return {
      line_id: String(s.line_id ?? ""),
      direction_label: String(s.direction_label ?? ""),
      from_station: String(s.from_station ?? s.from ?? ""),
      to_station: String(s.to_station ?? s.to ?? ""),
      walk_minutes: num(s.walk_minutes),
      manual: s.manual === undefined ? !s.line_id : Boolean(s.manual),
      type: String(s.type ?? ""),
      line_name: String(s.line_name ?? s.line ?? ""),
      run_minutes: num(s.run_minutes),
      stops_text: String(s.stops_text ?? ""),
      color: String(s.color ?? ""),
      color2: String(s.color2 ?? ""),
      note: String(s.note ?? ""),
      headway_text: String(s.headway_text ?? ""),
      timetable: Array.isArray(s.timetable) ? s.timetable : [],
      use_timetable: Boolean(s.use_timetable),
      price: num(s.price),
      transfer: typeof s.transfer === "boolean" ? s.transfer : null,
      service: String(s.service ?? ""),
      start_time: String(s.start_time ?? s.start ?? ""),
      end_time: String(s.end_time ?? s.end ?? ""),
      train_no: String(s.train_no ?? s.train ?? ""),
      train_model: String(s.train_model ?? s.model ?? ""),
      extras: (Array.isArray(s.extras) ? s.extras : []).map(normalizeField),
    };
  }

  /** 统一成规划方案的 Trip 结构；`segments` 是旧版记录的写法。 */
  function normalizeRecord(raw) {
    const base = D.empty("record");
    const data = raw && typeof raw === "object" ? raw : {};
    const steps = Array.isArray(data.steps) ? data.steps : (Array.isArray(data.segments) ? data.segments : []);
    return {
      ...base,
      ...data,
      name: String(data.name ?? data.title ?? base.name),
      date: String(data.date ?? ""),
      city: String(data.city ?? ""),
      note: String(data.note ?? ""),
      transfer_walk_default: Number.isFinite(Number(data.transfer_walk_default)) ? Number(data.transfer_walk_default) : 5,
      paid_zone_mode: Boolean(data.paid_zone_mode),
      fields: (Array.isArray(data.fields) ? data.fields : []).map(normalizeField),
      steps: steps.filter((s) => s && typeof s === "object").map(normalizeStep),
    };
  }

  // ---------------- 草稿读写 ----------------

  let saveTimer = null;

  function initDraft() {
    D.migrateLegacy();
    const requestedId = new URLSearchParams(location.search).get("id");
    let draft = requestedId ? D.get("record", requestedId) : null;
    if (!draft) draft = D.list("record")[0] || null;
    if (!draft) {
      const data = D.empty("record");
      draft = D.create("record", { title: DEFAULT_TITLE, summary: D.summarize("record", data), data });
    }

    state.draftId = draft.id;
    state.record = normalizeRecord(draft.data);
    if (draft.title && !state.record.name) state.record.name = draft.title;
    if (!state.record.date) state.record.date = D.todayISO();

    $("rec-title").value = state.record.name;
    $("rec-date").value = state.record.date;
    $("rec-note").value = state.record.note;
    fillCitySelect();

    markSaved(draft.updatedAt);
    renderAll();
    syncKernelButton();
    if (state.record.city) warmKernel();
  }

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
      title: state.record.name.trim() || DEFAULT_TITLE,
      summary: D.summarize("record", state.record),
      data: state.record,
    });
    markSaved(saved.updatedAt);
  }

  function markSaved(iso) {
    const el = $("rec-save-state");
    const d = iso ? new Date(iso) : new Date();
    if (!Number.isNaN(d.getTime())) el.textContent = `已自动保存 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    document.title = `${state.record.name.trim() || DEFAULT_TITLE} · 记录模式 · 运转计划助手`;
  }

  function touch() {
    scheduleSave();
    renderAll();
  }

  // ---------------- 规划内核（按需加载） ----------------

  function setKernelHint(text, { error = false } = {}) {
    const hint = $("rec-mode-hint");
    hint.textContent = text;
    hint.style.color = error ? "var(--warn)" : "";
  }

  /** 懒加载内核：只有用到数据库线路时才下载 Pyodide。 */
  async function warmKernel() {
    if (state.kernel.ready) return true;
    if (state.kernel.loading) return false;
    if (!window.TP) {
      setKernelHint("线路库未加载，只能使用手动自选");
      return false;
    }
    state.kernel.loading = true;
    state.kernel.error = "";
    setKernelHint("正在加载线路库…");
    syncKernelButton();
    try {
      const info = await TP.ensure();
      state.kernel.cities = [...new Set([...(info.cities || []), ...Object.keys(info.combinedCities || {})])];
      state.kernel.typeLabels = info.typeLabels || {};
      state.kernel.ready = true;
      state.kernel.loading = false;
      fillCitySelect();
      setKernelHint("线路库已就绪：可选用数据库线路，自动计算运行时长与经停站。");
      if (state.record.city) await setCity(state.record.city, { silent: true });
      await refreshStationOptions();
      syncKernelButton();
      renderAll();
      return true;
    } catch (err) {
      state.kernel.loading = false;
      state.kernel.ready = false;
      state.kernel.error = err?.message || String(err);
      setKernelHint(`线路库加载失败：${state.kernel.error}。可继续使用手动自选。`, { error: true });
      syncKernelButton();
      return false;
    }
  }

  function fillCitySelect() {
    const sel = $("rec-city");
    const cities = state.kernel.cities || [];
    const opts = ['<option value="">（不使用线路库 · 纯手动）</option>'];
    cities.forEach((name) => opts.push(`<option value="${esc(name)}">${esc(name)}</option>`));
    if (state.record.city && !cities.includes(state.record.city)) {
      opts.push(`<option value="${esc(state.record.city)}">${esc(state.record.city)}</option>`);
    }
    sel.innerHTML = opts.join("");
    sel.value = state.record.city || "";
    const editorParams = new URLSearchParams({ from: "record" });
    if (state.record.city) editorParams.set("city", state.record.city);
    $("btn-rec-editor").href = `editor.html?${editorParams}`;
  }

  async function setCity(name, { silent = false } = {}) {
    state.record.city = name || "";
    state.city = state.record.city;
    $("rec-city").value = state.record.city;
    state.lines = [];
    state.lineDetail.clear();
    if (!name) {
      if (!silent) await refreshStationOptions();
      scheduleSave();
      return;
    }
    const ready = await warmKernel();
    if (!ready) {
      if (!silent) toast("线路库尚未就绪，可先用手动自选");
      return;
    }
    const res = TP.loadCity(name);
    if (!res.ok) {
      if (!silent) toast(res.error || "加载线路库失败");
      return;
    }
    state.lines = res.lines || [];
    await refreshStationOptions();
    renderAll();
    if (!silent) scheduleSave();
  }

  async function refreshStationOptions() {
    const box = $("rec-station-options");
    if (!state.kernel.ready || !state.city) {
      box.innerHTML = "";
      return;
    }
    const res = TP.stations();
    if (!res.ok) return;
    box.innerHTML = res.stations.map((s) => `<option value="${esc(s)}"></option>`).join("");
  }

  $("rec-city").addEventListener("change", (ev) => setCity(ev.target.value));

  /** 线路库未就绪时，通过按钮手动加载；加载成功后隐藏按钮并填入城市列表。 */
  function syncKernelButton() {
    const button = $("btn-rec-kernel");
    button.hidden = state.kernel.ready;
    button.textContent = state.kernel.loading ? "加载中…" : (state.kernel.error ? "重试加载线路库" : "加载线路库");
    button.disabled = state.kernel.loading;
  }

  $("btn-rec-kernel").addEventListener("click", async () => {
    const ok = await warmKernel();
    syncKernelButton();
    if (ok && !state.record.city) toast("线路库已就绪，可在上方选择城市");
    if (!ok) toast(state.kernel.error || "线路库加载失败");
  });

  // ---------------- 渲染 ----------------

  function renderAll() {
    renderList();
    renderStats();
    renderTimeline();
    renderTripFields();
  }

  function renderList() {
    const steps = state.record.steps;
    if (!steps.length) {
      $("rec-list").innerHTML = `
        <div class="rec-empty">
          <p><b>还没有记录。</b>点击下方「＋ 添加一段行程」开始记录这次运转。</p>
          <p class="hint">可选用数据库线路（自动计算运行时长与经停站），也可手动填写任意交通方式。</p>
        </div>`;
      return;
    }
    $("rec-list").innerHTML = steps.map(segmentCardHtml).join("");
  }

  function segmentCardHtml(step, index) {
    const duration = durationOf(step);
    const color = step.color || typeColor(step.type);
    const lineText = [step.line_name || step.line_id, step.train_no].filter(Boolean).join(" · ") || "未命名线路";
    const extras = (step.extras || []).filter((f) => f.label || f.value);
    const hasMeta = step.price != null || step.note || extras.length;
    const badges = [
      step.service ? `<span class="rec-train rec-express">${esc(serviceName(step))}</span>` : "",
      step.manual ? '<span class="rec-train">手动</span>' : "",
      step.train_model ? `<span class="rec-train">${esc(step.train_model)}</span>` : "",
    ].filter(Boolean).join("");

    return `
      <article class="rec-card" data-i="${index}">
        <div class="rec-ribbon" style="background:${color}"></div>
        <div class="body">
          <div class="rec-head">
            <span class="rec-seq">${pad2(index + 1)}</span>
            <span class="rec-type" style="background:${color}">${esc(typeLabelOf(step.type))}</span>
            <span class="rec-line">${esc(lineText)}</span>
            ${badges}
            <span class="rec-actions">
              <button type="button" class="ghost" data-act="up" data-i="${index}" title="上移" ${index === 0 ? "disabled" : ""}>↑</button>
              <button type="button" class="ghost" data-act="down" data-i="${index}" title="下移" ${index === state.record.steps.length - 1 ? "disabled" : ""}>↓</button>
              <button type="button" class="ghost" data-act="edit" data-i="${index}">编辑</button>
              <button type="button" class="ghost" data-act="del" data-i="${index}">删除</button>
            </span>
          </div>

          <div class="rec-route">
            <div class="rec-end">
              <div class="t">${esc(step.start_time || "--:--")}</div>
              <div class="s">${esc(step.from_station || "未填写起始站")}</div>
            </div>
            <div class="rec-arrow">
              <span class="dur">${duration == null ? "用时未填" : esc(formatDuration(duration))}${isOvernight(step) ? " · 跨天" : ""}</span>
              <div class="bar" style="background:${color}"></div>
              <span class="line">${esc(step.line_name || step.train_no || "—")}</span>
            </div>
            <div class="rec-end right">
              <div class="t">${esc(step.end_time || "--:--")}</div>
              <div class="s">${esc(step.to_station || "未填写到达站")}</div>
            </div>
          </div>

          ${hasMeta ? `<div class="rec-meta">
            ${step.price != null ? `<span class="rec-price">票价 ¥${esc(step.price)}</span>` : ""}
            ${step.note ? `<span>${esc(step.note)}</span>` : ""}
            ${extras.map((f) => `<span class="rec-chip">${esc(f.label || "字段")}：${esc(f.value || "")}</span>`).join("")}
          </div>` : ""}
        </div>
      </article>`;
  }

  /** 车种显示名：优先用线路库里的服务名，否则回退到服务 id。 */
  function serviceName(step) {
    const line = state.lineDetail.get(step.line_id) || state.lines.find((ln) => ln.id === step.line_id);
    const svc = (line?.express || []).find((s) => s.id === step.service);
    return svc?.name || step.service || "";
  }

  function computeStats(steps) {
    let totalRun = 0;
    let price = 0;
    let missing = 0;
    let day = 0;
    let prevEnd = null;
    let firstAbs = null;
    let lastAbs = null;
    const types = new Set();

    steps.forEach((step) => {
      if (step.type) types.add(typeLabelOf(step.type));
      if (step.price != null && Number.isFinite(Number(step.price))) price += Number(step.price);

      const a = timeToMinutes(step.start_time);
      const b = timeToMinutes(step.end_time);
      if (a == null || b == null) {
        const run = step.run_minutes;
        if (run == null || !Number.isFinite(Number(run))) missing += 1;
        else totalRun += Number(run);
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
      count: steps.length,
      types: [...types],
      totalRun,
      span: firstAbs == null ? null : lastAbs - firstAbs,
      price,
      missing,
    };
  }

  function renderStats() {
    const stats = computeStats(state.record.steps);
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
    const timed = state.record.steps
      .map((step) => ({ step, duration: durationOf(step) }))
      .filter((item) => item.duration != null && item.duration > 0);

    if (!timed.length) {
      $("rec-timeline").innerHTML = '<p class="hint">填写起止时间后，这里按用时比例显示彩色时间轴。</p>';
      return;
    }

    const total = timed.reduce((sum, item) => sum + item.duration, 0) || 1;
    const bars = timed.map(({ step, duration }) => {
      const color = step.color || typeColor(step.type);
      const label = `${step.line_name || typeLabelOf(step.type)} ${formatDuration(duration)}`;
      return `<div style="flex:${duration};background:${color}" title="${esc(label)}"></div>`;
    }).join("");
    const legend = timed.map(({ step, duration }) => {
      const color = step.color || typeColor(step.type);
      return `<span><i class="dot" style="background:${color}"></i>${esc(step.line_name || typeLabelOf(step.type))} ${esc(formatDuration(duration))}</span>`;
    }).join("");

    const firstStart = state.record.steps.find((s) => s.start_time)?.start_time || "";
    const lastEnd = [...state.record.steps].reverse().find((s) => s.end_time)?.end_time || "";
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

  // ---------------- 顶栏与侧栏 ----------------

  $("rec-title").addEventListener("input", (ev) => {
    state.record.name = ev.target.value;
    scheduleSave();
    document.title = `${state.record.name.trim() || DEFAULT_TITLE} · 记录模式 · 运转计划助手`;
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

  $("rec-list").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-act]");
    if (!btn) return;
    const index = Number(btn.dataset.i);
    const steps = state.record.steps;
    const act = btn.dataset.act;

    if (act === "edit") {
      openDialog(index);
      return;
    }
    if (act === "del") {
      const label = steps[index]?.line_name || steps[index]?.type || `第 ${index + 1} 段`;
      if (!confirm(`确定删除「${label}」这条记录吗？`)) return;
      steps.splice(index, 1);
    } else if (act === "up" && index > 0) {
      [steps[index - 1], steps[index]] = [steps[index], steps[index - 1]];
    } else if (act === "down" && index < steps.length - 1) {
      [steps[index + 1], steps[index]] = [steps[index], steps[index + 1]];
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

  function setMode(mode) {
    state.dialog.mode = mode;
    $("rec-mode-db").checked = mode === "db";
    $("rec-mode-manual").checked = mode === "manual";
    $("rec-db-fields").hidden = mode !== "db";
    $("rec-manual-fields").hidden = mode !== "manual";
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
    const byTimes = durationOfTimes(start, end);
    if (start && end && byTimes != null) {
      hint.textContent = `本段用时 ${formatDuration(byTimes)}${end < start ? "（跨天）" : ""}`;
      return;
    }
    if (state.dialog.mode === "db" && state.dialog.runMinutes != null) {
      hint.textContent = `按线路数据，本段运行 ${formatDuration(state.dialog.runMinutes)}；填写起止时间后以实际用时为准`;
      return;
    }
    hint.textContent = "填写起始与到达时间后自动计算用时";
  }

  /** 线路的快车服务列表（大站快车 / 直达车等）。 */
  function lineServices(line) {
    return Array.isArray(line?.express) ? line.express : [];
  }

  function dialogService() {
    return $("seg-service-field").hidden ? "" : $("seg-service").value;
  }

  function fillServiceSelect(line, selected = "") {
    const services = lineServices(line);
    $("seg-service-field").hidden = services.length === 0;
    if (!services.length) {
      $("seg-service").innerHTML = "";
      $("seg-service-hint").textContent = "";
      return;
    }
    const opts = ['<option value="">各站停（普通车）</option>'];
    services.forEach((svc) => {
      const stops = Array.isArray(svc.stops) ? svc.stops : [];
      const headway = svc.headwayText ? ` · ${svc.headwayText}` : "";
      opts.push(`<option value="${esc(svc.id)}">${esc(svc.name)} · 停 ${stops.length} 站${esc(headway)}</option>`);
    });
    $("seg-service").innerHTML = opts.join("");
    $("seg-service").value = services.some((svc) => svc.id === selected) ? selected : "";
    updateServiceHint();
  }

  function updateServiceHint() {
    const svc = lineServices(state.dialog.line).find((s) => s.id === $("seg-service").value);
    $("seg-service-hint").textContent = svc
      ? `停靠：${(svc.stops || []).join(" → ")}`
      : "各站停：全部车站都会停靠";
  }

  function currentStops() {
    const line = state.dialog.line;
    if (!line) return [];
    const svc = lineServices(line).find((s) => s.id === dialogService());
    return svc ? (svc.stops || []) : (line.stations || []);
  }

  function fillStationSelects(preferredFrom = "") {
    const stops = currentStops();
    $("seg-from-station").innerHTML = stops.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
    if (preferredFrom && stops.includes(preferredFrom)) $("seg-from-station").value = preferredFrom;
  }

  async function refreshToStations(prefer = "") {
    if (!state.dialog.line) return;
    const res = TP.reachableAny(state.dialog.line.id, $("seg-from-station").value, dialogService());
    if (!res.ok) {
      $("seg-to-station").innerHTML = "";
      $("seg-db-run").textContent = res.error;
      return;
    }
    $("seg-to-station").innerHTML = res.stations.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
    if (prefer && res.stations.includes(prefer)) $("seg-to-station").value = prefer;
  }

  async function autoPickDirection() {
    const line = state.dialog.line;
    if (!line) return;
    const from = $("seg-from-station").value;
    const to = $("seg-to-station").value;
    if (from && to && from !== to) {
      const res = TP.pickDirection(line.id, from, to, dialogService());
      if (res.ok && res.direction) $("seg-direction").value = res.direction;
    }
    await refreshRunHint();
  }

  /** 用内核计算本段运行时长与经停站（数据库线路，含快车）。 */
  async function refreshRunHint() {
    const line = state.dialog.line;
    if (state.dialog.mode !== "db" || !line) return;
    const from = $("seg-from-station").value;
    const to = $("seg-to-station").value;
    if (!from || !to || from === to) {
      state.dialog.runMinutes = null;
      state.dialog.stops = [];
      $("seg-db-run").textContent = from === to ? "起始站与到达站相同" : "选择起始与到达站后自动计算";
      updateDurationHint();
      return;
    }
    const res = TP.evaluate({
      name: "", city: state.city, note: "", transfer_walk_default: 0, paid_zone_mode: false,
      steps: [{
        line_id: line.id, direction_label: $("seg-direction").value, from_station: from, to_station: to,
        manual: false, type: line.type, line_name: line.name, service: dialogService(),
      }],
    });
    if (res.ok && res.segments.length) {
      const seg = res.segments[0];
      state.dialog.runMinutes = seg.run;
      state.dialog.stops = seg.stops || [];
      state.dialog.type = seg.type;
      state.dialog.color = seg.color;
      state.dialog.color2 = seg.color2 || "";
      const serviceTag = seg.serviceName ? ` · ${seg.serviceName}` : "";
      $("seg-db-run").textContent = `${formatDuration(seg.run)} · ${seg.stopCount} 站${serviceTag} · ${seg.headway}`;
    } else {
      state.dialog.runMinutes = null;
      state.dialog.stops = [];
      $("seg-db-run").textContent = res.error || "无法计算该区间";
    }
    updateDurationHint();
  }

  async function setDialogLine(lineId, step = null) {
    const res = TP.line(lineId);
    if (!res.ok) {
      setDialogError(res.error);
      return;
    }
    const line = res.line;
    state.dialog.lineId = line.id;
    state.dialog.line = line;
    state.lineDetail.set(line.id, line);
    setMode("db");
    $("seg-line-name").value = line.name;
    $("rec-line-candidates").hidden = true;
    $("seg-line-picked").textContent =
      `${line.name} · ${line.typeLabel} · ${line.headwayText}`
      + (lineServices(line).length ? ` · 含 ${lineServices(line).length} 种快车` : "");
    fillServiceSelect(line, step ? step.service || "" : "");
    fillStationSelects(step ? step.from_station : state.dialog.prefillFrom);
    $("seg-direction").innerHTML = line.directions.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join("");
    if (step && line.directions.includes(step.direction_label)) $("seg-direction").value = step.direction_label;
    await refreshToStations(step ? step.to_station : "");
    if (step) await refreshRunHint();
    else await autoPickDirection();
  }

  const queryLines = debounce(async () => {
    if (!state.kernel.ready || !state.city) return;
    const kw = $("seg-line-name").value.trim();
    const res = TP.searchLines(kw);
    if (!res.ok) return;
    $("rec-line-options").innerHTML = res.lines.map((ln) => `<option value="${esc(ln.name)}"></option>`).join("");
    const exact = res.lines.find((ln) => ln.name === kw);
    if (exact) {
      await setDialogLine(exact.id);
      return;
    }
    if (!kw) {
      $("rec-line-candidates").hidden = true;
      return;
    }
    $("rec-line-candidates").hidden = res.lines.length === 0;
    $("rec-line-candidates").innerHTML = res.lines
      .map((ln) => `<option value="${esc(ln.id)}">${esc(ln.name)} · ${esc(ln.typeLabel)} · ${esc(ln.headwayText)}</option>`)
      .join("");
  }, 260);

  function openDialog(index = -1) {
    state.editing = index;
    const step = index >= 0 ? state.record.steps[index] : null;
    const prev = index >= 0 ? null : state.record.steps[state.record.steps.length - 1];

    $("rec-dlg-title").textContent = step ? `编辑第 ${index + 1} 段行程` : "添加行程记录";
    $("rec-dlg-subtitle").textContent = state.record.name || DEFAULT_TITLE;

    state.dialog.lineId = "";
    state.dialog.line = null;
    state.dialog.runMinutes = null;
    state.dialog.stops = [];
    // 新增记录时，数据库线路的起点默认接上一段的到达站
    state.dialog.prefillFrom = prev?.to_station || "";
    state.dialog.type = step?.type || "";
    state.dialog.color = step?.color || "";
    state.dialog.color2 = step?.color2 || "";
    $("seg-line-name").value = "";
    $("rec-line-candidates").hidden = true;
    $("rec-line-candidates").innerHTML = "";
    $("rec-line-options").innerHTML = "";
    $("seg-line-picked").textContent = "";
    $("seg-service-field").hidden = true;
    $("seg-service").innerHTML = "";
    $("seg-service-hint").textContent = "";
    $("seg-from-station").innerHTML = "";
    $("seg-to-station").innerHTML = "";
    $("seg-direction").innerHTML = "";
    $("seg-db-run").textContent = "选择起始与到达站后自动计算";
    $("seg-service").value = "";

    $("seg-start").value = step?.start_time || prev?.end_time || "";
    $("seg-end").value = step?.end_time || "";
    $("seg-train").value = step?.train_no || "";
    $("seg-model").value = step?.train_model || "";
    $("seg-price").value = step?.price ?? "";
    $("seg-note").value = step?.note || "";
    $("seg-type").value = step?.type || MANUAL_TYPES[0];
    $("seg-manual-line").value = step?.line_name || "";
    $("seg-manual-dir").value = step?.direction_label || "";
    $("seg-manual-from").value = step?.from_station || prev?.to_station || "";
    $("seg-manual-to").value = step?.to_station || "";
    $("seg-manual-run").value = step?.run_minutes ?? "";

    state.dialogExtras = (step?.extras || []).map((f) => ({ label: f.label || "", value: f.value || "" }));
    renderSegExtras();
    setDialogError("");

    const canUseDb = state.kernel.ready && Boolean(state.city);
    if (step && !step.manual && step.line_id && canUseDb) {
      setMode("db");
      setDialogLine(step.line_id, step);
    } else {
      setMode(canUseDb && !step?.manual ? "db" : "manual");
      if (!canUseDb) {
        setKernelHint(state.kernel.loading
          ? "线路库加载中…（加载完成后可选用数据库线路）"
          : "未加载线路库：可先用手动自选，或在上方选择城市");
        if (!state.kernel.loading) warmKernel();
      }
    }

    updateDurationHint();
    $("rec-dialog").showModal();
    setTimeout(() => (canUseDb && state.dialog.mode === "db" ? $("seg-line-name") : $("seg-manual-line")).focus(), 0);
  }

  function closeDialog() {
    state.editing = -1;
    $("rec-dialog").close();
  }

  function finishStep(seg) {
    return normalizeStep({
      ...seg,
      note: $("seg-note").value.trim(),
      price: $("seg-price").value.trim(),
      start_time: $("seg-start").value,
      end_time: $("seg-end").value,
      train_no: $("seg-train").value.trim(),
      train_model: $("seg-model").value.trim(),
      extras: state.dialogExtras
        .map((f) => ({ label: f.label.trim(), value: f.value.trim() }))
        .filter((f) => f.label || f.value),
    });
  }

  function collectDialog() {
    if (state.dialog.mode === "db") {
      const line = state.dialog.line;
      return finishStep({
        line_id: line?.id || "",
        direction_label: $("seg-direction").value,
        from_station: $("seg-from-station").value,
        to_station: $("seg-to-station").value,
        manual: false,
        type: state.dialog.type || line?.type || "",
        line_name: line?.name || "",
        run_minutes: state.dialog.runMinutes,
        stops_text: (state.dialog.stops || []).join("、"),
        color: state.dialog.color || line?.color || "",
        color2: state.dialog.color2 || line?.color2 || "",
        service: dialogService(),
      });
    }
    return finishStep({
      line_id: "",
      direction_label: $("seg-manual-dir").value.trim(),
      from_station: $("seg-manual-from").value.trim(),
      to_station: $("seg-manual-to").value.trim(),
      manual: true,
      type: $("seg-type").value.trim(),
      line_name: $("seg-manual-line").value.trim(),
      run_minutes: numOrNull($("seg-manual-run").value),
      stops_text: "",
      color: "",
      color2: "",
      service: "",
    });
  }

  function saveDialog() {
    const step = collectDialog();
    if (!step.from_station || !step.to_station) {
      setDialogError("请填写起始站与到达站");
      return;
    }
    if (step.from_station === step.to_station) {
      setDialogError("起始站与到达站不能相同");
      return;
    }
    if (state.dialog.mode === "db" && !step.line_id) {
      setDialogError("请先输入并选择线路（在候选列表中点选）");
      return;
    }

    const wasEdit = state.editing >= 0;
    if (wasEdit) state.record.steps[state.editing] = step;
    else state.record.steps.push(step);

    const savedIndex = wasEdit ? state.editing : state.record.steps.length - 1;
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

  $("rec-mode-db").addEventListener("change", async () => {
    if (!state.kernel.ready) {
      const ok = await warmKernel();
      if (!ok) {
        setMode("manual");
        return;
      }
    }
    if (!state.city) {
      toast("请先在上方选择城市线路库");
      setMode("manual");
      return;
    }
    setMode("db");
    updateDurationHint();
  });
  $("rec-mode-manual").addEventListener("change", () => {
    setMode("manual");
    updateDurationHint();
  });

  $("seg-line-name").addEventListener("input", () => {
    if ($("seg-line-name").value !== state.dialog.line?.name) {
      state.dialog.line = null;
      state.dialog.lineId = "";
      $("seg-line-picked").textContent = "";
    }
    queryLines();
  });
  $("rec-line-candidates").addEventListener("change", (ev) => setDialogLine(ev.target.value));
  $("btn-seg-line-clear").addEventListener("click", () => {
    state.dialog.line = null;
    state.dialog.lineId = "";
    $("seg-line-name").value = "";
    $("seg-line-picked").textContent = "";
    $("seg-from-station").innerHTML = "";
    $("seg-to-station").innerHTML = "";
    $("seg-direction").innerHTML = "";
    $("seg-service-field").hidden = true;
    state.dialog.runMinutes = null;
    updateDurationHint();
  });
  $("seg-service").addEventListener("change", async () => {
    updateServiceHint();
    fillStationSelects($("seg-from-station").value);
    await refreshToStations("");
    await autoPickDirection();
  });
  $("seg-from-station").addEventListener("change", async () => {
    await refreshToStations($("seg-to-station").value);
    await autoPickDirection();
  });
  $("seg-to-station").addEventListener("change", () => autoPickDirection());
  $("seg-direction").addEventListener("change", () => refreshRunHint());

  $("seg-start").addEventListener("input", updateDurationHint);
  $("seg-end").addEventListener("input", updateDurationHint);
  $("seg-manual-run").addEventListener("input", updateDurationHint);

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

  // ---------------- 导出 ----------------

  /** 导出内容与规划方案结构一致，规划器可直接导入；kind 标明来源。 */
  function exportData() {
    return {
      kind: "record",
      version: 2,
      exportedAt: new Date().toISOString(),
      name: state.record.name.trim() || DEFAULT_TITLE,
      date: state.record.date || "",
      city: state.record.city || "",
      note: state.record.note,
      transfer_walk_default: state.record.transfer_walk_default,
      paid_zone_mode: state.record.paid_zone_mode,
      fields: state.record.fields.filter((f) => f.label || f.value),
      steps: state.record.steps,
    };
  }

  $("btn-switch-plan").addEventListener("click", (ev) => {
    ev.preventDefault();
    flushSave();
    const tripData = JSON.parse(JSON.stringify(state.record));
    delete tripData.fields;
    const draft = D.create("plan", {
      title: (state.record.name || "").trim() || "我的运转方案",
      city: state.record.city || "",
      summary: D.summarize("plan", tripData),
      data: tripData,
    });
    location.href = `plan.html?id=${encodeURIComponent(draft.id)}`;
  });

  $("btn-rec-clear").addEventListener("click", () => {
    if (!state.record.steps.length) {
      toast("当前没有行程记录可清除");
      return;
    }
    if (!confirm(`确定清除当前记录的 ${state.record.steps.length} 段行程吗？\n记录名、日期、城市与备注会保留，此操作不可撤销。`)) return;
    state.record.steps = [];
    touch();
    flushSave();
    toast("已清除当前记录");
  });

  $("btn-rec-export").addEventListener("click", () => {
    flushSave();
    if (!state.record.steps.length) {
      toast("还没有可导出的行程记录");
      return;
    }
    D.downloadJSON(D.safeFileName(state.record.name, DEFAULT_TITLE), exportData());
    toast("已导出数据文件（与规划方案互通）");
  });

  $("btn-rec-print").addEventListener("click", () => {
    flushSave();
    if (!state.record.steps.length) {
      toast("还没有可导出的行程记录");
      return;
    }
    $("rec-print-view").innerHTML = buildPrintSheet();
    $("rec-print-view").hidden = false;

    const savedTitle = document.title;
    document.title = D.safeFileName(state.record.name, DEFAULT_TITLE);
    window.addEventListener("afterprint", () => {
      $("rec-print-view").hidden = true;
      document.title = savedTitle;
    }, { once: true });
    window.print();
  });

  function buildPrintSheet() {
    const record = state.record;
    const stats = computeStats(record.steps);
    const fields = record.fields.filter((f) => f.label || f.value);

    const rows = record.steps.map((step, index) => {
      const duration = durationOf(step);
      const extras = (step.extras || [])
        .filter((f) => f.label || f.value)
        .map((f) => `${f.label || "字段"}：${f.value || ""}`)
        .join("；");
      const detail = [step.note, extras].filter(Boolean).join("；");
      const lineCell = [step.line_name || step.line_id, step.train_no].filter(Boolean).map(esc).join("<br>")
        + (step.service ? `<br><i>${esc(serviceName(step))}</i>` : "");
      return `<tr>
        <td>${index + 1}</td>
        <td>${esc(typeLabelOf(step.type))}</td>
        <td>${lineCell}</td>
        <td>${esc(step.from_station || "")}</td>
        <td>${esc(step.start_time || "")}</td>
        <td>${esc(step.to_station || "")}</td>
        <td>${esc(step.end_time || "")}</td>
        <td>${duration == null ? "—" : esc(formatDuration(duration))}${isOvernight(step) ? "<br>跨天" : ""}</td>
        <td>${esc(step.train_model || "")}</td>
        <td>${step.price != null ? esc(step.price) : ""}</td>
        <td>${esc(detail)}</td>
      </tr>`;
    }).join("");

    const summary = [
      `共 ${stats.count} 段`,
      `乘车 ${formatDuration(stats.totalRun)}`,
      stats.span != null ? `全程 ${formatDuration(stats.span)}` : "",
      stats.price ? `票价 ¥${Number(stats.price.toFixed(2))}` : "",
      record.city ? `线路库 ${record.city}` : "",
    ].filter(Boolean).join(" · ");

    return `
      <div class="rec-sheet">
        <h1>${esc(record.name || DEFAULT_TITLE)}</h1>
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
