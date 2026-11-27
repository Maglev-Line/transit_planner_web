/* 线路库面板（规划模式与记录模式共用）
 *
 * 列表按「线路系统」分组显示：同一系统的线路集中在一起，每条线路后面不再重复
 * 标注所属系统（详情里仍会写明系统）。单击查看线路详情；同一线路 400ms 内
 * 再次单击（双击）交给 onPick，由页面决定是预填到新行程还是新记录。
 *
 * 线路数据一律由页面从内核取（api_load_city 的摘要 / api_line 的详情），
 * 本文件只负责渲染与交互，不含任何业务计算。
 */
(() => {
  "use strict";

  /** 判定「双击」的两次单击最大间隔（毫秒）。 */
  const DOUBLE_CLICK_MS = 400;
  const SPLIT_MIN_LIST = 60;
  const SPLIT_MIN_DETAIL = 96;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
  // 双色渐变按「边框盒」铺满且不重复，避免边框区域重复平铺、两端露出另一颜色
  const swatch = (c1, c2) => (c2
    ? `linear-gradient(90deg, ${c1} 0 50%, ${c2} 50% 100%) border-box no-repeat`
    : (c1 || "#888888"));
  const isBranchName = (name) => Boolean(window.LineBranches?.parseBranchName(name));
  const servicesOf = (line) => (Array.isArray(line?.express) ? line.express : []);

  /** 同城组合的系统名形如「广州::地铁系统」，显示时写成「广州 · 地铁系统」。 */
  const systemLabel = (system) => String(system || "").replace(/::/g, " · ");

  /**
   * 按系统分组：顺序优先用城市声明的 systems，其余系统按出现顺序附后。
   * @returns {Array<{ system: string, lines: Array<object> }>}
   */
  function groupBySystem(lines, systems = []) {
    const buckets = new Map();
    (lines || []).forEach((line) => {
      const key = String(line.system || "").trim();
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(line);
    });
    const order = (systems || []).filter((system, index, list) => (
      buckets.has(system) && list.indexOf(system) === index
    ));
    buckets.forEach((_, key) => {
      if (!order.includes(key)) order.push(key);
    });
    return order.map((key) => ({ system: key, lines: buckets.get(key) }));
  }

  function lineItemHtml(line, selectedId, itemTitle = "单击查看详情，双击预填到新行程") {
    return `
      <div class="line-item${line.id === selectedId ? " active" : ""}" data-line="${esc(line.id)}" title="${esc(itemTitle)}">
        <span class="swatch" style="background:${swatch(line.color, line.color2)}"></span>
        <span class="nm">${esc(line.name)}</span>
        ${isBranchName(line.name) ? '<span class="tag tag-branch">支线</span>' : ""}
        <span class="tag">${esc(line.typeLabel)}</span>
      </div>`;
  }

  /** 每个方向自己的停靠站表（上下行不一致时）。未声明的方向按站表停靠全部车站。 */
  function skipRows(line) {
    const stops = line?.directionSkips;
    if (!stops || typeof stops !== "object") return "";
    return Object.entries(stops)
      .filter(([, stations]) => Array.isArray(stations) && stations.length)
      .map(([direction, stations]) => `<div class="kv">「${esc(direction)}」停靠 ${stations.length} 站：${esc(stations.join("、"))}</div>`)
      .join("");
  }

  /** 线路详情：站表 + 区间时长，附系统、方向、班次等信息。 */
  function detailHtml(line, prefillHint = "") {
    const travel = Array.isArray(line.travelMinutes) ? line.travelMinutes : [];
    const chain = (line.stations || []).map((station, i) => {
      const seg = i < travel.length ? `<span class="seg-min">${esc(travel[i])}′</span>` : "";
      return `<span class="st">${esc(station)}</span>${seg}`;
    }).join("");
    const services = servicesOf(line);
    return `
      <div class="kv"><b>${esc(line.name)}</b><span class="tag">${esc(line.typeLabel)}</span></div>
      ${line.system ? `<div class="kv">系统：${esc(systemLabel(line.system))}</div>` : ""}
      <div class="kv">方向：${esc((line.directions || []).join(" / "))}</div>
      <div class="kv">班次：${esc(line.headwayText)}${line.firstTrain ? ` · 首班 ${esc(line.firstTrain)}` : ""}${line.lastTrain ? ` · 末班 ${esc(line.lastTrain)}` : ""}</div>
      ${line.operator ? `<div class="kv">运营：${esc(line.operator)}</div>` : ""}
      ${line.ring ? '<div class="kv">环线（首尾闭合）</div>' : ""}
      ${services.length ? `<div class="kv">快车：${services.map((svc) => `${esc(svc.name)}（停 ${(svc.stops || []).length} 站）`).join(" / ")}</div>` : ""}
      ${skipRows(line)}
      <div class="station-chain">${chain}</div>
      ${prefillHint ? `<p class="hint" style="margin:6px 0 0">${esc(prefillHint)}</p>` : ""}`;
  }

  /**
   * 创建线路库面板控制器。
   * @param {object} options
   * - panel / list / search / detail / splitter：线路库面板内的元素
   * - resolveLine(lineId)：返回 { ok, line, error }，由页面自行缓存
   * - onPick(lineId)：双击线路时调用
   * - onSelect(line)：显示详情后调用（可选）
   * - onError(message)：读取线路详情失败时调用（可选）
   * - prefillHint：详情底部的操作提示
   * - itemTitle / emptyText / noMatchText：线路行的悬停提示、空列表与搜索无结果时的提示
   */
  function createPanel(options) {
    const { panel, list, search, detail, splitter } = options;
    const { resolveLine, onPick, onSelect, onError } = options;
    const emptyText = options.emptyText || "未加载线路库";
    const noMatchText = options.noMatchText || "没有匹配的线路";
    const prefillHint = options.prefillHint || "双击左侧线路可把该线路预填到新行程。";
    const itemTitle = options.itemTitle || "单击查看详情，双击预填到新行程";

    const state = { selectedId: "", lines: [], systems: [], drag: null, lastClick: { id: "", at: 0 } };

    // ---------------- 列表 / 详情 ----------------

    function render(lines, { systems = [] } = {}) {
      state.lines = lines || [];
      state.systems = systems || [];
      const kw = String(search?.value || "").trim().toLowerCase();
      const items = state.lines.filter((line) => (
        !kw || `${line.name} ${line.shortName} ${line.id}`.toLowerCase().includes(kw)
      ));
      if (!items.length) {
        list.innerHTML = `<p class="hint">${esc(state.lines.length ? noMatchText : emptyText)}</p>`;
        return;
      }
      const groups = groupBySystem(items, state.systems);
      const showHeaders = groups.some((group) => group.system);
      list.innerHTML = groups.map((group) => `
        <div class="line-group">
          ${showHeaders ? `<div class="line-group-title"><span>${esc(systemLabel(group.system) || "未标注系统")}</span><span class="count">${group.lines.length}</span></div>` : ""}
          ${group.lines.map((line) => lineItemHtml(line, state.selectedId, itemTitle)).join("")}
        </div>`).join("");
    }

    async function showDetail(lineId) {
      state.selectedId = lineId;
      render(state.lines, { systems: state.systems });
      const res = resolveLine(lineId);
      if (!res || !res.ok) {
        onError?.(res?.error || "无法读取该线路");
        return;
      }
      detail.hidden = false;
      splitter.hidden = false;
      detail.innerHTML = detailHtml(res.line, prefillHint);
      detail.scrollTop = 0;
      // 默认布局优先保证线路信息完整显示，之后可用分割条上下拖动调整
      fitSplit();
      onSelect?.(res.line);
    }

    function reset() {
      state.selectedId = "";
      detail.hidden = true;
      splitter.hidden = true;
      resetSplit();
    }

    function select(lineId) {
      state.selectedId = lineId;
      render(state.lines, { systems: state.systems });
    }

    // ---------------- 列表 / 详情分割条 ----------------

    function splitterVisible() {
      return !splitter.hidden && splitter.offsetParent !== null;
    }

    function splitSpace() {
      const rect = panel.getBoundingClientRect();
      const cs = getComputedStyle(panel);
      const bottom = rect.bottom - parseFloat(cs.paddingBottom) - parseFloat(cs.borderBottomWidth);
      return Math.max(0, bottom - list.getBoundingClientRect().top);
    }

    function splitterHeight() {
      const cs = getComputedStyle(splitter);
      return splitter.offsetHeight + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
    }

    function maxListHeight() {
      return Math.max(SPLIT_MIN_LIST, splitSpace() - splitterHeight() - SPLIT_MIN_DETAIL);
    }

    function setListHeight(px) {
      list.style.flexBasis = `${Math.max(0, Math.round(px))}px`;
    }

    function resetSplit() {
      list.style.flexBasis = "";
      panel.classList.remove("has-detail", "dragging");
    }

    /** 详情的自然高度：临时解除 flex 拉伸，量完立即还原。 */
    function detailNaturalHeight() {
      const prev = detail.style.flex;
      detail.style.flex = "0 0 auto";
      const height = detail.scrollHeight;
      detail.style.flex = prev;
      return height + 2;
    }

    /** 默认布局：优先给足详情高度，列表占用剩余空间；详情过长时才在内部滚动。 */
    function fitSplit() {
      panel.classList.add("has-detail");
      if (!splitterVisible()) {
        list.style.flexBasis = "";
        return;
      }
      const available = splitSpace() - splitterHeight();
      const listHeight = available - detailNaturalHeight();
      setListHeight(Math.min(Math.max(listHeight, SPLIT_MIN_LIST), maxListHeight()));
    }

    splitter.addEventListener("pointerdown", (ev) => {
      if (ev.pointerType === "mouse" && ev.button !== 0) return;
      ev.preventDefault();
      state.drag = { y: ev.clientY, height: list.getBoundingClientRect().height };
      splitter.setPointerCapture(ev.pointerId);
      panel.classList.add("dragging");
    });
    splitter.addEventListener("pointermove", (ev) => {
      if (!state.drag) return;
      const height = state.drag.height + (ev.clientY - state.drag.y);
      setListHeight(Math.min(Math.max(height, SPLIT_MIN_LIST), maxListHeight()));
    });
    const stopDrag = () => {
      state.drag = null;
      panel.classList.remove("dragging");
    };
    splitter.addEventListener("pointerup", stopDrag);
    splitter.addEventListener("pointercancel", stopDrag);
    splitter.addEventListener("lostpointercapture", stopDrag);
    splitter.addEventListener("dblclick", fitSplit);

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
    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!splitterVisible()) list.style.flexBasis = "";
      }, 150);
    });

    // ---------------- 搜索与单击 / 双击 ----------------

    let searchTimer = null;
    search?.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => render(state.lines, { systems: state.systems }), 150);
    });

    // 注意：这里不能用原生 dblclick——单击会重绘线路列表、替换掉被点的节点，
    // 浏览器便不再对列表派发 dblclick，双击会完全没有反应。
    list.addEventListener("click", async (ev) => {
      const item = ev.target.closest("[data-line]");
      if (!item) return;
      const id = item.dataset.line;
      const now = Date.now();
      const isDouble = state.lastClick.id === id && now - state.lastClick.at < DOUBLE_CLICK_MS;
      state.lastClick = isDouble ? { id: "", at: 0 } : { id, at: now };
      if (isDouble) {
        if (onPick) await onPick(id);
        return;
      }
      await showDetail(id);
    });

    return { render, showDetail, reset, select, fitSplit };
  }

  window.LineLibrary = {
    DOUBLE_CLICK_MS,
    groupBySystem,
    lineItemHtml,
    detailHtml,
    createPanel,
  };
})();
