# -*- coding: utf-8 -*-
"""智能规划：按换乘次数与出行时间给出若干最优方案（Web 端专用）。

本模块只新增 Web 端的路线搜索能力，复用 `transit_planner.core` 的城市数据、
方向判定与区间时长计算，不改动共享规划内核。

搜索模型：
- 节点 = （线路, 站表下标）；
- 乘车边 = 线路上相邻两站，耗时取 travel_minutes；
- 换乘边 = 同一车站（含同站异名）换乘耗时 0；跨付费系统转乘按默认步行分钟计；
- 状态额外记录已换乘次数，从而得到「不同换乘次数下的最短时间」，
  再按 (时间 + 换乘折算分钟 × 换乘次数) 排序，并提供最快 / 少换乘等方案。
"""
from __future__ import annotations

import heapq
import itertools
from dataclasses import dataclass
from typing import Iterable

from transit_planner.core import engine
from transit_planner.core.models import City, Direction, Line, LineError

TRANSFER_PENALTY = 4.0   # 每次换乘折算的分钟数，仅用于综合排序
MAX_TRANSFERS = 6        # 搜索时允许的最大换乘次数
MAX_PLANS = 5            # 最多返回的方案数


@dataclass(frozen=True)
class _Edge:
    kind: str                       # ride / transfer
    start: tuple[str, int]
    end: tuple[str, int]
    minutes: float
    sign: int = 0                   # 乘车边：+1 沿站表向前，-1 沿站表向后
    is_transfer: bool = False       # 换乘边是否跨付费系统


_Last = tuple[str, int]
_LabelKey = tuple[tuple[str, int], int, _Last]


@dataclass
class _Label:
    minutes: float
    prev: _LabelKey | None
    edge: _Edge | None


def _unique_count(line: Line) -> int:
    """环线闭合站去重后的真实站数（与内核保持一致）。"""
    n = len(line.stations)
    if line.ring and n >= 2 and line.stations[0] == line.stations[-1]:
        return n - 1
    return n


def _station_lines(city: City) -> dict[str, list[tuple[Line, int]]]:
    """站名 → 停靠线路与站表下标（环线闭合站只保留一个下标）。"""
    out: dict[str, list[tuple[Line, int]]] = {}
    for line in city.lines:
        for idx in range(_unique_count(line)):
            out.setdefault(line.stations[idx], []).append((line, idx))
    return out


def _ride_edges(city: City) -> dict[tuple[str, int], list[_Edge]]:
    """构建相邻车站之间的双向乘车边。"""
    edges: dict[tuple[str, int], list[_Edge]] = {}
    for line in city.lines:
        count = _unique_count(line)
        if count < 2:
            continue
        if line.ring:
            for i in range(count):
                j = (i + 1) % count
                if i >= len(line.travel_minutes):
                    continue
                minutes = float(line.travel_minutes[i])
                if minutes < 0:
                    continue
                start, end = (line.id, i), (line.id, j)
                edges.setdefault(start, []).append(_Edge("ride", start, end, minutes, 1))
                edges.setdefault(end, []).append(_Edge("ride", end, start, minutes, -1))
        else:
            for i in range(count - 1):
                if i >= len(line.travel_minutes):
                    continue
                minutes = float(line.travel_minutes[i])
                if minutes < 0:
                    continue
                start, end = (line.id, i), (line.id, i + 1)
                edges.setdefault(start, []).append(_Edge("ride", start, end, minutes, 1))
                edges.setdefault(end, []).append(_Edge("ride", end, start, minutes, -1))
    return edges


def _transfer_options(city: City, station_lines: dict[str, list[tuple[Line, int]]],
                      line_by_id: dict[str, Line], default_walk: float):
    """返回一个函数：节点 → 可换乘的边。结果按节点缓存。"""
    cache: dict[tuple[str, int], list[_Edge]] = {}
    transfer_groups = [set(group) for group in city.transfers]
    alias_groups = [set(group) for group in city.aliases]

    def options(node: tuple[str, int]) -> list[_Edge]:
        if node in cache:
            return cache[node]
        line = line_by_id[node[0]]
        station = line.stations[node[1]]
        best: dict[tuple[str, int], _Edge] = {}

        def add(other_line: Line, other_idx: int, minutes: float, is_transfer: bool) -> None:
            target = (other_line.id, other_idx)
            if target == node:
                return
            prev = best.get(target)
            if prev is None or (minutes, is_transfer) < (prev.minutes, prev.is_transfer):
                best[target] = _Edge("transfer", node, target, minutes, 0, is_transfer)

        alias_names = {station}
        for group in alias_groups:
            if station in group:
                alias_names |= group
        for name in alias_names:
            for other_line, other_idx in station_lines.get(name, ()):
                if other_line.id != line.id:
                    add(other_line, other_idx, 0.0, False)
        for group in transfer_groups:
            if station not in group:
                continue
            for name in group:
                if name == station:
                    continue
                for other_line, other_idx in station_lines.get(name, ()):
                    if other_line.id != line.id:
                        add(other_line, other_idx, default_walk, True)
        cache[node] = list(best.values())
        return cache[node]

    return options


