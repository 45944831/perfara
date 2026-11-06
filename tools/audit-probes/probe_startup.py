import os, subprocess, sys, time, urllib.request, shutil, tempfile

EXE = r"E:\WorkBuddy1\2026-10-19-13-59-27\perfara\server\PerfaraServer.exe"
BASE = r"C:\Users\user\AppData\Local\Temp\perfara_startup_probe"


def wait_health(port, deadline):
    while time.time() < deadline:
        try:
            with urllib.request.urlopen("http://127.0.0.1:%d/api/health" % port, timeout=0.5) as r:
                if r.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(0.02)
    return False


for run in range(3):
    shutil.rmtree(BASE, ignore_errors=True)
    for d in ("temp", "data"):
        os.makedirs(os.path.join(BASE, d), exist_ok=True)
    env = dict(os.environ)
    env.update({"TEMP": os.path.join(BASE, "temp"), "TMP": os.path.join(BASE, "temp")})
    port = 8131 + run
    t0 = time.time()
    p = subprocess.Popen([EXE, "--port", str(port), "--host", "127.0.0.1",
                          "--no-browser", "--data-dir", os.path.join(BASE, "data")],
                         env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ok = wait_health(port, t0 + 60)
    t1 = time.time()
    mei = os.path.join(BASE, "temp")
    mei_size = 0
    for root, dirs, files in os.walk(mei):
        for f in files:
            try:
                mei_size += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    print("run%d  health=%s  冷启 %.2fs  TEMP占用 %.1fMB" % (run, ok, t1 - t0, mei_size / 1048576))
    subprocess.run(["taskkill", "/F", "/T", "/PID", str(p.pid)],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)
    left = os.listdir(mei) if os.path.isdir(mei) else []
    print("      强杀后 TEMP 残留条目:", len(left))
shutil.rmtree(BASE, ignore_errors=True)
