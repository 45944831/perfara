# -*- coding: utf-8 -*-
"""
PC 进程性能采样：按行输出 JSON（与 Android 采集数据结构对齐），供 Electron 解析。
依赖：psutil（pip install psutil）
FPS：可选 Intel PresentMon（ETW），将 PresentMon-x64.exe / PresentMon.exe 放在本脚本同目录，
     或设置环境变量 PRESENTMON_PATH；否则 FPS 为 0。
用法: python collect_pc_perf.py <exe完整路径>
     <exe完整路径> 为单个命令行参数，含空格时由 shell/父进程传入一个 argv（勿拆成多段）。
"""
from __future__ import annotations

import atexit
import csv
import json
import os
import subprocess
import sys
import threading
import time
from collections import deque

INTERVAL_SEC = 1.0

# PresentMon 输出的 CSV 行计数（最近 1 秒窗口）≈ FPS
_FPS_LOCK = threading.Lock()
_FPS_STATE = {"v": 0.0, "src": "none"}  # src: none | presentmon
# 帧延迟分解（PresentMon v1 列集现成，1s 滑动均值，ms）：
#   displayChange  = MsBetweenDisplayChange  上屏节奏（上一帧被显示到本帧被显示）
#   untilDisplayed = MsUntilDisplayed        Present→上屏（P2D 延迟）
#   inPresentApi   = MsInPresentAPI          Present() 调用耗时
#   renderLatency  = MsRenderPresentLatency  Present→GPU 完成该帧
#   appStartGap    = MsBetweenAppStart       帧起点间距（模拟+等待）
# 取不到该列时值为 None = 未测量，绝不写 0 冒充。
_FRAME_KEYS = ("displayChange", "untilDisplayed", "inPresentApi", "renderLatency", "appStartGap")
_FRAME_COLS = {
    "msbetweendisplaychange": "displayChange",
    "msuntildisplayed": "untilDisplayed",
    "msinpresentapi": "inPresentApi",
    "msrenderpresentlatency": "renderLatency",
    "msbetweenappstart": "appStartGap",
}
_FPS_STATE["frame"] = {k: None for k in _FRAME_KEYS}
_FPS_PM_PROC = None


def _win_hide_kw():
    if sys.platform != "win32":
        return {}
    # subprocess 在 Windows 下隐藏控制台窗口
    try:
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    except Exception:
        return {}


def _norm_exe_path(p: str) -> str:
    if not p:
        return ""
    try:
        s = os.path.abspath(p.strip().strip('"'))
        return os.path.normcase(os.path.normpath(s))
    except Exception:
        return os.path.normcase(p.strip())


def _pick_pid_max_rss(psutil, pids: list) -> int:
    """同一路径多实例时取 RSS 最大者（主进程/播放器通常远大于 helper）。"""
    best_pid = pids[0]
    best_rss = -1
    for pid in pids:
        try:
            rss = psutil.Process(pid).memory_info().rss
            if rss > best_rss:
                best_rss = rss
                best_pid = pid
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return best_pid


def find_pid_by_exe(target_path: str):
    target = _norm_exe_path(target_path)
    try:
        import psutil
    except ImportError:
        print(
            json.dumps(
                {
                    "error": "no_psutil",
                    "message": "请安装: pip install psutil",
                }
            ),
            flush=True,
        )
        sys.exit(2)
    matches = []
    for proc in psutil.process_iter(["pid", "exe", "name"]):
        try:
            exe = proc.info.get("exe")
            if not exe:
                try:
                    exe = proc.exe()
                except (psutil.AccessDenied, psutil.NoSuchProcess):
                    continue
            if not exe:
                continue
            if _norm_exe_path(exe) == target:
                matches.append(proc.info["pid"])
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    if not matches:
        return None
    if len(matches) == 1:
        return matches[0]
    chosen = _pick_pid_max_rss(psutil, matches)
    sys.stderr.write(
        "[collect_pc_perf] 同 exe 多进程 %s，选用 RSS 最大 PID=%s\n"
        % (matches, chosen)
    )
    sys.stderr.flush()
    return chosen


def find_presentmon_executable():
    env = os.environ.get("PRESENTMON_PATH", "").strip().strip('"')
    if env and os.path.isfile(env):
        return env
    here = os.path.dirname(os.path.abspath(__file__))
    for name in (
        "PresentMon.exe",
        "PresentMon-x64.exe",
        "PresentMon-64.exe",
    ):
        p = os.path.join(here, name)
        if os.path.isfile(p):
            return p
    try:
        import shutil

        return shutil.which("PresentMon.exe") or shutil.which("PresentMon-x64.exe")
    except Exception:
        return None


