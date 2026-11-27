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

  let systemCatalog = null;
  if (Object.hasOwn(doc, "systems")) {
    if (!Array.isArray(doc.systems)) {
      errors.push("systems 必须是字符串数组");
    } else {
      systemCatalog = new Set();
      doc.systems.forEach((system, i) => {
        if (typeof system !== "string" || !system.trim()) {
          errors.push(`第 ${i + 1} 个系统名称必须是非空字符串`);
        } else if (systemCatalog.has(system.trim())) {
          errors.push(`系统名称「${system.trim()}」重复`);
        } else {
          systemCatalog.add(system.trim());
        }
      });
    }
  }

  if (Object.hasOwn(doc, "combined_shared_stations")) {
    if (!Array.isArray(doc.combined_shared_stations)) {
      errors.push("combined_shared_stations 必须是字符串数组");
    } else {
      doc.combined_shared_stations.forEach((name, i) => {
        if (typeof name !== "string" || !name.trim()) {
          errors.push(`第 ${i + 1} 个同城组合共用车站必须是非空字符串`);
        }
      });
    }
  }

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
    if (line.system != null && typeof line.system !== "string") {
      errors.push(`${label}的 system 必须是字符串`);
    } else if (systemCatalog && (
      (systemCatalog.size && !systemCatalog.has(String(line.system || "").trim()))
      || (!systemCatalog.size && String(line.system || "").trim())
    )) {
      errors.push(`${label}所属系统「${line.system || ""}」未在 systems 中声明`);
    }

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

    // 快车 / 大站车：只停部分车站的列车服务
    if (line.express != null) {
      if (!Array.isArray(line.express)) {
        errors.push(`${label}的 express（快车服务）必须是数组`);
      } else {
        const order = new Map(line.stations.map((station, index) => [station, index]));
        const seenServiceIds = new Set();
        line.express.forEach((service, j) => {
          const serviceLabel = `${label}第 ${j + 1} 个快车服务`;
          if (!service || typeof service !== "object") {
            errors.push(`${serviceLabel}必须是对象`);
            return;
          }
          if (typeof service.name !== "string" || !service.name.trim()) errors.push(`${serviceLabel}缺少名称（name）`);
          if (service.id != null && typeof service.id !== "string") errors.push(`${serviceLabel}的 id 必须是字符串`);
          const serviceId = typeof service.id === "string" ? service.id.trim() : "";
          if (serviceId) {
            if (seenServiceIds.has(serviceId)) errors.push(`${label}快车服务 ID「${serviceId}」重复`);
            seenServiceIds.add(serviceId);
          }
          if (!Array.isArray(service.stops)) {
            errors.push(`${serviceLabel}缺少停靠站（stops 必须是数组）`);
            return;
          }
          if (service.stops.length < 2) errors.push(`${serviceLabel}至少需要 2 个停靠站`);
          if (service.stops.length >= line.stations.length) {
            warnings.push(`${serviceLabel}停靠全部车站，与普通车没有区别`);
          }
          let previous = -1;
          service.stops.forEach((station) => {
            const index = order.get(station);
            if (index === undefined) {
              errors.push(`${serviceLabel}的停靠站「${station}」不在本站表内`);
              return;
            }
            if (index <= previous) errors.push(`${serviceLabel}的停靠站需按站表顺序排列且不重复`);
            previous = index;
          });
          if (service.section_minutes != null) {
            if (!Array.isArray(service.section_minutes)) {
              errors.push(`${serviceLabel}的 section_minutes 必须是数组`);
            } else if (service.section_minutes.length && service.section_minutes.length !== service.stops.length - 1) {
              errors.push(`${serviceLabel}的 section_minutes 长度应为 ${Math.max(0, service.stops.length - 1)}`);
            } else if (service.section_minutes.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
              errors.push(`${serviceLabel}的 section_minutes 必须是不小于 0 的数字`);
            }
          }
          if (service.skip_minutes != null
            && (typeof service.skip_minutes !== "number" || !Number.isFinite(service.skip_minutes) || service.skip_minutes < 0)) {
            errors.push(`${serviceLabel}的 skip_minutes 必须是不小于 0 的数字`);
          }
          if (service.headway_text != null && typeof service.headway_text !== "string") {
            errors.push(`${serviceLabel}的 headway_text 必须是字符串`);
          }
        });
      }
    }

    if (line.direction_stops != null) {
      const stops = line.direction_stops;
      if (typeof stops !== "object" || Array.isArray(stops)) {
        errors.push(`${label}的 direction_stops 必须是「方向 → 停靠站数组」对象`);
      } else {
        const stationSet = new Set(line.stations.filter((s) => typeof s === "string"));
        Object.entries(stops).forEach(([direction, stations]) => {
          if (!Array.isArray(stations)) {
            errors.push(`${label}的「${direction}」停靠站必须是数组`);
            return;
          }
          if (stations.length < 2) {
            errors.push(`${label}的「${direction}」至少需要 2 个停靠站`);
          }
          stations.forEach((station) => {
            if (typeof station !== "string" || !station.trim()) {
              errors.push(`${label}的「${direction}」停靠站名称不能为空`);
            } else if (!stationSet.has(station.trim())) {
              errors.push(`${label}的「${direction}」停靠站「${station}」不在本站表内`);
            }
          });
        });
      }
    }

    stats.lines += 1;
    stats.segments += Math.max(0, line.stations.length - 1);
    stats.stations += line.stations.length;
  });

  if (doc.through_services != null) {
    if (!Array.isArray(doc.through_services)) {
      errors.push("through_services 必须是数组");
    } else {
      const lineById = new Map(doc.lines
        .filter((line) => line && typeof line === "object" && !Array.isArray(line))
        .map((line) => [line.id, line]));
      const seenIds = new Set(lineById.keys());
      doc.through_services.forEach((service, i) => {
        const label = `第 ${i + 1} 个贯通交路`;
        if (!service || typeof service !== "object" || Array.isArray(service)) {
          errors.push(`${label}必须是对象`);
          return;
        }
        const id = typeof service.id === "string" ? service.id.trim() : "";
        if (!id) errors.push(`${label}缺少 id`);
        else if (seenIds.has(id)) errors.push(`贯通交路 ID「${id}」重复`);
        else seenIds.add(id);
        if (typeof service.name !== "string" || !service.name.trim()) errors.push(`${label}缺少 name`);
        if (!Array.isArray(service.segments) || service.segments.length === 0) {
          errors.push(`${label}至少需要一个线路区段（segments）`);
          return;
        }

        const routeStations = [];
        let previousStation = "";
        service.segments.forEach((section, j) => {
          const sectionLabel = `${label}第 ${j + 1} 个区段`;
          const source = section && typeof section.line_id === "string" ? lineById.get(section.line_id) : null;
          if (!source) {
            errors.push(`${sectionLabel}引用了不存在的线路`);
            return;
          }
          if (!Array.isArray(source.stations)) return;
          const ring = source.ring === true;
          const closesRing = ring && source.stations.length > 1
            && source.stations[0] === source.stations[source.stations.length - 1];
          const stationCount = source.stations.length - (closesRing ? 1 : 0);
          const stations = source.stations.slice(0, stationCount);
          const start = stations.indexOf(section.from_station);
          const end = stations.indexOf(section.to_station);
          if (start < 0 || end < 0 || start === end) {
            errors.push(`${sectionLabel}的起终站无效`);
            return;
          }
          if (section.reverse != null && typeof section.reverse !== "boolean") {
            errors.push(`${sectionLabel}的 reverse 必须是布尔值`);
            return;
          }
          if (previousStation && previousStation !== section.from_station) {
            errors.push(`${sectionLabel}未与前一区段在同一车站衔接`);
          }
          if (!ring && section.reverse === true) {
            errors.push(`${sectionLabel}的 reverse 仅适用于环线区段`);
          }
          const sign = ring
            ? (section.reverse === true ? -1 : 1)
            : (start < end ? 1 : -1);
          const sectionStations = [stations[start]];
          const minuteIndexes = [];
          let current = start;
          while (current !== end) {
            const next = ring
              ? (current + sign + stationCount) % stationCount
              : current + sign;
            minuteIndexes.push(sign > 0 ? current : (ring ? (current - 1 + stationCount) % stationCount : current - 1));
            current = next;
            sectionStations.push(stations[current]);
            if (sectionStations.length > stationCount + 1) {
              errors.push(`${sectionLabel}无法沿线路到达终点`);
              return;
            }
          }
          if (!Array.isArray(source.travel_minutes)
            || minuteIndexes.some((index) => index < 0 || index >= source.travel_minutes.length)) {
            errors.push(`${sectionLabel}的线路区间时长不完整`);
          }
          routeStations.push(...(routeStations.length ? sectionStations.slice(1) : sectionStations));
          previousStation = section.to_station;
        });

        for (const key of ["headway_rush", "headway_normal"]) {
          if (service[key] != null && (typeof service[key] !== "number" || !Number.isFinite(service[key]) || service[key] < 0)) {
            errors.push(`${label}的 ${key} 必须是不小于 0 的数字`);
          }
        }
        if (service.express != null) {
          if (!Array.isArray(service.express)) {
            errors.push(`${label}的 express 必须是数组`);
          } else {
            const seenExpressIds = new Set();
            service.express.forEach((express, j) => {
              const expressLabel = `${label}的第 ${j + 1} 个快车服务`;
              if (!express || typeof express !== "object") {
                errors.push(`${expressLabel}必须是对象`);
                return;
              }
              if (typeof express.name !== "string" || !express.name.trim()) errors.push(`${expressLabel}缺少 name`);
              if (express.id != null && typeof express.id !== "string") {
                errors.push(`${expressLabel}的 id 必须是字符串`);
              }
              const expressId = typeof express.id === "string" ? express.id.trim() : "";
              if (expressId) {
                if (seenExpressIds.has(expressId)) errors.push(`${label}快车服务 ID「${expressId}」重复`);
                seenExpressIds.add(expressId);
              }
              if (!Array.isArray(express.stops) || express.stops.length < 2) {
                errors.push(`${expressLabel}至少需要 2 个停靠站`);
                return;
              }
              let previous = -1;
              express.stops.forEach((station) => {
                const index = routeStations.indexOf(station);
                if (index < 0) errors.push(`${expressLabel}的停靠站「${station}」不在贯通交路内`);
                else if (index <= previous) errors.push(`${expressLabel}的停靠站需按交路顺序列出且不重复`);
                else previous = index;
              });
              if (express.section_minutes != null
                && (!Array.isArray(express.section_minutes)
                  || (express.section_minutes.length > 0 && express.section_minutes.length !== express.stops.length - 1)
                  || express.section_minutes.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0))) {
                errors.push(`${expressLabel}的 section_minutes 长度或数值无效`);
              }
              if (express.skip_minutes != null
                && (typeof express.skip_minutes !== "number" || !Number.isFinite(express.skip_minutes) || express.skip_minutes < 0)) {
                errors.push(`${expressLabel}的 skip_minutes 必须是不小于 0 的数字`);
              }
              if (express.headway_text != null && typeof express.headway_text !== "string") {
                errors.push(`${expressLabel}的 headway_text 必须是字符串`);
              }
            });
          }
        }
      });
    }
  }

  const knownSystemStations = new Set();
  doc.lines.forEach((line) => {
    if (!line || typeof line !== "object" || !Array.isArray(line.stations)) return;
    const system = typeof line.system === "string" ? line.system.trim() : "";
    line.stations.forEach((station) => {
      if (typeof station === "string") knownSystemStations.add(`${system}\u0000${station.trim()}`);
    });
  });

  // 强互通系统：只登记车站名称、没有线路数据的系统（如广东城际、国家铁路）
  if (Object.hasOwn(doc, "station_systems")) {
    const raw = doc.station_systems;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push("station_systems 必须是对象（系统名 → 车站数组）");
    } else {
      Object.entries(raw).forEach(([name, value]) => {
        const label = `强互通系统「${name}」`;
        if (!name.trim()) errors.push("station_systems 中存在空的系统名称");
        const stations = Array.isArray(value)
          ? value
          : (value && typeof value === "object" && Array.isArray(value.stations) ? value.stations : null);
        if (!stations) {
          errors.push(`${label}的车站必须是数组`);
          return;
        }
        if (value && !Array.isArray(value) && value.type != null && typeof value.type !== "string") {
          errors.push(`${label}的 type 必须是字符串`);
        }
        if (!stations.length) warnings.push(`${label}没有登记车站`);
        stations.forEach((station, i) => {
          if (typeof station !== "string" || !station.trim()) {
            errors.push(`${label}第 ${i + 1} 个车站名称为空`);
            return;
          }
          knownSystemStations.add(`${name.trim()}\u0000${station.trim()}`);
        });
      });
    }
  }

  for (const key of ["transfers", "aliases"]) {
    const groups = doc[key];
    if (groups == null) continue;
    if (!Array.isArray(groups)) {
      errors.push(`${key} 必须是数组`);
      continue;
    }
    groups.forEach((group, i) => {
      if (!Array.isArray(group) || group.length < 2) {
        errors.push(`${key} 第 ${i + 1} 组至少需要 2 个${key === "transfers" ? "站点端点" : "站名"}`);
      } else if (key === "transfers") {
        const explicitSystems = new Set();
        let hasLegacyEndpoint = false;
        group.forEach((endpoint) => {
          if (typeof endpoint === "string") {
            hasLegacyEndpoint = true;
            if (!endpoint.trim()) errors.push(`${key} 第 ${i + 1} 组包含空站名`);
            else warnings.push(`${key} 第 ${i + 1} 组仍使用旧格式站名「${endpoint}」`);
            return;
          }
          if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) {
            errors.push(`${key} 第 ${i + 1} 组的端点必须是对象`);
            return;
          }
          const station = typeof endpoint.station === "string" ? endpoint.station.trim() : "";
          const system = typeof endpoint.system === "string" ? endpoint.system.trim() : "";
          if (!station) errors.push(`${key} 第 ${i + 1} 组的端点缺少 station`);
          if (!system) errors.push(`${key} 第 ${i + 1} 组的「${station}」端点缺少 system`);
          else explicitSystems.add(system);
          if (station && system && !knownSystemStations.has(`${system}\u0000${station}`)) {
            errors.push(`${key} 第 ${i + 1} 组的端点「${system}|${station}」无法匹配到线路或强互通系统车站`);
          }
        });
        if (!hasLegacyEndpoint && explicitSystems.size < 2) {
          errors.push(`${key} 第 ${i + 1} 组的端点必须跨越至少 2 个系统`);
        }
      } else if (group.some((name) => typeof name !== "string" || !name.trim())) {
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
