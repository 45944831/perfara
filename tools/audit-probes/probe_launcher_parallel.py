import os, re, subprocess, sys, time
from pathlib import Path

REPO = Path(r"E:\WorkBuddy1\2026-10-19-13-59-27")
LOG = REPO / "perfara" / "logs" / "launcher.log"
PY = REPO / "tools" / ".venv" / "Scripts" / "python.exe"

start_lines = len(LOG.read_text(encoding="utf-8", errors="replace").splitlines()) if LOG.exists() else 0

t0 = time.time()
p = subprocess.Popen([str(PY), str(REPO / "tools" / "launcher_portable.py")],
                     cwd=str(REPO), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

marks = {}
deadline = t0 + 40
killed = False
while time.time() < deadline:
    try:
        lines = LOG.read_text(encoding="utf-8", errors="replace").splitlines()[start_lines:]
    except OSError:
        lines = []
    for ln in lines:
        if "启动采集客户端" in ln and "gui" not in marks:
            marks["gui"] = (time.time() - t0, ln)
        if "看板服务已就绪" in ln and "ready" not in marks:
            marks["ready"] = (time.time() - t0, ln)
    if "ready" in marks and "gui" in marks:
        break
    time.sleep(0.05)
time.sleep(1.0)

subprocess.run(["taskkill", "/F", "/T", "/IM", "Perfara.exe"], capture_output=True,
               stdin=subprocess.DEVNULL)
killed = True
try:
    p.wait(timeout=25)
except subprocess.TimeoutExpired:
    p.kill()

for k in ("gui", "ready"):
    if k in marks:
        print("%-6s +%.2fs  %s" % (k, marks[k][0], marks[k][1]))
    else:
        print("%-6s 未捕获" % k)
print("\n新日志：")
print("\n".join(LOG.read_text(encoding="utf-8", errors="replace").splitlines()[start_lines:]))
