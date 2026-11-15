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
import ctypes
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


# --------------------------------------------------------------- 父进程存活守卫
#
# 背景：PerfaraServer.exe 是 console=False 的 PyInstaller onefile —— 没有控制台窗口，
# 没有关闭接口，也没有任何「拉起我的人没了我就退」的机制。谁拉起它谁就得负责收尾；
# 拉起者一旦异常退出（被强杀 / 崩溃 / 脚本跑完），服务进程就成了孤儿，一直占着端口，
# 下次启动顺延到 8001 / 8002，越积越多。v2026.10.20.1 修过启动器侧（Job Object +
# taskkill /T），但只要绕过启动器直接跑 exe，问题原样复现。
#
# 这里从**子进程侧**兜底：把祖先进程链上的 SYNCHRONIZE 句柄全打开，任一个消失就退出。
#
# 为什么是「整条祖先链」而不是「直接父进程」：onefile 是两层，
#     启动器 → bootloader(PID A) → python 子进程(PID B)
# B 的直接父进程是 A（bootloader），而先死的往往是启动器 —— A 还活着。只盯直接父进程
# 在这种形态下完全失效，而这正是本机 4 个残留进程的实际结构
# （45100 的父进程 30148 仍在，30148 的父进程 25536 已消失）。
#
# 上溯到桌面会话根（explorer.exe 等）就停：双击启动时它们的父进程就是它们自己，
# 监视它们只会让「资源管理器重启」误杀正在用的服务。

ROOT_PROCESS_NAMES = frozenset({
    "explorer.exe", "services.exe", "svchost.exe", "wininit.exe", "lsass.exe",
    "csrss.exe", "winlogon.exe", "smss.exe", "system", "registry", "idle",
})

SYNCHRONIZE = 0x00100000
TH32CS_SNAPPROCESS = 0x00000002
WAIT_OBJECT_0 = 0x00000000
WAIT_FAILED = 0xFFFFFFFF
INFINITE = 0xFFFFFFFF
MAX_WATCH = 60          # MAXIMUM_WAIT_OBJECTS - 4，留余量
WATCH_GRACE_S = 3.0     # 收到退出信号后给 uvicorn 的收尾时间

_WATCHDOG_HOOK = None   # 由 main() 注入：优雅停机回调


class _PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", ctypes.c_ulong),
        ("cntUsage", ctypes.c_ulong),
        ("th32ProcessID", ctypes.c_ulong),
        ("th32DefaultHeapID", ctypes.c_void_p),
        ("th32ModuleID", ctypes.c_ulong),
        ("cntThreads", ctypes.c_ulong),
        ("th32ParentProcessID", ctypes.c_ulong),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", ctypes.c_ulong),
        ("szExeFile", ctypes.c_wchar * 260),
    ]


def _snapshot_processes() -> dict[int, tuple[int, str]]:
    """{pid: (父 pid, 小写镜像名)}。取不到就返回空字典，调用方按「无守卫」处理。"""
    if os.name != "nt":
        return {}
    snap: dict[int, tuple[int, str]] = {}
    try:
        k32 = ctypes.windll.kernel32
        k32.CreateToolhelp32Snapshot.restype = ctypes.c_void_p
        h = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
        if not h or h == ctypes.c_void_p(-1).value:
            return {}
        try:
            entry = _PROCESSENTRY32W()
            entry.dwSize = ctypes.sizeof(_PROCESSENTRY32W)
            ok = k32.Process32FirstW(ctypes.c_void_p(h), ctypes.byref(entry))
            while ok:
                snap[int(entry.th32ProcessID)] = (
                    int(entry.th32ParentProcessID),
                    (entry.szExeFile or "").lower(),
                )
                ok = k32.Process32NextW(ctypes.c_void_p(h), ctypes.byref(entry))
        finally:
            k32.CloseHandle(ctypes.c_void_p(h))
    except Exception:
        return {}
    return snap


def ancestor_chain(stop_names=None) -> list[tuple[int, str]]:
    """当前进程的祖先进程，由近及远，到桌面会话根为止（不含）。"""
    if os.name != "nt":
        return []
    stop = {n.lower() for n in (stop_names if stop_names is not None else ROOT_PROCESS_NAMES)}
    snap = _snapshot_processes()
    if not snap:
        return []
    me = os.getpid()
    out: list[tuple[int, str]] = []
    seen = {me}
    cur = snap.get(me, (0, ""))[0]
    while cur and cur not in seen and len(out) < MAX_WATCH:
        seen.add(cur)
        ppid, name = snap.get(cur, (0, ""))
        if not name:            # 已退出 / 查不到：链到此断开
            break
        if name in stop:        # 桌面会话根：不属于本次启动的生命周期
            break
        out.append((cur, name))
        cur = ppid
    return out


