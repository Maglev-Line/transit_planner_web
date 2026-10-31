/* 城市数据差异对比（浏览器 + 审核台 + 编辑器预览共用）。
 *
 * 输出结构化的 diff（不依赖 DOM），并提供 renderHtml() 供审核台直接展示。
 */
(() => {
  "use strict";

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeColor = (c) => (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(c || "")) ? c : "#888888");
  const SEP = "\u0000";

  const LINE_FIELDS = [
    ["name", "线路名称"],
    ["short_name", "线路简称"],
    ["type", "交通类型"],
    ["color", "主色"],
    ["color2", "副色"],
    ["operator", "运营方"],
    ["headway_rush", "高峰间隔"],
    ["headway_normal", "平峰间隔"],
    ["first_train", "首班车"],
    ["last_train", "末班车"],
    ["ring", "环线"],
  ];

  /** 经典 LCS 差分，返回 equal / add / del 操作序列。 */
  function lcsDiff(a, b) {
    const n = a.length;
    const m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const ops = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        ops.push({ type: "equal", a: a[i], b: b[j], ai: i, bi: j });
        i += 1;
        j += 1;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push({ type: "del", a: a[i], ai: i });
        i += 1;
      } else {
        ops.push({ type: "add", b: b[j], bi: j });
        j += 1;
      }
    }
    while (i < n) ops.push({ type: "del", a: a[i++], ai: i - 1 });
    while (j < m) ops.push({ type: "add", b: b[j++], bi: j - 1 });
    return ops;
  }

  /** 连续「删 + 增」视为改名，避免一改动就整站表全红。 */
  function pairRenames(ops) {
    const out = [];
    let i = 0;
    while (i < ops.length) {
      if (ops[i].type !== "del") {
        out.push(ops[i]);
        i += 1;
        continue;
      }
      const dels = [];
      while (i < ops.length && ops[i].type === "del") dels.push(ops[i++]);
      const adds = [];
      while (i < ops.length && ops[i].type === "add") adds.push(ops[i++]);
      const pairs = Math.min(dels.length, adds.length);
      for (let k = 0; k < pairs; k += 1) {
        out.push({ type: "rename", before: dels[k].a, after: adds[k].b, ai: dels[k].ai, bi: adds[k].bi });
      }
      for (let k = pairs; k < dels.length; k += 1) out.push(dels[k]);
      for (let k = pairs; k < adds.length; k += 1) out.push(adds[k]);
    }
    return out;
  }

  function diffStations(before, after) {
    const ops = pairRenames(lcsDiff(before || [], after || []));
    const result = { added: [], removed: [], renamed: [] };
    ops.forEach((op) => {
      if (op.type === "add") result.added.push({ name: op.b, index: op.bi });
      else if (op.type === "del") result.removed.push({ name: op.a, index: op.ai });
      else if (op.type === "rename") result.renamed.push({ index: op.bi, before: op.before, after: op.after });
    });
    return result;
  }

  function segmentMap(line) {
    const map = new Map();
    const stations = line?.stations || [];
    const minutes = line?.travel_minutes || [];
    for (let i = 0; i < stations.length - 1; i += 1) {
      map.set(`${stations[i]}${SEP}${stations[i + 1]}`, Number(minutes[i]));
    }
    return map;
  }

  function diffMinutes(beforeLine, afterLine) {
    const before = segmentMap(beforeLine);
    const after = segmentMap(afterLine);
    const label = (key) => key.split(SEP).join(" → ");
    const result = { added: [], removed: [], changed: [] };
    after.forEach((value, key) => {
      if (!before.has(key)) result.added.push({ seg: label(key), after: value });
      else if (before.get(key) !== value) result.changed.push({ seg: label(key), before: before.get(key), after: value });
    });
    before.forEach((value, key) => {
      if (!after.has(key)) result.removed.push({ seg: label(key), before: value });
    });
    return result;
  }

  function diffLines(beforeLines, afterLines) {
    const before = new Map();
    (beforeLines || []).forEach((line) => { if (line && line.id) before.set(line.id, line); });
    const after = new Map();
    (afterLines || []).forEach((line) => { if (line && line.id) after.set(line.id, line); });

    const added = [];
    const removed = [];
    const changed = [];
    after.forEach((line, id) => {
      if (!before.has(id)) {
        added.push({ id, name: line.name || id, stationCount: (line.stations || []).length });
        return;
      }
      const prev = before.get(id);
      const fields = [];
      LINE_FIELDS.forEach(([key, label]) => {
        const a = JSON.stringify(prev[key] ?? "");
        const b = JSON.stringify(line[key] ?? "");
        if (a !== b) fields.push({ label, before: String(prev[key] ?? "—"), after: String(line[key] ?? "—") });
      });
      const stations = diffStations(prev.stations, line.stations);
      const minutes = diffMinutes(prev, line);
      const directionsChanged = JSON.stringify(prev.directions || []) !== JSON.stringify(line.directions || []);
      if (fields.length || stations.added.length || stations.removed.length || stations.renamed.length
        || minutes.added.length || minutes.removed.length || minutes.changed.length || directionsChanged) {
        changed.push({
          id,
          name: line.name || id,
          beforeName: prev.name || id,
          color: line.color,
          color2: line.color2,
          fields,
          stations,
          minutes,
          directionsChanged,
        });
      }
    });
    before.forEach((line, id) => {
      if (!after.has(id)) removed.push({ id, name: line.name || id, stationCount: (line.stations || []).length });
    });

    const counts = { addedLines: added.length, removedLines: removed.length, changedLines: changed.length, addedStations: 0, removedStations: 0, renamedStations: 0 };
    changed.forEach((line) => {
      counts.addedStations += line.stations.added.length;
      counts.removedStations += line.stations.removed.length;
      counts.renamedStations += line.stations.renamed.length;
    });
    return { added, removed, changed, counts };
  }

  function groupKey(group) {
    return JSON.stringify([...group].map((x) => String(x)).sort());
  }

  function diffGroups(beforeGroups, afterGroups) {
    const before = new Map((beforeGroups || []).map((g) => [groupKey(g), g]));
    const after = new Map((afterGroups || []).map((g) => [groupKey(g), g]));
    const added = [];
    const removed = [];
    after.forEach((group, key) => { if (!before.has(key)) added.push(group); });
    before.forEach((group, key) => { if (!after.has(key)) removed.push(group); });
    return { added, removed };
  }

  function diffWalks(beforeWalks, afterWalks) {
    const before = beforeWalks || {};
    const after = afterWalks || {};
    const result = { added: [], removed: [], changed: [] };
    Object.entries(after).forEach(([key, value]) => {
      if (!(key in before)) result.added.push({ key, after: value });
      else if (Number(before[key]) !== Number(value)) result.changed.push({ key, before: before[key], after: value });
    });
    Object.entries(before).forEach(([key, value]) => {
      if (!(key in after)) result.removed.push({ key, before: value });
    });
    return result;
  }

  function buildSummary({ isNew, city, meta, lines, groups, walks }) {
    const parts = [];
    if (isNew) {
      parts.push(`新建城市「${city}」：${lines.counts.addedLines} 条线路`);
      return parts.join("，");
    }
    if (lines.counts.addedLines) parts.push(`新增 ${lines.counts.addedLines} 条线路`);
    if (lines.counts.removedLines) parts.push(`删除 ${lines.counts.removedLines} 条线路`);
    if (lines.counts.changedLines) parts.push(`修改 ${lines.counts.changedLines} 条线路`);
    if (lines.counts.addedStations) parts.push(`新增 ${lines.counts.addedStations} 站`);
    if (lines.counts.removedStations) parts.push(`删除 ${lines.counts.removedStations} 站`);
    if (lines.counts.renamedStations) parts.push(`重命名 ${lines.counts.renamedStations} 站`);
    const groupChanges = groups.transfers.added.length + groups.transfers.removed.length
      + groups.aliases.added.length + groups.aliases.removed.length;
    if (groupChanges) parts.push(`换乘关系 ${groupChanges} 项变更`);
    const walkChanges = walks.added.length + walks.removed.length + walks.changed.length;
    if (walkChanges) parts.push(`站外步行 ${walkChanges} 项变更`);
    if (!parts.length && meta.length) parts.push("仅修改城市基本信息");
    if (!parts.length) parts.push("数据没有变化");
    return parts.join("，");
  }

  function diff(base, next) {
    const isNew = !base;
    const b = base || {};
    const n = next || {};
    const meta = [];
    [["city", "城市名"], ["region", "地区"], ["version", "版本"]].forEach(([key, label]) => {
      const before = String(b[key] ?? "");
      const after = String(n[key] ?? "");
      if (before !== after) meta.push({ field: key, label, before, after });
    });
    const lines = diffLines(b.lines || [], n.lines || []);
    const groups = {
      transfers: diffGroups(b.transfers || [], n.transfers || []),
      aliases: diffGroups(b.aliases || [], n.aliases || []),
    };
    const walks = diffWalks(b.external_walks, n.external_walks);
    const summary = buildSummary({ isNew, city: n.city || b.city || "未命名", meta, lines, groups, walks });
    return { isNew, meta, lines, groups, walks, summary };
  }

  // ---------------- HTML 渲染 ----------------

  function fieldsTable(fields) {
    if (!fields.length) return "";
    return `<table class="diff-table"><thead><tr><th>字段</th><th>修改前</th><th>修改后</th></tr></thead><tbody>${
      fields.map((f) => `<tr><td>${esc(f.label)}</td><td class="old">${esc(f.before)}</td><td class="new">${esc(f.after)}</td></tr>`).join("")
    }</tbody></table>`;
  }

  function stationOps(stations) {
    const items = [];
    stations.added.forEach((s) => items.push(`<li class="add">＋ ${esc(s.name)} <span class="hint">第 ${s.index + 1} 站</span></li>`));
    stations.removed.forEach((s) => items.push(`<li class="del">－ ${esc(s.name)} <span class="hint">原第 ${s.index + 1} 站</span></li>`));
    stations.renamed.forEach((s) => items.push(`<li class="rename">✎ ${esc(s.before)} → <b>${esc(s.after)}</b></li>`));
    if (!items.length) return "";
    return `<ul class="diff-ops">${items.join("")}</ul>`;
  }

  function minuteOps(minutes) {
    const items = [];
    minutes.added.forEach((m) => items.push(`<li class="add">＋ ${esc(m.seg)}：${esc(m.after)} 分钟</li>`));
    minutes.removed.forEach((m) => items.push(`<li class="del">－ ${esc(m.seg)}：${esc(m.before)} 分钟</li>`));
    minutes.changed.forEach((m) => items.push(`<li class="rename">${esc(m.seg)}：${esc(m.before)} → <b>${esc(m.after)}</b> 分钟</li>`));
    if (!items.length) return "";
    return `<ul class="diff-ops">${items.join("")}</ul>`;
  }

  function renderHtml(result, { compact = false } = {}) {
    const blocks = [];
    blocks.push(`<p class="diff-summary"><b>${esc(result.summary)}</b></p>`);

    if (result.meta.length) blocks.push(fieldsTable(result.meta));

    if (result.isNew) {
      result.lines.added.forEach((line) => {
        blocks.push(`<div class="diff-line"><div class="diff-line-head"><b>${esc(line.name)}</b><span class="tag">${esc(line.id)}</span><span class="hint">${line.stationCount} 站</span></div></div>`);
      });
      return `<div class="diff">${blocks.join("")}</div>`;
    }

    if (result.lines.added.length) {
      blocks.push(`<div class="diff-group"><h4>新增线路</h4>${
        result.lines.added.map((line) => `<div class="diff-line"><div class="diff-line-head"><b>${esc(line.name)}</b><span class="tag">${esc(line.id)}</span><span class="hint">${line.stationCount} 站</span></div></div>`).join("")
      }</div>`);
    }
    if (result.lines.removed.length) {
      blocks.push(`<div class="diff-group"><h4>删除线路</h4>${
        result.lines.removed.map((line) => `<div class="diff-line removed"><div class="diff-line-head"><b>${esc(line.name)}</b><span class="tag">${esc(line.id)}</span><span class="hint">${line.stationCount} 站</span></div></div>`).join("")
      }</div>`);
    }
    if (result.lines.changed.length) {
      blocks.push(`<div class="diff-group"><h4>修改线路</h4>${
        result.lines.changed.map((line) => {
          const body = [
            fieldsTable(line.fields),
            stationOps(line.stations),
            minuteOps(line.minutes),
            line.directionsChanged ? `<p class="hint">方向定义有变化（由站表自动重建或手工指定）</p>` : "",
          ].join("");
          const swatch = line.color2
            ? `linear-gradient(90deg, ${safeColor(line.color)} 0 50%, ${safeColor(line.color2)} 50% 100%)`
            : safeColor(line.color);
          return `<div class="diff-line"><div class="diff-line-head"><span class="swatch" style="background:${swatch}"></span><b>${esc(line.name)}</b><span class="tag">${esc(line.id)}</span></div>${compact ? "" : body}</div>`;
        }).join("")
      }</div>`);
    }

    const groupBlocks = [];
    [["transfers", "转乘站组"], ["aliases", "同站异名组"]].forEach(([key, label]) => {
      const group = result.groups[key];
      group.added.forEach((g) => groupBlocks.push(`<li class="add">＋ ${esc(label)}：${esc(g.join(" ↔ "))}</li>`));
      group.removed.forEach((g) => groupBlocks.push(`<li class="del">－ ${esc(label)}：${esc(g.join(" ↔ "))}</li>`));
    });
    if (groupBlocks.length) blocks.push(`<ul class="diff-ops">${groupBlocks.join("")}</ul>`);

    const walkBlocks = [];
    result.walks.added.forEach((w) => walkBlocks.push(`<li class="add">＋ 站外步行 ${esc(w.key)}：${esc(w.after)} 分钟</li>`));
    result.walks.removed.forEach((w) => walkBlocks.push(`<li class="del">－ 站外步行 ${esc(w.key)}：${esc(w.before)} 分钟</li>`));
    result.walks.changed.forEach((w) => walkBlocks.push(`<li class="rename">站外步行 ${esc(w.key)}：${esc(w.before)} → <b>${esc(w.after)}</b> 分钟</li>`));
    if (walkBlocks.length) blocks.push(`<ul class="diff-ops">${walkBlocks.join("")}</ul>`);

    return `<div class="diff">${blocks.join("")}</div>`;
  }

  window.CityDiff = { diff, renderHtml };
})();
