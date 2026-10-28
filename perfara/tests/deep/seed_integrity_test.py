"""种子库完整性测试：打包版首次启动生成的演示库必须能被看板正常读取。

覆盖两类此前漏检的问题：
  1. 脱敏规则把 JSON 数字字面量一起替换掉，产出的不是合法 JSON
  2. 看板详情接口对 blob content 无容错，遇到坏 JSON 直接 500

用法：
    python perfara/tests/deep/seed_integrity_test.py            # 测 perfara/dist/PerfaraServer.exe
    python perfara/tests/deep/seed_integrity_test.py --db PATH  # 只测某个库文件（不起服务）
    python perfara/tests/deep/seed_integrity_test.py --src     # 测仓库内 _seed/webperf.db

退出码 0 = 全部通过。
"""
import argparse
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND_PKG = os.path.abspath(os.path.join(HERE, "..", ".."))
ROOT = os.path.abspath(os.path.join(BACKEND_PKG, ".."))
DEFAULT_EXE = os.path.join(BACKEND_PKG, "dist", "PerfaraServer.exe")
SEED_DB = os.path.join(BACKEND_PKG, "_seed", "webperf.db")

JSON_COLUMNS = [
    ("metric_blobs", "content"),
    ("test_runs", "summary"),
    ("test_runs", "raw_json"),
    ("parsed_info", "summary_json"),
    ("metric_configs", "config_json"),
]

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("  PASS  " if ok else "  FAIL  ") + name + (("  | " + detail) if detail else ""))


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def kill_tree(pid: int) -> None:
    """onefile exe 的 bootloader 与实际服务是两层，terminate() 只收掉前者。

    用 taskkill /T 连子进程一起收，避免测试结束后留下监听端口的孤儿。
    """
    try:
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(pid)],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass


def wait_health(port, deadline):
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.3)
    return False


def http(port, path, uid=None, timeout=20):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}")
    if uid:
        req.add_header("X-WebPerf-Uid", uid)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        return -1, str(e).encode()