def _presentmon_stderr_reader(proc: subprocess.Popen) -> None:
    try:
        err = proc.stderr
        if not err:
            return
        for line in err:
            if line and str(line).strip():
                sys.stderr.write("[PresentMon] " + str(line))
                sys.stderr.flush()
    except Exception:
        pass


def _split_csv_row(line: str):
    line = line.strip()
    if not line:
        return []
    try:
        return next(csv.reader([line]))
    except Exception:
        return []


def _presentmon_worker(pid: int) -> None:
    global _FPS_PM_PROC
    exe = find_presentmon_executable()
    if not exe:
        sys.stderr.write(
            "[collect_pc_perf] 未找到 PresentMon：请将 PresentMon-x64.exe 放到 Scripts 目录或设置 PRESENTMON_PATH，否则 FPS 为 0\n"
        )
        sys.stderr.flush()
        return
    # --v1_metrics：列名稳定；勿对 PresentMon 使用 CREATE_NO_WINDOW（可能影响 ETW/会话）
    args = [
        exe,
        "--process_id",
        str(pid),
        "--output_stdout",
        "--stop_existing_session",
        "--no_console_stats",
        "--v1_metrics",
    ]
    try:
        proc = subprocess.Popen(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
    except Exception as e:
        sys.stderr.write("[collect_pc_perf] PresentMon 启动失败: %s\n" % e)
        sys.stderr.flush()
        return
    _FPS_PM_PROC = proc
    threading.Thread(target=_presentmon_stderr_reader, args=(proc,), daemon=True).start()
    recent = deque()  # type: ignore[var-annotated]
    inst_fps = deque(maxlen=90)  # 由 MsBetweenPresents 推算的瞬时 FPS 滑动平均
    frame_bufs = {k: deque(maxlen=90) for k in _FRAME_KEYS}  # 帧延迟分解各列的滑动窗口
    now_wall = time.time
    col_ms = None
    col_dfps = None
    col_frame = {}  # 列名小写 -> frame key
    header_seen = False
    try:
        for raw_line in proc.stdout:
            if not raw_line:
                continue
            parts = _split_csv_row(raw_line)
            if not parts:
                continue
            if parts[0].startswith("\ufeff"):
                parts[0] = parts[0].lstrip("\ufeff")
            if not header_seen:
                low = [p.strip().lower() for p in parts]
                if "msbetweenpresents" in low:
                    col_ms = low.index("msbetweenpresents")
                if "displayedfps" in low:
                    col_dfps = low.index("displayedfps")
                for cname, fkey in _FRAME_COLS.items():
                    if cname in low:
                        col_frame[low.index(cname)] = fkey
                if "msbetweenpresents" in low or "processid" in low:
                    header_seen = True
                continue
            t = now_wall()
            recent.append(t)
            while recent and t - recent[0] > 1.0:
                recent.popleft()
            # 帧延迟分解：只收数值合法的行，1s 窗口均值（get_fps_for_sample 里取）
            for idx, fkey in col_frame.items():
                if len(parts) <= idx:
                    continue
                try:
                    v = float(parts[idx].strip())
                except ValueError:
                    continue
                if v > 0:
                    frame_bufs[fkey].append(v)
            count_fps = float(len(recent))
            ms_fps = 0.0
            if col_ms is not None and len(parts) > col_ms:
                try:
                    ms = float(parts[col_ms].strip())
                    if ms > 0:
                        ms_fps = min(1000.0 / ms, 1000.0)
                        inst_fps.append(ms_fps)
                except ValueError:
                    pass
            if col_dfps is not None and len(parts) > col_dfps:
                try:
                    v = float(parts[col_dfps].strip())
                    if v > 0:
                        inst_fps.append(min(v, 1000.0))
                except ValueError:
                    pass
            roll = sum(inst_fps) / len(inst_fps) if inst_fps else 0.0
            merged = max(count_fps, roll)
            with _FPS_LOCK:
                _FPS_STATE["v"] = merged
                _FPS_STATE["src"] = "presentmon"
                _FPS_STATE["frame"] = {
                    k: (round(sum(b) / len(b), 2) if b else None) for k, b in frame_bufs.items()
                }
    except Exception as e:
        sys.stderr.write("[collect_pc_perf] PresentMon 读输出结束: %s\n" % e)
        sys.stderr.flush()
    finally:
        try:
            proc.terminate()
        except Exception:
            pass
        _FPS_PM_PROC = None


def get_fps_for_sample():
    with _FPS_LOCK:
        frame = dict(_FPS_STATE.get("frame") or {})
        return round(_FPS_STATE["v"], 1), _FPS_STATE["src"], frame


def stop_presentmon_if_any() -> None:
    global _FPS_PM_PROC
    p = _FPS_PM_PROC
    if p:
        try:
            p.terminate()
        except Exception:
            pass
        _FPS_PM_PROC = None


atexit.register(stop_presentmon_if_any)


def nvidia_gpu_percent() -> float:
    try:
        r = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=utilization.gpu",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=3,
            **_win_hide_kw(),
        )
        if r.returncode != 0 or not r.stdout.strip():
            return 0.0
        v = float(r.stdout.strip().split("\n")[0].strip())
        return max(0.0, min(100.0, v))
    except Exception:
        return 0.0


