"""便携版启动器（tools/launcher_portable.py）端口与进程回收回归。

覆盖 README 里 v2026.10.20.1「关闭程序后进程残留 / 端口漂移」修复的三条承诺：
  1. port_free / pick_port 在端口被占时顺延，且顺延有界
  2. wait_port_free 在监听者退出后返回、仍被占超时则报 False（不再无限等）
  3. Job Object（kill-on-close）：启动器被强杀，服务子进程必须一起消失
  另外验证 find_processes_by_exe 只命中本包进程、health_ok 不会被非 HTTP 监听者挂死。

用法：tools/.venv/Scripts/python.exe perfara/tests/deep/launcher_port_test.py
"""
import ctypes
import os
import socket
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent.parent
sys.path.insert(0, str(REPO / "tools"))

import launcher_portable as L  # noqa: E402

results = []


def check(name, ok, detail=""):
    detail = "" if detail == "" else str(detail)
    results.append((name, bool(ok), detail))
    print(("  PASS  " if ok else "  FAIL  ") + name + (("  | " + detail) if detail else ""))


def bind_bg():
    """在后台线程占住一个端口（不回写 HTTP，纯 listen）。返回 (sock, port, stop)。"""
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    s.listen(5)
    port = s.getsockname()[1]
    stop = threading.Event()

    def loop():
        s.settimeout(0.3)
        while not stop.is_set():
            try:
                c, _ = s.accept()
                c.close()
            except socket.timeout:
                continue
            except OSError:
                break
    t = threading.Thread(target=loop, daemon=True)
    t.start()
    return s, port, (stop, t)