def _dijkstra(starts: Iterable[tuple[str, int]], ride_edges: dict, transfer_options,
              max_transfers: int, exclude_line_id: str = "") -> tuple[dict, dict]:
    """多标签 Dijkstra：键 = (节点, 换乘次数, 最后一步类型)。

    最后一步类型用 (kind, sign) 表示：乘车为 ("ride", ±1)，换乘为 ("transfer", 0)，
    起点为 ("start", 0)。保留「同时间但来向不同」的标签，才能同时保留
    「从 A 方向进入」和「从 B 方向进入」的后续可能，避免同时间折返方案把正常方案挤掉。

    返回 (labels, ride_labels)：
    - labels 用于继续搜索；
    - ride_labels 只记录「最后一步是乘车」的标签，供方案终点使用。
    """
    Last = tuple[str, int]
    LabelKey = tuple[tuple[str, int], int, Last]
    labels: dict[LabelKey, _Label] = {}
    ride_labels: dict[LabelKey, _Label] = {}
    heap: list[tuple[float, int, tuple[str, int], int, Last]] = []
    counter = itertools.count()

    def push(node: tuple[str, int], transfers: int, minutes: float,
             prev: LabelKey | None, edge: _Edge | None, last: Last) -> None:
        # 先记录乘车终点，即使该状态随后被同时间的换乘标签占位
        if edge is not None and edge.kind == "ride":
            ride_key = (node, transfers, last)
            current = ride_labels.get(ride_key)
            if current is None or minutes < current.minutes - 1e-9:
                ride_labels[ride_key] = _Label(minutes, prev, edge)

        key = (node, transfers, last)
        current = labels.get(key)
        if current is not None and current.minutes <= minutes + 1e-9:
            return
        # 只与「来向相同」的标签比较，避免不同来向的等时标签互相挤出
        for t in range(transfers + 1):
            other = labels.get((node, t, last))
            if other is not None and other.minutes <= minutes + 1e-9:
                return
        labels[key] = _Label(minutes, prev, edge)
        heapq.heappush(heap, (minutes, next(counter), node, transfers, last))

    for node in starts:
        push(node, 0, 0.0, None, None, ("start", 0))

    while heap:
        minutes, _, node, transfers, last = heapq.heappop(heap)
        key = (node, transfers, last)
        label = labels.get(key)
        if label is None or label.minutes + 1e-9 < minutes:
            continue
        parent_edge = label.edge
        for edge in ride_edges.get(node, ()):
            if exclude_line_id and edge.end[0] == exclude_line_id:
                continue
            if edge.end[0] != node[0]:
                continue
            # 同一条线路上原地折返永远不会更优，直接剪掉，避免出现绕一圈再坐回来的方案
            if (parent_edge is not None and parent_edge.kind == "ride"
                    and parent_edge.end[0] == edge.start[0]
                    and parent_edge.sign and edge.sign == -parent_edge.sign):
                continue
            push(edge.end, transfers, minutes + edge.minutes, key, edge, ("ride", edge.sign))
        if transfers >= max_transfers:
            continue
        for edge in transfer_options(node):
            if exclude_line_id and edge.end[0] == exclude_line_id:
                continue
            push(edge.end, transfers + 1, minutes + edge.minutes, key, edge, ("transfer", 0))

    return labels, ride_labels


def _direction_for(line: Line, sign: int, from_station: str, to_station: str) -> Direction:
    """按乘车走向选择方向标签。"""
    for direction in line.directions:
        try:
            if engine.direction_sign(line, direction) == sign:
                return direction
        except LineError:
            continue
    picked = engine.pick_direction(line, from_station, to_station)
    if picked is not None:
        return picked
    if line.directions:
        return line.directions[0]
    return Direction(label="手动方向")


