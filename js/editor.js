/* 运转计划助手 · 线路数据工坊
 *
 * 纯前端编辑器：所有校验委托 Python 内核（TP.validateCity），本文件只负责
 * 状态、线路图渲染与交互。提交审核与导出 JSON 分别走 DataApi / 本地下载。
 */
(() => {
  "use strict";

  // ---------------- 小工具 ----------------

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const safeColor = (c) => (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(c || "")) ? c : "#888888");
  const toNumber = (v) => (v === "" || v === null || v === undefined ? NaN : Number(v));
  const palette = ["#2f6feb", "#e23b3b", "#1f8a4c", "#f0a020", "#8b4bd8", "#0c9aa5", "#d4478b", "#5b6472"];

  const DRAFT_PREFIX = "transit-planner-web.draft.";
  const LAST_CITY_KEY = "transit-planner-web.editor-city";
  const CONTACT_KEY = "transit-planner-web.editor-contact";

  function fmtMinute(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return "—";
    return Number.isInteger(n) ? `${n}′` : `${n.toFixed(1)}′`;
  }

  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  function downloadJson(name, text) {
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${String(name || "city").replace(/[\\/:*?"<>|]/g, "_")}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------------- 状态 ----------------

  const state = {
    info: null,
    types: {},
    typeKeys: [],
    cities: [],
    extraCities: [],
    stems: [],
    published: {},
    backend: false,
    cityName: "",
    doc: null,
    baseDoc: null,
    origin: "",
    dirty: false,
    submitted: false,
    existsBuiltin: false,
    selectedLineId: "",
    stationIndex: -1,
    segmentIndex: -1,
    view: "map",
    validating: false,
    validation: null,
    mapMetrics: null,
  };

  const selectedLine = () => (state.doc?.lines || []).find((line) => line.id === state.selectedLineId) || null;
  const typeLabel = (key) => state.types[key] || key || "未分类";
  const citiesForSelect = () => [...new Set([...state.stems, ...Object.keys(state.published), ...state.extraCities])];
  function addCity(name) {
    if (!name || citiesForSelect().includes(name)) return;
    state.extraCities.push(name);
  }

  // ---------------- 启动 ----------------

  async function boot() {
    try {
      const info = await TP.boot((msg, ratio) => {
        $("boot-msg").textContent = msg;
        $("boot-bar").style.width = `${Math.round(ratio * 100)}%`;
      });
      state.info = info;
      state.types = info.typeLabels || {};
      state.typeKeys = Object.keys(state.types);
      state.published = TP.published || {};
      state.stems = (TP.manifest?.dataFiles || []).map((file) => file.replace(/\.json$/i, ""));
      state.cities = citiesForSelect();

      fillCitySelect();
      fillNewCitySources();
      bindEvents();

      const health = await DataApi.health();
      state.backend = Boolean(health.ok);

      const wantedRaw = new URLSearchParams(location.search).get("city") || readLastCity() || state.cities[0] || "";
      const wanted = state.info?.cityFiles?.[wantedRaw] || wantedRaw;
      let city = state.cities.includes(wanted) ? wanted : "";
      if (!city && wanted && readDraft(wanted)) {
        addCity(wanted);
        fillCitySelect();
        city = wanted;
      }
      if (!city) city = state.cities[0] || "";
      if (city) await loadCity(city);
      else renderAll();

      $("boot").hidden = true;
      $("editor").hidden = false;
    } catch (err) {
      document.body.classList.add("err");
      $("boot").classList.add("error");
      $("boot-msg").textContent = `启动失败：${err.message}。请确认网络可访问 cdn.jsdelivr.net（Pyodide 运行时），并通过 http(s) 访问本页面。`;
    }
  }

  function fillCitySelect() {
    state.cities = citiesForSelect();
    $("city-select").innerHTML = state.cities.map((name) => {
      const tags = [];
      if (state.published[name]) tags.push("已审核");
      if (!state.stems.includes(name)) tags.push("社区新建");
      return `<option value="${esc(name)}">${esc(name)}${tags.length ? `（${tags.join(" · ")}）` : ""}</option>`;
    }).join("");
    if (state.cityName) $("city-select").value = state.cityName;
    fillNewCitySources();
  }

  function fillNewCitySources() {
    const sel = $("new-city-source");
    if (!sel) return;
    const sources = [...new Set([...state.stems, ...Object.keys(state.published)])];
    sel.innerHTML = ['<option value="">空白（含 1 条示例线路）</option>']
      .concat(sources.map((name) => `<option value="${esc(name)}">复制：${esc(name)}</option>`))
      .join("");
  }

  function readLastCity() {
    try { return localStorage.getItem(LAST_CITY_KEY) || ""; } catch { return ""; }
  }

  function rememberCity(name) {
    try { localStorage.setItem(LAST_CITY_KEY, name); } catch { /* 隐私模式下忽略 */ }
  }

  // ---------------- 数据加载 / 规范化 ----------------

  function normalizeLine(raw) {
    const line = raw && typeof raw === "object" ? raw : {};
    return {
      ...line,
      id: String(line.id ?? ""),
      name: String(line.name ?? ""),
      short_name: String(line.short_name ?? ""),
      type: String(line.type || "metro"),
      color: String(line.color || "#888888"),
      color2: String(line.color2 || ""),
      operator: String(line.operator || ""),
      stations: Array.isArray(line.stations) ? line.stations.map((s) => String(s ?? "")) : [],
      travel_minutes: Array.isArray(line.travel_minutes) ? line.travel_minutes.map((v) => toNumber(v)) : [],
      headway_rush: Number.isFinite(Number(line.headway_rush)) ? Number(line.headway_rush) : 10,
      headway_normal: Number.isFinite(Number(line.headway_normal)) ? Number(line.headway_normal) : 15,
      first_train: String(line.first_train ?? ""),
      last_train: String(line.last_train ?? ""),
      ring: Boolean(line.ring),
      directions: Array.isArray(line.directions)
        ? line.directions.map((d) => ({
          ...d,
          label: String(d?.label ?? ""),
          terminal: d?.terminal ?? null,
          reverse: Boolean(d?.reverse),
        }))
        : [],
    };
  }

  function normalizeDoc(raw, fallbackName) {
    const doc = raw && typeof raw === "object" ? raw : {};
    const groups = (list) => (Array.isArray(list) ? list.map((g) => (Array.isArray(g) ? g.map(String) : [])).filter((g) => g.length) : []);
    return {
      ...doc,
      city: String(doc.city || fallbackName || "未命名"),
      region: String(doc.region || ""),
      version: String(doc.version || "1.0"),
      lines: Array.isArray(doc.lines) ? doc.lines.map(normalizeLine) : [],
      external_walks: doc.external_walks && typeof doc.external_walks === "object" && !Array.isArray(doc.external_walks)
        ? { ...doc.external_walks }
        : {},
      transfers: groups(doc.transfers),
      aliases: groups(doc.aliases),
    };
  }

  async function loadCity(name) {
    if (!name) return;
    const res = TP.cityJson(name);
    let doc = null;
    let origin = state.published[name] ? "override" : "builtin";
    let restoredFromDraft = false;
    if (res.ok) {
      doc = normalizeDoc(res.city, name);
    } else {
      // 尚未提交的新城市没有数据文件，只能从本地草稿恢复
      const draft = readDraft(name);
      if (!draft?.doc) {
        toast(res.error || `无法读取「${name}」`);
        $("city-select").value = state.cityName;
        return;
      }
      doc = normalizeDoc(draft.doc, name);
      origin = "draft";
      restoredFromDraft = true;
    }
    state.cityName = name;
    state.doc = doc;
    state.baseDoc = res.ok ? clone(doc) : null;
    state.origin = origin;
    state.existsBuiltin = state.stems.includes(name);
    state.dirty = restoredFromDraft;
    state.submitted = false;
    state.validation = null;
    state.selectedLineId = doc.lines[0]?.id || "";
    state.stationIndex = -1;
    state.segmentIndex = -1;
    $("city-select").value = name;
    rememberCity(name);
    history.replaceState(null, "", `?city=${encodeURIComponent(name)}`);

    renderAll();
    if (!restoredFromDraft) offerDraft(name);
    if (!state.backend && $("banner").hidden) {
      showBanner("在线审核未启用：当前是纯静态环境，仍可编辑并「导出 JSON」；部署到 Netlify 后即可匿名提交审核。", [], "info");
    }
    scheduleValidate();
  }

  // ---------------- 本地草稿 ----------------

  const draftKey = (name) => `${DRAFT_PREFIX}${name}`;

  function readDraft(name) {
    try { return JSON.parse(localStorage.getItem(draftKey(name)) || "null"); } catch { return null; }
  }

  function clearDraft(name) {
    try { localStorage.removeItem(draftKey(name)); } catch { /* 忽略 */ }
  }

  function persistDraft() {
    if (!state.doc) return;
    try {
      localStorage.setItem(draftKey(state.cityName), JSON.stringify({ savedAt: Date.now(), doc: state.doc }));
    } catch { /* 容量不足时忽略 */ }
  }

  const persistDraftSoon = debounce(persistDraft, 500);

  function offerDraft(name) {
    const draft = readDraft(name);
    if (!draft?.doc) return;
    if (JSON.stringify(draft.doc) === JSON.stringify(state.doc)) {
      clearDraft(name);
      return;
    }
    const when = new Date(draft.savedAt || Date.now()).toLocaleString("zh-CN");
    showBanner(`发现本浏览器在 ${when} 保存、尚未提交的草稿。`, [
      {
        label: "恢复草稿",
        cls: "primary",
        onClick: () => {
          state.doc = normalizeDoc(draft.doc, name);
          state.origin = "draft";
          state.dirty = true;
          state.selectedLineId = state.doc.lines.some((line) => line.id === state.selectedLineId)
            ? state.selectedLineId
            : state.doc.lines[0]?.id || "";
          state.stationIndex = -1;
          state.segmentIndex = -1;
          clearBanner();
          renderAll();
          scheduleValidate();
          toast("已恢复本地草稿");
        },
      },
      {
        label: "丢弃草稿",
        onClick: () => {
          clearDraft(name);
          clearBanner();
          toast("已丢弃本地草稿");
        },
      },
    ]);
  }

  // ---------------- 提示条 ----------------

  function showBanner(text, actions = [], kind = "") {
    const box = $("banner");
    box.className = `ed-banner${kind ? ` ${kind}` : ""}`;
    box.innerHTML = `<span class="msg">${esc(text)}</span><div class="spacer"></div>${actions.map((action, i) => (
      action.href
        ? `<a class="ed-banner-link" href="${esc(action.href)}">${esc(action.label)}</a>`
        : `<button type="button" class="${action.cls || ""}" data-banner-action="${i}">${esc(action.label)}</button>`
    )).join("")}`;
    box.hidden = false;
    box.querySelectorAll("[data-banner-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = actions[Number(btn.dataset.bannerAction)];
        if (action?.onClick) action.onClick();
      });
    });
  }

  function clearBanner() {
    $("banner").hidden = true;
    $("banner").innerHTML = "";
  }

  // ---------------- 渲染：总览 ----------------

  function renderAll() {
    renderState();
    renderLineList();
    renderWorkspace();
    renderCityMeta();
    renderGroupMeta();
    renderWalkMeta();
    renderValidation();
  }

  function renderState() {
    const el = $("ed-state");
    if (!state.doc) {
      el.textContent = "—";
      el.className = "ed-state";
      return;
    }
    if (state.dirty) {
      el.textContent = "● 有未提交修改";
      el.className = "ed-state dirty";
    } else if (state.submitted) {
      el.textContent = "✓ 已提交，等待审核";
      el.className = "ed-state submitted";
    } else {
      el.textContent = state.published[state.cityName] ? "已同步社区审核版" : "已同步内置数据";
      el.className = "ed-state";
    }
  }

  function originLabel() {
    const published = state.published[state.cityName];
    if (state.origin === "draft") return "本地草稿（尚未提交）";
    if (state.origin === "new") return "新建城市（尚未提交）";
    if (state.origin === "upload") return "上传的 JSON（尚未提交）";
    if (published) return `社区审核版 · ${published.updatedAt ? new Date(published.updatedAt).toLocaleString("zh-CN") : "已通过"}`;
    return "内置数据";
  }

  function miniMap(line) {
    const stations = line.stations || [];
    const shown = stations.slice(0, 14);
    const count = Math.max(shown.length, 2);
    const width = 58;
    const height = 14;
    const pad = 3;
    const gap = (width - pad * 2) / (count - 1);
    const color = safeColor(line.color);
    const dots = shown.map((_, i) => `<circle cx="${(pad + i * gap).toFixed(1)}" cy="7" r="1.8" fill="#fff" stroke="${color}" stroke-width="1.2"/>`).join("");
    return `<svg class="mini" viewBox="0 0 ${width} ${height}" aria-hidden="true"><line x1="${pad}" y1="7" x2="${width - pad}" y2="7" stroke="${color}" stroke-width="3" stroke-linecap="round"/>${dots}</svg>`;
  }

  function renderLineList() {
    const lines = state.doc?.lines || [];
    $("line-count").textContent = `${lines.length} 条`;
    if (!lines.length) {
      $("line-list").innerHTML = `<p class="hint" style="padding:10px">还没有线路，点击右上角「＋」新增。</p>`;
      return;
    }
    $("line-list").innerHTML = lines.map((line) => `
      <div class="ed-line-item${line.id === state.selectedLineId ? " active" : ""}" data-id="${esc(line.id)}" role="button" tabindex="0" aria-label="${esc(line.name || "未命名线路")}">
        <span class="ed-line-mini">${miniMap(line)}</span>
        <span class="ed-line-info">
          <span class="ed-line-name">${esc(line.name || "未命名线路")}</span>
          <span class="ed-line-sub">${esc(typeLabel(line.type))} · ${line.stations.length} 站${line.ring ? " · 环线" : ""}</span>
        </span>
        <span class="ed-line-ops">
          <button type="button" class="ghost" data-move="-1" title="上移">↑</button>
          <button type="button" class="ghost" data-move="1" title="下移">↓</button>
          <button type="button" class="ghost danger" data-del="1" title="删除线路">✕</button>
        </span>
      </div>`).join("");
  }

  function renderWorkspace() {
    const line = selectedLine();
    $("line-title").textContent = line ? `${line.name || "未命名线路"} · 线路图` : "线路图";
    renderMapToolbar();
    renderMap();
    renderStationEditor();
    renderProps();
  }

  function renderMapToolbar() {
    const line = selectedLine();
    const box = $("map-toolbar");
    if (!line) {
      box.innerHTML = `<span class="hint">${state.doc?.lines.length ? "从左侧选择一条线路" : "还没有线路，先新增一条"}</span>`;
      return;
    }
    const segments = Math.max(0, line.stations.length - 1);
    box.innerHTML = `
      <span class="line-chip"><i style="background:${line.color2 ? `linear-gradient(90deg, ${safeColor(line.color)} 0 50%, ${safeColor(line.color2)} 50% 100%)` : safeColor(line.color)}"></i>${esc(line.name || "未命名线路")}</span>
      <span class="hint">${esc(typeLabel(line.type))} · ${line.stations.length} 站 · ${segments} 段</span>
      <div class="spacer"></div>
      <button type="button" data-tool="add-station" title="在线路末端添加一个车站">＋ 末尾加站</button>
      <button type="button" data-tool="fill" title="为缺失的区间补上默认 3 分钟">补齐区间时长</button>
      <button type="button" data-tool="reverse" title="把站表与区间顺序整体倒过来">反向站表</button>
      <button type="button" data-tool="dirs" title="按当前站表重新生成两个方向">重建方向</button>`;
  }

  function interchangeSet(line) {
    const set = new Set();
    (state.doc?.lines || []).forEach((other) => {
      if (other.id === line.id) return;
      (other.stations || []).forEach((station) => set.add(station));
    });
    return set;
  }

  function renderMap() {
    const map = $("map");
    const line = selectedLine();
    state.mapMetrics = null;
    if (!line) {
      map.innerHTML = `<p class="empty">${state.doc?.lines.length ? "从左侧选择一条线路，开始编辑线路图。" : "还没有线路，点击左侧「＋」新增。"}</p>`;
      return;
    }
    const stations = line.stations || [];
    const n = stations.length;
    const gap = n > 30 ? 58 : n > 22 ? 70 : n > 14 ? 86 : n > 8 ? 104 : 124;
    const padL = 64;
    const padR = 104;
    const width = Math.max(padL + padR + Math.max(n - 1, 0) * gap, 560);
    const y = 124;
    const height = 272;
    const color = safeColor(line.color);
    const color2 = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(line.color2 || "") ? line.color2 : "";
    const interchanges = interchangeSet(line);
    const parts = [];

    parts.push(`<line id="drag-marker" x1="0" y1="${y - 48}" x2="0" y2="${y + 48}" class="drag-marker" style="opacity:0"/>`);

    const dirs = (line.directions || []).map((d) => d.label).filter(Boolean);
    parts.push(`<text x="${padL}" y="34" class="dir-text">${esc(dirs.join("  /  ") || "（尚未生成方向）")}</text>`);

    if (n >= 2) {
      const x0 = padL;
      const x1 = padL + (n - 1) * gap;
      if (color2) {
        parts.push(`<rect x="${x0}" y="${y - 6}" width="${x1 - x0}" height="6" rx="3" fill="${color}"/>`);
        parts.push(`<rect x="${x0}" y="${y}" width="${x1 - x0}" height="6" rx="3" fill="${color2}"/>`);
      } else {
        parts.push(`<rect x="${x0}" y="${y - 6}" width="${x1 - x0}" height="12" rx="6" fill="${color}"/>`);
      }
      parts.push(`<path d="M${x1 + 4} ${y} l11 -7 v14 z" fill="${color}"/>`);
    }

    for (let i = 0; i < n - 1; i += 1) {
      const xa = padL + i * gap;
      const xm = xa + gap / 2;
      const value = line.travel_minutes[i];
      parts.push(`<g class="seg-label" data-seg="${i}" role="button" tabindex="0" aria-label="第 ${i + 1} 段区间时长">
        <rect class="pill" x="${xm - 20}" y="${y - 44}" width="40" height="24" rx="12"/>
        <text class="seg-text" x="${xm}" y="${y - 27}">${esc(fmtMinute(value))}</text>
      </g>`);
      parts.push(`<g class="insert" data-insert="${i + 1}" role="button" tabindex="0" aria-label="在第 ${i + 2} 站前插入车站">
        <circle cx="${xm}" cy="${y}" r="10"/>
        <path class="plus" d="M${xm - 4.5} ${y} h9 M${xm} ${y - 4.5} v9"/>
      </g>`);
    }

    stations.forEach((name, i) => {
      const x = padL + i * gap;
      const isInterchange = interchanges.has(name);
      const r = isInterchange ? 10 : 7;
      const selected = i === state.stationIndex;
      const labelY = y + 30;
      parts.push(`<g class="station${selected ? " selected" : ""}${isInterchange ? " interchange" : ""}" data-station="${i}" role="button" tabindex="0" aria-label="${esc(name)}">
        ${selected ? `<circle class="halo" cx="${x}" cy="${y}" r="${r + 7}"/>` : ""}
        <circle class="node" cx="${x}" cy="${y}" r="${r}" style="stroke:${color}"/>
        <text class="st-name" x="${x}" y="${labelY}" transform="rotate(-38 ${x} ${labelY})">${esc(name)}</text>
      </g>`);
    });

    const appendX = padL + Math.max(n - 1, 0) * gap + (n ? gap * 0.9 : 0);
    parts.push(`<g class="append" data-insert="${n}" role="button" tabindex="0" aria-label="在末尾添加车站">
      <circle cx="${appendX}" cy="${y}" r="13"/>
      <path class="plus" d="M${appendX - 5} ${y} h10 M${appendX} ${y - 5} v10"/>
    </g>`);

    if (!n) {
      parts.push(`<text x="${padL}" y="${y + 54}" class="empty-text">这条线路还没有车站：点击右侧虚线「＋」添加第一站。</text>`);
    }

    map.innerHTML = `<svg class="ed-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(line.name || "线路")} 线路图">${parts.join("")}</svg>`;
    state.mapMetrics = { padL, gap, y, width };
  }

  function renderStationEditor() {
    const box = $("station-editor");
    const line = selectedLine();
    if (!line) {
      box.innerHTML = "";
      return;
    }

    if (state.segmentIndex >= 0 && state.segmentIndex < line.stations.length - 1) {
      const i = state.segmentIndex;
      const value = line.travel_minutes[i];
      box.innerHTML = `
        <div class="ed-station-card">
          <div class="ed-sc-head">
            <span class="ed-sc-badge">区间 ${i + 1}</span>
            <b>${esc(line.stations[i])} → ${esc(line.stations[i + 1])}</b>
            <div class="spacer"></div>
            <span class="hint">点线路上的时长胶囊即可编辑</span>
          </div>
          <div class="ed-sc-grid" style="grid-template-columns:minmax(120px,.5fr)">
            <div class="field"><span>运行时长（分钟）</span><input id="seg-minutes" type="number" min="0" step="0.5" value="${Number.isFinite(Number(value)) ? Number(value) : ""}"></div>
          </div>
          <div class="row">
            <button type="button" data-act="seg-insert">在区间中间插入车站</button>
            <div class="spacer"></div>
            <button type="button" data-act="seg-close">关闭</button>
          </div>
        </div>`;
      return;
    }

    if (state.stationIndex < 0 || state.stationIndex >= line.stations.length) {
      box.innerHTML = `<div class="ed-station-hint">点击线路图上的站点可编辑站名与相邻区间；拖动站点圆点可调整顺序。</div>`;
      return;
    }

    const i = state.stationIndex;
    const prev = i > 0 ? line.travel_minutes[i - 1] : null;
    const next = i < line.stations.length - 1 ? line.travel_minutes[i] : null;
    box.innerHTML = `
      <div class="ed-station-card">
        <div class="ed-sc-head">
          <span class="ed-sc-badge" style="background:${safeColor(line.color)}">第 ${i + 1} 站</span>
          <b id="st-head-name">${esc(line.stations[i] || "（空站名）")}</b>
          <div class="spacer"></div>
          <span class="hint">拖动圆点可排序</span>
        </div>
        <div class="ed-sc-grid">
          <div class="field"><span>站名</span><input id="st-name" type="text" value="${esc(line.stations[i] || "")}" placeholder="车站名称"></div>
          <div class="field"><span>上一段时长（分钟）</span><input id="st-prev" type="number" min="0" step="0.5" value="${Number.isFinite(Number(prev)) ? Number(prev) : ""}" ${i > 0 ? "" : "disabled"}></div>
          <div class="field"><span>下一段时长（分钟）</span><input id="st-next" type="number" min="0" step="0.5" value="${Number.isFinite(Number(next)) ? Number(next) : ""}" ${i < line.stations.length - 1 ? "" : "disabled"}></div>
        </div>
        <div class="row">
          <button type="button" data-act="insert-before">← 在前面插入</button>
          <button type="button" data-act="insert-after">在后面插入 →</button>
          <button type="button" data-act="left" ${i > 0 ? "" : "disabled"}>◀ 左移</button>
          <button type="button" data-act="right" ${i < line.stations.length - 1 ? "" : "disabled"}>右移 ▶</button>
          <div class="spacer"></div>
          <button type="button" class="danger" data-act="delete">删除本站</button>
        </div>
      </div>`;
  }

  function renderProps() {
    const box = $("view-props");
    const line = selectedLine();
    if (!line) {
      box.innerHTML = `<p class="hint">选择线路后可编辑属性。</p>`;
      return;
    }
    const types = [...new Set([...state.typeKeys, line.type].filter(Boolean))];
    box.innerHTML = `
      <div class="ed-props">
        <div class="grid2">
          <div class="field"><span>线路 ID（同一城市内唯一）</span><input data-field="id" type="text" value="${esc(line.id)}"></div>
          <div class="field"><span>线路名称</span><input data-field="name" type="text" value="${esc(line.name)}"></div>
          <div class="field"><span>简称</span><input data-field="short_name" type="text" value="${esc(line.short_name)}"></div>
          <div class="field"><span>交通类型</span><select data-field="type">${types.map((key) => `<option value="${esc(key)}" ${key === line.type ? "selected" : ""}>${esc(typeLabel(key))}</option>`).join("")}</select></div>
          <div class="field"><span>运营方</span><input data-field="operator" type="text" value="${esc(line.operator)}"></div>
          <div class="field"><span>标志色</span>
            <div class="row">
              <input type="color" data-field="color" value="${safeColor(line.color)}">
              <label class="check"><input type="checkbox" data-field="color2-on" ${line.color2 ? "checked" : ""}> 双色</label>
              <input type="color" data-field="color2" value="${safeColor(line.color2 || "#ffffff")}" ${line.color2 ? "" : "disabled"}>
            </div>
          </div>
          <div class="field"><span>高峰间隔（分钟，0 = 不定班）</span><input data-field="headway_rush" type="number" min="0" step="1" value="${esc(line.headway_rush)}"></div>
          <div class="field"><span>平峰间隔（分钟）</span><input data-field="headway_normal" type="number" min="0" step="1" value="${esc(line.headway_normal)}"></div>
          <div class="field"><span>首班车</span><input data-field="first_train" type="text" value="${esc(line.first_train)}" placeholder="06:30"></div>
          <div class="field"><span>末班车</span><input data-field="last_train" type="text" value="${esc(line.last_train)}" placeholder="23:00"></div>
          <div class="field"><span>环线</span><label class="check"><input type="checkbox" data-field="ring" ${line.ring ? "checked" : ""}> 首尾相接环形运行</label></div>
        </div>
        <div class="ed-dirs">
          <b>方向</b>
          <span class="hint">方向由站表自动生成；环线或自定义方向可在 JSON 模式中直接编辑。</span>
          <div class="chips">${(line.directions || []).map((d) => `<span class="chip">${esc(d.label || "—")}</span>`).join("") || "<span class='hint'>尚未生成</span>"}</div>
          <button type="button" id="btn-rebuild-dirs">按站表重建方向</button>
        </div>
      </div>`;
  }

  function renderCityMeta() {
    const doc = state.doc;
    if (!doc) {
      $("city-meta").innerHTML = "";
      return;
    }
    $("city-meta").innerHTML = `
      <div class="city-name">${esc(doc.city)}<small>城市名即数据文件名：${esc(doc.city)}.json</small></div>
      <div class="grid2">
        <div class="field"><span>地区</span><input data-city="region" type="text" value="${esc(doc.region)}" placeholder="如：华东"></div>
        <div class="field"><span>版本</span><input data-city="version" type="text" value="${esc(doc.version)}" placeholder="1.0"></div>
      </div>
      <div class="hint">数据来源：${esc(originLabel())}</div>`;
  }

  function splitNames(text) {
    return String(text || "").split(/[、,，;；|/]+/).map((s) => s.trim()).filter(Boolean);
  }

  function renderGroupMeta() {
    const doc = state.doc;
    if (!doc) {
      $("group-meta").innerHTML = "";
      return;
    }
    const block = (kind, label, hint) => {
      const groups = doc[kind] || [];
      return `<div class="ed-group-block">
        <div class="hint"><b>${label}</b>：${hint}</div>
        ${groups.map((group, i) => `<div class="ed-group-row">
          <input data-group="${kind}" data-index="${i}" type="text" value="${esc(group.join("、"))}" placeholder="站名1、站名2">
          <button type="button" data-del-group="${kind}" data-index="${i}" title="删除这一组">✕</button>
        </div>`).join("")}
        <button type="button" class="ed-add-btn" data-add-group="${kind}">＋ 添加${label}</button>
      </div>`;
    };
    $("group-meta").innerHTML = block("transfers", "转乘站组", "同地点、不同付费系统，换乘需出闸")
      + block("aliases", "同站异名", "同一车站、仅名称不同，不出闸");
  }

  function renderWalkMeta() {
    const doc = state.doc;
    if (!doc) {
      $("walk-meta").innerHTML = "";
      return;
    }
    const walks = Object.entries(doc.external_walks || {});
    $("walk-meta").innerHTML = `
      <div class="hint">键写成「站A|站B」，值为步行分钟；用于站外换乘估算。</div>
      ${walks.map(([key, value], i) => `<div class="ed-walk-row">
        <input data-walk-key data-index="${i}" type="text" value="${esc(key)}" placeholder="站A|站B">
        <input data-walk-val data-index="${i}" type="number" min="0" step="1" value="${esc(value)}">
        <button type="button" data-del-walk="${i}" title="删除">✕</button>
      </div>`).join("")}
      <button type="button" class="ed-add-btn" data-add-walk="1">＋ 添加站外步行</button>`;
  }

  function localStats() {
    const lines = state.doc?.lines || [];
    const stations = new Set();
    let segments = 0;
    lines.forEach((line) => {
      line.stations.forEach((s) => { if (s) stations.add(s); });
      segments += Math.max(0, line.stations.length - 1);
    });
    return { lines: lines.length, stations: stations.size, segments };
  }

  function renderValidation() {
    const box = $("validation");
    if (!state.doc) {
      box.innerHTML = `<p class="hint">尚未加载数据</p>`;
      return;
    }
    const v = state.validation;
    const stats = v?.stats || localStats();
    let html = `<div class="v-stats">${stats.lines} 条线路 · ${stats.stations} 站 · ${stats.segments} 段</div>`;
    if (state.validating) html += `<div class="v-busy">正在用内核校验…</div>`;
    else if (!v) html += `<div class="v-busy">等待校验…</div>`;
    else if (!v.valid) {
      html += `<div class="v-block errors"><h4>${v.errors.length} 处错误（修正后才能提交）</h4><ul>${v.errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>`;
    } else {
      html += `<div class="v-ok">✓ 数据校验通过</div>`;
    }
    if (v?.warnings?.length) {
      html += `<div class="v-block warnings"><h4>${v.warnings.length} 条提醒</h4><ul>${v.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>`;
    }
    box.innerHTML = html;
  }

  // ---------------- 校验 ----------------

  const scheduleValidate = debounce(async () => {
    if (!state.doc) return;
    state.validating = true;
    renderValidation();
    try {
      const res = TP.validateCity(state.doc);
      state.validation = res.ok
        ? { valid: Boolean(res.valid), errors: res.errors || [], warnings: res.warnings || [], stats: res.stats || null }
        : { valid: false, errors: [res.error || "校验失败"], warnings: [], stats: null };
    } catch (err) {
      state.validation = { valid: false, errors: [`校验失败：${err.message}`], warnings: [], stats: null };
    }
    state.validating = false;
    renderValidation();
  }, 450);

  // ---------------- 变更 ----------------

  function touch({ draft = true } = {}) {
    state.dirty = true;
    renderState();
    if (draft) persistDraftSoon();
    scheduleValidate();
  }

  const refreshLineListSoon = debounce(renderLineList, 250);

  function rebuildDirections(line) {
    if (!line.stations || line.stations.length < 2) {
      line.directions = [];
      return;
    }
    if (line.ring) {
      line.directions = [
        { label: "正向环行", terminal: null, reverse: false },
        { label: "反向环行", terminal: null, reverse: true },
      ];
      return;
    }
    const first = line.stations[0];
    const last = line.stations[line.stations.length - 1];
    line.directions = [
      { label: `${last}方向`, terminal: last, reverse: false },
      { label: `${first}方向`, terminal: first, reverse: false },
    ];
  }

  function ensureDirections(line) {
    const directions = line.directions || [];
    const valid = directions.length > 0 && directions.every((d) => (
      d && typeof d.label === "string" && d.label.trim()
      && (!d.terminal || line.stations.includes(d.terminal))
    ));
    if (!valid) rebuildDirections(line);
  }

  function insertStation(line, index) {
    const n = line.stations.length;
    const at = Math.max(0, Math.min(index, n));
    if (n === 0) {
      line.stations.splice(0, 0, "新车站");
      ensureDirections(line);
      return 0;
    }
    let value = 3;
    let segIndex = at;
    if (at > 0 && at <= n) {
      const prevIndex = at - 1;
      const prevValue = Number(line.travel_minutes[prevIndex]);
      if (Number.isFinite(prevValue) && prevValue > 0) {
        value = Math.max(1, Math.round((prevValue / 2) * 10) / 10);
        line.travel_minutes[prevIndex] = value;
      }
      segIndex = at;
    } else {
      segIndex = 0;
    }
    line.travel_minutes.splice(segIndex, 0, value);
    line.stations.splice(at, 0, "新车站");
    ensureDirections(line);
    return at;
  }

  function deleteStation(line, index) {
    line.stations.splice(index, 1);
    const segIndex = index < line.travel_minutes.length ? index : line.travel_minutes.length - 1;
    if (segIndex >= 0) line.travel_minutes.splice(segIndex, 1);
    ensureDirections(line);
  }

  function moveStation(line, from, to) {
    if (from === to) return;
    const [station] = line.stations.splice(from, 1);
    line.stations.splice(to, 0, station);
    ensureDirections(line);
  }

  function selectLine(id) {
    if (state.selectedLineId === id) return;
    state.selectedLineId = id;
    state.stationIndex = -1;
    state.segmentIndex = -1;
    renderLineList();
    renderWorkspace();
  }

  function selectStation(index) {
    state.stationIndex = index;
    state.segmentIndex = -1;
    renderMap();
    renderStationEditor();
  }

  function selectSegment(index) {
    state.segmentIndex = index;
    state.stationIndex = -1;
    renderMap();
    renderStationEditor();
  }

  function addLine() {
    const count = state.doc.lines.length;
    let id = `line_${count + 1}`;
    let salt = 1;
    while (state.doc.lines.some((line) => line.id === id)) { id = `line_${count + 1}_${salt++}`; }
    const line = normalizeLine({
      id,
      name: `新线路 ${count + 1}`,
      short_name: `新线路${count + 1}`,
      type: "metro",
      color: palette[count % palette.length],
      stations: ["起点站", "终点站"],
      travel_minutes: [3],
      headway_rush: 10,
      headway_normal: 15,
      ring: false,
      directions: [],
    });
    rebuildDirections(line);
    state.doc.lines.push(line);
    state.selectedLineId = id;
    state.stationIndex = -1;
    state.segmentIndex = -1;
    touch();
    renderAll();
  }

  function deleteLine(id) {
    const line = state.doc.lines.find((item) => item.id === id);
    if (!line) return;
    if (!confirm(`确定删除线路「${line.name || id}」？此操作在提交前只影响当前草稿。`)) return;
    state.doc.lines = state.doc.lines.filter((item) => item.id !== id);
    if (state.selectedLineId === id) {
      state.selectedLineId = state.doc.lines[0]?.id || "";
      state.stationIndex = -1;
      state.segmentIndex = -1;
    }
    touch();
    renderAll();
  }

  function moveLine(id, delta) {
    const index = state.doc.lines.findIndex((line) => line.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= state.doc.lines.length) return;
    const [line] = state.doc.lines.splice(index, 1);
    state.doc.lines.splice(target, 0, line);
    touch();
    renderLineList();
  }

  // ---------------- 线路图交互 ----------------

  let drag = null;

  function onMapPointerDown(ev) {
    const node = ev.target.closest?.("g[data-station]");
    if (!node) return;
    const index = Number(node.dataset.station);
    drag = {
      index,
      startX: ev.clientX,
      startY: ev.clientY,
      moved: false,
      target: index,
      pointerId: ev.pointerId,
      svg: $("map").querySelector("svg"),
    };
    node.setPointerCapture?.(ev.pointerId);
  }

  function onMapPointerMove(ev) {
    if (!drag || ev.pointerId !== drag.pointerId || !drag.svg) return;
    if (!drag.moved && Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) < 8) return;
    drag.moved = true;
    const rect = drag.svg.getBoundingClientRect();
    const viewBox = drag.svg.viewBox.baseVal;
    const scale = viewBox.width > 0 && rect.width > 0 ? viewBox.width / rect.width : 1;
    const x = (ev.clientX - rect.left) * scale;
    const { padL, gap } = state.mapMetrics || { padL: 64, gap: 100 };
    const line = selectedLine();
    if (!line) return;
    const target = Math.max(0, Math.min(line.stations.length - 1, Math.round((x - padL) / gap)));
    drag.target = target;
    const marker = drag.svg.querySelector("#drag-marker");
    if (marker) {
      const markX = padL + target * gap;
      marker.setAttribute("x1", markX);
      marker.setAttribute("x2", markX);
      marker.style.opacity = "0.85";
    }
  }

  function onMapPointerUp() {
    if (!drag) return;
    const current = drag;
    drag = null;
    const marker = current.svg?.querySelector("#drag-marker");
    if (marker) marker.style.opacity = "0";
    if (current.moved && current.target !== current.index) {
      const line = selectedLine();
      if (!line) return;
      moveStation(line, current.index, current.target);
      state.stationIndex = current.target;
      state.segmentIndex = -1;
      touch();
      renderAll();
      return;
    }
    selectStation(current.index);
  }

  function onMapClick(ev) {
    const insert = ev.target.closest("[data-insert]");
    if (insert) {
      const line = selectedLine();
      if (!line) return;
      const at = insertStation(line, Number(insert.dataset.insert));
      state.stationIndex = at;
      state.segmentIndex = -1;
      touch();
      renderAll();
      requestAnimationFrame(() => {
        const input = $("st-name");
        if (input) { input.focus(); input.select(); }
      });
      return;
    }
    const seg = ev.target.closest("[data-seg]");
    if (seg) selectSegment(Number(seg.dataset.seg));
  }

  function onMapKeydown(ev) {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const station = ev.target.closest("[data-station]");
    if (station) {
      ev.preventDefault();
      selectStation(Number(station.dataset.station));
      return;
    }
    const insert = ev.target.closest("[data-insert]");
    if (insert) {
      ev.preventDefault();
      const line = selectedLine();
      if (!line) return;
      const at = insertStation(line, Number(insert.dataset.insert));
      state.stationIndex = at;
      touch();
      renderAll();
      return;
    }
    const seg = ev.target.closest("[data-seg]");
    if (seg) {
      ev.preventDefault();
      selectSegment(Number(seg.dataset.seg));
    }
  }

  // ---------------- 事件绑定 ----------------

  function bindEvents() {
    $("city-select").addEventListener("change", () => {
      if (state.dirty && !confirm("当前有未提交的修改，切换城市会丢失这些修改。继续？")) {
        $("city-select").value = state.cityName;
        return;
      }
      loadCity($("city-select").value);
    });

    $("btn-new-city").addEventListener("click", openNewCityDialog);
    $("btn-new-close").addEventListener("click", () => $("new-city-dialog").close());
    $("btn-new-cancel").addEventListener("click", () => $("new-city-dialog").close());
    $("btn-new-ok").addEventListener("click", createNewCity);

    $("btn-upload").addEventListener("click", () => $("file-upload").click());
    $("file-upload").addEventListener("change", uploadJson);

    $("btn-reset").addEventListener("click", () => {
      if (!state.doc) return;
      const isOnline = state.stems.includes(state.cityName) || Boolean(state.published[state.cityName]);
      const message = isOnline
        ? "放弃未提交的修改，恢复为线上数据？"
        : "该城市尚未提交审核，还原会删除本地草稿并切换到内置城市。继续？";
      if (!confirm(message)) return;
      clearDraft(state.cityName);
      if (!isOnline) {
        state.extraCities = state.extraCities.filter((name) => name !== state.cityName);
        state.cityName = "";
        fillCitySelect();
        const fallback = state.cities[0] || "";
        if (fallback) {
          loadCity(fallback);
        } else {
          state.doc = null;
          state.baseDoc = null;
          renderAll();
        }
        toast("已删除本地草稿");
        return;
      }
      loadCity(state.cityName);
      toast("已恢复为线上数据");
    });

    $("btn-export").addEventListener("click", () => {
      if (!state.doc) return;
      downloadJson(state.cityName || state.doc.city, JSON.stringify(state.doc, null, 2));
      toast("已导出城市 JSON");
    });

    $("btn-submit").addEventListener("click", openSubmitDialog);
    $("btn-submit-close").addEventListener("click", () => $("submit-dialog").close());
    $("btn-submit-cancel").addEventListener("click", () => $("submit-dialog").close());
    $("btn-submit-ok").addEventListener("click", submitForReview);

    $("btn-add-line").addEventListener("click", addLine);

    $("line-list").addEventListener("click", (ev) => {
      const item = ev.target.closest("[data-id]");
      if (!item) return;
      const id = item.dataset.id;
      if (ev.target.closest("[data-del]")) { deleteLine(id); return; }
      const move = ev.target.closest("[data-move]");
      if (move) { moveLine(id, Number(move.dataset.move)); return; }
      selectLine(id);
    });
    $("line-list").addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      const item = ev.target.closest("[data-id]");
      if (!item) return;
      ev.preventDefault();
      selectLine(item.dataset.id);
    });

    document.querySelectorAll(".ed-tabs button").forEach((btn) => {
      btn.addEventListener("click", () => switchView(btn.dataset.view));
    });

    $("map-toolbar").addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-tool]");
      if (!btn) return;
      const line = selectedLine();
      if (!line) return;
      const tool = btn.dataset.tool;
      if (tool === "add-station") {
        const at = insertStation(line, line.stations.length);
        state.stationIndex = at;
        state.segmentIndex = -1;
        touch();
        renderAll();
        requestAnimationFrame(() => {
          const input = $("st-name");
          if (input) { input.focus(); input.select(); }
        });
      } else if (tool === "fill") {
        const needed = Math.max(0, line.stations.length - 1);
        for (let i = 0; i < needed; i += 1) {
          const value = Number(line.travel_minutes[i]);
          if (!Number.isFinite(value)) line.travel_minutes[i] = 3;
        }
        touch();
        renderWorkspace();
        toast("已为缺失的区间补上 3 分钟");
      } else if (tool === "reverse") {
        line.stations.reverse();
        line.travel_minutes.reverse();
        ensureDirections(line);
        state.stationIndex = -1;
        state.segmentIndex = -1;
        touch();
        renderAll();
        toast("站表已反向");
      } else if (tool === "dirs") {
        rebuildDirections(line);
        touch();
        renderAll();
        toast("已按站表重建方向");
      }
    });

    $("map").addEventListener("pointerdown", onMapPointerDown);
    $("map").addEventListener("pointermove", onMapPointerMove);
    $("map").addEventListener("pointerup", onMapPointerUp);
    $("map").addEventListener("pointercancel", () => {
      if (drag?.svg) {
        const marker = drag.svg.querySelector("#drag-marker");
        if (marker) marker.style.opacity = "0";
      }
      drag = null;
    });
    $("map").addEventListener("click", onMapClick);
    $("map").addEventListener("keydown", onMapKeydown);

    $("station-editor").addEventListener("input", (ev) => {
      const line = selectedLine();
      if (!line) return;
      const el = ev.target;
      if (el.id === "st-name") {
        line.stations[state.stationIndex] = el.value;
        const head = $("st-head-name");
        if (head) head.textContent = el.value || "（空站名）";
        touch();
        renderMap();
        refreshLineListSoon();
      } else if (el.id === "st-prev") {
        line.travel_minutes[state.stationIndex - 1] = toNumber(el.value);
        touch();
        renderMap();
      } else if (el.id === "st-next") {
        line.travel_minutes[state.stationIndex] = toNumber(el.value);
        touch();
        renderMap();
      } else if (el.id === "seg-minutes") {
        line.travel_minutes[state.segmentIndex] = toNumber(el.value);
        touch();
        renderMap();
      }
    });

    $("station-editor").addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-act]");
      if (!btn) return;
      const line = selectedLine();
      if (!line) return;
      const act = btn.dataset.act;
      if (act === "seg-close") { state.segmentIndex = -1; renderMap(); renderStationEditor(); return; }
      if (act === "seg-insert") {
        const at = insertStation(line, state.segmentIndex + 1);
        state.stationIndex = at;
        state.segmentIndex = -1;
        touch();
        renderAll();
        requestAnimationFrame(() => { const input = $("st-name"); if (input) { input.focus(); input.select(); } });
        return;
      }
      const index = state.stationIndex;
      if (index < 0) return;
      if (act === "insert-before" || act === "insert-after") {
        const at = insertStation(line, act === "insert-before" ? index : index + 1);
        state.stationIndex = at;
        state.segmentIndex = -1;
        touch();
        renderAll();
        requestAnimationFrame(() => { const input = $("st-name"); if (input) { input.focus(); input.select(); } });
      } else if (act === "left" && index > 0) {
        moveStation(line, index, index - 1);
        state.stationIndex = index - 1;
        touch();
        renderAll();
      } else if (act === "right" && index < line.stations.length - 1) {
        moveStation(line, index, index + 1);
        state.stationIndex = index + 1;
        touch();
        renderAll();
      } else if (act === "delete") {
        if (!confirm(`删除车站「${line.stations[index] || ""}」？`)) return;
        deleteStation(line, index);
        state.stationIndex = -1;
        state.segmentIndex = -1;
        touch();
        renderAll();
      }
    });

    $("view-props").addEventListener("input", onPropsInput);
    $("view-props").addEventListener("change", onPropsChange);

    $("city-meta").addEventListener("input", (ev) => {
      const el = ev.target.closest("[data-city]");
      if (!el || !state.doc) return;
      state.doc[el.dataset.city] = el.value;
      touch();
    });

    $("group-meta").addEventListener("input", (ev) => {
      const el = ev.target.closest("[data-group]");
      if (!el || !state.doc) return;
      const kind = el.dataset.group;
      const inputs = [...$("group-meta").querySelectorAll(`input[data-group="${kind}"]`)];
      state.doc[kind] = inputs.map((input) => splitNames(input.value));
      touch();
    });
    $("group-meta").addEventListener("click", (ev) => {
      const add = ev.target.closest("[data-add-group]");
      if (add) {
        state.doc[add.dataset.addGroup].push(["站名1", "站名2"]);
        touch();
        renderGroupMeta();
        return;
      }
      const del = ev.target.closest("[data-del-group]");
      if (del) {
        state.doc[del.dataset.delGroup].splice(Number(del.dataset.index), 1);
        touch();
        renderGroupMeta();
      }
    });

    $("walk-meta").addEventListener("input", () => {
      if (!state.doc) return;
      const keys = [...$("walk-meta").querySelectorAll("[data-walk-key]")];
      const values = [...$("walk-meta").querySelectorAll("[data-walk-val]")];
      const walks = {};
      keys.forEach((input, i) => {
        const key = input.value.trim();
        if (!key) return;
        const value = Number(values[i]?.value);
        walks[key] = Number.isFinite(value) ? value : 0;
      });
      state.doc.external_walks = walks;
      touch();
    });
    $("walk-meta").addEventListener("click", (ev) => {
      if (!state.doc) return;
      if (ev.target.closest("[data-add-walk]")) {
        let key = "站A|站B";
        let i = 2;
        while (key in state.doc.external_walks) key = `站A|站B${i++}`;
        state.doc.external_walks[key] = 5;
        touch();
        renderWalkMeta();
        return;
      }
      const del = ev.target.closest("[data-del-walk]");
      if (del) {
        const entries = Object.entries(state.doc.external_walks);
        const [key] = entries[Number(del.dataset.delWalk)] || [];
        if (key !== undefined) delete state.doc.external_walks[key];
        touch();
        renderWalkMeta();
      }
    });

    $("btn-json-apply").addEventListener("click", applyJson);
    $("btn-json-format").addEventListener("click", () => {
      try {
        $("json-text").value = JSON.stringify(JSON.parse($("json-text").value), null, 2);
        $("json-error").hidden = true;
      } catch (err) {
        setJsonError(`JSON 解析失败：${err.message}`);
      }
    });

    // 回车提交时不要让 <form method="dialog"> 直接关闭弹窗而不提交
    document.querySelector("#submit-dialog form")?.addEventListener("submit", (ev) => {
      ev.preventDefault();
      submitForReview();
    });
    document.querySelector("#new-city-dialog form")?.addEventListener("submit", (ev) => {
      ev.preventDefault();
      createNewCity();
    });

    window.addEventListener("beforeunload", (ev) => {
      if (!state.dirty) return;
      ev.preventDefault();
      ev.returnValue = "";
    });
  }

  function onPropsInput(ev) {
    const el = ev.target.closest("[data-field]");
    if (!el) return;
    const field = el.dataset.field;
    if (field === "color2-on" || field === "ring") return;
    const line = selectedLine();
    if (!line) return;
    line[field] = el.type === "number" ? Number(el.value) : el.value;
    touch();
    renderMap();
    if (["id", "name", "short_name", "type", "color", "color2"].includes(field)) refreshLineListSoon();
  }

  function onPropsChange(ev) {
    const el = ev.target.closest("[data-field]");
    if (!el) return;
    const line = selectedLine();
    if (!line) return;
    if (el.dataset.field === "color2-on") {
      line.color2 = el.checked ? (line.color2 && line.color2 !== "#ffffff" ? line.color2 : "#ffffff") : "";
      touch();
      renderProps();
      renderLineList();
      renderMap();
    } else if (el.dataset.field === "ring") {
      line.ring = el.checked;
      rebuildDirections(line);
      touch();
      renderAll();
    }
  }

  function switchView(view) {
    state.view = view;
    document.querySelectorAll(".ed-tabs button").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === view);
    });
    $("view-map").hidden = view !== "map";
    $("view-props").hidden = view !== "props";
    $("view-json").hidden = view !== "json";
    if (view === "json") {
      $("json-error").hidden = true;
      $("json-text").value = JSON.stringify(state.doc, null, 2);
    } else if (view === "map") {
      renderMap();
      renderStationEditor();
    } else if (view === "props") {
      renderProps();
    }
  }

  function setJsonError(message) {
    const box = $("json-error");
    box.textContent = message;
    box.hidden = false;
  }

  function applyJson() {
    let raw;
    try {
      raw = JSON.parse($("json-text").value);
    } catch (err) {
      setJsonError(`JSON 解析失败：${err.message}`);
      return;
    }
    const doc = normalizeDoc(raw, state.cityName);
    const res = TP.validateCity(doc);
    if (!res.ok) {
      setJsonError(res.error || "校验失败");
      return;
    }
    if (!res.valid) {
      setJsonError(`校验未通过：\n${(res.errors || []).slice(0, 8).join("\n")}`);
      return;
    }
    const nextName = String(doc.city || "").trim();
    if (nextName !== state.cityName) {
      if (!confirm(`城市名已改为「${nextName}」，将以该名称提交审核。继续？`)) return;
      state.cityName = nextName;
      addCity(nextName);
      fillCitySelect();
      $("city-select").value = nextName;
    }
    state.doc = normalizeDoc(res.city || doc, state.cityName);
    state.stationIndex = -1;
    state.segmentIndex = -1;
    if (!state.doc.lines.some((line) => line.id === state.selectedLineId)) {
      state.selectedLineId = state.doc.lines[0]?.id || "";
    }
    touch();
    persistDraft();
    renderAll();
    switchView("map");
    toast("已从 JSON 应用修改");
  }

  // ---------------- 新建 / 上传 ----------------

  function openNewCityDialog() {
    $("new-city-name").value = "";
    $("new-city-region").value = "";
    $("new-city-source").value = "";
    $("new-city-error").hidden = true;
    fillNewCitySources();
    $("new-city-dialog").showModal();
    requestAnimationFrame(() => $("new-city-name").focus());
  }

  function blankCityDoc(name, region) {
    const line = normalizeLine({
      id: "line_1",
      name: "示例线路",
      short_name: "示例线",
      type: "metro",
      color: palette[0],
      operator: "",
      stations: ["起点站", "中途站", "终点站"],
      travel_minutes: [3, 3],
      headway_rush: 10,
      headway_normal: 15,
      ring: false,
      directions: [],
    });
    rebuildDirections(line);
    return normalizeDoc({
      city: name,
      region,
      version: "1.0",
      lines: [line],
      external_walks: {},
      transfers: [],
      aliases: [],
    }, name);
  }

  async function createNewCity() {
    const name = $("new-city-name").value.trim();
    const error = $("new-city-error");
    if (!name) {
      error.textContent = "请填写城市名。";
      error.hidden = false;
      return;
    }
    if (/[\\/:*?"<>|]/.test(name)) {
      error.textContent = "城市名不能包含 \\ / : * ? \" < > | 等字符。";
      error.hidden = false;
      return;
    }
    if (state.stems.includes(name) || state.published[name]) {
      if (!confirm(`「${name}」已存在，将基于现有数据继续编辑（不会覆盖，直到提交并通过审核）。继续？`)) return;
      $("new-city-dialog").close();
      await loadCity(name);
      return;
    }

    const source = $("new-city-source").value;
    let doc;
    if (source) {
      const res = TP.cityJson(source);
      if (!res.ok) {
        error.textContent = res.error || "复制失败";
        error.hidden = false;
        return;
      }
      doc = normalizeDoc(res.city, name);
    } else {
      doc = blankCityDoc(name, $("new-city-region").value.trim());
    }
    doc.city = name;
    if ($("new-city-region").value.trim()) doc.region = $("new-city-region").value.trim();

    state.cityName = name;
    state.doc = doc;
    state.baseDoc = null;
    state.origin = "new";
    state.dirty = true;
    state.submitted = false;
    state.existsBuiltin = false;
    state.validation = null;
    state.selectedLineId = doc.lines[0]?.id || "";
    state.stationIndex = -1;
    state.segmentIndex = -1;
    addCity(name);
    fillCitySelect();
    $("city-select").value = name;
    $("new-city-dialog").close();
    clearBanner();
    persistDraft();
    renderAll();
    scheduleValidate();
    history.replaceState(null, "", `?city=${encodeURIComponent(name)}`);
    toast(`已创建「${name}」，编辑后记得提交审核`);
  }

  function uploadJson(ev) {
    const file = ev.target.files?.[0];
    ev.target.value = "";
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toast("文件过大（上限 2 MB）");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      let raw;
      try {
        raw = JSON.parse(String(reader.result));
      } catch (err) {
        toast(`JSON 解析失败：${err.message}`);
        return;
      }
      const name = String(raw?.city || "").trim();
      if (!name) {
        toast("JSON 里缺少城市名（city 字段）");
        return;
      }
      if (name !== state.cityName && !confirm(`上传的数据属于「${name}」，是否切换为编辑该城市？`)) return;
      const res = TP.validateCity(raw);
      if (!res.ok) {
        toast(res.error || "校验失败");
        return;
      }
      const doc = normalizeDoc(raw, name);
      state.cityName = name;
      state.doc = doc;
      state.baseDoc = null;
      state.origin = "upload";
      state.dirty = true;
      state.submitted = false;
      state.existsBuiltin = state.stems.includes(name);
      state.validation = null;
      state.selectedLineId = doc.lines[0]?.id || "";
      state.stationIndex = -1;
      state.segmentIndex = -1;
      addCity(name);
      fillCitySelect();
      $("city-select").value = name;
      clearBanner();
      persistDraft();
      renderAll();
      scheduleValidate();
      history.replaceState(null, "", `?city=${encodeURIComponent(name)}`);
      if (!res.valid) {
        toast(`已载入，但仍有 ${(res.errors || []).length} 处校验错误，请查看右侧「数据校验」`);
      } else {
        toast("已载入上传的 JSON");
      }
    };
    reader.readAsText(file, "utf-8");
  }

  // ---------------- 提交审核 ----------------

  function openSubmitDialog() {
    if (!state.doc) return;
    if (!state.backend) {
      toast("在线审核未启用：请先「导出 JSON」提交给管理员，或使用 Netlify 部署版");
      return;
    }
    if (state.validation && !state.validation.valid) {
      toast(`还有 ${state.validation.errors.length} 处错误，请先修正再提交`);
      $("validation").scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const kind = state.existsBuiltin || state.published[state.cityName] ? "edit" : "new";
    $("submit-target").innerHTML = `
      <span class="badge">${kind === "new" ? "新建城市" : "修改现有城市"}</span>
      <b>${esc(state.cityName)}</b>
      <span class="hint">${state.doc.lines.length} 条线路 · ${state.doc.lines.reduce((sum, line) => sum + line.stations.length, 0)} 站</span>`;
    $("submit-summary").value = "";
    $("submit-contact").value = (() => { try { return localStorage.getItem(CONTACT_KEY) || ""; } catch { return ""; } })();
    $("diff-preview").innerHTML = CityDiff.renderHtml(CityDiff.diff(state.baseDoc, state.doc));
    $("submit-error").hidden = true;
    $("submit-hint").textContent = state.validation?.warnings?.length
      ? `${state.validation.warnings.length} 条提醒（仍可提交）`
      : "";
    $("submit-dialog").showModal();
    requestAnimationFrame(() => $("submit-summary").focus());
  }

  async function submitForReview() {
    const error = $("submit-error");
    const summary = $("submit-summary").value.trim();
    if (summary.length < 4) {
      error.textContent = "请填写至少 4 个字的修改说明。";
      error.hidden = false;
      return;
    }
    const contact = $("submit-contact").value.trim();
    const kind = state.existsBuiltin || state.published[state.cityName] ? "edit" : "new";
    const button = $("btn-submit-ok");
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = "提交中…";
    error.hidden = true;

    const res = await DataApi.submit({
      kind,
      city: state.cityName,
      summary,
      contact,
      base: state.baseDoc,
      doc: state.doc,
    });

    button.disabled = false;
    button.textContent = "提交";

    if (!res.ok) {
      error.textContent = res.error || "提交失败";
      error.hidden = false;
      return;
    }

    try { localStorage.setItem(CONTACT_KEY, contact); } catch { /* 忽略 */ }
    clearDraft(state.cityName);
    state.dirty = false;
    state.submitted = true;
    renderState();
    $("submit-dialog").close();
    showBanner(`已提交审核（编号 ${res.id}）。审核记录与差异对所有访客公开，管理员通过后立即生效。`, [
      { label: "查看审核记录", href: `review.html?submission=${encodeURIComponent(res.id)}` },
      { label: "关闭", onClick: clearBanner },
    ], "ok");
    toast("已提交，等待管理员审核");
  }

  // ---------------- 启动 ----------------

  boot();
})();
