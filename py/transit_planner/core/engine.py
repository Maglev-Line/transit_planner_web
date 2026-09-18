"""规划引擎：终点站方向解析、分段时长、经停站、换乘提示、全程汇总。

设计原则：纯手动串联（交通迷可自由绕路），本引擎只负责『算』与『提示』。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .models import City, Line, Direction, Step, Trip, LineError, TYPE_METRO


# ---------------- 转乘 / 同站异名 / 付费区 ----------------

def alias_names(city: City | None, station: str) -> list[str]:
    """返回与某站同站异名的全部站名（含自身）。"""
    if city is None:
        return [station]
    for grp in city.aliases:
        if station in grp:
            return grp
    return [station]


def stations_same(city: City | None, a: str, b: str) -> bool:
    """两站是否为同一车站（同名或同站异名），同付费系统不出闸。"""
    if a == b:
        return True
    if city is None:
        return False
    for grp in city.aliases:
        if a in grp and b in grp:
            return True
    return False


def is_known_transfer(city: City | None, a: str, b: str) -> bool:
    """两站是否为『转乘站』：同一地点但名称不同、分属不同付费系统（需出闸/换系统）。"""
    if city is None or a == b:
        return False
    for grp in city.transfers:
        if a in grp and b in grp:
            return True
    return False


def step_is_transfer(city: City | None, prev_arrival: str | None, step: Step) -> bool:
    """本段上车前是否跨付费区转乘（转乘）：用户强制指定优先，否则按转乘站组自动判定。"""
    if step.transfer is not None:
        return bool(step.transfer)
    if prev_arrival is not None and is_known_transfer(city, prev_arrival, step.from_station):
        return True
    return False


def direction_sign(line: Line, direction: Direction) -> int:
    """返回乘车方向沿站表的走向：+1 升序，-1 降序（环线按 reverse 决定）。"""
    if direction.terminal is not None:
        idx = line.station_index(direction.terminal)
        return 1 if idx == len(line.stations) - 1 else -1
    return -1 if direction.reverse else 1


def _ring_unique_count(line: Line) -> int:
    """环线的真实站数。站表按「首尾相连」重复记录了闭合站
    （stations[0] == stations[-1]）时，去重后以 n-1 站走环，避免把闭合站算两次。"""
    n = len(line.stations)
    if n >= 2 and line.stations[0] == line.stations[-1]:
        return n - 1
    return n


def _path_indices(line: Line, sign: int, from_idx: int, to_idx: int):
    """求从 from_idx 沿 sign 到 to_idx 的站序；环线允许绕行。
    返回 (indices, minutes) 其中 indices 含起点终点，minutes 为该段运行分钟。
    """
    n = len(line.stations)
    if line.ring:
        m = _ring_unique_count(line)  # 真实站数（闭合站去重）
        from_idx %= m
        to_idx %= m
        # 顺时针收集
        stops = []
        cur = from_idx
        stops.append(cur)
        minutes = 0.0
        while cur != to_idx:
            nxt = (cur + sign) % m
            minutes += line.travel_minutes[cur if sign > 0 else nxt]
            cur = nxt
            stops.append(cur)
            if len(stops) > m:
                raise LineError(f"线路 {line.name} 中 {line.stations[from_idx]} 无法到达 {line.stations[to_idx]}")
        return stops, minutes
    # 非环线
    delta = to_idx - from_idx
    if sign > 0 and delta <= 0:
        raise LineError(f"在 {line.name} 当前方向（{direction_label(line, from_idx)}）中，无法从 {line.stations[from_idx]} 到 {line.stations[to_idx]}")
    if sign < 0 and delta >= 0:
        raise LineError(f"在 {line.name} 当前方向中，无法从 {line.stations[from_idx]} 到 {line.stations[to_idx]}")
    indices = list(range(from_idx, to_idx + sign, sign))
    minutes = sum(line.travel_minutes[i if sign > 0 else i - 1] for i in range(min(from_idx, to_idx), max(from_idx, to_idx)))
    return indices, minutes


def direction_label(line: Line, station_idx: int) -> str:
    """给定当前站下标，返回驶向的方向标签（沿默认方向）。"""
    if len(line.directions) == 2:
        return line.directions[1].label
    return line.directions[0].label


def compute_step(line: Line, direction: Direction, from_station: str, to_station: str) -> tuple[list[str], float]:
    """计算一段行程。返回 (经停站列表[含起点终点], 运行分钟)。"""
    from_idx = line.station_index(from_station)
    to_idx = line.station_index(to_station)
    if from_idx == to_idx:
        raise LineError("起点与终点相同")
    sign = direction_sign(line, direction)
    indices, minutes = _path_indices(line, sign, from_idx, to_idx)
    stops = [line.stations[i] for i in indices]
    return stops, minutes


@dataclass
class SegmentResult:
    """一段行程的计算结果。"""
    step: Step
    line: Line
    direction: Direction
    stops: list[str] = field(default_factory=list)
    run_minutes: float = 0.0
    walk_minutes: float = 0.0
    stop_count: int = 0
    manual: bool = False
    transfer: bool = False        # 跨付费区转乘（转乘）：上车前需出闸/换系统
    paid_zone_index: int = 0      # 所属付费区编号（从 0 开始）

    @property
    def segment_minutes(self) -> float:
        return self.walk_minutes + self.run_minutes


@dataclass
class PaidZone:
    """一个付费区：进闸站到出闸站之间的一次完整计费（含多段绕路行程）。"""
    index: int
    entry_station: str
    exit_station: str
    segments: list[SegmentResult] = field(default_factory=list)
    price: float | None = None    # 该付费区票价（取本区第一段进闸行程填写的票价）

    @property
    def run_minutes(self) -> float:
        return sum(s.run_minutes for s in self.segments)


@dataclass
class TripResult:
    """全程计算结果。"""
    segments: list[SegmentResult] = field(default_factory=list)

    @property
    def total_run(self) -> float:
        return sum(s.run_minutes for s in self.segments)

    @property
    def total_walk(self) -> float:
        return sum(s.walk_minutes for s in self.segments)

    @property
    def total_minutes(self) -> float:
        return self.total_run + self.total_walk

    @property
    def transfer_count(self) -> int:
        # 按"更换线路"次数统计（含同站换乘）；首段不计
        return sum(1 for i in range(1, len(self.segments))
                   if self.segments[i].line.id != self.segments[i - 1].line.id)

    @property
    def fare_transfer_count(self) -> int:
        # 「转乘」次数（跨付费区，需出闸/换系统）
        return sum(1 for s in self.segments if s.transfer)

    @property
    def line_count(self) -> int:
        return len({s.line.id for s in self.segments})

    @property
    def paid_zones(self) -> list[PaidZone]:
        """将行程段按付费区分组。"""
        groups: dict[int, list[SegmentResult]] = {}
        for s in self.segments:
            groups.setdefault(s.paid_zone_index, []).append(s)
        out: list[PaidZone] = []
        for idx in sorted(groups):
            segs = groups[idx]
            price = segs[0].step.price if segs else None  # 进闸段票价即该付费区票价
            out.append(PaidZone(
                index=idx,
                entry_station=segs[0].step.from_station,
                exit_station=segs[-1].step.to_station,
                segments=segs, price=price,
            ))
        return out


def parse_stops(text: str) -> list[str]:
    """解析用户输入的经停站文本（顿号/逗号/箭头/空格分隔）。"""
    if not text:
        return []
    parts = re.split(r"[、，,/→>·\s]+", text)
    return [p.strip() for p in parts if p.strip()]


def _resolve_walk(step: Step, prev_arrival: str | None, default_walk: float,
                  city: City | None = None) -> float:
    if prev_arrival is None:
        return float(step.walk_minutes) if step.walk_minutes is not None else 0.0
    if step.walk_minutes is not None:
        return float(step.walk_minutes)
    if stations_same(city, prev_arrival, step.from_station):
        return 0.0  # 同站换乘（含同站异名），未显式指定则记 0
    return float(default_walk)


def resolve_walk(step: Step, prev_arrival: str | None, default_walk: float,
                 city: City | None = None) -> float:
    """公开版换乘步行解析（供界面显示默认值使用）。"""
    return _resolve_walk(step, prev_arrival, default_walk, city)


def pick_direction(line: Line, from_station: str, to_station: str) -> Direction | None:
    """根据起终点自动选择可乘坐的方向（数据库线路用）。

    两个方向都可行（如环线）时返回第一个；无法到达返回 None。
    """
    try:
        from_idx = line.station_index(from_station)
        to_idx = line.station_index(to_station)
    except LineError:
        return None
    if from_idx == to_idx:
        return None
    for d in line.directions:
        try:
            _path_indices(line, direction_sign(line, d), from_idx, to_idx)
            return d
        except LineError:
            continue
    return None


def evaluate_manual_step(step: Step, prev_arrival: str | None, default_walk: float,
                         city: City | None = None) -> SegmentResult:
    """手动自选行程段：不依赖任何线路数据库。"""
    line_name = step.line_name or "手动线路"
    line = Line(
        id=f"manual_{line_name}", name=line_name, short_name=line_name,
        type=step.type or TYPE_METRO,
        color=step.color or "#888888", color2=step.color2 or "",
        stations=[step.from_station, step.to_station],
        headway_rush=1.0, headway_normal=1.0,
    )
    direction = Direction(label=step.direction_label or "手动方向", terminal=None, reverse=False)
    stops = parse_stops(step.stops_text)
    if not stops:
        stops = [step.from_station, step.to_station]
    run = float(step.run_minutes or 0)
    walk = _resolve_walk(step, prev_arrival, default_walk, city)
    stop_count = max(0, len(stops) - 1) if len(stops) >= 2 else 0
    return SegmentResult(step=step, line=line, direction=direction, stops=stops,
                         run_minutes=run, walk_minutes=walk, stop_count=stop_count, manual=True)


def evaluate_trip(city: City | None, trip: Trip) -> TripResult:
    """评估整个方案，逐段校验并计算时长/经停站/步行，并按付费区划分。

    city 可为 None（纯手动跨城方案时使用），但存在非手动行程段时会报错。
    """
    result = TripResult()
    prev_arrival: str | None = None
    zone = 0
    for i, step in enumerate(trip.steps):
        transfer = i > 0 and step_is_transfer(city, prev_arrival, step)
        if transfer:
            zone += 1  # 跨付费区转车 → 进入新的付费区
        if step.manual:
            seg = evaluate_manual_step(step, prev_arrival, trip.transfer_walk_default, city=city)
        else:
            if city is None:
                raise LineError("未加载线路库：非手动行程段需要城市线路数据，请切换城市或使用手动自选模式。")
            line = city.line(step.line_id)
            dir_idx = line.direction_index(step.direction_label)
            direction = line.directions[dir_idx]

            stops, minutes = compute_step(line, direction, step.from_station, step.to_station)
            walk = _resolve_walk(step, prev_arrival, trip.transfer_walk_default, city)
            seg = SegmentResult(
                step=step, line=line, direction=direction,
                stops=stops, run_minutes=minutes, walk_minutes=walk,
                stop_count=len(stops) - 1, manual=False,
            )
        seg.transfer = transfer
        seg.paid_zone_index = zone
        result.segments.append(seg)
        prev_arrival = step.to_station
    return result


def zone_prices(trip: Trip, result: TripResult) -> list[tuple[int, str, str, float]]:
    """付费区票价明细：[(序号, 进闸站, 出闸站, 票价)]（仅统计已填写票价）。"""
    out: list[tuple[int, str, str, float]] = []
    for z in result.paid_zones:
        if z.price is not None:
            out.append((z.index + 1, z.entry_station, z.exit_station, float(z.price)))
    return out


def price_total(trip: Trip, result: TripResult) -> float:
    """全程总票价。

    付费区模式：按『进闸站→出闸站』一次计费（绕路仍为一段付费区的收费），
    只累加每个付费区进闸段填写的票价；否则累加每段票价。
    """
    if trip.paid_zone_mode:
        return sum(p for _, _, _, p in zone_prices(trip, result))
    return sum(s.step.price for s in result.segments if s.step.price is not None)


def transfer_hints(city: City, station: str) -> list[tuple[Line, list[Direction]]]:
    """换乘提示：某站可换乘的所有线路及各自方向（含同站异名）。"""
    seen: list[Line] = []
    for s in alias_names(city, station):
        for ln in city.lines_serving(s):
            if ln not in seen:
                seen.append(ln)
    return [(ln, ln.directions) for ln in seen]


def reachable_from(city: City, line: Line, direction: Direction, from_station: str) -> list[str]:
    """当前站、当前方向下，可以到达的后续站点列表（供界面选择）。"""
    sign = direction_sign(line, direction)
    from_idx = line.station_index(from_station)
    if line.ring:
        m = _ring_unique_count(line)
        from_idx %= m
        return [line.stations[(from_idx + sign * k) % m] for k in range(1, m)]
    else:
        if sign > 0:
            out = line.stations[from_idx + 1:]
        else:
            out = list(reversed(line.stations[:from_idx]))
    return out


def all_stations(city: City) -> list[str]:
    """城市内全部站点的去重有序列表。"""
    seen: dict[str, None] = {}
    for ln in city.lines:
        for s in ln.stations:
            seen.setdefault(s)
    return list(seen)