def _ring_loop(line: Line, start_idx: int, sign: int) -> tuple[list[str], float]:
    """环线从 start_idx 沿 sign 走一整圈，返回（含起终点的站序, 运行分钟）。"""
    count = _unique_count(line)
    stops = [line.stations[(start_idx + k * sign) % count] for k in range(count + 1)]
    minutes = 0.0
    for k in range(count):
        index = (start_idx + k * sign) % count
        segment = index if sign > 0 else (index - 1) % count
        if segment < len(line.travel_minutes):
            minutes += float(line.travel_minutes[segment])
    return stops, minutes


def _edges_from_ride(labels: dict, ride_labels: dict,
                     key: _LabelKey) -> tuple[tuple[str, int], list[_Edge]]:
    """从「最后一步是乘车」的标签回溯完整路径。"""
    label = ride_labels[key]
    edges: list[_Edge] = [label.edge] if label.edge is not None else []
    prev = label.prev
    start_key = key
    while prev is not None:
        parent = labels.get(prev)
        if parent is None:
            break
        if parent.edge is not None:
            edges.append(parent.edge)
        start_key = prev
        prev = parent.prev
    return start_key[0], list(reversed(edges))


def _path_to_legs(city: City, line_by_id: dict[str, Line], start_node: tuple[str, int],
                  edges: list[_Edge], default_walk: float) -> list[dict]:
    """把节点/边路径压缩成「乘车段」列表。"""
    raw: list[dict] = []
    current: dict | None = None
    pending_walk = 0.0
    pending_transfer = False

    for edge in edges:
        if edge.kind == "ride":
            line = line_by_id[edge.start[0]]
            if current is not None and current["line"].id == line.id and current["sign"] == edge.sign:
                current["indices"].append(edge.end[1])
                current["minutes"] += edge.minutes
            else:
                if current is not None:
                    raw.append(current)
                current = {
                    "line": line,
                    "sign": edge.sign,
                    "indices": [edge.start[1], edge.end[1]],
                    "minutes": edge.minutes,
                    "walk": pending_walk,
                    "is_transfer": pending_transfer,
                }
                pending_walk = 0.0
                pending_transfer = False
        else:
            if current is not None:
                raw.append(current)
                current = None
            pending_walk += edge.minutes
            pending_transfer = pending_transfer or edge.is_transfer

    if current is not None:
        raw.append(current)

    legs: list[dict] = []
    for leg in raw:
        line: Line = leg["line"]
        start_idx = leg["indices"][0]
        end_idx = leg["indices"][-1]
        from_station = line.stations[start_idx]
        to_station = line.stations[end_idx]
        direction = _direction_for(line, leg["sign"], from_station, to_station)
        if line.ring and from_station == to_station:
            stops, minutes = _ring_loop(line, start_idx, leg["sign"])
        else:
            stops, minutes = engine.compute_step(line, direction, from_station, to_station)
        legs.append({
            "lineId": line.id,
            "lineName": line.name,
            "shortName": line.short_name,
            "type": line.type,
            "typeLabel": line.type_label,
            "color": line.color or "#888888",
            "color2": line.color2 or "",
            "direction": direction.label,
            "from": from_station,
            "to": to_station,
            "run": round(minutes, 1),
            "walk": round(leg["walk"], 1),
            "stopCount": max(0, len(stops) - 1),
            "stops": stops,
            "transfer": bool(leg["is_transfer"]),
            "_first": False,
        })
    if legs:
        legs[0]["_first"] = True
    return legs


def _steps_from_legs(legs: list[dict]) -> list[dict]:
    steps: list[dict] = []
    for leg in legs:
        steps.append({
            "line_id": leg["lineId"],
            "direction_label": leg["direction"],
            "from_station": leg["from"],
            "to_station": leg["to"],
            "walk_minutes": leg["walk"],
            "manual": False,
            "type": leg["type"],
            "line_name": leg["lineName"],
            "run_minutes": None,
            "stops_text": "",
            "color": leg["color"],
            "color2": leg["color2"],
            "note": "",
            "headway_text": "",
            "timetable": [],
            "use_timetable": False,
            "price": None,
            "transfer": True if leg["transfer"] else None,
            "service": "",
        })
    return steps


