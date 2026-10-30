#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""发布包端到端冒烟：解压 zip → 双击入口（launcher）→ 看板可用 → 收进程 → 端口释放。

为什么单独一套（2026-10-28）：
    `scan_package.py` 与 `scan_seed_db.py` 回答的是「包里有没有泄漏」，
    而 zip 层审计看不见两件事：
      · 根目录 `Perfara.exe` 装的是**启动器**还是 all-in-one —— 两种都能起页面，
        但只有启动器那条路径会做「遗留进程清理 + Job Object 连根收 + 端口释放确认」；
      · 前端资源的 MIME —— 历史上 `.js` 被当 `text/plain` 返回过，看板整页空白，
        任何「接口 200」的检查都发现不了白屏。
    所以这里跑的是**解压后的包**，不是仓库源码、也不是 perfara/ 目录。

用法：
    python perfara/tests/deep/zip_smoke_test.py <便携包.zip>
    python perfara/tests/deep/zip_smoke_test.py <便携包.zip> --keep   # 保留解压目录排查

退出码：0 全绿 / 1 有红 / 2 包或解压产物缺失
"""
import argparse
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEMO_UIDS = ("perfara123", "wonderxu")

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print("  %s  %s%s" % ("PASS" if ok else "FAIL", name,
                          ("  | " + str(detail)[:120]) if detail else ""))


def http_get(base, path, uid=None, timeout=25):
    """返回 (status, 小写键的响应头, body)。

    uvicorn/h11 发出的头是**小写**（content-type / server）。用 dict(r.headers)
    再 .get("Content-Type") 只会拿到空串，于是「MIME 可执行」「未回显框架头」
    两条断言看起来通过、实则从未被验证过。
    """
    req = urllib.request.Request(base + path)
    if uid:
        req.add_header("X-WebPerf-Uid", uid)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read()
    except Exception as e:
        return -1, {}, str(e).encode()


def port_open(port):
    s = socket.socket()
    s.settimeout(0.4)
    r = s.connect_ex(("127.0.0.1", port))
    s.close()
    return r == 0


def procs_under(pkg):
    """列出镜像路径在 pkg 目录内的进程（tasklist 不给路径，所以用 PowerShell）。

    路径经环境变量传入：早先用 `powershell -Command <script> <pkg>` 追加参数，
    PowerShell 会把 <pkg> 当成命令的又一个参数（$args 为空），脚本直接报错、
    stdout 为空 —— 于是「无遗留进程」永远 PASS。
    """
    script = ("Get-Process | Where-Object { $_.Path -like ($env:PROBE_ROOT + '\\*') } "
              "| ForEach-Object { \"$($_.Id) $($_.Path)\" }")
    env = dict(os.environ)
    env["PROBE_ROOT"] = pkg
    out = subprocess.run(["powershell", "-NoProfile", "-Command", script],
                         capture_output=True, text=True, env=env).stdout
    return [l.strip() for l in out.splitlines() if l.strip()]


def kill_listed(leftovers):
    """按 procs_under 的输出回收进程，避免测试自己留下客户端窗口。"""
    for line in leftovers:
        pid = line.split()[0]
        subprocess.run(["taskkill", "/T", "/F", "/PID", pid],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("zip")
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()

    zp = os.path.abspath(args.zip)
    if not os.path.isfile(zp):
        print("[error] 找不到包：%s" % zp)
        return 2
    print("== 发布包冒烟：%s (%.1f MB) ==" % (os.path.basename(zp),
                                             os.path.getsize(zp) / 1048576))

    pkg = tempfile.mkdtemp(prefix="perfara_zip_smoke_")
    with zipfile.ZipFile(zp) as z:
        if z.testzip() is not None:
            check("zip 完整性（testzip）", False, "有条目 CRC 不符")
            return 1
        z.extractall(pkg)
    check("zip 可解压且条目数正常", len(z.infolist()) > 1000, "%d 个条目" % len(z.infolist()))
    apks = [i.filename for i in z.infolist() if i.filename.lower().endswith(".apk")]
    check("发布包不带 WeakNet.apk（手机弱网只走 USB，不依赖 APK）", not apks, apks[:3])

    launcher = os.path.join(pkg, "Perfara.exe")
    server = os.path.join(pkg, "server", "PerfaraServer.exe")
    check("根入口是**启动器**而不是 all-in-one 服务",
          os.path.isfile(launcher) and os.path.isfile(server)
          and os.path.getsize(launcher) < 15 * 1048576,
          "Perfara.exe=%.1fMB server/PerfaraServer.exe=%.1fMB"
          % (os.path.getsize(launcher) / 1048576, os.path.getsize(server) / 1048576))

    # 采集客户端在包里，但冒烟只验「起得起、看板可用」，不依赖它
    check("采集客户端随包", os.path.isfile(os.path.join(pkg, "collector", "Perfara.exe")),
          os.path.join(pkg, "collector", "Perfara.exe"))

    # 弱网二级页面：页面在 app.asar 内，引擎在 asar 外（Electron 不能 spawn asar 内文件），
    # 且 exe 必须支持 --headless —— 旧版 exe 会让页面停在「引擎版本过旧」。
    asar = os.path.join(pkg, "collector", "resources", "app.asar")
    inner = []
    try:
        here = os.path.dirname(os.path.abspath(__file__))      # perfara/tests/deep
        tools_dir = os.path.join(here, "..", "..", "..", "tools")
        sys.path.insert(0, os.path.abspath(tools_dir))
        import asar_tool
        if os.path.isfile(asar):
            header, _ = asar_tool.read_header(asar)
            inner = [p for p, _ in asar_tool.walk(header)]
    except Exception as e:                                     # noqa: BLE001
        print("   app.asar 读取失败：%r" % (e,))
    need = ("renderer/weaknet-page.js", "renderer/weaknet-page.css",
            "src/weaknet-host.js", "src/phone-proxy.js")
    check("弱网二级页面随包（app.asar 内）", all(n in inner for n in need),
          "缺 %s" % [n for n in need if n not in inner] if not all(n in inner for n in need)
          else "%d 个文件" % len(inner))

    wn = os.path.join(pkg, "collector", "resources", "weaknet", "WeakNet.exe")
    check("弱网引擎随包", os.path.isfile(wn),
          "%.1fMB" % (os.path.getsize(wn) / 1048576) if os.path.isfile(wn) else "缺 " + wn)
    if os.path.isfile(wn):
        wr = os.path.join(pkg, "_wn_ready.json")
        try:
            os.remove(wr)
        except OSError:
            pass
        wp = subprocess.Popen([wn, "--headless", "--ready-file", wr], cwd=os.path.dirname(wn),
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        info = {}
        wdl = time.time() + 30
        while time.time() < wdl:
            if os.path.isfile(wr):
                try:
                    info = json.load(open(wr, encoding="utf-8"))
                except (ValueError, OSError):
                    info = {}
                if info:
                    break
            if wp.poll() is not None:
                break
            time.sleep(0.3)
        check("弱网引擎支持 --headless 握手", info.get("status") in ("ready", "already"),
              json.dumps(info, ensure_ascii=False) or "30s 内无就绪文件（旧版 exe？）")
        subprocess.run(["taskkill", "/PID", str(wp.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            os.remove(wr)
        except OSError:
            pass

    proc = subprocess.Popen([launcher], cwd=pkg,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = None
    deadline = time.time() + 120
    port = None
    log_path = os.path.join(pkg, "logs", "launcher.log")
    while time.time() < deadline:
        # 端口由启动器决定（8000 被占会 +1 退避），从它自己的日志里取才准
        if os.path.isfile(log_path):
            m = re.search(r"看板端口\s+(\d+)", open(log_path, encoding="utf-8",
                                                    errors="replace").read())
            if m:
                port = int(m.group(1))
                base = "http://127.0.0.1:%d" % port
                st, _, _ = http_get(base, "/api/health", timeout=2)
                if st == 200:
                    break
        time.sleep(0.5)
        if proc.poll() is not None:
            break
    check("启动器拉起看板服务（/api/health 200）", base and port and port_open(port),
          "port=%s" % port)
    if not base:
        tail = open(log_path, encoding="utf-8", errors="replace").read()[-400:] \
            if os.path.isfile(log_path) else "（无 launcher.log）"
        print("   launcher.log 尾部：%s" % tail)
        report(args, pkg)
        return 1

    st, hd, body = http_get(base, "/")
    html = body.decode("utf-8", errors="replace")
    check("看板首屏 200 且返回 SPA 外壳", st == 200 and "<div id=\"app\"" in html,
          "status=%s len=%d" % (st, len(html)))
    # 离线承诺盯的是「首屏加载期会不会外连」：`<a>` 里的外链只有点击才发请求，
    # 页脚开源署名正是这样一个锚点，把它连同文字一起去掉再判定；脚本/样式/图片
    # 等资源位上的 http(s) 仍然一律算违约。
    no_anchor = re.sub(r"<a\b[^>]*>.*?</a>", "", html, flags=re.S)
    check("首屏无外链请求（离线承诺）",
          "http://" not in no_anchor and "https://" not in no_anchor,
          "外链数=%d（含署名锚点，已排除）"
          % (html.count("http://") + html.count("https://")))

    m = re.search(r'(?:src|href)="(/[^"]+\.js)"', html)
    asset = m.group(1) if m else None
    if asset:
        st, hd, _ = http_get(base, asset)
        ct = hd.get("content-type", "")
        # 白屏的唯一判据是浏览器愿不愿执行它：text/plain 会被拒绝，
        # text/javascript / application/javascript 都可以
        check("JS 资源 MIME 可执行（白屏类故障）",
              st == 200 and ("javascript" in ct or "ecmascript" in ct),
              "%s -> %s %s" % (asset, st, ct))
    else:
        check("JS 资源 MIME 可执行（白屏类故障）", False, "首屏没找到 .js 引用")

    css = re.search(r'href="(/[^"]+\.css)"', html)
    if css:
        st, hd, _ = http_get(base, css.group(1))
        check("CSS 资源 MIME 正确", st == 200 and "text/css" in hd.get("content-type", ""),
              "%s -> %s" % (css.group(1), hd.get("content-type", "")))

    st, hd, body = http_get(base, "/api/tests?page=1&page_size=5", uid=DEMO_UIDS[0])
    try:
        j = json.loads(body)
        items = j.get("items") or j.get("tests") or []
        total = j.get("total", len(items))
    except Exception:
        items, total = None, "parse-error"
    # 列表里的均值在 summary JSON 里（TestRunOut.summary），顶层没有 fps_avg 这个字段
    def _fps(it):
        s = (it or {}).get("summary") or {}
        return s.get("fpsAvg") if isinstance(s, dict) else None

    check("随包种子库可用（演示记录读得出且有均值）",
          st == 200 and isinstance(items, list) and len(items) > 0
          and any(_fps(it) for it in items),
          "status=%s total=%s 首页=%d 条 均值=%s"
          % (st, total, len(items or []), [_fps(i) for i in (items or [])][:3]))

    st, hd, body = http_get(base, "/api/projects", uid=DEMO_UIDS[1])
    check("超管项目列表 200", st == 200, "status=%s" % st)
    # 这套服务没有登录态，UID 就是身份：陌生 UID 不该被拒（那是设计），
    # 但必须只看得到自己的空集。一旦它摸到别人的行，越权就发生了。
    st, hd, body = http_get(base, "/api/tests", uid="__nobody__")
    try:
        j = json.loads(body)
        foreign = (j.get("items") or j.get("tests") or []) if st == 200 else []
        f_total = j.get("total", len(foreign))
    except Exception:
        foreign, f_total = ["<parse-error>"], "?"
    check("陌生 uid 只能看到空集（不能读全库）",
          st == 200 and len(foreign) == 0,
          "status=%s total=%s 条数=%d" % (st, f_total, len(foreign)))

    st, hd, _ = http_get(base, "/api/health")
    check("响应头未回显框架（信息泄漏）", "uvicorn" not in hd.get("server", "").lower(),
          "server=%r" % hd.get("server", ""))

    # 收进程：启动器退出应当连根带走服务与客户端
    subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        proc.wait(timeout=25)
    except Exception:
        proc.kill()
    # Electron 退出 + PyInstaller 收尾在忙盘上可能超过 2.5s，给足窗口再判定残留
    time.sleep(5)
    leftovers = procs_under(pkg)
    check("启动器退出后本包无遗留进程", not leftovers, leftovers[:4])
    check("服务端口已释放", not port_open(port), "port %s open=%s" % (port, port_open(port)))
    if leftovers:
        # 断言已经记下失败；这里只做清理，避免下一次运行被上一轮的采集端窗口干扰。
        kill_listed(leftovers)

    return report(args, pkg)


def report(args, pkg):
    fails = [n for n, ok, _ in results if not ok]
    print("\n===== 发布包冒烟：%d PASS / %d FAIL ====="
          % (len(results) - len(fails), len(fails)))
    if fails:
        print("失败项：" + ", ".join(fails))
    if args.keep:
        print("解压目录保留: %s" % pkg)
    else:
        shutil.rmtree(pkg, ignore_errors=True)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
