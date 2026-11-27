# -*- coding: utf-8 -*-
"""本地冒烟测试：不启动浏览器，直接用本机 Python 验证桥接层（py/web_api.py）。

用途：在把内核交给 Pyodide 之前，先确认「内核 → JSON 接口」这一层没有接线错误；
界面问题与内核问题可以据此快速区分。

用法：python tools/smoke_test.py
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "py"))

import web_api  # noqa: E402
from transit_planner.core.models import City, CityLibrary  # noqa: E402
from transit_planner.core.models import Direction, Line, LineError, TransferEndpoint  # noqa: E402
from transit_planner.core import engine  # noqa: E402
from route_planner import plan_routes  # noqa: E402

web_api.DATA_DIR = str(ROOT / "py" / "data")   # 本地测试直接用仓库里的数据目录


def call(name: str, *args) -> dict:
    res = json.loads(getattr(web_api, name)(*args))
    if not res.get("ok"):
        raise SystemExit(f"[×] {name} 返回错误：{res.get('error')}")
    return res


def check_system_transfers() -> None:
    """系统内同站可换乘；系统间仅允许明确配置的站点对转乘。"""
    source = Line(
        id="system_a", name="系统 A", system="A", stations=["起点", "共站"],
        travel_minutes=[2], directions=[Direction(label="共站方向", terminal="共站")],
    )
    target = Line(
        id="system_b", name="系统 B", system="B", stations=["共站", "终点"],
        travel_minutes=[3], directions=[Direction(label="终点方向", terminal="终点")],
    )
    city = City(name="测试", lines=[source, target])
    try:
        plan_routes(city, "起点", "station", "终点")
    except LineError:
        pass
    else:
        raise AssertionError("同名跨系统站在未配置转乘站对时不应连通")

    city.transfers = [[
        TransferEndpoint(station="共站", system="A"),
        TransferEndpoint(station="共站", system="B"),
    ]]
    cross = plan_routes(city, "起点", "station", "终点")["plans"][0]
    assert cross["transfers"] == 0 and cross["systemTransfers"] == 1
    assert cross["legs"][1]["transfer"] and cross["legs"][1]["walk"] == 5

    target.system = "A"
    city.transfers = []
    same = plan_routes(city, "起点", "station", "终点")["plans"][0]
    assert same["transfers"] == 1 and same["systemTransfers"] == 0
    assert same["legs"][1]["interchange"] and not same["legs"][1]["transfer"]


def main() -> int:
    info = call("api_init")
    print(f"[√] 内核 v{info['version']}（同步于 {info['syncedAt']}）")
    cities = info["cities"]
    print(f"[√] 城市：{'、'.join(cities)}")
    print(f"[√] 同城组合：{'、'.join(info['combinedCities'])}")
    assert info.get("cityFiles", {}).get("广州") == "广州-佛山", "共用文件城市应映射到 广州-佛山.json"
    print("[√] 城市文件映射：广州 / 佛山 → 广州-佛山.json")

    # 数据工坊：读取原始 JSON → 内核校验 → 故意制造错误
    raw = call("api_city_json", "上海")
    assert raw["fileName"] == "上海.json" and raw["city"]["city"] == "上海"
    checked = call("api_validate_city", json.dumps(raw["city"], ensure_ascii=False))
    assert checked["valid"] and checked["stats"]["lines"] == len(raw["city"]["lines"])
    print(f"[√] 数据工坊：读取上海 JSON 并通过校验（{checked['stats']['lines']} 条线路、"
          f"{checked['stats']['stations']} 站、{len(checked['warnings'])} 条提醒）")
    shanghai_systems = {line["system"] for line in raw["city"]["lines"]}
    assert shanghai_systems == {
        "地铁系统", "磁浮系统", "松江有轨电车系统", "金山铁路系统", "公交系统",
    }, f"上海线路系统分类不完整：{shanghai_systems}"
    assert all(
        isinstance(endpoint, dict) and endpoint.get("station") and endpoint.get("system")
        for group in raw["city"]["transfers"] for endpoint in group
    ), "上海转乘站对的每个端点都必须同时声明站名和系统"
    print(f"[√] 上海数据库：{len(shanghai_systems)} 个线路系统，"
          f"{len(raw['city']['transfers'])} 组精确转乘站对")

    broken_doc = json.loads(json.dumps(raw["city"], ensure_ascii=False))
    broken_doc["lines"][0]["travel_minutes"] = ["不是数字"]
    broken = call("api_validate_city", json.dumps(broken_doc, ensure_ascii=False))
    assert not broken["valid"] and broken["errors"], "非法区间时长应被内核校验拦下"
    print(f"[√] 数据工坊：非法数据被拦下（{broken['errors'][0][:24]}…）")

    city_name = "上海" if "上海" in cities else cities[0]
    city = call("api_load_city", city_name)
    print(f"[√] {city_name}：{city['city']['lineCount']} 条线路、{city['city']['stationCount']} 站")
    check_system_transfers()
    shanghai_hints = call("api_transfer_hints", "莘庄", "sh_m1")["hints"]
    jinshan_hint = next(h for h in shanghai_hints if h["id"] == "sh_rail_jinshan")
    assert jinshan_hint["transfer"] and jinshan_hint["boardStation"] == "莘庄"
    print("[√] 上海莘庄：地铁与金山铁路同名站被识别为跨系统转乘")
    metro_direction = call(
        "api_pick_direction", "sh_m1", "莘庄", "上海南站"
    )["direction"]
    rail_direction = call(
        "api_pick_direction", "sh_rail_jinshan", "上海南", "金山卫"
    )["direction"]
    transfer_trip = call("api_evaluate", json.dumps({
        "city": "上海",
        "transfer_walk_default": 5,
        "steps": [
            {"line_id": "sh_m1", "direction_label": metro_direction,
             "from_station": "莘庄", "to_station": "上海南站"},
            {"line_id": "sh_rail_jinshan", "direction_label": rail_direction,
             "from_station": "上海南", "to_station": "金山卫"},
        ],
    }, ensure_ascii=False))
    assert transfer_trip["totals"]["transferCount"] == 0
    assert transfer_trip["totals"]["systemTransferCount"] == 1
    assert transfer_trip["segments"][1]["walk"] == 5
    print("[√] 跨系统行程统计为转乘，且同名转乘站按默认步行时间计算")

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
    assert res["totals"]["transferCount"] == 1
    assert res["totals"]["systemTransferCount"] == 0
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
    assert hints and all(h.get("boardStation") for h in hints), "换乘提示应附带实际可上车站名 boardStation"
    print(f"[√] {b} 可换乘 {len(hints)} 条线路"
          + (f"，例如 {hints[1]['name']} {hints[1]['directions']}" if len(hints) > 1 else ""))

    check_express()
    check_routes()
    check_network_services()
    check_combined_city()

    print("\n全部检查通过。")
    return 0


def check_combined_city() -> None:
    """同城组合只合并明确配置的跨城同站，其余重名站保持独立。"""
    shanghai = call("api_city_json", "上海")["city"]
    suzhou = call("api_city_json", "苏州")["city"]
    original_names = [
        {station for line in doc["lines"] for station in line["stations"]}
        for doc in (shanghai, suzhou)
    ]
    shared_names = original_names[0] & original_names[1]
    assert "花桥" in shared_names, "上海与苏州的同城配置应包含花桥站"

    combined = call("api_load_city", "上海-苏州")
    assert combined["city"]["combined"], "上海-苏州应以同城组合模式加载"
    stations_by_city = {"上海": set(), "苏州": set()}
    line_cities = {}
    for summary in combined["lines"]:
        city_name = summary["cityName"]
        assert city_name in stations_by_city, f"线路 {summary['id']} 应标记所属城市"
        line_cities[summary["id"]] = city_name
        line = call("api_line", summary["id"])["line"]
        stations_by_city[city_name].update(line["stations"])
    assert line_cities["sh_m11"] == "上海" and line_cities["sz_m11"] == "苏州"
    assert "花桥" in stations_by_city["上海"] and "花桥" in stations_by_city["苏州"], \
        "配置为同座车站的花桥应在两地线路中保持同名"
    for station in shared_names - {"花桥"}:
        assert f"{station}（上海）" in stations_by_city["上海"]
        assert f"{station}（苏州）" in stations_by_city["苏州"]
        assert station not in stations_by_city["上海"] | stations_by_city["苏州"]
    combined_city = CityLibrary(ROOT / "py" / "data").load("上海-苏州")
    shanghai_system = combined_city.line("sh_m11").system
    suzhou_system = combined_city.line("sz_m11").system
    assert shanghai_system != suzhou_system
    assert any(
        endpoint.station == "花桥" and endpoint.system == suzhou_system
        for endpoint in engine.transfer_targets(combined_city, "花桥", shanghai_system)
    ), "同城组合应仅将配置的花桥站声明为跨系统共站"
    print(f"[√] 上海-苏州同城组合：{len(shared_names)} 个重名站中仅花桥共站")

    # 共用车站由参与城市的数据声明（数据工坊可编辑），任一城市声明即生效
    with tempfile.TemporaryDirectory() as tmp:
        data_dir = Path(tmp)
        def write_city(name: str, stations: list[str], shared: list[str] | None = None) -> None:
            doc = {
                "city": name,
                "systems": ["地铁系统"],
                "lines": [{
                    "id": f"{name}_m1", "name": f"{name}1号线", "system": "地铁系统",
                    "stations": stations, "travel_minutes": [2] * (len(stations) - 1),
                }],
            }
            if shared is not None:
                doc["combined_shared_stations"] = shared
            (data_dir / f"{name}.json").write_text(
                json.dumps(doc, ensure_ascii=False), encoding="utf-8"
            )

        write_city("上海", ["甲", "交界"], shared=["交界"])
        write_city("苏州", ["交界", "乙"])
        library = CityLibrary(data_dir)
        merged = library.load("上海-苏州")
        assert "交界" in merged.line("上海_m1").stations, "声明的共用车站应保留原名"
        assert "交界" in merged.line("苏州_m1").stations, "声明的共用车站应保留原名"
        assert any(
            endpoint.station == "交界"
            for endpoint in engine.transfer_targets(
                merged, "交界", merged.line("上海_m1").system,
            )
        ), "声明的共用车站应自动成为跨系统转乘站"

        write_city("上海", ["甲", "交界"])
        isolated = CityLibrary(data_dir).load("上海-苏州")
        assert "交界（上海）" in isolated.line("上海_m1").stations, "未声明的重名站应按城市区分"
        assert not engine.transfer_targets(
            isolated, "交界（上海）", isolated.line("上海_m1").system,
        ), "未声明的重名站不应自动转乘"
    print("[√] 同城组合共用车站由数据声明，可在数据工坊中编辑")


def check_network_services() -> None:
    """跨线贯通与线路内快车都能校验、搜索并计算。"""
    beijing_doc = call("api_city_json", "北京")["city"]
    beijing_check = call("api_validate_city", json.dumps(beijing_doc, ensure_ascii=False))
    assert beijing_check["valid"], f"北京贯通交路应通过校验：{beijing_check['errors']}"
    assert (
        beijing_check["city"]["through_services"][0]["id"]
        == beijing_doc["through_services"][0]["id"]
        and [
            (section["line_id"], section["from_station"], section["to_station"])
            for section in beijing_check["city"]["through_services"][0]["segments"]
        ] == [
            (section["line_id"], section["from_station"], section["to_station"])
            for section in beijing_doc["through_services"][0]["segments"]
        ]
    ), "数据工坊校验结果应保留可编辑的 through_services 配置"

    beijing = call("api_load_city", "北京")
    through = next(
        line for line in beijing["lines"] if line["id"] == "bj_through_m9_mfs"
    )
    assert through["stationCount"] == 24, "北京贯通交路应包含两区段的连续站点"
    assert "bj_through_m9_mfs" in beijing["city"]["throughServiceIds"]
    plans = call("api_plan_routes", json.dumps({
        "mode": "station", "origin": "国家图书馆", "target": "阎村东", "limit": 5,
    }, ensure_ascii=False))["plans"]
    assert all(
        leg["lineId"] != "bj_through_m9_mfs"
        for plan in plans for leg in plan["legs"]
    ), "智能规划不应展示班次较少的跨线贯通交路"
    blocked_through_goal = json.loads(web_api.api_plan_routes(json.dumps({
        "mode": "line", "origin": "国家图书馆", "target": "bj_through_m9_mfs",
    }, ensure_ascii=False)))
    assert not blocked_through_goal["ok"], "跨线交路不能作为智能规划的乘坐线路目标"

    through_direction = call(
        "api_pick_direction", "bj_through_m9_mfs", "国家图书馆", "阎村东"
    )["direction"]
    evaluated = call("api_evaluate", json.dumps({
        "city": "北京",
        "steps": [{
            "line_id": "bj_through_m9_mfs",
            "direction_label": through_direction,
            "from_station": "国家图书馆",
            "to_station": "阎村东",
            "manual": False,
        }],
    }, ensure_ascii=False))
    assert evaluated["failedStep"] is None, f"贯通交路仍应可手动计算：{evaluated.get('error')}"
    assert "郭公庄" in evaluated["segments"][0]["stops"]

    through_fast_doc = json.loads(json.dumps(beijing_doc, ensure_ascii=False))
    through_fast_doc["through_services"][0]["express"] = [{
        "id": "test_rapid",
        "name": "跨线直快车",
        "stops": ["国家图书馆", "郭公庄", "阎村东"],
        "section_minutes": [],
        "skip_minutes": 0.4,
        "headway_text": "",
    }]
    fast_check = call("api_validate_city", json.dumps(through_fast_doc, ensure_ascii=False))
    assert fast_check["valid"], f"跨线快车服务应通过校验：{fast_check['errors']}"
    web_api._city = CityLibrary.with_through_services(City.from_dict(through_fast_doc))
    fast_plans = call("api_plan_routes", json.dumps({
        "mode": "station", "origin": "国家图书馆", "target": "阎村东", "limit": 5,
    }, ensure_ascii=False))["plans"]
    assert all(
        leg["lineId"] != "bj_through_m9_mfs"
        for plan in fast_plans for leg in plan["legs"]
    ), "快车班次较少时，智能规划也不应展示跨线交路"
    fast_direction = call(
        "api_pick_direction", "bj_through_m9_mfs", "国家图书馆", "阎村东", "test_rapid"
    )["direction"]
    evaluated_fast = call("api_evaluate", json.dumps({
        "city": "北京",
        "steps": [{
            "line_id": "bj_through_m9_mfs",
            "direction_label": fast_direction,
            "from_station": "国家图书馆",
            "to_station": "阎村东",
            "manual": False,
            "service": "test_rapid",
        }],
    }, ensure_ascii=False))
    assert evaluated_fast["failedStep"] is None, "跨线快车步骤应可由运转内核计算"

    shanghai_doc = call("api_city_json", "上海")["city"]
    shanghai_check = call("api_validate_city", json.dumps(shanghai_doc, ensure_ascii=False))
    assert shanghai_check["valid"], f"上海快车数据应通过校验：{shanghai_check['errors']}"
    call("api_load_city", "上海")
    line16 = call("api_line", "sh_m16")["line"]
    assert [service["name"] for service in line16["express"]] == ["大站车", "直达车"]
    for service_id, service_name, expected_stops in [
        ("rapid", "大站车", ["龙阳路", "罗山路", "新场", "惠南", "临港大道", "滴水湖"]),
        ("direct", "直达车", ["龙阳路", "滴水湖"]),
    ]:
        direction = call("api_pick_direction", "sh_m16", "龙阳路", "滴水湖", service_id)["direction"]
        result = call("api_evaluate", json.dumps({
            "city": "上海",
            "steps": [{
                "line_id": "sh_m16", "direction_label": direction,
                "from_station": "龙阳路", "to_station": "滴水湖",
                "manual": False, "service": service_id,
            }],
        }, ensure_ascii=False))
        segment = result["segments"][0]
        assert segment["serviceName"] == service_name and segment["stops"] == expected_stops
    express_route = call("api_plan_routes", json.dumps({
        "mode": "station", "origin": "龙阳路", "target": "滴水湖", "limit": 1,
    }, ensure_ascii=False))["plans"][0]
    assert any(
        leg["lineId"] == "sh_m16" and leg["service"] == "direct"
        for leg in express_route["legs"]
    ), "智能规划应能使用更快的直达车服务"

    chongqing_doc = call("api_city_json", "重庆")["city"]
    chongqing_check = call("api_validate_city", json.dumps(chongqing_doc, ensure_ascii=False))
    assert chongqing_check["valid"], f"重庆快车数据应通过校验：{chongqing_check['errors']}"
    call("api_load_city", "重庆")
    line15 = next(line for line in call("api_load_city", "重庆")["lines"] if line["id"] == "cq_m15")
    assert line15["type"] == "suburban", "重庆15号线应标记为市域铁路"
    line10 = call("api_line", "cq_m10")["line"]
    assert [service["id"] for service in line10["express"]] == ["direct_fast"]
    expected_direct_stops = [
        "王家庄", "中央公园西", "江北机场T2航站楼", "江北机场T3航站楼",
        "上湾路", "重庆北站北广场", "重庆北站南广场", "红土地",
        "鲤鱼池", "曾家岩", "大礼堂", "七星岗", "万寿路", "兰花路",
    ]
    direction = call(
        "api_pick_direction", "cq_m10", expected_direct_stops[0], expected_direct_stops[-1], "direct_fast"
    )["direction"]
    result = call("api_evaluate", json.dumps({
        "city": "重庆",
        "steps": [{
            "line_id": "cq_m10", "direction_label": direction,
            "from_station": expected_direct_stops[0], "to_station": expected_direct_stops[-1],
            "manual": False, "service": "direct_fast",
        }],
    }, ensure_ascii=False))
    assert result["segments"][0]["stops"] == expected_direct_stops
    assert "南坪" not in result["segments"][0]["stops"]
    cq_through_id = "cq_through_m5_m0_m4"
    assert cq_through_id in {service["id"] for service in chongqing_doc["through_services"]}
    cq_through = call("api_line", cq_through_id)["line"]
    expected_cq_stops = [
        "跳磴", "华岩中心", "金建路", "重庆西站", "上桥", "重庆图书馆",
        "沙坪坝", "冉家坝", "民安大道", "重庆北站北广场", "头塘", "唐家沱",
    ]
    assert [service["name"] for service in cq_through["express"]] == ["直快车"]
    assert cq_through["color"] == "#B35A20"
    assert cq_through["headwayText"] == "30分钟一班"
    assert cq_through["express"][0]["headwayText"] == "30分钟一班"
    editable_chongqing = json.loads(json.dumps(chongqing_doc, ensure_ascii=False))
    editable_service = editable_chongqing["through_services"][0]
    editable_service["color"] = "#B35A20"
    editable_service["headway_rush"] = 30
    editable_service["headway_normal"] = 30
    editable_service["express"][0]["headway_text"] = "30分钟一班"
    edit_check = call(
        "api_validate_city", json.dumps(editable_chongqing, ensure_ascii=False)
    )
    assert edit_check["valid"], f"数据工坊修改跨线交路后应通过校验：{edit_check['errors']}"
    saved_service = edit_check["city"]["through_services"][0]
    assert saved_service["color"] == "#B35A20"
    assert saved_service["headway_rush"] == saved_service["headway_normal"] == 30
    assert saved_service["express"][0]["headway_text"] == "30分钟一班"
    assert saved_service["express"][0]["stops"] == expected_cq_stops
    cq_direction = call(
        "api_pick_direction", cq_through_id, expected_cq_stops[0], expected_cq_stops[-1],
        "cq_direct_fast",
    )["direction"]
    cq_result = call("api_evaluate", json.dumps({
        "city": "重庆",
        "steps": [{
            "line_id": cq_through_id,
            "direction_label": cq_direction,
            "from_station": expected_cq_stops[0],
            "to_station": expected_cq_stops[-1],
            "manual": False,
            "service": "cq_direct_fast",
        }],
    }, ensure_ascii=False))
    assert cq_result["failedStep"] is None, f"重庆跨线直快车应可计算：{cq_result.get('error')}"
    assert cq_result["segments"][0]["stops"] == expected_cq_stops
    assert cq_result["segments"][0]["serviceName"] == "直快车"
    cq_smart_routes = call("api_plan_routes", json.dumps({
        "mode": "station", "origin": "跳磴", "target": "唐家沱", "limit": 5,
    }, ensure_ascii=False))["plans"]
    assert all(
        leg["lineId"] != cq_through_id
        for plan in cq_smart_routes for leg in plan["legs"]
    ), "班次较少的重庆跨线直快车不应进入智能规划"
    call("api_load_city", "上海")
    print("[√] 北京贯通/跨线快车、上海16号线快车、重庆跨线直快车均可配置和计算")
    suzhou_doc = call("api_city_json", "苏州")["city"]
    suzhou_check = call("api_validate_city", json.dumps(suzhou_doc, ensure_ascii=False))
    assert suzhou_check["valid"], f"苏州线路数据应通过校验：{suzhou_check['errors']}"
    suzhou_systems = {"地铁系统", "有轨电车系统", "智轨系统"}
    assert set(suzhou_doc["systems"]) == suzhou_systems
    assert all(line["system"] in suzhou_systems for line in suzhou_doc["lines"])
    assert all(line["type"] != "national_rail" for line in suzhou_doc["lines"])
    duplicate_station_systems = {}
    for line in suzhou_doc["lines"]:
        for station in line["stations"]:
            duplicate_station_systems.setdefault(station, set()).add(line["system"])
    expected_transfer_groups = {
        frozenset((station, system) for system in systems)
        for station, systems in duplicate_station_systems.items()
        if len(systems) > 1
    }
    configured_transfer_groups = {
        frozenset((endpoint["station"], endpoint["system"]) for endpoint in group)
        for group in suzhou_doc["transfers"]
        if not any(endpoint["system"] in (suzhou_doc.get("station_systems") or {}) for endpoint in group)
    }
    assert configured_transfer_groups == expected_transfer_groups, (
        "苏州应且仅应声明所有跨系统同名车站为转乘站"
    )
    suzhou_rail_pairs = {
        (group[0]["station"], group[1]["station"])
        for group in suzhou_doc["transfers"]
        if group[1]["system"] == "国家铁路系统"
    }
    assert ("苏州火车站", "苏州") in suzhou_rail_pairs, f"苏州火车站应登记国铁转乘：{suzhou_rail_pairs}"
    invalid_system_doc = json.loads(json.dumps(suzhou_doc, ensure_ascii=False))
    invalid_system_doc["systems"].remove("智轨系统")
    invalid_system_check = call(
        "api_validate_city", json.dumps(invalid_system_doc, ensure_ascii=False)
    )
    assert not invalid_system_check["valid"], "删除仍被线路引用的系统应无法通过校验"
    suzhou = call("api_load_city", "苏州")
    suzhou_line = call("api_line", "sz_m11")["line"]
    assert suzhou_line["system"] == "地铁系统"
    suzhou_hints = call("api_transfer_hints", "狮子山", "sz_m1")["hints"]
    tram_hint = next(hint for hint in suzhou_hints if hint["id"] == "sz_tram_t1")
    assert tram_hint["transfer"] and tram_hint["boardStation"] == "狮子山"
    metro_direction = call("api_pick_direction", "sz_m1", "狮子山", "塔园路")["direction"]
    tram_direction = call("api_pick_direction", "sz_tram_t1", "狮子山", "新区公园")["direction"]
    suzhou_transfer = call("api_evaluate", json.dumps({
        "city": "苏州",
        "steps": [
            {"line_id": "sz_m1", "direction_label": metro_direction,
             "from_station": "狮子山", "to_station": "塔园路"},
            {"line_id": "sz_tram_t1", "direction_label": tram_direction,
             "from_station": "狮子山", "to_station": "新区公园"},
        ],
    }, ensure_ascii=False))
    assert suzhou_transfer["totals"]["transferCount"] == 0
    assert suzhou_transfer["totals"]["systemTransferCount"] == 1
    print("[√] 苏州狮子山：地铁与有轨电车按指定同名站转乘")
    assert suzhou_line["stations"][0] == "唯亭" and suzhou_line["stations"][-1] == "花桥"
    assert "金厍桥" not in suzhou_line["stations"]
    assert len(suzhou_line["travelMinutes"]) == len(suzhou_line["stations"]) - 1
    assert suzhou_line["directions"] == ["花桥方向", "唯亭方向"]
    through_ids = {"sz_through_m3_m11", "sz_through_m4_m7"}
    assert through_ids.issubset(set(suzhou["city"]["throughServiceIds"]))
    for line_id, origin, target, junction in [
        ("sz_through_m3_m11", "花桥", "金厍桥", "唯亭"),
        ("sz_through_m4_m7", "龙道浜", "木里", "红庄"),
    ]:
        through_line = call("api_line", line_id)["line"]
        assert through_line["system"] == "地铁系统"
        assert through_line["stations"][0] == origin and through_line["stations"][-1] == target
        assert through_line["stations"].count(junction) == 1
        assert len(through_line["travelMinutes"]) == len(through_line["stations"]) - 1
        direction = call("api_pick_direction", line_id, origin, target)["direction"]
        result = call("api_evaluate", json.dumps({
            "city": "苏州",
            "steps": [{
                "line_id": line_id,
                "direction_label": direction,
                "from_station": origin,
                "to_station": target,
                "manual": False,
            }],
        }, ensure_ascii=False))
        assert result["failedStep"] is None, f"{through_line['name']}应可计算：{result.get('error')}"
        assert result["segments"][0]["stops"] == through_line["stations"]
        assert result["segments"][0]["system"] == "地铁系统"
    smart_suzhou_route = call("api_plan_routes", json.dumps({
        "mode": "station", "origin": "花桥", "target": "金厍桥", "limit": 5,
    }, ensure_ascii=False))["plans"]
    assert all(
        leg["lineId"] not in through_ids
        for plan in smart_suzhou_route for leg in plan["legs"]
    ), "苏州智能规划不应使用低频跨线交路"
    print("[√] 苏州3/11号线与4/7号线贯通车可配置和计算，智能规划不纳入")

    shenzhen_doc = call("api_city_json", "深圳")["city"]
    shenzhen_check = call("api_validate_city", json.dumps(shenzhen_doc, ensure_ascii=False))
    assert shenzhen_check["valid"], f"深圳线路数据应通过校验：{shenzhen_check['errors']}"
    shenzhen = call("api_load_city", "深圳")
    assert "szn_m8" not in {line["id"] for line in shenzhen["lines"]}
    shenzhen_line = next(line for line in shenzhen["lines"] if line["id"] == "szn_m2")
    assert shenzhen_line["name"] == "深圳地铁2/8号线"
    assert shenzhen_line["shortName"] == "2/8号线"
    print("[√] 苏州11号线缩至唯亭—花桥，深圳8号线并入2/8号线")


def check_routes() -> None:
    """智能规划：前往车站 / 乘坐线路两种模式都能给出可计算的方案。"""
    city = call("api_load_city", "上海")
    lines = [
        ln for ln in city["lines"]
        if not ln.get("ring") and ln["stationCount"] >= 5 and not ln["name"].endswith("支线")
    ]
    assert len(lines) >= 2, "智能规划测试需要至少两条非环线线路"
    first = call("api_line", lines[0]["id"])["line"]
    second = call("api_line", lines[1]["id"])["line"]
    origin = first["stations"][0]
    target = second["stations"][-1]
    assert origin != target, "测试起点与终点不应相同"

    params = {"mode": "station", "origin": origin, "target": target, "transferWalk": 5, "limit": 5}
    plans = call("api_plan_routes", json.dumps(params, ensure_ascii=False))["plans"]
    assert plans, "前往车站模式应给出方案"
    for plan in plans:
        assert plan["transfers"] + plan["systemTransfers"] == max(0, len(plan["legs"]) - 1), "换乘与转乘之和应与乘车段数一致"
        assert abs(plan["minutes"] - sum(leg["run"] + leg["walk"] for leg in plan["legs"])) < 0.3
        evaluated = call("api_evaluate", json.dumps({"city": "上海", "steps": plan["steps"]}, ensure_ascii=False))
        assert evaluated["failedStep"] is None, f"方案步骤应可被内核计算：{evaluated.get('error')}"
    print(f"[√] 智能规划（前往车站）：{origin} → {target}，{len(plans)} 个方案，"
          f"推荐 {plans[0]['minutes']} 分钟 / 换乘 {plans[0]['transfers']} 次")

    params = {"mode": "line", "origin": origin, "target": second["id"], "transferWalk": 5, "limit": 5}
    plans = call("api_plan_routes", json.dumps(params, ensure_ascii=False))["plans"]
    assert plans, "乘坐线路模式应给出方案"
    for plan in plans:
        assert plan["legs"][-1]["lineId"] == second["id"], "方案最后一段应乘坐所选线路"
        assert abs(plan["minutes"] - sum(leg["run"] + leg["walk"] for leg in plan["legs"])) < 0.3
    print(f"[√] 智能规划（乘坐线路）：{second['name']}，{len(plans)} 个方案，"
          f"推荐 {plans[0]['minutes']} 分钟 / 换乘 {plans[0]['transfers']} 次")

    # 环线允许同站起终点表示单方向完整乘坐一圈，并可经首尾相接处到达下一站
    ring_summary = next(ln for ln in city["lines"] if ln["id"] == "sh_m4")
    ring = call("api_line", ring_summary["id"])["line"]
    ring_origin = ring["stations"][0]
    ring_plans = call("api_plan_routes", json.dumps({
        "mode": "line", "origin": ring_origin, "target": ring["id"], "limit": 5,
    }, ensure_ascii=False))["plans"]
    assert ring_plans, "从环线闭合站出发应能规划乘坐环线"
    for plan in ring_plans:
        ring_legs = [leg for leg in plan["legs"] if leg["lineId"] == ring["id"]]
        assert len(ring_legs) == 1, "每个乘坐线路方案应只乘坐所选线路的一个方向"
        assert len(ring_legs[0]["stops"]) == len(ring["stations"]), "环线一圈应经过去重后的全线车站并回到起点"
        evaluated = call("api_evaluate", json.dumps({
            "city": "上海", "steps": plan["steps"],
        }, ensure_ascii=False))
        assert evaluated["failedStep"] is None, f"环线方案应可被计算：{evaluated.get('error')}"
    print(f"[√] 智能规划（环线）：{ring_origin} 出发可单向乘坐一圈并通过行程校验")

    cross_closure = call("api_plan_routes", json.dumps({
        "mode": "station", "origin": "上海体育馆", "target": "虹桥路", "limit": 5,
    }, ensure_ascii=False))["plans"]
    closure_plan = next((
        plan for plan in cross_closure
        if plan["legs"][0]["lineId"] == ring["id"]
        and plan["legs"][0]["stops"][:3] == ["上海体育馆", "宜山路", "虹桥路"]
    ), None)
    assert closure_plan, "应能经宜山路闭合站跨越线路站表首尾"
    evaluated = call("api_evaluate", json.dumps({
        "city": "上海", "steps": closure_plan["steps"],
    }, ensure_ascii=False))
    assert evaluated["failedStep"] is None, f"跨越环线闭合站的方案应可计算：{evaluated.get('error')}"
    print("[√] 智能规划：上海体育馆可经宜山路跨越4号线站表首尾到达虹桥路")

    same = json.loads(web_api.api_plan_routes(json.dumps({
        "mode": "station", "origin": origin, "target": origin,
    }, ensure_ascii=False)))
    assert not same["ok"] and same["error"], "起点与终点相同时应返回错误"


def check_express() -> None:
    """快车（大站快车）在数据库 JSON 中定义，规划与记录都能识别。"""
    city = call("api_city_json", "上海")["city"]
    target = next(ln for ln in city["lines"] if len(ln["stations"]) >= 6)
    stations = target["stations"]
    express_stops = [stations[0], stations[2], stations[-1]]
    doc = json.loads(json.dumps(city, ensure_ascii=False))
    for ln in doc["lines"]:
        if ln["id"] == target["id"]:
            ln["express"] = [{
                "id": "rapid",
                "name": "大站车",
                "stops": express_stops,
                "section_minutes": [],
                "skip_minutes": 0.4,
                "headway_text": "高峰 20 分钟一班",
            }]

    check = call("api_validate_city", json.dumps(doc, ensure_ascii=False))
    assert check["ok"] and check["valid"], f"含快车服务的城市数据应通过校验：{check.get('errors')}"
    print(f"[√] 快车数据校验通过：{target['name']} 的「大站车」停 {len(express_stops)} 站")

    bad = json.loads(json.dumps(doc, ensure_ascii=False))
    for ln in bad["lines"]:
        if ln["id"] == target["id"]:
            ln["express"][0]["stops"] = [stations[-1], stations[0]]
    bad_check = call("api_validate_city", json.dumps(bad, ensure_ascii=False))
    assert not bad_check["valid"], "停靠站顺序倒置应被校验拦下"
    print("[√] 快车停靠站乱序会被校验拦下")

    # 写入数据目录并重新加载城市，验证规划内核端到端识别快车
    data_path = Path(web_api.DATA_DIR) / "上海.json"
    original = data_path.read_text(encoding="utf-8")
    try:
        data_path.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
        call("api_load_city", "上海")
        line_id = target["id"]
        normal = call("api_evaluate", json.dumps({
            "name": "t", "city": "上海", "steps": [{
                "line_id": line_id, "direction_label": target["directions"][0]["label"],
                "from_station": stations[0], "to_station": stations[-1], "manual": False,
            }],
        }, ensure_ascii=False))["segments"][0]
        rapid = call("api_evaluate", json.dumps({
            "name": "t", "city": "上海", "steps": [{
                "line_id": line_id, "direction_label": target["directions"][0]["label"],
                "from_station": stations[0], "to_station": stations[-1], "manual": False, "service": "rapid",
            }],
        }, ensure_ascii=False))["segments"][0]
        assert rapid["serviceName"] == "大站车", f"应返回车种名，实际 {rapid.get('serviceName')}"
        assert rapid["stopCount"] < normal["stopCount"], "快车停站数应少于各站停"
        assert rapid["run"] < normal["run"], "快车运行时长应短于各站停"
        assert rapid["headway"] == "高峰 20 分钟一班", f"应使用快车自己的班次文字，实际 {rapid['headway']}"
        assert [s for s in rapid["stops"]] == express_stops, f"快车经停站应为 {express_stops}，实际 {rapid['stops']}"
        print(f"[√] 快车识别：{rapid['stopCount']} 站 / {rapid['run']} 分钟，"
              f"普通车 {normal['stopCount']} 站 / {normal['run']} 分钟")

        reach = call("api_reachable_any", line_id, stations[0], "rapid")["stations"]
        assert reach and all(s in express_stops for s in reach), f"快车可达站应只在停靠站内，实际 {reach}"
        direction = call("api_pick_direction", line_id, stations[0], stations[-1], "rapid")["direction"]
        assert direction, "快车应能自动判定方向"
        print(f"[√] 快车可达站与方向判定正常（{direction}）")

        # 规划与记录 JSON 结构互通：记录字段（起止时间等）不影响内核计算
        record_like = call("api_evaluate", json.dumps({
            "kind": "record", "version": 2, "name": "记录", "city": "上海",
            "fields": [{"label": "天气", "value": "晴"}],
            "steps": [{
                "line_id": line_id, "direction_label": direction,
                "from_station": stations[0], "to_station": stations[-1], "manual": False,
                "start_time": "07:30", "end_time": "08:00", "train_no": "1234",
                "train_model": "A 型车", "extras": [{"label": "座位号", "value": "1-2"}],
            }],
        }, ensure_ascii=False))
        assert record_like["ok"] and record_like["evaluatedSteps"] == 1, "记录格式的方案应能被内核计算"
        assert record_like["totals"]["run"] > 0
        print("[√] 运转记录格式（含起止时间与自定义字段）可直接被内核计算")
    finally:
        data_path.write_text(original, encoding="utf-8")
        call("api_load_city", "上海")

    check_direction_stops()
    check_station_systems()

    print("\n全部检查通过。")
    return 0


def check_direction_stops() -> None:
    """上下行停靠站不一致：按方向计算时长与经停站，穿越不服务站但不作为终点。"""
    call("api_load_city", "北京")
    line = call("api_line", "bj_msdjc")["line"]
    stops = line["directionSkips"]
    assert set(stops) == {"2号航站楼方向", "北新桥方向"}, f"首都机场线应有两个方向的停靠表：{stops}"
    assert stops["北新桥方向"] == ["2号航站楼", "三元桥", "东直门", "北新桥"], \
        f"北新桥方向应跳过 3号航站楼，实际 {stops['北新桥方向']}"

    def ride(direction: str, origin: str, target: str) -> dict:
        payload = {
            "city": "北京",
            "steps": [{
                "line_id": "bj_msdjc", "direction_label": direction,
                "from_station": origin, "to_station": target, "manual": False,
            }],
        }
        res = call("api_evaluate", json.dumps(payload, ensure_ascii=False))
        assert res["ok"], f"{origin} → {target}（{direction}）应可计算：{res.get('error')}"
        return res["segments"][0]

    outbound = ride("2号航站楼方向", "北新桥", "2号航站楼")
    inbound = ride("北新桥方向", "2号航站楼", "北新桥")
    assert outbound["stops"] == ["北新桥", "东直门", "三元桥", "3号航站楼", "2号航站楼"], \
        f"2号航站楼方向应停靠全部车站，实际 {outbound['stops']}"
    assert inbound["stops"] == ["2号航站楼", "三元桥", "东直门", "北新桥"], \
        f"北新桥方向不应停靠 3号航站楼，实际 {inbound['stops']}"
    assert len(outbound["stops"]) == 5 and len(inbound["stops"]) == 4

    blocked = call("api_evaluate", json.dumps({
        "city": "北京",
        "steps": [{
            "line_id": "bj_msdjc", "direction_label": "北新桥方向",
            "from_station": "3号航站楼", "to_station": "北新桥", "manual": False,
        }],
    }, ensure_ascii=False))
    assert blocked["evaluatedSteps"] == 0 and blocked["failedStep"] == 0, "北新桥方向不应在 3号航站楼办客"
    assert "不停靠" in blocked["error"], f"应提示该方向不停靠：{blocked['error']}"

    # 智能规划可以让列车穿过不服务站，但不能在该站上下车
    plan = call("api_plan_routes", json.dumps({
        "origin": "2号航站楼", "target": "东直门", "mode": "station", "limit": 1,
    }, ensure_ascii=False))
    assert plan["ok"] and plan["plans"], f"2号航站楼 应能直达 东直门：{plan.get('error')}"
    assert plan["plans"][0]["legs"][0]["stops"] == ["2号航站楼", "三元桥", "东直门"], \
        f"应穿过 3号航站楼但不停靠：{plan['plans'][0]['legs'][0]['stops']}"
    no_plan = json.loads(web_api.api_plan_routes(json.dumps({
        "origin": "3号航站楼", "target": "东直门", "mode": "station", "limit": 1,
    }, ensure_ascii=False)))
    assert not no_plan["ok"], "3号航站楼 不在北新桥方向停靠，不应规划出反向方案"
    print(f"[√] 上下行停靠站：正向 {len(outbound['stops'])} 站 / 反向 {len(inbound['stops'])} 站，"
          "反向不停靠的车站无法上下车，智能规划可穿过但不停靠")


def check_station_systems() -> None:
    """强互通系统：只登记站名的城际 / 国铁系统出现在转乘提示中，不进入线路库。"""
    city = call("api_load_city", "珠江三角洲")
    systems = {item["name"]: item for item in city["city"]["stationSystems"]}
    assert systems["广东城际系统"]["type"] == "intercity", "广东城际系统应以 intercity 类型登记"
    assert systems["国家铁路系统"]["type"] == "national_rail", "国家铁路系统应以 national_rail 类型登记"
    assert all(line["system"] not in systems for line in city["lines"]), "强互通系统不应出现在线路库中"

    hints = call("api_transfer_hints", "广州南站", "gz_m2")
    names = {item["system"]: item for item in hints["stationSystems"]}
    assert names["广东城际系统"]["station"] == "广州南", f"应提示转乘广东城际系统的广州南站：{names}"
    assert names["国家铁路系统"]["typeLabel"] == "国家铁路", "国铁系统提示应带类型文字"
    assert not any(hint.get("system") in names for hint in hints["hints"]), "强互通系统不应作为可乘坐线路返回"

    dongguan = call("api_city_json", "东莞")["city"]
    stations = {s for line in dongguan["lines"] for s in line["stations"]}
    transfer_names = {
        endpoint["station"] for pair in dongguan["transfers"] for endpoint in pair
        if endpoint["station"] not in stations
    }
    declared = set(dongguan["station_systems"]["广东城际系统"]["stations"])
    assert transfer_names <= declared, \
        f"无所属系统的转乘站应全部登记为广东城际系统：{transfer_names - declared}"

    # 同站异名的写法同样要继承国铁提示（汉口站北广场 → 汉口火车站 → 国铁汉口）
    call("api_load_city", "武汉")
    wuhan_hints = call("api_transfer_hints", "汉口站北广场", "")
    wuhan_names = {item["system"]: item for item in wuhan_hints["stationSystems"]}
    assert wuhan_names["国家铁路系统"]["station"] == "汉口", \
        f"异名车站应继承国铁转乘提示：{wuhan_names}"
    print("[√] 强互通系统：转乘提示可用、不进线路库，珠三角无所属系统的转乘站已登记为广东城际系统")


if __name__ == "__main__":
    raise SystemExit(main())