def _open_wait_handles(chain: list[tuple[int, str]]) -> list[tuple[int, int]]:
    """给每个祖先开一个「只等它退出」的句柄。开不到（权限不足/已退出）就跳过。"""
    k32 = ctypes.windll.kernel32
    k32.OpenProcess.restype = ctypes.c_void_p
    handles: list[tuple[int, int]] = []
    for pid, _name in chain:
        try:
            h = k32.OpenProcess(SYNCHRONIZE, False, pid)
        except Exception:
            h = None
        if h:
            handles.append((int(h), pid))
    return handles


def _watch_ancestors(handles: list[tuple[int, int]], names: dict[int, str]) -> None:
    """阻塞等待任意一个祖先退出，然后收尾退出本进程。"""
    k32 = ctypes.windll.kernel32
    try:
        arr = (ctypes.c_void_p * len(handles))(*[h for h, _ in handles])
        k32.WaitForMultipleObjects.restype = ctypes.c_ulong
        rc = int(k32.WaitForMultipleObjects(len(handles), arr, False, INFINITE))
    except Exception:
        return
    if rc == WAIT_FAILED:
        return
    idx = rc - WAIT_OBJECT_0
    gone_pid = handles[idx][1] if 0 <= idx < len(handles) else 0
    gone = names.get(gone_pid, str(gone_pid))
    try:
        print(f"[exit] 祖先进程 {gone}(pid={gone_pid}) 已退出，随之停止服务", flush=True)
    except Exception:
        pass
    if _WATCHDOG_HOOK is not None:
        try:
            _WATCHDOG_HOOK()        # 让 uvicorn 收尾（关监听、落盘）
        except Exception:
            pass
        time.sleep(WATCH_GRACE_S)   # 主线程正常退出会带走整个进程
    os._exit(0)                     # 兜底：宽限期过了还没走就硬退


def _watch_posix(ppid0: int) -> None:
    while True:
        time.sleep(0.5)
        if os.getppid() != ppid0:
            try:
                print("[exit] 父进程已退出，随之停止服务", flush=True)
            except Exception:
                pass
            os._exit(0)


def start_parent_watchdog(enabled: bool = True) -> int:
    """启动祖先进程存活守卫，返回被监视的进程数（0 表示未启用或没得监视）。

    用 daemon 线程，不参与解释器退出；不改变任何指标口径，只在「拉起者已消失」时退出。
    """
    if not enabled:
        return 0
    if os.name != "nt":
        ppid0 = os.getppid()
        if ppid0 and ppid0 != 1:
            threading.Thread(target=_watch_posix, args=(ppid0,), daemon=True).start()
            return 1
        return 0

    chain = ancestor_chain()
    handles = _open_wait_handles(chain)
    if not handles:
        return 0
    names = dict(chain)
    threading.Thread(target=_watch_ancestors, args=(handles, names), daemon=True).start()
    try:
        print("[init] 祖先进程守卫已启用: "
              + ", ".join(f"{n}({p})" for p, n in chain), flush=True)
    except Exception:
        pass
    return len(handles)


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


def _open_browser_when_ready(url: str, timeout: float = 25.0) -> None:
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
    parser.add_argument("--no-exit-with-parent", action="store_true",
                        help="不跟随拉起者退出（默认跟随：拉起进程消失时本服务自动停止）")
    args = parser.parse_args()

    _setup_console()
    # 尽早开句柄：晚一步父进程可能已经死掉，PID 还会被复用，守卫就失效了。
    start_parent_watchdog(not args.no_exit_with_parent)
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
        # 固定协议/事件循环，跳过 uvicorn 的 auto 探测与 websockets 初始化（约 -0.2~0.3s）。
        # 本项目没有 WebSocket 路由，也没有 lifespan 钩子（已核对 backend/app.py），
        # 因此 ws="none" / lifespan="off" 不会丢功能。
        http="h11",
        loop="asyncio",
        ws="none",
        lifespan="off",
        log_config=None,  # 沿用 backend 里已配置好的文件 + 控制台日志
        access_log=False,
        # 不回显 `server: uvicorn`：服务只监听回环，但版本号属于无谓的指纹信息。
        server_header=False,
        workers=1,
    )
    server = uvicorn.Server(config)
    # 守卫线程走优雅停机：置 should_exit 让 server.run() 返回，主线程退出即带走进程。
    global _WATCHDOG_HOOK
    _WATCHDOG_HOOK = lambda: setattr(server, "should_exit", True)  # noqa: E731
    try:
        server.run()
    except KeyboardInterrupt:
        print("\n[exit] 已停止", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
