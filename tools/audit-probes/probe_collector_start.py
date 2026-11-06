import json, os, shutil, subprocess, time, urllib.request

EXE = r"E:\WorkBuddy1\2026-10-19-13-59-27\perfara\collector\Perfara.exe"
BASE = r"C:\Users\user\AppData\Local\Temp\perfara_collector_probe"


def targets(port):
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/json/list" % port, timeout=0.5) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:
        return []


for run in range(2):
    shutil.rmtree(BASE, ignore_errors=True)
    for d in ("temp", "appdata", "localappdata"):
        os.makedirs(os.path.join(BASE, d), exist_ok=True)
    env = dict(os.environ)
    env.pop("ELECTRON_RUN_AS_NODE", None)
    env.update({
        "TEMP": os.path.join(BASE, "temp"), "TMP": os.path.join(BASE, "temp"),
        "APPDATA": os.path.join(BASE, "appdata"),
        "LOCALAPPDATA": os.path.join(BASE, "localappdata"),
    })
    port = 9341 + run
    t0 = time.time()
    p = subprocess.Popen([EXE, "--remote-debugging-port=%d" % port], env=env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    page_at = None
    dom_at = None
    deadline = t0 + 60
    while time.time() < deadline:
        ts = targets(port)
        pages = [t for t in ts if t.get("type") == "page"]
        if pages and page_at is None:
            page_at = time.time() - t0
        if page_at is not None:
            break
        time.sleep(0.05)
    print("run%d  首个 page target %.2fs  targets=%d" % (run, page_at or -1, len(ts)))
    # 再用 CDP 读 document.readyState，直到 interactive/complete
    if pages:
        ws = pages[0]["webSocketDebuggerUrl"]
        try:
            import websocket  # noqa
            has_ws = True
        except Exception:
            has_ws = False
        if not has_ws:
            # 退化：轮询 title 非空即可视为渲染出首屏
            for _ in range(200):
                ts2 = [t for t in targets(port) if t.get("type") == "page"]
                if ts2 and ts2[0].get("title"):
                    dom_at = time.time() - t0
                    print("      title=%r  at %.2fs" % (ts2[0]["title"], dom_at))
                    break
                time.sleep(0.05)
    subprocess.run(["taskkill", "/F", "/T", "/PID", str(p.pid)],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.0)
shutil.rmtree(BASE, ignore_errors=True)
