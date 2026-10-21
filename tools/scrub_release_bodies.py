#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""脱敏 GitHub Release 正文（v2026.10.21 / v2026.10.20.1）。

只做文本替换，保留数据安全通告本身（下载过的人需要知情），
仅去掉真实机型（Android 13 中端机型）、系统皮肤（定制 ROM）与设备类型指代（iPhone）。
用法: python scrub_release_bodies.py <owner> <repo> <token>
"""
import json
import subprocess
import sys

REPLACEMENTS = [
    # 通告里描述泄露内容时的设备类型指代
    ("含测试项目、iPhone 性能数据、设备 UDID 与 3 个测试用户名",
     "含测试项目、iOS 性能数据、设备 UDID 与测试用户名"),
    ("含测试项目、iPhone 性能数据、设备 UDID 与测试用户名",
     "含测试项目、iOS 性能数据、设备 UDID 与测试用户名"),
    # 走查章节的真实机型
    ("用真机（Android 13 中端机型 / Android 13 / 定制 ROM）把",
     "用真机（Android 13 中端机型）把"),
    # 定制 ROM 指代 厂商 定制 ROM
    ("定制 ROM 13 上 `am start -p` 返回 `unable to resolve Intent`",
     "部分厂商定制 ROM 上 `am start -p` 返回 `unable to resolve Intent`"),
]

TARGET_TAGS = ("v2026.10.21", "v2026.10.20.1")

# 兜底扫描：替换后不允许再出现这些词
BANNED = ("generic", "定制 ROM", "iPhone", "examplegame", "vendor", "示例应用",
          "Player", "PCApp", "设备序列号", "00TQX33Z")


def api(method, url, token, payload=None):
    cmd = ["curl", "-s", "-X", method,
           "-H", f"Authorization: token {token}",
           "-H", "Accept: application/vnd.github+json", url]
    if payload is not None:
        cmd += ["--data-binary", "@" + payload]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    return json.loads(r.stdout) if r.stdout.strip() else {}


def main():
    owner, repo, token = sys.argv[1], sys.argv[2], sys.argv[3]
    rels = api("GET", f"https://api.github.com/repos/{owner}/{repo}/releases?per_page=20", token)
    by_tag = {r["tag_name"]: r for r in rels}
    payload_path = "C:/Users/user/AppData/Local/Temp/release_body_patch.json"

    for tag in TARGET_TAGS:
        rel = by_tag.get(tag)
        if not rel:
            print(f"[warn] 未找到 Release: {tag}")
            continue
        body = rel.get("body") or ""
        new = body
        for old, rep in REPLACEMENTS:
            new = new.replace(old, rep)
        hits = [k for k in BANNED if k in new]
        if hits:
            print(f"[FAIL] {tag} 替换后仍有敏感词: {hits}")
            sys.exit(1)
        if new == body:
            print(f"[skip] {tag} 无需修改")
            continue
        with open(payload_path, "w", encoding="utf-8") as f:
            json.dump({"body": new}, f, ensure_ascii=False)
        res = api("PATCH", f"https://api.github.com/repos/{owner}/{repo}/releases/{rel['id']}",
                  token, payload_path)
        ok = "body" in res
        print(f"[{'OK' if ok else 'ERR'}] {tag} (id={rel['id']}) body 已更新"
              + ("" if ok else f" -> {res.get('message', res)}"))


if __name__ == "__main__":
    main()
