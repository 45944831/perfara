#!/usr/bin/env python3
"""Perfara 便携版启动器 / PyInstaller 打包入口。

双击 exe 即可启动服务并自动打开浏览器：
  Perfara.exe                 默认 http://127.0.0.1:8000/
  Perfara.exe --port 8099     指定端口
  Perfara.exe --host 0.0.0.0  允许局域网访问（默认仅本机）
  Perfara.exe --no-browser    不自动打开浏览器
  Perfara.exe --data-dir D:\\perfara-data  指定数据目录（数据库 / 日志）

数据（data/webperf.db、logs/）默认保存在 exe 同目录，整个文件夹拷走即可迁移。
"""
from __future__ import annotations

import argparse
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

APP_NAME = "Perfara"
DEFAULT_PORT = 8000
PORT_SCAN = 20  # 端口被占用时向后顺延尝试的次数


def _app_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def _setup_console() -> None:
    """Windows 控制台：标题 + UTF-8 输出，避免中文在重定向/老代码页下变乱码。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    if os.name == "nt":
        try:
            import ctypes

            ctypes.windll.kernel32.SetConsoleTitleW(f"{APP_NAME} 便携版")
        except Exception:
            pass


def _bootstrap_paths(data_dir: str | None) -> Path:
    """在导入 backend 之前确定可写目录，并把种子数据库就位。"""
    root = Path(data_dir).expanduser().resolve() if data_dir else _app_root()
    os.environ.setdefault("PERFARA_HOME", str(root))
    os.makedirs(root / "data", exist_ok=True)
    os.makedirs(root / "logs", exist_ok=True)

    from backend.paths import seed_database

    db = root / "data" / "webperf.db"
    if seed_database(db):
        print(f"[init] 已初始化数据库: {db}", flush=True)
    os.environ.setdefault("WEB_PERF_DB", str(db))
    return root


def _port_free(host: str, port: int) -> bool:
    bind_host = "127.0.0.1" if host in ("0.0.0.0", "::") else host
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((bind_host, port))
            return True
        except OSError:
            return False


def _pick_port(host: str, preferred: int) -> int:
    for p in range(preferred, preferred + PORT_SCAN):
        if _port_free(host, p):
            return p
    return preferred


def _open_browser_when_ready(url: str, timeout: float = 30.0) -> None:
    health = url.rstrip("/") + "/api/health"
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(health, timeout=1) as resp:
                if resp.status == 200:
                    webbrowser.open(url)
                    return
        except (urllib.error.URLError, OSError, ValueError):
            time.sleep(0.3)
    print(f"[warn] 服务在 {timeout:.0f}s 内未就绪，请手动打开 {url}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(
        prog=APP_NAME,
        description="Perfara 性能洞察平台 · 便携版",
        add_help=True,
    )
    parser.add_argument("--host", default=os.environ.get("WEBPERF_HOST", "127.0.0.1"),
                        help="监听地址，默认 127.0.0.1（仅本机）；用 0.0.0.0 开放局域网")
    parser.add_argument("--port", type=int, default=int(os.environ.get("WEBPERF_PORT", DEFAULT_PORT)),
                        help=f"监听端口，默认 {DEFAULT_PORT}；被占用时自动顺延")
    parser.add_argument("--data-dir", default=os.environ.get("PERFARA_HOME"),
                        help="数据目录（数据库与日志），默认为 exe 所在目录")
    parser.add_argument("--no-browser", action="store_true", help="启动后不自动打开浏览器")
    args = parser.parse_args()

    _setup_console()
    root = _bootstrap_paths(args.data_dir)
    # 相对路径（若有）统一以数据目录为基准，避免从别处启动时路径漂移
    try:
        os.chdir(root)
    except OSError:
        pass

    port = _pick_port(args.host, args.port)
    if port != args.port:
        print(f"[warn] 端口 {args.port} 已被占用，改用 {port}", flush=True)

    try:
        import uvicorn

        from backend.app import app
    except Exception as exc:  # 依赖缺失 / 打包不完整时给出可读提示
        print(f"[error] 启动失败: {type(exc).__name__}: {exc}", flush=True)
        try:
            if sys.stdin and sys.stdin.isatty():
                input("按回车键退出...")
        except Exception:
            pass
        return 1

    local = f"http://127.0.0.1:{port}/"
    print("=" * 60, flush=True)
    print(f" {APP_NAME} · 性能洞察平台（便携版）", flush=True)
    print(f" 数据目录 : {root}", flush=True)
    print(f" 访问地址 : {local}", flush=True)
    print(f" 演示账号 : {local}?uid=perfara123", flush=True)
    if args.host in ("0.0.0.0", "::"):
        print(f" 局域网   : http://<本机IP>:{port}/", flush=True)
    print(" 停止服务 : Ctrl+C（或直接关闭本窗口）", flush=True)
    print("=" * 60, flush=True)

    if not args.no_browser:
        threading.Thread(target=_open_browser_when_ready, args=(local,), daemon=True).start()

    config = uvicorn.Config(
        app,
        host=args.host,
        port=port,
        log_config=None,  # 沿用 backend 里已配置好的文件 + 控制台日志
        access_log=False,
        workers=1,
    )
    server = uvicorn.Server(config)
    try:
        server.run()
    except KeyboardInterrupt:
        print("\n[exit] 已停止", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
