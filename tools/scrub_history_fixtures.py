#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""脱敏本地报告库夹具（perfara/collector/resources/reports/history/，已被 .gitignore）。

该目录是运行期数据、不入库，但 compare_lanes_test.js 等离线测试依赖它，
且文件名/内容含真实机型与应用名。统一处理：
  1. 文件名 20261020-HHMMSS-厂商_generic.{js,json} -> ...-DEVICE_X.{js,json}
  2. index.json / index.js 的 id、file、deviceName、deviceId、app
  3. 各 payload（.js 的 var data= 与 .json）内 device.name/bundleId/appName/deviceId

幂等：已是 DEVICE_ 开头或已脱敏值的直接跳过。
"""
import json
import os
import re
import sys

HIST = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    "perfara", "collector", "resources", "reports", "history")
HIST = os.path.abspath(HIST)

# 时间戳 -> 测试用的脱敏 ID 后缀（与 perfara/tests/deep/compare_lanes_test.js 的 IDS 对应）
TS_MAP = {
    "093156": "DEVICE_A",
    "143158": "DEVICE_B",
    "145215": "DEVICE_C",
    "145531": "DEVICE_D",
}

TEXT_MAP = [
    ("com.example.game", "com.example.game"),
    ("Android 13 中端机型", "Android 真机"),
    ("generic", "generic"),
    ("设备序列号", "demo-device-001"),
]


def norm_id(m):
    """把 id/file 里的 -厂商_generic 或 -厂商_generic（旧版误伤形态）归一为 -DEVICE_X"""
    ts = m.group(1)
    suf = TS_MAP.get(ts[9:])
    return f"{ts}-{suf}" if suf else m.group(0)


ID_RE = r"(\d{8}-\d{6})-厂商_(?:generic|generic)"


def scrub_text(s):
    for old, new in TEXT_MAP:
        s = s.replace(old, new)
    return s


def scrub_json_obj(o):
    """递归脱敏 JSON 值里的敏感串（键名不动）。"""
    if isinstance(o, str):
        return scrub_text(o)
    if isinstance(o, list):
        return [scrub_json_obj(x) for x in o]
    if isinstance(o, dict):
        return {k: scrub_json_obj(v) for k, v in o.items()}
    return o


def main():
    if not os.path.isdir(HIST):
        print("history 目录不存在，跳过:", HIST)
        return
    renamed, scrubbed = 0, 0

    # 1) 重命名 payload 文件（.js / .json 成对）
    for fn in sorted(os.listdir(HIST)):
        m = re.match(r"^(\d{8}-\d{6})-厂商_generic\.(js|json)$", fn)
        if not m:
            continue
        ts, ext = m.group(1), m.group(2)
        suf = TS_MAP.get(ts[9:])  # HHMMSS
        if not suf:
            print("  [warn] 未登记的时间戳，跳过:", fn)
            continue
        new = f"{ts}-{suf}.{ext}"
        os.rename(os.path.join(HIST, fn), os.path.join(HIST, new))
        renamed += 1
        print("  rename:", fn, "->", new)

    # 2) index.json：先归一 id/file，再整棵树脱敏值
    p = os.path.join(HIST, "index.json")
    if os.path.exists(p):
        raw = open(p, encoding="utf-8").read()
        data = json.loads(raw)
        data = scrub_json_obj(data)
        for it in data:
            it["id"] = re.sub(ID_RE, norm_id, it.get("id", ""))
            it["file"] = re.sub(ID_RE, norm_id, it.get("file", ""))
        open(p, "w", encoding="utf-8").write(json.dumps(data, ensure_ascii=False, indent=1))
        scrubbed += 1
        print("  scrubbed: index.json")

    # 3) index.js：var reportIndex = [...]
    p = os.path.join(HIST, "index.js")
    if os.path.exists(p):
        raw = open(p, encoding="utf-8").read()
        out = re.sub(ID_RE, norm_id, raw)
        out = scrub_text(out)
        if out != raw:
            open(p, "w", encoding="utf-8").write(out)
            scrubbed += 1
            print("  scrubbed: index.js")

    # 4) 各 payload（已是 DEVICE_ 名）
    for fn in sorted(os.listdir(HIST)):
        if not re.match(r"^\d{8}-\d{6}-DEVICE_[A-D]\.(js|json)$", fn):
            continue
        p = os.path.join(HIST, fn)
        raw = open(p, encoding="utf-8").read()
        if fn.endswith(".json"):
            data = scrub_json_obj(json.loads(raw))
            out = json.dumps(data, ensure_ascii=False, indent=1)
        else:
            # var data = {...}; 形式：只替换值，不动结构
            out = scrub_text(raw)
        if out != raw:
            open(p, "w", encoding="utf-8").write(out)
            scrubbed += 1
            print("  scrubbed:", fn)

    # 自检
    bad = []
    kws = ("generic", "examplegame", "vendor", "设备序列号", "示例应用")
    for fn in sorted(os.listdir(HIST)):
        p = os.path.join(HIST, fn)
        if not os.path.isfile(p):
            continue
        try:
            v = open(p, encoding="utf-8").read()
        except Exception:
            continue
        for kw in kws:
            if kw in v:
                bad.append((fn, kw))

    # 结构自检：4 个 DEVICE_X id 齐全，且索引引用的文件都在
    p = os.path.join(HIST, "index.json")
    if os.path.exists(p):
        idx = json.load(open(p, encoding="utf-8"))
        ids = [it.get("id") for it in idx]
        for suf in TS_MAP.values():
            if not any(i and i.endswith("-" + suf) for i in ids):
                bad.append(("index.json", "缺 id 后缀 " + suf))
        for it in idx:
            f = it.get("file", "")
            fp = os.path.join(os.path.dirname(HIST), f)  # file 形如 history/xxx.js
            if f and not os.path.exists(fp):
                bad.append(("index.json", "引用文件不存在: " + f))

    if bad:
        print("[FAIL] 仍有敏感残留/结构问题:", bad)
        sys.exit(1)
    print(f"完成: 改名 {renamed} 个文件, 脱敏 {scrubbed} 个文件, 自检通过 -> {HIST}")


if __name__ == "__main__":
    main()
