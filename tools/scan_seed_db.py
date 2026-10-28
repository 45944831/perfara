#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""审计 exe 内嵌的**种子数据库**——现有审计链唯一的盲区。

为什么需要它（2026-10-27）：
    `PerfaraServer.exe` 把 `_seed/webperf.db` 压进 PyInstaller 归档，首次启动复制给用户。
    zip 层审计（`scan_package.py`）会跳过 `.exe`（二进制），所以「包内 data/ 0 条 +
    敏感串 0 命中」这个结论覆盖不到它 —— 真实设备序列号就是这样随 v2026.10.23.1 发出去的。

做法：在空目录里真跑一次 exe（`--no-browser --data-dir <tmp>`），把它首次生成的库
拿出来，用 `sensitive_patterns` 逐列扫描。**只有跑起来才知道 exe 里装了什么。**
除了泄漏扫描，还跑两道可用性门禁（2026-10-28 补）：
  · JSON 列必须可解析（v2026.10.27 的种子库就是这样被脱敏正则改成 44 处非法 JSON 的）
  · 逐条演示记录 GET /api/tests/{id} 不得 500

用法：
    python tools/scan_seed_db.py                              # 默认扫 perfara/server/PerfaraServer.exe
    python tools/scan_seed_db.py <exe 路径>
    python tools/scan_seed_db.py <exe> --keep                 # 保留临时目录便于人工排查

退出码：0 干净 / 1 有命中（含 free page 字节残留）、种子库 JSON 损坏或详情接口 500 / 2 启动失败
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_EXE = os.path.join(ROOT, "perfara", "server", "PerfaraServer.exe")

sys.path.insert(0, os.path.join(ROOT, "tools"))
import sensitive_patterns as sp  # noqa: E402

READY_TIMEOUT = 90.0


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_health(port: int, deadline: float) -> bool:
    url = "http://127.0.0.1:%d/api/health" % port
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.1)
    return False


