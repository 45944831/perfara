r"""打包态上传闸门冒烟：起 server\PerfaraServer.exe，逐个 content-type / Origin 打点。"""
import json, socket, subprocess, sys, time, urllib.error, urllib.request
from pathlib import Path

PKG = Path(r"E:\WorkBuddy1\2026-10-19-13-59-27\perfara")
EXE = PKG / "server" / "PerfaraServer.exe"

s = socket.socket(); s.bind(("127.0.0.1", 0)); PORT = s.getsockname()[1]; s.close()
proc = subprocess.Popen([str(EXE), "--port", str(PORT), "--host", "127.0.0.1", "--no-browser",
                         "--data-dir", str(PKG)], cwd=str(PKG),
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def health():
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/api/health" % PORT, timeout=1) as r:
            return r.status == 200
    except Exception:
        return False

ok = False
for _ in range(120):
    if health():
        ok = True; break
    time.sleep(0.3)
print("health:", ok)
if not ok:
    proc.kill(); sys.exit(1)

def post(ctype, origin=None, body=b'{"uid":"probe-r12"}'):
    req = urllib.request.Request("http://127.0.0.1:%d/api/upload" % PORT, data=body, method="POST")
    if ctype:
        req.add_header("Content-Type", ctype)
    if origin:
        req.add_header("Origin", origin)
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code

cases = [
    ("text/plain", None, 415, "text/plain 直投被拒"),
    (None, None, 415, "缺 content-type 被拒"),
    ("application/json", "http://evil.example", 403, "跨站 Origin 被拒"),
    ("application/json", "null", 403, "Origin: null 被拒"),
    ("application/json", "http://127.0.0.1:%d" % PORT, 400, "同源 Origin 放行（400=已过闸门到载荷校验）"),
    ("application/json; charset=utf-8", None, 400, "application/json;charset 放行（400=载荷不合法）"),
]
fails = 0
for ctype, origin, want, name in cases:
    got = post(ctype, origin)
    good = got == want
    fails += 0 if good else 1
    print("  %-32s want=%s got=%s %s" % (name, want, got, "OK" if good else "FAIL"))

proc.kill(); proc.wait()
print("RESULT:", "PASS" if fails == 0 else "FAIL(%d)" % fails)