def _signature(legs: list[dict]) -> tuple:
    return tuple((leg["lineId"], leg["direction"], leg["from"], leg["to"], round(leg["walk"], 1))
                 for leg in legs)


def _make_plan(legs: list[dict], mode: str, note: str = "") -> dict:
    clean_legs = [{k: v for k, v in leg.items() if not k.startswith("_")} for leg in legs]
    if clean_legs:
        clean_legs[0]["transfer"] = False  # 第一段之前只有步行，不存在换乘
    total_run = sum(leg["run"] for leg in clean_legs)
    total_walk = sum(leg["walk"] for leg in clean_legs)
    minutes = total_run + total_walk
    # 以实际压缩后的乘车段计算换乘次数，避免搜索中的无效换乘被计入
    transfers = max(0, len(clean_legs) - 1)
    signature = _signature(clean_legs)
    lines: list[dict] = []
    seen: set[str] = set()
    for leg in clean_legs:
        if leg["lineId"] in seen:
            continue
        seen.add(leg["lineId"])
        lines.append({"id": leg["lineId"], "name": leg["lineName"], "color": leg["color"],
                      "color2": leg["color2"], "from": leg["from"], "to": leg["to"]})
    return {
        "mode": mode,
        "minutes": round(minutes, 1),
        "run": round(total_run, 1),
        "walk": round(total_walk, 1),
        "transfers": transfers,
        "lines": lines,
        "lineCount": len(lines),
        "stopCount": sum(leg["stopCount"] for leg in clean_legs),
        "legs": clean_legs,
        "steps": _steps_from_legs(clean_legs),
        "note": note,
        "_signature": signature,
    }


def _pareto(plans: list[dict]) -> list[dict]:
    """只保留「换乘更少且不慢于其它方案」的 Pareto 方案。"""
    ordered = sorted(plans, key=lambda plan: (plan["transfers"], plan["minutes"]))
    out: list[dict] = []
    best = float("inf")
    for plan in ordered:
        if plan["minutes"] < best - 1e-9:
            out.append(plan)
            best = plan["minutes"]
    return out


def _dedupe(plans: list[dict]) -> list[dict]:
    seen: set[tuple] = set()
    out: list[dict] = []
    for plan in plans:
        signature = plan["_signature"]
        if signature in seen:
            continue
        seen.add(signature)
        out.append(plan)
    return out


def _rank(plans: list[dict], limit: int) -> list[dict]:
    plans = _dedupe(plans)
    if not plans:
        return []
    for plan in plans:
        plan["score"] = round(plan["minutes"] + TRANSFER_PENALTY * plan["transfers"], 1)

    by_signature = {plan["_signature"]: plan for plan in plans}
    fastest = min(plans, key=lambda p: (p["minutes"], p["transfers"]))["_signature"]
    fewest = min(plans, key=lambda p: (p["transfers"], p["minutes"]))["_signature"]
    chosen: list[dict] = []
    for signature in (fastest, fewest):
        if len(chosen) >= limit:
            break
        plan = by_signature[signature]
        if plan not in chosen:
            chosen.append(plan)
    for plan in sorted(plans, key=lambda p: (p["score"], p["minutes"], p["transfers"])):
        if len(chosen) >= limit:
            break
        if plan not in chosen:
            chosen.append(plan)
    ordered = sorted(chosen, key=lambda p: (p["score"], p["minutes"], p["transfers"]))
    recommended = ordered[0]["_signature"] if ordered else None

    for plan in ordered:
        tags: list[str] = []
        if plan["_signature"] == recommended:
            tags.append("推荐")
        if plan["_signature"] == fastest and "最快" not in tags:
            tags.append("最快")
        if plan["_signature"] == fewest and "少换乘" not in tags:
            tags.append("少换乘")
        plan["tag"] = " · ".join(tags) if tags else "备选"
    return ordered


def _strip_internal(plans: list[dict]) -> list[dict]:
    return [{k: v for k, v in plan.items() if not k.startswith("_")} for plan in plans]


