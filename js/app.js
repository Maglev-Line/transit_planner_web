/* 运转计划助手 · Web —— 界面层
 *
 * 所有业务计算（分段时长、经停站、换乘判定、付费区、票价合计）都委托 Python 内核：
 *   js/bridge.js  →  web_api  →  transit_planner.core.engine（与桌面版同一份实现）
 * 本文件只负责状态、渲染与交互。
 */
(() => {
  "use strict";

  // ---------------- 小工具 ----------------

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtMin = (m) => (m == null || Number.isNaN(+m) ? "—" : (Number.isInteger(+m) ? `${+m} 分钟` : `${(+m).toFixed(1)} 分钟`));
  const numOrNull = (v) => (v === "" || v == null ? null : Number(v));
  const swatch = (c1, c2) => (c2 ? `linear-gradient(90deg, ${c1} 0 50%, ${c2} 50% 100%)` : (c1 || "#888888"));
  const debounce = (fn, ms = 280) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const STORAGE_KEY = "transit-planner-web.v1";

  // ---------------- 状态 ----------------

  const state = {
    info: null,
    typeLabels: {},
    cities: [],
    typeKeys: [],
    city: "",
    cityInfo: null,
    lines: [],
    lineDetail: new Map(),
    selectedLine: "",
    result: null,
    trip: {
      name: "我的运转方案",
      date: "",
      city: "",
      note: "",
      transfer_walk_default: 5,
      paid_zone_mode: false,
      steps: [],
    },
  };

  // ---------------- 启动 ----------------

  async function boot() {
    try {
      const info = await TP.boot((msg, ratio) => {
        $("boot-msg").textContent = msg;
        $("boot-bar").style.width = `${Math.round(ratio * 100)}%`;
      });
      state.info = info;
      state.typeLabels = info.typeLabels || {};
      state.typeKeys = Object.keys(state.typeLabels);
      state.cities = [...(info.cities || []), ...Object.keys(info.combinedCities || {})];

      $("kernel-info").textContent =
        `${info.appName} 内核 v${info.version} · 同步于 ${info.syncedAt || "未知"} · ` +
        `${(info.cities || []).length} 座城市 + ${Object.keys(info.combinedCities || {}).length} 个同城组合 · ` +
        `${state.typeKeys.length} 种交通类型`;

      fillCitySelect();
      fillTypeSelect();

      const saved = loadLocal();
      const city = saved?.city || state.cities[0] || "";
      if (saved?.trip) state.trip = { ...state.trip, ...saved.trip, steps: saved.trip.steps || [] };
      syncTopbar();
      await setCity(city, { silent: true });

      $("boot").hidden = true;
      $("app").hidden = false;
      renderAll();
    } catch (err) {
      document.body.classList.add("err");
      $("boot").classList.add("error");
      $("boot-msg").textContent =
        `启动失败：${err.message}。请确认网络可访问 cdn.jsdelivr.net（Pyodide 运行时），` +
        `并通过 http(s) 访问本页面（直接双击 index.html 时浏览器会禁止读取内核文件）。`;
    }
  }

  function fillCitySelect() {
    const sel = $("city-select");
    const opts = ['<option value="">（不使用线路库 · 纯手动）</option>'];
    state.cities.forEach((name) => {
      const combined = state.info.combinedCities?.[name];
      opts.push(`<option value="${esc(name)}">${esc(name)}${combined ? "（同城组合）" : ""}</option>`);
    });
    sel.innerHTML = opts.join("");
  }

  function fillTypeSelect() {
    $("m-type").innerHTML = state.typeKeys
      .map((k) => `<option value="${esc(k)}">${esc(state.typeLabels[k])}</option>`)
      .join("");
  }

  function syncTopbar() {
    $("trip-name").value = state.trip.name || "";
    $("trip-date").value = state.trip.date || "";
    $("paid-zone").checked = !!state.trip.paid_zone_mode;
    $("walk-default").value = state.trip.transfer_walk_default ?? 5;
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ city: state.city, trip: state.trip }));
    } catch { /* 隐私模式下忽略 */ }
  }

  function loadLocal() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    } catch {
      return null;
    }
  }

  // ---------------- 城市与线路库 ----------------

  async function setCity(name, { silent = false } = {}) {
    state.city = name;
    state.trip.city = name;
    state.selectedLine = "";
    $("city-select").value = name;
    $("line-detail").hidden = true;

    const res = TP.loadCity(name);
    if (!res.ok) {
      setStatus(res.error, true);
      state.lines = [];
      state.cityInfo = null;
    } else {
      state.lines = res.lines || [];
      state.cityInfo = res.city;
      $("city-label").textContent = res.city
        ? `${res.city.lineCount} 条线路 · ${res.city.stationCount} 站${res.city.combined ? " · 只读同城组合" : ""}`
        : "纯手动模式";
    }
    state.lineDetail.clear();
    renderLibrary();
    await refreshStationOptions();
    await evaluate();
    if (!silent) persist();
  }

  function renderLibrary() {
    const kw = ($("line-search").value || "").trim().toLowerCase();
    const items = state.lines.filter((ln) => {
      if (!kw) return true;
      return `${ln.name} ${ln.shortName} ${ln.id}`.toLowerCase().includes(kw);
    });
    if (!items.length) {
      $("line-list").innerHTML = `<p class="hint">${state.lines.length ? "没有匹配的线路" : "未加载线路库"}</p>`;
      return;
    }
    $("line-list").innerHTML = items.map((ln) => `
      <div class="line-item${ln.id === state.selectedLine ? " active" : ""}" data-line="${esc(ln.id)}" title="单击查看详情，双击预填到新行程">
        <span class="swatch" style="background:${swatch(ln.color, ln.color2)}"></span>
        <span class="nm">${esc(ln.name)}</span>
        <span class="tag">${esc(ln.typeLabel)}</span>
      </div>`).join("");
  }

  async function showLineDetail(lineId) {
    state.selectedLine = lineId;
    renderLibrary();
    let line = state.lineDetail.get(lineId);
    if (!line) {
      const res = TP.line(lineId);
      if (!res.ok) { setStatus(res.error, true); return; }
      line = res.line;
      state.lineDetail.set(lineId, line);
    }
    const chain = line.stations.map((s, i) => {
      const seg = i < line.travelMinutes.length ? `<span class="seg-min">${line.travelMinutes[i]}′</span>` : "";
      return `<span class="st">${esc(s)}</span>${seg}`;
    }).join("");
    $("line-detail").hidden = false;
    $("line-detail").innerHTML = `
      <div class="kv"><b>${esc(line.name)}</b><span class="tag">${esc(line.typeLabel)}</span></div>
      <div class="kv">方向：${esc(line.directions.join(" / "))}</div>
      <div class="kv">班次：${esc(line.headwayText)}${line.firstTrain ? ` · 首班 ${esc(line.firstTrain)}` : ""}${line.lastTrain ? ` · 末班 ${esc(line.lastTrain)}` : ""}</div>
      ${line.operator ? `<div class="kv">运营：${esc(line.operator)}</div>` : ""}
      ${line.ring ? `<div class="kv">环线（首尾闭合）</div>` : ""}
      <div class="station-chain">${chain}</div>
      <p class="hint" style="margin:6px 0 0">双击左侧线路可把该线路预填到新行程。</p>`;
  }

  async function refreshStationOptions() {
    if (!state.city) {
      $("station-options").innerHTML = "";
      return;
    }
    const res = TP.stations();
    if (!res.ok) return;
    $("station-options").innerHTML = res.stations.map((s) => `<option value="${esc(s)}"></option>`).join("");
  }

  // ---------------- 计算与渲染 ----------------

  async function evaluate() {
    if (!state.trip.steps.length && !state.trip) return;
    let res;
    try {
      res = TP.evaluate(state.trip);
    } catch (err) {
      setStatus(`计算失败：${err.message}`, true);
      return;
    }
    if (!res.ok) { setStatus(res.error, true); return; }
    state.result = res;
    renderPlan();
    renderSide();
    persist();
  }

  function setStatus(msg, isError = false) {
    $("plan-status").innerHTML = msg
      ? `<p class="${isError ? "err-box" : "hint"}">${esc(msg)}</p>`
      : "";
  }

  function renderAll() {
    renderLibrary();
    renderPlan();
    renderSide();
  }

  function renderPlan() {
    const steps = state.trip.steps;
    const res = state.result;
    const segs = res?.segments || [];
    const failed = res?.failedStep;

    if (!steps.length) {
      $("step-list").innerHTML = '<p class="hint">还没有行程。点击下方「＋ 添加行程」开始串联：起点站 → 线路 → 方向 → 到达站。</p>';
      setStatus("");
      return;
    }

    const html = [];
    steps.forEach((step, i) => {
      if (i > 0) html.push(walkRowHtml(i, steps, segs[i]));
      html.push(cardHtml(i, step, segs[i], failed === i ? res.error : ""));
    });
    $("step-list").innerHTML = html.join("");

    if (failed != null) {
      setStatus(`第 ${failed + 1} 段无法计算：${res.error}（后面的段落暂不参与统计）`, true);
    } else {
      setStatus("");
    }
  }

  function cardHtml(i, step, seg, error) {
    const color = seg?.color || step.color || "#888888";
    const color2 = seg?.color2 || step.color2 || "";
    const name = seg?.lineName || step.line_name || step.line_id || "未命名线路";
    const typeLabel = seg?.typeLabel || state.typeLabels[step.type] || step.type || "";
    const dir = seg?.direction || step.direction_label || "—";
    const run = seg ? fmtMin(seg.run) : (step.run_minutes != null ? fmtMin(step.run_minutes) : "—");
    const stops = seg?.stops || [];
    const price = step.price != null ? `<span class="price">票价 ¥${esc(step.price)}</span>` : "";
    const note = step.note ? `<b>备注</b>${esc(step.note)}` : "";
    const transfer = seg?.transfer ? '<span class="badge-transfer">转乘（跨付费区）</span>' : "";
    const zone = seg ? `<b>付费区</b>${seg.paidZone + 1}` : "";
    const manual = step.manual ? '<span class="type">手动</span>' : "";
    const stopsBlock = stops.length
      ? `<details class="stops-toggle"><summary class="hint">经停站（${stops.length} 站）</summary><div class="stops">${stops.map(esc).join(" · ")}</div></details>`
      : "";
    const tt = renderTimetable(step);

    return `
      <div class="card${error ? " error" : ""}">
        <div class="ribbon" style="background:${swatch(color, color2)}"></div>
        <div class="body">
          <div class="card-head">
            <span class="nm">${esc(name)}</span>
            ${typeLabel ? `<span class="type">${esc(typeLabel)}</span>` : ""}
            ${manual}${transfer}
            <span class="actions">
              <button class="ghost" data-act="up" data-i="${i}" title="上移" ${i === 0 ? "disabled" : ""}>↑</button>
              <button class="ghost" data-act="down" data-i="${i}" title="下移" ${i === state.trip.steps.length - 1 ? "disabled" : ""}>↓</button>
              <button class="ghost" data-act="edit" data-i="${i}">编辑</button>
              <button class="ghost" data-act="del" data-i="${i}">删除</button>
            </span>
          </div>
          <div class="route">
            <b>${esc(step.from_station || "?")}</b>
            <span class="arrow">→</span>
            <span>${esc(dir)}</span>
            <span class="arrow">→</span>
            <b>${esc(step.to_station || "?")}</b>
          </div>
          <div class="meta">
            <span><b>运行</b>${run}</span>
            ${seg ? `<span><b>步行</b>${fmtMin(seg.walk)}</span>` : ""}
            ${seg ? `<span><b>站数</b>${seg.stopCount}</span>` : ""}
            ${seg ? `<span><b>班次</b>${esc(seg.headway)}</span>` : ""}
            ${seg && (seg.firstTrain || seg.lastTrain) ? `<span><b>首末</b>${esc(seg.firstTrain || "—")} / ${esc(seg.lastTrain || "—")}</span>` : ""}
            ${zone}${price}${note ? `<span>${note}</span>` : ""}
          </div>
          ${error ? `<div class="err-box">无法计算：${esc(error)}</div>` : ""}
          ${stopsBlock}
          ${tt}
        </div>
      </div>`;
  }

  function renderTimetable(step) {
    if (!step.timetable || !step.timetable.length) return "";
    const rows = step.timetable.map((r) => `<tr><td>${esc(r[0] || "")}</td><td>${esc(r[1] || "")}</td><td>${esc(r[2] || "")}</td></tr>`).join("");
    return `<table class="timetable"><thead><tr>
      <th>车次</th><th>发时</th><th>到时</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function walkRowHtml(i, steps, seg) {
    const step = steps[i];
    const value = step.walk_minutes ?? "";
    const placeholder = seg?.walkDefault ?? state.trip.transfer_walk_default;
    const autoTransfer = seg?.transferAuto;
    const forced = step.transfer === true ? "yes" : step.transfer === false ? "no" : "auto";
    const zone = seg ? `<span class="zone">属于付费区 ${seg.paidZone + 1}</span>` : "";
    return `
      <div class="walk-row">
        <span>换乘 / 步行</span>
        <input type="number" min="0" step="1" data-walk="${i}" value="${esc(value)}" placeholder="${esc(placeholder)}">
        <span>分钟</span>
        <label>转乘
          <select data-transfer="${i}">
            <option value="auto"${forced === "auto" ? " selected" : ""}>自动判定${autoTransfer ? "（库中为转乘）" : ""}</option>
            <option value="yes"${forced === "yes" ? " selected" : ""}>转乘（出闸/换系统）</option>
            <option value="no"${forced === "no" ? " selected" : ""}>不转乘</option>
          </select>
        </label>
        ${zone}
      </div>`;
  }

  function renderSide() {
    renderStats();
    renderTimeline();
    renderZones();
    renderHints();
  }

  function renderStats() {
    const t = state.result?.totals;
    const cells = [
      ["总时长", t ? fmtMin(t.minutes) : "—"],
      ["其中运行", t ? fmtMin(t.run) : "—"],
      ["换乘 / 站外步行", t ? fmtMin(t.walk) : "—"],
      ["换乘次数", t ? `${t.transferCount} 次` : "—"],
      ["转乘次数", t ? `${t.fareTransferCount} 次` : "—"],
      ["线路数", t ? `${t.lineCount} 条` : "—"],
      ["总站数", t ? `${t.stopCount} 站` : "—"],
      ["总票价", t ? `¥${t.price}` : "—"],
    ];
    $("stats").innerHTML = cells.map(([k, v]) => `<div class="cell"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join("");
  }

  function renderTimeline() {
    const segs = state.result?.segments || [];
    if (!segs.length) {
      $("timeline").innerHTML = '<p class="hint">添加行程后按运行时长成比例显示。</p>';
      return;
    }
    const total = segs.reduce((acc, s) => acc + s.run + s.walk, 0) || 1;
    const bars = segs.map((s, i) => {
      const parts = [];
      if (i > 0 && s.walk > 0) parts.push(`<div style="flex:${s.walk / total};background:#cfd8e6" title="换乘/步行 ${fmtMin(s.walk)}"></div>`);
      parts.push(`<div style="flex:${Math.max(s.run, 0.01) / total};background:${swatch(s.color, s.color2)}" title="${esc(s.lineName)} ${esc(s.direction)} 运行 ${fmtMin(s.run)}"></div>`);
      return parts.join("");
    }).join("");
    const legend = segs.map((s) => `<span><i class="dot" style="background:${swatch(s.color, s.color2)}"></i>${esc(s.shortName || s.lineName)} ${fmtMin(s.run)}</span>`).join("");
    $("timeline").innerHTML = `
      <div class="tl-bar">${bars}</div>
      <div class="tl-legend">${legend}</div>
      <p class="hint" style="margin:4px 0 0">全程 ${fmtMin(state.result.totals.minutes)}（含换乘步行 ${fmtMin(state.result.totals.walk)}）</p>`;
  }

  function renderZones() {
    const res = state.result;
    if (!res || !res.segments.length) {
      $("zones").innerHTML = '<p class="hint">填写票价后在此汇总。</p>';
      return;
    }
    const rows = [];
    if (res.paidZoneMode) {
      rows.push('<p class="hint" style="margin:0 0 4px">付费区模式：按「进闸站 → 出闸站」一次计费。</p>');
      res.paidZones.forEach((z) => {
        rows.push(`<div class="zone-item">付费区 ${z.index}：<b>${esc(z.entry)}</b> → <b>${esc(z.exit)}</b>
          · ${z.segmentCount} 段 · 运行 ${fmtMin(z.run)}${z.price != null ? ` · <b>¥${z.price}</b>` : " · 未填票价"}</div>`);
      });
      const total = res.zonePrices.reduce((a, r) => a + r[3], 0);
      rows.push(`<div class="zone-item">票价合计 <b>¥${Number(total.toFixed(2))}</b>（${res.zonePrices.length} 个已填票价区）</div>`);
    } else {
      res.segments.forEach((s, i) => {
        rows.push(`<div class="zone-item">第 ${i + 1} 段 ${esc(s.shortName || s.lineName)}：${s.price != null ? `<b>¥${s.price}</b>` : "未填票价"}</div>`);
      });
      rows.push(`<div class="zone-item">票价合计 <b>¥${res.totals.price}</b></div>`);
    }
    $("zones").innerHTML = rows.join("");
  }

  async function renderHints() {
    const steps = state.trip.steps;
    const station = steps.length ? steps[steps.length - 1].to_station : "";
    if (!state.city || !station) {
      $("hints").innerHTML = '<p class="hint">加载线路库并添加行程后，这里显示本站可换乘的线路。</p>';
      return;
    }
    const last = steps[steps.length - 1];
    const res = TP.transferHints(station, last.manual ? "" : last.line_id);
    if (!res.ok) { $("hints").innerHTML = `<p class="hint">${esc(res.error)}</p>`; return; }
    const others = res.hints.filter((h) => !h.current);
    if (!others.length) {
      $("hints").innerHTML = `<p class="hint">「${esc(station)}」暂无其他可换乘线路（本地数据未收录或不含换乘站）。</p>`;
      return;
    }
    $("hints").innerHTML = `<p class="hint" style="margin:0 0 4px">在「${esc(station)}」可换乘：</p>` +
      others.map((h) => `
        <div class="hint-item">
          <i class="dot" style="background:${swatch(h.color, h.color2)}"></i>
          <span>${esc(h.name)}</span>
          <span class="tag">${esc(h.typeLabel)}</span>
          <span class="dirs" title="${esc(h.directions.join(" / "))}">${esc(h.directions.join(" / "))}</span>
        </div>`).join("");
  }

  // ---------------- 行程卡片交互 ----------------

  $("step-list").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-act]");
    if (!btn) return;
    const i = Number(btn.dataset.i);
    const steps = state.trip.steps;
    const act = btn.dataset.act;
    if (act === "up" && i > 0) [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]];
    if (act === "down" && i < steps.length - 1) [steps[i + 1], steps[i]] = [steps[i], steps[i + 1]];
    if (act === "del") steps.splice(i, 1);
    if (act === "edit") { openStepDialog(i); return; }
    persist();
    evaluate();
  });

  const onWalkInput = debounce(() => evaluate(), 400);
  $("step-list").addEventListener("input", (ev) => {
    const input = ev.target.closest("[data-walk]");
    if (!input) return;
    state.trip.steps[Number(input.dataset.walk)].walk_minutes = numOrNull(input.value);
    onWalkInput();
  });
  $("step-list").addEventListener("change", (ev) => {
    const sel = ev.target.closest("[data-transfer]");
    if (!sel) return;
    const idx = Number(sel.dataset.transfer);
    state.trip.steps[idx].transfer = sel.value === "yes" ? true : sel.value === "no" ? false : null;
    evaluate();
  });

  $("btn-add").addEventListener("click", () => openStepDialog(null));
  $("line-search").addEventListener("input", debounce(renderLibrary, 150));
  $("line-list").addEventListener("click", (ev) => {
    const item = ev.target.closest("[data-line]");
    if (item) showLineDetail(item.dataset.line);
  });
  $("line-list").addEventListener("dblclick", (ev) => {
    const item = ev.target.closest("[data-line]");
    if (!item) return;
    openStepDialog(null).then(() => setDialogLine(item.dataset.line));
  });

  // ---------------- 顶栏交互 ----------------

  $("city-select").addEventListener("change", (ev) => setCity(ev.target.value));
  $("trip-name").addEventListener("input", (ev) => { state.trip.name = ev.target.value; persist(); });
  $("trip-date").addEventListener("change", (ev) => { state.trip.date = ev.target.value; persist(); });
  $("paid-zone").addEventListener("change", (ev) => { state.trip.paid_zone_mode = ev.target.checked; evaluate(); });
  $("walk-default").addEventListener("change", (ev) => {
    state.trip.transfer_walk_default = numOrNull(ev.target.value) ?? 0;
    evaluate();
  });

  $("btn-export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state.trip, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${state.trip.name || "运转方案"}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $("btn-import").addEventListener("click", () => $("file-import").click());
  $("file-import").addEventListener("change", async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      state.trip = { ...state.trip, ...data, steps: data.steps || [] };
      syncTopbar();
      if (state.trip.city && state.trip.city !== state.city) await setCity(state.trip.city, { silent: true });
      renderAll();
      await evaluate();
    } catch (err) {
      setStatus(`导入失败：${err.message}`, true);
    } finally {
      ev.target.value = "";
    }
  });

  // ---------------- 行程弹窗 ----------------

  const dlg = { index: null, mode: "db", lineId: "", line: null };

  function setDialogError(msg) {
    $("dlg-error").hidden = !msg;
    $("dlg-error").textContent = msg || "";
  }

  function setMode(mode) {
    dlg.mode = mode;
    $("mode-db").checked = mode === "db";
    $("mode-manual").checked = mode === "manual";
    $("db-fields").hidden = mode !== "db";
    $("manual-fields").hidden = mode !== "manual";
  }

  async function openStepDialog(index) {
    dlg.index = index;
    dlg.lineId = "";
    dlg.line = null;
    const step = index == null ? null : state.trip.steps[index];
    $("dlg-title").textContent = index == null ? "添加行程" : `编辑第 ${index + 1} 段行程`;
    $("dlg-subtitle").textContent = state.cityInfo ? state.cityInfo.name : "纯手动模式";
    $("dlg-foot-hint").textContent = state.city
      ? "数据库线路的时长与经停站由内核计算"
      : "未加载线路库：只能使用手动自选方式";
    setDialogError("");

    $("line-name").value = "";
    $("line-candidates").hidden = true;
    $("line-candidates").innerHTML = "";
    $("line-picked").textContent = "";
    $("line-options").innerHTML = "";
    $("from-station").innerHTML = "";
    $("direction").innerHTML = "";
    $("to-station").innerHTML = "";
    $("db-run").textContent = "选择起点与到达站后自动计算";
    $("m-line-name").value = "";
    $("m-direction").value = "";
    $("m-from").value = "";
    $("m-to").value = "";
    $("m-run").value = "";
    $("m-stops").value = "";
    $("m-headway").value = "";
    $("m-color").value = "#2f6feb";
    $("m-color2").value = "#ffffff";
    $("m-color2").disabled = true;
    $("m-color2-on").checked = false;
    $("price").value = "";
    $("walk-minutes").value = "";
    $("note").value = "";
    $("use-timetable").checked = false;
    $("timetable-rows").innerHTML = "";
    $("m-type").value = state.typeKeys[0] || "metro";

    if (step) {
      $("price").value = step.price ?? "";
      $("walk-minutes").value = step.walk_minutes ?? "";
      $("note").value = step.note || "";
      $("use-timetable").checked = !!step.use_timetable;
      (step.timetable || []).forEach((row) => addTimetableRow(row));
      if (step.manual) {
        setMode("manual");
        $("m-line-name").value = step.line_name || "";
        $("m-direction").value = step.direction_label || "";
        $("m-from").value = step.from_station || "";
        $("m-to").value = step.to_station || "";
        $("m-run").value = step.run_minutes ?? "";
        $("m-stops").value = step.stops_text || "";
        $("m-headway").value = step.headway_text || "";
        $("m-type").value = step.type || state.typeKeys[0] || "metro";
        $("m-color").value = step.color || "#2f6feb";
        if (step.color2) { $("m-color2-on").checked = true; $("m-color2").disabled = false; $("m-color2").value = step.color2; }
      } else {
        setMode("db");
        if (state.city) {
          await setDialogLine(step.line_id, step);
        } else {
          setMode(state.city ? "db" : "manual");
        }
      }
    } else {
      setMode(state.city ? "db" : "manual");
    }
    syncRunFromTimetable();
    $("step-dialog").showModal();
  }

  /** 在弹窗里选定数据库线路；step 非空时用于回填编辑。 */
  async function setDialogLine(lineId, step = null) {
    const res = TP.line(lineId);
    if (!res.ok) { setDialogError(res.error); return; }
    const line = res.line;
    dlg.lineId = line.id;
    dlg.line = line;
    state.lineDetail.set(line.id, line);
    setMode("db");
    $("line-name").value = line.name;
    $("line-candidates").hidden = true;
    $("line-picked").innerHTML =
      `<span class="swatch" style="display:inline-block;vertical-align:-1px;background:${swatch(line.color, line.color2)}"></span>
       ${esc(line.name)} · ${esc(line.typeLabel)} · ${esc(line.headwayText)}`;
    $("from-station").innerHTML = line.stations.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
    $("direction").innerHTML = line.directions.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join("");
    if (step) {
      $("from-station").value = step.from_station;
      if (line.directions.includes(step.direction_label)) $("direction").value = step.direction_label;
    }
    await refreshToStations(step ? step.to_station : "");
    await refreshRunHint();
  }

  async function refreshToStations(prefer = "") {
    if (!dlg.line) return;
    const res = TP.reachable(dlg.line.id, $("direction").value, $("from-station").value);
    if (!res.ok) {
      $("to-station").innerHTML = "";
      $("db-run").textContent = res.error;
      return;
    }
    $("to-station").innerHTML = res.stations.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
    if (prefer && res.stations.includes(prefer)) $("to-station").value = prefer;
    await refreshRunHint();
  }

  async function refreshRunHint() {
    if (dlg.mode !== "db" || !dlg.line) return;
    const from = $("from-station").value;
    const to = $("to-station").value;
    if (!from || !to || from === to) {
      $("db-run").textContent = from === to ? "起点与到达站相同" : "选择起点与到达站后自动计算";
      return;
    }
    const res = TP.evaluate({
      name: "", city: state.city, note: "", transfer_walk_default: 0, paid_zone_mode: false,
      steps: [{
        line_id: dlg.line.id, direction_label: $("direction").value, from_station: from, to_station: to,
        manual: false, type: dlg.line.type, line_name: dlg.line.name,
      }],
    });
    if (res.ok && res.segments.length) {
      $("db-run").textContent = `${fmtMin(res.segments[0].run)} · ${res.segments[0].stopCount} 站 · ${res.segments[0].headway}`;
    } else {
      $("db-run").textContent = res.error || "无法计算该区间";
    }
  }

  // 线路名输入推荐
  const searchDialogLines = debounce(async () => {
    if (!state.city) return;
    const kw = $("line-name").value.trim();
    const res = TP.searchLines(kw);
    if (!res.ok) return;
    $("line-options").innerHTML = res.lines.map((ln) => `<option value="${esc(ln.name)}"></option>`).join("");
    const exact = res.lines.find((ln) => ln.name === kw);
    if (exact) { await setDialogLine(exact.id); return; }
    if (!kw) { $("line-candidates").hidden = true; return; }
    $("line-candidates").hidden = res.lines.length === 0;
    $("line-candidates").innerHTML = res.lines
      .map((ln) => `<option value="${esc(ln.id)}">${esc(ln.name)} · ${esc(ln.typeLabel)} · ${esc(ln.headwayText)}</option>`)
      .join("");
  }, 260);

  $("line-name").addEventListener("input", () => {
    if ($("line-name").value !== dlg.line?.name) { dlg.line = null; dlg.lineId = ""; $("line-picked").textContent = ""; }
    searchDialogLines();
  });
  $("line-candidates").addEventListener("change", (ev) => setDialogLine(ev.target.value));
  $("btn-line-clear").addEventListener("click", () => {
    dlg.line = null;
    dlg.lineId = "";
    $("line-name").value = "";
    $("line-picked").textContent = "";
    $("from-station").innerHTML = "";
    $("direction").innerHTML = "";
    $("to-station").innerHTML = "";
  });
  $("from-station").addEventListener("change", async () => {
    if (!dlg.line) return;
    const to = $("to-station").value;
    const res = TP.pickDirection(dlg.line.id, $("from-station").value, to);
    if (res.ok && res.direction) $("direction").value = res.direction;
    await refreshToStations();
  });
  $("direction").addEventListener("change", () => refreshToStations());
  $("to-station").addEventListener("change", refreshRunHint);

  $("mode-db").addEventListener("change", () => setMode("db"));
  $("mode-manual").addEventListener("change", () => setMode("manual"));
  $("m-color2-on").addEventListener("change", (ev) => { $("m-color2").disabled = !ev.target.checked; });

  // 时刻表
  function addTimetableRow(row = ["", "", ""]) {
    const div = document.createElement("div");
    div.className = "tt-row";
    div.innerHTML = `
      <input type="text" placeholder="车次（如 G123）" value="${esc(row[0] || "")}">
      <input type="text" placeholder="发时 07:00" value="${esc(row[1] || "")}">
      <input type="text" placeholder="到时 09:07" value="${esc(row[2] || "")}">
      <button type="button" class="ghost" title="删除该车次">✕</button>`;
    div.querySelector("button").addEventListener("click", () => { div.remove(); syncRunFromTimetable(); });
    div.querySelectorAll("input").forEach((inp) => inp.addEventListener("input", syncRunFromTimetable));
    $("timetable-rows").appendChild(div);
  }

  function collectTimetable() {
    return [...$("timetable-rows").querySelectorAll(".tt-row")].map((row) => {
      const [no, from, to] = [...row.querySelectorAll("input")].map((i) => i.value.trim());
      return [no, from, to];
    }).filter((r) => r.some((v) => v));
  }

  function timetableMinutes() {
    const rows = collectTimetable();
    if (!rows.length) return null;
    const [no, from, to] = rows[0];
    const parse = (t) => (/^\d{1,2}:\d{2}$/.test(t) ? Number(t.split(":")[0]) * 60 + Number(t.split(":")[1]) : null);
    const a = parse(from);
    const b = parse(to);
    if (a == null || b == null) return null;
    return (b - a + 1440) % 1440;
  }

  function syncRunFromTimetable() {
    const on = $("use-timetable").checked;
    const minutes = on ? timetableMinutes() : null;
    if (dlg.mode === "manual") {
      $("m-run").readOnly = on && minutes != null;
      if (on && minutes != null) $("m-run").value = minutes;
    }
    return minutes;
  }

  $("use-timetable").addEventListener("change", syncRunFromTimetable);
  $("btn-tt-add").addEventListener("click", () => { addTimetableRow(); syncRunFromTimetable(); });
  $("btn-dlg-cancel").addEventListener("click", () => $("step-dialog").close());
  $("btn-dlg-close").addEventListener("click", () => $("step-dialog").close());
  $("step-dialog").addEventListener("submit", (ev) => { ev.preventDefault(); saveStep(); });
  $("btn-dlg-save").addEventListener("click", saveStep);

  async function saveStep() {
    const walkMinutes = numOrNull($("walk-minutes").value);
    const price = numOrNull($("price").value);
    const note = $("note").value.trim();
    const timetable = collectTimetable();
    const useTimetable = $("use-timetable").checked;
    const prev = dlg.index == null ? null : state.trip.steps[dlg.index];
    let step;

    if (dlg.mode === "db") {
      if (!dlg.line) { setDialogError("请先输入并选择线路（在候选列表中点选）"); return; }
      const from = $("from-station").value;
      const to = $("to-station").value;
      if (!from || !to) { setDialogError("请选择起点站与到达站"); return; }
      if (from === to) { setDialogError("起点站与到达站不能相同"); return; }
      step = {
        line_id: dlg.line.id,
        direction_label: $("direction").value,
        from_station: from,
        to_station: to,
        walk_minutes: walkMinutes,
        manual: false,
        type: dlg.line.type,
        line_name: dlg.line.name,
        run_minutes: null,
        stops_text: "",
        color: dlg.line.color,
        color2: dlg.line.color2,
        note,
        headway_text: "",
        timetable,
        use_timetable: useTimetable,
        price,
        transfer: prev ? prev.transfer : null,
      };
    } else {
      const name = $("m-line-name").value.trim();
      const from = $("m-from").value.trim();
      const to = $("m-to").value.trim();
      if (!name) { setDialogError("请填写线路名称"); return; }
      if (!from || !to) { setDialogError("请填写起点站与到达站"); return; }
      const autoMinutes = $("use-timetable").checked ? timetableMinutes() : null;
      const runMinutes = autoMinutes != null ? autoMinutes : numOrNull($("m-run").value);
      step = {
        line_id: "",
        direction_label: $("m-direction").value.trim(),
        from_station: from,
        to_station: to,
        walk_minutes: walkMinutes,
        manual: true,
        type: $("m-type").value,
        line_name: name,
        run_minutes: runMinutes,
        stops_text: $("m-stops").value.trim(),
        color: $("m-color").value,
        color2: $("m-color2-on").checked ? $("m-color2").value : "",
        note,
        headway_text: $("m-headway").value.trim(),
        timetable,
        use_timetable: useTimetable,
        price,
        transfer: prev ? prev.transfer : null,
      };
    }

    setDialogError("");
    if (dlg.index == null) state.trip.steps.push(step);
    else state.trip.steps[dlg.index] = step;
    $("step-dialog").close();
    await evaluate();
  }

  // ---------------- 导出图纸（打印 / 另存为 PDF） ----------------

  $("btn-print").addEventListener("click", () => {
    if (!state.result || !state.result.segments.length) {
      setStatus("还没有可导出的行程", true);
      return;
    }
    $("print-view").innerHTML = buildPrintSheet();
    $("print-view").hidden = false;
    window.print();
    window.addEventListener("afterprint", () => { $("print-view").hidden = true; }, { once: true });
  });

  function buildPrintSheet() {
    const trip = state.trip;
    const res = state.result;
    const t = res.totals;
    const tl = res.segments.map((s, i) => {
      const walk = i > 0 && s.walk > 0 ? `<div style="flex:${s.walk};background:#e3e7ee"></div>` : "";
      return `${walk}<div style="flex:${Math.max(s.run, 0.01)};background:${swatch(s.color, s.color2)}"></div>`;
    }).join("");

    const segs = res.segments.map((s, i) => {
      const tt = (s.timetable || []).length
        ? `<table><thead><tr><th>车次</th><th>发时</th><th>到时</th></tr></thead><tbody>${
            s.timetable.map((r) => `<tr><td>${esc(r[0] || "")}</td><td>${esc(r[1] || "")}</td><td>${esc(r[2] || "")}</td></tr>`).join("")
          }</tbody></table>`
        : "";
      return `
        <div class="seg">
          <div class="ribbon" style="background:${swatch(s.color, s.color2)}"></div>
          <div class="hd">${i + 1}. ${esc(s.lineName)}（${esc(s.typeLabel)}）${s.transfer ? " · 转乘（跨付费区）" : ""}</div>
          <div class="ln">${esc(s.from)} → ${esc(s.direction)} → ${esc(s.to)}
            · 运行 ${fmtMin(s.run)}${s.walk > 0 ? ` · 上车前步行 ${fmtMin(s.walk)}` : ""} · ${s.stopCount} 站
            · 班次 ${esc(s.headway)}
            ${s.firstTrain || s.lastTrain ? ` · 首末 ${esc(s.firstTrain || "—")} / ${esc(s.lastTrain || "—")}` : ""}
            ${s.price != null ? ` · 票价 ¥${esc(s.price)}` : ""}
            · 付费区 ${s.paidZone + 1}</div>
          ${s.note ? `<div class="ln">备注：${esc(s.note)}</div>` : ""}
          ${tt}
          <div class="st">经停站：${s.stops.map(esc).join(" → ")}</div>
        </div>`;
    }).join("");

    const zoneRows = res.paidZoneMode
      ? `<div class="zone"><b>付费区（按进闸→出闸一次计费）</b><br>${res.paidZones.map((z) =>
          `付费区 ${z.index}：${esc(z.entry)} → ${esc(z.exit)}（${z.segmentCount} 段 · 运行 ${fmtMin(z.run)}${z.price != null ? ` · ¥${z.price}` : ""}）`
        ).join("<br>")}</div>`
      : "";

    return `
      <div class="sheet">
        <h1>${esc(trip.name || "我的运转方案")}</h1>
        <div class="sub">${state.cityInfo ? `${esc(state.cityInfo.name)} · ` : ""}${esc(trip.date || "")}
          · 生成于 ${new Date().toLocaleString("zh-CN")}${trip.paid_zone_mode ? " · 付费区模式" : ""}</div>
        <div class="sum">
          <span>总时长 <b>${fmtMin(t.minutes)}</b></span>
          <span>运行 ${fmtMin(t.run)}</span>
          <span>换乘/步行 ${fmtMin(t.walk)}</span>
          <span>换乘 ${t.transferCount} 次</span>
          <span>转乘 ${t.fareTransferCount} 次</span>
          <span>线路 ${t.lineCount} 条</span>
          <span>站数 ${t.stopCount}</span>
          <span>票价 ¥${t.price}</span>
        </div>
        <div class="tl">${tl}</div>
        ${segs}
        ${zoneRows}
        <div class="zone">换乘步行时间为估算值，请以现场为准；站间时长为线路库估算近似值，请以运营方实时信息为准。</div>
      </div>`;
  }

  // ---------------- 启动 ----------------

  boot();
})();
