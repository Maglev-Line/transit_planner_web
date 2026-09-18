# -*- coding: utf-8 -*-
"""浏览器端（Pyodide）调用入口：把桌面版内核的纯函数包装成 JSON 接口。

约定：
- 本文件属于 Web 项目，**不要**把业务规则写在这里；所有计算都必须经 `transit_planner.core.engine`
  （与桌面版共用同一份权威实现，避免两套逻辑漂移）。
- 每个 api_* 函数都返回 JSON 字符串（成功 `{"ok": true, ...}`，失败 `{"ok": false, "error": "..."}`），
  这样 JS 侧永远拿到结构化结果，不会因异常中断。
"""
from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

from transit_planner.core import engine
from transit_planner.core.models import (
    TYPE_LABELS,
    City,
    CityLibrary,
    Direction,
    Line,
    LineError,
    Step,
    Trip,
    type_display,
)

DATA_DIR = "/data"

_lib: CityLibrary | None = None
_city_name: str | None = None
_city: City | None = None


# ---------------- 内部工具 ----------------

def _library() -> CityLibrary:
    """延迟创建 CityLibrary（其构造函数会建目录，避免导入即产生副作用）。"""
    global _lib
    if _lib is None:
        _lib = CityLibrary(DATA_DIR)
    return _lib

def _ok(**kw) -> str:
    return json.dumps({"ok": True, **kw}, ensure_ascii=False)


def _err(message: str) -> str:
    return json.dumps({"ok": False, "error": message}, ensure_ascii=False)


def _line_summary(ln: Line, brief: bool = False) -> dict:
    d = {
        "id": ln.id,
        "name": ln.name,
        "shortName": ln.short_name,
        "type": ln.type,
        "typeLabel": type_display(ln.type),
        "color": ln.color,
        "color2": ln.color2,
        "operator": ln.operator,
        "ring": ln.ring,
        "stationCount": len(ln.stations),
        "headwayText": ln.headway_text,
        "firstTrain": ln.first_train,
        "lastTrain": ln.last_train,
        "directions": [x.label for x in ln.directions],
    }
    if not brief:
        d["stations"] = list(ln.stations)
        d["travelMinutes"] = list(ln.travel_minutes)
    return d


def _require_city() -> City:
    if _city is None:
        raise LineError("尚未加载城市线路库")
    return _city


def _step_headway(seg) -> str:
    """发车班次：手动段用填写文字，数据库段用线路班次。"""
    if seg.manual:
        return seg.step.headway_text or "不定班"
    return seg.line.headway_text


def _segment_payload(seg) -> dict:
    ln = seg.line
    return {
        "manual": seg.manual,
        "transfer": bool(seg.transfer),
        "paidZone": seg.paid_zone_index,
        "lineId": ln.id,
        "lineName": ln.name,
        "shortName": ln.short_name,
        "type": ln.type,
        "typeLabel": type_display(ln.type),
        "color": ln.color or "#888888",
        "color2": ln.color2 or "",
        "direction": (seg.step.direction_label or "手动方向") if seg.manual else seg.direction.label,
        "from": seg.step.from_station,
        "to": seg.step.to_station,
        "run": round(seg.run_minutes, 1),
        "walk": round(seg.walk_minutes, 1),
        "stopCount": seg.stop_count,
        "stops": list(seg.stops),
        "headway": _step_headway(seg),
        "firstTrain": "" if seg.manual else ln.first_train,
        "lastTrain": "" if seg.manual else ln.last_train,
        "note": seg.step.note,
        "price": seg.step.price,
        "timetable": seg.step.timetable,
        "useTimetable": bool(seg.step.use_timetable),
    }


def _result_payload(trip: Trip, result) -> dict:
    segments = []
    for i, seg in enumerate(result.segments):
        payload = _segment_payload(seg)
        prev = trip.steps[i - 1].to_station if i > 0 else None
        # 默认换乘步行：忽略用户已填值，按「同站 0 / 其余取默认」给出建议值
        payload["walkDefault"] = round(
            engine.resolve_walk(replace(seg.step, walk_minutes=None), prev, trip.transfer_walk_default, _city), 1
        )
        # 库中自动判定的转乘（与用户强制指定无关），供界面提示
        payload["transferAuto"] = bool(prev is not None and engine.is_known_transfer(_city, prev, seg.step.from_station))
        segments.append(payload)
    zones = [
        {
            "index": z.index + 1,
            "entry": z.entry_station,
            "exit": z.exit_station,
            "run": round(z.run_minutes, 1),
            "price": z.price,
            "segmentCount": len(z.segments),
        }
        for z in result.paid_zones
    ]
    return {
        "segments": segments,
        "totals": {
            "run": round(result.total_run, 1),
            "walk": round(result.total_walk, 1),
            "minutes": round(result.total_minutes, 1),
            "transferCount": result.transfer_count,
            "fareTransferCount": result.fare_transfer_count,
            "lineCount": result.line_count,
            "stopCount": sum(s.stop_count for s in result.segments),
            "price": round(engine.price_total(trip, result), 2),
        },
        "paidZones": zones,
        "zonePrices": [[n, a, b, round(p, 2)] for n, a, b, p in engine.zone_prices(trip, result)],
        "paidZoneMode": trip.paid_zone_mode,
    }


# ---------------- 接口 ----------------

def api_init() -> str:
    """启动信息：内核版本、交通类型表、数据清单。"""
    from transit_planner import APP_NAME, __version__

    manifest_path = Path("/py/manifest.json")
    manifest = {}
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    return _ok(
        appName=APP_NAME,
        version=__version__,
        syncedAt=manifest.get("syncedAt", ""),
        typeLabels=TYPE_LABELS,
        cities=sorted(p.stem for p in Path(DATA_DIR).glob("*.json")),
        combinedCities={k: list(v) for k, v in CityLibrary.COMBINED_CITIES.items()},
    )


