# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 打包配置：生成便携包里的「纯服务」exe。

与 perfara.spec 的差别只在产物形态：
    perfara.spec        → Perfara.exe        合并版（服务 + 自动开浏览器，console 可见）
    perfara_server.spec → PerfaraServer.exe  便携包 server\\ 下的后台服务（无控制台、无浏览器）

用法（在 perfara/ 目录下执行）：
    ..\\tools\\.venv\\Scripts\\python.exe -m PyInstaller perfara_server.spec --noconfirm --clean
产物：dist\\PerfaraServer.exe

注意：改过 backend/ 或 frontend/dist 之后必须重打，否则便携包里的服务会落后于源码
（历史上就因为漏打，出现过 .js 被当成 text/plain 返回、看板整页空白的问题）。
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
# ⚠️ 种子库必须是 _seed/webperf.db（脱敏后的演示数据），**不能**是 data/webperf.db。
# data/webperf.db 是开发机的工作库，含真实设备序列号 / 机型 / 应用包名 / 用户 uid；
# 一旦编进 exe，首次启动就会复制给用户，而 zip 层审计（剔 data/ + 扫文本条目）
# 看不见它 —— 因为它被压在 PyInstaller 归档里。生成方式：
#     python tools/make_seed_db.py
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

_ICON = _os.path.abspath(_os.path.join(
    globals().get("SPECPATH", "."), "..", "_client_src", "app", "icon", "perfara.ico"))
if not _os.path.isfile(_ICON):
    raise SystemExit("[spec] 缺少应用图标: %s" % _ICON)

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
    name="PerfaraServer",
    icon=_ICON,
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,  # 关闭 UPX，避免被杀软误报
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,  # 便携包由启动器后台拉起，不需要黑框
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
