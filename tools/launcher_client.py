#!/usr/bin/env python3
"""Perfara离线版 便携包入口：只启动采集客户端 GUI。

目录结构（与 Perfara-Portable 一致）：
    Perfara离线版.exe              ← 本启动器
    collector\\Perfara离线版.exe    ← 采集客户端（Electron，已移除激活与上传）
    logs\\                    ← 运行日志

本地版说明：
    - 采集数据只落在本机 collector\\resources\\reports\\ 下，不上传任何服务器；
    - 每次「停止采集」都会在 reports\\history\\ 归档一份，可在客户端点「报告库」查看与对比；
    - 因此不再需要看板服务进程，也不再生成上传配置。
"""
from __future__ import annotations

import ctypes
import subprocess
import sys
import time
from pathlib import Path

APP_NAME = "Perfara离线版"


def base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def log(msg: str, log_path: Path) -> None:
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    try:
        print(line, flush=True)
    except Exception:
        pass
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def fatal(msg: str) -> None:
    try:
        ctypes.windll.user32.MessageBoxW(None, msg, APP_NAME, 0x10)
    except Exception:
        pass


def main() -> int:
    base = base_dir()
    log_path = base / "logs" / "launcher.log"
    log(f"启动 {APP_NAME}（本地版），目录 {base}", log_path)

    collector_exe = base / "collector" / "Perfara离线版.exe"
    if not collector_exe.is_file():
        fatal(f"缺少文件：\n{collector_exe}\n\n请确认压缩包已完整解压。")
        log(f"缺少采集客户端：{collector_exe}", log_path)
        return 1

    log("启动采集客户端 ...", log_path)
    try:
        gui = subprocess.Popen([str(collector_exe)], cwd=str(collector_exe.parent))
    except Exception as e:
        fatal(f"采集客户端启动失败：\n{e}")
        log(f"采集客户端启动失败：{e}", log_path)
        return 1

    gui.wait()
    log(f"采集客户端已退出 code={gui.returncode}", log_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