def main():
    print("== 便携版启动器：端口选择与进程回收 ==")
    host = "127.0.0.1"

    # ---- 1. port_free ----
    free_s = socket.socket()
    free_s.bind((host, 0))
    free_port = free_s.getsockname()[1]
    free_s.close()
    check("port_free 判定空闲端口为空闲", L.port_free(host, free_port), free_port)

    sock, busy_port, (stop, _t) = bind_bg()
    check("port_free 判定被占端口为非空闲", not L.port_free(host, busy_port), busy_port)

    # ---- 2. pick_port ----
    picked = L.pick_port(host, free_port)
    check("pick_port 空闲时原样返回首选端口", picked == free_port, f"{picked} vs {free_port}")
    moved = L.pick_port(host, busy_port)
    check("pick_port 被占时向后顺延", moved != busy_port and L.port_free(host, moved),
          f"{busy_port} -> {moved}")

    # ---- 3. wait_port_free ----
    t0 = time.time()
    ok_before = L.wait_port_free(host, busy_port, timeout=1.0)
    dt = time.time() - t0
    check("wait_port_free 端口仍被占时按时返回 False", ok_before is False and dt < 3.0,
          f"{ok_before} {dt:.2f}s")
    stop.set()
    sock.close()
    t0 = time.time()
    ok_after = L.wait_port_free(host, busy_port, timeout=5.0)
    check("wait_port_free 监听者退出后返回 True", ok_after is True,
          f"{ok_after} {time.time() - t0:.2f}s")

    # ---- 4. health_ok 不被非 HTTP 监听者挂死 ----
    s2, p2, (stop2, _t2) = bind_bg()
    t0 = time.time()
    h = L.health_ok(p2)
    el = time.time() - t0
    check("health_ok 对无 HTTP 响应的端口返回 False 且不卡住", h is False and el < 8.0,
          f"{h} {el:.2f}s")
    stop2.set()
    s2.close()

    # 真 HTTP 服务应返回 True
    # 真 HTTP 服务应返回 True（health_ok 探的是 /api/health）
    probe = socket.socket()
    probe.bind((host, 0))
    hp = probe.getsockname()[1]
    probe.close()
    holder_dir = Path(tempfile.mkdtemp(prefix="lph_"))
    srv_py = holder_dir / "srv.py"
    srv_py.write_text(
        "import http.server\n"
        "class H(http.server.BaseHTTPRequestHandler):\n"
        "    def do_GET(self):\n"
        "        self.send_response(200); self.end_headers(); self.wfile.write(b'ok')\n"
        "    def log_message(self, *a): pass\n"
        f"http.server.HTTPServer(('127.0.0.1', {hp}), H).serve_forever()\n",
        encoding="utf-8")
    hsrv = subprocess.Popen([sys.executable, str(srv_py)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)
    check("health_ok 对真实 /api/health 服务返回 True", L.health_ok(hp) is True, hp)
    hsrv.kill()
    hsrv.wait(timeout=5)
    shutil.rmtree(holder_dir, ignore_errors=True)

    # ---- 5. find_processes_by_exe 精确性 ----
    #   注意 venv 的 sys.executable 是重定向器，真实 image 路径是底座解释器；
    #   函数按 QueryFullProcessImageNameW 比对，所以断言要用 image 路径。
    image = Path(L._proc_image_path(os.getpid()))
    pids = L.find_processes_by_exe(image)
    check("find_processes_by_exe 命中自身进程", os.getpid() in pids,
          f"self={os.getpid()} image={image} hits={len(pids)}")
    other = L.find_processes_by_exe(image.parent / "definitely_not_here.exe")
    check("find_processes_by_exe 不误命中不存在的 exe", other == [], other)

    # ---- 6. Job Object：父进程被强杀，子进程连带退出 ----
    if sys.platform != "win32":
        print("  SKIP  非 Windows，Job Object 用例跳过")
    else:
        job = L.make_kill_on_close_job()
        child = subprocess.Popen([sys.executable, "-c",
                                  "import time\nwhile True: time.sleep(0.2)"],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        assigned = L.assign_to_job(job, child)
        check("assign_to_job 成功", assigned is True, f"job={job} pid={child.pid}")
        cpid = child.pid
        L.kill_tree(child.pid)
        time.sleep(0.6)
        alive = child.poll() is None
        check("kill_tree 后子进程已退出", not alive, f"pid={cpid} poll={child.poll()}")
        L.close_job(job)

        job_dir = Path(tempfile.mkdtemp(prefix="lpj_"))
        gc_py = job_dir / "gc.py"
        gc_py.write_text("import time\nwhile True:\n    time.sleep(0.2)\n", encoding="utf-8")
        holder_py = job_dir / "holder.py"
        holder_py.write_text(
            "import subprocess, sys, time\n"
            f"sys.path.insert(0, r'{REPO / 'tools'}')\n"
            "import launcher_portable as L\n"
            "job = L.make_kill_on_close_job()\n"
            "p = subprocess.Popen([sys.executable, sys.argv[1]],\n"
            "                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n"
            "assert L.assign_to_job(job, p), 'assign failed'\n"
            "print(p.pid, flush=True)\n"
            "time.sleep(60)\n",
            encoding="utf-8")
        holder = subprocess.Popen([sys.executable, str(holder_py), str(gc_py)],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        line = (holder.stdout.readline() or "").strip()
        gpid = int(line) if line.isdigit() else None
        time.sleep(0.6)
        if gpid is None:
            check("Job 内孙进程初始存活", False,
                  f"holder 未打印 pid: {line!r} {holder.stderr.read()[:200]!r}")
            holder.kill()
        else:
            tl = subprocess.run(["tasklist", "/FI", f"PID eq {gpid}", "/NH"],
                                capture_output=True, text=True).stdout
            check("Job 内孙进程初始存活", "python" in tl.lower(), f"grandchild={gpid}")
            holder.kill()          # 模拟「启动器被强杀」
            holder.wait(timeout=10)
            deadline = time.time() + 6.0
            gone = False
            while time.time() < deadline:
                tl2 = subprocess.run(["tasklist", "/FI", f"PID eq {gpid}", "/NH"],
                                     capture_output=True, text=True).stdout
                if "python" not in tl2.lower():
                    gone = True
                    break
                time.sleep(0.4)
            check("强杀启动器后 Job 内服务进程被内核回收", gone,
                  f"pid={gpid} 仍存活: {tl2.strip()[:80]}")
        try:
            shutil.rmtree(job_dir, ignore_errors=True)
        except Exception:
            pass

    p = sum(1 for _, ok, _ in results if ok)
    f = len(results) - p
    print(f"\n===== {p} PASS / {f} FAIL =====")
    for name, ok, d in results:
        if not ok:
            print(f"  FAIL: {name}  {d}")
    return 0 if f == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
