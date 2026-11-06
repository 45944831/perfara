"""打包态并联启动冒烟：起 perfara\\Perfara.exe，量两个时间点，再模拟关掉采集窗口看收尾。"""
import importlib.util
import socket
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(r"E:\WorkBuddy1\2026-10-19-13-59-27")
PKG = REPO / "perfara"
LOG = PKG / "logs" / "launcher.log"

spec = importlib.util.spec_from_file_location("lp", REPO / "tools" / "launcher_portable.py")
lp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lp)

start_lines = len(LOG.read_text(encoding="utf-8", errors="replace").splitlines()) if LOG.exists() else 0

t0 = time.time()
p = subprocess.Popen([str(PKG / "Perfara.exe")], cwd=str(PKG),
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

marks = {}
deadline = t0 + 45
collector_pids = []
while time.time() < deadline:
    try:
        lines = LOG.read_text(encoding="utf-8", errors="replace").splitlines()[start_lines:]
    except OSError:
        lines = []
    for ln in lines:
        if "启动采集客户端" in ln and "gui" not in marks:
            marks["gui"] = time.time() - t0
        if "看板服务已就绪" in ln and "ready" not in marks:
            marks["ready"] = time.time() - t0
    collector_pids = lp.find_processes_by_exe(PKG / "collector" / "Perfara.exe")
    if "ready" in marks and collector_pids:
        break
    time.sleep(0.05)

print("采集进程 pid=%s  窗口拉起 +%.2fs  服务就绪 +%.2fs"
      % (collector_pids, marks.get("gui", -1), marks.get("ready", -1)))

# 模拟用户关掉采集窗口（只杀 collector，不动启动器）
for pid in collector_pids:
    lp.kill_tree(pid)

exit_code = None
try:
    exit_code = p.wait(timeout=30)
except subprocess.TimeoutExpired:
    p.kill()
print("启动器退出 code=%s（耗时 %.1fs）" % (exit_code, time.time() - t0))

time.sleep(0.5)
left_server = lp.find_processes_by_exe(PKG / "server" / "PerfaraServer.exe")
left_collector = lp.find_processes_by_exe(PKG / "collector" / "Perfara.exe")
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
    try:
        s.bind(("127.0.0.1", 8000))
        port_state = "free"
    except OSError:
        port_state = "BUSY"
run_left = [str(x) for x in (PKG / ".run").iterdir()] if (PKG / ".run").is_dir() else []
print("残留服务=%s 残留采集=%s 端口8000=%s .run=%s" % (left_server, left_collector, port_state, run_left))
print("\n新日志：")
print("\n".join(LOG.read_text(encoding="utf-8", errors="replace").splitlines()[start_lines:]))
