# -*- coding: utf-8 -*-
"""本地冒烟测试：不启动浏览器，直接用本机 Python 验证桥接层（py/web_api.py）。

用途：在把内核交给 Pyodide 之前，先确认「内核 → JSON 接口」这一层没有接线错误；
界面问题与内核问题可以据此快速区分。

用法：python tools/smoke_test.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "py"))

import web_api  # noqa: E402

web_api.DATA_DIR = str(ROOT / "py" / "data")   # 本地测试直接用仓库里的数据目录


def call(name: str, *args) -> dict:
    res = json.loads(getattr(web_api, name)(*args))
    if not res.get("ok"):
        raise SystemExit(f"[×] {name} 返回错误：{res.get('error')}")
    return res


def main() -> int:
    info = call("api_init")
    print(f"[√] 内核 v{info['version']}（同步于 {info['syncedAt']}）")
    cities = info["cities"]
    print(f"[√] 城市：{'、'.join(cities)}")
    print(f"[√] 同城组合：{'、'.join(info['combinedCities'])}")

    city_name = "上海" if "上海" in cities else cities[0]
    city = call("api_load_city", city_name)
    print(f"[√] {city_name}：{city['city']['lineCount']} 条线路、{city['city']['stationCount']} 站")

    lines = call("api_search_lines", "1号线")["lines"]
    line = lines[0]
    detail = call("api_line", line["id"])["line"]
    print(f"[√] 线路详情：{detail['name']}（{detail['typeLabel']}），{detail['stationCount']} 站，"
          f"{detail['headwayText']}，方向 {detail['directions']}")

    a, b = detail["stations"][0], detail["stations"][3]
    direction = call("api_pick_direction", line["id"], a, b)["direction"]
    reachable = call("api_reachable", line["id"], direction, a)["stations"]
    assert b in reachable, "可达站列表里应包含目标站"
    print(f"[√] {a} → {b} 自动选方向「{direction}」，可达 {len(reachable)} 站")

    # 不限方向的可达站（界面：先选起点/到达站，方向自动判定）
    any_from_head = call("api_reachable_any", line["id"], a)["stations"]
    assert b in any_from_head, "不限方向时应包含目标站"
    assert a not in any_from_head, "不限方向的可达站不应包含起点站自身"
    assert set(any_from_head) == set(detail["stations"]) - {a}, "不限方向时应覆盖本线其余全部站点"
    any_from_tail = call("api_reachable_any", line["id"], detail["stations"][-1])["stations"]
    assert any_from_tail and detail["stations"][-2] in any_from_tail, "末站应能反向到达前一站"
    print(f"[√] 不限方向：{a} 可达 {len(any_from_head)} 站；末站可达 {len(any_from_tail)} 站")

    trip = {
        "name": "冒烟测试", "date": "2026-01-01", "city": city_name, "note": "",
        "transfer_walk_default": 5.0, "paid_zone_mode": False,
        "steps": [
            {"line_id": line["id"], "direction_label": direction, "from_station": a, "to_station": b,
             "manual": False, "price": 4.0},
            {"line_id": "", "direction_label": "手动方向", "from_station": b, "to_station": "某不存在站",
             "manual": True, "line_name": "手动测试线", "run_minutes": 12.5, "type": "bus",
             "stops_text": f"{b}、中间站、某不存在站", "headway_text": "高峰8分钟一班", "price": 2.0,
             "timetable": [["G123", "07:00", "07:12"]], "use_timetable": True},
        ],
    }
    res = call("api_evaluate", json.dumps(trip, ensure_ascii=False))
    assert res["evaluatedSteps"] == 2 and res["failedStep"] is None, "两段都应可计算"
    first = res["segments"][0]
    print(f"[√] 第 1 段：{first['lineName']} {first['from']} → {first['to']}，"
          f"运行 {first['run']} 分钟 / {first['stopCount']} 站，经停 {len(first['stops'])} 站，"
          f"默认步行 {first['walkDefault']} 分钟")
    assert res["totals"]["price"] == 6.0, "票价合计应为 6.0"
    print(f"[√] 统计：总时长 {res['totals']['minutes']} 分钟（运行 {res['totals']['run']} + "
          f"步行 {res['totals']['walk']}）、换乘 {res['totals']['transferCount']} 次、"
          f"线路 {res['totals']['lineCount']} 条、票价 ¥{res['totals']['price']}")

    # 付费区模式：同站折返两段（不转乘）应属于同一付费区
    trip["paid_zone_mode"] = True
    zone = call("api_evaluate", json.dumps(trip, ensure_ascii=False))
    zones = zone["paidZones"]
    assert len(zones) == 1 and zones[0]["segmentCount"] == 2, f"应合并为 1 个付费区，实际 {zones}"
    print(f"[√] 付费区模式：付费区 1（{zones[0]['entry']} → {zones[0]['exit']}，"
          f"{zones[0]['segmentCount']} 段，票价 ¥{zones[0]['price']}）")

    # 容错：故意把第 2 段起点写成该线路不存在的站
    broken = json.loads(json.dumps(trip, ensure_ascii=False))
    broken["steps"][0]["to_station"] = "不存在的站"
    bad = call("api_evaluate", json.dumps(broken, ensure_ascii=False))
    assert bad["failedStep"] == 0 and bad["error"], "应报告第 1 段计算失败"
    print(f"[√] 容错：第 {bad['failedStep'] + 1} 段失败并返回原因 → {bad['error']}")

    hints = call("api_transfer_hints", b, line["id"])["hints"]
    print(f"[√] {b} 可换乘 {len(hints)} 条线路"
          + (f"，例如 {hints[1]['name']} {hints[1]['directions']}" if len(hints) > 1 else ""))

    print("\n全部检查通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
