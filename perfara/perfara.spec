# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 打包配置：生成便携式单文件 Perfara.exe。

用法：
    .venv/Scripts/python.exe -m PyInstaller perfara.spec --noconfirm --clean

产物：dist/Perfara.exe（单文件，双击即启动服务并打开浏览器）
"""
from PyInstaller.utils.hooks import collect_submodules

# uvicorn / fastapi / sqlalchemy 大量使用动态导入，需显式收集子模块
_hidden = []
for _pkg in (
    "uvicorn",
    "fastapi",
    "starlette",
    "pydantic",
    "pydantic_settings",
    "sqlalchemy",
    "anyio",
    "websockets",
    "watchfiles",
    "httptools",
    "multipart",
    "itsdangerous",
):
    try:
        _hidden += collect_submodules(_pkg)
    except Exception:
        pass

_hidden += [
    "backend",
    "backend.app",
    "backend.paths",
    "backend.database",
    "backend.models",
    "backend.schemas",
    "backend.parsers",
    "backend.settings",
    "backend.utils",
    "backend.auth_deps",
    "backend.trend_metrics",
    "backend.logging_setup",
    "backend.version",
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
]

# 只读资源：前端构建产物、图表配置、种子数据库
# ⚠️ 种子库只能用 _seed/webperf.db（脱敏后的演示数据），**不能**用 data/webperf.db
# —— 那是开发机工作库，含真实设备序列号 / 机型 / 应用包名 / 用户 uid，编进 exe 后
# 首次启动会复制给用户。生成方式：python tools/make_seed_db.py
import os as _os
_SEED = _os.path.join(globals().get("SPECPATH", "."), "_seed", "webperf.db")
if not _os.path.isfile(_SEED):
    raise SystemExit(
        "[spec] 缺少脱敏种子库: %s\n"
        "请先运行: python tools/make_seed_db.py\n"
        "（绝不要改回 data/webperf.db —— 那是开发机真实数据）" % _SEED
    )

_datas = [
    ("frontend/dist", "frontend/dist"),
    ("backend/chart-configs", "backend/chart-configs"),
    (_SEED, "data"),
]

a = Analysis(
    ["launcher.py"],
    pathex=["."],
    binaries=[],
    datas=_datas,
    hiddenimports=_hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "tkinter",
        "matplotlib",
        "numpy",
        "pandas",
        "scipy",
        "PIL",
        "PyQt5",
        "PySide2",
        "pytest",
        "IPython",
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="Perfara",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,  # 关闭 UPX，避免被杀软误报
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,  # 保留控制台：可看启动日志、Ctrl+C 停止
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
