#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""后端上传接口畸形数据测试（独立临时库 + 临时服务，不污染真实数据）。

覆盖既有 test_api_full.py 没细化的部分：
  E01-E06  结构畸形：perf 为 null / 为字符串 / 为数组 / 嵌套超深 / 巨大 JSON
  E07-E10  类型错乱：fps 是字符串数组 / 混合类型 / NaN 字样 / 布尔数组
  E11-E14  编码与注入：unicode 边界、SQL 注入字样、超长字符串、控制字符
  E15-E18  边界数值：Infinity / -Infinity / 1e308 / 极小值
"""
from __future__ import annotations

import json
import os
import socket
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

os.environ["no_proxy"] = "127.0.0.1,localhost"
os.environ["NO_PROXY"] = "127.0.0.1,localhost"

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT / "perfara"))
sys.path.insert(0, str(ROOT))

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


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


PORT = _free_port()
BASE = f"http://127.0.0.1:{PORT}"

import uvicorn  # noqa: E402
from backend.app import app  # noqa: E402

TMP = tempfile.mkdtemp(prefix="perfara_edge_")
os.environ["WEB_PERF_DB"] = str(Path(TMP) / "webperf.db")
# database 模块在 import 时就读 env，需在 import app 前设置 —— app 已 import，
# 这里改用直接改 DB_PATH 的方式
from backend import database  # noqa: E402

database.DB_PATH = str(Path(TMP) / "webperf.db")
database.SQLALCHEMY_DATABASE_URL = f"sqlite:///{database.DB_PATH}"
database.engine.dispose()
from sqlalchemy import create_engine  # noqa: E402

database.engine = create_engine(database.SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False})
database.SessionLocal.configure(bind=database.engine)
database.Base.metadata.create_all(bind=database.engine)

server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=PORT, log_level="error"))
th = threading.Thread(target=server.run, daemon=True)
th.start()
for _ in range(80):
    try:
        urllib.request.urlopen(BASE + "/api/chart-configs", timeout=2)
        break
    except Exception:
        time.sleep(0.25)

UID = "edge_tester"


def post_upload(body_bytes: bytes, name: str, expect: int) -> tuple[bool, str]:
    req = urllib.request.Request(
        BASE + f"/api/upload?uid={UID}", data=body_bytes, method="POST",
        headers={"Content-Type": "application/json"},
    )
    code = -1
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            code = resp.getcode()
    except urllib.error.HTTPError as e:
        code = e.code
    except Exception as e:  # noqa: BLE001
        return False, f"{name}: 连接异常 {e}"
    return code == expect, f"{name}: got={code} expect={expect}"


def not_500(body_bytes: bytes, name: str) -> tuple[bool, str]:
    """关键断言：畸形输入绝不能打成 500（那说明异常没被处理、直接崩到框架层）。"""
    req = urllib.request.Request(
        BASE + f"/api/upload?uid={UID}", data=body_bytes, method="POST",
        headers={"Content-Type": "application/json"},
    )
    code = -1
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            code = resp.getcode()
    except urllib.error.HTTPError as e:
        code = e.code
    except Exception as e:  # noqa: BLE001
        return False, f"{name}: 连接异常 {e}"
    if code == 500:
        return False, f"{name}: got=500（服务端异常未处理，直接崩到框架层）"
    return True, f"{name}: got={code}（已被优雅处理）"


def base() -> dict:
    """按**真实**上传结构构造（见 perfara/tests/fixtures/sample_payload.json）：
    device 是 dict（bundleId/appName/category），perf 是采样点 list。
    ⚠️ android 的 cpu/mem/net/battery/cpuCores 必须是 dict ——
    parsers.py 直接对它们调 .get()，传标量会 AttributeError。"""
    return {
        "device": {"name": "EdgeX", "bundleId": "com.edge.x",
                   "appName": "EdgeX", "category": "android"},
        "perf": [{
            "fps": 60,
            "cpu": {"sysCpu": 10, "procCpu": 5},
            "mem": {"totalPss": 100, "nativeHeap": 20},
            "net": {"rxKBps": 1, "txKBps": 2},
            "battery": {"level": 90, "currentNow": 100},
            "cpuCores": {"usage": [10, 20], "freq": [1800, 2000]},
            "timestamp": 1700000000000,
            "time": "00:00:01",
        }],
        "ts": 1700000000000,
        "testid": "edge0001",
    }


def jb(obj) -> bytes:
    return json.dumps(obj).encode("utf-8")


def main() -> int:
    print("== 后端上传畸形数据测试 ==")

    # ─────────── 字段类型错乱（本次修复的核心） ───────────
    print("[字段类型错乱 → 不能 500]")
    p = base(); p["app"] = {"pkg": "com.edge.x", "name": "EdgeX"}
    ok, d = not_500(jb(p), "E01 顶层 app 为 dict"); check(d, ok)
    p = base(); p["device"] = {"appName": {"nested": "dict"}, "bundleId": "com.edge.x"}
    ok, d = not_500(jb(p), "E02 device.appName 为 dict"); check(d, ok)
    p = base(); p["device"] = {"appName": ["a", "b"], "bundleId": ["x"]}
    ok, d = not_500(jb(p), "E03 appName/bundleId 为 list"); check(d, ok)
    p = base(); p["device"] = "not-a-dict"
    ok, d = not_500(jb(p), "E04 device 为字符串"); check(d, ok)
    p = base(); p["device"] = [1, 2, 3]
    ok, d = not_500(jb(p), "E05 device 为数组"); check(d, ok)
    p = base(); p["device"]["appName"] = True
    ok, d = not_500(jb(p), "E06 appName 为布尔"); check(d, ok)
    p = base(); p["device"]["bundleId"] = 12345
    ok, d = not_500(jb(p), "E07 bundleId 为数字"); check(d, ok)
    p = base(); p["label"] = {"deep": "dict"}
    ok, d = not_500(jb(p), "E08 label 为 dict"); check(d, ok)
    p = base(); p["platform"] = {"x": 1}
    ok, d = not_500(jb(p), "E09 platform 为 dict"); check(d, ok)
    p = base(); p["device"]["category"] = {"x": 1}
    ok, d = not_500(jb(p), "E10 category 为 dict"); check(d, ok)

    # ─────────── 结构畸形 ───────────
    print("[结构畸形]")
    p = base(); p["perf"] = None
    ok, d = not_500(jb(p), "E11 perf=null"); check(d, ok)
    p = base(); p["perf"] = "not-an-array"
    ok, d = not_500(jb(p), "E12 perf=字符串"); check(d, ok)
    p = base(); p["perf"] = {"fps": [1, 2]}
    ok, d = not_500(jb(p), "E13 perf=dict"); check(d, ok)
    deep = base()
    node = {"v": 1}
    for _ in range(200):
        node = {"n": node}
    deep["perf"] = [node]
    ok, d = not_500(jb(deep), "E14 嵌套 200 层"); check(d, ok)
    big = base()
    big["perf"] = [{"fps": 60}] * 100000
    ok, d = not_500(jb(big), "E15 超大 JSON(~5MB)"); check(d, ok)
    ok, d = not_500(jb([1, 2, 3]), "E16 顶层为数组"); check(d, ok)

    # ─────────── 类型错乱 ───────────
    print("[采样点类型错乱]")
    p = base(); p["perf"] = [{"fps": "60"}]
    ok, d = not_500(jb(p), "E17 fps 为字符串"); check(d, ok)
    p = base(); p["perf"] = [{"fps": 60, "cpu": "x", "mem": None}]
    ok, d = not_500(jb(p), "E18 混合类型"); check(d, ok)
    p = base()
    raw = json.dumps(p).replace('"fps": 60', '"fps": NaN')
    ok, d = not_500(raw.encode(), "E19 NaN 字面量"); check(d, ok)
    p = base(); p["perf"] = [{"fps": True, "cpu": False}]
    ok, d = not_500(jb(p), "E20 fps 为布尔"); check(d, ok)
    p = base(); p["perf"] = ["just-a-string", 42, None]
    ok, d = not_500(jb(p), "E21 perf 元素为裸值"); check(d, ok)

    # ─────────── 编码与注入 ───────────
    print("[编码与注入]")
    p = base(); p["device"]["appName"] = "'; DROP TABLE tests; --"
    ok, d = not_500(jb(p), "E22 SQL 注入字样"); check(d, ok)
    p = base(); p["device"]["appName"] = "x" * 100000
    ok, d = not_500(jb(p), "E23 超长字符串(10万字符)"); check(d, ok)
    p = base(); p["device"]["appName"] = "emoji😀控制\x01\x02字符"
    ok, d = not_500(jb(p), "E24 emoji + 控制字符"); check(d, ok)
    p = base(); p["device"]["appName"] = "极限unicode\U0010ffff"
    ok, d = not_500(jb(p), "E25 极限码位"); check(d, ok)

    # ─────────── 边界数值 ───────────
    print("[边界数值]")
    p = base()
    raw = json.dumps(p).replace('"fps": 60', '"fps": Infinity')
    ok, d = not_500(raw.encode(), "E26 Infinity 字面量"); check(d, ok)
    p = base(); p["perf"] = [{"fps": 1e308, "cpu": -1e308, "mem": 1e-308}]
    ok, d = not_500(jb(p), "E27 1e308 / -1e308 / 1e-308"); check(d, ok)
    p = base(); p["perf"] = [{"fps": 60.5}]
    ok, d = not_500(jb(p), "E28 小数 FPS"); check(d, ok)
    p = base(); p["perf"] = [{"fps": -0.0}]
    ok, d = not_500(jb(p), "E29 负零"); check(d, ok)

    # ─────────── 正常上传仍要成功（防止修复把正常路径打断） ───────────
    print("[正常路径未回归]")
    ok, d = post_upload(jb(base()), "E30 正常上传仍返回 200", 200); check(d, ok)
    p = base(); p["device"]["bundleId"] = 98765
    ok, d = post_upload(jb(p), "E31 数字型 bundleId 仍返回 200", 200); check(d, ok)

    # ─────────── 验证服务仍存活 ───────────
    print("[服务健壮性]")
    try:
        with urllib.request.urlopen(BASE + "/api/health", timeout=5) as r:
            ok = r.getcode() == 200
    except Exception:
        ok = False
    check("E32 经历全部畸形输入后服务仍健康", ok)

    server.should_exit = True
    time.sleep(1)
    print(f"\n==== 畸形数据测试结果: {PASS} PASS / {FAIL} FAIL ====")
    if FAILED:
        print("FAILED: " + ", ".join(FAILED))
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
