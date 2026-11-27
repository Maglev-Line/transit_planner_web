"""数据模型：线路、方向、城市库、行程方案。

所有数据以 JSON 形式存储（人类可读、可手工编辑）。
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field, asdict
from dataclasses import fields as dc_fields
from pathlib import Path

# 交通类型常量
TYPE_METRO = "metro"          # 地铁
TYPE_SUBURBAN = "suburban"    # 市域铁路
TYPE_INTERCITY = "intercity"  # 城际铁路
TYPE_TRAM = "tram"            # 有轨电车
TYPE_MONORAIL = "monorail"    # 单轨
TYPE_CLOUDRAIL = "cloudrail"  # 比亚迪云巴
TYPE_BUS = "bus"              # 公交
TYPE_RAIL = "national_rail"   # 国家铁路
TYPE_MAGLEV = "maglev"        # 磁浮
TYPE_FERRY = "ferry"          # 轮渡
TYPE_CABLEWAY = "cableway"    # 索道（缆车）
TYPE_APM = "apm"              # 自动旅客捷运（APM）

TYPE_LABELS = {
    TYPE_METRO: "地铁",
    TYPE_SUBURBAN: "市域铁路",
    TYPE_INTERCITY: "城际铁路",
    TYPE_TRAM: "有轨电车",
    TYPE_MONORAIL: "单轨",
    TYPE_CLOUDRAIL: "比亚迪云巴",
    TYPE_BUS: "公交",
    TYPE_RAIL: "国家铁路",
    TYPE_MAGLEV: "磁浮",
    TYPE_FERRY: "轮渡",
    TYPE_CABLEWAY: "索道",
    TYPE_APM: "APM",
}


def type_display(key: str) -> str:
    """交通类型的显示文字：内置类型查表；用户自定义类型直接以名称为 key。"""
    return TYPE_LABELS.get(key, key)


def all_type_keys() -> list[str]:
    """内置交通类型 key 列表（含轮渡/索道/APM）。"""
    return list(TYPE_LABELS)


class LineError(Exception):
    pass


@dataclass
class Direction:
    """一个乘车方向，用『终点站』命名（如：富锦路方向）。"""
    label: str
    terminal: str | None = None   # 终点站名；环线等可为 None
    reverse: bool = False         # 沿站表反向运行（环线/自定义方向用）

    @property
    def display(self) -> str:
        return self.label


# 快车每跳过一个中间站默认节省的分钟（停站时间）
DEFAULT_EXPRESS_SKIP_MINUTES = 0.4


@dataclass
class ExpressService:
    """快车 / 大站车 / 直达车等不停靠全部车站的列车服务。

    stops：本服务实际停靠的站（有序，须是本线路站表中的车站）。
    section_minutes：可选，停靠站之间的运行分钟（长度 = len(stops) - 1）；
                     缺省时按基础区间时长累加，并按跳过的车站数节省停站时间。
    headway_text：可选，本服务的发车班次文字（留空沿用线路班次）。
    """
    id: str = ""
    name: str = "快车"
    stops: list[str] = field(default_factory=list)
    section_minutes: list[float] = field(default_factory=list)
    skip_minutes: float = DEFAULT_EXPRESS_SKIP_MINUTES
    headway_text: str = ""

    def __post_init__(self) -> None:
        if not self.id:
            self.id = self.name or "express"


@dataclass
class ThroughSection:
    """贯通交路使用的一段既有线路区间。"""
    line_id: str
    from_station: str
    to_station: str
    reverse: bool = False


@dataclass
class ThroughService:
    """跨越多条线路连续运行的贯通交路。"""
    id: str
    name: str
    segments: list[ThroughSection] = field(default_factory=list)
    short_name: str = ""
    type: str = TYPE_METRO
    color: str = ""
    color2: str = ""
    operator: str = ""
    headway_rush: float = 10.0
    headway_normal: float = 15.0
    express: list[ExpressService] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict) -> "ThroughService":
        data = dict(data)
        data["segments"] = [
            segment if isinstance(segment, ThroughSection) else ThroughSection(**segment)
            for segment in data.get("segments", [])
        ]
        known = {f.name for f in dc_fields(ExpressService)}
        data["express"] = [
            service if isinstance(service, ExpressService)
            else ExpressService(**{k: v for k, v in service.items() if k in known})
            for service in data.get("express", [])
            if isinstance(service, (dict, ExpressService))
        ]
        allowed = {f.name for f in dc_fields(cls)}
        return cls(**{k: v for k, v in data.items() if k in allowed})


@dataclass
class Line:
    """一条线路。stations 为有序站表，travel_minutes[i] 为 stations[i]->stations[i+1] 的时长(分钟)。"""
    id: str
    name: str
    short_name: str = ""
    type: str = TYPE_METRO
    color: str = "#888888"
    color2: str = ""        # 副色（双色标志色，如国铁黑白、上海磁浮）
    operator: str = ""
    stations: list[str] = field(default_factory=list)
    travel_minutes: list[float] = field(default_factory=list)
    headway_rush: float = 10.0     # 高峰发车间隔(分钟)
    headway_normal: float = 15.0   # 平峰发车间隔(分钟)
    first_train: str = ""
    last_train: str = ""
    ring: bool = False
    directions: list[Direction] = field(default_factory=list)
    express: list[ExpressService] = field(default_factory=list)  # 快车服务（可空）
    system: str = ""             # 线路所属系统；空值用于兼容旧数据的单一系统
    direction_stops: dict[str, list[str]] = field(default_factory=dict)
    # 上下行停靠站不一致：方向 label -> 该方向的停靠站表（按该方向的行车顺序）。
    # 未列出的车站表示该方向不服务（跳站），因此也能表达上下行完全分离的情形；
    # 未声明该字段的方向按线路站表停靠全部车站。

    def __post_init__(self) -> None:
        if not self.directions and len(self.stations) >= 2:
            first, last = self.stations[0], self.stations[-1]
            if self.ring:
                self.directions = [
                    Direction(label=f"{first} → {last}", terminal=None, reverse=False),
                    Direction(label=f"{last} → {first}", terminal=None, reverse=True),
                ]
            else:
                self.directions = [
                    Direction(label=f"{last}方向", terminal=last, reverse=False),
                    Direction(label=f"{first}方向", terminal=first, reverse=False),
                ]
        if not self.short_name:
            self.short_name = self.name

    @property
    def type_label(self) -> str:
        return TYPE_LABELS.get(self.type, self.type)

    @property
    def headway_text(self) -> str:
        """发车班次文字（不写等车时间）。0 表示「不定班」（无固定间隔）。"""
        r, n = self.headway_rush, self.headway_normal
        if r <= 0 or n <= 0:
            return "不定班"
        if r == n:
            return f"{fmt_minutes(r)}一班"
        return f"高峰{fmt_minutes(r)}一班 / 平峰{fmt_minutes(n)}一班"

    def station_index(self, station: str) -> int:
        try:
            return self.stations.index(station)
        except ValueError:
            raise LineError(f"线路 {self.name} 不包含站点 {station}")

    def direction_index(self, label: str) -> int:
        for i, d in enumerate(self.directions):
            if d.label == label:
                return i
        raise LineError(f"线路 {self.name} 不存在方向 {label}")

    def express_service(self, service_id: str) -> ExpressService:
        """按 id 取快车服务（空 id / 各站停 返回空服务由调用方处理）。"""
        for svc in self.express:
            if svc.id == service_id:
                return svc
        raise LineError(f"线路 {self.name} 不存在车种 {service_id}")

    def has_express(self) -> bool:
        return bool(self.express)

    def service_stops(self, service_id: str = "") -> list[str]:
        """某车种的停靠站表：空 id 表示各站停（全部车站）。"""
        if not service_id:
            return list(self.stations)
        return list(self.express_service(service_id).stops)

    def stop_list(self, direction_label: str) -> list[str]:
        """某方向自己的停靠站表（按行车顺序）；未声明时返回空列表，表示按站表停靠全部车站。"""
        if not self.direction_stops:
            return []
        stops = self.direction_stops.get(direction_label) or []
        return [s for s in stops if s in self.stations]

    def skipped_stations(self, direction_label: str) -> list[str]:
        """某方向不服务的车站（上下行停靠站不一致时使用）。"""
        stops = self.stop_list(direction_label)
        if not stops:
            return []
        served = set(stops)
        return [s for s in self.stations if s not in served]

    def to_dict(self) -> dict:
        d = asdict(self)
        if not d.get("direction_stops"):
            d.pop("direction_stops", None)
        return d

    @classmethod
    def from_dict(cls, data: dict) -> "Line":
        data = dict(data)
        data["directions"] = [Direction(**x) for x in data.get("directions", [])]
        express = data.get("express")
        known = {f.name for f in dc_fields(ExpressService)}
        data["express"] = [
            x if isinstance(x, ExpressService)
            else ExpressService(**{k: v for k, v in x.items() if k in known})
            for x in (express if isinstance(express, list) else [])
            if isinstance(x, (dict, ExpressService))
        ]
        data["direction_stops"] = cls._read_direction_stops(data)
        return cls(**data)

    @staticmethod
    def _read_direction_stops(data: dict) -> dict[str, list[str]]:
        """读取上下行停靠站表；兼容只写「跳站」的 direction_skips 写法。"""
        def clean(value) -> list[str]:
            return [str(s).strip() for s in value if str(s).strip()] if isinstance(value, list) else []

        stops: dict[str, list[str]] = {}
        raw_stops = data.get("direction_stops")
        if isinstance(raw_stops, dict):
            for label, value in raw_stops.items():
                names = clean(value)
                if names:
                    stops[str(label)] = names
        raw_skips = data.get("direction_skips")
        if isinstance(raw_skips, dict):
            all_stations = [str(s) for s in (data.get("stations") or []) if str(s).strip()]
            for label, value in raw_skips.items():
                if str(label) in stops:
                    continue
                skipped = set(clean(value))
                if not skipped:
                    continue
                remaining = [s for s in all_stations if s not in skipped]
                if remaining:
                    stops[str(label)] = remaining
        return stops


@dataclass
class StationSystem:
    """强互通系统：只登记车站名称、没有线路时刻数据的系统。

    典型用途是「广东城际系统」「国家铁路系统」这类外部网络：数据里只写车站名，
    在这些车站上与城市内任何系统视为互通，用于转乘提示。
    type 为交通类型键（如 national_rail），界面据此提供对应的行程查询入口。
    """
    name: str
    stations: list[str] = field(default_factory=list)
    type: str = ""

    @classmethod
    def from_value(cls, name: str, value) -> "StationSystem":
        """接受两种写法：站名数组，或 {type, stations} 对象。"""
        if isinstance(value, dict):
            stations = value.get("stations")
            return cls(
                name=str(name),
                stations=[str(s).strip() for s in stations if str(s).strip()]
                if isinstance(stations, list) else [],
                type=str(value.get("type", "") or ""),
            )
        if isinstance(value, list):
            return cls(name=str(name), stations=[str(s).strip() for s in value if str(s).strip()])
        return cls(name=str(name))

    def to_value(self) -> list[str] | dict:
        if self.type:
            return {"type": self.type, "stations": list(self.stations)}
        return list(self.stations)


@dataclass
class City:
    """一个城市的线路库。"""
    name: str
    region: str = ""
    version: str = "1.0"
    lines: list[Line] = field(default_factory=list)
    external_walks: dict[str, float] = field(default_factory=dict)  # "A|B" -> 步行分钟
    transfers: list[list["TransferEndpoint"]] = field(default_factory=list)
    # 转乘站对：每个端点用站名和系统共同定位；空系统仅用于兼容旧格式。
    aliases: list[list[str]] = field(default_factory=list)
    # 同站异名组：同一车站、同一付费系统、仅名称不同（如广州"西塱"↔广佛线"西朗"），
    # 换乘不出闸，按同站换乘（步行 0 分钟）处理。
    combined_shared_stations: list[str] = field(default_factory=list)
    # 同城组合共用的同名车站：参与组合的任一座城市声明后，组合时保留同名并自动
    # 声明为跨系统转乘站；未声明的重名站会按城市区分（如"体育西路（佛山）"）。
    station_systems: list["StationSystem"] = field(default_factory=list)
    # 强互通系统：只登记车站名称的系统（如广东城际、国家铁路），用于转乘提示。
    line_cities: dict[str, str] = field(default_factory=dict, repr=False)
    through_services: list[ThroughService] = field(default_factory=list)
    systems: list[str] = field(default_factory=list)

    def line(self, line_id: str) -> Line:
        for ln in self.lines:
            if ln.id == line_id:
                return ln
        raise LineError(f"城市 {self.name} 中不存在线路 {line_id}")

    def lines_serving(self, station: str) -> list[Line]:
        return [ln for ln in self.lines if station in ln.stations]

    def station_systems_at(self, station: str) -> list["StationSystem"]:
        """在该站设有车站的强互通系统（只登记车站名的系统）。"""
        return [system for system in self.station_systems if station in system.stations]

    def to_dict(self) -> dict:
        return {
            "city": self.name,
            "region": self.region,
            "version": self.version,
            "systems": list(self.systems),
            "lines": [ln.to_dict() for ln in self.lines],
            "external_walks": self.external_walks,
            "transfers": [
                [
                    endpoint.station if endpoint.legacy else {
                        "station": endpoint.station,
                        "system": endpoint.system,
                    }
                    for endpoint in group
                ]
                for group in self.transfers
            ],
            "aliases": self.aliases,
            **({"combined_shared_stations": list(self.combined_shared_stations)}
               if self.combined_shared_stations else {}),
            **({"station_systems": {
                system.name: system.to_value() for system in self.station_systems
            }} if self.station_systems else {}),
            "through_services": [asdict(service) for service in self.through_services],
        }

    @classmethod
    def from_dict(cls, data: dict) -> "City":
        systems = data.get("systems")
        if isinstance(systems, list):
            systems = list(dict.fromkeys(str(system) for system in systems))
        else:
            systems = list(dict.fromkeys(
                str(line.get("system", "")).strip()
                for line in data.get("lines", [])
                if isinstance(line, dict) and str(line.get("system", "")).strip()
            ))
        transfers = []
        for group in data.get("transfers", []):
            endpoints = []
            if not isinstance(group, list):
                continue
            for endpoint in group:
                if isinstance(endpoint, dict):
                    endpoints.append(TransferEndpoint(
                        station=str(endpoint.get("station", "")),
                        system=str(endpoint.get("system", "")),
                        legacy=bool(endpoint.get("legacy", False)),
                    ))
                elif isinstance(endpoint, str):
                    endpoints.append(TransferEndpoint(station=endpoint, legacy=True))
            transfers.append(endpoints)
        raw_shared = data.get("combined_shared_stations")
        combined_shared_stations = (
            [str(station).strip() for station in raw_shared if str(station).strip()]
            if isinstance(raw_shared, list) else []
        )
        raw_station_systems = data.get("station_systems")
        station_systems: list[StationSystem] = []
        if isinstance(raw_station_systems, dict):
            station_systems = [
                StationSystem.from_value(name, value)
                for name, value in raw_station_systems.items()
                if str(name).strip()
            ]
        elif isinstance(raw_station_systems, list):
            for item in raw_station_systems:
                if isinstance(item, dict) and str(item.get("name", "")).strip():
                    name = str(item["name"]).strip()
                    station_systems.append(StationSystem.from_value(
                        name, {k: v for k, v in item.items() if k != "name"}
                    ))
        return cls(
            name=data.get("city", "未命名"),
            region=data.get("region", ""),
            version=data.get("version", "1.0"),
            lines=[Line.from_dict(x) for x in data.get("lines", [])],
            external_walks=data.get("external_walks", {}),
            transfers=transfers,
            aliases=data.get("aliases", []),
            combined_shared_stations=list(dict.fromkeys(combined_shared_stations)),
            station_systems=station_systems,
            through_services=[
                ThroughService.from_dict(service)
                for service in data.get("through_services", [])
            ],
            systems=systems,
        )


@dataclass
class TransferEndpoint:
    """转乘关系中的一个站点，由站名与所属系统共同定位。"""
    station: str
    system: str = ""
    legacy: bool = False


def merge_lines(first: Line, second: Line) -> Line:
    """合并同一条线路的两份数据：站点数据更完整的一方优先，缺失字段由另一方补齐。"""
    primary, secondary = (
        (first, second) if len(first.stations) >= len(second.stations) else (second, first)
    )
    color = primary.color
    if not color or color == "#888888":
        color = secondary.color or color
    return Line(
        id=primary.id,
        name=primary.name or secondary.name,
        short_name=primary.short_name or secondary.short_name,
        system=primary.system or secondary.system,
        type=primary.type or secondary.type,
        color=color,
        color2=primary.color2 or secondary.color2,
        operator=primary.operator or secondary.operator,
        stations=list(primary.stations),
        travel_minutes=list(primary.travel_minutes),
        headway_rush=primary.headway_rush,
        headway_normal=primary.headway_normal,
        first_train=primary.first_train or secondary.first_train,
        last_train=primary.last_train or secondary.last_train,
        ring=primary.ring or secondary.ring,
        directions=list(primary.directions) or list(secondary.directions),
        express=list(primary.express) or list(secondary.express),
    )


class CityLibrary:
    """管理多个城市的 JSON 城市库。

    支持「同城」组合模式：将多座城市的数据在内存中合并为一座虚拟城市
    （不额外生成大文件），用于上海-苏州 / 广州-佛山 / 珠江三角洲等跨城规划。
    """

    # 同城组合：键 = 界面显示的城市名，值 = 参与合并的真实城市文件
    COMBINED_CITIES: dict[str, tuple[str, ...]] = {
        "上海-苏州": ("上海", "苏州"),
        "广州-佛山": ("广州", "佛山"),
        "珠江三角洲": ("广州", "深圳", "佛山", "东莞"),
    }

    # 同城组合中允许跨城市共用的同名车站由参与城市的数据文件声明
    # （`combined_shared_stations`）；未声明的重名站会按城市区分。

    # 多城共用一份线路库文件：城市名 -> 数据文件 stem（广州 / 佛山 的线路统一存放于 广州-佛山.json）
    SHARED_CITY_FILES: dict[str, str] = {
        "广州": "广州-佛山",
        "佛山": "广州-佛山",
        # 南京都市圈跨市线路（宁马线 / 宁滁线）与南京线网共用同一份数据
        "马鞍山": "南京",
        "滁州": "南京",
    }

    # 共用文件的城市视图：该城市关注的线路排在线路库最前（其余仍按文件顺序）
    CITY_LINE_PRIORITY: dict[str, tuple[str, ...]] = {
        "马鞍山": ("nj_s2",),
        "滁州": ("nj_s4",),
    }

    # 共用文件中线路的归属：按线路 ID 前缀区分，用于分别保存各城市的改动
    CITY_LINE_PREFIXES: dict[str, str] = {
        "广州": "gz_",
        "佛山": "fs_",
    }

    def __init__(self, data_dir: str | Path) -> None:
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)

    def file_stem(self, city: str) -> str:
        """城市对应的数据文件 stem（共用文件的城市返回共用文件）。"""
        return self.SHARED_CITY_FILES.get(city, city)

    def list_cities(self) -> list[str]:
        files = sorted(p.stem for p in self.data_dir.glob("*.json"))
        return sorted(set(files) | set(self.COMBINED_CITIES) | set(self.SHARED_CITY_FILES))

    @staticmethod
    def is_combined(name: str) -> bool:
        return name in CityLibrary.COMBINED_CITIES

    def load(self, city: str) -> City:
        if city in self.COMBINED_CITIES:
            return self._load_combined(city)
        path = self.data_dir / f"{self.file_stem(city)}.json"
        if not path.exists():
            raise FileNotFoundError(f"未找到城市线路库：{path}")
        with path.open("r", encoding="utf-8") as f:
            c = City.from_dict(json.load(f))
        c = self.with_through_services(c)
        if city in self.SHARED_CITY_FILES:
            c.name = city
        return c

    @staticmethod
    def with_through_services(city: City) -> City:
        """以派生线路形式展开跨线交路，供规划搜索和线路详情共用。"""
        if not city.through_services:
            return city

        expanded = City(
            name=city.name,
            region=city.region,
            version=city.version,
            lines=list(city.lines),
            external_walks=dict(city.external_walks),
            transfers=list(city.transfers),
            aliases=list(city.aliases),
            combined_shared_stations=list(city.combined_shared_stations),
            station_systems=list(city.station_systems),
            line_cities=dict(city.line_cities),
            through_services=list(city.through_services),
            systems=list(city.systems),
        )
        for service in expanded.through_services:
            if not service.id or any(line.id == service.id for line in expanded.lines):
                raise LineError(f"贯通交路 ID「{service.id}」为空或与现有线路重复")
            stations: list[str] = []
            travel_minutes: list[float] = []
            for section in service.segments:
                source = next((line for line in expanded.lines if line.id == section.line_id), None)
                if source is None:
                    raise LineError(f"贯通交路「{service.name}」引用了不存在的线路「{section.line_id}」")
                try:
                    start = source.stations.index(section.from_station)
                    end = source.stations.index(section.to_station)
                except ValueError as exc:
                    raise LineError(
                        f"贯通交路「{service.name}」区段车站不在线路「{source.name}」内"
                    ) from exc
                if start == end:
                    raise LineError(f"贯通交路「{service.name}」区段起终站不能相同")
                if source.ring:
                    count = (
                        len(source.stations) - 1
                        if len(source.stations) > 1 and source.stations[0] == source.stations[-1]
                        else len(source.stations)
                    )
                    start %= count
                    end %= count
                    sign = -1 if section.reverse else 1
                    indices = [start]
                    while indices[-1] != end:
                        indices.append((indices[-1] + sign) % count)
                        if len(indices) > count:
                            raise LineError(f"贯通交路「{service.name}」环线区段无法到达终点")
                    minute_indices = [
                        index if sign > 0 else (index - 1) % count
                        for index in indices[:-1]
                    ]
                else:
                    if section.reverse:
                        raise LineError(
                            f"贯通交路「{service.name}」的 reverse 仅适用于环线区段"
                        )
                    sign = 1 if end > start else -1
                    indices = list(range(start, end + sign, sign))
                    minute_indices = [
                        index if sign > 0 else index - 1
                        for index in indices[:-1]
                    ]
                segment_stations = [source.stations[index] for index in indices]
                segment_minutes = [
                    float(source.travel_minutes[index])
                    for index in minute_indices
                    if 0 <= index < len(source.travel_minutes)
                ]
                if len(segment_minutes) != len(segment_stations) - 1:
                    raise LineError(f"贯通交路「{service.name}」区段缺少区间时长")
                if stations and stations[-1] != segment_stations[0]:
                    raise LineError(
                        f"贯通交路「{service.name}」相邻区段未在同一车站衔接"
                    )
                stations.extend(segment_stations if not stations else segment_stations[1:])
                travel_minutes.extend(segment_minutes)
            if len(stations) < 2:
                raise LineError(f"贯通交路「{service.name}」至少需要两个连续区段车站")
            expanded.lines.append(Line(
                id=service.id,
                name=service.name,
                short_name=service.short_name or service.name,
                system=next(
                    (source.system for section in service.segments
                     if (source := next((line for line in expanded.lines if line.id == section.line_id), None))
                     and source.system),
                    "",
                ),
                type=service.type,
                color=service.color or "#888888",
                color2=service.color2,
                operator=service.operator,
                stations=stations,
                travel_minutes=travel_minutes,
                headway_rush=service.headway_rush,
                headway_normal=service.headway_normal,
                directions=[
                    Direction(label=f"{stations[-1]}方向", terminal=stations[-1]),
                    Direction(label=f"{stations[0]}方向", terminal=stations[0]),
                ],
                express=list(service.express),
            ))
        return expanded

    @staticmethod
    def _qualify_stations(city: City, names: dict[str, str]) -> None:
        """为组合中的非共站重名站添加城市后缀，并同步更新线路引用。"""
        if not names:
            return

        pattern = re.compile("|".join(re.escape(name) for name in sorted(names, key=len, reverse=True)))

        def qualify_label(label: str) -> str:
            return pattern.sub(lambda match: names[match.group()], label)

        for line in city.lines:
            line.stations = [names.get(station, station) for station in line.stations]
            line.directions = [
                Direction(
                    label=qualify_label(direction.label),
                    terminal=(
                        names.get(direction.terminal, direction.terminal)
                        if direction.terminal is not None else None
                    ),
                    reverse=direction.reverse,
                )
                for direction in line.directions
            ]
            for service in line.express:
                service.stops = [names.get(station, station) for station in service.stops]

        city.transfers = [
            [
                TransferEndpoint(
                    station=names.get(endpoint.station, endpoint.station),
                    system=endpoint.system,
                    legacy=endpoint.legacy,
                )
                for endpoint in group
            ]
            for group in city.transfers
        ]
        city.aliases = [[names.get(station, station) for station in group] for group in city.aliases]
        city.external_walks = {
            "|".join(names.get(station, station) for station in key.split("|", 1)): minutes
            for key, minutes in city.external_walks.items()
        }

    def _load_combined(self, key: str) -> City:
        """合并多座城市为一座虚拟城市，并按配置隔离不同城市的同名车站。"""
        merged = City(name=key, region="同城组合", version="1.0")
        index_by_id: dict[str, int] = {}
        index_by_name: dict[str, int] = {}
        loaded_stems: set[str] = set()
        parts: list[tuple[str, City]] = []
        for part in self.COMBINED_CITIES[key]:
            stem = self.file_stem(part)
            if stem in loaded_stems:
                continue  # 多座城市共用同一文件时只读一次
            loaded_stems.add(stem)
            path = self.data_dir / f"{stem}.json"
            if not path.exists():
                continue
            with path.open("r", encoding="utf-8") as f:
                c = City.from_dict(json.load(f))
            parts.append((part, c))

        station_owners: dict[str, set[str]] = {}
        for part, city in parts:
            for line in city.lines:
                for station in line.stations:
                    station_owners.setdefault(station, set()).add(part)
        # 共用车站由各参与城市的数据声明（任一城市声明即视为共用），可在数据工坊中编辑
        shared_stations = {
            station
            for _, city in parts
            for station in city.combined_shared_stations
        }
        # 强互通系统（如广东城际、国家铁路）跨城共用：系统名不加城市前缀，车站取并集
        station_system_names = {
            system.name
            for _, city in parts
            for system in city.station_systems
        }
        qualified_names: dict[str, set[str]] = {}

        for part, c in parts:
            for line in c.lines:
                line.system = f"{part}::{line.system or 'default'}"
                if line.system not in merged.systems:
                    merged.systems.append(line.system)
            for group in c.transfers:
                for endpoint in group:
                    if endpoint.system and endpoint.system not in station_system_names:
                        endpoint.system = f"{part}::{endpoint.system}"
            isolated_names = {
                station: f"{station}（{part}）"
                for station, owners in station_owners.items()
                if len(owners) > 1 and station not in shared_stations and part in owners
            }
            for station, qualified in isolated_names.items():
                qualified_names.setdefault(station, set()).add(qualified)
            self._qualify_stations(c, isolated_names)
            for ln in c.lines:
                idx = index_by_id.get(ln.id)
                if idx is None and ln.name.strip():
                    idx = index_by_name.get(ln.name.strip())
                if idx is not None:
                    ln = merge_lines(merged.lines[idx], ln)
                    merged.lines[idx] = ln
                else:
                    idx = len(merged.lines)
                    merged.lines.append(ln)
                index_by_id[ln.id] = idx
                merged.line_cities[ln.id] = part
                if ln.name.strip():
                    index_by_name[ln.name.strip()] = idx
            merged.external_walks.update(c.external_walks)
            for grp in c.transfers:
                if grp not in merged.transfers:
                    merged.transfers.append(grp)
            for grp in c.aliases:
                if grp not in merged.aliases:
                    merged.aliases.append(grp)
        for station in shared_stations:
            endpoints = []
            for line in merged.lines:
                if station in line.stations:
                    endpoint = TransferEndpoint(station=station, system=line.system)
                    if endpoint not in endpoints:
                        endpoints.append(endpoint)
            if len({endpoint.system for endpoint in endpoints}) > 1 and endpoints not in merged.transfers:
                merged.transfers.append(endpoints)
        merged.station_systems = self._merge_station_systems(parts, qualified_names)
        return merged

    @staticmethod
    def _merge_station_systems(parts: list[tuple[str, City]],
                               qualified_names: dict[str, set[str]]) -> list[StationSystem]:
        """合并各城市的强互通系统：同名系统取并集，并补上被限定过的重名站写法。"""
        merged: dict[str, StationSystem] = {}
        for _, city in parts:
            for system in city.station_systems:
                target = merged.setdefault(system.name, StationSystem(
                    name=system.name, stations=[], type=system.type,
                ))
                if system.type and not target.type:
                    target.type = system.type
                for station in system.stations:
                    if station not in target.stations:
                        target.stations.append(station)
                    for qualified in qualified_names.get(station, ()):
                        if qualified not in target.stations:
                            target.stations.append(qualified)
        return list(merged.values())

    def _shared_siblings(self, city: str) -> tuple[str, ...]:
        """同一份共用文件中其它城市的线路 ID 前缀。"""
        stem = self.file_stem(city)
        return tuple(
            self.CITY_LINE_PREFIXES[name]
            for name in self.SHARED_CITY_FILES
            if self.file_stem(name) == stem and name != city and name in self.CITY_LINE_PREFIXES
        )

    def _merge_into_shared(self, city: City, path: Path) -> City:
        """把某城市的线路合并回共用文件：只替换本城市的线路，保留同文件内其它城市的线路。"""
        with path.open("r", encoding="utf-8") as f:
            existing = City.from_dict(json.load(f))
        sibling_prefixes = self._shared_siblings(city.name)
        keep = [ln for ln in existing.lines if ln.id.startswith(sibling_prefixes)]
        mine = [ln for ln in city.lines if not ln.id.startswith(sibling_prefixes)]
        lines = [*keep, *mine]
        # 按城市顺序归位（广州线路在前、佛山线路在后），组内保持原顺序
        order = tuple(
            self.CITY_LINE_PREFIXES[n] for n in self.SHARED_CITY_FILES
            if self.file_stem(n) == self.file_stem(city.name) and n in self.CITY_LINE_PREFIXES
        )
        lines = [ln for p in order for ln in lines if ln.id.startswith(p)] + [
            ln for ln in lines if not ln.id.startswith(order)
        ]
        transfers = list(existing.transfers)
        transfers += [g for g in city.transfers if g not in transfers]
        aliases = list(existing.aliases)
        aliases += [g for g in city.aliases if g not in aliases]
        systems = list(existing.systems)
        systems += [system for system in city.systems if system not in systems]
        shared_stations = list(existing.combined_shared_stations)
        shared_stations += [s for s in city.combined_shared_stations if s not in shared_stations]
        walks = dict(existing.external_walks)
        walks.update(city.external_walks)
        return City(
            name=self.file_stem(city.name),
            region=city.region or existing.region,
            version=city.version or existing.version,
            lines=lines,
            external_walks=walks,
            transfers=transfers,
            aliases=aliases,
            combined_shared_stations=shared_stations,
            systems=systems,
        )

    def save(self, city: City) -> None:
        path = self.data_dir / f"{self.file_stem(city.name)}.json"
        doc = city.to_dict()
        if city.name in self.SHARED_CITY_FILES and path.exists():
            doc = self._merge_into_shared(city, path).to_dict()
        tmp = path.with_suffix(".json.tmp")
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, indent=2)
        tmp.replace(path)

    def delete(self, city: str) -> None:
        shared_stems = set(self.SHARED_CITY_FILES.values())
        if city in self.SHARED_CITY_FILES or city in shared_stems:
            raise LineError(f"{city} 与其它城市共用线路库文件，不能单独删除，请直接编辑其中的线路")
        path = self.data_dir / f"{city}.json"
        if path.exists():
            path.unlink()


# ---------------- 行程方案 ----------------

@dataclass
class Step:
    """一步行程。

    manual=False：基于线路数据库，乘坐某线某方向，从某站到某站。
    manual=True ：完全手动填写（自定义线路名/方向/时长/经停站/颜色），
                  适用于跨城国铁、数据库未收录的线路等。
    walk_minutes：上车前（从上一到达站）的换乘/步行分钟；首步忽略。None 表示用默认值。
    service：车种（线路 express 服务的 id）；空串表示各站停的普通车。
    start_time / end_time：实际乘车时刻（"HH:MM"）。数据库线路由引擎忽略，供运转记录使用。
    train_no / train_model：车次与车型文字（可选）。
    extras：本段自定义字段 [[名称, 内容], ...]。
    """
    line_id: str = ""
    direction_label: str = ""
    from_station: str = ""
    to_station: str = ""
    walk_minutes: float | None = None
    manual: bool = False
    type: str = ""                # 交通类型（地铁/公交/市域铁路/轮渡…；手动段可自定义）
    line_name: str = ""
    run_minutes: float | None = None
    stops_text: str = ""
    color: str = ""
    color2: str = ""              # 手动段副色（双色）
    note: str = ""
    headway_text: str = ""            # 手动发车班次文字（如"高峰8/平峰15 分钟一班"）
    timetable: list = field(default_factory=list)  # 时刻表：[[车次, 发时, 到时], ...]
    use_timetable: bool = False       # 按时刻表乘坐列车（勾选后启用时刻表编辑）
    price: float | None = None        # 票价(元)，手动输入
    transfer: bool | None = None      # 跨系统转乘（兼容手动强制指定）。
                                     # None=自动；True/False=用户强制指定。
    service: str = ""                 # 车种（线路 express 服务 id）；空串 = 各站停
    start_time: str = ""              # 实际乘车时刻（运转记录用，规划忽略）
    end_time: str = ""                # 实际到达时刻（运转记录用，规划忽略）
    train_no: str = ""                # 车次（可选）
    train_model: str = ""             # 车型（可选）
    extras: list = field(default_factory=list)  # 本段自定义字段 [{"label": .., "value": ..}]

    def to_dict(self) -> dict:
        return {
            "line_id": self.line_id,
            "direction_label": self.direction_label,
            "from_station": self.from_station,
            "to_station": self.to_station,
            "walk_minutes": self.walk_minutes,
            "manual": self.manual,
            "type": self.type,
            "line_name": self.line_name,
            "run_minutes": self.run_minutes,
            "stops_text": self.stops_text,
            "color": self.color,
            "color2": self.color2,
            "note": self.note,
            "headway_text": self.headway_text,
            "timetable": self.timetable,
            "use_timetable": self.use_timetable,
            "price": self.price,
            "transfer": self.transfer,
            "service": self.service,
            "start_time": self.start_time,
            "end_time": self.end_time,
            "train_no": self.train_no,
            "train_model": self.train_model,
            "extras": self.extras,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Step":
        return cls(
            line_id=data.get("line_id", ""),
            direction_label=data.get("direction_label", ""),
            from_station=data.get("from_station", ""),
            to_station=data.get("to_station", ""),
            walk_minutes=data.get("walk_minutes"),
            manual=data.get("manual", False),
            type=data.get("type", ""),
            line_name=data.get("line_name", ""),
            run_minutes=data.get("run_minutes"),
            stops_text=data.get("stops_text", ""),
            color=data.get("color", ""),
            color2=data.get("color2", ""),
            note=data.get("note", ""),
            headway_text=data.get("headway_text", ""),
            timetable=data.get("timetable", []),
            use_timetable=data.get("use_timetable", False),
            price=data.get("price"),
            transfer=data.get("transfer"),
            service=data.get("service", ""),
            start_time=data.get("start_time", ""),
            end_time=data.get("end_time", ""),
            train_no=data.get("train_no", ""),
            train_model=data.get("train_model", ""),
            extras=data.get("extras", []) or [],
        )


@dataclass
class Trip:
    """一个完整运转行程方案。

    规划方案与运转记录共用这一份结构：记录额外使用 steps[*].start_time / end_time
    与顶层 fields（整次运转自定义字段），规划器会忽略这些字段。
    """
    name: str = "我的运转方案"
    date: str = ""
    city: str = "上海"
    note: str = ""
    transfer_walk_default: float = 5.0   # 默认换乘/站外步行分钟
    paid_zone_mode: bool = False         # 付费区模式：按进闸站→出闸站计费，跨系统转车开启新付费区
    steps: list[Step] = field(default_factory=list)
    fields: list = field(default_factory=list)  # 整次运转自定义字段（运转记录用）

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "date": self.date,
            "city": self.city,
            "note": self.note,
            "transfer_walk_default": self.transfer_walk_default,
            "paid_zone_mode": self.paid_zone_mode,
            "steps": [s.to_dict() for s in self.steps],
            "fields": self.fields,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Trip":
        """容错解析：忽略 kind / version / segments 等非本结构的额外字段。"""
        d = dict(data or {})
        known = {f.name for f in dc_fields(cls)}
        d["steps"] = [
            s if isinstance(s, Step) else Step.from_dict(s)
            for s in d.get("steps", []) or []
            if isinstance(s, (dict, Step))
        ]
        filtered = {k: v for k, v in d.items() if k in known}
        return cls(**filtered)

    def save(self, path: str | Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8") as f:
            json.dump(self.to_dict(), f, ensure_ascii=False, indent=2)

    @classmethod
    def load(cls, path: str | Path) -> "Trip":
        with open(path, "r", encoding="utf-8") as f:
            return cls.from_dict(json.load(f))


def fmt_minutes(m: float) -> str:
    """分钟格式化：整数则去掉小数点。"""
    if float(m).is_integer():
        return f"{int(m)}分钟"
    return f"{m:.1f}分钟"
