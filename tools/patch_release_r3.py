#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 Release 正文从 r2 更新到 r3（r3 = r2 重打 app.asar 去掉测试机型注释，功能无差异）。

用法: python patch_release_r3.py <owner> <repo> <token>
"""
import json
import subprocess
import sys

R3 = {
    "name": "Perfara_Portable_20261021_r3.zip",
    "size": "220,695,786",
    "md5": "3cf0f08bd9ee854c593164bd04016a9d",
    "sha256": "cbcc2113d6f3a603a33cd67b47de671bd5ae69e58de62c25b57476ce9163817a",
    "asar_size": "1,729,773",
    "asar_md5": "ed55bfede632d1649a5732b906c516d2",
    "baseline": "a2fe3ce",
}

PAIRS_21 = [
    # 顶部通告：改指 r3，并说明 r2 为何也被取代
    ("> ⚠️ **数据安全通告（2026-10-21 21:30）**",
     "> ⚠️ **数据安全通告（2026-10-21 21:30 发布，22:50 更新）**"),
    ("**该资产已立即下架删除**。请改下载修复版 **`Perfara_Portable_20261021_r2.zip`**（220,695,879 B）：",
     "**该资产已立即下架删除**。请下载最新修复版 **`Perfara_Portable_20261021_r3.zip`**"
     f"（{R3['size']} B）："),
    ("> 打包脚本已修复（`tools/make_release_zip.py`，提交 `2790415`），后续产物不再含任何 `.db`。",
     "> 打包脚本已修复（`tools/make_release_zip.py`，提交 `2790415`），后续产物不再含任何 `.db`。\n"
     "> `_r2` 随后也被 `_r3` 取代并下架：`_r2` 的 `app.asar` 内还残留测试机型注释，\n"
     "> `_r3` 用脱敏后源码重打，功能无差异。"),
    # 章节标题
    ("## 追加修复（2026-10-21 晚，已含在 r2 包内）",
     "## 追加修复（2026-10-21 晚，已含在 r3 包内）"),
    ("### 7. 发布包数据安全（r2）", "### 7. 发布包数据安全"),
    # 下载指引
    ("**点下方资产 `Perfara_Portable_20261021_r2.zip` 直接下载**",
     f"**点下方资产 `{R3['name']}` 直接下载**"),
    # 产物校验表
    ("### 本次产物校验（r2）", "### 本次产物校验（r3）"),
    ("| `app.asar` | 1,731,099 B / 58 文件，MD5 `d50aba6125fe8a38ce437b07c9ef9ff7` |",
     f"| `app.asar` | {R3['asar_size']} B / 58 文件，MD5 `{R3['asar_md5']}` |"),
    ("| 发布 zip | 220,695,879 B，2950 条目 |",
     f"| 发布 zip | {R3['size']} B，2950 条目 |"),
    ("| 发布 zip MD5 | `1392d2ba6c713f9bc78c661a438626a5` |",
     f"| 发布 zip MD5 | `{R3['md5']}` |"),
    ("| 发布 zip SHA256 | `2fba51c2f8a296a1a624b91630a788134e462c00bae7bbd80c387b54b7ae87ad` |",
     f"| 发布 zip SHA256 | `{R3['sha256']}` |"),
    ("| 代码基线 | git `d564073`（含复测报告 / 打包修复 / 资产核查工具 / README 下载指引，main 已同步） |",
     f"| 代码基线 | git `{R3['baseline']}`（另含公开内容脱敏：机型/应用名占位化、截图重生、app.asar 重打，main 已同步） |"),
]

PAIRS_201 = [
    ("的 `Perfara_Portable_20261021_r2.zip`（已剔除数据库，210.5 MB）：",
     f"的 `{R3['name']}`（已剔除数据库，210.5 MB）："),
    ("> **请使用 [v2026.10.21](https://github.com/45944831/perfara/releases/tag/v2026.10.21)（r2 资产）**，本版本不再提供下载。",
     f"> **请使用 [v2026.10.21](https://github.com/45944831/perfara/releases/tag/v2026.10.21)（r3 资产）**，本版本不再提供下载。"),
]

TARGETS = {
    "v2026.10.21": PAIRS_21,
    "v2026.10.20.1": PAIRS_201,
}


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
    payload_path = "C:/Users/user/AppData/Local/Temp/release_r3_patch.json"

    for tag, pairs in TARGETS.items():
        rel = by_tag.get(tag)
        if not rel:
            print(f"[warn] 未找到 Release: {tag}")
            continue
        body = rel.get("body") or ""
        new = body
        applied, missed = 0, []
        for old, rep in pairs:
            if old in new:
                new = new.replace(old, rep)
                applied += 1
            else:
                missed.append(old[:40])
        if "r2.zip" in new or "_r2.zip" in new:
            print(f"[FAIL] {tag} 仍有 r2 引用")
            sys.exit(1)
        if new == body:
            print(f"[skip] {tag} 无需修改")
            continue
        with open(payload_path, "w", encoding="utf-8") as f:
            json.dump({"body": new}, f, ensure_ascii=False)
        res = api("PATCH", f"https://api.github.com/repos/{owner}/{repo}/releases/{rel['id']}",
                  token, payload_path)
        ok = "body" in res
        note = f"（{len(missed)} 条未命中: {missed}）" if missed else ""
        print(f"[{'OK' if ok else 'ERR'}] {tag} 应用 {applied} 处替换{note}"
              + ("" if ok else f" -> {res.get('message', res)}"))


if __name__ == "__main__":
    main()
