#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""对抗性深度测试（2026-10-28）：隔离临时库 + 自管服务，不碰 perfara/data/webperf.db。

与 api_deep_test.py 的分工：
    api_deep 覆盖「正常路径 + 已修复缺陷的回归」；
    本套专门打开放上传入口与鉴权边界，覆盖：
      · 畸形 / 超长 / 非有限浮点 / 深层嵌套 / 超大载荷
      · 带 metricConfig 的去重一致性
      · 项目创建的并发竞态与失败上传的脏项目
      · UID 隔离、别名作用域、分享令牌可预测性
      · 删除 / reparse 的级联与幂等
      · 路径穿越、分页/日期边界、静态资源 MIME

输出约定：
    [PASS] / [FAIL]   FAIL 表示与约定行为不符，退出码 1；
    [RISK]            设计或安全风险（不阻断退出码），单独汇总。

用法：
    tools/.venv/Scripts/python.exe perfara/tests/deep/adversarial_deep_test.py [port]
"""
import hashlib
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
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
PERFARA = os.path.abspath(os.path.join(HERE, "..", ".."))
REPO = os.path.abspath(os.path.join(PERFARA, ".."))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8161
BASE = f"http://127.0.0.1:{PORT}"
TIMEOUT = 120

RESULTS = []
RISKS = []
SERVER = None
TMP = None
GROUP = ""


def check(name, cond, detail=""):
    ok = bool(cond)
    RESULTS.append((GROUP, name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {GROUP} / {name}" + ("" if ok else f"  ->  {detail}"), flush=True)
    return ok


def risk(name, present, detail=""):
    if present:
        RISKS.append((GROUP, name, detail))
        print(f"[RISK] {GROUP} / {name}  ->  {detail}", flush=True)
    else:
        print(f"[ ok ] {GROUP} / {name}", flush=True)


def section(title):
    global GROUP
    GROUP = title
    print(f"\n--- {title} ---", flush=True)


def call(method, path, params=None, body=None, headers=None, timeout=TIMEOUT):
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read()
    except Exception as e:
        return 0, {}, str(e).encode("utf-8", "replace")


def jcall(method, path, params=None, body=None, headers=None, timeout=TIMEOUT):
    st, hd, raw = call(method, path, params, body, headers, timeout)
    try:
        return st, hd, json.loads(raw.decode("utf-8", "replace"))
    except Exception:
        return st, hd, None


def upload(payload, uid="advuser", para2=None, headers=None, timeout=TIMEOUT):
    if isinstance(payload, (dict, list)):
        body = json.dumps(payload, ensure_ascii=False, allow_nan=True).encode("utf-8")
    else:
        body = payload
    hd = {"Content-Type": "application/json"}
    if headers:
        hd.update(headers)
    params = {"uid": uid}
    if para2 is not None:
        params["para2"] = para2
    return jcall("POST", "/api/upload", params=params, body=body, headers=hd, timeout=timeout)


def make_payload(pkg="com.adv.app", app="AdvApp", n=4, label="adv", category="android",
                 ts0=1762000000000, fps=60.0, extra=None):
    perf = []
    for i in range(n):
        perf.append({
            "timestamp": ts0 + i * 1000,
            "fps": fps,
            "jank": i % 3,
            "bigJank": 0,
            "cpu": {"sysCpu": 30.0 + i, "procCpu": 20.0 + i},
            "cpuCores": {"usage": [10, 20], "freq": [1000, 1200]},
            "mem": {"totalPss": 300000 + i * 1000, "javaHeap": 1000},
            "net": {"rxKBps": 10, "txKBps": 5},
            "gpu": 44.0,
            "temperature": 39.0 + i,
            "battery": {"temperature": 38.0, "currentNow": 400, "power": 1.5},
        })
    p = {
        "device": {"name": "AdvDevice", "model": "generic", "brand": "generic",
                   "bundleId": pkg, "appName": app, "category": category, "osVersion": "13"},
        "label": label,
        "perf": perf,
    }
    if extra:
        p.update(extra)
    return p


def start_server():
    global SERVER, TMP
    TMP = tempfile.mkdtemp(prefix="perfara_adv_")
    db = os.path.join(TMP, "adv.db")
    env = dict(os.environ)
    env["WEB_PERF_DB"] = db
    env["PERFARA_HOME"] = TMP
    env["PYTHONIOENCODING"] = "utf-8"
    log = open(os.path.join(TMP, "server.log"), "wb")
    SERVER = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "backend.app:app",
         "--host", "127.0.0.1", "--port", str(PORT), "--log-level", "warning",
         "--no-server-header"],
        cwd=PERFARA, env=env, stdout=log, stderr=subprocess.STDOUT)
    for _ in range(120):
        if SERVER.poll() is not None:
            raise SystemExit(f"服务提前退出 exit={SERVER.returncode}，日志见 {TMP}")
        try:
            if call("GET", "/api/health", timeout=2)[0] == 200:
                return
        except Exception:
            pass
        time.sleep(0.25)
    raise SystemExit("服务启动超时")


def stop_server():
    if SERVER and SERVER.poll() is None:
        SERVER.terminate()
        try:
            SERVER.wait(timeout=15)
        except Exception:
            SERVER.kill()


def dbq(sql, args=()):
    con = sqlite3.connect(os.path.join(TMP, "adv.db"), timeout=20)
    try:
        return con.execute(sql, args).fetchall()
    finally:
        con.close()


def run_tests():
    # ───────────────────────── 01 基线与已修缺陷回归 ─────────────────────────
    section("01 基线与已修缺陷回归")
    st, hd, raw = call("GET", "/api/health")
    check("健康检查 200", st == 200, f"{st}")
    check("响应不暴露 server 头", "server" not in hd, str(sorted(hd)))
    st, _, _ = call("GET", "/api/tests")
    check("缺少 uid 返回 400", st == 400, str(st))

    ok = upload(make_payload(label="demo"), uid="perfara123")
    check("演示账号上传 403", ok[0] == 403, str(ok[0]))

    bad_dev = make_payload(pkg="com.adv.devname")
    bad_dev["device"]["name"] = ["NOT", "A", "STRING"]
    st, _, r = upload(bad_dev, uid="devname")
    check("device.name 为数组时降级而非 500", st == 200 and r and r.get("device") == "", f"{st} {str(r)[:120]}")

    # 先造一条数据供查询回归
    st, _, seedrow = upload(make_payload(pkg="com.adv.query", label="query-label"), uid="queryuser")
    check("基准上传成功", st == 200, f"{st}")

    st, _, r = jcall("GET", "/api/tests", {"uid": "queryuser", "project_id": 0})
    check("project_id=0 不再被当作未传（total=0）", st == 200 and r and r.get("total") == 0, f"{st} {str(r)[:100]}")
    st, _, r = jcall("GET", "/api/tests", {"uid": "queryuser", "q": "%"})
    check("q=% 不再命中全部记录", st == 200 and r and r.get("total") == 1, f"{st} total={(r or {}).get('total')}")
    st, _, _ = jcall("POST", "/api/admin/reparse", {"uid": "queryuser", "test_id": 0})
    check("reparse?test_id=0 返回 404 而非全库重解析", st == 404, str(st))

    st, _, body = call("GET", "/..%2F..%2Fbackend%2Fapp.py")
    check("编码路径穿越读不到后端源码", b"def upload_json" not in body, body[:80])
    st, _, body = call("GET", "/assets/..%2F..%2Fbackend%2Fapp.py")
    check("assets 路径穿越读不到后端源码", b"def upload_json" not in body, body[:80])
    st, _, body = call("GET", "/C:%5CWindows%5Cwin.ini")
    check("绝对路径参数不泄露本机文件", b"[fonts]" not in body.lower() and b"def upload_json" not in body, body[:80])

    # ───────────────────────── 02 畸形上传 ─────────────────────────
    section("02 畸形上传")
    cases = [
        ("空 body", b""),
        ("非法 JSON", b"{not json}"),
        ("根为数组", json.dumps([1, 2, 3]).encode()),
        ("根为字符串", json.dumps("hello").encode()),
        ("perf 为空数组", json.dumps({"device": {"category": "android"}, "perf": []}).encode()),
        ("perf 项非对象", json.dumps({"device": {"category": "android"}, "perf": [1]}).encode()),
        ("缺少 timestamp", json.dumps({"device": {"category": "android"}, "perf": [{"fps": 60}]}).encode()),
        ("非法 category", json.dumps({"device": {"category": "linux"}, "perf": [{"timestamp": 1}]}).encode()),
        ("category 冲突", json.dumps({"device": {"category": "android"}, "category": "ios", "perf": [{"timestamp": 1}]}).encode()),
        ("device 为数组", json.dumps({"device": [1], "perf": [{"timestamp": 1}]}).encode()),
        ("时间戳溢出", json.dumps({"device": {"category": "android"}, "perf": [{"timestamp": 10 ** 30}]}).encode()),
        ("非法 UTF-8", b'{"label":"\xff\xfe","device":{"category":"android"},"perf":[{"timestamp":1}]}'),
    ]
    for name, body in cases:
        st, _, r = jcall("POST", "/api/upload", {"uid": "fuzz"}, body=body,
                         headers={"Content-Type": "application/json"})
        check(f"{name} 返回 4xx 而非 5xx", 400 <= st < 500, f"{st} {str(r)[:120]}")

    nested = b'{"label":' + b"[" * 6000 + b"]" * 6000 + b',"device":{"category":"android"},"perf":[{"timestamp":1}]}'
    st, _, r = jcall("POST", "/api/upload", {"uid": "fuzz"}, body=nested,
                     headers={"Content-Type": "application/json"})
    check("6000 层嵌套 JSON 不 500", 400 <= st < 500, f"{st} {str(r)[:120]}")
    check("深层嵌套后服务仍健康", call("GET", "/api/health")[0] == 200, "")

    st, _, r = jcall("POST", "/api/upload", {"uid": "fuzz"},
                     body=b"--xx\r\nContent-Disposition: form-data; name=\"uid\"\r\n\r\nfuzz\r\n--xx--\r\n",
                     headers={"Content-Type": "multipart/form-data"})  # 缺 boundary
    check("multipart 缺 boundary 不 500", st < 500, f"{st} {str(r)[:120]}")

    boundary = "----advBoundary"
    mp_no_file = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"uid\"\r\n\r\nfuzz\r\n"
                  f"--{boundary}--\r\n").encode()
    st, _, r = jcall("POST", "/api/upload", body=mp_no_file,
                     headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    check("multipart 缺 file 返回 400", st == 400, f"{st} {str(r)[:120]}")

    mp_txt = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"uid\"\r\n\r\nfuzz\r\n"
              f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.txt\"\r\n"
              f"Content-Type: application/json\r\n\r\n{{}}\r\n--{boundary}--\r\n").encode()
    st, _, r = jcall("POST", "/api/upload", body=mp_txt,
                     headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    check("multipart 非 .json 文件名返回 400", st == 400, f"{st} {str(r)[:120]}")

    # ───────────────────────── 03 非有限浮点与超长字段 ─────────────────────────
    section("03 非有限浮点与超长字段")
    st, _, r = upload(make_payload(pkg="com.adv.inf", label="inf", fps=float("inf")), uid="nonfinite")
    check("Infinity 指标不导致上传 500", st == 200, f"{st} {str(r)[:100]}")
    st, _, r = jcall("GET", "/api/tests", {"uid": "nonfinite"})
    check("含 Infinity 的列表仍 200", st == 200, f"{st}")
    if r and r.get("items"):
        tid = r["items"][0]["id"]
        st, _, _ = jcall("GET", f"/api/tests/{tid}", {"uid": "nonfinite"})
        check("含 Infinity 的详情仍 200", st == 200, f"{st}")
    stored = dbq("SELECT summary, raw_json FROM test_runs WHERE owner_uid='nonfinite'")[0]
    check("非有限浮点被清洗为 null，不写入 Infinity/NaN",
          not ("Infinity" in (stored[0] or "") or "NaN" in (stored[0] or "")
               or "Infinity" in (stored[1] or "") or "NaN" in (stored[1] or "")),
          "summary 前 80 字：" + (stored[0] or "")[:80])
    # JS 侧 JSON.parse 不认 Infinity/NaN：严格 JSON 才能被前端消费
    try:
        json.loads(stored[0], parse_constant=lambda c: (_ for _ in ()).throw(ValueError(c)))
        check("库内 summary 为严格 JSON（JS 可解析）", True)
    except Exception as e:
        check("库内 summary 为严格 JSON（JS 可解析）", False, f"parse_constant 拒绝：{e}")

    long_uid = "u" * 4096
    st, _, _ = upload(make_payload(pkg="com.adv.longuid"), uid=long_uid)
    ln = dbq("SELECT count(*) FROM test_runs WHERE length(owner_uid) > 128")[0][0]
    check("超长 UID 被拒绝（400，且没有落库）", st == 400 and ln == 0, f"status={st} long_rows={ln}")

    st, _, _ = upload(make_payload(pkg="com.adv.longlabel", label="L" * 262144), uid="longlabel")
    ln2 = dbq("SELECT count(*) FROM test_runs WHERE owner_uid='longlabel'")[0][0]
    check("超长 label 被拒绝（400，且没有落库）", st == 400 and ln2 == 0,
          f"status={st} rows={ln2}")

    # ───────────────────────── 04 载荷体积 ─────────────────────────
    section("04 载荷体积")
    big = make_payload(pkg="com.adv.big", n=20000, label="big")
    t0 = time.time()
    st, _, r = upload(big, uid="biguser", timeout=180)
    cost = time.time() - t0
    size_mb = len(json.dumps(big)) / 1048576
    check("约 20k 点 / 数 MB 载荷可上传", st == 200, f"{st} {str(r)[:80]}")
    db_mb = os.path.getsize(os.path.join(TMP, "adv.db")) / 1048576
    check("常规大载荷仍在 16 MB 上限内（上传成功）", st == 200,
          f"{size_mb:.1f} MB / {cost:.1f}s；落库后 db={db_mb:.1f} MB（单条）")

    # 只发头、不真传 17 MB：服务端应按 Content-Length 直接 413
    # （urllib 会先把整包塞进 socket，被提前拒绝时只能看到连接重置）
    oversize_len = 17 * 1024 * 1024
    sock = socket.create_connection(("127.0.0.1", PORT), timeout=10)
    try:
        sock.sendall(
            b"POST /api/upload?uid=oversize HTTP/1.1\r\n"
            + f"Host: 127.0.0.1:{PORT}\r\n".encode()
            + b"Content-Type: application/json\r\n"
            + f"Content-Length: {oversize_len}\r\n\r\n".encode()
        )
        head = sock.recv(4096)
    finally:
        sock.close()
    status_line = head.split(b"\r\n", 1)[0].decode("latin-1", "replace")
    check("超过 16 MB 的请求被 413 拒绝", " 413 " in status_line, status_line)

    # ───────────────────────── 05 去重与并发 ─────────────────────────
    section("05 去重与并发")
    p_plain = make_payload(pkg="com.adv.dedupe", n=5, label="dedupe-plain")
    st1, _, r1 = upload(p_plain, uid="dedupe")
    st2, _, r2 = upload(p_plain, uid="dedupe")
    check("无 metricConfig 的重复上传去重为同一条",
          st1 == 200 and st2 == 200 and (r1 or {}).get("id") == (r2 or {}).get("id"),
          f"{(r1 or {}).get('id')} vs {(r2 or {}).get('id')}")

    p_cfg = make_payload(pkg="com.adv.dedupe", n=5, label="dedupe-cfg",
                         extra={"metricConfig": {"fps": False, "cpu": True, "mem": True}})
    st1, _, r1 = upload(p_cfg, uid="dedupe")
    st2, _, r2 = upload(p_cfg, uid="dedupe")
    same = (r1 or {}).get("id") == (r2 or {}).get("id")
    check("带 metricConfig 的重复上传同样去重", same,
          f"第一次 id={(r1 or {}).get('id')}，第二次 id={(r2 or {}).get('id')}")
    dupn = dbq("SELECT count(*) FROM test_runs WHERE owner_uid='dedupe' AND label='dedupe-cfg'")[0][0]
    check("metricConfig 参与哈希且去重有效（库内仅 1 条）", dupn == 1,
          f"同一载荷重复上传后库内 {dupn} 条")
    p_cfg2 = make_payload(pkg="com.adv.dedupe", n=5, label="dedupe-cfg",
                          extra={"metricConfig": {"fps": True, "cpu": True, "mem": True}})
    _, _, r3 = upload(p_cfg2, uid="dedupe")
    check("metricConfig 不同视为不同记录（不误合并）",
          (r3 or {}).get("id") not in (None, (r1 or {}).get("id")),
          f"cfg1 id={(r1 or {}).get('id')} cfg2 id={(r3 or {}).get('id')}")

    def up_cfg(_i):
        return upload(p_cfg, uid="dedupe-race")

    with ThreadPoolExecutor(max_workers=8) as ex:
        outs = list(ex.map(up_cfg, range(8)))
    ids = {(o[2] or {}).get("id") for o in outs if o[0] == 200}
    check("带 metricConfig 的并发重复上传只产生一条", len(ids) == 1, f"得到 {len(ids)} 个 id：{sorted(ids)}")

    def up_newproj(i):
        # 包名与应用名都必须全新：ensure_project_for_payload 会按 app_name 复用项目，
        # 沿用公共的 "AdvApp" 会让 12 路请求都挂到既有项目上，测不到并发创建。
        return upload(make_payload(pkg="com.adv.race.newproj", app="RaceNewProj",
                                   label=f"race-{i}", ts0=1763000000000 + i * 100000),
                      uid="raceproj")

    with ThreadPoolExecutor(max_workers=12) as ex:
        outs = list(ex.map(up_newproj, range(12)))
    okn = sum(1 for o in outs if o[0] == 200)
    nproj = dbq("SELECT count(*) FROM projects WHERE package_name='com.adv.race.newproj'")[0][0]
    check("12 路并发新项目上传全部成功", okn == 12, f"{okn}/12")
    check("并发创建同一项目不产生重复 Project 行", nproj == 1, f"{nproj} 个项目行")

    # 失败上传是否留下脏项目
    st, _, _ = upload({"device": {"bundleId": "com.adv.pollution", "appName": "Pollution",
                                  "category": "android"}, "perf": []}, uid="pollution")
    check("空 perf 上传被拒绝", st == 400, str(st))
    npoll = dbq("SELECT count(*) FROM projects WHERE package_name='com.adv.pollution'")[0][0]
    risk("校验失败的上传仍创建了 Project 行（脏数据）", npoll > 0, f"Project 行数={npoll}")

    # ───────────────────────── 06 UID 隔离与共享令牌 ─────────────────────────
    section("06 UID 隔离与共享令牌")
    st, _, alice = upload(make_payload(pkg="com.adv.alice", label="alice-secret"), uid="alice")
    alice_id = (alice or {}).get("id")
    check("alice 上传成功", st == 200 and alice_id, f"{st}")
    st, _, r = jcall("GET", "/api/tests", {"uid": "bob"})
    check("bob 列表看不到 alice 的记录", st == 200 and (r or {}).get("total") == 0, f"{st} total={(r or {}).get('total')}")
    st, _, _ = jcall("GET", f"/api/tests/{alice_id}", {"uid": "bob"})
    check("bob 无令牌读 alice 详情 404", st == 404, str(st))
    st, _, _ = jcall("PATCH", f"/api/tests/{alice_id}/label", {"uid": "bob"}, body=json.dumps({"label": "x"}).encode(),
                     headers={"Content-Type": "application/json"})
    check("bob 改 alice 标签 404", st == 404, str(st))
    st, _, _ = jcall("DELETE", f"/api/tests/{alice_id}", {"uid": "bob"})
    check("bob 删 alice 记录 404", st == 404, str(st))
    st, _, _ = jcall("POST", "/api/admin/reparse", {"uid": "bob", "test_id": alice_id})
    check("bob reparse alice 记录 404", st == 404, str(st))
    st, _, _ = jcall("GET", f"/api/projects/{alice['project_id']}/infos", {"uid": "bob"})
    check("bob 读 alice 项目快照 404", st == 404, str(st))

    st, _, r = jcall("GET", "/api/tests", {"uid": "perfara123"})
    check("演示账号空快照列表为空", st == 200 and (r or {}).get("total") == 0, f"{st} total={(r or {}).get('total')}")
    st, _, _ = jcall("PATCH", f"/api/tests/{alice_id}/label", {"uid": "perfara123"},
                     body=json.dumps({"label": "x"}).encode(), headers={"Content-Type": "application/json"})
    check("演示账号改标签 403", st == 403, str(st))
    st, _, _ = jcall("DELETE", f"/api/tests/{alice_id}", {"uid": "perfara123"})
    check("演示账号删除 403", st == 403, str(st))
    st, _, _ = jcall("POST", "/api/admin/reparse", {"uid": "perfara123"})
    check("演示账号 reparse 403", st == 403, str(st))

    st, _, r = jcall("GET", "/api/tests", {"uid": "wonderxu"})
    check("超管 UID 可读全量（设计行为）", st == 200 and (r or {}).get("total", 0) >= 1, f"{st} total={(r or {}).get('total')}")
    risk("任意调用方自报 uid=wonderxu 即可读取全部数据", st == 200,
         "uid 只是请求参数，不是凭据；默认回环时风险有限，--host 0.0.0.0 时等于全量公开")

    token = dbq("SELECT share_md5 FROM test_runs WHERE id=?", (alice_id,))[0][0]
    st, _, _ = jcall("GET", f"/api/tests/{alice_id}", {"uid": "bob", "testid": token})
    check("bob 用真实分享令牌可读 alice 详情（公开链接语义）", st == 200, str(st))
    st, _, pub = jcall("GET", "/api/public/test", {"testid": token})
    check("匿名 public 接口用随机令牌可取详情", st == 200 and (pub or {}).get("id") == alice_id, str(st))
    check("public 详情不回传 owner_uid / para1 / para2",
          (pub or {}).get("test", {}).get("owner_uid") is None
          and (pub or {}).get("test", {}).get("para1") is None
          and (pub or {}).get("test", {}).get("para2") is None,
          str((pub or {}).get("test"))[:160])
    st_old, _, _ = jcall("GET", "/api/public/test",
                         {"testid": hashlib.md5(str(alice_id).encode()).hexdigest()})
    check("md5(id) 旧令牌不再可用", st_old == 404, str(st_old))
    check("分享令牌不可由自增 id 推导（长度 31、t 前缀、非 md5）",
          isinstance(token, str) and token.startswith("t") and len(token) == 31,
          str(token))

    # 别名表现在按 owner_uid 隔离
    alias_body = json.dumps([{"package_name": "com.adv.alice", "display_name": "AliasByAlice"}]).encode()
    st, _, _ = jcall("PUT", "/api/project-aliases", {"uid": "alice"}, body=alias_body,
                     headers={"Content-Type": "application/json"})
    check("alice 写项目别名成功", st == 200, str(st))
    st, _, r = jcall("GET", "/api/project-aliases", {"uid": "bob"})
    seen = any(a.get("display_name") == "AliasByAlice" for a in (r or []))
    check("bob 读不到 alice 的别名", not seen, str(r)[:160])
    alias_body2 = json.dumps([{"package_name": "com.adv.alice", "display_name": "OverwrittenByBob"}]).encode()
    st, _, _ = jcall("PUT", "/api/project-aliases", {"uid": "bob"}, body=alias_body2,
                     headers={"Content-Type": "application/json"})
    st2, _, r2 = jcall("GET", "/api/project-aliases", {"uid": "alice"})
    check("bob 改不动 alice 的别名", st == 200
          and any(a.get("display_name") == "AliasByAlice" for a in (r2 or []))
          and not any(a.get("display_name") == "OverwrittenByBob" for a in (r2 or [])),
          str(r2)[:160])

    # ───────────────────────── 07 生命周期：删除 / reparse ─────────────────────────
    section("07 生命周期：删除 / reparse")
    st, _, r = upload(make_payload(pkg="com.adv.life", label="life"), uid="life")
    tid = (r or {}).get("id")
    nblob = dbq("SELECT count(*) FROM metric_blobs WHERE test_run_id=?", (tid,))[0][0]
    ninfo = dbq("SELECT count(*) FROM parsed_info WHERE test_run_id=?", (tid,))[0][0]
    check("上传后恰好 1 个 blob / 1 条快照", nblob == 1 and ninfo == 1, f"blob={nblob} info={ninfo}")
    st, _, _ = jcall("DELETE", f"/api/tests/{tid}", {"uid": "life"})
    check("删除返回 204", st == 204, str(st))
    check("删除后详情 404", jcall("GET", f"/api/tests/{tid}", {"uid": "life"})[0] == 404)
    check("删除后 blob/快照无孤儿",
          dbq("SELECT count(*) FROM metric_blobs WHERE test_run_id=?", (tid,))[0][0] == 0
          and dbq("SELECT count(*) FROM parsed_info WHERE test_run_id=?", (tid,))[0][0] == 0)
    check("重复删除返回 404", jcall("DELETE", f"/api/tests/{tid}", {"uid": "life"})[0] == 404)

    st, _, r = upload(make_payload(pkg="com.adv.rep", label="keep-me"), uid="rep")
    rid = (r or {}).get("id")
    st, _, rr = jcall("POST", "/api/admin/reparse", {"uid": "rep", "test_id": rid})
    check("单条 reparse 成功", st == 200 and (rr or {}).get("reparsed") == 1, f"{st} {str(rr)[:100]}")
    nblob = dbq("SELECT count(*) FROM metric_blobs WHERE test_run_id=?", (rid,))[0][0]
    ninfo = dbq("SELECT count(*) FROM parsed_info WHERE test_run_id=?", (rid,))[0][0]
    lab = dbq("SELECT label FROM test_runs WHERE id=?", (rid,))[0][0]
    check("reparse 后 blob 仍为 1（不重复）", nblob == 1, f"blob={nblob}")
    check("reparse 后快照仍为 1（旧行已删）", ninfo == 1, f"info={ninfo}")
    check("reparse 保留人工标签", lab == "keep-me", str(lab))

    # ───────────────────────── 08 查询边界 ─────────────────────────
    section("08 查询边界")
    st, _, r = jcall("GET", "/api/tests", {"uid": "queryuser", "page_size": 1000})
    check("page_size=1000 被夹到 200", st == 200 and (r or {}).get("page_size") == 200, f"{(r or {}).get('page_size')}")
    st, _, r = jcall("GET", "/api/tests", {"uid": "queryuser", "page": 999999})
    check("超大页码返回空页而非报错", st == 200 and (r or {}).get("items") == [], f"{st}")
    for k, v in [("date_from", "not-a-date"), ("date_to", "2026-13-99"), ("date_to", "%%%%")]:
        st, _, _ = jcall("GET", "/api/tests", {"uid": "queryuser", k: v})
        check(f"{k}={v!r} 不报错", st == 200, str(st))
    st, _, r = jcall("GET", "/api/tests/trend",
                     {"uid": "queryuser", "label": "%", "category": "android", "project_name": "AdvApp"})
    check("trend 的 label 按精确值匹配（% 不当通配符）", st == 200 and (r or {}).get("points") == [], f"{st}")
    st, _, _ = jcall("GET", "/api/tests/trend", {"uid": "queryuser", "label": "x", "category": "linux",
                                                 "project_name": "AdvApp"})
    check("trend 非法 category 返回 400", st == 400, str(st))
    st, _, _ = jcall("GET", "/api/tests/trend", {"uid": "queryuser", "label": "x", "category": "android"})
    check("trend 缺 project_name 返回 400", st == 400, str(st))
    st, _, r = jcall("GET", "/api/tests/distinct-labels", {"uid": "queryuser"})
    check("distinct-labels 返回去重排序列表", st == 200 and r == sorted(set(r or [])), str(r))
    st, _, r = jcall("GET", "/api/tests/distinct-app-names", {"uid": "queryuser"})
    check("distinct-app-names 含已上传应用", st == 200 and "AdvApp" in (r or []), str(r))
    st, _, _ = jcall("GET", "/api/tests/9223372036854775808", {"uid": "queryuser"})
    check("超出 SQLite 整型的 id 返回 4xx（非 500）", 400 <= st < 500, str(st))
    st, _, _ = jcall("GET", "/api/tests/not-a-number", {"uid": "queryuser"})
    check("非数字 id 返回 4xx", 400 <= st < 500, str(st))

    # ───────────────────────── 09 静态资源 ─────────────────────────
    section("09 静态资源")
    dist = os.path.join(PERFARA, "frontend", "dist")
    js = None
    assets = os.path.join(dist, "assets")
    if os.path.isdir(assets):
        js = next((f for f in sorted(os.listdir(assets)) if f.endswith(".js")), None)
    if js:
        st, hd, _ = call("GET", "/assets/" + js)
        check("SPA 的 .js 以 JavaScript MIME 返回", st == 200 and "javascript" in hd.get("content-type", ""),
              f"{st} {hd.get('content-type')}")
    st, _, body = call("GET", "/")
    check("看板首页 200", st == 200, str(st))
    index_html = open(os.path.join(dist, "index.html"), "rb").read().decode("utf-8", "replace")
    check("index.html 无外部 http(s) 依赖", "https://" not in index_html and "http://" not in index_html,
          index_html[:120])
    st, _, body = call("GET", "/api/definitely-not-a-route")
    check("未知 API 返回 404 而非 SPA 首页", st == 404 and b"<html" not in body.lower(), f"{st}")
    st, _, body = call("GET", "/whatever/route")
    check("未知前端路由回落 index.html", st == 200 and b"<html" in body.lower(), str(st))

    # ───────────────────────── 10 并发与库健康 ─────────────────────────
    section("10 并发与库健康")
    def up_unique(i):
        return upload(make_payload(pkg="com.adv.bulk", label=f"bulk-{i}",
                                   ts0=1764000000000 + i * 10000), uid="bulkuser")

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=16) as ex:
        outs = list(ex.map(up_unique, range(32)))
    cost = time.time() - t0
    okn = sum(1 for o in outs if o[0] == 200)
    check("32 路并发上传全部 200", okn == 32, f"{okn}/32 用时 {cost:.2f}s")
    st, _, r = jcall("GET", "/api/tests", {"uid": "bulkuser", "page_size": 200})
    check("32 条记录全部可列出", st == 200 and (r or {}).get("total") == 32, f"total={(r or {}).get('total')}")
    check("并发后库完整性 ok", dbq("PRAGMA integrity_check")[0][0] == "ok")
    check("SQLite 已启用 WAL", dbq("PRAGMA journal_mode")[0][0].lower() == "wal")
    check("无孤儿 blob", dbq("SELECT count(*) FROM metric_blobs b LEFT JOIN test_runs t ON b.test_run_id=t.id WHERE t.id IS NULL")[0][0] == 0)
    check("无重复 share_md5", dbq("SELECT count(*) FROM (SELECT share_md5 FROM test_runs WHERE share_md5 IS NOT NULL GROUP BY share_md5 HAVING count(*)>1)")[0][0] == 0)
    try:
        logtxt = open(os.path.join(TMP, "server.log"), "rb").read().decode("utf-8", "replace")
    except Exception:
        logtxt = ""
    check("服务端日志无未捕获 Traceback", "Traceback" not in logtxt, logtxt[-400:].replace("\n", " | "))


def main():
    start_server()
    print(f"server up  base={BASE}")
    t0 = time.time()
    try:
        run_tests()
    finally:
        stop_server()
    fails = [r for r in RESULTS if not r[2]]
    print("\n" + "=" * 66)
    print(f"断言 {len(RESULTS)} 项：PASS {len(RESULTS) - len(fails)} / FAIL {len(fails)}；"
          f"风险记录 {len(RISKS)} 条；用时 {time.time() - t0:.1f}s")
    if fails:
        print("---- FAIL ----")
        for g, n, _, d in fails:
            print(f"  {g} / {n}   {d}")
    if RISKS:
        print("---- RISK ----")
        for g, n, d in RISKS:
            print(f"  {g} / {n}   {d}")
    print("=" * 66)
    if os.environ.get("KEEP_TMP") != "1":
        for _ in range(6):
            shutil.rmtree(TMP, ignore_errors=True)
            if not os.path.exists(TMP):
                break
            time.sleep(0.3)
    else:
        print(f"临时目录保留：{TMP}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
