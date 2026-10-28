#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""metricConfig 上传回归测试（独立临时库 + 临时服务，不污染真实数据）。

覆盖：
  W01-W03  android 带 metricConfig(fps/cpu 移除) 上传 → series 过滤 + summary 置 null + test_raw 保留配置
  W04-W05  无 metricConfig（旧数据）→ 全量保留，行为不变
  W06      ios 带 metricConfig(mem/disk 移除) → series 过滤
  W07      pc 带 metricConfig(disk/fps 移除) → series 过滤（含 pcExtra.*）
  W08      /api/chart-configs 仍返回 4 类配置（数组结构未被破坏）
  W09      详情接口 test_raw 含 metricConfig（SPA perf 视图适配依据）
  W10      补丁后的 SPA 资源可被静态服务（含注入标记）
"""
import json
import logging
import os
import shutil
import socket
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

TMP = tempfile.mkdtemp(prefix="perfara_mc_")
os.environ["WEB_PERF_DB"] = os.path.join(TMP, "test.db")
os.environ["PERFARA_HOME"] = TMP
os.environ["no_proxy"] = "127.0.0.1,localhost"
os.environ["NO_PROXY"] = "127.0.0.1,localhost"

sys.path.insert(0, ROOT)

PASS = 0
FAIL = 0
FAILED = []


def _record(ok, name, extra=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        FAILED.append(name)
        print(f"  FAIL  {name}  {extra}")


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


PORT = _free_port()
BASE = f"http://127.0.0.1:{PORT}"

import uvicorn  # noqa: E402
from backend.app import app  # noqa: E402

server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=PORT, log_level="error"))
th = threading.Thread(target=server.run, daemon=True)
th.start()
for _ in range(80):
    try:
        urllib.request.urlopen(BASE + "/api/chart-configs", timeout=2)
        break
    except Exception:
        time.sleep(0.25)


def call(method, path, body=None):
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.getcode(), json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8"))
        except Exception:
            return e.code, {}


UID = "mc-test-uid"


def mk_android(n=6):
    perf = []
    for i in range(n):
        perf.append({
            "timestamp": 1700000000000 + i * 1000,
            "time": f"12:00:0{i}",
            "cpu": {"sysCpu": 10 + i, "procCpu": 5 + i},
            "cpuCores": {"usage": [1, 2], "freq": [100, 200]},
            "mem": {"totalPss": 1000 + i, "javaHeap": 10},
            "fps": 60, "jank": 1, "bigJank": 0,
            "net": {"rxKBps": 5, "txKBps": 2},
            "gpu": 3, "temperature": 30,
            "battery": {"currentNow": 100, "power": 2, "level": 80},
        })
    return {"device": {"name": "Pixel", "category": "android"}, "perf": perf, "tag": None}


def mk_ios(n=6):
    perf = []
    for i in range(n):
        perf.append({
            "timestamp": 1700000000000 + i * 1000,
            "cpuUsage": 8, "cpuTotalSystem": 3, "cpuTotalUser": 5,
            "fps": 59, "jank": 0, "bigjank": 0,
            "physFootprint": 200, "memResidentSize": 180, "memRPrvt": 100,
            "_diskReadKBps": 10, "_diskWriteKBps": 5,
            "_ctxSwitchPs": 100, "_intWakeupsPs": 20, "_vmPageInsPs": 3,
        })
    return {"device": {"name": "iPhone", "category": "ios"}, "perf": perf, "tag": None}


def mk_pc(n=6):
    perf = []
    for i in range(n):
        perf.append({
            "timestamp": 1700000000000 + i * 1000,
            "cpu": {"sysCpu": 12, "procCpu": 6}, "cpuCores": {"usage": [1, 2], "freq": [100, 200]},
            "mem": {"totalPss": 900}, "fps": 58, "jank": 2, "bigJank": 0, "jankRate": 0.5,
            "net": {"rxKBps": 4, "txKBps": 1}, "gpu": 2, "temperature": 35,
            "battery": {"currentNow": 50, "power": 1, "level": 90},
            "pid": 1234,
            "pcExtra": {"diskReadKBps": 7, "diskWriteKBps": 3, "fpsFloat": 58.5, "exe": "a.exe", "name": "A"},
        })
    return {"device": {"name": "PC", "category": "pc"}, "perf": perf, "tag": None}


def upload(payload, name, expect=200):
    code, j = call("POST", f"/api/upload?uid={UID}", payload)
    _record(code == expect, name, f"code={code} body={str(j)[:200]}")
    return j if code == expect else None


def get(path, name, expect=200):
    code, j = call("GET", path)
    _record(code == expect, name, f"code={code}")
    return j if code == expect else Noneprint("[W01-W03] android 上传带 metricConfig(fps/cpu 移除)")
p1 = mk_android()
p1["metricConfig"] = {"fps": False, "cpu": False, "mem": True, "net": True, "gpu": True, "temp": True, "battery": True}
r1 = upload(p1, "W01 upload android+mc -> 200")
if r1:
    tid = r1.get("id") or r1.get("test_run_id") or (r1.get("test") or {}).get("id")
    d = get(f"/api/tests/{tid}?uid={UID}", "W02 detail -> 200")
    if d:
        blob = (d.get("blobs") or [{}])[0].get("content") or {}
        series = blob.get("series") or {}
        keys = set(series.keys())
        _record(not any(k == "fps" or k.startswith("cpu") for k in keys), "W03a fps/cpu series 已删除", str(sorted(keys))[:200])
        _record(any(k.startswith("mem.") for k in keys), "W03b mem series 保留")
        _record(any(k.startswith("battery.") for k in keys), "W03c battery series 保留")
        meta = blob.get("meta") or {}
        _record(meta.get("metricConfig", "MISSING") == p1["metricConfig"], "W03d meta.metricConfig 记录")
        summary = (d.get("test") or {}).get("summary") or {}
        _record(summary.get("fpsAvg") is None and summary.get("cpuProcAvg") is None, "W03e fpsAvg/cpuProcAvg 置 null", str(summary)[:160])
        _record(summary.get("memPssAvg") is not None, "W03f memPssAvg 保留")
        raw = d.get("test_raw") or {}
        _record((raw.get("metricConfig") or {}).get("fps") is False, "W09 test_raw.metricConfig 存在（SPA 适配依据）")

print("[W04-W05] 旧数据无 metricConfig → 行为不变")
r4 = upload(mk_android(), "W04 upload android 无配置 -> 200")
if r4:
    tid = r4.get("id") or r4.get("test_run_id") or (r4.get("test") or {}).get("id")
    d = get(f"/api/tests/{tid}?uid={UID}", "W05 detail -> 200")
    if d:
        series = ((d.get("blobs") or [{}])[0].get("content") or {}).get("series") or {}
        _record("fps" in series and "cpu.sysCpu" in series and "mem.totalPss" in series, "W05a 全量 series 保留")
        summary = (d.get("test") or {}).get("summary") or {}
        _record(summary.get("fpsAvg") is not None and summary.get("cpuProcAvg") is not None, "W05b summary 非 null")

print("[W06] ios 带 metricConfig(mem/disk 移除)")
p6 = mk_ios()
p6["metricConfig"] = {"fps": True, "cpu": True, "mem": False, "disk": False, "events": True, "proc": True}
r6 = upload(p6, "W06 upload ios+mc -> 200")
if r6:
    tid = r6.get("id") or r6.get("test_run_id") or (r6.get("test") or {}).get("id")
    d = get(f"/api/tests/{tid}?uid={UID}", "W06b detail -> 200")
    if d:
        keys = set(((d.get("blobs") or [{}])[0].get("content") or {}).get("series") or {})
        _record(not any(k.startswith("mem") or k.startswith("physFootprint") for k in keys), "W06c ios mem series 删除", str(sorted(keys))[:200])
        _record("_diskReadKBps" not in keys and "_diskWriteKBps" not in keys, "W06d ios disk series 删除")
        _record("fps" in keys and "_ctxSwitchPs" in keys, "W06e ios fps/events 保留")

print("[W07] pc 带 metricConfig(disk/fps 移除)")
p7 = mk_pc()
p7["metricConfig"] = {"fps": False, "cpu": True, "mem": True, "net": True, "gpu": True, "temp": True, "battery": True, "disk": False}
r7 = upload(p7, "W07 upload pc+mc -> 200")
if r7:
    tid = r7.get("id") or r7.get("test_run_id") or (r7.get("test") or {}).get("id")
    d = get(f"/api/tests/{tid}?uid={UID}", "W07b detail -> 200")
    if d:
        keys = set(((d.get("blobs") or [{}])[0].get("content") or {}).get("series") or {})
        _record("fps" not in keys and "jankRate" not in keys and "pcExtra.fpsFloat" not in keys, "W07c pc fps 组 series 删除", str(sorted(keys))[:200])
        _record("pcExtra.diskReadKBps" not in keys and "pcExtra.diskWriteKBps" not in keys, "W07d pc disk series 删除")
        _record("cpu.sysCpu" in keys and "pid" in keys, "W07e pc cpu/pid 保留")

print("[W08] /api/chart-configs 结构完好")
code, cfg = call("GET", "/api/chart-configs")
ok = code == 200 and all(k in cfg for k in ("android", "ios", "ios_gpu", "pc"))
ok = ok and isinstance(cfg.get("android"), dict) and isinstance(cfg.get("ios"), dict) and isinstance(cfg.get("pc"), dict)
ok = ok and isinstance(cfg.get("ios_gpu"), dict) and isinstance(cfg["ios_gpu"].get("groups"), dict) and isinstance(cfg["ios_gpu"].get("low_gpu_groups"), dict)
_record(ok, "W08 chart-configs 4 类配置齐全")

print("[W10] 补丁后的 SPA 静态资源")
code, raw = None, None
try:
    with urllib.request.urlopen(BASE + "/assets/index-CX8C-b2E.js", timeout=10) as resp:
        code = resp.getcode()
        raw = resp.read().decode("utf-8", "replace")
except Exception as e:
    code = -1
_record(code == 200 and raw and "perfara-metric-config-patch-v1" in raw, "W10 main bundle 补丁已生效")

print()
print(f"RESULT: {PASS} passed, {FAIL} failed")
if FAILED:
    print("FAILED:", ", ".join(FAILED))
server.should_exit = True
th.join(timeout=8)
logging.shutdown()
# 应用启动时给 root logger 挂了 RotatingFileHandler；显式 close + 摘除，
# 否则 Windows 上 logs/app.log 仍被占用，临时目录会残留。
for _h in list(logging.getLogger().handlers):
    try:
        _h.flush()
        _h.close()
    except Exception:
        pass
    logging.getLogger().removeHandler(_h)
try:
    from backend import database as _db
    _db.engine.dispose()
except Exception:
    pass
for _ in range(6):
    shutil.rmtree(TMP, ignore_errors=True)
    if not os.path.exists(TMP):
        break
    time.sleep(0.3)
sys.exit(1 if FAIL else 0)