def sample_once(pid: int, net_last: dict, disk_last: dict, psutil):
    now = time.time()
    try:
        p = psutil.Process(pid)
    except psutil.NoSuchProcess:
        return None, "gone"

    # 进程 CPU 需短间隔；系统 CPU 取整段间隔
    proc_cpu = p.cpu_percent(interval=0.15)
    sys_cpu = psutil.cpu_percent(interval=None)

    mem_info = p.memory_info()
    rss_mb = round(mem_info.rss / 1048576.0, 2)
    vms_mb = round(mem_info.vms / 1048576.0, 2)
    try:
        full = p.memory_full_info()
        uss_mb = round(getattr(full, "uss", 0) / 1048576.0, 2)
    except Exception:
        uss_mb = 0.0

    per_cpu = psutil.cpu_percent(interval=None, percpu=True) or []
    # psutil.cpu_freq() 只有一个全局频率；复制成 N 条重合曲线会被读成
    # 「各核心频率相同」，掩盖逐核差异。Windows 上拿不到逐核频率，标 None。
    # 故不再读取全局频率（没有消费者），避免留一个会被误用的误导性数据源。
    freq_list = [None] * len(per_cpu) if per_cpu else []

    n = psutil.net_io_counters()
    rx_k = tx_k = 0.0
    if net_last.get("t") is not None:
        dt_n = max(0.001, now - net_last["t"])
        rx_k = max(0.0, (n.bytes_recv - net_last["br"]) / 1024.0 / dt_n)
        tx_k = max(0.0, (n.bytes_sent - net_last["bs"]) / 1024.0 / dt_n)
    net_last["t"], net_last["br"], net_last["bs"] = now, n.bytes_recv, n.bytes_sent

    d_read_k = d_write_k = 0.0
    try:
        dio = p.io_counters()
        if disk_last.get("t") is not None:
            dt_d = max(0.001, now - disk_last["t"])
            d_read_k = max(0.0, (dio.read_bytes - disk_last["rb"]) / 1024.0 / dt_d)
            d_write_k = max(0.0, (dio.write_bytes - disk_last["wb"]) / 1024.0 / dt_d)
        disk_last["t"] = now
        disk_last["rb"], disk_last["wb"] = dio.read_bytes, dio.write_bytes
    except Exception:
        pass

    bat = psutil.sensors_battery()

    # psutil.sensors_temperatures() 给的是 CPU / 芯片结温（die temp），不是机身温度。
    # 报告页「温度」指标的口径是机身 / 电池温度，把结温塞进去会复现 Android 侧
    # 「手摸不热却 60 多度」的假高温。结温单独放 cpuTemp 供降频分析，
    # 主温度保持 None（PC 没有外壳热敏电阻时不编造数值）。
    cpu_die_temp = None
    try:
        temps = psutil.sensors_temperatures()
        if temps:
            for _name, entries in temps.items():
                for e in entries:
                    if e.current:
                        v = float(e.current)
                        cpu_die_temp = v if cpu_die_temp is None else max(cpu_die_temp, v)
                        break
    except Exception:
        pass

    # 无电池时整组置 None，不输出「电量 0% / 电流 0mA / 功耗 0mW」这种假数据；
    # 电池温度未采集也不用 CPU 结温顶替。
    battery_out = None
    if bat:
        battery_out = {
            "level": int(bat.percent) if bat.percent is not None else None,
            "voltage": None,
            "temperature": None,
            "currentNow": None,
            "power": None,
        }

    gpu_u = nvidia_gpu_percent()
    fps_val, fps_src, frame_stats = get_fps_for_sample()
    # 取不到帧率 ≠ 0 帧：PresentMon 无权限 / 不可用（含非 Win32 程序、受保护进程）时
    # fps_src == 'none'，此时写 null —— 与安卓采集的 FPS_NO_DATA_METHODS 约定一致，
    # 报告页断线、统计跳过，而不是画一条零线把均值拖低。
    fps_out = None if fps_src == 'none' else int(round(min(1000.0, max(0.0, float(fps_val)))))

    data = {
        "timestamp": int(now * 1000),
        "time": time.strftime("%H:%M:%S"),
        "cpu": {
            "sysCpu": round(min(100.0, float(sys_cpu)), 1),
            # P-02：进程 CPU 按单核百分比（单核跑满=100%，N 核可到 N×100），与
            # Android 侧同口径（perf_source_audit 有「不被 100 截断」锁定）。
            # 旧写法 min(100, …) 把多线程满载显示成 100%，CPU 瓶颈被完全掩盖。
            "procCpu": round(float(proc_cpu), 1),
        },
        "mem": {
            # 字段名与 Android 对齐；PC 上为进程工作集（RSS，MB），界面展示为「工作集内存」
            # PC 没有 Dalvik/Java Heap 等 Android 分项：未采集写 None，不能写 0MB
            "totalPss": rss_mb,
            "nativeHeap": uss_mb,
            "dalvikHeap": None,
            "javaHeap": None,
            "code": None,
            "stack": None,
            "graphics": None,
            "privateOther": round(max(0, rss_mb - uss_mb), 2),
            "system": round(max(0, vms_mb - rss_mb), 2),
        },
        "fps": fps_out,
        # PC 侧无帧时间序列，不做卡顿分级：null = 未测量，报 0 会被读成「零卡顿」
        "jank": None,
        "bigJank": None,
        "jankRate": None,
        "net": {"rxKBps": round(rx_k, 2), "txKBps": round(tx_k, 2)},
        "battery": battery_out,
        "temperature": None,
        "cpuTemp": round(cpu_die_temp, 1) if cpu_die_temp is not None else None,
        "gpu": round(gpu_u, 1),
        "cpuCores": {
            "usage": [round(float(x), 1) for x in per_cpu],
            "freq": freq_list,
        },
        "pid": pid,
        "pcExtra": {
            "diskReadKBps": round(d_read_k, 2),
            "diskWriteKBps": round(d_write_k, 2),
            "exe": p.exe() or "",
            "name": p.name() or "",
            "fpsSource": fps_src,
            "fpsFloat": None if fps_src == 'none' else fps_val,
            # 帧延迟分解（PresentMon v1 列，1s 滑动均值 ms）：拿不到列时 None = 未测量
            "frameDisplayChangeMs": frame_stats.get("displayChange"),
            "frameUntilDisplayedMs": frame_stats.get("untilDisplayed"),
            "framePresentApiMs": frame_stats.get("inPresentApi"),
            "frameRenderLatencyMs": frame_stats.get("renderLatency"),
            "frameAppStartGapMs": frame_stats.get("appStartGap"),
        },
    }
    return data, None


