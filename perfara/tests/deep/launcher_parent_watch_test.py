"""祖先进程存活守卫（launcher.py）回归。

要防的形态（本机真实复现过）：
    启动器(PID A)  →  bootloader(PID B，仍活着)  →  python 子进程(PID C，uvicorn)
A 被强杀后，B 不知道也不在乎，C 照旧监听端口 —— 4 个残留 PerfaraServer.exe 就是这么来的。
所以守卫必须盯**整条祖先链**；只盯直接父进程（B）会完全失效。

本测试用三层替身进程精确复现：
    harness → L2(替身「启动器」，被杀) → L1(替身「bootloader」，存活) → L0(带守卫的叶子)

用法：tools/.venv/Scripts/python.exe perfara/tests/deep/launcher_parent_watch_test.py
"""
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

PERFARA = Path(__file__).resolve().parents[2]
LAUNCHER_DIR = PERFARA
PY = sys.executable

pass_n = 0
fail_n = 0
failed = []


def check(name, ok, detail=""):
    global pass_n, fail_n
    if ok:
        pass_n += 1
        print(f"  PASS  {name}")
    else:
        fail_n += 1
        failed.append(name)
        print(f"  FAIL  {name}  {detail}")


sys.path.insert(0, str(LAUNCHER_DIR))
import launcher as L  # noqa: E402


# 通用替身：depth>0 继续往下生，depth==0 装守卫后常驻。
# 每一层都把自身 pid 打到 stdout（stdout 沿链继承，harness 能一次读全）。
CHILD_SRC = r'''
import os, subprocess, sys, time
script, depth, perfara_dir, enable = (
    sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4])
print("SELF=%d" % os.getpid(), flush=True)
if depth == 0:
    sys.path.insert(0, perfara_dir)
    import launcher as _L
    print("WATCH=%d" % _L.start_parent_watchdog(enable == "1"), flush=True)
    print("LEAF_READY=%d" % os.getpid(), flush=True)
    while True:
        time.sleep(0.2)
else:
    p = subprocess.Popen([sys.executable, script, script, str(depth - 1), perfara_dir, enable])
    print("CHILD=%d" % p.pid, flush=True)
    while True:
        time.sleep(0.2)
'''


def _alive(pid):
    if not pid:
        return False
    try:
        out = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/NH", "/FO", "CSV"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15,
        ).stdout or ""
    except Exception:
        return False
    return f'"{pid}"' in out


def _kill(pid, tree=True):
    args = ["taskkill", "/F", "/PID", str(pid)]
    if tree:
        args.insert(2, "/T")
    subprocess.run(args, capture_output=True, stdin=subprocess.DEVNULL)


def run_case(enable: bool, wait_s: float):
    """起三层替身 → 杀掉最上层 → 返回 (叶子是否存活, 监视数, 全部 pid, 叶子 pid)。

    用读线程收行，主循环只看截止时间 —— 直接 readline() 会在下层没吐字时永久阻塞，
    测试会挂死而不是报失败。
    """
    src = PERFARA / "_watch_probe_child.py"
    src.write_text(CHILD_SRC, encoding="utf-8")
    pids = []
    leaf = None
    watch = None
    lines = []
    proc = subprocess.Popen(
        [PY, str(src), str(src), "2", str(LAUNCHER_DIR), "1" if enable else "0"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace",
    )

    def _pump():
        try:
            for raw in proc.stdout:
                lines.append(raw.strip())
        except Exception:
            pass

    threading.Thread(target=_pump, daemon=True).start()
    try:
        deadline = time.time() + 40
        idx = 0
        while time.time() < deadline and leaf is None:
            if idx < len(lines):
                line = lines[idx]
                idx += 1
                if line.startswith("SELF="):
                    pids.append(int(line.split("=", 1)[1]))
                elif line.startswith("WATCH="):
                    watch = int(line.split("=", 1)[1])
                elif line.startswith("LEAF_READY="):
                    leaf = int(line.split("=", 1)[1])
            else:
                time.sleep(0.05)
        # 第一层（替身「启动器」）= 本进程直接子进程，只杀它、不杀树
        _kill(proc.pid, tree=False)
        time.sleep(wait_s)
        alive = _alive(leaf)
        # 中间层（替身「bootloader」）= 叶子的直接父进程，必须仍然活着 ——
        # 否则这次根本没测到「父在、祖父亡」这个关键形态。
        boot = pids[1] if len(pids) > 1 else None
        return alive, watch, pids, leaf, _alive(boot)
    finally:
        for pid in reversed(pids):
            _kill(pid)
        _kill(proc.pid)
        try:
            src.unlink()
        except OSError:
            pass


print("\n===== 祖先进程存活守卫 =====")

print("\n-- 1. 祖先链解析 --")
chain = L.ancestor_chain()
check("祖先链非空（本进程有父进程）", len(chain) > 0, chain)
check("祖先链不含自身", os.getpid() not in [p for p, _ in chain], chain)
check("祖先链不含桌面会话根（explorer/services 等）",
      all(n not in L.ROOT_PROCESS_NAMES for _, n in chain), chain)
snap = L._snapshot_processes()
check("进程快照可用且包含自身", bool(snap) and os.getpid() in snap, len(snap))
if chain:
    pid0 = chain[0][0]
    check("链首就是直接父进程", snap.get(os.getpid(), (0, ""))[0] == pid0,
          {"parent": snap.get(os.getpid(), (0, ""))[0], "chain0": pid0})

print("\n-- 2. 开关 --")
check("显式关闭时返回 0（不起线程）", L.start_parent_watchdog(False) == 0)

print("\n-- 3. 真实三层：杀掉「启动器」层，带守卫的叶子应自行退出 --")
alive, watch, pids, leaf, boot_alive = run_case(enable=True, wait_s=9.0)
check("叶子进程装上了守卫", bool(watch) and watch > 0, watch)
check("三层进程都起来了（启动器 / bootloader / 叶子）", len(pids) >= 3, pids)
check("中间的「bootloader」层仍然活着（形态与真实残留一致）", boot_alive is True,
      {"pids": pids, "boot_alive": boot_alive})
check("启动器消失后，叶子进程已退出（不再残留）", alive is False,
      {"leaf": leaf, "still_alive": alive})

print("\n-- 4. 反例：同样条件下关掉守卫，叶子必须残留（证明修复非空转）--")
alive2, watch2, pids2, leaf2, boot_alive2 = run_case(enable=False, wait_s=5.0)
check("关闭守卫时未启用监视", watch2 == 0, watch2)
check("关闭守卫后叶子确实残留（反例成立）", alive2 is True,
      {"leaf": leaf2, "alive": alive2})

print("\n" + "-" * 42)
print(f"  {pass_n} PASS / {fail_n} FAIL")
if failed:
    print("  失败项:\n   - " + "\n   - ".join(failed))
print("-" * 42 + "\n")
sys.exit(1 if fail_n else 0)
