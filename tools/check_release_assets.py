#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用 HTTP Range 验证 GitHub Release 历史 zip 资产是否包含 data/webperf.db。

不下载整个 210MB：只拉文件尾部定位 EOCD -> 中央目录 -> 条目名列表。
若命中 data/webperf.db，再 Range 拉该文件前 16 字节确认是 SQLite 主库。
"""
import json
import os
import struct
import sys
import urllib.request

RELS = [
    ("v2026.10.21", "Perfara_Portable_20261021.zip",
     "https://github.com/45944831/perfara/releases/download/v2026.10.21/Perfara_Portable_20261021.zip"),
    ("v2026.10.20.1", "Perfara_Portable_20261020_r6.zip",
     "https://github.com/45944831/perfara/releases/download/v2026.10.20.1/Perfara_Portable_20261020_r6.zip"),
    ("v2026.10.20", "Perfara_Portable_20261020.zip",
     "https://github.com/45944831/perfara/releases/download/v2026.10.20/Perfara_Portable_20261020.zip"),
]

EOCD_SIG = b"PK\x05\x06"
CDH_SIG = b"PK\x01\x02"


def http_range(url, start, end):
    req = urllib.request.Request(url, headers={"Range": f"bytes={start}-{end}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def get_size(url):
    req = urllib.request.Request(url, method="HEAD")
    with urllib.request.urlopen(req, timeout=30) as r:
        return int(r.headers["Content-Length"])


def check(url):
    size = get_size(url)
    # 1) 拉尾部找 EOCD（EOCD 最长 22 + 65535 注释，取 128KB 足够）
    tail = http_range(url, max(0, size - 131072), size - 1)
    pos = tail.rfind(EOCD_SIG)
    if pos < 0:
        return size, None, "EOCD not found"
    eocd = tail[pos:pos + 22]
    (_, _, _, _, _, _, cd_size, cd_off, comment_len) = struct.unpack("<4s4H2LH", eocd[:20] + eocd[20:22])
    total_entries = struct.unpack("<H", eocd[10:12])[0]
    # 2) 拉中央目录
    cd = http_range(url, cd_off, cd_off + cd_size - 1)
    # 3) 遍历条目
    names = []
    p = 0
    while p + 46 <= len(cd):
        if cd[p:p + 4] != CDH_SIG:
            break
        (_, _, _, _, _, _, _, csize, usize, nlen, elen, clen, _, _, _, _, off) = struct.unpack(
            "<4s6H3L5H2L", cd[p:p + 46])
        name = cd[p + 46:p + 46 + nlen].decode("utf-8", "replace")
        names.append((name, csize, usize, off))
        p += 46 + nlen + elen + clen
    return size, names, None


def main():
    results = {}
    for tag, fname, url in RELS:
        print(f"=== {tag} / {fname} ===", flush=True)
        try:
            size, names, err = check(url)
            if err:
                print(f"  [ERROR] {err}")
                results[tag] = "error"
                continue
            print(f"  大小 {size/1048576:.1f}MB, CD 条目 {len(names)}")
            hit = [n for n in names if "webperf" in n[0].lower() or n[0].endswith(".db")]
            dbs = [n for n in names if ".db" in n[0]]
            if hit:
                for n in hit:
                    print(f"  *** 命中: {n[0]}  usize={n[1]}")
                    # 拉前 16 字节确认 SQLite 头
                    head = http_range(url, n[2], n[2] + 15)
                    print(f"      文件头: {head[:16]!r}")
                results[tag] = "HAS_DB"
            else:
                print("  [clean] 无 .db / webperf 条目")
                results[tag] = "clean"
            # data/ 目录内容
            dataf = [n[0] for n in names if n[0].startswith("data/")]
            print(f"  data/ 条目: {dataf}")
        except Exception as e:  # noqa: BLE001
            print(f"  [EXC] {type(e).__name__}: {e}")
            results[tag] = "error"
    print("\nSUMMARY:", json.dumps(results, ensure_ascii=False))


if __name__ == "__main__":
    main()
