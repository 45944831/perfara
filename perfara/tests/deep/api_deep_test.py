#!/usr/bin/env python3
"""后端 API 全面深度测试（隔离临时库 + 自管临时服务，不碰 perfara/data/webperf.db）。

覆盖：静态资源/MIME、鉴权矩阵、上传（正常/畸形/超大/去重）、列表分页与过滤、
趋势、详情与分享令牌、改名/删除、别名、chart-configs、reparse、路径穿越、
CORS、并发。每条断言打印 PASS/FAIL，任一 FAIL 则退出码非 0。

用法（用带 fastapi/uvicorn 的解释器）：
    tools/.venv/Scripts/python.exe perfara/tests/deep/api_deep_test.py [port]
"""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
PERFARA = os.path.abspath(os.path.join(HERE, "..", ".."))
REPO = os.path.abspath(os.path.join(PERFARA, ".."))

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8137
BASE = f"http://127.0.0.1:{PORT}"
TIMEOUT = 60

RESULTS = []
SERVER = None
TMP = None

GROUP = ""


def check(name, cond, detail=""):
    ok = bool(cond)
    RESULTS.append((GROUP, name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {GROUP} / {name}" + (("" if ok else f"  ->  {detail}") or ""))
    return ok


def section(title):
    global GROUP
    GROUP = title
    print(f"\n--- {title} ---", flush=True)


def call(method, path, params=None, body=None, headers=None, timeout=TIMEOUT):
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    # 注意：uvicorn 下发的响应头是小写的，这里统一按小写取，避免误判成「头缺失」。
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, {k.lower(): v for k, v in dict(r.headers).items()}, r.read()
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in dict(e.headers).items()}, e.read()
    except Exception as e:
        return 0, {}, str(e).encode("utf-8", "replace")


def jcall(method, path, params=None, body=None, headers=None):
    st, hd, raw = call(method, path, params, body, headers)
    try:
        return st, hd, json.loads(raw.decode("utf-8", "replace"))
    except Exception:
        return st, hd, None


def multipart(fields, filename=None, filebytes=b"", ctype="application/json", boundary=None):
    boundary = boundary or "----perfaraDeepBoundary"
    out = []
    for k, v in fields.items():
        out.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode("utf-8")
        )
    if filename is not None:
        out.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
            f"Content-Type: {ctype}\r\n\r\n".encode("utf-8") + filebytes + b"\r\n"
        )
    out.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(out), {"Content-Type": f"multipart/form-data; boundary={boundary}"}


def upload(payload_bytes, uid="deepuser", para1=None, para2=None, filename="t.json", fields=None):
    f = {"uid": uid}
    if para1 is not None:
        f["para1"] = para1
    if para2 is not None:
        f["para2"] = para2
    if fields:
        f.update(fields)
    body, hd = multipart(f, filename, payload_bytes)
    return jcall("POST", "/api/upload", body=body, headers=hd)


def make_payload(pkg="com.example.deepapp", app="DeepApp", n=8, fps=60.0, ts0=1761600000000,
                 category="android", label="deep-label"):
    perf = []
    for i in range(n):
        perf.append({
            "timestamp": ts0 + i * 1000,
            "fps": fps,
            "jank": i % 3,
            "big_jank": 0,
            "small_jank": i % 2,
            "tiny_jank": i % 5,
            "stutter": 0.5,
            "cpuUsage": 20.0 + i,
            "cpuTotalSystem": 40.0 + i,
            "memory": 300000000 + i * 1000,
            "javaHeap": 20000000,
            "temperature": 300 + i,
            "battery": {"level": 80, "temperature": 305, "currentNow": 400000, "voltage": 4200},
            "gpuUsage": 55.0,
            "netUp": 100,
            "netDown": 200,
        })
    return {
        "device": {"name": "DeepDev", "model": "generic", "brand": "generic",
                   "bundleId": pkg, "appName": app, "category": category, "osVersion": "13"},
        "label": label,
        "perf": perf,
    }


def start_server():
    global SERVER, TMP
    TMP = tempfile.mkdtemp(prefix="perfara_deep_")
    db = os.path.join(TMP, "deep.db")
    env = dict(os.environ)
    env["WEB_PERF_DB"] = db
    env["PERFARA_HOME"] = TMP
    env["PYTHONIOENCODING"] = "utf-8"
    log = open(os.path.join(TMP, "server.log"), "wb")
    SERVER = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "backend.app:app",
         "--host", "127.0.0.1", "--port", str(PORT), "--log-level", "warning",
         # 与 launcher.py 的 Config(server_header=False) 对齐：不加这个开关，
         # uvicorn 默认会下发 Server 头，下面「未回显框架头」那条断言测的就不是真实启动形态。
         "--no-server-header"],
        cwd=PERFARA, env=env, stdout=log, stderr=subprocess.STDOUT)
    for _ in range(80):
        try:
            st, _, raw = call("GET", "/api/health", timeout=3)
            if st == 200:
                return json.loads(raw.decode())
        except Exception:
            pass
        if SERVER.poll() is not None:
            raise SystemExit(f"服务提前退出 exit={SERVER.returncode}，日志见 {os.path.join(TMP,'server.log')}")
        time.sleep(0.25)
    raise SystemExit("服务启动超时")


def rmtree_retry(path):
    """Windows 上服务刚退出时文件句柄可能还挂着，一次性 rmtree 会留下半截目录。"""
    for _ in range(6):
        shutil.rmtree(path, ignore_errors=True)
        if not os.path.exists(path):
            return
        time.sleep(0.3)


def stop_server():
    if SERVER and SERVER.poll() is None:
        SERVER.terminate()
        try:
            SERVER.wait(timeout=15)
        except Exception:
            SERVER.kill()