def main():
    if len(sys.argv) < 2:
        print(
            json.dumps({"error": "usage", "message": "collect_pc_perf.py <exe路径>"}),
            flush=True,
        )
        sys.exit(2)
    exe_path = sys.argv[1].strip().strip('"')
    if not exe_path or not os.path.isfile(exe_path):
        print(
            json.dumps(
                {
                    "error": "bad_exe",
                    "message": "文件不存在: " + exe_path,
                }
            ),
            flush=True,
        )
        sys.exit(2)

    import psutil

    pid = find_pid_by_exe(exe_path)
    if pid is None:
        print(
            json.dumps(
                {
                    "error": "not_running",
                    "message": "未找到已运行的进程，请先启动: " + exe_path,
                }
            ),
            flush=True,
        )
        sys.exit(3)

    psutil.cpu_percent(interval=None)
    time.sleep(0.2)
    net_last = {"t": None, "br": 0, "bs": 0}
    disk_last = {"t": None, "rb": 0, "wb": 0}

    sys.stderr.write("[collect_pc_perf] PID=%s 采样间隔 %.1fs\n" % (pid, INTERVAL_SEC))
    sys.stderr.flush()

    pm_thread = threading.Thread(target=_presentmon_worker, args=(pid,), daemon=True)
    pm_thread.start()
    time.sleep(0.35)

    # 预热进程 CPU 计数，避免首帧 procCpu 恒为 0
    try:
        _p = psutil.Process(pid)
        _p.cpu_percent(interval=None)
        time.sleep(0.05)
        _p.cpu_percent(interval=0.2)
    except Exception:
        pass

    while True:
        try:
            data, err = sample_once(pid, net_last, disk_last, psutil)
        except psutil.NoSuchProcess:
            print(json.dumps({"error": "process_gone"}), flush=True)
            sys.exit(0)
        if err == "gone":
            print(json.dumps({"error": "process_gone"}), flush=True)
            sys.exit(0)
        if data:
            print(json.dumps(data, ensure_ascii=False), flush=True)
        time.sleep(INTERVAL_SEC)


if __name__ == "__main__":
    main()