def audit_json(db_path):
    """返回 [(table, column, row_id, err)]，只收集真正的 JSON 解析失败。"""
    bad = []
    good = 0
    con = sqlite3.connect(db_path)
    try:
        have = {r[0] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        for tbl, col in JSON_COLUMNS:
            if tbl not in have:
                continue
            cols = {r[1] for r in con.execute(f"PRAGMA table_info({tbl})")}
            if col not in cols or "id" not in cols:
                continue
            for rid, val in con.execute(
                f"SELECT id, {col} FROM {tbl} WHERE {col} IS NOT NULL AND {col} != ''"
            ).fetchall():
                if not isinstance(val, str):
                    continue
                try:
                    json.loads(val)
                    good += 1
                except Exception as e:
                    bad.append((tbl, col, rid, str(e)))
    finally:
        con.close()
    return bad, good


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("exe", nargs="?", default=DEFAULT_EXE)
    ap.add_argument("--db", help="跳过 exe，直接检查指定库文件")
    ap.add_argument("--src", action="store_true", help="检查仓库内的 _seed/webperf.db")
    args = ap.parse_args()

    if args.src:
        db, home, port, proc = SEED_DB, None, None, None
        label = "_seed/webperf.db（仓库内）"
    elif args.db:
        db, home, port, proc = os.path.abspath(args.db), None, None, None
        label = db
    else:
        exe = os.path.abspath(args.exe)
        if not os.path.isfile(exe):
            print(f"[error] 找不到 exe: {exe}")
            return 2
        home = tempfile.mkdtemp(prefix="seedint_")
        port = free_port()
        proc = subprocess.Popen(
            [exe, "--no-browser", "--data-dir", home, "--port", str(port)],
            cwd=os.path.dirname(exe),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        if not wait_health(port, time.time() + 60):
            check("打包版服务启动", False, "60s 内未就绪")
            kill_tree(proc.pid)
            return 1
        db = os.path.join(home, "data", "webperf.db")
        label = f"{os.path.basename(exe)} 首次启动生成的库"

    print(f"== 种子库完整性：{label} ==")
    check("库文件存在", os.path.isfile(db), db)
    if not os.path.isfile(db):
        return 1

    try:
        # ---- 1. 数据库自身健康 ----
        con = sqlite3.connect(db)
        ic = con.execute("PRAGMA integrity_check").fetchone()[0]
        con.close()
        check("PRAGMA integrity_check = ok", ic == "ok", ic)

        # ---- 2. JSON 列必须可解析 ----
        bad, good = audit_json(db)
        check("JSON 列全部可解析", not bad, f"{good} 个合法 / {len(bad)} 个损坏")
        for tbl, col, rid, err in bad[:6]:
            print(f"         损坏: {tbl}.{col} id={rid}  {err}")
        if bad:
            sample = bad[0]
            con = sqlite3.connect(db)
            val = con.execute(
                f"SELECT {sample[1]} FROM {sample[0]} WHERE id=?", (sample[2],)
            ).fetchone()[0]
            con.close()
            pos = 0
            try:
                pos = int(err_col := sample[3].split("column ")[1].split(" ")[0])
            except Exception:
                pos = 0
            lo = max(0, pos - 40)
            print(f"         损坏处上下文: ...{val[lo:pos + 25]!r}")
            print("         （脱敏正则 \\b[A-Z0-9]{14,}\\b 命中了浮点数字面量的尾数，"
                  "把 24.218338859221145 换成了 24.DEMO-SERIAL）")

        # ---- 2b. 脱敏不能回退（复用 tools/scan_seed_db 的同一套规则）----
        sys.path.insert(0, os.path.join(ROOT, "tools"))
        try:
            import sensitive_patterns as sp
            pats = sp.load()
            con = sqlite3.connect(db)
            hits = []
            for (tbl,) in con.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            ).fetchall():
                cols = [r[1] for r in con.execute(f"PRAGMA table_info({tbl})").fetchall()]
                for col in cols:
                    for (val,) in con.execute(
                        f"SELECT {col} FROM {tbl}"
                    ).fetchall():
                        if not isinstance(val, str) or not val:
                            continue
                        for label, rx in pats:
                            m = rx.search(val)
                            if m:
                                hits.append((tbl, col, label, m.group(0)[:40]))
            con.close()
            check("敏感规则 0 命中", not hits,
                  f"{len(hits)} 处" + (f" 例:{hits[0]}" if hits else ""))

            # ---- 2c. 字节层：删/改过的 free page 里也可能留着旧值 ----
            #      SQL 全绿但二进制能 grep 出来，就是 2026-10-28 那次的情形。
            raw = open(db, "rb").read().decode("utf-8", errors="replace")
            bhits = [(label, rx.search(raw).group(0)[:40])
                     for label, rx in pats if rx.search(raw)]
            check("敏感规则字节层 0 命中（含 free page）", not bhits,
                  f"{len(bhits)} 处" + (f" 例:{bhits[0]}" if bhits else "")
                  + f"｜文件 {len(raw)} B")
        except Exception as e:
            check("敏感规则复扫", False, f"{type(e).__name__}: {e}")

        # ---- 3. 演示数据在界面上真的有数 ----
        #     summary 坏掉时 parse_summary_dict 静默返回 {}，列表看起来是空的
        con = sqlite3.connect(db)
        runs = con.execute(
            "SELECT id, summary FROM test_runs ORDER BY id LIMIT 20").fetchall()
        con.close()
        blank = []
        for rid, sm in runs:
            try:
                d = json.loads(sm) if isinstance(sm, str) and sm.strip() else {}
            except Exception:
                d = {}
            if not d:
                blank.append(rid)
        check("演示记录的概览可解析（看板列表有均值）",
              len(blank) == 0, f"空白记录 id={blank[:12]}")

        # ---- 4. 走真实服务：详情接口不能 500 ----
        if port is not None:
            st, body = http(port, "/api/tests?page_size=50", uid="perfara123")
            ids = []
            if st == 200:
                try:
                    ids = [it["id"] for it in json.loads(body)["items"]]
                except Exception:
                    pass
            check("演示账号可取测试列表", st == 200 and len(ids) > 0, f"{st} n={len(ids)}")
            code500 = []
            for tid in ids:
                s2, _ = http(port, f"/api/tests/{tid}", uid="perfara123")
                if s2 == 500:
                    code500.append(tid)
            check("每条演示记录详情可打开", not code500, f"500 的 id={code500}")
            # 趋势图（依赖 summary）
            st3, b3 = http(port, "/api/tests/distinct-app-names", uid="perfara123")
            check("项目名称下拉可用", st3 == 200, f"{st3}")
        else:
            # 无服务时用 backend 的序列化路径直接复现
            sys.path.insert(0, BACKEND_PKG)
            tmp = tempfile.mkdtemp(prefix="seedint_srv_")
            os.environ["WEB_PERF_DB"] = os.path.join(tmp, "t.db")
            os.environ["PERFARA_HOME"] = tmp
            shutil.copy(db, os.environ["WEB_PERF_DB"])
            try:
                from backend.database import SessionLocal  # noqa
                from backend.models import TestRun  # noqa
                from backend.schemas import TestRunDetailOut  # noqa
                db_session = SessionLocal()
                t = db_session.query(TestRun).first()
                if t is None:
                    check("库内有测试记录", False, "空库")
                else:
                    try:
                        blobs = sorted(t.metric_blobs or [], key=lambda b: b.id)
                        TestRunDetailOut.from_orm_and_blobs(t, blobs)
                        check("详情序列化未崩溃", True)
                    except Exception as e:
                        check("详情序列化未崩溃", False, f"{type(e).__name__}: {e}")
                db_session.close()
            except Exception as e:
                check("离线复现详情序列化", False, f"{type(e).__name__}: {e}")
            finally:
                # SQLAlchemy 的连接池会一直持有 t.db 的句柄，不 dispose 则 Windows 删不掉。
                try:
                    from backend.database import engine as _engine
                    _engine.dispose()
                except Exception:
                    pass
                for _ in range(6):
                    shutil.rmtree(tmp, ignore_errors=True)
                    if not os.path.exists(tmp):
                        break
                    time.sleep(0.3)
    finally:
        if proc is not None:
            kill_tree(proc.pid)
            try:
                proc.wait(timeout=10)
            except Exception:
                proc.kill()
        if home is not None:
            time.sleep(0.5)
            shutil.rmtree(home, ignore_errors=True)

    p = sum(1 for _, ok, _ in results if ok)
    f = len(results) - p
    print(f"\n===== {p} PASS / {f} FAIL =====")
    for name, ok, detail in results:
        if not ok:
            print(f"  FAIL: {name}  {detail}")
    return 0 if f == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
