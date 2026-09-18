"""数据模型：线路、方向、城市库、行程方案。

所有数据以 JSON 形式存储（人类可读、可手工编辑）。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from pathlib import Path

# 交通类型常量
TYPE_METRO = "metro"          # 地铁
TYPE_SUBURBAN = "suburban"    # 市域铁路
TYPE_TRAM = "tram"            # 有轨电车
TYPE_MONORAIL = "monorail"    # 单轨
TYPE_CLOUDRAIL = "cloudrail"  # 比亚迪云巴
TYPE_BUS = "bus"              # 公交
TYPE_RAIL = "national_rail"   # 国家铁路
TYPE_MAGLEV = "maglev"        # 磁浮
TYPE_FERRY = "ferry"          # 轮渡
TYPE_CABLEWAY = "cableway"    # 索道（缆车）

TYPE_LABELS = {
    TYPE_METRO: "地铁",
    TYPE_SUBURBAN: "市域铁路",
    TYPE_TRAM: "有轨电车",
    TYPE_MONORAIL: "单轨",
    TYPE_CLOUDRAIL: "比亚迪云巴",
    TYPE_BUS: "公交",
    TYPE_RAIL: "国家铁路",
    TYPE_MAGLEV: "磁浮",
    TYPE_FERRY: "轮渡",
    TYPE_CABLEWAY: "索道",
}


def type_display(key: str) -> str:
    """交通类型的显示文字：内置类型查表；用户自定义类型直接以名称为 key。"""
    return TYPE_LABELS.get(key, key)


def all_type_keys() -> list[str]:
    """内置交通类型 key 列表（含轮渡/索道）。"""
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

    def to_dict(self) -> dict:
        d = asdict(self)
        return d

    @classmethod
    def from_dict(cls, data: dict) -> "Line":
        data = dict(data)
        data["directions"] = [Direction(**x) for x in data.get("directions", [])]
        return cls(**data)


@dataclass
class City:
    """一个城市的线路库。"""
    name: str
    region: str = ""
    version: str = "1.0"
    lines: list[Line] = field(default_factory=list)
    external_walks: dict[str, float] = field(default_factory=dict)  # "A|B" -> 步行分钟
    transfers: list[list[str]] = field(default_factory=list)
    # 转乘站组：同一地点、不同名称、分属不同付费系统（如地铁"上海南站"↔国铁"上海南"），
    # 换乘必须出闸/换系统，应标记为「转乘」。
    aliases: list[list[str]] = field(default_factory=list)
    # 同站异名组：同一车站、同一付费系统、仅名称不同（如广州"西塱"↔广佛线"西朗"），
    # 换乘不出闸，按同站换乘（步行 0 分钟）处理。

    def line(self, line_id: str) -> Line:
        for ln in self.lines:
            if ln.id == line_id:
                return ln
        raise LineError(f"城市 {self.name} 中不存在线路 {line_id}")

    def lines_serving(self, station: str) -> list[Line]:
        return [ln for ln in self.lines if station in ln.stations]

    def to_dict(self) -> dict:
        return {
            "city": self.name,
            "region": self.region,
            "version": self.version,
            "lines": [ln.to_dict() for ln in self.lines],
            "external_walks": self.external_walks,
            "transfers": self.transfers,
            "aliases": self.aliases,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "City":
        return cls(
            name=data.get("city", "未命名"),
            region=data.get("region", ""),
            version=data.get("version", "1.0"),
            lines=[Line.from_dict(x) for x in data.get("lines", [])],
            external_walks=data.get("external_walks", {}),
            transfers=data.get("transfers", []),
            aliases=data.get("aliases", []),
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

    def __init__(self, data_dir: str | Path) -> None:
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)

    def list_cities(self) -> list[str]:
        files = sorted(p.stem for p in self.data_dir.glob("*.json"))
        return sorted(set(files) | set(self.COMBINED_CITIES))

    @staticmethod
    def is_combined(name: str) -> bool:
        return name in CityLibrary.COMBINED_CITIES

    def load(self, city: str) -> City:
        if city in self.COMBINED_CITIES:
            return self._load_combined(city)
        path = self.data_dir / f"{city}.json"
        if not path.exists():
            raise FileNotFoundError(f"未找到城市线路库：{path}")
        with path.open("r", encoding="utf-8") as f:
            return City.from_dict(json.load(f))

    def _load_combined(self, key: str) -> City:
        """合并多座城市为一座虚拟城市（线路/换乘/同站异名全部合并）。"""
        merged = City(name=key, region="同城组合", version="1.0")
        line_ids: set[str] = set()
        for part in self.COMBINED_CITIES[key]:
            path = self.data_dir / f"{part}.json"
            if not path.exists():
                continue
            with path.open("r", encoding="utf-8") as f:
                c = City.from_dict(json.load(f))
            for ln in c.lines:
                if ln.id in line_ids:
                    continue  # 避免 ID 冲突
                line_ids.add(ln.id)
                merged.lines.append(ln)
            merged.external_walks.update(c.external_walks)
            for grp in c.transfers:
                if grp not in merged.transfers:
                    merged.transfers.append(grp)
            for grp in c.aliases:
                if grp not in merged.aliases:
                    merged.aliases.append(grp)
        return merged

    def save(self, city: City) -> None:
        path = self.data_dir / f"{city.name}.json"
        tmp = path.with_suffix(".json.tmp")
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(city.to_dict(), f, ensure_ascii=False, indent=2)
        tmp.replace(path)

    def delete(self, city: str) -> None:
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
    transfer: bool | None = None      # 跨付费区转乘（转乘）：上车前需出闸/换系统。
                                     # None=自动（按数据中的转乘站组判定）；True/False=用户强制指定。

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
        )


@dataclass
class Trip:
    """一个完整运转行程方案。"""
    name: str = "我的运转方案"
    date: str = ""
    city: str = "上海"
    note: str = ""
    transfer_walk_default: float = 5.0   # 默认换乘/站外步行分钟
    paid_zone_mode: bool = False         # 付费区模式：按进闸站→出闸站计费，跨付费区转车标记「转乘」
    steps: list[Step] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "date": self.date,
            "city": self.city,
            "note": self.note,
            "transfer_walk_default": self.transfer_walk_default,
            "paid_zone_mode": self.paid_zone_mode,
            "steps": [s.to_dict() for s in self.steps],
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Trip":
        d = dict(data)
        d["steps"] = [Step.from_dict(x) for x in d.get("steps", [])]
        return cls(**d)

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
