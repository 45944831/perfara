"""A/B 对比报告统计表行高：「!」标记放副标注前 vs 放末尾（旧行为）。"""
import base64
import json
import shutil
import socket
import subprocess
import time
import urllib.request
from pathlib import Path

from websockets.sync.client import connect

REPO = Path(r"E:\WorkBuddy1\2026-10-19-13-59-27")
RPT = REPO / "perfara" / "collector" / "resources" / "reports"
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

# 造一份「旧行为」副本：把 insertBefore 换回 appendChild
new_src = (RPT / "perf.html").read_text(encoding="utf-8")
old_src = new_src.replace(
    "var sub = el.querySelector('.metric-sub');\n      if (sub) el.insertBefore(dot, sub); else el.appendChild(dot);",
    "el.appendChild(dot);",
)
assert old_src != new_src, "旧行为副本注入失败"
old_path = RPT / "_shot_old.html"
old_path.write_text(old_src, encoding="utf-8")


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close()
    return p


def wait_devtools(port, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen("http://127.0.0.1:%d/json" % port, timeout=1) as r:
                return json.loads(r.read())
        except Exception:
            time.sleep(0.2)
    raise SystemExit("devtools 未就绪")


class Cdp:
    def __init__(self, ws_url):
        self.ws = connect(ws_url, max_size=50 * 1024 * 1024)
        self.id = 0

    def call(self, method, **params):
        self.id += 1
        self.ws.send(json.dumps({"id": self.id, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.id:
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                return msg.get("result", {})

    def eval(self, expr):
        r = self.call("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True)
        return r.get("result", {}).get("value")


PROBE = r"""
(() => {
  const tb = document.querySelector('#tbl-global tbody');
  if (!tb) return {error: 'no tbody'};
  const rows = [...tb.querySelectorAll('tr')].filter(tr => !tr.hidden && !tr.classList.contains('stats-detail-row') && tr.querySelector('.metric-sub'));
  return rows.slice(0, 4).map(tr => {
    const td = tr.cells[0];
    const dot = td.querySelector('.info-dot');
    const sub = td.querySelector('.metric-sub');
    const nameNode = [...td.childNodes].find(n => n.nodeType === 3 && n.textContent.trim());
    const nr = nameNode ? (() => { const r = document.createRange(); r.selectNodeContents(nameNode); return r.getBoundingClientRect(); })() : null;
    const dr = dot ? dot.getBoundingClientRect() : null;
    const sr = sub ? sub.getBoundingClientRect() : null;
    return {
      name: td.textContent.trim().slice(0, 18),
      rowH: Math.round(tr.getBoundingClientRect().height),
      tdH: Math.round(td.getBoundingClientRect().height),
      hasDot: !!dot,
      dotTop: dr ? Math.round(dr.top - tr.getBoundingClientRect().top) : null,
      nameTop: nr ? Math.round(nr.top - tr.getBoundingClientRect().top) : null,
      subTop: sr ? Math.round(sr.top - tr.getBoundingClientRect().top) : null,
      lines: td.querySelector('.metric-sub') ? 2 : 1,
    };
  });
})()
"""


def measure(path, tag):
    port = free_port()
    import tempfile
    prof = Path(tempfile.mkdtemp(prefix="cdp_rpt_" + tag + "_"))
    proc = subprocess.Popen([EDGE, "--headless", "--disable-gpu", "--no-first-run",
                             "--remote-debugging-port=%d" % port,
                             "--user-data-dir=%s" % prof, "--window-size=1200,2000",
                             "about:blank"])
    try:
        targets = wait_devtools(port)
        page = next(t for t in targets if t["type"] == "page")
        cdp = Cdp(page["webSocketDebuggerUrl"])
        cdp.call("Page.enable")
        cdp.call("Runtime.enable")
        cdp.call("Page.navigate", url=path.as_uri())
        time.sleep(2.5)
        rows = cdp.eval(PROBE)
        shot = cdp.call("Page.captureScreenshot", format="png")
        out = REPO / "release" / "_audit" / ("rpt_%s.png" % tag)
        out.write_bytes(base64.b64decode(shot["data"]))
        return rows, out
    finally:
        proc.kill()
        proc.wait()


old_rows, old_shot = measure(old_path, "old")
new_rows, new_shot = measure(RPT / "perf.html", "new")

for tag, rows in (("旧（dot 在末尾）", old_rows), ("新（dot 在副标注前）", new_rows)):
    print("==", tag)
    if isinstance(rows, dict):
        print("  ", rows); continue
    for r in rows:
        print("  %-18s 行高=%s 单元格高=%s dotTop=%s nameTop=%s subTop=%s"
              % (r["name"], r["rowH"], r["tdH"], r["dotTop"], r["nameTop"], r["subTop"]))
print("\n截图:", old_shot.name, new_shot.name)