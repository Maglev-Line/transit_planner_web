# -*- coding: utf-8 -*-
"""应用设置持久化（基于 QSettings，关闭软件后保留）。

保存内容：最常出行城市 / 地铁站 / 公交站、自动保存开关与位置、在线地图 API 密钥。
"""
from __future__ import annotations

from dataclasses import dataclass, field, fields, MISSING

ORG = "运转计划助手"
APP = "settings"


@dataclass
class AppSettings:
    # 常用出行
    favorite_city: str = ""
    favorite_metro: str = ""
    favorite_bus: str = ""
    # 自动保存
    auto_save: bool = False
    auto_save_dir: str = ""
    # 在线地图 API（仅获取线路信息，不含实时状态）
    amap_enabled: bool = False
    amap_key: str = ""
    baidu_enabled: bool = False
    baidu_key: str = ""
    tencent_enabled: bool = False
    tencent_key: str = ""
    # 用户自定义交通类型（如 轮渡、缆车…），key 即显示名
    custom_transit_types: list[str] = field(default_factory=list)

    def save(self) -> None:
        from PySide6.QtCore import QSettings
        s = QSettings(ORG, APP)
        for f in fields(self):
            s.setValue(f.name, getattr(self, f.name))
        s.sync()

    @classmethod
    def load(cls) -> "AppSettings":
        from PySide6.QtCore import QSettings
        s = QSettings(ORG, APP)
        data = {}
        for f in fields(cls):
            default = f.default
            if f.default_factory is not MISSING:  # default_factory 字段（如 list）
                raw = s.value(f.name, f.default_factory())
                if isinstance(raw, str):  # QSettings 空列表有时以空串返回
                    raw = [x for x in raw.split("\0") if x]
                raw = list(raw or f.default_factory())
                data[f.name] = [str(x) for x in raw]
            elif isinstance(default, bool):
                data[f.name] = s.value(f.name, default, type=bool)
            elif isinstance(default, list):
                raw = s.value(f.name, default)
                if isinstance(raw, str):
                    raw = [x for x in raw.split("\0") if x]
                raw = list(raw or default)
                data[f.name] = [str(x) for x in raw]
            else:
                data[f.name] = s.value(f.name, default, type=str)
        return cls(**data)

    @property
    def enabled_providers(self) -> list[str]:
        out = []
        if self.amap_enabled:
            out.append("amap")
        if self.baidu_enabled:
            out.append("baidu")
        if self.tencent_enabled:
            out.append("tencent")
        return out