def kill_tree(pid: int) -> None:
    subprocess.run(["taskkill", "/T", "/F", "/PID", str(pid)],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def text_columns(cur, table):
    cur.execute("PRAGMA table_info(%s)" % table)
    return [r[1] for r in cur.fetchall()]


def tables(cur):
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    return [r[0] for r in cur.fetchall()]


# 种子库里承载 JSON 的列。脱敏脚本一旦把数字字面量也替换掉，坏的就是这些列，
# 表现是「看板列表均值空白 + 点详情 500」——泄漏扫描（只看敏感词）完全看不见。
JSON_COLUMNS = [
    ("metric_blobs", "content"),
    ("test_runs", "summary"),
    ("test_runs", "raw_json"),
    ("parsed_info", "summary_json"),
    ("metric_configs", "config_json"),
]


def check_json_columns(db_path):
    """返回 (损坏列表, 合法计数)。损坏项为 (表, 列, rowid, 错误)。"""
    bad, good = [], 0
    con = sqlite3.connect(db_path)
    try:
        have = {r[0] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        for tbl, col in JSON_COLUMNS:
            if tbl not in have:
                continue
            cols = {r[1] for r in con.execute("PRAGMA table_info(%s)" % tbl).fetchall()}
            if col not in cols or "id" not in cols:
                continue
            for rid, val in con.execute(
                "SELECT id, %s FROM %s WHERE %s IS NOT NULL AND %s != ''" % (col, tbl, col, col)
            ).fetchall():
                if not isinstance(val, str) or not val.strip():
                    continue
                try:
                    json.loads(val)
                    good += 1
                except Exception as e:
                    bad.append((tbl, col, rid, str(e)))
    finally:
        con.close()
    return bad, good


def check_detail_endpoints(port, db_path):
    """逐条演示记录真取详情：500 即视为发布阻断（新用户第一次点看板就是这个页面）。"""
    con = sqlite3.connect(db_path)
    try:
        ids = [r[0] for r in con.execute("SELECT id FROM test_runs ORDER BY id").fetchall()]
    except sqlite3.Error:
        ids = []
    finally:
        con.close()
    bad = []
    for tid in ids:
        for uid in ("perfara123", "wonderxu"):
            req = urllib.request.Request("http://127.0.0.1:%d/api/tests/%d" % (port, tid))
            req.add_header("X-WebPerf-Uid", uid)
            try:
                with urllib.request.urlopen(req, timeout=25) as r:
                    status = r.status
                    r.read()
            except urllib.error.HTTPError as e:
                status = e.code
            except Exception:
                status = -1
            if status == 500:
                bad.append((tid, uid))
    return ids, bad


def scan_db(db_path: str, pats):
    con = sqlite3.connect(db_path)
    cur = con.cursor()
    hits, scanned = [], 0
    for t in tables(cur):
        for c in text_columns(cur, t):
            try:
                rows = cur.execute("SELECT %s FROM %s" % (c, t)).fetchall()
            except sqlite3.Error:
                continue
            for (val,) in rows:
                if not isinstance(val, str) or not val:
                    continue
                scanned += 1
                for label, rx in pats:
                    for m in rx.finditer(val):
                        hits.append((t, c, label, m.group(0)))
    cur.execute("SELECT id FROM test_runs")
    alive = {r[0] for r in cur.fetchall()}
    cur.execute("SELECT test_run_id FROM perfara_demo_snapshot")
    stale = [r[0] for r in cur.fetchall() if r[0] not in alive]
    con.close()
    return hits, scanned, stale


def scan_db_bytes(db_path: str, pats):
    """整文件字节扫描：SQL 看不见的 free page / 旧版本页残留也算泄漏。

    种子库会被压进 exe、还会进 git，别人拿到的是二进制而不是查询结果。
    2026-10-28 就是这样在「SQL 全绿」的种子库里捞出真机机型与真实包名的。
    """
    with open(db_path, "rb") as f:
        raw = f.read().decode("utf-8", errors="replace")
    hits = []
    for label, rx in pats:
        for m in rx.finditer(raw):
            hits.append((label, m.group(0)))
    return hits, len(raw)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("exe", nargs="?", default=DEFAULT_EXE)
    ap.add_argument("--keep", action="store_true", help="保留临时目录")
    args = ap.parse_args()

    exe = os.path.abspath(args.exe)
    if not os.path.isfile(exe):
        print("[error] 找不到 exe: %s" % exe)
        return 2

    pats = sp.load()
    print("exe    : %s (%.1f MB)" % (exe, os.path.getsize(exe) / 1048576))
    print("规则   : %d 条 (%s)" % (len(pats), ", ".join(l for l, _ in pats)))

    home = tempfile.mkdtemp(prefix="perfara_seed_")
    port = free_port()
    t0 = time.time()
    proc = subprocess.Popen(
        [exe, "--no-browser", "--data-dir", home, "--port", str(port)],
        cwd=os.path.dirname(exe),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        ok = wait_health(port, time.time() + READY_TIMEOUT)
        if not ok:
            print("[error] %.0fs 内服务未就绪，无法取种子库" % READY_TIMEOUT)
            return 2
        print("启动   : %.2fs 就绪" % (time.time() - t0))

        db = os.path.join(home, "data", "webperf.db")
        if not os.path.isfile(db):
            print("[error] 首次启动未生成 data/webperf.db：%s" % db)
            return 2
        print("种子库 : %d B" % os.path.getsize(db))

        hits, scanned, stale = scan_db(db, pats)
        print("扫描   : %d 个文本值" % scanned)
        if hits:
            print("\n[FAIL] 命中 %d 处：" % len(hits))
            seen = set()
            for t, c, label, val in hits:
                k = (t, c, val)
                if k in seen:
                    continue
                seen.add(k)
                print("   [%s.%s] <%s> %r" % (t, c, label, val[:60]))
        else:
            print("\n[OK] 0 命中")
        if stale:
            print("[WARN] 演示快照指向不存在的记录：%s" % stale)

        bhits, bsize = scan_db_bytes(db, pats)
        print("字节   : %d B 整文件扫描" % bsize)
        if bhits:
            print("[FAIL] 二进制里有 %d 处残留（SQL 查不到，但解包就能看到）：" % len(bhits))
            seen_b = set()
            for label, val in bhits:
                if (label, val) in seen_b:
                    continue
                seen_b.add((label, val))
                print("   <%s> %r" % (label, val[:60]))
            print("   修 tools/make_seed_db.py：删/改过的页要 VACUUM 才能归还内容。")
        else:
            print("[OK] 字节层 0 命中")

        # ── 可用性门禁：泄漏扫描只证明「没带出隐私」，证明不了「数据还能用」──
        jbad, jgood = check_json_columns(db)
        print("JSON   : %d 个合法 / %d 个损坏" % (jgood, len(jbad)))
        if jbad:
            print("[FAIL] 种子库有 %d 处 JSON 不可解析（脱敏把非字符串内容也改了）：" % len(jbad))
            for tbl, col, rid, err in jbad[:8]:
                print("   [%s.%s] id=%s  %s" % (tbl, col, rid, err[:90]))
            print("   修 tools/make_seed_db.py：序列号形态正则需要求含字母，"
                  "且 JSON 列只替换字符串叶子。")

        ids, dbad = check_detail_endpoints(port, db)
        print("详情   : GET /api/tests/{id} 抽样 %d 条 × 2 个 uid，500 计 %d 处"
              % (len(ids), len(dbad)))
        if dbad:
            print("[FAIL] 演示记录详情 500（用户首启即白屏/报错）：%s" % dbad[:8])

        return 1 if (hits or bhits or jbad or dbad) else 0
    finally:
        kill_tree(proc.pid)
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
        time.sleep(0.4)
        if args.keep:
            print("临时目录保留: %s" % home)
        else:
            shutil.rmtree(home, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