def _plan_station_mode(city: City, start_names: list[str], target: str,
                       default_walk: float) -> list[dict]:
    line_by_id = {line.id: line for line in city.lines}
    station_lines = _station_lines(city)
    ride_edges = _ride_edges(city)
    transfer_options = _transfer_options(city, station_lines, line_by_id, default_walk)

    starts: list[tuple[str, int]] = []
    for name in start_names:
        for line, index in station_lines.get(name, ()):
            starts.append((line.id, index))
    if not starts:
        raise LineError(f"起点站「{start_names[0] if start_names else ''}」不在当前线路库中")

    goal_names = set(engine.alias_names(city, target))
    if not any(name in station_lines for name in goal_names):
        raise LineError(f"车站「{target}」不在当前线路库中")
    labels, ride_labels = _dijkstra(starts, ride_edges, transfer_options, MAX_TRANSFERS)

    best_at_transfers: dict[int, tuple[float, _LabelKey]] = {}
    for key, label in ride_labels.items():
        node, transfers, _ = key
        line = line_by_id[node[0]]
        if node[1] >= len(line.stations):
            continue
        if line.stations[node[1]] not in goal_names:
            continue
        current = best_at_transfers.get(transfers)
        if current is None or label.minutes < current[0] - 1e-9:
            best_at_transfers[transfers] = (label.minutes, key)

    plans: list[dict] = []
    for transfers, (_, key) in sorted(best_at_transfers.items()):
        start_node, edges = _edges_from_ride(labels, ride_labels, key)
        if not edges:
            continue
        legs = _path_to_legs(city, line_by_id, start_node, edges, default_walk)
        if not legs:
            continue
        plans.append(_make_plan(legs, "station"))
    return _pareto(plans)


def _line_boarding_options(city: City, station: str,
                           origin_names: set[str], station_lines: dict,
                           default_walk: float) -> list[dict]:
    """从起点到目标线路某站的上车方案（不含目标线路乘车段）。"""
    options: list[dict] = []
    if station in origin_names:
        options.append({"minutes": 0.0, "transfers": 0, "walk": 0.0,
                        "transfer": False, "key": None})
        return options
    # 起点与目标线路车站属于同一转乘站组时，直接步行过去上车
    for group in city.transfers:
        if station in group and origin_names & set(group):
            options.append({"minutes": default_walk, "transfers": 0, "walk": default_walk,
                            "transfer": True, "key": None})
            break
    return options


