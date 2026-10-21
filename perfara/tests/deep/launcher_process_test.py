#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""便携版启动器（tools/launcher_portable.py）行为测试。

用真实进程 / 真实端口验证：
  L01-L08  端口管理：port_free / pick_port / wait_port_free
  L09-L16  进程管理：find_processes_by_exe / kill_server_processes / kill_tree
  L17-L20  Job Object：make_kill_on_close_job / assign_to_job / close_job（句柄关闭即杀）
  L21-L24  配置与采集端发现：write_client_config / find_collector
  L25-L28  健康检查：health_ok / wait_health

⚠️ 所有"服务进程"都用**临时目录里的同名假 exe**（python.exe 副本），
   按完整路径匹配，不会碰到真实 PerfaraServer.exe。
"""
from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str((ROOT / "tools").resolve()))

import launcher_portable as LP  # noqa: E402

PASS = 0
FAIL = 0
FAILED: list[str] = []


def check(name: str, cond, detail="") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        FAILED.append(name)
        print(f"  FAIL  {name}  {detail}")


def wait_port(port: int, timeout: float = 8.0) -> bool:
    """等待端口可连接。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
            return True
        except OSError:
            time.sleep(0.15)
    return False


def main() -> int:
    print("== Perfara 启动器行为测试 ==")

    tmp = Path(tempfile.mkdtemp(prefix="perfara-launcher-test-"))
    try:
        # ─────────── 端口管理 ───────────
        print("[端口管理]")
        # 找一个空闲端口做基准
        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        free_port = probe.getsockname()[1]
        probe.close()

        check("L01 port_free 对空闲端口返回 True", LP.port_free("127.0.0.1", free_port) is True)

        # 占住一个端口
        holder = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        holder.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        holder.bind(("127.0.0.1", 0))
        holder.listen(1)
        busy = holder.getsockname()[1]
        check("L02 port_free 对已占用端口返回 False", LP.port_free("127.0.0.1", busy) is False,
              f"port={busy}")

        # pick_port 应从首选端口顺延
        picked = LP.pick_port("127.0.0.1", busy)
        check("L03 pick_port 首选被占时顺延", picked > busy, f"busy={busy} picked={picked}")
        check("L04 pick_port 顺延后的端口确实空闲", LP.port_free("127.0.0.1", picked) is True)
        holder.close()

        # wait_port_free：端口释放后应返回 True
        h2 = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        h2.bind(("127.0.0.1", 0))
        h2.listen(1)
        p2 = h2.getsockname()[1]
        h2.close()
        check("L05 wait_port_free 端口已空闲时立即返回 True", LP.wait_port_free("127.0.0.1", p2, 2) is True)

        # wait_port_free：端口一直被占应在超时后返回 False
        h3 = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        h3.bind(("127.0.0.1", 0))
        h3.listen(1)
        p3 = h3.getsockname()[1]
        t0 = time.time()
        r3 = LP.wait_port_free("127.0.0.1", p3, 1.0)
        el = time.time() - t0
        check("L06 wait_port_free 端口被占超时返回 False", r3 is False)
        check("L07 wait_port_free 超时时长符合预期", 0.9 <= el <= 2.5, f"{el:.2f}s")
        h3.close()

        # pick_port 全被占时返回首选（允许失败由上层处理）
        s1 = socket.socket(socket.AF_INET, socket.SOCK_STREAM); s1.bind(("127.0.0.1", 0)); s1.listen(1)
        p_all = s1.getsockname()[1]
        keep = [s1]
        for _ in range(3):
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.bind(("127.0.0.1", p_all + 1 + _)); s.listen(1); keep.append(s)
        # PORT_SCAN=20，这里只占前几个，所以 pick_port 应能找到更后面的
        found = LP.pick_port("127.0.0.1", p_all)
        check("L08 pick_port 部分占用时跳过被占端口", found > p_all, f"p_all={p_all} found={found}")
        for s in keep:
            s.close()

        # ─────────── 进程管理 ───────────
        print("[进程管理]")
        # 造一个"本包目录"的假 PerfaraServer.exe。
        # ⚠️ 必须用**系统 python**（D:\python\python.exe）而不是 venv 的解释器：
        #    venv 的 python.exe 复制出去后找不到 pyvenv.cfg，会以退出码 106 直接死掉。
        pkg = tmp / "pkg"
        (pkg / "server").mkdir(parents=True, exist_ok=True)
        (pkg / "collector").mkdir(parents=True, exist_ok=True)
        fake_server = pkg / "server" / "PerfaraServer.exe"
        py = Path(r"D:\python\python.exe")
        if not py.is_file():
            py = Path(sys.executable)
        shutil.copy2(py, fake_server)

        check("L09 假服务 exe 已就位", fake_server.is_file())

        # 未启动时 find 应为空
        check("L10 未启动时 find_processes_by_exe 为空",
              LP.find_processes_by_exe(fake_server) == [],
              str(LP.find_processes_by_exe(fake_server)))

        # 起一个长驻进程（同名 exe，完整路径匹配）
        proc = subprocess.Popen(
            [str(fake_server), "-c", "import time; time.sleep(120)"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        time.sleep(1.5)
        found = LP.find_processes_by_exe(fake_server)
        check("L11 启动后 find_processes_by_exe 能找到该 pid",
              proc.pid in found, f"pid={proc.pid} found={found}")

        # 同名不同路径的进程不应被匹配（防止误杀别的程序）
        other_dir = tmp / "other"
        other_dir.mkdir(parents=True, exist_ok=True)
        other_exe = other_dir / "PerfaraServer.exe"
        shutil.copy2(py, other_exe)
        proc2 = subprocess.Popen(
            [str(other_exe), "-c", "import time; time.sleep(120)"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        time.sleep(1.5)
        found2 = LP.find_processes_by_exe(fake_server)
        check("L12 find_processes_by_exe 按完整路径匹配，不误杀同名不同路径进程",
              proc.pid in found2 and proc2.pid not in found2,
              f"found={found2} other_pid={proc2.pid}")

        # kill_server_processes 应清掉本包的、且留下别的
        ok = LP.kill_server_processes(fake_server, timeout=6.0)
        check("L13 kill_server_processes 返回 True", ok is True)
        time.sleep(1.0)
        after = LP.find_processes_by_exe(fake_server)
        check("L14 kill_server_processes 后本包进程已消失", after == [], str(after))
        alive_other = LP.find_processes_by_exe(other_exe)
        check("L15 kill_server_processes 不影响其他目录同名进程", proc2.pid in alive_other,
              str(alive_other))

        # kill_tree 应能连根杀掉（含子进程）
        tree_holder = pkg / "server" / "TreeTest.exe"
        shutil.copy2(py, tree_holder)
        tree = subprocess.Popen(
            [str(tree_holder), "-c",
             "import subprocess,sys,time;"
             "c=subprocess.Popen([sys.executable,'-c','import time;time.sleep(300)']);"
             "time.sleep(300)"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        time.sleep(2.0)
        LP.kill_tree(tree.pid)
        time.sleep(1.5)
        gone = tree.poll() is not None
        check("L16 kill_tree 杀掉父进程", gone, f"poll={tree.poll()}")

        # ─────────── Job Object ───────────
        print("[Job Object]")
        job = LP.make_kill_on_close_job()
        check("L17 make_kill_on_close_job 返回有效句柄", isinstance(job, int) and job > 0, str(job))

        job_exe = pkg / "server" / "JobTest.exe"
        shutil.copy2(py, job_exe)
        jp = subprocess.Popen(
            [str(job_exe), "-c", "import time; time.sleep(300)"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        time.sleep(1.2)
        assigned = LP.assign_to_job(job, jp)
        check("L18 assign_to_job 成功", assigned is True)
        check("L19 Job 内进程存活", jp.poll() is None, str(jp.poll()))

        LP.close_job(job)
        deadline = time.time() + 6
        while time.time() < deadline and jp.poll() is None:
            time.sleep(0.2)
        check("L20 关闭 Job 句柄后进程随之退出（KILL_ON_JOB_CLOSE 生效）", jp.poll() is not None,
              str(jp.poll()))

        # ─────────── 配置写入 / 采集端发现 ───────────
        print("[配置与采集端发现]")
        cfg = pkg / "collector" / "resources" / "configout" / "config.js"
        LP.write_client_config(pkg, 8123, tmp / "launcher.log")
        check("L21 write_client_config 生成 config.js", cfg.is_file(), str(cfg))
        if cfg.is_file():
            text = cfg.read_text(encoding="utf-8")
            check("L22 config.js 内容含上传地址与端口",
                  "http://127.0.0.1:8123/api/upload" in text, text[:120])
            # 文件首行是注释，var 声明在第二行 —— 断言要按"去掉注释后"判断
            code_lines = [l for l in text.splitlines() if not l.strip().startswith("//")]
            check("L23 config.js 是合法 JS 变量声明",
                  any(l.strip().startswith("var upload=") for l in code_lines), text[:80])

        # find_collector：两个候选名
        check("L24 find_collector 目录为空时返回 None", LP.find_collector(tmp / "empty") is None)
        (pkg / "collector" / "Perfara.exe").write_bytes(b"x")
        found_c = LP.find_collector(pkg)
        check("L25 find_collector 找到 Perfara.exe",
              found_c is not None and found_c.name == "Perfara.exe", str(found_c))
        (pkg / "collector" / "Perfara离线版.exe").write_bytes(b"x")
        check("L26 find_collector 优先返回 Perfara.exe",
              LP.find_collector(pkg).name == "Perfara.exe")
        (pkg / "collector" / "Perfara.exe").unlink()
        check("L27 find_collector 回退到 Perfara离线版.exe",
              LP.find_collector(pkg).name == "Perfara离线版.exe")

        # ─────────── 健康检查 ───────────
        print("[健康检查]")
        # 起一个真的 HTTP 服务返回 {"status":"ok"}。
        # ⚠️ 用独立脚本文件而不是 python -c 拼 class：-c 里塞 \n 定义的类缩进不可靠。
        srv_script = tmp / "health_srv.py"
        srv_script.write_text(
            "import http.server, json, sys\n"
            "port = int(sys.argv[1])\n"
            "class H(http.server.BaseHTTPRequestHandler):\n"
            "    def do_GET(self):\n"
            "        self.send_response(200)\n"
            "        self.send_header('Content-Type', 'application/json')\n"
            "        self.end_headers()\n"
            "        self.wfile.write(json.dumps({'status': 'ok'}).encode())\n"
            "    def log_message(self, *a):\n"
            "        pass\n"
            "http.server.HTTPServer(('127.0.0.1', port), H).serve_forever()\n",
            encoding="utf-8",
        )
        probe2 = socket.socket(); probe2.bind(("127.0.0.1", 0)); hport = probe2.getsockname()[1]; probe2.close()
        srv = subprocess.Popen(
            [str(py), str(srv_script), str(hport)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            if wait_port(hport, 8):
                check("L28 health_ok 对返回 status=ok 的服务为 True", LP.health_ok(hport) is True)
                check("L29 wait_health 快速就绪", LP.wait_health(hport, 8) is True)
            else:
                check("L28 health_ok 对返回 status=ok 的服务为 True", False, "服务未就绪")
                check("L29 wait_health 快速就绪", False, "服务未就绪")
        finally:
            srv.kill(); srv.wait()

        # 无服务端口
        probe3 = socket.socket(); probe3.bind(("127.0.0.1", 0)); dead = probe3.getsockname()[1]; probe3.close()
        check("L30 health_ok 对无服务端口为 False", LP.health_ok(dead) is False)

        # ─────────── 清理测试进程 ───────────
        for p in (proc2, tree, jp):
            try:
                p.kill(); p.wait(timeout=3)
            except Exception:
                pass

    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print(f"\n==== 启动器测试结果: {PASS} PASS / {FAIL} FAIL ====")
    if FAILED:
        print("FAILED: " + ", ".join(FAILED))
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