def dbq(sql, args=()):
    p = os.path.join(TMP, "deep.db")
    con = sqlite3.connect(p, timeout=15)
    try:
        return con.execute(sql, args).fetchall()
    finally:
        con.close()


def main():
    info = start_server()
    print(f"server up: {info}  base={BASE}")
    try:
        run_tests()
    finally:
        stop_server()

    total = len(RESULTS)
    fails = [r for r in RESULTS if not r[2]]
    print("\n" + "=" * 62)
    print(f"合计 {total} 项，PASS {total - len(fails)}，FAIL {len(fails)}")
    for g, n, _, d in fails:
        print(f"  FAIL  {g} / {n}   {d}")
    print("=" * 62)
    if os.environ.get("KEEP_TMP") != "1":
        rmtree_retry(TMP)
    else:
        print(f"临时目录保留：{TMP}")
    return 1 if fails else 0


def run_tests():
    # ---------- 1. 健康检查与静态资源 ----------
    section("01 健康检查/静态资源")
    st, hd, b = call("GET", "/api/health")
    check("GET /api/health 200", st == 200, f"{st} {b[:200]!r}")
    check("health 带版本号", b'"version"' in b, b[:200].decode("utf-8", "replace"))
    check("响应未回显 server/x-powered-by 框架头", "server" not in hd and "x-powered-by" not in hd,
          f"headers={sorted(hd)}")

    st, hd, b = call("GET", "/")
    check("GET / 返回 SPA index", st == 200 and (b"<div id=\"app\"" in b or "text/html" in hd.get("content-type", "")),
          f"{st} {hd.get('content-type')} {b[:120]!r}")

    assets = os.path.join(PERFARA, "frontend", "dist", "assets")
    js_names = sorted(f for f in os.listdir(assets) if f.endswith(".js")) if os.path.isdir(assets) else []
    if js_names:
        st, hd, _ = call("GET", "/assets/" + js_names[0], headers={"Accept-Encoding": "gzip"})
        ct = hd.get("content-type", "")
        check("首屏 JS 的 MIME 不是 text/plain", st == 200 and ("javascript" in ct or "ecmascript" in ct),
              f"{st} {ct!r}")
        check("大 JS 走 GZip", "gzip" in hd.get("content-encoding", "").lower(),
              f"content-encoding={hd.get('content-encoding')!r}")
    else:
        check("前端 dist 资源存在", False, f"{assets} 为空")

    st, hd, b = call("GET", "/api/definitely-not-a-route")
    check("未知 /api/* 返回 404 而非 SPA 兜底", st == 404, f"{st} {b[:150]!r}")
    st, hd, b = call("GET", "/api/tests/distinct-labels")
    check("/api/tests/distinct-labels 未被 {test_id} 吞掉", st != 422, f"{st} {b[:150]!r}")

    # ---------- 2. 鉴权矩阵 ----------
    section("02 鉴权矩阵")
    st, hd, b = call("GET", "/api/projects")
    check("无 uid 请求 /api/projects 被拒", st == 400, f"{st} {b[:200]!r}")
    check("无 uid 的错误码语义（应为 401/403，实为 400）", st == 400, "语义待产品确认：400 混淆了参数错误与未授权")

    st, _, b = call("GET", "/api/tests", {"uid": ""})
    check("空 uid 被拒", st == 400, f"{st} {b[:200]!r}")

    p = make_payload(label="auth-probe")
    st, _, r = upload(json.dumps(p).encode(), uid="alice")
    check("alice 上传成功", st == 200 and r and r.get("id"), f"{st} {r}")
    alice_id = (r or {}).get("id")

    st, _, r2 = jcall("GET", "/api/tests", {"uid": "alice"})
    check("alice 能看自己的记录", st == 200 and any(x["id"] == alice_id for x in (r2 or {}).get("items", [])), f"{st}")
    st, _, r3 = jcall("GET", "/api/tests", {"uid": "bob"})
    check("bob 看不到 alice 的记录", st == 200 and all(x["id"] != alice_id for x in (r3 or {}).get("items", [])),
          f"{st} {[x['id'] for x in (r3 or {}).get('items', [])][:5]}")
    st, _, r4 = jcall("GET", "/api/tests", {"uid": "WonderXu"})
    check("超管（大小写不敏感）能看到全部", st == 200 and any(x["id"] == alice_id for x in (r4 or {}).get("items", [])), f"{st}")

    st, _, _ = jcall("GET", "/api/tests", {}, headers={"X-WebPerf-Uid": "alice"})
    check("头 X-WebPerf-Uid 可用", st == 200, f"{st}")
    st, _, _ = jcall("GET", "/api/tests", {}, headers={"X-Uid": "alice"})
    check("头 X-Uid 可用", st == 200, f"{st}")
    st, _, _ = jcall("GET", "/api/tests", {"uid": "alice "})
    check("uid 带空格被 strip 后仍可用", st == 200, f"{st}")

    # ---------- 3. 上传 ----------
    section("03 上传")
    st, _, r = upload(b"not json at all", uid="alice")
    check("非 JSON 内容 400 invalid_json", st == 400 and r and str(r.get("detail", "")).find("invalid_json") >= 0, f"{st} {r}")
    st, _, r = upload("中文非法JSON{".encode("utf-8"), uid="alice")
    check("坏 JSON（UTF-8）仍归为 400", st == 400, f"{st} {r}")
    st, _, r = upload(b"\xff\xfe\x00\x01binary", uid="alice", filename="x.json")
    check("非 UTF-8 字节 400 decode_error", st == 400 and r and "decode" in str(r.get("detail", "")).lower(), f"{st} {r}")
    st, _, r = upload(b"{}", uid="alice", filename="report.txt")
    check("非 .json 文件名被拒 400", st == 400, f"{st} {r}")
    st, _, r = upload(b"{}", uid="alice")
    check("空对象 {} 400（schema 校验）", st == 400, f"{st} {r}")
    st, _, r = upload(b"[]", uid="alice")
    check("顶层数组不崩成 500", st == 400, f"{st} {r}")
    st, _, r = upload(b'"just a string"', uid="alice")
    check("顶层字符串不崩成 500", st == 400, f"{st} {r}")
    st, _, r = upload(b"12345", uid="alice")
    check("顶层数字不崩成 500", st == 400, f"{st} {r}")

    bad = {"device": {"category": "android", "bundleId": "com.x"}, "perf": []}
    st, _, r = upload(json.dumps(bad).encode(), uid="alice")
    check("perf 空数组 400", st == 400, f"{st} {r}")
    bad2 = {"device": {"category": "nintendo", "bundleId": "com.x"}, "perf": [{"timestamp": 1}]}
    st, _, r = upload(json.dumps(bad2).encode(), uid="alice")
    check("未知 category 400", st == 400, f"{st} {r}")
    bad3 = {"device": {"category": "android", "bundleId": "com.x"}, "perf": [{"fps": 30}]}
    st, _, r = upload(json.dumps(bad3).encode(), uid="alice")
    check("缺 timestamp 400", st == 400, f"{st} {r}")
    bad4 = make_payload(label="tagbad")
    bad4["tag"] = [[0, 999]]
    st, _, r = upload(json.dumps(bad4).encode(), uid="alice")
    check("tag 越界 400", st == 400, f"{st} {r}")

    nsc = {"device": {"category": "android", "bundleId": {"a": 1}}, "perf": [{"timestamp": 1761600000000, "fps": 30}]}
    st, _, r = upload(json.dumps(nsc).encode(), uid="alice")
    check("bundleId 传 dict 不出现 500", st != 500, f"{st} {r}")
    nsc2 = {"device": {"category": "android", "bundleId": "com.x", "name": ["a", "b"]},
            "perf": [{"timestamp": 1761600000000, "fps": 30}]}
    st, _, r = upload(json.dumps(nsc2).encode(), uid="alice")
    check("device.name 传 list 不出现 500", st != 500, f"{st} {str(r)[:300]}")
    st, _, r = upload(json.dumps(nsc2).encode(), uid="deep2")
    check("入库失败的回错不回显 SQL 语句与绑定参数",
          "INSERT INTO" not in str(r) and "[SQL:" not in str(r) and "[parameters:" not in str(r),
          f"{st} {str(r)[:400]}")
    scalar_bat = make_payload(pkg="com.example.scalarken", app="ScalarKen", label="scalar-battery")
    scalar_bat["perf"][0]["battery"] = 80
    st, _, r = upload(json.dumps(scalar_bat).encode(), uid="alice")
    check("battery 传标量归为 400（不 500）", st == 400, f"{st} {str(r)[:200]}")
    check("解析类错误不回显内部异常类名", "AttributeError" not in str(r), f"{st} {str(r)[:250]}")

    st, _, r = upload(json.dumps(make_payload(label="demo-try")).encode(), uid="perfara123")
    check("演示账号上传 403", st == 403, f"{st} {r}")
    st, _, r = upload(json.dumps(make_payload(label="nouid")).encode(), uid="")
    check("无 uid 上传 400", st == 400, f"{st} {r}")

    pl = json.dumps(make_payload(pkg="com.example.jsonbody", app="JsonBody", label="jsonbody-probe")).encode()
    st, _, r = jcall("POST", "/api/upload", {"uid": "alice", "para2": "jb"}, body=pl,
                     headers={"Content-Type": "application/json"})
    check("裸 JSON body + 查询 uid 可上传", st == 200 and r and r.get("id"), f"{st} {r}")
    jb_id = (r or {}).get("id")

    body, hd = multipart({"uid": "alice"}, filename="broken.json", filebytes=b"{}")
    body = body[: len(body) - 20]
    st, _, r = jcall("POST", "/api/upload", body=body, headers=hd)
    check("被截断的 multipart 不出现 500", st != 500, f"{st} {str(r)[:200]}")

    st, _, r = jcall("POST", "/api/upload", {"uid": "alice"}, body=b"{oops",
                     headers={"Content-Type": "application/json"})
    check("裸 JSON body 语法错 400", st == 400, f"{st} {r}")

    body, hd = multipart({"uid": "alice", "para1": "p1only"}, filename="t.json",
                         filebytes=json.dumps(make_payload(pkg="com.example.p1only", app="P1Only", label="p1-only")).encode())
    body = body.replace(b'Content-Disposition: form-data; name="file"',
                        b'Content-Disposition: form-data; name="upload"')
    st, _, r = jcall("POST", "/api/upload", body=body, headers=hd)
    check("缺 file 字段的 multipart 400", st == 400, f"{st} {r}")

    # 去重
    dup = json.dumps(make_payload(pkg="com.example.dup", app="Dup", label="dup")).encode()
    st1, _, r1 = upload(dup, uid="alice")
    st2, _, r2 = upload(dup, uid="alice")
    check("相同内容重复上传命中去重", st1 == 200 and st2 == 200 and r1 and r2 and r1.get("id") == r2.get("id"),
          f"{r1.get('id') if r1 else st1} vs {r2.get('id') if r2 else st2}")
    st3, _, r3 = upload(dup, uid="alice", para2="other")
    check("同内容不同 para2 记为新记录", st3 == 200 and r3 and r3.get("id") != r1.get("id"),
          f"{r3.get('id') if r3 else st3} vs {r1.get('id')}")

    # 超大 payload
    big = json.dumps(make_payload(pkg="com.example.big", app="BigRun", n=20000, label="big")).encode()
    t0 = time.time()
    st, _, r = upload(big, uid="alice")
    dt = time.time() - t0
    check("20000 点大载荷上传成功", st == 200 and r and r.get("id"), f"{st} {str(r)[:200]}")
    check("大载荷上传耗时 < 30s", dt < 30, f"{dt:.2f}s")
    big_id = (r or {}).get("id")

    # metricConfig
    mc = make_payload(pkg="com.example.mc", app="McApp", label="mc-off")
    mc["metricConfig"] = {"fps": False, "cpu": True}
    st, _, r = upload(json.dumps(mc).encode(), uid="alice")
    check("带 metricConfig 上传成功", st == 200 and r and r.get("id"), f"{st} {r}")
    mc_id = (r or {}).get("id")
    if mc_id:
        st, _, d = jcall("GET", f"/api/tests/{mc_id}", {"uid": "alice"})
        raw = (d or {}).get("test_raw") or {}
        items = raw.get("perf") or [{}]
        check("metricConfig 关闭 fps 后 test_raw 已剔除 fps", "fps" not in (items[0] if items else {}),
              f"keys={sorted((items[0] if items else {}).keys())[:12]}")

    # ---------- 4. 项目 / 列表 / 过滤 ----------
    section("04 项目与列表")
    st, _, r = jcall("GET", "/api/projects", {"uid": "alice"})
    check("/api/projects 200 且为数组", st == 200 and isinstance(r, list) and len(r) > 0, f"{st}")
    st, _, r = jcall("GET", "/api/projects", {"uid": "alice", "q": "com.example.deepapp"})
    check("q 精确子串过滤可用", st == 200, f"{st} {str(r)[:200]}")
    st, _, r_all = jcall("GET", "/api/projects", {"uid": "alice"})
    st, _, r_wild = jcall("GET", "/api/projects", {"uid": "alice", "q": "%"})
    check("q=% 按字面匹配，不再当 LIKE 通配符（D8 已修）",
          st == 200 and len(r_wild) == 0 and len(r_all) > 0,
          f"q=% 返回 {len(r_wild)}，全部 {len(r_all)} —— 期望 % 被转义后匹配 0 条")
    st, _, r = jcall("GET", "/api/projects", {"uid": "alice", "q": "'; DROP TABLE projects; --"})
    check("q 注入不改变结果且不报错", st == 200, f"{st} {str(r)[:150]}")
    n = dbq("SELECT count(*) FROM projects")[0][0]
    check("q 注入后 projects 表完好", n > 0, f"count={n}")

    st, _, r = jcall("GET", "/api/tests", {"uid": "alice", "page": 0})
    check("page=0 校验拒绝（422）", st == 422, f"{st}")
    st, _, r = jcall("GET", "/api/tests", {"uid": "alice", "page_size": 0})
    check("page_size=0 校验拒绝（422）", st == 422, f"{st}")
    st, _, r = jcall("GET", "/api/tests", {"uid": "alice", "page_size": 1001})
    check("page_size=1001 校验拒绝（422）", st == 422, f"{st}")
    st, _, r = jcall("GET", "/api/tests", {"uid": "alice", "page_size": 1000})
    check("page_size=1000 被内部钳制为 200", st == 200 and r and r.get("page_size") == 200,
          f"page_size={ (r or {}).get('page_size') }")
    st, _, r = jcall("GET", "/api/tests", {"uid": "alice", "page": 999999})
    check("超大页码返回空列表而非 500", st == 200 and isinstance((r or {}).get("items"), list) and (r or {}).get("items") == [],
          f"{st} items={len((r or {}).get('items', []))}")
    st, _, r = jcall("GET", "/api/tests", {"uid": "alice", "project_id": 2 ** 63})
    check("project_id 超 int64 不泄漏 500", st in (400, 422), f"{st} {str(r)[:150]}")
    st, _, r = jcall("GET", "/api/tests", {"uid": "alice", "project_id": -1})
    check("project_id=-1 返回空而非全量", st == 200 and (r or {}).get("total") in (0, None),
          f"total={(r or {}).get('total')}")

    st, _, all_alice = jcall("GET", "/api/tests", {"uid": "alice", "page_size": 200})
    real_pid = next((x["project_id"] for x in all_alice["items"] if x["id"] == alice_id), None)
    st, _, r = jcall("GET", "/api/tests", {"uid": "wonderxu", "project_id": real_pid})
    check("按真实 project_id 过滤命中", st == 200 and any(x["id"] == alice_id for x in (r or {}).get("items", [])), f"{st}")
    st, _, r0 = jcall("GET", "/api/tests", {"uid": "wonderxu", "project_id": 0})
    check("project_id=0 按真实过滤，不再当未传（D6 已修）",
          st == 200 and (r0 or {}).get("total") in (0, None)
          and not any(x["id"] == alice_id for x in (r0 or {}).get("items", [])),
          f"total={(r0 or {}).get('total')} —— 期望：0 不返回全部记录")

    st, _, r = jcall("GET", "/api/tests", {"uid": "alice", "date_from": "2020-01-01", "date_to": "2030-01-01"})
    check("正常日期区间可用", st == 200, f"{st} {str(r)[:150]}")
    st, _, r = jcall("GET", "/api/tests", {"uid": "alice", "date_to": "garbage"})
    check("date_to=垃圾串不出现 500", st != 500, f"{st} {str(r)[:200]}")
    st, _, r = jcall("GET", "/api/tests", {"uid": "alice", "date_from": "2026-1-1"})
    check("日期不补零（2026-1-1）行为", st in (200, 400, 422), f"{st} {str(r)[:150]}")
    st, _, r = jcall("GET", "/api/tests", {"uid": "alice", "date_from": "2030-01-01", "date_to": "2020-01-01"})
    check("date_from>date_to 返回空", st == 200 and (r or {}).get("total") == 0, f"{st} total={(r or {}).get('total')}")

    # ---------- 5. distinct / trend ----------
    section("05 维度与趋势")
    st, _, dl = upload(json.dumps(make_payload(label="deep-label", ts0=1761610000000)).encode(), uid="alice")
    check("预置 deep-label 记录", st == 200 and dl and dl.get("id"), f"{st} {str(dl)[:150]}")
    st, _, dl2 = upload(json.dumps(make_payload(label="deep-label", n=12, ts0=1761620000000)).encode(),
                        uid="alice", para2="run2")
    check("预置 deep-label 第二条（趋势至少 2 点）", st == 200 and dl2 and dl2.get("id"), f"{st} {str(dl2)[:150]}")
    st, _, r = jcall("GET", "/api/tests/distinct-labels", {"uid": "alice"})
    check("distinct-labels 返回含 deep-label", st == 200 and isinstance(r, list) and "deep-label" in r, f"{st} {str(r)[:200]}")
    st, _, r = jcall("GET", "/api/tests/distinct-app-names", {"uid": "alice"})
    check("distinct-app-names 含 DeepApp", st == 200 and "DeepApp" in (r or []), f"{st} {str(r)[:200]}")
    st, _, r = jcall("GET", "/api/tests/distinct-labels-for-app",
                     {"uid": "alice", "category": "android", "project_name": "DeepApp"})
    check("distinct-labels-for-app 正常", st == 200 and isinstance(r, list) and "deep-label" in (r or []),
          f"{st} {str(r)[:200]}")
    st, _, r = jcall("GET", "/api/tests/distinct-labels-for-app", {"uid": "alice", "category": "nintendo"})
    check("distinct-labels-for-app 非法 category 400", st == 400, f"{st} {str(r)[:150]}")
    st, _, r = jcall("GET", "/api/tests/distinct-labels-for-app", {"uid": "alice"})
    check("缺 category 参数被拒", st == 422, f"{st}")

    TN = {"uid": "alice", "label": "deep-label", "category": "android", "project_name": "DeepApp"}
    st, _, r = jcall("GET", "/api/tests/trend", TN)
    check("trend 返回点位", st == 200 and r and len(r.get("points", [])) >= 1, f"{st} {str(r)[:200]}")
    if r and r.get("points"):
        p0 = r["points"][0]
        check("趋势点带 means 与 peaks", "means" in p0 and "peaks" in p0, str(list(p0.keys())))
        check("趋势均值含 fpsAvg", (p0.get("means") or {}).get("fpsAvg") is not None, str(p0.get("means"))[:200])
    st, _, r = jcall("GET", "/api/tests/trend", {"uid": "alice", "category": "android", "project_name": "DeepApp"})
    check("trend 缺 label 被拒", st == 422, f"{st}")
    st, _, r = jcall("GET", "/api/tests/trend", {"uid": "alice", "label": "deep-label", "category": "android"})
    check("trend 缺 project_name 归为 400（必填语义，记录）", st == 400, f"{st} {str(r)[:150]}")
    st, _, r = jcall("GET", "/api/tests/trend", dict(TN, category="bad"))
    check("trend 非法 category 400", st == 400, f"{st}")
    st, _, r = jcall("GET", "/api/tests/trend", dict(TN, limit=5000))
    check("trend limit=5000 钳制为 300 以内", st == 200 and len((r or {}).get("points", [])) <= 300, f"{st}")
    st, _, r = jcall("GET", "/api/tests/trend", dict(TN, limit=0))
    check("trend limit=0 被拒 422", st == 422, f"{st}")
    st, _, r = jcall("GET", "/api/tests/trend", dict(TN, label="no-such-label-xyz"))
    check("不存在 label 的 trend 返回空点集", st == 200 and (r or {}).get("points") == [], f"{st} {str(r)[:150]}")
    st, _, r = jcall("GET", "/api/tests/trend", dict(TN, project_name="不存在的项目名"))
    check("不存在项目名的 trend 返回空点集", st == 200 and (r or {}).get("points") == [], f"{st} {str(r)[:150]}")

    # 大 blob 的趋势端点耗时（性能）
    t0 = time.time()
    st, _, r = jcall("GET", "/api/tests/trend",
                     {"uid": "alice", "label": "big", "category": "android", "project_name": "BigRun"})
    dt = time.time() - t0
    check("20000 点记录的 trend 查询 < 10s", st == 200 and dt < 10, f"{st} {dt:.2f}s points={len((r or {}).get('points', []))}")

    # ---------- 6. 详情 / 分享 ----------
    section("06 详情与分享")
    st, _, d = jcall("GET", f"/api/tests/{alice_id}", {"uid": "alice"})
    check("owner 取详情 200", st == 200 and d and d.get("test", {}).get("id") == alice_id, f"{st}")
    check("详情含 blobs 与 project", d and isinstance(d.get("blobs"), list) and d.get("project") is not None, "")
    st, _, d = jcall("GET", f"/api/tests/{alice_id}", {"uid": "bob"})
    check("他人 uid 取详情 404（不泄漏存在性）", st == 404, f"{st}")
    st, _, d = jcall("GET", f"/api/tests/{alice_id}")
    check("无 uid 无 token 404", st == 404, f"{st}")
    st, _, d = jcall("GET", f"/api/tests/{alice_id}", {"uid": "wonderxu"})
    check("超管取任意详情 200", st == 200, f"{st}")

    _, _, d = jcall("GET", f"/api/tests/{alice_id}", {"uid": "alice"})
    real_token = (d or {}).get("test", {}).get("md5")
    check("详情返回随机分享令牌", isinstance(real_token, str) and real_token.startswith("t") and len(real_token) == 31,
          str(real_token))
    md5_id = __import__("hashlib").md5(str(alice_id).encode()).hexdigest()
    st, _, d = jcall("GET", f"/api/tests/{alice_id}", {"testid": md5_id})
    check("md5(id) 兜底令牌已不可匿名访问", st == 404, f"{st}")
    st, _, d = jcall("GET", f"/api/tests/{alice_id}", {"testid": real_token or "x"})
    check("随机令牌可匿名访问详情", st == 200, f"{st}")
    st, _, d = jcall("GET", f"/api/tests/{alice_id}", {"testid": "deadbeef" * 4})
    check("错误令牌 404", st == 404, f"{st}")
    st, _, d = jcall("GET", "/api/public/test", {"testid": real_token or "x"})
    check("/api/public/test 用随机令牌命中", st == 200 and d and d.get("test", {}).get("id") == alice_id, f"{st}")
    st, _, d = jcall("GET", "/api/public/test", {"testid": md5_id})
    check("/api/public/test 不再接受 md5(id)", st == 404, f"{st}")
    st, _, d = jcall("GET", "/api/public/test", {"testid": real_token or "x"})
    check("public 详情带 test_raw 全量数据", st == 200 and (d or {}).get("test_raw") is not None, f"{st}")
    check("public 详情不回传身份字段",
          (d or {}).get("test", {}).get("owner_uid") is None
          and (d or {}).get("test", {}).get("para1") is None
          and (d or {}).get("test", {}).get("para2") is None,
          str((d or {}).get("test"))[:160])
    st, _, d = jcall("GET", "/api/public/test")
    check("public 缺 testid 被拒", st in (400, 422), f"{st}")
    st, _, d = jcall("GET", "/api/tests/notanint", {"uid": "alice"})
    check("/api/tests/{非数字} 返回 422 而非 SPA 页", st == 422, f"{st}")
    st, _, d = jcall("GET", "/api/tests/999999999", {"uid": "alice"})
    check("不存在的 id 返回 404", st == 404, f"{st}")
    st, _, d = jcall("GET", f"/api/tests/{big_id}", {"uid": "alice"})
    check("详情包含大记录（raw_json 完整）", st == 200 and len(json.dumps((d or {}).get("test_raw") or {})) > 100000,
          f"raw_len={len(json.dumps((d or {}).get('test_raw') or {}))}")

    # ---------- 7. 改名 / 删除 ----------
    section("07 改名与删除")
    st, _, r = jcall("PATCH", f"/api/tests/{alice_id}/label", body=json.dumps({"label": "renamed-ok"}).encode(),
                     headers={"Content-Type": "application/json", "X-WebPerf-Uid": "alice"})
    check("owner 改名 200", st == 200 and r and r.get("label") == "renamed-ok", f"{st} {str(r)[:200]}")
    st, _, _ = jcall("GET", f"/api/tests/{alice_id}", {"uid": "alice"})
    st, _, r = jcall("PATCH", f"/api/tests/{alice_id}/label", body=json.dumps({"label": "hacker"}).encode(),
                     headers={"Content-Type": "application/json", "X-WebPerf-Uid": "bob"})
    check("他人改名 404", st == 404, f"{st}")
    st, _, r = jcall("PATCH", f"/api/tests/{alice_id}/label", body=json.dumps({"label": "demo"}).encode(),
                     headers={"Content-Type": "application/json", "X-WebPerf-Uid": "perfara123"})
    check("演示账号改名 403", st == 403, f"{st}")
    st, _, r = jcall("PATCH", f"/api/tests/{alice_id}/label", body=json.dumps({"label": "<script>alert(1)</script>"}).encode(),
                     headers={"Content-Type": "application/json", "X-WebPerf-Uid": "alice"})
    check("label 原样存储 HTML（后端不转义，前端负责）", st == 200 and r and r.get("label") == "<script>alert(1)</script>",
          f"{st} {r}")
    jcall("PATCH", f"/api/tests/{alice_id}/label", body=json.dumps({"label": "renamed-ok"}).encode(),
          headers={"Content-Type": "application/json", "X-WebPerf-Uid": "alice"})
    st, _, r = jcall("PATCH", f"/api/tests/{alice_id}/label", body=json.dumps({"label": "x" * 5000}).encode(),
                     headers={"Content-Type": "application/json", "X-WebPerf-Uid": "alice"})
    check("超长 label 的处理（应限长或明确报错，不得 500）", st != 500, f"{st} len={len((r or {}).get('label') or '')}")
    st, _, r = jcall("PATCH", f"/api/tests/{alice_id}/label", body=json.dumps({}).encode(),
                     headers={"Content-Type": "application/json", "X-WebPerf-Uid": "alice"})
    check("label 为 null 不报错", st in (200, 422), f"{st} {str(r)[:150]}")

    victim = upload(json.dumps(make_payload(pkg="com.example.todelete", app="ToDelete", label="del-me")).encode(),
                    uid="alice")[2]
    vid = (victim or {}).get("id")
    st, _, _ = jcall("DELETE", f"/api/tests/{vid}", headers={"X-WebPerf-Uid": "bob"})
    check("他人删除 404", st == 404, f"{st}")
    st, _, _ = jcall("DELETE", f"/api/tests/{vid}", headers={"X-WebPerf-Uid": "perfara123"})
    check("演示账号删除 403", st == 403, f"{st}")
    st, _, _ = jcall("DELETE", f"/api/tests/{vid}", headers={"X-WebPerf-Uid": "alice"})
    check("owner 删除 204", st == 204, f"{st}")
    st, _, _ = jcall("DELETE", f"/api/tests/{vid}", headers={"X-WebPerf-Uid": "alice"})
    check("重复删除 404", st == 404, f"{st}")
    time.sleep(0.3)
    orphan = dbq("SELECT count(*) FROM metric_blobs WHERE test_run_id = ?", (vid,))[0][0]
    check("删除记录后无 metric_blobs 孤儿行", orphan == 0, f"孤儿行数={orphan}")
    orphan_pi = dbq("SELECT count(*) FROM parsed_info WHERE test_run_id = ?", (vid,))[0][0]
    check("删除记录后无 parsed_info 孤儿行", orphan_pi == 0, f"孤儿行数={orphan_pi}")

    # ---------- 8. 别名 ----------
    section("08 项目别名")
    alias = [{"package_name": "com.example.alias", "app_name": "AliasApp", "display_name": "别名一"}]
    st, _, r = jcall("PUT", "/api/project-aliases", body=json.dumps(alias).encode(),
                     headers={"Content-Type": "application/json", "X-WebPerf-Uid": "alice"})
    check("PUT 别名 200", st == 200, f"{st} {str(r)[:200]}")
    st, _, r = jcall("PUT", "/api/project-aliases", body=json.dumps(alias).encode(),
                     headers={"Content-Type": "application/json", "X-WebPerf-Uid": "alice"})
    st, _, lst = jcall("GET", "/api/project-aliases", {"uid": "alice"})
    same = [x for x in (lst or []) if x.get("package_name") == "com.example.alias"]
    check("重复 PUT 同一别名不产生重复行", len(same) == 1, f"命中 {len(same)} 行")
    st, _, r = jcall("PUT", "/api/project-aliases", body=json.dumps([{"package_name": "x"}]).encode(),
                     headers={"Content-Type": "application/json", "X-WebPerf-Uid": "alice"})
    check("别名缺 display_name 被拒 422", st == 422, f"{st}")
    st, _, r = jcall("PUT", "/api/project-aliases", body=json.dumps(alias).encode(),
                     headers={"Content-Type": "application/json", "X-WebPerf-Uid": "perfara123"})
    check("演示账号写别名 403", st == 403, f"{st}")
    st, _, r = jcall("PUT", "/api/project-aliases", body=b"notjson",
                     headers={"Content-Type": "application/json", "X-WebPerf-Uid": "alice"})
    check("别名体非 JSON 不出现 500", st != 500, f"{st}")

    # 别名生效：上传时项目名用别名
    st, _, r = upload(json.dumps(make_payload(pkg="com.example.alias", app="AliasApp", label="via-alias")).encode(), uid="alice")
    st2, _, prj = jcall("GET", "/api/projects", {"uid": "alice", "q": "com.example.alias"})
    check("别名映射生效（display_name 命中）", any((p or {}).get("display_name") == "别名一" for p in (prj or [])),
          f"{st} {str(prj)[:200]}")

    # ---------- 9. chart-configs / with-info / infos ----------
    section("09 配置与派生信息")
    st, _, r = jcall("GET", "/api/chart-configs")
    check("chart-configs 免鉴权可读（记录行为）", st == 200 and isinstance(r, dict) and len(r) > 0, f"{st} {str(r)[:150]}")
    st, _, r = jcall("GET", "/api/projects/with-info", {"uid": "alice"})
    check("projects/with-info 返回结构", st == 200 and isinstance(r, list), f"{st}")
    pid = real_pid
    st, _, r = jcall("GET", f"/api/projects/{pid}/infos", {"uid": "alice", "limit": 5})
    check("projects/{id}/infos 返回快照", st == 200 and isinstance(r, list) and len(r) >= 1, f"{st} {str(r)[:200]}")
    st, _, r = jcall("GET", f"/api/projects/{pid}/infos", {"uid": "alice", "limit": 501})
    check("infos limit=501 被拒 422", st == 422, f"{st}")
    st, _, r = jcall("GET", "/api/projects/999999/infos", {"uid": "alice"})
    check("不存在项目的 infos 不报 500", st != 500, f"{st}")

    # ---------- 10. reparse ----------
    section("10 管理端 reparse")
    st, _, r = jcall("POST", "/api/admin/reparse", {"test_id": alice_id}, headers={"X-WebPerf-Uid": "alice"})
    check("reparse 指定 test_id 可用", st == 200 and r is not None, f"{st} {str(r)[:200]}")
    st, _, r = jcall("POST", "/api/admin/reparse", {"test_id": 0}, headers={"X-WebPerf-Uid": "alice"})
    check("reparse test_id=0 走单条分支，不再全量重解析（D7 已修）",
          st == 404 and (r or {}).get("total") is None,
          f"st={st} resp={str(r)[:200]} —— 若 st=200 且 total 为大值，说明 0 被当未传而走了全量重解析")
    bulk = jcall("POST", "/api/admin/reparse", {"limit": 100000}, headers={"X-WebPerf-Uid": "alice"})
    check("reparse limit 超界不 500", bulk[0] in (200, 422), f"{bulk[0]}")
    st, _, r = jcall("POST", "/api/admin/reparse", body=None, headers={"X-WebPerf-Uid": "perfara123"})
    check("演示账号 reparse 403", st == 403, f"{st}")
    st, _, r = jcall("POST", "/api/admin/reparse")
    check("无 uid reparse 被拒", st == 400, f"{st}")
    # reparse 之后记录仍可详情
    st, _, d = jcall("GET", f"/api/tests/{alice_id}", {"uid": "alice"})
    check("reparse 后记录仍可访问", st == 200, f"{st}")

    # ---------- 11. 路径穿越 / CORS ----------
    section("11 路径穿越与跨域")
    traversal = [
        "/../backend/app.py",
        "/..%2fbackend/app.py",
        "/..%2f..%2fREADME.md",
        "/%2e%2e/%2e%2e/perfara/backend/database.py",
        "/static/../../backend/app.py",
        "/" + ".." * 1,
    ]
    for t in traversal:
        st, hd, b = call("GET", t)
        leaked = b"SECRET" in b or b"WEB_PERF_DB" in b or b"create_engine" in b or b"wonderxu" in b
        check(f"穿越 {t} 未泄漏后端源码", not leaked, f"{st} {b[:120]!r}")
    st, hd, b = call("GET", "/%2e%2e%2f%2e%2e%2fWindows/win.ini")
    check("穿越到系统盘 win.ini 被拒", st != 200 or b"[fonts]" not in b, f"{st} {b[:120]!r}")
    st, hd, b = call("GET", "/data/webperf.db")
    check("数据库文件不可经 HTTP 下载", st != 200 or b"SQLite format 3" not in b, f"{st} {b[:80]!r}")
    st, hd, b = call("GET", "/../requirements.txt")
    check("穿越到上级 requirements.txt 未被读出", b"fastapi" not in b, f"{st} {b[:120]!r}")

    # startswith 前缀守卫的绕过：与 dist 同层、名字以 "dist" 开头的目录可被穿越命中
    dist_dir = os.path.join(PERFARA, "frontend", "dist")
    sib = dist_dir + "_probe"
    os.makedirs(sib, exist_ok=True)
    marker = os.path.join(sib, "zz-marker.txt")
    with open(marker, "w", encoding="utf-8") as fh:
        fh.write("PERFARA-PREFIX-GUARD-PROBE")
    try:
        st, hd, b = call("GET", "/../dist_probe/zz-marker.txt")
        check("同层 dist* 目录不可经穿越读取（startswith 守卫）", b"PERFARA-PREFIX-GUARD-PROBE" not in b,
              f"{st} {b[:120]!r}")
    finally:
        os.remove(marker)
        os.rmdir(sib)

    st, hd, _ = call("GET", "/api/health", headers={"Origin": "http://evil.example.com"})
    acao = hd.get("access-control-allow-origin")
    check("非白名单 Origin 不回显 ACAO", acao is None, f"ACAO={acao!r}")
    st, hd, _ = call("GET", "/api/health", headers={"Origin": "http://127.0.0.1:5173"})
    check("白名单 Origin 正常放行", hd.get("access-control-allow-origin") == "http://127.0.0.1:5173",
          f"ACAO={hd.get('access-control-allow-origin')!r}")
    st, hd, _ = call("OPTIONS", "/api/upload", headers={"Origin": "http://evil.example.com",
                                                        "Access-Control-Request-Method": "POST"})
    check("跨域预检不放行任意 Origin", hd.get("access-control-allow-origin") in (None, ""),
          f"{st} ACAO={hd.get('access-control-allow-origin')!r}")

    # ---------- 12. 并发 ----------
    section("12 并发与稳定性")
    def one_upload(i):
        pl = json.dumps(make_payload(pkg=f"com.example.conc{i}", app=f"Conc{i}", label=f"conc-{i}",
                                     ts0=1761600000000 + i * 100000)).encode()
        return upload(pl, uid="concur")

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=16) as ex:
        outs = list(ex.map(one_upload, range(32)))
    dt = time.time() - t0
    codes = [o[0] for o in outs]
    check("32 路并发上传全部成功", all(c == 200 for c in codes), f"状态分布={sorted(set(codes))} 明细={codes[:8]}")
    check("并发上传耗时 < 60s", dt < 60, f"{dt:.2f}s")
    ids = [ (o[2] or {}).get("id") for o in outs if o[2] ]
    check("并发上传 id 无重复分配", len(ids) == len(set(ids)), f"{len(ids)} 条 / 去重 {len(set(ids))}")

    same_pl = json.dumps(make_payload(pkg="com.example.race", app="Race", label="race", ts0=1761700000000)).encode()
    with ThreadPoolExecutor(max_workers=12) as ex:
        routs = list(ex.map(lambda _i: upload(same_pl, uid="race"), range(12)))
    rids = [ (o[2] or {}).get("id") for o in routs if o[2] ]
    check("同一内容并发上传不产生重复记录（去重竞态）", len(set(rids)) == 1,
          f"并发 12 次得到 {len(set(rids))} 个不同 id：{sorted(set(rids))}")

    def reader(i):
        return jcall("GET", "/api/tests", {"uid": "concur", "page_size": 50})[0]

    with ThreadPoolExecutor(max_workers=8) as ex:
        codes2 = list(ex.map(reader, range(40)))
    check("写并发期间读不失败", all(c == 200 for c in codes2), f"{sorted(set(codes2))}")

    lock_err = dbq("PRAGMA integrity_check")[0][0]
    check("数据库完整性检查 ok", lock_err == "ok", str(lock_err))

    srvlog = os.path.join(TMP, "server.log")
    txt = ""
    try:
        txt = open(srvlog, "rb").read().decode("utf-8", "replace")
    except Exception:
        pass
    check("服务端日志无 Traceback", "Traceback" not in txt, txt[-600:].replace("\n", " | "))

    # ---------- 13. 演示账号隔离 ----------
    section("13 演示账号与空快照")
    st, _, r = jcall("GET", "/api/tests", {"uid": "perfara123"})
    check("演示账号（空快照）列表为空而非报错", st == 200 and (r or {}).get("total") == 0, f"{st} total={(r or {}).get('total')}")
    st, _, r = jcall("GET", f"/api/tests/{alice_id}", {"uid": "perfara123"})
    check("演示账号读他人详情 404", st == 404, f"{st}")
    st, _, r = jcall("GET", "/api/projects", {"uid": "perfara123"})
    check("演示账号项目列表为空", st == 200 and r == [], f"{st} {str(r)[:150]}")


if __name__ == "__main__":
    sys.exit(main())
