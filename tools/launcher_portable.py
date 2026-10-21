#!/usr/bin/env python3
"""Perfara 便携版启动器：先起看板服务，再起采集客户端，客户端退出后**连根**收掉服务。

目录结构（便携包根目录）：
    Perfara.exe                      ← 本启动器
    collector\\Perfara.exe            ← 采集客户端（Electron）
    server\\PerfaraServer.exe         ← 看板服务（FastAPI，PyInstaller onefile）
    data\\webperf.db  logs\\          ← 数据与日志

生命周期（这是本文件存在的意义）：
    1. 启动时清理**本包目录**遗留的 PerfaraServer.exe（上次异常退出留下的孤儿），
       避免端口被占后一路顺延到 8001/8002/8003；
    2. 把服务进程放进 Windows Job Object（JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE），
       这样即使启动器被任务管理器强杀，服务进程树也会随之退出；
    3. 客户端退出后，先 taskkill /T /F 杀进程树，再关闭 Job 句柄兜底，
       并轮询确认端口已释放，才写「看板服务已停止」。
"""
from __future__ import annotations

import ctypes
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from ctypes import wintypes
from pathlib import Path

APP_NAME = "Perfara"
DEFAULT_PORT = 8000
PORT_SCAN = 20

k32 = ctypes.WinDLL("kernel32", use_last_error=True)

# ---------------------------------------------------------------- 基础工具


def base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[1] / "perfara"


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


def port_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, port))
            return True
        except OSError:
            return False


def pick_port(host: str, preferred: int) -> int:
    for p in range(preferred, preferred + PORT_SCAN):
        if port_free(host, p):
            return p
    return preferred


def wait_port_free(host: str, port: int, timeout: float = 8.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if port_free(host, port):
            return True
        time.sleep(0.15)
    return port_free(host, port)


# ------------------------------------------------- 进程枚举 / 结束进程树

TH32CS_SNAPPROCESS = 0x00000002
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
PROCESS_TERMINATE = 0x0001


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", wintypes.WCHAR * 260),
    ]


def _proc_image_path(pid: int) -> str:
    """取进程完整路径；拿不到（权限/已退出）返回空串。"""
    h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return ""
    try:
        size = wintypes.DWORD(1024)
        buf = ctypes.create_unicode_buffer(size.value)
        if k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return buf.value
        return ""
    finally:
        k32.CloseHandle(h)


def find_processes_by_exe(exe_path: Path) -> list[int]:
    """返回 image 路径等于 exe_path 的所有 pid（用于清理本包遗留进程）。"""
    target = str(exe_path).lower()
    pids: list[int] = []
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap in (None, ctypes.c_void_p(-1).value):
        return pids
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        ok = k32.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            if entry.szExeFile.lower() == exe_path.name.lower():
                path = _proc_image_path(entry.th32ProcessID)
                if path and path.lower() == target:
                    pids.append(int(entry.th32ProcessID))
            ok = k32.Process32NextW(snap, ctypes.byref(entry))
    finally:
        k32.CloseHandle(snap)
    return pids


def kill_tree(pid: int) -> None:
    """兜底用：taskkill /T 连同子进程一起杀（PyInstaller onefile 有 bootloader 父/子两层）。

    注意：无控制台的打包进程里 stdin 句柄可能无效，子进程会起不来，故显式给 DEVNULL。
    """
    if pid <= 0:
        return
    try:
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(pid)],
            capture_output=True,
            stdin=subprocess.DEVNULL,
            timeout=15,
        )
    except Exception:
        pass


