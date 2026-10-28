"""缺陷取证：非纯量 device.name 走 500 并把 SQL/绑定参数回显给未鉴权调用方。"""
import json
import os
import socket
import tempfile
import threading
import time
import urllib.error
import urllib.request

TMP = tempfile.mkdtemp(prefix="perfara_repro_")
os.environ["WEB_PERF_DB"] = os.path.join(TMP, "repro.db")
os.environ["PERFARA_HOME"] = TMP
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

import uvicorn
from backend.app import app

s = socket.socket()
s.bind(("127.0.0.1", 0))
PORT = s.getsockname()[1]
s.close()

cfg = uvicorn.Config(app, host="127.0.0.1", port=PORT, log_level="critical")
server = uvicorn.Server(cfg)
threading.Thread(target=server.run, daemon=True).start()
for _ in range(100):
    if server.started:
        break
    time.sleep(0.1)

payload = {"device": {"category": "android", "bundleId": "com.example.victim",
                      "appName": "VictimApp", "name": ["NOT", "A", "STRING"]},
           "perf": [{"timestamp": 1761600000000, "fps": 30, "cpuUsage": 12}]}
body = json.dumps(payload).encode()
boundary = "----repro"
multipart = (
    f'--{boundary}\r\nContent-Disposition: form-data; name="uid"\r\n\r\nleek\r\n'
    f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.json"\r\n'
    f"Content-Type: application/json\r\n\r\n".encode() + body +
    f"\r\n--{boundary}--\r\n".encode()
)
req = urllib.request.Request(f"http://127.0.0.1:{PORT}/api/upload", data=multipart, method="POST",
                             headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        print("STATUS", r.status)
        print(r.read().decode("utf-8", "replace"))
except urllib.error.HTTPError as e:
    print("STATUS", e.code)
    txt = e.read().decode("utf-8", "replace")
    print("BODY_LEN", len(txt))
    print(txt)
    print("--- 泄漏要素判定 ---")
    for k in ["INSERT INTO", "[SQL:", "[parameters:", "raw_json", "owner_uid", "sqlite3.ProgrammingError",
              "PendingRollbackError", "Traceback"]:
        print(f"{k}: {'出现' if k in txt else '未出现'}")
server.should_exit = True
