/* 运转计划助手 · Web —— 界面层
 *
 * 所有业务计算（分段时长、经停站、换乘判定、付费区、票价合计）都委托 Python 内核：
 *   js/bridge.js  →  web_api  →  transit_planner.core.engine（浏览器内运行同一份规划内核）
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
  // 双色线路的「上下各半」写法（用于彩色时间轴：上=主色、下=副色）
  const swatchV = (c1, c2) => (c2 ? `linear-gradient(180deg, ${c1} 0 50%, ${c2} 50% 100%)` : (c1 || "#888888"));
  const debounce = (fn, ms = 280) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const D = window.TPDrafts;
  const history = { current: null, undo: [], redo: [], lastChangeAt: 0, ready: false, restoring: false };
  const maxHistoryEntries = 100;
  const historyCoalesceMs = 700;

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
    draftId: "",
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

  let smartPlans = [];
  let smartContext = { targets: [] };

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
      state.cities = [...new Set([...(info.cities || []), ...Object.keys(info.combinedCities || {})])];

      fillCitySelect();
      fillTypeSelect();

      loadDraft();
      syncTopbar();
      const city = state.city || state.cities[0] || "";
      await setCity(city, { silent: true });
      resetHistory();

      $("boot").hidden = true;
      $("app").hidden = false;
      renderAll();
      flushDraft();
    } catch (err) {
      document.body.classList.add("err");
      $("boot").classList.add("error");
      $("boot-msg").textContent = `启动失败：${err.message}。请检查网络连接后重试。`;
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
    $("city-select").value = state.trip.city || "";
    $("trip-name").value = state.trip.name || "";
    $("trip-date").value = state.trip.date || "";
    $("paid-zone").checked = !!state.trip.paid_zone_mode;
  }

  function updateHistoryButtons() {
    $("btn-undo").disabled = history.undo.length === 0 || history.restoring;
    $("btn-redo").disabled = history.redo.length === 0 || history.restoring;
  }

  function resetHistory() {
    history.current = JSON.stringify(state.trip);
    history.undo = [];
    history.redo = [];
    history.lastChangeAt = 0;
    history.ready = true;
    updateHistoryButtons();
  }

  function recordHistoryChange() {
    if (!history.ready) return;
    const next = JSON.stringify(state.trip);
    if (next === history.current) return;
    const now = Date.now();
    if (!history.lastChangeAt || now - history.lastChangeAt > historyCoalesceMs) {
      history.undo.push(history.current);
      if (history.undo.length > maxHistoryEntries) history.undo.shift();
    }
    history.current = next;
    history.lastChangeAt = now;
    history.redo = [];
    updateHistoryButtons();
  }

  async function restoreHistory(source, destination) {
    if (history.restoring) return;
    const target = source.pop();
    if (!target) return;
    history.restoring = true;
    updateHistoryButtons();
    destination.push(JSON.stringify(state.trip));
    if (destination.length > maxHistoryEntries) destination.shift();
    try {
      const previousCity = state.city;
      state.trip = JSON.parse(target);
      history.current = JSON.stringify(state.trip);
      history.lastChangeAt = 0;
      const nextCity = state.trip.city || "";
      syncTopbar();
      if (previousCity !== nextCity) {
        await setCity(nextCity, { silent: true });
      } else {
        state.city = nextCity;
        renderAll();
        await evaluate();
      }
      flushDraft();
      history.current = JSON.stringify(state.trip);
    } finally {
      history.restoring = false;
      updateHistoryButtons();
    }
  }

  /** 读取 ?id= 指定的草稿；没有则打开最近一份，仍没有就新建。 */
  function loadDraft() {
    const requestedId = new URLSearchParams(location.search).get("id") || "";
    let draft = requestedId ? D.get("plan", requestedId) : null;
    if (!draft) {
      D.migrateLegacy();
      draft = D.list("plan")[0] || null;
    }
    if (!draft) {
      const data = D.empty("plan");
      data.city = state.cities[0] || "";
      draft = D.create("plan", {
        title: data.name,
        city: data.city,
        summary: D.summarize("plan", data),
        data,
      });
    }

    state.draftId = draft.id;
    state.city = draft.city || draft.data?.city || "";
    if (draft.data && typeof draft.data === "object") {
      state.trip = {
        ...state.trip,
        ...draft.data,
        steps: Array.isArray(draft.data.steps) ? draft.data.steps : [],
      };
    }
    markDraftSaved(draft.updatedAt);
  }

  function flushDraft() {
    if (!state.draftId) return;
    const saved = D.save("plan", {
      id: state.draftId,
      title: (state.trip.name || "").trim() || "我的运转方案",
      city: state.city || "",
      summary: D.summarize("plan", state.trip),
      data: state.trip,
    });
    markDraftSaved(saved.updatedAt);
  }

  function markDraftSaved(iso) {
    const el = $("draft-chip");
    if (!el) return;
    const d = iso ? new Date(iso) : new Date();
    if (!Number.isNaN(d.getTime())) {
      const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      el.textContent = `已自动保存 ${hm}`;
    }
    document.title = `${(state.trip.name || "").trim() || "我的运转方案"} · 规划模式 · 运转计划助手`;
  }

  const persistSave = debounce(flushDraft, 350);
  function persist() {
    recordHistoryChange();
    persistSave();
  }

  // ---------------- 城市与线路库 ----------------

  async function setCity(name, { silent = false } = {}) {
    state.city = name;
    state.trip.city = name;
    recordHistoryChange();
    state.selectedLine = "";
    $("city-select").value = name;
    $("line-detail").hidden = true;
    $("library-splitter").hidden = true;
    resetLibrarySplit();

    const res = TP.loadCity(name);
    if (!res.ok) {
      setStatus(res.error, true);
      state.lines = [];
      state.cityInfo = null;
    } else {
      state.lines = res.lines || [];
      state.cityInfo = res.city;
      const stem = state.info?.cityFiles?.[name] || name;
      const override = TP.published?.[stem];
      $("city-label").textContent = res.city
        ? `${res.city.lineCount} 条线路 · ${res.city.stationCount} 站${res.city.combined ? " · 只读同城组合" : ""}${override ? " · 含社区审核数据" : ""}`
        : "纯手动模式";

      const editorButton = $("btn-editor");
      if (editorButton) {
        const editorParams = new URLSearchParams({ from: "plan" });
        if (name && !res.city?.combined) editorParams.set("city", stem);
        editorButton.href = `editor.html?${editorParams}`;
        editorButton.title = res.city?.combined
          ? "同城组合由多座城市合并而成，请分别编辑组成城市的数据"
          : "编辑该城市线路数据、提交审核";
      }
    }
    state.lineDetail.clear();
    renderLibrary();
    await refreshStationOptions();
    await evaluate();
    if (!silent) {
      persist();
    }
  }

  function showNotice(title, message) {
    $("notice-title").textContent = title;
    $("notice-msg").textContent = message;
    const dlg = $("notice-dialog");
    if (!dlg.open) dlg.showModal();
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
    const isBranch = (name) => Boolean(window.LineBranches?.parseBranchName(name));
    $("line-list").innerHTML = items.map((ln) => `
      <div class="line-item${ln.id === state.selectedLine ? " active" : ""}" data-line="${esc(ln.id)}" title="单击查看详情，双击预填到新行程">
        <span class="swatch" style="background:${swatch(ln.color, ln.color2)}"></span>
        <span class="nm">${esc(ln.name)}</span>
        ${isBranch(ln.name) ? '<span class="tag tag-branch">支线</span>' : ""}
        <span class="tag">${esc(ln.typeLabel)}</span>
        ${ln.system ? `<span class="tag">${esc(ln.system)}</span>` : ""}
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
    $("library-splitter").hidden = false;
    $("line-detail").innerHTML = `
      <div class="kv"><b>${esc(line.name)}</b><span class="tag">${esc(line.typeLabel)}</span></div>
      ${line.system ? `<div class="kv">系统：${esc(line.system)}</div>` : ""}
      <div class="kv">方向：${esc(line.directions.join(" / "))}</div>
      <div class="kv">班次：${esc(line.headwayText)}${line.firstTrain ? ` · 首班 ${esc(line.firstTrain)}` : ""}${line.lastTrain ? ` · 末班 ${esc(line.lastTrain)}` : ""}</div>
      ${line.operator ? `<div class="kv">运营：${esc(line.operator)}</div>` : ""}
      ${line.ring ? `<div class="kv">环线（首尾闭合）</div>` : ""}
      ${lineServices(line).length ? `<div class="kv">快车：${lineServices(line).map((svc) => `${esc(svc.name)}（停 ${(svc.stops || []).length} 站）`).join(" / ")}</div>` : ""}
      <div class="station-chain">${chain}</div>
      <p class="hint" style="margin:6px 0 0">双击左侧线路可把该线路预填到新行程。</p>`;
    $("line-detail").scrollTop = 0;
    // 默认布局优先保证线路信息完整显示，之后可用分割条上下拖动调整
    fitLibrarySplit();
  }

  // ---------------- 线路库分割条（列表 / 详情高度可拖动） ----------------

  const SPLIT_MIN_LIST = 60;
  const SPLIT_MIN_DETAIL = 96;

  function librarySplitterVisible() {
    const splitter = $("library-splitter");
    return !splitter.hidden && splitter.offsetParent !== null;
  }

  /** 列表顶边到面板内容区底边之间的垂直空间（含列表、分割条、详情）。 */
  function librarySplitSpace() {
    const lib = document.querySelector(".library");
    const rect = lib.getBoundingClientRect();
    const cs = getComputedStyle(lib);
    const bottom = rect.bottom - parseFloat(cs.paddingBottom) - parseFloat(cs.borderBottomWidth);
    return Math.max(0, bottom - $("line-list").getBoundingClientRect().top);
  }

  function splitterHeight() {
    const splitter = $("library-splitter");
    const cs = getComputedStyle(splitter);
    return splitter.offsetHeight + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
  }

  function maxListHeight() {
    return Math.max(SPLIT_MIN_LIST, librarySplitSpace() - splitterHeight() - SPLIT_MIN_DETAIL);
  }

  function setListHeight(px) {
    $("line-list").style.flexBasis = `${Math.max(0, Math.round(px))}px`;
  }

  function resetLibrarySplit() {
    $("line-list").style.flexBasis = "";
    document.querySelector(".library").classList.remove("has-detail", "dragging");
  }

  /** 详情的自然高度：临时解除 flex 拉伸，量完立即还原。 */
  function detailNaturalHeight() {
    const detail = $("line-detail");
    const prev = detail.style.flex;
    detail.style.flex = "0 0 auto";
    const height = detail.scrollHeight;
    detail.style.flex = prev;
    return height + 2;
  }

  /** 默认布局：优先给足详情高度，列表占用剩余空间；详情过长时才在内部滚动。 */
  function fitLibrarySplit() {
    document.querySelector(".library").classList.add("has-detail");
    if (!librarySplitterVisible()) {
      $("line-list").style.flexBasis = "";
      return;
    }
    const available = librarySplitSpace() - splitterHeight();
    const listHeight = available - detailNaturalHeight();
    setListHeight(Math.min(Math.max(listHeight, SPLIT_MIN_LIST), maxListHeight()));
  }

  function initLibrarySplitter() {
    const splitter = $("library-splitter");
    const list = $("line-list");
    const lib = document.querySelector(".library");
    let drag = null;

    splitter.addEventListener("pointerdown", (ev) => {
      if (ev.pointerType === "mouse" && ev.button !== 0) return;
      ev.preventDefault();
      drag = { y: ev.clientY, height: list.getBoundingClientRect().height };
      splitter.setPointerCapture(ev.pointerId);
      lib.classList.add("dragging");
    });
    splitter.addEventListener("pointermove", (ev) => {
      if (!drag) return;
      const height = drag.height + (ev.clientY - drag.y);
      setListHeight(Math.min(Math.max(height, SPLIT_MIN_LIST), maxListHeight()));
    });
    const stopDrag = () => {
      drag = null;
      lib.classList.remove("dragging");
    };
    splitter.addEventListener("pointerup", stopDrag);
    splitter.addEventListener("pointercancel", stopDrag);
    splitter.addEventListener("lostpointercapture", stopDrag);
    splitter.addEventListener("dblclick", fitLibrarySplit);

    splitter.addEventListener("keydown", (ev) => {
      const current = list.getBoundingClientRect().height;
      let next = null;
      if (ev.key === "ArrowUp") next = current - 24;
      else if (ev.key === "ArrowDown") next = current + 24;
      else if (ev.key === "Home") next = SPLIT_MIN_LIST;
      else if (ev.key === "End") next = maxListHeight();
      if (next == null) return;
      ev.preventDefault();
      setListHeight(Math.min(Math.max(next, SPLIT_MIN_LIST), maxListHeight()));
    });

    // 窄屏隐藏分割条时，清掉内联高度，恢复按内容自然排布
    window.addEventListener("resize", debounce(() => {
      if (!librarySplitterVisible()) list.style.flexBasis = "";
    }, 150));
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
    recordHistoryChange();
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
      $("step-list").innerHTML = '<p class="hint">还没有行程。点击下方「＋ 添加行程」开始串联。</p>';
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
    const system = seg?.system || step.system || "";
    const dir = seg?.direction || step.direction_label || "—";
    const run = seg ? fmtMin(seg.run) : (step.run_minutes != null ? fmtMin(step.run_minutes) : "—");
    const stops = seg?.stops || [];
    const price = step.price != null ? `<span class="price">票价 ¥${esc(step.price)}</span>` : "";
    const note = step.note ? `<b>备注</b>${esc(step.note)}` : "";
    const transfer = seg?.transfer ? '<span class="badge-transfer">跨系统转乘</span>' : "";
    const zone = seg ? `<b>付费区</b>${seg.paidZone + 1}` : "";
    const manual = step.manual ? '<span class="type">手动</span>' : "";
    const serviceName = seg?.serviceName || (step.service ? step.service : "");
    const service = serviceName ? `<span class="badge-express">${esc(serviceName)}</span>` : "";
    const stopsBlock = stops.length
      ? `<details class="stops-toggle"><summary class="hint">经停站（${stops.length} 站）</summary><div class="stops">${stops.map(esc).join(" · ")}</div></details>`
      : "";
    const railTimetable = step.rail_timetable ? railTimetableHtml(step.rail_timetable) : "";
    const tt = renderTimetable(step);

    return `
      <div class="card${error ? " error" : ""}">
        <div class="ribbon" style="background:${swatch(color, color2)}"></div>
        <div class="body">
          <div class="card-head">
            <span class="nm">${esc(name)}</span>
            ${typeLabel ? `<span class="type">${esc(typeLabel)}</span>` : ""}
            ${system ? `<span class="type">${esc(system)}</span>` : ""}
            ${service}${manual}${transfer}
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
          ${railTimetable}
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
      ["转乘次数", t ? `${t.systemTransferCount ?? t.fareTransferCount} 次` : "—"],
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
      parts.push(`<div style="flex:${Math.max(s.run, 0.01) / total};background:${swatchV(s.color, s.color2)}" title="${esc(s.lineName)} ${esc(s.direction)} 运行 ${fmtMin(s.run)}"></div>`);
      return parts.join("");
    }).join("");
    const legend = segs.map((s) => `<span><i class="dot" style="background:${swatchV(s.color, s.color2)}"></i>${esc(s.shortName || s.lineName)} ${fmtMin(s.run)}</span>`).join("");
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

  /** 当前所在站：最后一段行程的到达站。 */
  function currentStation() {
    const steps = state.trip.steps;
    return steps.length ? steps[steps.length - 1].to_station || "" : "";
  }

  async function renderHints() {
    const steps = state.trip.steps;
    const station = currentStation();
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
    const inZone = others.filter((h) => !h.transfer);   // 同系统换乘
    const crossZone = others.filter((h) => h.transfer); // 跨系统转乘
    const row = (h) => {
      const board = h.boardStation || h.transferStation || station;
      return `
        <div class="hint-item" data-line="${esc(h.id)}" data-from="${esc(board)}" role="button" tabindex="0"
             title="双击添加「${esc(h.name)}」，起点填为「${esc(board)}」">
          <i class="dot" style="background:${swatch(h.color, h.color2)}"></i>
          <span>${esc(h.name)}</span>
          <span class="tag">${esc(h.typeLabel)}</span>
          ${h.transfer ? '<span class="badge-transfer">跨系统转乘</span>' : ""}
          <span class="dirs" title="${esc(h.directions.join(" / "))}">${esc(h.directions.join(" / "))}</span>
        </div>`;
    };
    const parts = [];
    if (inZone.length) {
      parts.push(`<p class="hint" style="margin:0">在「${esc(station)}」可换乘：</p>`, ...inZone.map(row));
    }
    if (crossZone.length) {
      const exits = [...new Set(crossZone.map((h) => h.transferStation || station))];
      parts.push(
        `<p class="hint" style="margin:0">在「${esc(exits.join(" / "))}」跨系统转乘：</p>`,
        ...crossZone.map(row),
      );
    }
    parts.push('<p class="hint" style="margin:4px 0 0">双击线路可添加为下一段，起点自动填为当前站。</p>');
    $("hints").innerHTML = parts.join("");
  }

  /** 双击（或键盘 Enter）换乘提示中的线路，直接添加下一段。 */
  function addStepFromHint(item) {
    if (!item) return;
    addStepWithLine(item.dataset.line, item.dataset.from || "");
  }

  $("hints").addEventListener("dblclick", (ev) => {
    const item = ev.target.closest("[data-line]");
    if (!item) return;
    ev.preventDefault();
    addStepFromHint(item);
  });
  $("hints").addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const item = ev.target.closest("[data-line]");
    if (!item) return;
    ev.preventDefault();
    addStepFromHint(item);
  });

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
  initLibrarySplitter();

  // 单击查看线路详情；双击（同一线路 400ms 内两次单击）打开「添加行程」并预填该线路。
  // 注意：这里不能用原生 dblclick——单击会重绘线路列表、替换掉被点的节点，
  // 浏览器便不再对 line-list 派发 dblclick，双击会完全没有反应。
  let lastLineClick = { id: "", at: 0 };
  $("line-list").addEventListener("click", async (ev) => {
    const item = ev.target.closest("[data-line]");
    if (!item) return;
    const id = item.dataset.line;
    const now = Date.now();
    const isDouble = lastLineClick.id === id && now - lastLineClick.at < 400;
    lastLineClick = isDouble ? { id: "", at: 0 } : { id, at: now };
    if (isDouble) await addStepWithLine(id);
    else await showLineDetail(id);
  });

  /** 打开「添加行程」弹窗并预填指定数据库线路；prefillFrom 默认当前站。 */
  async function addStepWithLine(lineId, prefillFrom = "") {
    try {
      await openStepDialog(null, { prefillFrom: prefillFrom || currentStation() });
      await setDialogLine(lineId);
    } catch (err) {
      setStatus(`打开添加行程失败：${err.message}`, true);
    }
  }

  // ---------------- 智能规划 ----------------

  function showSmartError(msg) {
    const box = $("smart-error");
    box.textContent = msg || "";
    box.hidden = !msg;
  }

  function openSmartDialog() {
    if (!state.city) {
      showNotice("请先选择城市", "智能规划需要使用城市线路库，请先在上方选择城市。");
      return;
    }
    const stations = TP.stations();
    if (!stations.ok) {
      showNotice("线路库不可用", stations.error || "无法读取当前城市的车站。");
      return;
    }
    const list = stations.stations || [];
    if (!list.length) {
      showNotice("没有可用车站", "当前城市没有可用车站数据，暂时无法智能规划。");
      return;
    }

    const throughServiceIds = new Set(state.cityInfo?.throughServiceIds || []);
    const planningLines = state.lines.filter((line) => !throughServiceIds.has(line.id));
    const lineDetails = [];
    for (const summary of planningLines) {
      let line = state.lineDetail.get(summary.id);
      if (!line) {
        const detail = TP.line(summary.id);
        if (!detail.ok) {
          showNotice("线路库不可用", detail.error || `无法读取线路「${summary.name}」`);
          return;
        }
        line = detail.line;
        state.lineDetail.set(line.id, line);
      }
      lineDetails.push(line);
    }

    const stationLines = new Map();
    const lineGroups = window.LineBranches.groupLines(lineDetails);
    for (const group of lineGroups) {
      const members = [group.main, ...group.branches];
      const marker = {
        color: swatch(group.main.color, group.main.color2),
      };
      for (const name of new Set(members.flatMap((line) => line.stations))) {
        if (!stationLines.has(name)) stationLines.set(name, []);
        const stationMembers = members.filter((line) => line.stations.includes(name));
        stationLines.get(name).push({
          ...marker,
          name: stationMembers.map((line) => line.name).join("、"),
        });
      }
    }

    $("smart-lines").innerHTML = planningLines.map((line) => `
      <label class="smart-check">
        <input type="checkbox" name="smart-line" value="${esc(line.id)}">
        <i class="smart-color-marker" style="background:${swatch(line.color, line.color2)}" aria-hidden="true"></i>
        <span class="smart-line-label">
          <span>${esc(line.shortName || line.name)}${line.typeLabel ? `（${esc(line.typeLabel)}）` : ""}</span>
          ${state.cityInfo?.combined && line.cityName ? `<small class="smart-line-city">${esc(line.cityName)}</small>` : ""}
        </span>
      </label>`).join("");
    $("smart-stations").innerHTML = list.map((name) => `
      <label class="smart-check">
        <input type="checkbox" name="smart-station" value="${esc(name)}">
        <span class="smart-station-markers" aria-label="${esc((stationLines.get(name) || []).map((line) => line.name).join("、"))}">
          ${(stationLines.get(name) || []).map((line) => `<i class="smart-color-marker" style="background:${line.color}" title="${esc(line.name)}" aria-hidden="true"></i>`).join("")}
        </span>
        <span>${esc(name)}</span>
      </label>`).join("");
    $("smart-origin-options").innerHTML = list.map((name) => `<option value="${esc(name)}"></option>`).join("");
    $("smart-origin").value = "";
    $("smart-walk").value = state.trip.transfer_walk_default ?? 5;

    smartPlans = [];
    $("smart-results").innerHTML = "";
    showSmartError("");
    $("smart-dialog").showModal();
  }

  function runSmartPlan() {
    const lineIds = [...document.querySelectorAll('input[name="smart-line"]:checked')].map((input) => input.value);
    const stationNames = [...document.querySelectorAll('input[name="smart-station"]:checked')].map((input) => input.value);
    const requestedOrigin = $("smart-origin").value.trim();
    const walk = numOrNull($("smart-walk").value) ?? state.trip.transfer_walk_default ?? 5;
    if (!lineIds.length && !stationNames.length) {
      return showSmartError("请至少勾选一条想乘坐的线路或一座想前往的车站");
    }

    showSmartError("");
    const goals = [
      ...lineIds.map((id) => ({ mode: "line", target: id, label: state.lines.find((line) => line.id === id)?.name || id })),
      ...stationNames.map((name) => ({ mode: "station", target: name, label: name })),
    ];
    smartContext = { targets: goals.map((goal) => goal.label) };
    const button = $("btn-smart-run");
    button.disabled = true;
    button.textContent = "计算中…";
    setTimeout(() => {
      try {
        const allStations = listStations();
        if (requestedOrigin && !allStations.includes(requestedOrigin)) {
          throw new Error(`线路库中没有找到起始站「${requestedOrigin}」`);
        }
        const firstGoal = goals[0];
        let origins = [];
        if (requestedOrigin) {
          origins = [requestedOrigin];
        } else if (firstGoal.mode === "line") {
          const detail = TP.line(firstGoal.target);
          if (!detail.ok) throw new Error(detail.error || `无法读取线路「${firstGoal.label}」`);
          origins = detail.line?.stations || [];
        } else {
          origins = allStations.filter((name) => !stationNames.includes(name));
        }
        origins = sampleOrigins([...new Set(origins)], 18);
        const candidates = origins.map((origin) => ({
          origin,
          current: origin,
          steps: [],
          legs: [],
          minutes: 0,
          transfers: 0,
          lineCount: 0,
          stopCount: 0,
        }));
        let plans = candidates;
        for (const goal of goals) {
          const next = [];
          for (const candidate of plans) {
            if (goal.mode === "station" && candidate.current === goal.target) {
              next.push(candidate);
              continue;
            }
            const result = TP.planRoutes({
              mode: goal.mode,
              origin: candidate.current,
              target: goal.target,
              transferWalk: walk,
              limit: goal.mode === "line" ? 1 : 2,
            });
            if (!result.ok) continue;
            for (const route of result.plans || []) {
              const routeSteps = JSON.parse(JSON.stringify(route.steps || []));
              const last = routeSteps[routeSteps.length - 1];
              if (!last || !last.to_station) continue;
              const routeLegs = (route.legs || []).map((leg) => ({ ...leg }));
              const previousLeg = candidate.legs[candidate.legs.length - 1];
              if (previousLeg && routeLegs[0]) {
                routeLegs[0].transfer = previousLeg.lineId !== routeLegs[0].lineId;
                routeSteps[0].transfer = routeLegs[0].transfer ? true : null;
              }
              const legs = [...candidate.legs, ...routeLegs];
              const transfers = legs.reduce((count, leg, index) => (
                index > 0 && legs[index - 1].lineId !== leg.lineId ? count + 1 : count
              ), 0);
              next.push({
                origin: candidate.origin,
                current: last.to_station,
                steps: [...candidate.steps, ...routeSteps],
                legs,
                minutes: candidate.minutes + Number(route.minutes || 0),
                transfers,
                lineCount: new Set(legs.map((leg) => leg.lineId)).size,
                stopCount: legs.reduce((total, leg) => total + Number(leg.stopCount || 0), 0),
              });
            }
          }
          plans = next
            .sort((a, b) => a.transfers - b.transfers || a.minutes - b.minutes)
            .slice(0, 8);
          if (!plans.length) break;
        }
        const completePlans = plans.filter((plan) => plan.steps.length);
        if (!completePlans.length && plans.length) {
          smartPlans = [];
          $("smart-results").innerHTML = "";
          showSmartError("起始站已是所选车站，无需规划行程；请添加其他目标");
          return;
        }
        smartPlans = completePlans.map((plan, index) => ({
          ...plan,
          tag: `方案 ${index + 1}`,
          experienceSummary: smartContext.targets.join("、"),
        }));
        renderSmartPlans();
      } catch (err) {
        smartPlans = [];
        $("smart-results").innerHTML = "";
        showSmartError(`计算失败：${err.message}`);
      } finally {
        button.disabled = false;
        button.textContent = "生成方案";
      }
    }, 20);
  }

  function listStations() {
    const result = TP.stations();
    if (!result.ok) throw new Error(result.error || "无法读取车站列表");
    return result.stations || [];
  }

  function sampleOrigins(stations, limit) {
    if (stations.length <= limit) return stations;
    return Array.from({ length: limit }, (_, index) => stations[Math.floor(index * (stations.length - 1) / (limit - 1))]);
  }

  function smartPlanHtml(plan, index) {
    const legs = (plan.legs || []).map((leg, legIndex) => {
      const color = leg.color2
        ? `linear-gradient(90deg, ${leg.color} 0 50%, ${leg.color2} 50% 100%)`
        : (leg.color || "#888888");
      const walk = leg.walk > 0
        ? `<div class="smart-walk">上车前步行 ${fmtMin(leg.walk)}</div>`
        : "";
      const interchange = leg.interchange && legIndex > 0
        ? '<span class="smart-badge">换乘</span>'
        : "";
      const transfer = leg.transfer && legIndex > 0
        ? '<span class="smart-badge">转乘</span>'
        : "";
      return `${walk}<div class="smart-leg">
        <i class="dot" style="background:${color}"></i>
        <span class="ln">${esc(leg.lineName)}${leg.serviceName ? `（${esc(leg.serviceName)}）` : ""}</span>
        <span class="meta">${esc(leg.from)} 至 ${esc(leg.to)}</span>
        <span class="dir">${esc(leg.direction)} · ${fmtMin(leg.run)} · ${leg.stopCount} 站</span>
        ${interchange}
        ${transfer}
      </div>`;
    }).join("");
    return `<div class="smart-card">
      <div class="smart-card-head">
        <span class="smart-tag">${esc(plan.tag || "备选")}</span>
        <span class="smart-time">${fmtMin(plan.minutes)}</span>
        <span class="hint">起点 ${esc(plan.origin)} · 覆盖 ${esc(plan.experienceSummary)} · 换乘 ${plan.transfers} 次 · 转乘 ${plan.systemTransfers} 次 · ${plan.lineCount} 条线路 · ${plan.stopCount} 站</span>
        <div class="spacer"></div>
        <button type="button" data-smart-apply="append" data-smart-index="${index}">追加到末尾</button>
        <button type="button" class="primary" data-smart-apply="replace" data-smart-index="${index}">替换规划</button>
      </div>
      <div class="smart-legs">${legs}</div>
    </div>`;
  }

  function renderSmartPlans() {
    const box = $("smart-results");
    if (!smartPlans.length) {
      box.innerHTML = '<p class="smart-empty">没有找到可行方案。</p>';
      return;
    }
    box.innerHTML = smartPlans.map((plan, index) => smartPlanHtml(plan, index)).join("");
  }

  function applySmartPlan(index, mode) {
    const plan = smartPlans[index];
    if (!plan) return;
    const steps = JSON.parse(JSON.stringify(plan.steps || []));
    if (!steps.length) return;
    if (mode === "replace") {
      if (state.trip.steps.length
        && !confirm(`用该方案替换当前 ${state.trip.steps.length} 段行程吗？`)) return;
      state.trip.steps = steps;
    } else {
      // 追加时按上一段到达站自动判定第一段的换乘步行
      steps[0].walk_minutes = null;
      state.trip.steps.push(...steps);
    }
    $("smart-dialog").close();
    evaluate();
    toast(mode === "replace" ? "已替换为智能方案" : "已追加智能方案");
  }

  $("btn-smart").addEventListener("click", openSmartDialog);
  $("btn-smart-close").addEventListener("click", () => $("smart-dialog").close());
  $("btn-smart-run").addEventListener("click", runSmartPlan);
  $("smart-dialog").addEventListener("submit", (ev) => {
    ev.preventDefault();
    runSmartPlan();
  });
  $("smart-results").addEventListener("click", (ev) => {
    const button = ev.target.closest("[data-smart-apply]");
    if (!button) return;
    applySmartPlan(Number(button.dataset.smartIndex), button.dataset.smartApply);
  });

  // ---------------- 顶栏交互 ----------------

  $("city-select").addEventListener("change", (ev) => setCity(ev.target.value));
  $("trip-name").addEventListener("input", (ev) => { state.trip.name = ev.target.value; persist(); });
  $("trip-date").addEventListener("change", (ev) => { state.trip.date = ev.target.value; persist(); });
  $("paid-zone").addEventListener("change", (ev) => { state.trip.paid_zone_mode = ev.target.checked; evaluate(); });
  $("btn-undo").addEventListener("click", () => restoreHistory(history.undo, history.redo));
  $("btn-redo").addEventListener("click", () => restoreHistory(history.redo, history.undo));

  $("btn-switch-record").addEventListener("click", (ev) => {
    ev.preventDefault();
    flushDraft();
    const data = {
      ...JSON.parse(JSON.stringify(state.trip)),
      fields: [],
      steps: JSON.parse(JSON.stringify(state.trip.steps)),
    };
    const draft = D.create("record", {
      title: (state.trip.name || "").trim() || "我的运转记录",
      city: state.trip.city || "",
      summary: D.summarize("record", data),
      data,
    });
    location.href = `record.html?id=${encodeURIComponent(draft.id)}`;
  });

  $("btn-export").addEventListener("click", () => $("export-dialog").showModal());
  $("btn-export-json").addEventListener("click", () => {
    $("export-dialog").close();
    // 与运转记录共用同一结构：kind 标记当前离线编辑器，起止时间等记录字段原样保留
    const payload = { ...state.trip, kind: "plan", version: 2, exportedAt: new Date().toISOString() };
    D.downloadJSON(D.safeFileName(state.trip.name, "运转方案"), payload);
    toast("已导出方案文件（与运转记录互通）");
  });
  $("btn-export-pdf").addEventListener("click", () => {
    $("export-dialog").close();
    printPlan();
  });
  $("export-dialog").querySelector("[data-close-export]").addEventListener("click", () => $("export-dialog").close());

  // 一键清除当前方案的全部行程段（保留城市、方案名、日期与付费区设置）
  $("btn-clear").addEventListener("click", () => {
    if (!state.trip.steps.length) {
      toast("当前没有行程可清除");
      return;
    }
    if (!confirm(`确定清除当前方案的 ${state.trip.steps.length} 段行程吗？\n城市、方案名、日期与付费区设置会保留，可通过撤销恢复。`)) return;
    state.trip.steps = [];
    state.result = null;
    setStatus("");
    renderAll();
    persist();
    toast("已清除当前规划");
  });

  $("btn-import").addEventListener("click", () => $("file-import").click());
  $("file-import").addEventListener("change", async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    try {
      const raw = JSON.parse(await file.text());
      const data = raw && Array.isArray(raw.steps) ? raw : raw?.trip;
      if (!data || typeof data !== "object" || !Array.isArray(data.steps)) {
        throw new Error("文件中没有找到 steps 数组，可能不是方案或记录文件");
      }
      // 记录 JSON 与方案结构一致：去掉文档元信息，段落里的记录字段（起止时间等）原样保留
      const { kind: _kind, version: _version, exportedAt: _exported, ...tripData } = data;
      const updatedRailData = await updateStaleImportedRailData(tripData, data.exportedAt);
      state.trip = { ...state.trip, ...tripData, steps: tripData.steps };
      syncTopbar();
      if (state.trip.city && state.trip.city !== state.city) await setCity(state.trip.city, { silent: true });
      renderAll();
      await evaluate();
      flushDraft();
      if (updatedRailData.failed.length) {
        setStatus(`已导入规划方案；国铁数据更新失败（已保留原数据）：${updatedRailData.failed.join("；")}`, true);
      } else {
        toast(updatedRailData.updated
          ? `已导入规划方案并更新 ${updatedRailData.updated} 段国铁经停数据`
          : "已导入规划方案");
      }
    } catch (err) {
      setStatus(`导入失败：${err.message}`, true);
    } finally {
      ev.target.value = "";
    }
  });

  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { el.hidden = true; }, 2000);
  }

  // ---------------- 行程弹窗 ----------------

  const dlg = {
    index: null, mode: "db", lineId: "", line: null, prefillFrom: "", service: "",
    railTrains: [], railTrain: null, railQuerySeq: 0, railConfirming: false,
    railTimetableCache: new Map(), railTimetableRequests: new Map(),
  };
  const railApiRateLimitKey = "railkale-api-rate-limit-v1";
  const railTimetableStoragePrefix = "railkale-timetable-cache-v1:";

  /** 当前弹窗选中的车种 id（空串 = 各站停）。 */
  function dialogService() {
    return $("service-field").hidden ? "" : $("line-service").value;
  }

  /** 线路的快车服务列表（无快车时为空）。 */
  function lineServices(line) {
    return Array.isArray(line?.express) ? line.express : [];
  }

  /** 填充车种下拉：始终包含「各站停」；线路有快车服务时显示该区域。 */
  function fillServiceSelect(line, selected = "") {
    const services = lineServices(line);
    $("service-field").hidden = services.length === 0;
    if (!services.length) {
      $("line-service").innerHTML = "";
      $("service-hint").textContent = "";
      dlg.service = "";
      return;
    }
    const opts = ['<option value="">各站停（普通车）</option>'];
    services.forEach((svc) => {
      const stops = Array.isArray(svc.stops) ? svc.stops : [];
      const headway = svc.headwayText ? ` · ${svc.headwayText}` : "";
      opts.push(`<option value="${esc(svc.id)}">${esc(svc.name)} · 停 ${stops.length} 站${esc(headway)}</option>`);
    });
    $("line-service").innerHTML = opts.join("");
    const exists = services.some((svc) => svc.id === selected);
    $("line-service").value = exists ? selected : "";
    dlg.service = $("line-service").value;
    updateServiceHint();
  }

  function updateServiceHint() {
    const svc = lineServices(dlg.line).find((s) => s.id === $("line-service").value);
    $("service-hint").textContent = svc
      ? `停靠：${(svc.stops || []).join(" → ")}`
      : "各站停：全部车站都会停靠";
  }

  function setDialogError(msg) {
    $("dlg-error").hidden = !msg;
    $("dlg-error").textContent = msg || "";
  }

  function setMode(mode) {
    const previous = dlg.mode;
    dlg.mode = mode;
    $("mode-db").checked = mode === "db";
    $("mode-rail").checked = mode === "rail";
    $("mode-manual").checked = mode === "manual";
    $("db-fields").hidden = mode !== "db";
    $("rail-fields").hidden = mode !== "rail";
    $("timetable-fields").hidden = mode === "rail";
    $("manual-fields").hidden = mode !== "manual";
    $("btn-dlg-save").textContent = mode === "rail"
      ? (dlg.railTrain ? "确认并加入" : "选择车次后确认并加入")
      : "确定";
    if (previous === "rail" && mode !== "rail") resetRailQuery();
  }

  function resetRailQuery() {
    dlg.railQuerySeq += 1;
    dlg.railTrains = [];
    dlg.railTrain = null;
    $("rail-query-results").hidden = true;
    $("rail-query-results").innerHTML = "";
    $("rail-selected").hidden = true;
    $("rail-selected").textContent = "";
    $("rail-query-status").className = "hint";
    $("rail-query-status").textContent = "";
    $("btn-rail-query").disabled = false;
    $("btn-rail-query").textContent = "查询车次";
    if (dlg.mode === "rail") $("btn-dlg-save").textContent = "选择车次后确认并加入";
  }

  async function reserveRailApiRequest(endpoint) {
    const reserve = () => {
      const now = Date.now();
      let records = {};
      try {
        const stored = localStorage.getItem(railApiRateLimitKey);
        if (stored) {
          records = JSON.parse(stored);
          if (!records || typeof records !== "object" || Array.isArray(records)) {
            throw new Error("访问记录格式无效");
          }
        }
      } catch (error) {
        throw new Error(`无法读取 RailKale 访问限额记录：${error.message}`);
      }

      const timestamps = records[endpoint] || [];
      if (!Array.isArray(timestamps) || timestamps.some((time) => !Number.isSafeInteger(time))) {
        throw new Error("RailKale 访问限额记录损坏，请清除本站缓存后重试");
      }
      const recent = timestamps.filter((time) => time > now - 60_000).sort((a, b) => a - b);
      if (recent.length >= 3) {
        const waitSeconds = Math.max(1, Math.ceil((recent[0] + 60_000 - now) / 1000));
        return { allowed: false, waitSeconds };
      }

      records[endpoint] = [...recent, now];
      try {
        localStorage.setItem(railApiRateLimitKey, JSON.stringify(records));
      } catch (error) {
        throw new Error(`无法保存 RailKale 访问限额记录：${error.message}`);
      }
      return { allowed: true, waitSeconds: 0 };
    };
    return navigator.locks?.request
      ? navigator.locks.request(railApiRateLimitKey, reserve)
      : reserve();
  }

  async function fetchRailJson(endpoint, params) {
    const limit = await reserveRailApiRequest(endpoint);
    if (!limit.allowed) {
      throw new Error(`已达到该接口每分钟 3 次的访问上限，请约 ${limit.waitSeconds} 秒后重试`);
    }
    const paths = { getTrains: "getTrains", trainTimeTable: "trainTimeTable" };
    const path = paths[endpoint];
    if (!path) throw new Error("不支持的 RailKale 接口");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20_000);
    try {
      const query = new URLSearchParams(params);
      const response = await fetch(`https://next.laide.net.cn/api/v3/${path}?${query}`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`接口返回 HTTP ${response.status}`);
      try {
        return await response.json();
      } catch {
        throw new Error("接口返回的内容不是有效 JSON");
      }
    } catch (error) {
      if (error.name === "AbortError") throw new Error("接口请求超过 20 秒，已停止等待");
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function localDateValue(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function parseRailDuration(value) {
    const match = /^(\d{1,3}):([0-5]\d)$/.exec(String(value || ""));
    if (!match) throw new Error(`接口返回了无效运行时长「${value}」`);
    return Number(match[1]) * 60 + Number(match[2]);
  }

  function validRailTime(value) {
    return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""));
  }

  function railArrivalStation(train, requestedTo) {
    // The D107 result codes are ambiguous; the timetable verifies the actual stop before prefill.
    if (train.trainNo === "D107" && train.fromStation === "SNH"
      && train.toStation === "HKN" && train.fromTime === "20:38") {
      if (train.toTime === "06:16" && train.duration === "09:38") return "武昌";
      if (train.toTime === "06:41" && train.duration === "10:03") return "汉口";
    }
    return requestedTo;
  }

  function railTimeMinutes(value) {
    if (!validRailTime(value)) return null;
    const [hours, minutes] = value.split(":").map(Number);
    return hours * 60 + minutes;
  }

  function normalizeRailTimetable(payload, train, date) {
    const data = payload?.data;
    if (!payload || payload.code !== 0 || !data || !Array.isArray(data.stops)) {
      throw new Error(payload?.msg || "接口未返回有效的车次时刻表");
    }
    if (data.train_number !== train.trainNo || data.date !== date) {
      throw new Error("时刻表车次号或日期与查询结果不一致");
    }
    const stops = data.stops.map((stop) => {
      if (!stop || typeof stop.station_name !== "string" || !stop.station_name
        || !validRailTime(stop.arrive_time) || !validRailTime(stop.depart_time)) {
        throw new Error("时刻表中的车站或时刻数据格式不完整");
      }
      const minutes = Number(stop.stopover_minutes);
      return {
        stationNo: stop.station_no == null ? "" : String(stop.station_no),
        stationName: stop.station_name,
        arriveTime: stop.arrive_time,
        departTime: stop.depart_time,
        stopoverMinutes: Number.isFinite(minutes) ? minutes : null,
        stopoverDisplay: typeof stop.stopover_display === "string" ? stop.stopover_display : "",
      };
    });
    if (!stops.length) throw new Error("时刻表没有经停站信息");
    return { ...data, stops };
  }

  function matchRailTimetableLeg(train, timetable) {
    const starts = [];
    const ends = [];
    timetable.stops.forEach((stop, index) => {
      if (stop.departTime === train.fromTime) starts.push(index);
      if (stop.arriveTime === train.toTime) ends.push(index);
    });
    const pairs = [];
    starts.forEach((start) => {
      ends.forEach((end) => {
        if (end > start) pairs.push({ start, end });
      });
    });
    if (pairs.length !== 1) return null;

    const { start, end } = pairs[0];
    const departure = railTimeMinutes(timetable.stops[start].departTime);
    const arrival = railTimeMinutes(timetable.stops[end].arriveTime);
    const duration = (arrival - departure + 24 * 60) % (24 * 60);
    if (duration !== train.durationMinutes) return null;
    return { start, end, stops: timetable.stops.slice(start, end + 1), duration };
  }

  /** 已保存的国铁全程时刻表：在行程卡片中折叠展示，便于核对。 */
  function railTimetableHtml(timetable) {
    const stops = Array.isArray(timetable?.stops) ? timetable.stops : [];
    if (!stops.length) return "";
    const rows = stops.map((stop, index) => {
      const first = index === 0;
      const last = index === stops.length - 1;
      const stopover = first ? "始发站"
        : last ? "终到站"
          : stop.stopoverDisplay || (stop.stopoverMinutes == null ? "—" : `${stop.stopoverMinutes}分钟`);
      const rowClass = first ? "rail-stop-origin" : last ? "rail-stop-destination" : "";
      return `<tr class="${rowClass}">
        <td>${esc(stop.stationNo || "—")}</td>
        <td>${esc(stop.stationName)}</td>
        <td>${esc(stop.arriveTime)}</td>
        <td>${esc(stop.departTime)}</td>
        <td>${esc(stopover)}</td>
      </tr>`;
    }).join("");
    return `<details class="stops-toggle">
      <summary class="hint">完整经停时刻表（${stops.length} 站）</summary>
      <div class="rail-timetable-scroll">
        <table class="rail-stop-table">
          <thead><tr><th>站次</th><th>车站</th><th>到站</th><th>发车</th><th>停留</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </details>`;
  }

  async function loadRailTimetable(train, date, { forceRefresh = false } = {}) {
    const key = `${date}|${train.trainNo}`;
    if (!forceRefresh && dlg.railTimetableCache.has(key)) return dlg.railTimetableCache.get(key);
    if (dlg.railTimetableRequests.has(key)) return dlg.railTimetableRequests.get(key);
    const request = (async () => {
      const storageKey = `${railTimetableStoragePrefix}${encodeURIComponent(key)}`;
      const requestFresh = async () => {
        let raw;
        try {
          raw = localStorage.getItem(storageKey);
        } catch (error) {
          throw new Error(`无法读取已缓存的国铁时刻表：${error.message}`);
        }
        if (raw && !forceRefresh) {
          let cached;
          try {
            cached = JSON.parse(raw);
          } catch {
            throw new Error("已缓存的国铁时刻表 JSON 损坏，请清除本站缓存后重试");
          }
          if (!cached || typeof cached.fetchedAt !== "string" || !cached.payload) {
            throw new Error("已缓存的国铁时刻表格式无效，请清除本站缓存后重试");
          }
          return {
            timetable: normalizeRailTimetable(cached.payload, train, date),
            fetchedAt: cached.fetchedAt,
          };
        }
        const payload = await fetchRailJson("trainTimeTable", { train: train.trainNo, date });
        const result = { timetable: normalizeRailTimetable(payload, train, date), fetchedAt: new Date().toISOString() };
        try {
          localStorage.setItem(storageKey, JSON.stringify({ payload, fetchedAt: result.fetchedAt }));
        } catch {
          // 缓存写入失败不影响本次使用：完整时刻表仍会写入行程与导出的 JSON
        }
        return result;
      };
      const result = navigator.locks?.request
        ? await navigator.locks.request(`${railTimetableStoragePrefix}${key}`, requestFresh)
        : await requestFresh();
      dlg.railTimetableCache.set(key, result);
      return result;
    })();
    dlg.railTimetableRequests.set(key, request);
    try {
      return await request;
    } finally {
      dlg.railTimetableRequests.delete(key);
    }
  }

  function isRailStep(step) {
    return step?.type === "national_rail" || step?.rail_timetable;
  }

  function isMoreThanOneMonthOld(value, now = new Date()) {
    const timestamp = Date.parse(value || "");
    if (!Number.isFinite(timestamp)) return true;
    const fetched = new Date(timestamp);
    const day = fetched.getDate();
    fetched.setDate(1);
    fetched.setMonth(fetched.getMonth() + 1);
    const lastDay = new Date(fetched.getFullYear(), fetched.getMonth() + 1, 0).getDate();
    fetched.setDate(Math.min(day, lastDay));
    return fetched.getTime() <= now.getTime();
  }

  function importedRailDate(step, tripDate) {
    const extraDate = (step.extras || []).find((field) => field.label === "乘车日期")?.value;
    const date = step.rail_timetable?.date || extraDate || tripDate || "";
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
  }

  async function refreshImportedRailStep(step, tripDate) {
    const trainNo = step.train_no || step.line_name || step.timetable?.[0]?.[0] || "";
    const date = importedRailDate(step, tripDate);
    const fromTime = step.start_time || step.timetable?.[0]?.[1] || "";
    const toTime = step.end_time || step.timetable?.[0]?.[2] || "";
    let durationMinutes = Number(step.run_minutes);
    if (!Number.isFinite(durationMinutes) && railTimeMinutes(fromTime) != null && railTimeMinutes(toTime) != null) {
      durationMinutes = (railTimeMinutes(toTime) - railTimeMinutes(fromTime) + 24 * 60) % (24 * 60);
    }
    if (!trainNo || !date || !validRailTime(fromTime) || !validRailTime(toTime)
      || !Number.isFinite(durationMinutes)) {
      throw new Error(`车次 ${trainNo || "（未知）"} 缺少可用于更新的日期、乘降时刻或运行时长`);
    }
    const train = { trainNo, date, fromTime, toTime, durationMinutes };
    const result = await loadRailTimetable(train, date, { forceRefresh: true });
    const leg = matchRailTimetableLeg(train, result.timetable);
    if (!leg) throw new Error(`车次 ${trainNo} 的经停时刻无法唯一匹配原乘降区间`);
    return {
      ...step,
      from_station: leg.stops[0].stationName,
      to_station: leg.stops[leg.stops.length - 1].stationName,
      run_minutes: leg.duration,
      stops_text: leg.stops.map((stop) => stop.stationName).join("、"),
      rail_timetable: result.timetable,
      rail_timetable_fetched_at: result.fetchedAt,
    };
  }

  /** 导入时若国铁数据超过一个月（或没有更新时间），询问是否重新查询；失败时保留原数据。 */
  async function updateStaleImportedRailData(tripData, exportedAt) {
    const staleIndexes = tripData.steps
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => isRailStep(step)
        && isMoreThanOneMonthOld(step.rail_timetable_fetched_at || exportedAt));
    if (!staleIndexes.length) return { asked: false, updated: 0, failed: [] };
    const yes = confirm(
      `该文件中的 ${staleIndexes.length} 段国铁行程数据已超过一个月或没有更新时间。是否现在重新查询并更新完整经停时刻表？\n选择“取消”将保留文件中的原数据。`,
    );
    if (!yes) return { asked: true, updated: 0, failed: [] };

    const updatedSteps = [...tripData.steps];
    const failed = [];
    for (const { step, index } of staleIndexes) {
      try {
        updatedSteps[index] = await refreshImportedRailStep(step, tripData.date);
      } catch (error) {
        failed.push(`第 ${index + 1} 段：${error.message}`);
      }
    }
    tripData.steps = updatedSteps;
    return { asked: true, updated: staleIndexes.length - failed.length, failed };
  }

  async function queryRailTrains() {
    const from = $("rail-from").value.trim();
    const to = $("rail-to").value.trim();
    const date = $("rail-date").value;
    const status = $("rail-query-status");
    if (!from || !to) {
      status.className = "err";
      status.textContent = "请填写国铁起点站和终点站。";
      return;
    }
    if (from === to) {
      status.className = "err";
      status.textContent = "起点站和终点站不能相同。";
      return;
    }

    resetRailQuery();
    const requestId = dlg.railQuerySeq;
    const button = $("btn-rail-query");
    button.disabled = true;
    button.textContent = "查询中…";
    status.className = "hint";
    status.textContent = "正在查询车次…";

    try {
      const payload = await fetchRailJson("getTrains", date ? { from, to, date } : { from, to });
      if (!payload || payload.success !== true || !Array.isArray(payload.trains)) {
        throw new Error(payload?.message || payload?.error || "接口未能完成车次查询");
      }
      const trains = payload.trains.map((train) => {
        if (!train || typeof train !== "object"
          || typeof train.trainNo !== "string" || !train.trainNo
          || typeof train.fromStation !== "string" || !train.fromStation
          || typeof train.toStation !== "string" || !train.toStation
          || typeof train.fromTime !== "string" || !validRailTime(train.fromTime)
          || typeof train.toTime !== "string" || !validRailTime(train.toTime)
          || typeof train.duration !== "string") {
          throw new Error("接口返回的车次信息格式不完整");
        }
        return {
          trainNo: train.trainNo,
          fromStation: train.fromStation,
          toStation: train.toStation,
          toStationName: railArrivalStation(train, to),
          date: payload.date || date || localDateValue(),
          fromTime: train.fromTime,
          toTime: train.toTime,
          duration: train.duration,
          durationMinutes: parseRailDuration(train.duration),
        };
      });
      if (requestId !== dlg.railQuerySeq || dlg.mode !== "rail" || !$("step-dialog").open) return;
      dlg.railTrains = trains;
      $("rail-query-results").hidden = false;
      $("rail-query-results").innerHTML = trains.length
        ? trains.map((train, index) => `
          <article class="rail-train">
            <div class="rail-train-overview">
              <div class="rail-train-main">
                <strong>${esc(train.trainNo)}</strong>
                <span>查询区间：${esc(from)} → ${esc(to)} · ${esc(train.fromTime)}–${esc(train.toTime)}</span>
                <span class="hint">选中车次后，点击「确认并加入」时才读取经停站</span>
              </div>
              <div class="rail-train-actions">
                <button type="button" class="ghost" data-rail-train="${index}">预填此车次</button>
              </div>
            </div>
          </article>`).join("")
        : '<p class="hint">该日期未查询到车次。</p>';
      status.textContent = `查询日期：${payload.date || date || "接口未提供"} · 共 ${trains.length} 趟`;
    } catch (error) {
      if (requestId !== dlg.railQuerySeq || dlg.mode !== "rail" || !$("step-dialog").open) return;
      status.className = "err";
      status.textContent = `车次查询失败：${error.message}`;
      $("rail-query-results").hidden = true;
      $("rail-query-results").innerHTML = "";
      dlg.railTrains = [];
    } finally {
      if (requestId === dlg.railQuerySeq) {
        button.disabled = false;
        button.textContent = "查询车次";
      }
    }
  }

  async function openStepDialog(index, { prefillFrom = currentStation() } = {}) {
    dlg.index = index;
    dlg.lineId = "";
    dlg.line = null;
    dlg.prefillFrom = index == null ? (prefillFrom || "") : "";
    const step = index == null ? null : state.trip.steps[index];
    $("dlg-title").textContent = index == null ? "添加行程" : `编辑第 ${index + 1} 段行程`;
    $("dlg-subtitle").textContent = state.cityInfo ? state.cityInfo.name : "纯手动模式";
    $("dlg-foot-hint").textContent = state.city
      ? "先选起点站与到达站，方向会自动判定"
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
    $("service-field").hidden = true;
    $("line-service").innerHTML = "";
    $("service-hint").textContent = "";
    dlg.service = "";
    $("db-run").textContent = "选择起点与到达站后自动计算";
    $("m-line-name").value = "";
    $("m-direction").value = "";
    $("m-from").value = dlg.prefillFrom;
    $("m-to").value = "";
    $("m-run").value = "";
    $("m-stops").value = "";
    $("m-headway").value = "";
    $("m-color").value = "#2f6feb";
    $("m-color2").value = "#ffffff";
    $("m-color2").disabled = true;
    $("m-color2-on").checked = false;
    $("rail-from").value = dlg.prefillFrom;
    $("rail-to").value = "";
    $("rail-date").value = state.trip.date || localDateValue();
    resetRailQuery();
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
       ${esc(line.name)}${line.system ? ` · ${esc(line.system)}` : ""} · ${esc(line.typeLabel)} · ${esc(line.headwayText)}`;
    fillServiceSelect(line, step ? step.service || "" : "");
    fillStationSelects(step);
    $("direction").innerHTML = line.directions.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join("");
    if (step && line.directions.includes(step.direction_label)) {
      $("direction").value = step.direction_label;
    }
    await refreshToStations(step ? step.to_station : "");
    if (step) await refreshRunHint();       // 编辑：保留原方向
    else await autoPickDirection();         // 新增：按默认起终点直接给出方向
  }

  /** 起终点候选：有快车服务时只列该服务停靠的车站。 */
  function fillStationSelects(step) {
    const line = dlg.line;
    if (!line) return;
    const stops = dialogService()
      ? (lineServices(line).find((s) => s.id === dialogService())?.stops || [])
      : line.stations;
    $("from-station").innerHTML = stops.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
    const preferredFrom = step ? step.from_station : dlg.prefillFrom;
    if (preferredFrom && stops.includes(preferredFrom)) $("from-station").value = preferredFrom;
  }

  /** 到达站候选只取决于线路、车种与起点站（不限方向）；方向在选好起终点后自动判定。 */
  async function refreshToStations(prefer = "") {
    if (!dlg.line) return;
    const res = TP.reachableAny(dlg.line.id, $("from-station").value, dialogService());
    if (!res.ok) {
      $("to-station").innerHTML = "";
      $("db-run").textContent = res.error;
      return;
    }
    $("to-station").innerHTML = res.stations.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
    if (prefer && res.stations.includes(prefer)) $("to-station").value = prefer;
  }

  /** 按起点站 / 到达站自动判定乘车方向（多解时取线路方向表里第一个可行方向，如环线）。 */
  async function autoPickDirection() {
    if (!dlg.line) return;
    const from = $("from-station").value;
    const to = $("to-station").value;
    if (from && to && from !== to) {
      const res = TP.pickDirection(dlg.line.id, from, to, dialogService());
      if (res.ok && res.direction) $("direction").value = res.direction;
    }
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
        manual: false, type: dlg.line.type, line_name: dlg.line.name, service: dialogService(),
      }],
    });
    if (res.ok && res.segments.length) {
      const seg = res.segments[0];
      const serviceTag = seg.serviceName ? ` · ${seg.serviceName}` : "";
      $("db-run").textContent = `${fmtMin(seg.run)} · ${seg.stopCount} 站${serviceTag} · ${seg.headway}`;
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
      .map((ln) => `<option value="${esc(ln.id)}">${esc(ln.name)}${ln.system ? ` · ${esc(ln.system)}` : ""} · ${esc(ln.typeLabel)} · ${esc(ln.headwayText)}</option>`)
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
    // 起点变了：到达站候选随之刷新（尽量保留原到达站），再按起终点自动判定方向
    await refreshToStations($("to-station").value);
    await autoPickDirection();
  });
  $("line-service").addEventListener("change", async () => {
    if (!dlg.line) return;
    // 车种变化：停靠站不同，起终点候选整体刷新
    dlg.service = $("line-service").value;
    updateServiceHint();
    fillStationSelects(null);
    await refreshToStations("");
    await autoPickDirection();
  });
  $("to-station").addEventListener("change", () => autoPickDirection());
  $("direction").addEventListener("change", () => refreshRunHint());

  $("mode-db").addEventListener("change", () => setMode("db"));
  $("mode-rail").addEventListener("change", () => setMode("rail"));
  $("mode-manual").addEventListener("change", () => setMode("manual"));
  $("btn-rail-query").addEventListener("click", queryRailTrains);
  $("btn-rail-swap").addEventListener("click", () => {
    const from = $("rail-from").value;
    $("rail-from").value = $("rail-to").value;
    $("rail-to").value = from;
    resetRailQuery();
  });
  ["rail-from", "rail-to", "rail-date"].forEach((id) => {
    $(id).addEventListener("input", resetRailQuery);
    $(id).addEventListener("change", resetRailQuery);
  });
  function selectRailTrain(train, card) {
    dlg.railTrain = train;
    $("rail-query-results").querySelectorAll(".rail-train").forEach((row) => {
      const selected = row === card;
      row.classList.toggle("selected", selected);
      row.querySelector("[data-rail-train]").textContent = selected ? "已预填" : "预填此车次";
    });
    const from = train.fromStationName || $("rail-from").value.trim();
    $("rail-selected").hidden = false;
    $("rail-selected").className = "rail-selected";
    $("rail-selected").textContent = `${train.trainNo} 已预填：${from} ${train.fromTime} → ${train.toStationName} ${train.toTime}，运行 ${train.duration}。确认后点击「确认并加入」，届时才会读取并保存完整经停时刻表。`;
    $("btn-dlg-save").textContent = "确认并加入";
    setDialogError("");
  }

  $("rail-query-results").addEventListener("click", (ev) => {
    const button = ev.target.closest("[data-rail-train]");
    if (!button) return;
    const index = Number(button.dataset.railTrain);
    const train = dlg.railTrains[index];
    if (!train) return;
    selectRailTrain(train, button.closest(".rail-train"));
  });
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

  // 数据提示弹窗
  $("btn-notice-ok").addEventListener("click", () => $("notice-dialog").close());
  $("btn-notice-close").addEventListener("click", () => $("notice-dialog").close());

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
        service: dialogService(),
      };
    } else if (dlg.mode === "rail") {
      const train = dlg.railTrain;
      if (!train) { setDialogError("请先查询并选择一趟国铁车次"); return; }
      if (dlg.railConfirming) return;
      dlg.railConfirming = true;
      const saveButton = $("btn-dlg-save");
      saveButton.disabled = true;
      saveButton.textContent = "读取并核验经停…";
      try {
        const result = await loadRailTimetable(train, train.date);
        const leg = matchRailTimetableLeg(train, result.timetable);
        if (!leg) throw new Error("无法根据车次与时刻唯一核验该乘降区间，未加入行程");
        train.timetable = result.timetable;
        train.timetableFetchedAt = result.fetchedAt;
        train.leg = leg;
        train.fromStationName = leg.stops[0].stationName;
        train.toStationName = leg.stops[leg.stops.length - 1].stationName;
      } catch (error) {
        setDialogError(`获取并核验国铁经停失败：${error.message}`);
        return;
      } finally {
        dlg.railConfirming = false;
        saveButton.disabled = false;
        saveButton.textContent = "确认并加入";
      }
      const from = train.fromStationName;
      const to = train.toStationName;
      if (!from || !to || from === to) { setDialogError("请填写不同的国铁起点站和终点站"); return; }
      step = {
        line_id: "",
        direction_label: `${to}方向`,
        from_station: from,
        to_station: to,
        walk_minutes: walkMinutes,
        manual: true,
        type: "national_rail",
        line_name: train.trainNo,
        run_minutes: train.durationMinutes,
        stops_text: train.leg.stops.map((stop) => stop.stationName).join("、"),
        color: "#333333",
        color2: "",
        note,
        headway_text: "按车次时刻",
        timetable: [[train.trainNo, train.fromTime, train.toTime]],
        use_timetable: false,
        price,
        transfer: prev ? prev.transfer : null,
        train_no: train.trainNo,
        start_time: train.fromTime,
        end_time: train.toTime,
        extras: train.date ? [{ label: "乘车日期", value: train.date }] : [],
        rail_timetable: train.timetable,
        rail_timetable_fetched_at: train.timetableFetchedAt,
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

  function printPlan() {
    if (!state.result || !state.result.segments.length) {
      setStatus("还没有可导出的行程", true);
      return;
    }
    $("print-view").innerHTML = buildPrintSheet();
    $("print-view").hidden = false;

    // 打印 / 另存为 PDF 时浏览器用 <title> 作默认文件名 → 临时换成方案名，打完再还原
    const savedTitle = document.title;
    document.title = printFileTitle();
    window.addEventListener("afterprint", () => {
      $("print-view").hidden = true;
      document.title = savedTitle;
    }, { once: true });

    window.print();
  }

  /** 另存为 PDF 时的默认文件名（不含扩展名）：方案名，剔除文件名非法字符。 */
  function printFileTitle() {
    const name = (state.trip.name || "我的运转方案").replace(/[\\/:*?"<>|]/g, "_").trim();
    return name || "我的运转方案";
  }

  /** 含时刻表或国铁车次的段落，导出时强调时长。 */
  function stepHasTimetable(step) {
    const type = String(step?.type || "");
    return type === "national_rail"
      || type.includes("国铁")
      || Boolean(step?.use_timetable)
      || (step?.timetable || []).length > 0;
  }

  function buildPrintSheet() {
    const trip = state.trip;
    const res = state.result;
    const t = res.totals;
    const tl = res.segments.map((s, i) => {
      const walk = i > 0 && s.walk > 0 ? `<div style="flex:${s.walk};background:#e3e7ee"></div>` : "";
      return `${walk}<div style="flex:${Math.max(s.run, 0.01)};background:${swatchV(s.color, s.color2)}"></div>`;
    }).join("");

    const segs = res.segments.map((s, i) => {
      const step = trip.steps[i] || {};
      const emphasizeDuration = stepHasTimetable(step);
      const tt = (s.timetable || []).length
        ? `<table><thead><tr><th>车次</th><th>发时</th><th>到时</th></tr></thead><tbody>${
            s.timetable.map((r) => `<tr><td>${esc(r[0] || "")}</td><td>${esc(r[1] || "")}</td><td>${esc(r[2] || "")}</td></tr>`).join("")
          }</tbody></table>`
        : "";
      return `
        <div class="seg">
          <div class="ribbon" style="background:${swatch(s.color, s.color2)}"></div>
          <div class="hd">${i + 1}. ${esc(s.lineName)}（${esc(s.typeLabel)}）${s.serviceName ? ` · ${esc(s.serviceName)}` : ""}${s.transfer ? " · 跨系统转乘" : ""}</div>
          <div class="ln">${esc(s.from)} → ${esc(s.direction)} → ${esc(s.to)}
            · 运行 <b class="${emphasizeDuration ? "duration-emphasis" : ""}">${fmtMin(s.run)}</b>${s.walk > 0 ? ` · 上车前步行 ${fmtMin(s.walk)}` : ""} · ${s.stopCount} 站
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
    const hasConfirmedTimetable = trip.steps.some((step) => stepHasTimetable(step));

    return `
      <div class="sheet">
        <h1>${esc(trip.name || "我的运转方案")}</h1>
        <div class="sub">${state.cityInfo ? `${esc(state.cityInfo.name)} · ` : ""}${esc(trip.date || "")}
          · 生成于 ${new Date().toLocaleString("zh-CN")}${trip.paid_zone_mode ? " · 付费区模式" : ""}</div>
        <div class="sum">
          <span>总时长 <b class="${hasConfirmedTimetable ? "duration-emphasis" : ""}">${fmtMin(t.minutes)}</b></span>
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

  window.addEventListener("pagehide", flushDraft);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushDraft();
  });

  boot();
})();
