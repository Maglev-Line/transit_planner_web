# -*- coding: utf-8 -*-
"""把桌面版《运转计划助手》的纯逻辑内核与城市数据同步到本 Web 项目。

只读源项目、只写本项目目录，不改动桌面版任何文件。

用法：
    python tools/sync_core.py                      # 自动寻找同级的「运转计划生成器」
    python tools/sync_core.py --src "Z:/3_张峻恺/运转计划生成器"

同步内容：
    <src>/transit_planner/__init__.py   -> py/transit_planner/__init__.py
    <src>/transit_planner/core/*.py     -> py/transit_planner/core/*.py
    <src>/transit_planner/data/*.json   -> py/data/*.json
并重新生成 py/manifest.json（浏览器端按该清单加载文件，无需硬编码文件名）。
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent            # 本 Web 项目根目录
DEFAULT_SRC = ROOT.parent / "运转计划生成器"              # 桌面版项目（默认同级目录）


def _copy_dir(src_dir: Path, dst_dir: Path, pattern: str) -> tuple[list[str], list[str]]:
    """按 pattern 复制目录内容到目标目录，返回（写入的文件, 清理的旧文件）。"""
    dst_dir.mkdir(parents=True, exist_ok=True)
    names = sorted(p.name for p in src_dir.glob(pattern) if p.is_file())
    written: list[str] = []
    removed: list[str] = []
    for name in names:
        src, dst = src_dir / name, dst_dir / name
        if dst.exists() and src.read_bytes() == dst.read_bytes():
            continue
        shutil.copy2(src, dst)
        written.append(name)
    for p in sorted(dst_dir.glob(pattern)):
        if p.is_file() and p.name not in names:
            p.unlink()
            removed.append(p.name)
    return written, removed


def _source_version(init_py: Path) -> str:
    try:
        m = re.search(r'__version__\s*=\s*"([^"]+)"', init_py.read_text(encoding="utf-8"))
        return m.group(1) if m else "unknown"
    except OSError:
        return "unknown"


def main() -> int:
    ap = argparse.ArgumentParser(description="同步桌面版 core 与 data 到本项目")
    ap.add_argument("--src", type=Path, default=DEFAULT_SRC, help="《运转计划生成器》目录")
    args = ap.parse_args()

    src = args.src.resolve()
    pkg = src / "transit_planner"
    if not (pkg / "core" / "engine.py").is_file():
        print(f"[×] 未找到桌面版内核：{pkg / 'core' / 'engine.py'}", file=sys.stderr)
        print("    请用 --src 指定《运转计划生成器》目录", file=sys.stderr)
        return 1

    py_dir = ROOT / "py"
    core_written, core_removed = _copy_dir(pkg / "core", py_dir / "transit_planner" / "core", "*.py")
    data_written, data_removed = _copy_dir(pkg / "data", py_dir / "data", "*.json")

    (py_dir / "transit_planner").mkdir(parents=True, exist_ok=True)
    pkg_init = py_dir / "transit_planner" / "__init__.py"
    if not pkg_init.exists() or pkg_init.read_bytes() != (pkg / "__init__.py").read_bytes():
        shutil.copy2(pkg / "__init__.py", pkg_init)
        core_written.append("../__init__.py")

    core_files = ["transit_planner/__init__.py"] + [
        f"transit_planner/core/{p.name}" for p in sorted((py_dir / "transit_planner" / "core").glob("*.py"))
    ]
    data_files = [p.name for p in sorted((py_dir / "data").glob("*.json"))]
    manifest = {
        "source": str(src),
        "sourceVersion": _source_version(pkg / "__init__.py"),
        "syncedAt": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "coreFiles": core_files,
        "dataFiles": data_files,
    }
    (py_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    print(f"[√] 内核 {len(core_files)} 个文件、数据 {len(data_files)} 个城市")
    print(f"    更新 {len(core_written)} 个内核文件、{len(data_written)} 个数据文件"
          f"；清理 {len(core_removed) + len(data_removed)} 个过期文件")
    print(f"    源版本 v{manifest['sourceVersion']}  ->  py/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