def kill_server_processes(server_exe: Path, timeout: float = 5.0) -> bool:
    """把**本包目录**的 PerfaraServer.exe 全部 TerminateProcess 掉（父/子两层都覆盖）。

    不依赖 taskkill：打包成无控制台程序后，外部命令经常静默失败，
    这正是旧启动器「日志说已停止、进程其实还在」的根因。
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        pids = find_processes_by_exe(server_exe)
        if not pids:
            return True
        for pid in pids:
            h = k32.OpenProcess(PROCESS_TERMINATE, False, pid)
            if h:
                k32.TerminateProcess(h, 1)
                k32.CloseHandle(h)
        time.sleep(0.15)
    return not find_processes_by_exe(server_exe)


# --------------------------------------------------------- Job Object 兜底


JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
JobObjectExtendedLimitInformation = 9


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_ulonglong),
        ("WriteOperationCount", ctypes.c_ulonglong),
        ("OtherOperationCount", ctypes.c_ulonglong),
        ("ReadTransferCount", ctypes.c_ulonglong),
        ("WriteTransferCount", ctypes.c_ulonglong),
        ("OtherTransferCount", ctypes.c_ulonglong),
    ]


class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_longlong),
        ("PerJobUserTimeLimit", ctypes.c_longlong),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


def make_kill_on_close_job() -> int:
    """建一个「句柄关闭即杀光成员进程」的 Job；失败返回 0（走 taskkill 兜底）。"""
    try:
        job = k32.CreateJobObjectW(None, None)
        if not job:
            return 0
        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        ok = k32.SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            ctypes.byref(info),
            ctypes.sizeof(info),
        )
        if not ok:
            k32.CloseHandle(job)
            return 0
        return int(job)
    except Exception:
        return 0


def assign_to_job(job: int, proc: subprocess.Popen) -> bool:
    try:
        handle = wintypes.HANDLE(int(proc._handle))  # noqa: SLF001 - Windows 下取原生句柄
        return bool(k32.AssignProcessToJobObject(wintypes.HANDLE(job), handle))
    except Exception:
        return False


def close_job(job: int) -> None:
    if job:
        try:
            k32.CloseHandle(wintypes.HANDLE(job))
        except Exception:
            pass


# ---------------------------------------------------------------- 主流程


def health_ok(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1) as r:
            return r.status == 200
    except (urllib.error.URLError, OSError, ValueError):
        return False


def wait_health(port: int, timeout: float = 30.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if health_ok(port):
            return True
        time.sleep(0.3)
    return False


def write_client_config(base: Path, port: int, log_path: Path) -> None:
    cfg = base / "collector" / "resources" / "configout" / "config.js"
    body = (
        "// 由便携版启动器自动生成：指向本机看板服务\n"
        f'var upload={{"uploadurl":"http://127.0.0.1:{port}/api/upload"}};\n'
    )
    try:
        cfg.parent.mkdir(parents=True, exist_ok=True)
        cfg.write_text(body, encoding="utf-8")
        log(f"已写入采集端上传配置 → {cfg}", log_path)
    except Exception as e:
        log(f"[warn] 写上传配置失败：{e}", log_path)


def find_collector(base: Path) -> Path | None:
    for name in ("Perfara.exe", "Perfara离线版.exe"):
        p = base / "collector" / name
        if p.is_file():
            return p
    return None


def main() -> int:
    base = base_dir()
    log_path = base / "logs" / "launcher.log"
    log(f"启动 {APP_NAME} 便携版，目录 {base}", log_path)

    server_exe = base / "server" / "PerfaraServer.exe"
    collector_exe = find_collector(base)
    if not server_exe.is_file():
        fatal(f"缺少文件：\n{server_exe}\n\n请确认压缩包已完整解压。")
        log(f"缺少看板服务：{server_exe}", log_path)
        return 1
    if collector_exe is None:
        fatal(f"缺少文件：\n{base / 'collector' / 'Perfara.exe'}\n\n请确认压缩包已完整解压。")
        log("缺少采集客户端", log_path)
        return 1

    # 1) 清理本包遗留的服务进程（上次被强杀/崩溃留下的孤儿）
    stale = find_processes_by_exe(server_exe)
    if stale:
        log(f"清理遗留服务进程 {stale}", log_path)
        if not kill_server_processes(server_exe):
            log("[warn] 遗留服务进程未能清理，可能被其他用户或权限更高的进程占用", log_path)
        time.sleep(0.3)

    # 2) 选端口
    port = pick_port("127.0.0.1", DEFAULT_PORT)
    if port != DEFAULT_PORT:
        log(f"[warn] 端口 {DEFAULT_PORT} 被其他程序占用，改用 {port}", log_path)
    log(f"看板端口 {port}", log_path)

    job = make_kill_on_close_job()
    server = None
    try:
        server = subprocess.Popen(
            [
                str(server_exe),
                "--port", str(port),
                "--host", "127.0.0.1",
                "--no-browser",
                "--data-dir", str(base),
            ],
            cwd=str(base),
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
        )
        if job:
            assign_to_job(job, server)
        log(f"看板服务已启动 pid={server.pid}", log_path)

        if not wait_health(port):
            log("[error] 看板服务 30s 内未就绪，请查看 logs\\app.log", log_path)
            fatal("看板服务启动失败。\n请查看 logs\\launcher.log 与 logs\\app.log。")
            return 1

        write_client_config(base, port, log_path)

        # 3) 起采集客户端并等待退出
        #    清掉 ELECTRON_RUN_AS_NODE：若父进程（如某些 Node 工具）带着这个变量，
        #    Electron 会退化成纯 Node 进程、窗口一闪就退出，看起来像「点了没反应」。
        log("启动采集客户端 ...", log_path)
        child_env = os.environ.copy()
        for k in ("ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE"):
            child_env.pop(k, None)
        try:
            gui = subprocess.Popen(
                [str(collector_exe)], cwd=str(collector_exe.parent), env=child_env
            )
        except OSError as e:
            log(f"[error] 采集客户端启动失败：{e}", log_path)
            fatal(f"采集客户端启动失败：\n{e}\n\n可尝试右键以管理员身份运行，"
                  f"或直接双击 collector\\{collector_exe.name}。")
            return 1
        gui.wait()
        log(f"采集客户端已退出 code={gui.returncode}", log_path)
    finally:
        # 4) 收服务：直接杀本包的服务进程（父/子两层），再关 Job 兜底，最后确认端口释放
        if server is not None:
            if not kill_server_processes(server_exe):
                kill_tree(server.pid)
            try:
                server.wait(timeout=3)
            except Exception:
                pass
        close_job(job)
        # Job 关闭后，PyInstaller 的子进程可能还在退出中，轮询确认
        if not wait_port_free("127.0.0.1", port, timeout=3):
            leftover = find_processes_by_exe(server_exe)
            if leftover:
                log(f"[warn] 仍有残留 pid={leftover}，再次清理", log_path)
                kill_server_processes(server_exe)
            wait_port_free("127.0.0.1", port, timeout=3)
        log("看板服务已停止", log_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
