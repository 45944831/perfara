#!/usr/bin/env python3
"""N2/N3/N4 回归：跨租户 latest_info、分享令牌、项目别名隔离。

单独起隔离临时库与临时服务，不碰 perfara/data/webperf.db。
三条越权都必须被拦住；全部通过时退出 0。

用法：
    tools/.venv/Scripts/python.exe perfara/tests/deep/tenant_isolation_repro.py [port]
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PERFARA = os.path.abspath(os.path.join(HERE, "..", ".."))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8152
BASE = f"http://127.0.0.1:{PORT}"

SERVER = None
TMP = None
RESULTS = []


def check(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(f"[{'PASS' if cond else 'FAIL'}] {name}" + (f"  {detail}" if detail else ""), flush=True)
    return bool(cond)


def call(method, path, params=None, body=None, headers=None, timeout=20):
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        print(f"  [http error] {method} {path}: {type(e).__name__}: {e}", flush=True)
        return 0, str(e).encode("utf-8", "replace")


def jcall(method, path, params=None, body=None, headers=None):
    st, raw = call(method, path, params, body, headers)
    try:
        return st, json.loads(raw.decode("utf-8", "replace"))
    except Exception:
        return st, None


def upload(payload, uid):
    boundary = "----perfaraTenantProbe"
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    parts = [
        f'--{boundary}\r\nContent-Disposition: form-data; name="uid"\r\n\r\n{uid}\r\n'.encode(),
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="t.json"\r\n'
        f"Content-Type: application/json\r\n\r\n".encode() + data + b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ]
    return jcall("POST", "/api/upload", body=b"".join(parts),
                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})


def payload(pkg, device_name, fps):
    ts0 = 1761600000000
    return {
        "device": {"name": device_name, "model": device_name, "brand": "Probe",
                   "bundleId": pkg, "appName": "TenantApp", "category": "android",
                   "osVersion": "13"},
        "label": "tenant-label",
        "perf": [
            {"timestamp": ts0 + i * 1000, "fps": fps + i, "jank": 0,
             "big_jank": 0, "small_jank": 0, "tiny_jank": 0,
             "cpuUsage": 10.0 + i, "memory": 300000000 + i * 1000}
            for i in range(8)
        ],
    }


def start_server():
    global SERVER, TMP
    TMP = tempfile.mkdtemp(prefix="perfara_tenant_")
    env = dict(os.environ)
    env["WEB_PERF_DB"] = os.path.join(TMP, "tenant.db")
    env["PERFARA_HOME"] = TMP
    env["PYTHONIOENCODING"] = "utf-8"
    log = open(os.path.join(TMP, "server.log"), "wb")
    SERVER = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "backend.app:app",
         "--host", "127.0.0.1", "--port", str(PORT),
         "--log-level", "warning", "--no-server-header"],
        cwd=PERFARA, env=env, stdout=log, stderr=subprocess.STDOUT)
    for _ in range(80):
        st, _ = call("GET", "/api/health", timeout=2)
        if st == 200:
            return
        if SERVER.poll() is not None:
            raise SystemExit(f"服务提前退出 exit={SERVER.returncode}，日志见 {TMP}")
        time.sleep(0.25)
    raise SystemExit("服务启动超时")


def rmtree_retry(path):
    for _ in range(6):
        shutil.rmtree(path, ignore_errors=True)
        if not os.path.exists(path):
            return
        time.sleep(0.3)


def stop_server():
    if SERVER and SERVER.poll() is None:
        SERVER.terminate()
        try:
            SERVER.wait(timeout=8)
        except subprocess.TimeoutExpired:
            SERVER.kill()
            SERVER.wait(timeout=5)
    if TMP:
        rmtree_retry(TMP)


def main():
    start_server()
    pkg = "com.tenant.shared"
    try:
        st, alice = upload(payload(pkg, "DeviceOf-alice", 30.0), "alice")
        print(f"alice upload -> {st} id={(alice or {}).get('id')}")
        st, bob = upload(payload(pkg, "DeviceOf-bob", 99.0), "bob")
        print(f"bob   upload -> {st} id={(bob or {}).get('id')}")
        alice_id = (alice or {}).get("id")
        bob_id = (bob or {}).get("id")

        # N2：latest ParsedInfo 必须按 uid 过滤，只在调用者自己的记录里取最新
        st, rows = jcall("GET", "/api/projects/with-info", params={"uid": "alice"})
        print(f"alice with-info -> {st} rows={json.dumps(rows, ensure_ascii=False)[:600]}")
        infos = [(row or {}).get("latest_info") or {} for row in rows or []]
        check("N2 alice 的 latest_info 不会取到 bob 的记录",
              st == 200 and all(i.get("test_run_id") != bob_id for i in infos),
              f"alice_id={alice_id} bob_id={bob_id} "
              f"latest={[i.get('test_run_id') for i in infos]}")

        # N3：分享令牌必须是随机值；md5(id) 与公开接口都不应再放行
        st, own = jcall("GET", f"/api/tests/{bob_id}", params={"uid": "bob"})
        token = ((own or {}).get("test") or {}).get("md5")
        check("N3 分享令牌为随机值（t 前缀 / 31 位 / 非 md5）",
              isinstance(token, str) and token.startswith("t") and len(token) == 31,
              str(token))
        md5_token = hashlib.md5(str(bob_id).encode()).hexdigest()
        st_a, _ = jcall("GET", f"/api/tests/{bob_id}", params={"testid": md5_token})
        st_b, pub = jcall("GET", "/api/public/test", params={"testid": md5_token})
        check("N3 md5(id) 令牌无法读取他人记录",
              st_a == 404 and st_b == 404, f"detail={st_a} public={st_b}")
        st_c, detail = jcall("GET", "/api/public/test", params={"testid": token})
        raw = detail.get("test_raw") if isinstance(detail, dict) else None
        owner = ((detail or {}).get("test") or {}).get("owner_uid")
        check("N3 真实令牌可公开分享，但不回传 owner_uid",
              st_c == 200 and owner is None and bool(raw),
              f"status={st_c} owner_uid={owner} test_raw={'present' if raw else 'missing'}")

        # N4：别名表按 owner_uid 读写隔离
        st, put1 = jcall("PUT", "/api/project-aliases", params={"uid": "alice"},
                         body=json.dumps([{"package_name": pkg, "display_name": "AliasByAlice"}]).encode("utf-8"),
                         headers={"Content-Type": "application/json"})
        print(f"alice put alias -> {st} {json.dumps(put1, ensure_ascii=False)[:300]}")
        st2, seen = jcall("GET", "/api/project-aliases", params={"uid": "bob"})
        print(f"bob get alias -> {st2} {json.dumps(seen, ensure_ascii=False)[:300]}")
        bob_view = [a for a in (seen or []) if (a or {}).get("package_name") == pkg]
        check("N4 bob 看不到 alice 写的别名",
              st2 == 200 and not any(a.get("display_name") == "AliasByAlice" for a in bob_view),
              f"bob 看到 {bob_view}")

        st3, put2 = jcall("PUT", "/api/project-aliases", params={"uid": "bob"},
                          body=json.dumps([{"package_name": pkg, "display_name": "OverwrittenByBob"}]).encode("utf-8"),
                          headers={"Content-Type": "application/json"})
        print(f"bob put alias -> {st3} {json.dumps(put2, ensure_ascii=False)[:300]}")
        st4, seen2 = jcall("GET", "/api/project-aliases", params={"uid": "alice"})
        alice_view = [a for a in (seen2 or []) if (a or {}).get("package_name") == pkg]
        check("N4b bob 覆盖不到 alice 的别名",
              st4 == 200
              and any(a.get("display_name") == "AliasByAlice" for a in alice_view)
              and not any(a.get("display_name") == "OverwrittenByBob" for a in alice_view),
              f"alice 看到 {alice_view}")
    finally:
        stop_server()

    bad = [r for r in RESULTS if not r[1]]
    print(f"\n==== 回归结果: PASS {len(RESULTS) - len(bad)} / FAIL {len(bad)} ====")
    return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(main())
