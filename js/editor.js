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
      // 编辑器从 hidden 变为可见后再渲染一次，让环线按真实图纸尺寸自适应
      requestAnimationFrame(() => { if (state.doc) renderMap(); });
    } catch (err) {
      document.body.classList.add("err");
      $("boot").classList.add("error");
      $("boot-msg").textContent = `启动失败：${err.message}。请检查网络连接后重试。`;
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
    const normalized = {
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
      express: Array.isArray(line.express)
        ? line.express.map((svc, i) => ({
          ...svc,
          id: String(svc?.id || `express${i + 1}`),
          name: String(svc?.name || "快车"),
          stops: Array.isArray(svc?.stops) ? svc.stops.map(String) : [],
          section_minutes: Array.isArray(svc?.section_minutes) ? svc.section_minutes.map((v) => toNumber(v)) : [],
          skip_minutes: Number.isFinite(Number(svc?.skip_minutes)) ? Number(svc.skip_minutes) : 0.4,
          headway_text: String(svc?.headway_text ?? ""),
        }))
        : [],
      directions: Array.isArray(line.directions)
        ? line.directions.map((d) => ({
          ...d,
          label: String(d?.label ?? ""),
          terminal: d?.terminal ?? null,
          reverse: Boolean(d?.reverse),
        }))
        : [],
    };
    // 环线首尾重复记录的闭合站在编辑器中统一去掉，只保留闭合区间的时长
    if (normalized.ring && normalized.stations.length >= 3 && normalized.stations[0] === normalized.stations[normalized.stations.length - 1]) {
      normalized.stations = normalized.stations.slice(0, -1);
      normalized.travel_minutes = normalized.travel_minutes.slice(0, normalized.stations.length);
    }
    return normalized;
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
      showBanner("在线审核未启用：仍可编辑并导出数据文件；连接审核服务后即可匿名提交审核。", [], "info");
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
    showBanner(`发现本地在 ${when} 保存、尚未提交的草稿。`, [
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
      el.innerHTML = '已提交，等待审核 <span class="ico ico-mono" style="--icon:url(assets/icons/check.svg)" aria-hidden="true"></span>';
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
    if (state.origin === "upload") return "上传的数据文件（尚未提交）";
    if (published) return `社区审核版 · ${published.updatedAt ? new Date(published.updatedAt).toLocaleString("zh-CN") : "已通过"}`;
    return "内置数据";
  }

  function miniMap(line) {
    const stations = line.stations || [];
    const color = safeColor(line.color);
    if (line.ring && ringSize(line) >= 3) {
      const dots = [17, 29, 41].map((x) => `<circle cx="${x}" cy="3.5" r="1.2" fill="#fff" stroke="${color}" stroke-width="1"/>`).join("")
        + [17, 29, 41].map((x) => `<circle cx="${x}" cy="10.5" r="1.2" fill="#fff" stroke="${color}" stroke-width="1"/>`).join("");
      return `<svg class="mini" viewBox="0 0 58 14" aria-hidden="true"><rect x="5" y="2.5" width="48" height="9" rx="4.5" fill="none" stroke="${color}" stroke-width="2.2"/>${dots}</svg>`;
    }
    const shown = stations.slice(0, 14);
    const count = Math.max(shown.length, 2);
    const width = 58;
    const height = 14;
    const pad = 3;
    const gap = (width - pad * 2) / (count - 1);
    const dots = shown.map((_, i) => `<circle cx="${(pad + i * gap).toFixed(1)}" cy="7" r="1.8" fill="#fff" stroke="${color}" stroke-width="1.2"/>`).join("");
    return `<svg class="mini" viewBox="0 0 ${width} ${height}" aria-hidden="true"><line x1="${pad}" y1="7" x2="${width - pad}" y2="7" stroke="${color}" stroke-width="3" stroke-linecap="round"/>${dots}</svg>`;
  }

  /** 当前城市的分组（主线 + 其支线合并为一条）。 */
  function lineGroups() {
    return window.LineBranches.groupLines(state.doc?.lines || []);
  }

  /** 选中线路所属的分组（选中的是支线时同样返回主线分组）。 */
  function selectedGroup() {
    const line = selectedLine();
    if (!line) return null;
    return window.LineBranches.groupOf(state.doc?.lines || [], line.id);
  }

  function renderLineList() {
    const lines = state.doc?.lines || [];
    const groups = lineGroups();
    $("line-count").textContent = lines.length === groups.length
      ? `${lines.length} 条`
      : `${groups.length} 条（含 ${lines.length - groups.length} 条支线）`;
    if (!lines.length) {
      $("line-list").innerHTML = `<p class="hint" style="padding:10px">还没有线路，点击右上角「＋」新增。</p>`;
      return;
    }
    const current = selectedLine();
    const inGroup = (group) => group.main.id === current?.id
      || group.branches.some((branch) => branch.id === current?.id);
    $("line-list").innerHTML = groups.map((group) => {
      const main = group.main;
      const count = window.LineBranches.groupStationCount(group);
      const branchNote = group.branches.length
        ? ` · 含 ${group.branches.length} 条支线 · ${esc(window.LineBranches.groupShape(group))}`
        : "";
      return `
      <div class="ed-line-item${inGroup(group) ? " active" : ""}${group.branches.length ? " has-branch" : ""}" data-id="${esc(main.id)}" role="button" tabindex="0" aria-label="${esc(main.name || "未命名线路")}">
        <span class="ed-line-mini">${group.branches.length ? miniMapGroup(group) : miniMap(main)}</span>
        <span class="ed-line-info">
          <span class="ed-line-name">${esc(main.name || "未命名线路")}</span>
          <span class="ed-line-sub">${esc(typeLabel(main.type))} · ${main.ring ? ringSize(main) : count} 站${main.ring ? " · 环线" : ""}${branchNote}</span>
        </span>
        <span class="ed-line-ops">
          <button type="button" class="ghost" data-move="-1" title="上移">↑</button>
          <button type="button" class="ghost" data-move="1" title="下移">↓</button>
          <button type="button" class="ghost danger" data-del="1" title="${group.branches.length ? "删除线路及其支线" : "删除线路"}">✕</button>
        </span>
      </div>`;
    }).join("");
  }

  /** 分组缩略图：主线水平，支线从分叉点斜向引出。 */
  function miniMapGroup(group) {
    const color = safeColor(group.main.color);
    const height = 22;
    const nodes = [];
    const run = window.LineBranches.longestCommonRun(group.main, group.branches[0]);
    const branchHeadBefore = run.bStart > 0;
    for (let k = 0; k < 4; k += 1) {
      nodes.push({ x: 8 + k * 10, y: 15 });
    }
    if (branchHeadBefore) nodes.push({ x: 8, y: 4 });
    else nodes.push({ x: 48, y: 4 });
    const path = branchHeadBefore
      ? `M8 4 L18 15 L38 15`
      : `M18 15 L28 4 L38 4`;
    const dots = nodes.map((node) => `<circle cx="${node.x}" cy="${node.y}" r="1.6" fill="#fff" stroke="${color}" stroke-width="1.2"/>`).join("");
    return `<svg class="mini" viewBox="0 0 58 ${height}" aria-hidden="true">
      <line x1="8" y1="15" x2="48" y2="15" stroke="${color}" stroke-width="2.6" stroke-linecap="round"/>
      <path d="${path}" fill="none" stroke="${color}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
      ${dots}
    </svg>`;
  }

  function renderWorkspace() {
    const line = selectedLine();
    const group = selectedGroup();
    const groupSuffix = group?.branches.length && group.main.id === line?.id
      ? `（含 ${group.branches.length} 条支线）`
      : "";
    $("line-title").textContent = line ? `${line.name || "未命名线路"} · 线路图${groupSuffix}` : "线路图";
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
    const segments = segmentCount(line);
    const stationCount = line.ring ? ringSize(line) : line.stations.length;
    box.innerHTML = `
      <span class="line-chip"><i style="background:${line.color2 ? `linear-gradient(90deg, ${safeColor(line.color)} 0 50%, ${safeColor(line.color2)} 50% 100%)` : safeColor(line.color)}"></i>${esc(line.name || "未命名线路")}</span>
      <span class="hint">${esc(typeLabel(line.type))} · ${stationCount} 站 · ${segments} 段</span>
      <div class="spacer"></div>
      <button type="button" data-tool="add-station" title="在线路末端添加一个车站">＋ 末尾加站</button>
      <button type="button" data-tool="fill" title="为缺失的区间补上默认 3 分钟">补齐区间时长</button>
      <button type="button" data-tool="reverse" title="把站表与区间顺序整体倒过来">反向站表</button>
      <button type="button" data-tool="dirs" title="按当前站表重新生成两个方向">重建方向</button>`;
  }

  /** 粗略估算站名在 SVG 里的渲染宽度：中日韩字符按 1 字宽，拉丁字符按半字宽。 */
  function estimateTextWidth(text, fontSize) {
    let units = 0;
    for (const ch of String(text ?? "")) {
      units += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch) ? 1 : 0.55;
    }
    return units * fontSize;
  }

  /** 折线转角处用二次贝塞尔做圆角，返回 SVG path 的 d 属性。 */
  function roundedPolyline(points, radius) {
    if (!points || points.length < 2) return "";
    const d = [`M${points[0].x} ${points[0].y}`];
    for (let i = 1; i < points.length - 1; i += 1) {
      const prev = points[i - 1];
      const cur = points[i];
      const next = points[i + 1];
      const lenIn = Math.hypot(cur.x - prev.x, cur.y - prev.y);
      const lenOut = Math.hypot(next.x - cur.x, next.y - cur.y);
      if (lenIn < 0.5 || lenOut < 0.5) {
        d.push(`L${cur.x} ${cur.y}`);
        continue;
      }
      const r = Math.min(radius, lenIn / 2, lenOut / 2);
      const ax = cur.x - ((cur.x - prev.x) / lenIn) * r;
      const ay = cur.y - ((cur.y - prev.y) / lenIn) * r;
      const bx = cur.x + ((next.x - cur.x) / lenOut) * r;
      const by = cur.y + ((next.y - cur.y) / lenOut) * r;
      d.push(`L${ax} ${ay}`);
      d.push(`Q${cur.x} ${cur.y} ${bx} ${by}`);
    }
    const last = points[points.length - 1];
    d.push(`L${last.x} ${last.y}`);
    return d.join(" ");
  }

  function interchangeSet(line) {
    const set = new Set();
    (state.doc?.lines || []).forEach((other) => {
      if (other.id === line.id) return;
      (other.stations || []).forEach((station) => set.add(station));
    });
    return set;
  }

  /** 环线的真实站数：站表首尾重复记录闭合站时，去重后少 1 站。 */
  function ringSize(line) {
    const n = (line.stations || []).length;
    if (line.ring && n >= 2 && line.stations[0] === line.stations[n - 1]) return n - 1;
    return n;
  }

  /** 需要编辑的区间数：环线包含「末站 → 首站」的闭合区间。 */
  function segmentCount(line) {
    if (line.ring) return Math.max(0, ringSize(line));
    return Math.max(0, (line.stations || []).length - 1);
  }

  function prevSegmentIndex(line, i) {
    if (line.ring) {
      const m = ringSize(line);
      return m > 0 ? (i - 1 + m) % m : -1;
    }
    return i > 0 ? i - 1 : -1;
  }

  function nextSegmentIndex(line, i) {
    if (line.ring) {
      const m = ringSize(line);
      return i >= 0 && i < m ? i : -1;
    }
    return i < (line.stations || []).length - 1 ? i : -1;
  }

  /** 第 i 段的两端站名（环线包含「末站 → 首站」的闭合区间）。 */
  function segmentStations(line, index) {
    const stations = line?.stations || [];
    if (!stations.length || index < 0 || index >= segmentCount(line)) return null;
    if (line.ring) {
      const m = ringSize(line);
      if (m < 2) return null;
      return { from: stations[index], to: stations[(index + 1) % m] };
    }
    if (index + 1 >= stations.length) return null;
    return { from: stations[index], to: stations[index + 1] };
  }

  /** 在一条线路中查找同名区间（先同向、再反向）；找不到返回 -1。 */
  function findSegmentIndex(line, from, to) {
    const total = segmentCount(line);
    for (let i = 0; i < total; i += 1) {
      const seg = segmentStations(line, i);
      if (!seg) continue;
      if (seg.from === from && seg.to === to) return i;
    }
    for (let i = 0; i < total; i += 1) {
      const seg = segmentStations(line, i);
      if (!seg) continue;
      if (seg.from === to && seg.to === from) return i;
    }
    return -1;
  }

  /** 与第 i 段物理相同的同组线路（主线 / 支线）。 */
  function sharedSegmentLines(line, index) {
    const seg = segmentStations(line, index);
    if (!seg) return [];
    const group = window.LineBranches.groupOf(state.doc?.lines || [], line.id);
    const members = group ? [group.main, ...group.branches] : [line];
    return members.filter((member) => member !== line && findSegmentIndex(member, seg.from, seg.to) >= 0);
  }

  /** 写入区间时长；共线段同时写入主线与支线，保持两者一致。 */
  function setSegmentMinutes(line, index, value) {
    if (!line || index < 0 || index >= segmentCount(line)) return;
    line.travel_minutes[index] = value;
    const seg = segmentStations(line, index);
    if (!seg) return;
    const group = window.LineBranches.groupOf(state.doc?.lines || [], line.id);
    const members = group ? [group.main, ...group.branches] : [line];
    members.forEach((member) => {
      if (member === line) return;
      const j = findSegmentIndex(member, seg.from, seg.to);
      if (j >= 0) member.travel_minutes[j] = value;
    });
  }

  function renderMap() {
    const map = $("map");
    const line = selectedLine();
    state.mapMetrics = null;
    if (!line) {
      map.innerHTML = `<p class="empty">${state.doc?.lines.length ? "从左侧选择一条线路，开始编辑线路图。" : "还没有线路，点击左侧「＋」新增。"}</p>`;
      return;
    }
    if (line.ring && ringSize(line) >= 3) {
      renderRingMap(line);
      return;
    }
    const group = selectedGroup();
    if (group?.branches.length) renderBranchMap(group);
    else renderLinearMap(line);
  }

  /**
   * 带支线的线路图：
   * 主线水平作为主干；支线在「分离车站之后的那一段区间」伸出，抬到一条平行轨道后
   * 与主线平行运行，站序与支线站表一致。
   * 若支线在主干之前另有车站（两头分叉），则在「汇入车站之前的那一段区间」斜向汇入主干。
   */
  function renderBranchMap(group) {
    const map = $("map");
    const main = group.main;
    const mainStations = main.stations || [];
    const interchanges = interchangeSet(main);
    group.branches.forEach((branch) => {
      (branch.stations || []).forEach((station) => interchanges.add(station));
    });
    const color = safeColor(main.color);
    const color2 = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(main.color2 || "") ? main.color2 : "";

    let maxStations = mainStations.length;
    group.branches.forEach((branch) => {
      maxStations = Math.max(maxStations, (branch.stations || []).length);
    });
    const gap = maxStations > 30 ? 58 : maxStations > 22 ? 70 : maxStations > 14 ? 86 : maxStations > 8 ? 104 : 124;
    // 平行轨道与主干之间的垂直距离（所有支线共用同一条平行轨道）
    const trackOffset = 104;

    // 每条支线：公共区段沿用主干坐标，独有车站排在平行轨道的网格上
    const branchGeom = new Map(); // branchId -> { nodes: Map(station -> {x, y}), before, after, ... }
    let minIdx = 0;   // 允许出现负的“主线列号”（支线在主干左侧延伸）
    let maxIdx = mainStations.length - 1;
    group.branches.forEach((branch) => {
      const run = window.LineBranches.longestCommonRun(main, branch);
      const stations = branch.stations || [];
      const beforeCount = run.bStart;
      const afterStart = run.bStart + run.length;
      const afterCount = stations.length - afterStart;
      const nodes = new Map();
      // 汇入主干前的那几站：从「汇入站的前一站」往左排
      for (let k = 0; k < beforeCount; k += 1) {
        const column = run.aStart - beforeCount + k;
        minIdx = Math.min(minIdx, column);
        nodes.set(stations[k], { column, y: -trackOffset });
      }
      // 从主干分离出去的那几站：从「分离站的下一站」往右排
      for (let k = 0; k < afterCount; k += 1) {
        const column = run.aStart + run.length + k;
        maxIdx = Math.max(maxIdx, column);
        nodes.set(stations[afterStart + k], { column, y: -trackOffset });
      }
      branchGeom.set(branch.id, {
        run,
        nodes,
        beforeCount,
        afterCount,
        afterStart,
      });
    });

    const padL = 64;
    const shiftX = padL - minIdx * gap; // 列号为 0 时的 x 位置（含左侧延伸的补偿）
    const xAt = (column) => shiftX + column * gap;
    const xMain = mainStations.map((_, i) => xAt(i));
    const topPad = 46;
    const spineY = topPad + trackOffset + 26;
    const trackY = spineY - trackOffset;
    const width = Math.max(xAt(maxIdx) + 120, 620);
    const height = spineY + 150;

    const parts = [];
    parts.push(`<line id="drag-marker" x1="0" y1="0" x2="0" y2="${height}" class="drag-marker" style="opacity:0"/>`);
    const dirLabels = (main.directions || []).map((d) => d.label).filter(Boolean);
    parts.push(`<text x="${padL}" y="26" class="dir-text">${esc(dirLabels.join("  /  ") || "（尚未生成方向）")}${group.branches.length ? "  ·  含支线" : ""}</text>`);

    // 主干
    if (mainStations.length >= 2) {
      const x0 = xMain[0];
      const x1 = xMain[xMain.length - 1];
      if (color2) {
        parts.push(`<rect x="${x0}" y="${spineY - 6}" width="${x1 - x0}" height="6" rx="3" fill="${color}"/>`);
        parts.push(`<rect x="${x0}" y="${spineY}" width="${x1 - x0}" height="6" rx="3" fill="${color2}"/>`);
      } else {
        parts.push(`<rect x="${x0}" y="${spineY - 6}" width="${x1 - x0}" height="12" rx="6" fill="${color}"/>`);
      }
    }

    // 支线：平行轨道 + 分离/汇入主干的两段连接线
    group.branches.forEach((branch) => {
      const stations = branch.stations || [];
      if (stations.length < 2) return;
      const geom = branchGeom.get(branch.id);
      const pointOf = (index) => {
        const station = stations[index];
        const custom = geom.nodes.get(station);
        if (custom) return { x: xAt(custom.column), y: trackY, column: custom.column };
        const mainIdx = mainStations.indexOf(station);
        return { x: xAt(mainIdx), y: spineY, column: mainIdx };
      };
      const points = stations.map((_, index) => pointOf(index));
      const stroke = `stroke="${color}" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"`;

      // 分离/汇入段：斜线接入平行轨道，转角做成圆角，且转角与首/末站之间留出直线段
      const run = geom.run;
      const radius = Math.max(18, Math.min(34, gap * 0.32));
      const stub = Math.max(18, gap * 0.22); // 转角到车站之间的直线段长度
      const need = radius + stub;            // 除斜线外，转角与直线段占用的水平空间
      if (geom.afterCount) {
        const lastShared = run.aStart + run.length - 1;
        const firstAfter = points[run.bStart + run.length];
        const baseX = xAt(lastShared);
        // 分离点默认落在共线区间的中点；空间不够时向左挪（仍在该区间内）
        const departX = Math.max(baseX + gap * 0.12, Math.min(baseX + gap * 0.42, firstAfter.x - need - 6));
        const depart = { x: departX, y: spineY };
        const leadIn = Math.max(12, Math.min(need, firstAfter.x - departX - 2));
        const corner = { x: firstAfter.x - leadIn, y: trackY };
        geom.departCornerX = corner.x;
        const path = roundedPolyline([depart, corner, ...points.slice(run.bStart + run.length)], radius);
        parts.push(`<path d="${path}" fill="none" ${stroke} opacity="0.95"/>`);
      }
      if (geom.beforeCount) {
        const lastBefore = points[run.bStart - 1];
        const baseX = xAt(run.aStart);
        // 汇入点默认落在共线区间的中点；空间不够时向右挪（仍在该区间内）
        const mergeX = Math.min(baseX - gap * 0.12, Math.max(baseX - gap * 0.42, lastBefore.x + need + 6));
        const merge = { x: mergeX, y: spineY };
        const leadIn = Math.max(12, Math.min(need, mergeX - lastBefore.x - 2));
        const corner = { x: lastBefore.x + leadIn, y: trackY };
        geom.mergeCornerX = corner.x;
        const path = roundedPolyline([...points.slice(0, geom.beforeCount), corner, merge], radius);
        parts.push(`<path d="${path}" fill="none" ${stroke} opacity="0.95"/>`);
      }

      // 没有连接段时（理论上不会出现），平行轨道仍按直线补上
      if (!geom.afterCount && !geom.beforeCount && points.length >= 2) {
        parts.push(`<line x1="${points[0].x}" y1="${trackY}" x2="${points[points.length - 1].x}" y2="${trackY}" ${stroke} opacity="0.95"/>`);
      }

      // 支线区间时长（含连接段）；共线区间的时长由主线胶囊显示，避免出现两个圆角矩形
      const sharedEnd = run.bStart + run.length - 1;
      for (let i = 0; i < points.length - 1; i += 1) {
        if (i >= run.bStart && i < sharedEnd) continue;
        const a = points[i];
        const b = points[i + 1];
        const onTrack = a.y === trackY && b.y === trackY;
        // 斜向连接段（分离/汇入）的区间中点与主线区间中点同列，胶囊按中点摆会压住主线胶囊；
        // 这类区间改放到平行轨道一侧的直线段上方：分离段取「转角 → 支线站」，汇入段取「支线站 → 转角」
        const merging = i < run.bStart;
        const stationX = merging ? a.x : b.x;
        const cornerX = merging ? geom.mergeCornerX : geom.departCornerX;
        const hasCorner = Number.isFinite(cornerX);
        // 与支线站保持 32px（胶囊半宽 20 + 站点半径 + 间隙），避免胶囊压住站点圆点
        const mx = !onTrack && hasCorner
          ? (merging
            ? Math.max((cornerX + stationX) / 2, stationX + 32)
            : Math.min((cornerX + stationX) / 2, stationX - 32))
          : (a.x + b.x) / 2;
        const my = onTrack || hasCorner ? trackY - 18 : spineY - 26;
        const value = branch.travel_minutes?.[i];
        parts.push(`<g class="seg-label" data-seg="${i}" data-line="${esc(branch.id)}" role="button" tabindex="0" aria-label="${esc(branch.name)} 第 ${i + 1} 段区间时长">
          <rect class="pill" x="${mx - 20}" y="${my - 12}" width="40" height="24" rx="12"/>
          <text class="seg-text" x="${mx}" y="${my + 5}">${esc(fmtMinute(value))}</text>
        </g>`);
      }
    });

    // 主线区间时长 + 插入点
    for (let i = 0; i < mainStations.length - 1; i += 1) {
      const xa = xMain[i];
      const xm = xa + gap / 2;
      const value = main.travel_minutes[i];
      parts.push(`<g class="seg-label" data-seg="${i}" data-line="${esc(main.id)}" role="button" tabindex="0" aria-label="第 ${i + 1} 段区间时长">
        <rect class="pill" x="${xm - 20}" y="${spineY - 44}" width="40" height="24" rx="12"/>
        <text class="seg-text" x="${xm}" y="${spineY - 27}">${esc(fmtMinute(value))}</text>
      </g>`);
      parts.push(`<g class="insert" data-insert="${i + 1}" data-line="${esc(main.id)}" role="button" tabindex="0" aria-label="在第 ${i + 2} 站前插入车站">
        <circle cx="${xm}" cy="${spineY}" r="10"/>
        <path class="plus" d="M${xm - 4.5} ${spineY} h9 M${xm} ${spineY - 4.5} v9"/>
      </g>`);
    }

    // 站点（主线）
    const stationNode = (line, stationName, x, y, indexInLine, labelAbove, labelToRight = false) => {
      const isInterchange = interchanges.has(stationName);
      const r = isInterchange ? 10 : 7;
      const selected = line.id === state.selectedLineId && indexInLine === state.stationIndex;
      const labelY = labelAbove ? y - 16 : y + 30;
      // 站名默认向左上展开；支线首站改为向右上展开，避免压到分离/汇入的圆角连接线
      const anchorStyle = labelToRight ? ' style="text-anchor:start"' : "";
      return `<g class="station${selected ? " selected" : ""}${isInterchange ? " interchange" : ""}" data-station="${indexInLine}" data-line="${esc(line.id)}" role="button" tabindex="0" aria-label="${esc(stationName)}">
        ${selected ? `<circle class="halo" cx="${x}" cy="${y}" r="${r + 7}"/>` : ""}
        <circle class="node" cx="${x}" cy="${y}" r="${r}" style="stroke:${color}"/>
        <text class="st-name" x="${x}" y="${labelY}"${anchorStyle} transform="rotate(-38 ${x} ${labelY})">${esc(stationName)}</text>
      </g>`;
    };

    mainStations.forEach((name, i) => {
      parts.push(stationNode(main, name, xMain[i], spineY, i, group.branches.length > 0));
    });

    group.branches.forEach((branch) => {
      const geom = branchGeom.get(branch.id);
      const afterStart = geom.run.bStart + geom.run.length;
      (branch.stations || []).forEach((name, i) => {
        const custom = geom.nodes.get(name);
        if (!custom) return; // 共线车站已由主线绘制
        const toRight = geom.afterCount > 0 && i === afterStart;
        parts.push(stationNode(branch, name, xAt(custom.column), trackY, i, true, toRight));
      });
    });

    map.innerHTML = `<svg class="ed-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(main.name || "线路")} 支线线路图">${parts.join("")}</svg>`;
    // 拖动排序按列号换算：padL 取第 0 列的 x（支线可在主干左侧延伸）
    state.mapMetrics = { padL: shiftX, gap, y: spineY, width };
  }

  function renderLinearMap(line) {
    const map = $("map");
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

  /** 环线：扁平圆角矩形（体育场形），站点上下各一半，区间时长放在环内。 */
  function renderRingMap(line) {
    const map = $("map");
    const stations = line.stations || [];
    const m = ringSize(line);
    const color = safeColor(line.color);
    const color2 = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(line.color2 || "") ? line.color2 : "";
    const interchanges = interchangeSet(line);
    const wrap = $("mapwrap");
    const availH = Math.max(240, (wrap?.clientHeight || 440) - 24);

    // 上下各分一半车站：多出来的一站放在上边
    const topCount = Math.ceil(m / 2);
    const bottomCount = m - topCount;
    const radius = Math.round(Math.min(84, Math.max(46, availH * 0.17)));
    // 与非环线线路一致：按车站数量撑开版面，宽度不足时由图纸区域横向滚动。
    // 站名是水平居中排版的，站距再按最长站名放宽，避免相邻站名相互压字。
    const baseGap = topCount > 30 ? 58 : topCount > 22 ? 70 : topCount > 14 ? 86 : topCount > 8 ? 104 : 124;
    const labelFont = baseGap < 62 ? 9.5 : m > 24 ? 10.5 : 11.5;
    const widestName = stations.reduce((w, name) => Math.max(w, estimateTextWidth(name, labelFont)), 0);
    const stationGap = Math.min(210, Math.max(baseGap, Math.ceil(widestName + 16)));
    const straight = Math.max(240, (topCount - 1) * stationGap);
    const width = straight + radius * 2;
    const padX = 18;
    const svgW = Math.ceil(width + padX * 2);
    const xLeft = padX;
    const xRight = xLeft + width - radius;

    const topGap = topCount > 1 ? straight / (topCount - 1) : straight;
    const bottomGap = bottomCount > 1 ? straight / (bottomCount - 1) : straight;
    const gap = Math.min(topGap, bottomGap);
    const dense = gap < 62;
    const compact = gap < 52;
    const pillW = compact ? 30 : 40;
    const pillH = compact ? 20 : 24;
    const pillFont = compact ? 10 : 11;
    const pillInset = pillH / 2 + 6;
    const capInset = pillW / 2 + 12;
    const plusR = dense ? 7 : 10;
    const yTop = dense ? 96 : 88;
    const yBottom = yTop + radius * 2;
    const cy = yTop + radius;
    const svgH = Math.ceil(yBottom + (dense ? 46 : 30) + 16);
    const parts = [];

    const pos = [];
    for (let i = 0; i < topCount; i += 1) {
      const t = topCount === 1 ? 0.5 : i / (topCount - 1);
      pos.push({ x: xLeft + radius + t * straight, y: yTop });
    }
    for (let j = 0; j < bottomCount; j += 1) {
      const t = bottomCount === 1 ? 0.5 : j / (bottomCount - 1);
      pos.push({ x: xRight - t * straight, y: yBottom });
    }

    const dirs = (line.directions || []).map((d) => d.label).filter(Boolean);
    parts.push(`<text x="18" y="20" class="dir-text">${esc(dirs.join("  /  ") || "（尚未生成方向）")}</text>`);

    // 轨道：上下两条直线 + 两端半圆，双色时上半圈用主色、下半圈用副色
    const sw = 12;
    if (color2) {
      parts.push(`<line x1="${xLeft + radius}" y1="${yTop}" x2="${xRight}" y2="${yTop}" stroke="${color}" stroke-width="${sw}"/>`);
      parts.push(`<path d="M${xRight} ${yTop} A${radius} ${radius} 0 0 1 ${xRight + radius} ${cy}" fill="none" stroke="${color}" stroke-width="${sw}"/>`);
      parts.push(`<path d="M${xLeft} ${cy} A${radius} ${radius} 0 0 1 ${xLeft + radius} ${yTop}" fill="none" stroke="${color}" stroke-width="${sw}"/>`);
      parts.push(`<line x1="${xLeft + radius}" y1="${yBottom}" x2="${xRight}" y2="${yBottom}" stroke="${color2}" stroke-width="${sw}"/>`);
      parts.push(`<path d="M${xRight + radius} ${cy} A${radius} ${radius} 0 0 1 ${xRight} ${yBottom}" fill="none" stroke="${color2}" stroke-width="${sw}"/>`);
      parts.push(`<path d="M${xLeft + radius} ${yBottom} A${radius} ${radius} 0 0 1 ${xLeft} ${cy}" fill="none" stroke="${color2}" stroke-width="${sw}"/>`);
    } else {
      parts.push(`<path d="M${xLeft + radius} ${yTop} H${xRight} A${radius} ${radius} 0 0 1 ${xRight} ${yBottom} H${xLeft + radius} A${radius} ${radius} 0 0 1 ${xLeft + radius} ${yTop}" fill="none" stroke="${color}" stroke-width="${sw}"/>`);
    }

    const plusHalf = plusR * 0.45;
    const addSegment = (i, x, y, px, py) => {
      const value = line.travel_minutes[i];
      parts.push(`<g class="seg-label" data-seg="${i}" role="button" tabindex="0" aria-label="第 ${i + 1} 段区间时长">
        <rect class="pill" x="${(x - pillW / 2).toFixed(1)}" y="${(y - pillH / 2).toFixed(1)}" width="${pillW}" height="${pillH}" rx="${pillH / 2}"/>
        <text class="seg-text" x="${x.toFixed(1)}" y="${(y + pillH * 0.17).toFixed(1)}" style="font-size:${pillFont}px">${esc(fmtMinute(value))}</text>
      </g>`);
      parts.push(`<g class="insert" data-insert="${i + 1}" role="button" tabindex="0" aria-label="在第 ${i + 1} 段插入车站">
        <circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${plusR}"/>
        <path class="plus" d="M${(px - plusHalf).toFixed(1)} ${py.toFixed(1)} h${(plusHalf * 2).toFixed(1)} M${px.toFixed(1)} ${(py - plusHalf).toFixed(1)} v${(plusHalf * 2).toFixed(1)}"/>
      </g>`);
    };

    for (let i = 0; i < m; i += 1) {
      if (i < topCount - 1) {
        const x = (pos[i].x + pos[i + 1].x) / 2;
        addSegment(i, x, yTop + pillInset, x, yTop);
      } else if (i === topCount - 1) {
        addSegment(i, xRight + radius - capInset, cy, xRight + radius, cy);
      } else if (i < m - 1) {
        const x = (pos[i].x + pos[i + 1].x) / 2;
        addSegment(i, x, yBottom - pillInset, x, yBottom);
      } else {
        addSegment(i, xLeft + capInset, cy, xLeft, cy);
      }
    }

    for (let i = 0; i < m; i += 1) {
      const p = pos[i];
      const name = stations[i];
      const isInterchange = interchanges.has(name);
      const nodeR = isInterchange ? (dense ? 8 : 10) : (dense ? 5.5 : 7);
      const selected = i === state.stationIndex;
      const isTop = i < topCount;
      const stagger = dense && (isTop ? i : i - topCount) % 2 === 1;
      const labelY = isTop ? yTop - 20 - (stagger ? 16 : 0) : yBottom + 30 + (stagger ? 16 : 0);
      parts.push(`<g class="station${selected ? " selected" : ""}${isInterchange ? " interchange" : ""}" data-station="${i}" role="button" tabindex="0" aria-label="${esc(name)}">
        ${selected ? `<circle class="halo" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${nodeR + 7}"/>` : ""}
        <circle class="node" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${nodeR}" style="stroke:${color}"/>
        <text class="st-name" x="${p.x.toFixed(1)}" y="${labelY}" style="font-size:${labelFont}px;text-anchor:middle">${esc(name)}</text>
      </g>`);
    }

    map.innerHTML = `<svg class="ed-svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" style="display:block;margin:8px auto" role="img" aria-label="${esc(line.name || "线路")} 环线图">${parts.join("")}</svg>`;
    state.mapMetrics = { ring: true, stadium: true, cx: xLeft + width / 2, cy, radius };
  }

  /** 当前线路所属分组的信息（主线名、共线站数、是否支线）。 */
  function branchContext(line) {
    const api = window.LineBranches;
    const group = api.groupOf(state.doc?.lines || [], line.id);
    if (!group) return null;
    const isBranch = group.main.id !== line.id;
    return {
      group,
      isBranch,
      main: group.main,
      parent: isBranch ? group.main : null,
      sharedCount: isBranch ? api.sharedStations(group.main, line).length : 0,
    };
  }

  /**
   * 改名后同步：方向标签、快车停靠站，以及同组支线/主线上的同名车站。
   * 不这么做的话，改一个主干站名就会让支线与主线“断开”，支线也会失去分组。
   */
  function syncRenamedStation(line, before, after) {
    const oldName = String(before ?? "");
    const newName = String(after ?? "");
    if (!oldName || oldName === newName) return;
    const renameInLine = (target) => {
      if (!target || target === line) return;
      target.stations = (target.stations || []).map((station) => (station === oldName ? newName : station));
    };
    const renameLabels = (target) => {
      (target?.directions || []).forEach((direction) => {
        if (typeof direction.label === "string" && direction.label.includes(oldName)) {
          direction.label = direction.label.split(oldName).join(newName);
        }
        if (direction.terminal === oldName) direction.terminal = newName;
      });
      (target?.express || []).forEach((service) => {
        if (Array.isArray(service.stops)) {
          service.stops = service.stops.map((station) => (station === oldName ? newName : station));
        }
      });
    };
    renameLabels(line);
    const group = window.LineBranches.groupOf(state.doc?.lines || [], line.id);
    if (!group) return;
    [group.main, ...group.branches].forEach((member) => {
      renameInLine(member);
      renameLabels(member);
    });
  }

  /** 支线提示条：说明当前编辑的是支线，并可一键切回主线。 */
  function branchBanner(line) {
    const ctx = branchContext(line);
    if (!ctx?.isBranch) return "";
    return `<div class="ed-branch-banner">
      <span class="badge">支线</span>
      本条是「${esc(ctx.parent.name)}」的支线，与主线共线 ${ctx.sharedCount} 站
      <div class="spacer"></div>
      <button type="button" data-act="goto-main">切到主线</button>
    </div>`;
  }

  function renderStationEditor() {
    const box = $("station-editor");
    const line = selectedLine();
    if (!line) {
      box.innerHTML = "";
      return;
    }
    const banner = branchBanner(line);

    if (state.segmentIndex >= 0 && state.segmentIndex < segmentCount(line)) {
      const i = state.segmentIndex;
      const value = line.travel_minutes[i];
      const m = line.ring ? ringSize(line) : line.stations.length - 1;
      const toStation = line.ring ? line.stations[(i + 1) % m] : line.stations[i + 1];
      const sharedNames = sharedSegmentLines(line, i).map((member) => member.name || member.id);
      box.innerHTML = `${banner}
        <div class="ed-station-card">
          <div class="ed-sc-head">
            <span class="ed-sc-badge">区间 ${i + 1}</span>
            <b>${esc(line.stations[i])} → ${esc(toStation)}</b>
            <div class="spacer"></div>
            <span class="hint">${sharedNames.length
              ? `共线段：修改会同步到「${esc(sharedNames.join("、"))}」`
              : "点线路上的时长胶囊即可编辑"}</span>
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
      const hasBranch = (selectedGroup()?.branches || []).length > 0;
      box.innerHTML = `${banner}<div class="ed-station-hint">点击线路图上的站点可编辑站名与相邻区间；拖动站点圆点可调整顺序。${hasBranch ? "支线站点同样可以点击编辑。" : ""}</div>`;
      return;
    }

    const i = state.stationIndex;
    const prevIndex = prevSegmentIndex(line, i);
    const nextIndex = nextSegmentIndex(line, i);
    const prev = prevIndex >= 0 ? line.travel_minutes[prevIndex] : null;
    const next = nextIndex >= 0 ? line.travel_minutes[nextIndex] : null;
    const isRing = line.ring && ringSize(line) >= 3;
    const canRight = isRing ? i < ringSize(line) - 1 : i < line.stations.length - 1;
    box.innerHTML = `${banner}
      <div class="ed-station-card">
        <div class="ed-sc-head">
          <span class="ed-sc-badge" style="background:${safeColor(line.color)}">第 ${i + 1} 站</span>
          <b id="st-head-name">${esc(line.stations[i] || "（空站名）")}</b>
          <div class="spacer"></div>
          <span class="hint">${isRing ? "环线可用左右按钮调整顺序" : "拖动圆点可排序"}</span>
        </div>
        <div class="ed-sc-grid">
          <div class="field"><span>站名</span><input id="st-name" type="text" value="${esc(line.stations[i] || "")}" placeholder="车站名称"></div>
          <div class="field"><span>上一段时长（分钟）</span><input id="st-prev" type="number" min="0" step="0.5" value="${Number.isFinite(Number(prev)) ? Number(prev) : ""}" ${prevIndex >= 0 ? "" : "disabled"}></div>
          <div class="field"><span>下一段时长（分钟）</span><input id="st-next" type="number" min="0" step="0.5" value="${Number.isFinite(Number(next)) ? Number(next) : ""}" ${nextIndex >= 0 ? "" : "disabled"}></div>
        </div>
        <div class="row">
          <button type="button" data-act="insert-before">← 在前面插入</button>
          <button type="button" data-act="insert-after">在后面插入 →</button>
          <button type="button" data-act="left" ${i > 0 ? "" : "disabled"}><span class="ico ico-mono" style="--icon:url(assets/icons/chevron-left.svg)" aria-hidden="true"></span> 左移</button>
          <button type="button" data-act="right" ${canRight ? "" : "disabled"}>右移 <span class="ico ico-mono" style="--icon:url(assets/icons/chevron-right.svg)" aria-hidden="true"></span></button>
          <div class="spacer"></div>
          <button type="button" class="danger" data-act="delete">删除本站</button>
        </div>
        ${canOpenBranch(line) ? `<div class="row ed-branch-row">
          <button type="button" data-act="open-branch" title="以本站为分叉点新建一条支线"><span class="ico ico-mono" style="--icon:url(assets/icons/branch.svg)" aria-hidden="true"></span> 从本站开新支线</button>
          <span class="hint">非环线可用；支线会与本线共用分叉点之前（或之后）的车站。</span>
        </div>` : ""}
      </div>`;
  }

  /** 只有非环线主线、且当前站点属于该线路时才允许开新支线。 */
  function canOpenBranch(line) {
    if (!line || line.ring) return false;
    if (window.LineBranches.parseBranchName(line.name)) return false; // 支线自身不再开分支
    return (line.stations || []).length >= 2;
  }

  /**
   * 从第 index 站开启一条新支线：
   * 支线先复制分叉点及其之前（靠主干起点一侧）的共线车站，末尾追加一个待命名的新站。
   */
  function openBranchFromStation(line, index) {
    if (!canOpenBranch(line) || index < 0 || index >= line.stations.length) return;
    const identity = window.LineBranches.nextBranchIdentity(state.doc.lines, line);
    const stations = line.stations.slice(0, index + 1);
    const minutes = line.travel_minutes.slice(0, index);
    const existing = new Set(state.doc.lines.flatMap((item) => item.stations || []));
    let newName = "新站";
    let serial = 1;
    while (existing.has(newName)) {
      serial += 1;
      newName = `新站${serial}`;
    }
    stations.push(newName);
    minutes.push(3);
    const branch = normalizeLine({
      ...line,
      id: identity.id,
      name: identity.name,
      short_name: `${line.short_name || line.name}支线${identity.index > 1 ? identity.index : ""}`,
      stations,
      travel_minutes: minutes,
      ring: false,
      directions: [],
      express: [],
      first_train: line.first_train,
      last_train: line.last_train,
    });
    rebuildDirections(branch);
    const at = state.doc.lines.findIndex((item) => item.id === line.id);
    state.doc.lines.splice(at + 1, 0, branch);
    state.selectedLineId = branch.id;
    state.stationIndex = stations.length - 1;
    state.segmentIndex = -1;
    touch();
    renderAll();
    requestAnimationFrame(() => {
      const input = $("st-name");
      if (input) { input.focus(); input.select(); }
    });
    // 共线不足 3 站时不会被识别为支线分组，这里给出提示
    const shared = window.LineBranches.sharedStations(line, branch).length;
    toast(shared >= window.LineBranches.MIN_SHARED
      ? `已创建「${branch.name}」，换个站名即可`
      : `已创建「${branch.name}」：与主线共线 ${shared} 站，少于 3 站不会显示为支线分组`);
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
          <span class="hint">方向由站表自动生成；环线或自定义方向可在源码模式中直接编辑。</span>
          <div class="chips">${(line.directions || []).map((d) => `<span class="chip">${esc(d.label || "—")}</span>`).join("") || "<span class='hint'>尚未生成</span>"}</div>
          <button type="button" id="btn-rebuild-dirs">按站表重建方向</button>
        </div>
        ${renderExpressEditor(line)}
      </div>`;
  }

  /** 快车 / 大站车服务编辑：只停部分车站的列车，规划与记录均可选用。 */
  function renderExpressEditor(line) {
    const services = Array.isArray(line.express) ? line.express : [];
    const rows = services.map((svc, i) => {
      const stops = new Set(Array.isArray(svc.stops) ? svc.stops : []);
      const options = (line.stations || [])
        .map((s) => `<option value="${esc(s)}" ${stops.has(s) ? "selected" : ""}>${esc(s)}</option>`)
        .join("");
      return `
        <div class="ed-express-item" data-express="${i}">
          <div class="grid3">
            <div class="field"><span>名称</span><input data-express-field="name" data-i="${i}" type="text" value="${esc(svc.name || "")}" placeholder="如：大站车"></div>
            <div class="field"><span>服务 ID</span><input data-express-field="id" data-i="${i}" type="text" value="${esc(svc.id || "")}" placeholder="如：rapid"></div>
            <div class="field"><span>班次文字（选填）</span><input data-express-field="headway_text" data-i="${i}" type="text" value="${esc(svc.headway_text || "")}" placeholder="如：高峰 20 分钟一班"></div>
          </div>
          <div class="field">
            <span>停靠站（按住 Ctrl / ⌘ 多选，按站表顺序勾选）</span>
            <select multiple size="6" data-express-stops="${i}">${options}</select>
          </div>
          <div class="ed-express-foot">
            <span class="hint" data-express-hint="${i}">已停 ${(svc.stops || []).length} / ${(line.stations || []).length} 站；未填区间时长时按「每跳过 1 站节省 ${esc(svc.skip_minutes ?? 0.4)} 分钟」估算。</span>
            <button type="button" class="danger" data-express-del="${i}">删除该车种</button>
          </div>
        </div>`;
    }).join("");
    return `
      <div class="ed-express" id="ed-express">
        <b>快车 / 大站车</b>
        <span class="hint">定义只停部分车站的列车服务：规划器与运转记录都能选用，运行时按停靠站计算。</span>
        ${rows || '<p class="hint" style="margin:6px 0">该线路暂无快车服务。</p>'}
        <button type="button" id="btn-add-express">＋ 添加快车服务</button>
      </div>`;
  }

  /** 新建一个快车服务：默认停靠首末站，用户再勾选中间站。 */
  function addExpressService() {
    const line = selectedLine();
    if (!line) return;
    if (!Array.isArray(line.express)) line.express = [];
    const stations = line.stations || [];
    const existing = new Set(line.express.map((svc) => svc.id));
    let n = line.express.length + 1;
    while (existing.has(`express${n}`)) n += 1;
    line.express.push({
      id: `express${n}`,
      name: n === 1 ? "快车" : `快车 ${n}`,
      stops: stations.length >= 2 ? [stations[0], stations[stations.length - 1]] : [...stations],
      section_minutes: [],
      skip_minutes: 0.4,
      headway_text: "",
    });
    touch();
    renderProps();
  }

  /** 只刷新快车停靠站统计文字，避免重绘整块面板导致输入框失去焦点。 */
  function renderExpressOnly() {
    const line = selectedLine();
    const total = (line?.stations || []).length;
    document.querySelectorAll("[data-express-hint]").forEach((el) => {
      const svc = line?.express?.[Number(el.dataset.expressHint)];
      if (!svc) return;
      el.textContent =
        `已停 ${(svc.stops || []).length} / ${total} 站；未填区间时长时按「每跳过 1 站节省 ${svc.skip_minutes ?? 0.4} 分钟」估算。`;
    });
  }

  function updateExpress(index, patch) {
    const line = selectedLine();
    const svc = line?.express?.[index];
    if (!svc) return;
    Object.assign(svc, patch);
    touch();
  }

  function deleteExpress(index) {
    const line = selectedLine();
    if (!line?.express?.[index]) return;
    if (!confirm(`删除快车服务「${line.express[index].name || line.express[index].id}」？`)) return;
    line.express.splice(index, 1);
    touch();
    renderProps();
  }

  function renderCityMeta() {
    const doc = state.doc;
    if (!doc) {
      $("city-meta").innerHTML = "";
      return;
    }
    $("city-meta").innerHTML = `
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
    if (state.validating) html += `<div class="v-busy">正在校验…</div>`;
    else if (!v) html += `<div class="v-busy">等待校验…</div>`;
    else if (!v.valid) {
      html += `<div class="v-block errors"><h4>${v.errors.length} 处错误（修正后才能提交）</h4><ul>${v.errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>`;
    } else {
      html += `<div class="v-ok"><span class="ico ico-mono" style="--icon:url(assets/icons/check.svg)" aria-hidden="true"></span> 数据校验通过</div>`;
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
    const group = window.LineBranches.groupOf(state.doc.lines, id);
    const line = state.doc.lines.find((item) => item.id === id);
    if (!line) return;
    const branches = group?.main.id === id ? group.branches : [];
    const extra = branches.length ? `及其 ${branches.length} 条支线（${branches.map((b) => b.name).join("、")}）` : "";
    if (!confirm(`确定删除线路「${line.name || id}」${extra}？此操作在提交前只影响当前草稿。`)) return;
    const removed = new Set([id, ...branches.map((branch) => branch.id)]);
    state.doc.lines = state.doc.lines.filter((item) => !removed.has(item.id));
    if (removed.has(state.selectedLineId)) {
      state.selectedLineId = state.doc.lines[0]?.id || "";
      state.stationIndex = -1;
      state.segmentIndex = -1;
    }
    touch();
    renderAll();
  }

  /** 按分组上下移动：主线与其支线作为整体一起移动。 */
  function moveLine(id, delta) {
    const groups = lineGroups();
    const groupIndex = groups.findIndex((group) => group.main.id === id
      || group.branches.some((branch) => branch.id === id));
    const target = groupIndex + delta;
    if (groupIndex < 0 || target < 0 || target >= groups.length) return;
    const ordered = [...groups];
    const [moved] = ordered.splice(groupIndex, 1);
    ordered.splice(target, 0, moved);
    state.doc.lines = ordered.flatMap((group) => [group.main, ...group.branches]);
    touch();
    renderLineList();
  }

  // ---------------- 线路图交互 ----------------

  let drag = null;

  function onMapPointerDown(ev) {
    const node = ev.target.closest?.("g[data-station]");
    if (!node) return;
    const index = Number(node.dataset.station);
    // 跨线路（支线图里点到支线节点）：只做选中，不启用拖动排序
    if (node.dataset.line && node.dataset.line !== state.selectedLineId) {
      drag = { index, pointerId: ev.pointerId, moved: false, crossLine: true, node, svg: null };
      return;
    }
    drag = {
      index,
      startX: ev.clientX,
      startY: ev.clientY,
      moved: false,
      target: index,
      pointerId: ev.pointerId,
      svg: $("map").querySelector("svg"),
      node,
    };
    try {
      node.setPointerCapture?.(ev.pointerId);
    } catch { /* 合成事件或已释放的指针：忽略 */ }
  }

  function onMapPointerMove(ev) {
    if (!drag || ev.pointerId !== drag.pointerId || !drag.svg) return;
    const line = selectedLine();
    if (!line || (line.ring && ringSize(line) >= 3)) return; // 环线不支持线性拖动排序
    if (!drag.moved && Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) < 8) return;
    drag.moved = true;
    const rect = drag.svg.getBoundingClientRect();
    const viewBox = drag.svg.viewBox.baseVal;
    const scale = viewBox.width > 0 && rect.width > 0 ? viewBox.width / rect.width : 1;
    const x = (ev.clientX - rect.left) * scale;
    const { padL, gap } = state.mapMetrics || { padL: 64, gap: 100 };
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
    if (current.crossLine) {
      // 点击支线节点：切换到该支线并选中站点
      focusLineFromEvent(current.node);
      state.stationIndex = current.index;
      state.segmentIndex = -1;
      renderAll();
      return;
    }
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
    } else {
      selectStation(current.index);
    }
  }

  /** 点击支线图上的元素时，先把编辑目标切到该元素所属的线路。 */
  function focusLineFromEvent(node) {
    const lineId = node?.dataset?.line;
    if (!lineId || lineId === state.selectedLineId) return false;
    const line = state.doc?.lines.find((item) => item.id === lineId);
    if (!line) return false;
    state.selectedLineId = line.id;
    state.stationIndex = -1;
    state.segmentIndex = -1;
    renderLineList();
    return true;
  }

  function onMapClick(ev) {
    const insert = ev.target.closest("[data-insert]");
    if (insert) {
      if (focusLineFromEvent(insert)) renderMap();
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
    if (seg) {
      if (focusLineFromEvent(seg)) renderMap();
      selectSegment(Number(seg.dataset.seg));
    }
  }

  function onMapKeydown(ev) {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const station = ev.target.closest("[data-station]");
    if (station) {
      ev.preventDefault();
      if (focusLineFromEvent(station)) renderMap();
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
      toast("已导出城市数据");
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
        const closingDuplicate = line.ring && line.stations.length >= 2 && line.stations[0] === line.stations[line.stations.length - 1];
        const at = insertStation(line, closingDuplicate ? line.stations.length - 1 : line.stations.length);
        state.stationIndex = at;
        state.segmentIndex = -1;
        touch();
        renderAll();
        requestAnimationFrame(() => {
          const input = $("st-name");
          if (input) { input.focus(); input.select(); }
        });
      } else if (tool === "fill") {
        const needed = segmentCount(line);
        for (let i = 0; i < needed; i += 1) {
          const value = Number(line.travel_minutes[i]);
          if (!Number.isFinite(value)) setSegmentMinutes(line, i, 3);
        }
        touch();
        renderWorkspace();
        toast("已为缺失的区间补上 3 分钟");
      } else if (tool === "reverse") {
        if (line.ring && ringSize(line) >= 3) {
          const m = ringSize(line);
          const oldMinutes = line.travel_minutes.slice();
          const unique = line.stations.slice(0, m).reverse();
          const newMinutes = [];
          for (let j = 0; j < m; j += 1) newMinutes.push(oldMinutes[(m - 2 - j + m) % m]);
          const hasClosingDuplicate = line.stations.length > m;
          line.stations = hasClosingDuplicate ? [...unique, unique[0]] : unique;
          line.travel_minutes = hasClosingDuplicate ? [...newMinutes, oldMinutes[oldMinutes.length - 1]] : newMinutes;
        } else {
          line.stations.reverse();
          line.travel_minutes.reverse();
        }
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
        const before = line.stations[state.stationIndex];
        line.stations[state.stationIndex] = el.value;
        syncRenamedStation(line, before, el.value);
        const head = $("st-head-name");
        if (head) head.textContent = el.value || "（空站名）";
        touch();
        renderMap();
        refreshLineListSoon();
      } else if (el.id === "st-prev") {
        const prevIndex = prevSegmentIndex(line, state.stationIndex);
        if (prevIndex >= 0) setSegmentMinutes(line, prevIndex, toNumber(el.value));
        touch();
        renderMap();
      } else if (el.id === "st-next") {
        const nextIndex = nextSegmentIndex(line, state.stationIndex);
        if (nextIndex >= 0) setSegmentMinutes(line, nextIndex, toNumber(el.value));
        touch();
        renderMap();
      } else if (el.id === "seg-minutes") {
        setSegmentMinutes(line, state.segmentIndex, toNumber(el.value));
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
      if (act === "goto-main") {
        const ctx = branchContext(line);
        if (ctx?.parent) selectLine(ctx.parent.id);
        return;
      }
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
      } else if (act === "open-branch") {
        openBranchFromStation(line, index);
      }
    });

    $("view-props").addEventListener("input", onPropsInput);
    $("view-props").addEventListener("change", onPropsChange);
    $("view-props").addEventListener("click", (ev) => {
      if (ev.target.closest("#btn-add-express")) return addExpressService();
      const del = ev.target.closest("[data-express-del]");
      if (del) return deleteExpress(Number(del.dataset.expressDel));
      return undefined;
    });

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
        setJsonError(`解析失败：${err.message}`);
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

    // 窗口尺寸变化时重新计算环线半径，保证圆环完整可见
    window.addEventListener("resize", debounce(() => {
      if (state.view === "map" && selectedLine()?.ring) renderMap();
    }, 160));
  }

  function onPropsInput(ev) {
    const expressInput = ev.target.closest("[data-express-field]");
    if (expressInput) {
      const index = Number(expressInput.dataset.i);
      const key = expressInput.dataset.expressField;
      updateExpress(index, { [key]: expressInput.value });
      if (key === "name" || key === "id") renderExpressOnly();
      return;
    }
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
    const stopsSelect = ev.target.closest("[data-express-stops]");
    if (stopsSelect) {
      const index = Number(stopsSelect.dataset.expressStops);
      // 按站表顺序保存勾选的停靠站，保证快车停靠站始终有序
      const chosen = new Set([...stopsSelect.selectedOptions].map((opt) => opt.value));
      const line = selectedLine();
      const ordered = (line?.stations || []).filter((s) => chosen.has(s));
      updateExpress(index, { stops: ordered });
      renderExpressOnly();
      return;
    }
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
      setJsonError(`解析失败：${err.message}`);
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
    toast("已从源码应用修改");
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
        toast(`文件解析失败：${err.message}`);
        return;
      }
      const name = String(raw?.city || "").trim();
      if (!name) {
        toast("文件里缺少城市名（city 字段）");
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
        toast("已载入上传的数据文件");
      }
    };
    reader.readAsText(file, "utf-8");
  }

  // ---------------- 提交审核 ----------------

  function openSubmitDialog() {
    if (!state.doc) return;
    if (!state.backend) {
      toast("在线审核未启用：请先导出数据文件提交给管理员，或连接审核服务后再提交");
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
      <span class="hint">${state.doc.lines.length} 条线路 · ${state.doc.lines.reduce((sum, line) => sum + (line.ring ? ringSize(line) : line.stations.length), 0)} 站</span>`;
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
      { label: "查看审核记录", href: `review.html?submission=${encodeURIComponent(res.id)}&from=editor` },
      { label: "关闭", onClick: clearBanner },
    ], "ok");
    toast("已提交，等待管理员审核");
  }

  // ---------------- 启动 ----------------

  boot();
})();
