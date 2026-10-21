#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把本地 webperf.db 复制一份并脱敏，用于重生 README 看板截图（不碰原库）。

脱敏范围：projects 应用名、test_runs/parsed_info 的 device 与 uid
（含 iPhone UDID）、web_users uid。性能数据本身不动（截图要用）。
"""
import os
import shutil
import sqlite3
import sys

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "perfara", "data", "webperf.db")

APP_BY_PLATFORM = {"ios": "示例应用-iOS", "pc": "示例应用-PC", "android": "示例应用-Android"}
DEVICE_MAP = {
    "iPhone": "iOS 设备",
    "Player.exe": "PC 应用",
    "PCApp.exe": "PC 应用",
    "Android 13 中端机型": "Android 真机",
}
# uid 前缀 -> 脱敏 uid（share_md5 与 owner_uid 同映射）
UID_MAP = {
    "wonderxu": "demo-user-6",
    "wonder": "demo-user-5",
    "bc142eca": "demo-user-1",
    "00TW44FZ": "demo-user-2",
    "00008101-": "demo-user-3",
    "5b7c3c7d": "demo-user-4",
    "perfara123": "demo123",
    "perefara123": "demo123",
    "perefara": "demo-user-7",
}


def map_uid(u):
    if not u:
        return u
    for pref, new in UID_MAP.items():
        if u.startswith(pref):
            return new
    return u


# raw_json / metric_blobs.content / summary_json 内的文本替换
JSON_TEXT_MAP = {
    "示例应用（com.example.app）": "示例应用-iOS",
    "com.example.app": "com.example.app",
    "示例应用": "示例应用-iOS",
    "com.example.game": "com.example.game",
    "iPhone": "iOS 设备",
    "Android 13 中端机型": "Android 真机",
    "generic": "generic",
    "Player.exe": "PC 应用",
    # 裸目录名（Tencent\Player\ 路径段），必须排在 "Player.exe" 之后
    "Player": "Player",
    "PCApp.exe": "PC 应用",
    "PCApp": "PCApp",
    "Tencent": "Vendor",
    "00008101-00017136347A001E": "demo-device",
    "00TW44FZ4DA59322E2B9853FE5CF9BBD": "demo-device",
    "00TQX33ZF2484E7F5A176AEE1BF87007": "demo-device",
    "wonderxu": "demo-user-6",
    "wonder": "demo-user-5",
    "perefara123": "demo123",
    "perfara123": "demo123",
    "perefara": "demo-user-7",
    "bc142eca84d21eb0b4ee583052817a0ec3f26f54ce50aedbf55cb3aa823e783f": "demo-user-1",
    "bc142eca84d21eb0b4ee583052817a0ec3f26f54": "demo-user-1",
    "5b7c3c7db419d89cede1b284d6016fdd5ee9201384f74d3ea510e1c939ec617a": "demo-user-4",
}


def scrub_json_text(s):
    if not s:
        return s
    for old, new in JSON_TEXT_MAP.items():
        if old in s:
            s = s.replace(old, new)
    return s


def main():
    dst = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.environ.get("TEMP", "/tmp"), "webperf_scrubbed.db")
    if os.path.exists(dst):
        os.remove(dst)
    shutil.copyfile(SRC, dst)
    con = sqlite3.connect(dst)
    cur = con.cursor()

    # projects：应用名按平台改通用名
    for row in cur.execute("select id, platform from projects").fetchall():
        pid, plat = row
        name = APP_BY_PLATFORM.get(plat, "示例应用")
        cur.execute("update projects set package_name=?, app_name=?, display_name=? where id=?",
                    (name, name, name, pid))

    # test_runs：device / owner_uid / share_md5
    for row in cur.execute("select id, device, owner_uid, share_md5 from test_runs").fetchall():
        tid, dev, uid, share = row
        cur.execute("update test_runs set device=?, owner_uid=?, share_md5=? where id=?",
                    (DEVICE_MAP.get(dev, "设备"), map_uid(uid), map_uid(share), tid))

    # parsed_info：device / package_name / app_name
    for row in cur.execute("select id, device, package_name, app_name, project_id from parsed_info").fetchall():
        pid2, dev, pkg, app, proj = row
        plat = cur.execute("select platform from projects where id=?", (proj,)).fetchone()
        name = APP_BY_PLATFORM.get(plat[0] if plat else "", "示例应用")
        cur.execute("update parsed_info set device=?, package_name=?, app_name=? where id=?",
                    (DEVICE_MAP.get(dev, "设备"), name, name, pid2))

    # web_users：uid
    for row in cur.execute("select id, uid from web_users").fetchall():
        cur.execute("update web_users set uid=? where id=?", (map_uid(row[1]), row[0]))

    # 原始 JSON 列：raw_json / metric_blobs.content / parsed_info.summary_json
    for row in cur.execute("select id, raw_json from test_runs").fetchall():
        cur.execute("update test_runs set raw_json=? where id=?", (scrub_json_text(row[1]), row[0]))
    for row in cur.execute("select id, content from metric_blobs").fetchall():
        cur.execute("update metric_blobs set content=? where id=?", (scrub_json_text(row[1]), row[0]))
    for row in cur.execute("select id, summary_json from parsed_info").fetchall():
        cur.execute("update parsed_info set summary_json=? where id=?", (scrub_json_text(row[1]), row[0]))

    con.commit()
    # 自检：不应再出现任何敏感词
    bad = []
    for t, cols in [("projects", ["package_name", "app_name", "display_name"]),
                    ("test_runs", ["device", "owner_uid", "share_md5", "raw_json"]),
                    ("metric_blobs", ["content"]),
                    ("parsed_info", ["device", "package_name", "app_name", "summary_json"]),
                    ("web_users", ["uid"])]:
        for c in cols:
            for r in cur.execute(f"select {c} from {t}").fetchall():
                v = str(r[0])
                for kw in ("generic", "examplegame", "vendor", "示例应用", "Player", "PCApp",
                           "iPhone", "00008101", "00TW44", "wonder", "bc142eca", "5b7c3c7d"):
                    if kw in v:
                        bad.append((t, c, v[:40]))
    con.close()
    if bad:
        print("[FAIL] 仍有敏感残留:", bad)
        sys.exit(1)
    print("脱敏完成 ->", dst)
    print("核对: projects/test_runs/parsed_info/web_users 无敏感词残留")


if __name__ == "__main__":
    main()
