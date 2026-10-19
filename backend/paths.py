"""统一路径解析：同一套代码既能在源码目录运行，也能在 PyInstaller 打包后的 exe 里运行。

打包后有两类目录，必须分开：
- 只读资源（前端构建产物、图表配置、种子数据库）→ 位于 PyInstaller 的解包目录 ``sys._MEIPASS``；
- 可写数据（数据库、日志）→ 位于 exe 所在目录，便携式程序拷走即可带走数据。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

#: 是否运行在 PyInstaller 打包环境中
FROZEN = bool(getattr(sys, "frozen", False))


def _bundle_root() -> Path:
    """只读资源根目录。"""
    if FROZEN:
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
    return Path(__file__).resolve().parent.parent


def _app_root() -> Path:
    """可写数据根目录。可用环境变量 PERFARA_HOME 覆盖（例如放到 U 盘固定目录）。"""
    env = (os.environ.get("PERFARA_HOME") or "").strip()
    if env:
        return Path(env).expanduser().resolve()
    if FROZEN:
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


BUNDLE_ROOT = _bundle_root()
APP_ROOT = _app_root()


def resource(*parts: str) -> Path:
    """只读资源路径（打包后在解包目录，源码运行时在项目根）。"""
    return BUNDLE_ROOT.joinpath(*parts)


def user_data(*parts: str) -> Path:
    """可写数据路径（打包后在 exe 同级目录，源码运行时在项目根）。"""
    return APP_ROOT.joinpath(*parts)


def ensure_data_dir() -> Path:
    """确保 data 目录存在并返回其路径。"""
    d = user_data("data")
    d.mkdir(parents=True, exist_ok=True)
    return d


def seed_database(target: Path, bundled: Path | None = None) -> bool:
    """首次运行时把随包携带的演示数据库复制到可写目录。

    返回 True 表示发生了复制。目标已存在时不覆盖，避免升级 exe 冲掉用户数据。
    """
    target = Path(target)
    if target.exists():
        return False
    src = Path(bundled) if bundled else resource("data", "webperf.db")
    if not src.is_file():
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        import shutil

        shutil.copy2(src, target)
        return True
    except Exception:
        return False
