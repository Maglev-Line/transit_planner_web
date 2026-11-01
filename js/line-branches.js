/* 支线识别与几何计算（数据工坊与规划器共用）
 *
 * 数据格式不变：支线仍是一条独立线路（名称 = 主线名 + 「支线」），
 * 与主线共用一段主干站。满足以下全部条件时才认定为支线：
 *   1. 名称形如「X支线」（可带序号，如「X支线2」）；
 *   2. 与主线标志色相同；
 *   3. 与主线的共线车站超过 2 站（即 ≥ 3 站）。
 * 这样既能识别 Y 型（末端分叉），也能识别两头分叉（支线在主线头部另起一段）。
 */
(() => {
  "use strict";

  /** 最少共线站数（超过 2 站）。 */
  const MIN_SHARED = 3;

  const normColor = (c) => String(c || "").trim().toLowerCase();

  /** 「上海地铁5号线支线2」→ { base: "上海地铁5号线", index: 2 }；非支线返回 null。 */
  function parseBranchName(name) {
    const text = String(name || "").trim();
    const m = /^(.*?)支线\s*(\d+)?$/.exec(text);
    if (!m || !m[1].trim()) return null;
    return { base: m[1].trim(), index: m[2] ? Number(m[2]) : 1 };
  }

  /** 两条线路的共线车站数（不要求连续）。 */
  function sharedStations(a, b) {
    const set = new Set(a.stations || []);
    return (b.stations || []).filter((s) => set.has(s));
  }

  /** 两条线路中最长的公共连续区段（在双方站表里都连续）。 */
  function longestCommonRun(a, b) {
    const A = a.stations || [];
    const B = b.stations || [];
    const indexOfB = new Map(B.map((s, i) => [s, i]));
    let best = { aStart: 0, bStart: 0, length: 0 };
    for (let i = 0; i < A.length; i += 1) {
      const j = indexOfB.get(A[i]);
      if (j === undefined) continue;
      if (i > 0 && B[j - 1] === A[i - 1]) continue; // 不是区段起点
      let len = 0;
      while (i + len < A.length && j + len < B.length && A[i + len] === B[j + len]) len += 1;
      if (len > best.length) best = { aStart: i, bStart: j, length: len };
    }
    return best;
  }

  /**
   * 判断 branch 是否可视为 main 的支线。
   * @returns {{ main: object, line: object, shared: string[], run: object } | null}
   */
  function matchBranch(main, line) {
    if (!main || !line || main.id === line.id) return null;
    if (main.ring) return null;
    const parsed = parseBranchName(line.name);
    if (!parsed || parsed.base !== String(main.name || "").trim()) return null;
    if (normColor(main.color) !== normColor(line.color)) return null;
    const shared = sharedStations(main, line);
    if (shared.length <= MIN_SHARED - 1) return null;
    return { main, line, shared, run: longestCommonRun(main, line) };
  }

  /**
   * 把城市里的线路分组：主线 + 其支线。
   * @param {Array<object>} lines
   * @returns {Array<{ key: string, main: object, branches: Array<object> }>}
   */
  function groupLines(lines) {
    const list = Array.isArray(lines) ? lines : [];
    const branchesOf = new Map();
    for (const line of list) {
      const parsed = parseBranchName(line.name);
      if (!parsed) continue;
      const main = list.find((candidate) => (
        candidate !== line
        && String(candidate.name || "").trim() === parsed.base
        && !parseBranchName(candidate.name)
        && matchBranch(candidate, line)
      ));
      if (!main) continue;
      if (!branchesOf.has(main.id)) branchesOf.set(main.id, []);
      branchesOf.get(main.id).push(line);
    }

    const used = new Set();
    const groups = [];
    for (const line of list) {
      if (used.has(line.id)) continue;
      const branches = branchesOf.get(line.id) || [];
      used.add(line.id);
      branches.forEach((branch) => used.add(branch.id));
      groups.push({ key: line.id, main: line, branches });
    }
    return groups;
  }

  /** 某条线路所属的分组（支线会返回其主线分组）。 */
  function groupOf(lines, lineId) {
    const groups = groupLines(lines);
    return groups.find((group) => group.main.id === lineId
      || group.branches.some((branch) => branch.id === lineId)) || null;
  }

  /** 站名是否只属于支线（不在主线站表内）。 */
  function isBranchOnly(group, station) {
    return group.branches.some((branch) => (
      (branch.stations || []).includes(station) && !(group.main.stations || []).includes(station)
    ));
  }

  /** 分组的总站数（主线站表 + 各支线独有站）。 */
  function groupStationCount(group) {
    const seen = new Set(group.main.stations || []);
    group.branches.forEach((branch) => {
      (branch.stations || []).forEach((station) => seen.add(station));
    });
    return seen.size;
  }

  /** 分组的外形：末端分叉 / 头部另起 / 中部多分叉（用于界面提示）。 */
  function groupShape(group) {
    const shapes = group.branches.map((branch) => {
      const run = longestCommonRun(group.main, branch);
      const before = run.bStart > 0;
      const after = run.bStart + run.length < (branch.stations || []).length;
      if (before && after) return "middle";
      if (before) return "head";
      return "tail";
    });
    if (!shapes.length) return "";
    const unique = [...new Set(shapes)];
    if (unique.length > 1) return "复合分叉";
    return { tail: "末端分叉（Y 型）", head: "头部另起（两头分叉）", middle: "中部支线" }[unique[0]] || "";
  }

  /** 生成不与现有线路冲突的支线 id / 名称。 */
  function nextBranchIdentity(lines, main) {
    const existingNames = new Set((lines || []).map((line) => String(line.name || "").trim()));
    const existingIds = new Set((lines || []).map((line) => String(line.id || "")));
    let index = 1;
    let name = `${main.name}支线`;
    while (existingNames.has(name)) {
      index += 1;
      name = `${main.name}支线${index}`;
    }
    let id = `${main.id}_b${index}`;
    let salt = 1;
    while (existingIds.has(id)) {
      id = `${main.id}_b${index}_${salt}`;
      salt += 1;
    }
    return { id, name, index };
  }

  window.LineBranches = {
    MIN_SHARED,
    parseBranchName,
    sharedStations,
    longestCommonRun,
    matchBranch,
    groupLines,
    groupOf,
    isBranchOnly,
    groupStationCount,
    groupShape,
    nextBranchIdentity,
  };
})();