def api_load_city(name: str) -> str:
    """加载城市（或同城组合），返回线路库摘要。"""
    global _city, _city_name
    try:
        if not name:
            _city, _city_name = None, None
            return _ok(city=None, lines=[])
        city = _library().load(name)
        _city, _city_name = city, name
        return _ok(
            city={
                "name": city.name,
                "region": city.region,
                "combined": CityLibrary.is_combined(name),
                "parts": list(CityLibrary.COMBINED_CITIES.get(name, ())),
                "lineCount": len(city.lines),
                "stationCount": len(engine.all_stations(city)),
                "transferGroups": city.transfers,
                "aliasGroups": city.aliases,
            },
            lines=[_line_summary(ln, brief=True) for ln in city.lines],
        )
    except Exception as exc:  # noqa: BLE001 - 统一转成 JSON 错误返回界面
        return _err(f"加载线路库失败：{exc}")


def api_line(line_id: str) -> str:
    """线路详情（含完整站表与区间时长）。"""
    try:
        ln = _require_city().line(line_id)
        return _ok(line=_line_summary(ln))
    except Exception as exc:  # noqa: BLE001
        return _err(str(exc))


def api_stations() -> str:
    """当前城市全部站点（去重，用于输入推荐）。"""
    try:
        return _ok(stations=engine.all_stations(_require_city()))
    except Exception as exc:  # noqa: BLE001
        return _err(str(exc))


def api_search_lines(keyword: str, limit: int = 20) -> str:
    """按关键词搜索线路（名称 / 简称 / id 模糊匹配）。"""
    try:
        city = _require_city()
        kw = (keyword or "").strip().lower()
        out = []
        for ln in city.lines:
            hay = f"{ln.name} {ln.short_name} {ln.id}".lower()
            if not kw or kw in hay:
                out.append(_line_summary(ln, brief=True))
        return _ok(lines=out[: max(1, int(limit))])
    except Exception as exc:  # noqa: BLE001
        return _err(str(exc))


def api_pick_direction(line_id: str, from_station: str, to_station: str) -> str:
    """按起终点自动选择方向，返回方向名（不可达返回 null）。"""
    try:
        ln = _require_city().line(line_id)
        d = engine.pick_direction(ln, from_station, to_station)
        return _ok(direction=d.label if d else None)
    except Exception as exc:  # noqa: BLE001
        return _err(str(exc))


def api_reachable(line_id: str, direction_label: str, from_station: str) -> str:
    """当前站、当前方向下可到达的后续站点。"""
    try:
        ln = _require_city().line(line_id)
        d = ln.directions[ln.direction_index(direction_label)]
        return _ok(stations=engine.reachable_from(_require_city(), ln, d, from_station))
    except Exception as exc:  # noqa: BLE001
        return _err(str(exc))


def api_transfer_hints(station: str, exclude_line_id: str = "") -> str:
    """某站可换乘的线路与方向（含同站异名）。"""
    try:
        city = _require_city()
        if not station:
            return _ok(hints=[])
        hints = []
        for ln, dirs in engine.transfer_hints(city, station):
            hints.append({
                **_line_summary(ln, brief=True),
                "directions": [d.label for d in dirs],
                "current": ln.id == exclude_line_id,
            })
        return _ok(hints=hints)
    except Exception as exc:  # noqa: BLE001
        return _err(str(exc))


def api_evaluate(trip_json: str) -> str:
    """评估整个方案。

    逐段容错：若第 k 段无法计算，则只返回前 k 段的完整结果，并给出错误段落与原因，
    界面可继续显示（而不是整页报错）。
    """
    try:
        trip = Trip.from_dict(json.loads(trip_json))
    except Exception as exc:  # noqa: BLE001
        return _err(f"方案数据格式错误：{exc}")

    last_ok = 0
    result = None
    error_message = ""
    for k in range(len(trip.steps), -1, -1):
        try:
            result = engine.evaluate_trip(_city, replace(trip, steps=trip.steps[:k]))
            last_ok = k
            break
        except LineError as exc:
            error_message = str(exc)
        except Exception as exc:  # noqa: BLE001
            error_message = f"{type(exc).__name__}: {exc}"

    payload = _result_payload(replace(trip, steps=trip.steps[:last_ok]), result)
    payload["evaluatedSteps"] = last_ok
    payload["failedStep"] = last_ok if last_ok < len(trip.steps) else None
    payload["error"] = error_message
    payload["ok"] = True
    return json.dumps(payload, ensure_ascii=False)


def api_walk_suggestion(trip_json: str, index: int) -> str:
    """第 index 段的上车前步行分钟默认值（同站 0，其余用默认值）。"""
    try:
        trip = Trip.from_dict(json.loads(trip_json))
        if index <= 0 or index >= len(trip.steps):
            return _ok(walk=0.0)
        prev = trip.steps[index - 1].to_station
        step = trip.steps[index]
        return _ok(walk=engine.resolve_walk(step, prev, trip.transfer_walk_default, _city))
    except Exception as exc:  # noqa: BLE001
        return _err(str(exc))


def api_manual_types() -> str:
    """内置交通类型的选择项。"""
    return _ok(types=[{"key": k, "label": v} for k, v in TYPE_LABELS.items()])


def api_default_step() -> str:
    """新建行程段的默认值。"""
    return _ok(step=Step().to_dict(), trip=Trip().to_dict())


def api_new_trip(city: str = "") -> str:
    trip = Trip(city=city or _city_name or "上海")
    return _ok(trip=trip.to_dict())
