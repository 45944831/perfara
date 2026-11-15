#!/usr/bin/env python3
"""SPA 产物构建 / 记录 / 校验（frontend/ 只有构建产物，源码不在本仓库）。

背景见 BUILD.md：本仓库不含 Vue/Vite SPA 源码，也不含 dist/ 的版本控制副本，
dist/ 由外部源码检出后构建、再用 4 个 patch-spa-*.js 后处理得到。本脚本把这套
流程固化下来，并记录产物清单与哈希用于版本锁定。

子命令：
    build    从 PERFARA_SPA_SRC 指向的源码检出目录构建（npm ci && npm run build），
             复制产物到 dist/，依次应用 4 个 patch，最后写 build-info.json。
    record   不构建、不改动 dist/，只清点现有产物并写 build-info.json
             （明确标注「仅记录现有产物快照，未从源码构建」）。
    verify   按 build-info.json 校验 dist/ 产物哈希是否一致。

源码缺失时 build 会给出清晰报错并退出，绝不联网、不伪造构建、不改动 dist/。
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "dist")
INDEX = os.path.join(DIST, "index.html")
BUILD_INFO = os.path.join(HERE, "build-info.json")

# 应用顺序：先补 favicon / 去外链 / 加署名，最后跑绑死产物文件名的 bundle 补丁。
PATCHES = (
    "patch-spa-favicon.js",
    "patch-spa-offline-fonts.js",
    "patch-spa-attribution.js",
    "patch-spa-metric-config.js",
)


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _node():
    return os.environ.get("PERFARA_NODE") or shutil.which("node") or "node"


def _npm():
    return os.environ.get("PERFARA_NPM") or shutil.which("npm") or shutil.which("npm.cmd") or "npm"


def _version(cmd):
    try:
        return subprocess.check_output([cmd, "--version"], text=True, timeout=30).strip()
    except Exception:
        return None


def _scan_dist():
    out = []
    for root, dirs, files in os.walk(DIST):
        dirs.sort()
        for f in sorted(files):
            full = os.path.join(root, f)
            rel = os.path.relpath(full, HERE).replace("\\", "/")
            out.append({"path": rel, "bytes": os.path.getsize(full), "sha256": _sha256(full)})
    return out


def _write_info(mode, note):
    artifacts = _scan_dist()
    patches = []
    for p in PATCHES:
        full = os.path.join(HERE, p)
        patches.append({"file": p, "bytes": os.path.getsize(full), "sha256": _sha256(full)})
    info = {
        "schema": 1,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "mode": mode,
        "note": note,
        "source_doc": "BUILD.md",
        "spa_src_env": "PERFARA_SPA_SRC",
        "build_command": "npm ci && npm run build",
        "toolchain": {"node": _version(_node()), "npm": _version(_npm())},
        "patch_application_order": list(PATCHES),
        # patch 版本 = 脚本内容 sha256；改了脚本，这个值就会变。
        "patches": patches,
        "artifact_count": len(artifacts),
        "artifact_bytes_total": sum(a["bytes"] for a in artifacts),
        "artifacts": artifacts,
    }
    with open(BUILD_INFO, "w", encoding="utf-8", newline="\n") as f:
        json.dump(info, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return info


def _copy_tree(src_root, dst_root):
    """覆盖式复制产物；不删除 dst_root 里的既有文件（避免误删本地产物）。"""
    for root, dirs, files in os.walk(src_root):
        dirs.sort()
        rel = os.path.relpath(root, src_root)
        target = dst_root if rel == "." else os.path.join(dst_root, rel)
        os.makedirs(target, exist_ok=True)
        for f in sorted(files):
            shutil.copy2(os.path.join(root, f), os.path.join(target, f))


def cmd_build(args):
    src = os.environ.get("PERFARA_SPA_SRC", "").strip()
    if not src:
        print("[错误] 未设置 PERFARA_SPA_SRC：SPA 源码不在本仓库，无法从源码构建。", file=sys.stderr)
        print("      请把 PERFARA_SPA_SRC 指向 Vue/Vite 源码检出目录（含 package.json）；", file=sys.stderr)
        print("      若只想锁定现有产物，改用：python build_frontend.py record", file=sys.stderr)
        print("      本脚本不会联网、不会伪造构建、不会改动 dist/。", file=sys.stderr)
        return 2
    if not os.path.isdir(src) or not os.path.isfile(os.path.join(src, "package.json")):
        print(f"[错误] PERFARA_SPA_SRC 无效（目录不存在或缺少 package.json）：{src}", file=sys.stderr)
        return 2

    print(f"[build] SPA 源码目录: {src}")
    for argv in ([_npm(), "ci"], [_npm(), "run", "build"]):
        print(f"[build] $ {' '.join(argv)}")
        rc = subprocess.call(argv, cwd=src)
        if rc != 0:
            print(f"[错误] 命令失败（退出码 {rc}）：{' '.join(argv)}", file=sys.stderr)
            return 1

    src_dist = os.environ.get("PERFARA_SPA_DIST") or os.path.join(src, "dist")
    if not os.path.isfile(os.path.join(src_dist, "index.html")):
        print(f"[错误] 构建产物里找不到 index.html：{src_dist}", file=sys.stderr)
        print("      可用 PERFARA_SPA_DIST 指定 Vite 输出目录。", file=sys.stderr)
        return 1
    print(f"[build] 复制产物 {src_dist} -> {DIST}")
    os.makedirs(DIST, exist_ok=True)
    _copy_tree(src_dist, DIST)

    node = _node()
    for p in PATCHES:
        print(f"[patch] {p}")
        rc = subprocess.call([node, os.path.join(HERE, p)], cwd=HERE)
        if rc != 0:
            print(f"[错误] {p} 执行失败（退出码 {rc}）。", file=sys.stderr)
            print("       若报 ENOENT / anchor not found，多为 Vite 内容哈希文件名已变，", file=sys.stderr)
            print("       需同步更新 patch-spa-metric-config.js 里硬编码的产物文件名（见 BUILD.md）。", file=sys.stderr)
            return 1

    info = _write_info(
        "build",
        "由 PERFARA_SPA_SRC 检出目录执行 npm ci / npm run build 后应用 4 个 patch 生成。",
    )
    print(f"[build] 产物 {info['artifact_count']} 个 / {info['artifact_bytes_total']} 字节，已写入 build-info.json")
    return 0


def cmd_record(args):
    if not os.path.isfile(INDEX):
        print("[错误] 找不到 dist/index.html；record 只记录现有产物，不构建、不改动 dist/。", file=sys.stderr)
        return 2
    info = _write_info(
        "record-existing-artifacts",
        "SPA 源码不在本仓库；本次仅记录现有 dist/ 产物快照，未从源码构建、未改动任何产物。",
    )
    print(f"[record] 产物 {info['artifact_count']} 个 / {info['artifact_bytes_total']} 字节")
    print(f"[record] 已写入 {BUILD_INFO}")
    return 0


def cmd_verify(args):
    if not os.path.isfile(BUILD_INFO):
        print("[错误] 找不到 build-info.json，请先运行 record 或 build。", file=sys.stderr)
        return 2
    with open(BUILD_INFO, encoding="utf-8") as f:
        info = json.load(f)
    bad = []
    for a in info.get("artifacts", []):
        full = os.path.join(HERE, a["path"])
        if not os.path.isfile(full) or _sha256(full) != a["sha256"]:
            bad.append(a["path"])
    total = len(info.get("artifacts", []))
    for p in info.get("patches", []):
        full = os.path.join(HERE, p["file"])
        if not os.path.isfile(full) or _sha256(full) != p["sha256"]:
            bad.append(p["file"] + " (patch)")
    if bad:
        print(f"[verify] FAIL：{len(bad)} 项哈希不一致：")
        for b in bad:
            print("   -", b)
        return 1
    print(f"[verify] OK：{total} 个产物 + {len(info.get('patches', []))} 个 patch 哈希全部一致")
    return 0


def main():
    ap = argparse.ArgumentParser(description="Perfara SPA 产物构建 / 记录 / 校验（源码不在本仓库）")
    sub = ap.add_subparsers(dest="cmd")
    sub.add_parser("build", help="从 PERFARA_SPA_SRC 构建并应用 4 个 patch")
    sub.add_parser("record", help="仅记录现有 dist/ 产物快照，不构建")
    sub.add_parser("verify", help="校验 dist/ 产物与 build-info.json 是否一致")
    args = ap.parse_args()
    if args.cmd == "build":
        return cmd_build(args)
    if args.cmd == "record":
        return cmd_record(args)
    if args.cmd == "verify":
        return cmd_verify(args)
    print("[错误] 请指定子命令：build / record / verify。", file=sys.stderr)
    print("      SPA 源码不在本仓库；未设置 PERFARA_SPA_SRC 时不会尝试构建。", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
