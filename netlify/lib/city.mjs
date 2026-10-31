/* 城市数据校验（服务端纯函数，不依赖 Netlify / 浏览器）。
 *
 * 与 Python 内核的分工：
 *   - 这里只做「结构 + 数值」的防呆校验，保证任何写入存储的数据都可被
 *     py/transit_planner/core/models.py 解析；
 *   - 方向的自动生成、区间时长计算等业务规则仍以内核为准（编辑器会额外调用内核校验）。
 */

export const MAX_BODY_BYTES = 1_500_000;

const MAX_LINES = 400;
const MAX_STATIONS_PER_LINE = 800;
const MAX_NAME_LENGTH = 40;
const MAX_REPORTED_ERRORS = 40;

// 与站点文件 / 目录同名的城市名容易被误当成静态资源，直接拒绝
const RESERVED_NAMES = new Set([
  "api", "py", "js", "css", "netlify", "index", "editor", "review", "admin",
  "data", "styles", "manifest", "favicon", "node_modules",
]);

/**
 * 规范化并校验城市名（城市名同时作为数据文件名）。
 * @param {unknown} raw
 * @returns {{ ok: true, name: string } | { ok: false, error: string }}
 */
export function sanitizeCityName(raw) {
  const name = String(raw ?? "").trim().replace(/\.json$/i, "").trim();
  if (!name) return { ok: false, error: "缺少城市名" };
  if (name.length > MAX_NAME_LENGTH) return { ok: false, error: `城市名过长（上限 ${MAX_NAME_LENGTH} 字）` };
  if (/[\\/]/.test(name) || name.includes("..")) return { ok: false, error: "城市名不能包含斜杠或 .." };
  if (/[\u0000-\u001f<>:"|?*]/.test(name)) return { ok: false, error: "城市名包含不允许的字符" };
  if (RESERVED_NAMES.has(name.toLowerCase())) return { ok: false, error: `「${name}」是保留名称，请换一个城市名` };
  return { ok: true, name };
}

/**
 * 校验一份城市 JSON 文档。
 * @param {unknown} doc
 * @returns {{ ok: boolean, errors: string[], warnings: string[], stats: { lines: number, stations: number, segments: number } }}
 */
export function validateCityDoc(doc) {
  const errors = [];
  const warnings = [];
  const stats = { lines: 0, stations: 0, segments: 0 };

  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, errors: ["城市数据必须是一个 JSON 对象"], warnings, stats };
  }

  const cityName = typeof doc.city === "string" ? doc.city.trim() : "";
  if (!cityName) errors.push("缺少城市名（city 字段）");

  if (!Array.isArray(doc.lines)) {
    errors.push("缺少线路列表（lines 必须是数组）");
    return { ok: false, errors, warnings, stats };
  }
  if (doc.lines.length === 0) errors.push("至少需要一条线路");
  if (doc.lines.length > MAX_LINES) errors.push(`线路数量超过上限（${MAX_LINES}）`);

  const idSeen = new Map();
  const nameSeen = new Set();
  const allStations = new Set();

  doc.lines.forEach((line, i) => {
    const tag = `第 ${i + 1} 条线路`;
    if (!line || typeof line !== "object" || Array.isArray(line)) {
      errors.push(`${tag}不是对象`);
      return;
    }
    const id = typeof line.id === "string" ? line.id.trim() : "";
    const lineName = typeof line.name === "string" ? line.name.trim() : "";
    const label = lineName ? `「${lineName}」` : tag;

    if (!id) errors.push(`${label}缺少线路 ID（id）`);
    else if (idSeen.has(id)) errors.push(`线路 ID「${id}」重复（${idSeen.get(id)} 与 ${tag}）`);
    else idSeen.set(id, tag);

    if (!lineName) errors.push(`${tag}缺少线路名称（name）`);
    else if (nameSeen.has(lineName)) warnings.push(`线路名称「${lineName}」重复`);
    nameSeen.add(lineName);

    if (!Array.isArray(line.stations)) {
      errors.push(`${label}缺少站表（stations 必须是数组）`);
      return;
    }
    if (line.stations.length < 2) errors.push(`${label}至少需要 2 个车站`);
    if (line.stations.length > MAX_STATIONS_PER_LINE) errors.push(`${label}车站数量超过上限（${MAX_STATIONS_PER_LINE}）`);

    const localSeen = new Set();
    line.stations.forEach((station, j) => {
      if (typeof station !== "string" || !station.trim()) {
        errors.push(`${label}第 ${j + 1} 个车站名称为空`);
        return;
      }
      const name = station.trim();
      if (localSeen.has(name)) warnings.push(`${label}站名「${name}」重复出现`);
      localSeen.add(name);
      allStations.add(name);
    });

    const minutes = line.travel_minutes;
    if (!Array.isArray(minutes)) {
      errors.push(`${label}缺少区间时长（travel_minutes 必须是数组）`);
    } else {
      // 环线若首尾重复记录闭合站，站表长度比真实站数多 1，所需区间数仍是 n-1
      const closesLoop =
        line.ring === true && line.stations.length >= 2 && line.stations[0] === line.stations[line.stations.length - 1];
      const required = line.ring === true && !closesLoop ? line.stations.length : Math.max(0, line.stations.length - 1);
      if (minutes.length < required) {
        warnings.push(`${label}区间时长不足（${minutes.length}/${required} 段），部分区段暂时无法计算`);
      } else if (minutes.length > required + 1) {
        warnings.push(`${label}区间时长比站表多 ${minutes.length - required} 段，内核会忽略多余部分`);
      }
      minutes.forEach((value, j) => {
        if (typeof value !== "number" || !Number.isFinite(value)) errors.push(`${label}第 ${j + 1} 段时长不是数字`);
        else if (value < 0) errors.push(`${label}第 ${j + 1} 段时长为负数`);
        else if (value > 300) warnings.push(`${label}第 ${j + 1} 段时长超过 300 分钟，请确认`);
      });
    }

    if (line.type != null && typeof line.type !== "string") errors.push(`${label}的交通类型（type）必须是字符串`);
    if (line.ring != null && typeof line.ring !== "boolean") errors.push(`${label}的 ring 必须是布尔值`);
    if (line.ring === true && line.stations.length < 3) warnings.push(`${label}标记为环线，但车站少于 3 个`);

    for (const key of ["headway_rush", "headway_normal"]) {
      const value = line[key];
      if (value != null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
        errors.push(`${label}的 ${key} 必须是不小于 0 的数字`);
      }
    }
    for (const key of ["color", "color2"]) {
      const value = line[key];
      if (value != null && typeof value !== "string") errors.push(`${label}的 ${key} 必须是字符串`);
      else if (value && !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) {
        warnings.push(`${label}的 ${key}「${value}」不是标准 #RGB / #RRGGBB 颜色`);
      }
    }
    if (line.directions != null) {
      if (!Array.isArray(line.directions)) errors.push(`${label}的 directions 必须是数组`);
      else {
        line.directions.forEach((direction, j) => {
          if (!direction || typeof direction !== "object" || typeof direction.label !== "string" || !direction.label.trim()) {
            errors.push(`${label}第 ${j + 1} 个方向缺少 label`);
          }
        });
      }
    }

    stats.lines += 1;
    stats.segments += Math.max(0, line.stations.length - 1);
    stats.stations += line.stations.length;
  });

  for (const key of ["transfers", "aliases"]) {
    const groups = doc[key];
    if (groups == null) continue;
    if (!Array.isArray(groups)) {
      errors.push(`${key} 必须是数组`);
      continue;
    }
    groups.forEach((group, i) => {
      if (!Array.isArray(group) || group.length < 2) errors.push(`${key} 第 ${i + 1} 组至少需要 2 个站名`);
      else if (group.some((name) => typeof name !== "string" || !name.trim())) {
        errors.push(`${key} 第 ${i + 1} 组包含空的站名`);
      }
    });
  }

  const walks = doc.external_walks;
  if (walks != null) {
    if (typeof walks !== "object" || Array.isArray(walks)) errors.push("external_walks 必须是对象");
    else {
      for (const [key, value] of Object.entries(walks)) {
        if (!key.includes("|")) warnings.push(`external_walks 的键「${key}」建议写成「站A|站B」`);
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          errors.push(`external_walks「${key}」必须是不小于 0 的数字`);
        }
      }
    }
  }

  stats.stations = allStations.size;
  const dedupErrors = [...new Set(errors)];
  return {
    ok: dedupErrors.length === 0,
    errors: dedupErrors.slice(0, MAX_REPORTED_ERRORS),
    warnings: [...new Set(warnings)].slice(0, MAX_REPORTED_ERRORS),
    stats,
  };
}