def _plan_line_mode(city: City, origin: str, line_id: str, default_walk: float) -> list[dict]:
    line_by_id = {item.id: item for item in city.lines}
    target_line = line_by_id.get(line_id)
    if target_line is None:
        raise LineError("所选线路不在当前线路库中")
    station_lines = _station_lines(city)
    ride_edges = _ride_edges(city)
    transfer_options = _transfer_options(city, station_lines, line_by_id, default_walk)

    origin_names = set(engine.alias_names(city, origin))
    starts: list[tuple[str, int]] = []
    for name in origin_names:
        for line, index in station_lines.get(name, ()):
            if line.id != target_line.id:
                starts.append((line.id, index))

    # 不含目标线路的前置里程；到目标线路各站上车的最后一小段单独处理
    labels, ride_labels = _dijkstra(
        starts, ride_edges, transfer_options, MAX_TRANSFERS,
        exclude_line_id=target_line.id,
    ) if starts else ({}, {})

    target_stations = [target_line.stations[i] for i in range(_unique_count(target_line))]
    # 同一站名可能在环线站表中重复，去重保持顺序
    target_stations = list(dict.fromkeys(target_stations))

    candidates: list[dict] = []

    for station in target_stations:
        pre_options: list[dict] = _line_boarding_options(
            city, station, origin_names, station_lines, default_walk
        )
        # 从前置路径的终点换乘 / 同站换乘到目标线路
        station_aliases = set(engine.alias_names(city, station))
        station_transfer_group: set[str] = set()
        for group in city.transfers:
            if station in group:
                station_transfer_group |= set(group)
        for key, label in ride_labels.items():
            node, transfers, _ = key
            source_line = line_by_id[node[0]]
            if node[1] >= len(source_line.stations):
                continue
            source_station = source_line.stations[node[1]]
            if source_station in station_aliases:
                walk, is_transfer = 0.0, False
            elif source_station in station_transfer_group:
                walk, is_transfer = default_walk, True
            else:
                continue
            pre_options.append({
                "minutes": label.minutes + walk,
                "transfers": transfers + 1,
                "walk": walk,
                "transfer": is_transfer,
                "key": key,
            })

        # 同一上车站在同一换乘次数下只保留最快的方案
        best_pre: dict[int, dict] = {}
        for option in pre_options:
            current = best_pre.get(option["transfers"])
            if current is None or option["minutes"] < current["minutes"] - 1e-9:
                best_pre[option["transfers"]] = option

        board_idx = target_line.stations.index(station)
        for direction in target_line.directions:
            try:
                sign = engine.direction_sign(target_line, direction)
            except LineError:
                continue
            if target_line.ring:
                stops, run = _ring_loop(target_line, board_idx, sign)
                to_station = station
                direction_label = direction.label
            else:
                terminal = direction.terminal
                if not terminal:
                    terminal = target_line.stations[-1] if sign > 0 else target_line.stations[0]
                if station == terminal:
                    continue
                if terminal in origin_names:
                    continue  # 坐到起点站没有意义
                stops, run = engine.compute_step(target_line, direction, station, terminal)
                to_station = terminal
                direction_label = direction.label
            final_leg = {
                "lineId": target_line.id,
                "lineName": target_line.name,
                "shortName": target_line.short_name,
                "type": target_line.type,
                "typeLabel": target_line.type_label,
                "color": target_line.color or "#888888",
                "color2": target_line.color2 or "",
                "direction": direction_label,
                "from": station,
                "to": to_station,
                "run": round(run, 1),
                "walk": 0.0,
                "stopCount": max(0, len(stops) - 1),
                "stops": stops,
                "transfer": False,
                "_first": False,
            }
            for transfers, option in best_pre.items():
                if transfers > MAX_TRANSFERS:
                    continue
                if option["key"] is None:
                    pre_legs: list[dict] = []
                    start_node = None
                else:
                    start_node, edges = _edges_from_ride(labels, ride_labels, option["key"])
                    pre_legs = _path_to_legs(city, line_by_id, start_node, edges, default_walk)
                walk = option["walk"]
                if pre_legs:
                    final_leg_copy = dict(final_leg)
                    final_leg_copy["walk"] = round(walk, 1)
                    final_leg_copy["transfer"] = bool(option["transfer"])
                    legs = pre_legs + [final_leg_copy]
                else:
                    if walk > 0:
                        # 起点头部步行到目标线路：记在第一段之前，不增加换乘次数
                        final_leg_copy = dict(final_leg)
                        final_leg_copy["walk"] = round(walk, 1)
                        final_leg_copy["transfer"] = bool(option["transfer"])
                        legs = [final_leg_copy]
                    else:
                        legs = [dict(final_leg)]
                if legs:
                    legs[0]["_first"] = True
                candidates.append(_make_plan(legs, "line", note="乘坐 " + target_line.name))

    # 乘坐线路模式下，「坐到哪个终点」本身就是有意义的选择：
    # 先按终点/环行方向分组，再在各组内做换乘次数与时间的 Pareto 筛选，
    # 避免较远的终点方向被较近的终点方向直接淘汰。
    grouped: dict[tuple[str, str], list[dict]] = {}
    for plan in candidates:
        last = plan["legs"][-1]
        grouped.setdefault((last["direction"], last["to"]), []).append(plan)
    result: list[dict] = []
    for group in grouped.values():
        result.extend(_pareto(group))
    return result


def plan_routes(city: City, origin: str, mode: str, target: str,
                transfer_walk: float = 5.0, limit: int = MAX_PLANS) -> dict:
    """智能规划入口。

    mode="station"：target 为到达站；
    mode="line"：target 为想乘坐的线路 id（坐到该线终点 / 环线一圈）。
    """
    origin = (origin or "").strip()
    target = (target or "").strip()
    if not origin:
        raise LineError("请选择起点站")
    if not target:
        raise LineError("请选择想去的车站或想坐的线路")
    default_walk = max(0.0, float(transfer_walk or 0.0))
    limit = max(1, min(int(limit or MAX_PLANS), MAX_PLANS))

    if mode == "line":
        plans = _plan_line_mode(city, origin, target, default_walk)
    else:
        if target in set(engine.alias_names(city, origin)):
            raise LineError("起点站与到达站相同，请重新选择")
        plans = _plan_station_mode(city, list(engine.alias_names(city, origin)), target, default_walk)

    plans = _rank(plans, limit)
    if not plans:
        raise LineError("没有找到可行的方案，请检查起点、目标或城市数据是否完整")
    return {
        "mode": "line" if mode == "line" else "station",
        "origin": origin,
        "target": target,
        "transferPenalty": TRANSFER_PENALTY,
        "plans": _strip_internal(plans),
    }
