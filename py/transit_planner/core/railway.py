# -*- coding: utf-8 -*-
"""铁路 12306 辅助：根据发站/到站生成车次查询链接。

查询地址基于 12306 官方「余票查询」页。12306 要求使用车站电报码，
这里通过官方 station_name.js 解析车站编码；解析失败时回退到官网首页。
"""
from __future__ import annotations

import re
import urllib.parse
import urllib.request

_STATION_NAME_URL = "https://kyfw.12306.cn/otn/resources/js/framework/station_name.js"
_UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) 运转计划助手/1.1"}
_codes_cache: dict[str, str] | None = None


def _station_codes() -> dict[str, str]:
    """返回 站名 -> 电报码 映射（带缓存）。"""
    global _codes_cache
    if _codes_cache is not None:
        return _codes_cache
    codes: dict[str, str] = {}
    try:
        req = urllib.request.Request(_STATION_NAME_URL, headers=_UA)
        with urllib.request.urlopen(req, timeout=10) as resp:
            text = resp.read().decode("utf-8", "replace")
        m = re.search(r"var\s+station_names\s*=\s*'([^']*)'", text)
        if m:
            for entry in m.group(1).split("@"):
                parts = entry.split("|")
                if len(parts) >= 3 and parts[1] and parts[2]:
                    codes.setdefault(parts[1], parts[2])
    except Exception:
        pass
    _codes_cache = codes
    return codes


def build_12306_url(from_station: str, to_station: str, date: str = "") -> str:
    """生成 12306 车次查询链接；解析不到车站编码时回退到 12306 首页。"""
    codes = _station_codes()
    f_code = codes.get(from_station, "")
    t_code = codes.get(to_station, "")
    if f_code and t_code:
        params = {
            "linktypeid": "dc",
            "fs": f"{from_station},{f_code}",
            "ts": f"{to_station},{t_code}",
            "date": date or "",
        }
        return "https://kyfw.12306.cn/otn/leftTicket/init?" + urllib.parse.urlencode(params)
    return "https://www.12306.cn/"
