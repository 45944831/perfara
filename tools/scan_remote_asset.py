"""不下载整个发布包，用 HTTP Range 只取需要的 zip 条目来核查敏感残留。

原理：zip 的中央目录在文件尾部，先用 Range 取尾部解析出条目偏移，
再只取目标条目的压缩字节解压。220MB 的包只需拉几 KB。
"""
import io
import json
import os
import re
import ssl
import struct
import sys
import urllib.request
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sensitive_patterns  # noqa: E402

TARGETS = (
    'collector/resources/reports/data.js',
    'collector/resources/reports/data.json',
)
TAIL = 128 * 1024

CTX = ssl._create_unverified_context()


def get(url, token, start=None, end=None):
    req = urllib.request.Request(url)
    req.add_header('Authorization', 'token ' + token)
    req.add_header('Accept', 'application/octet-stream')
    if start is not None:
        req.add_header('Range', 'bytes=%d-%d' % (start, end))
    with urllib.request.urlopen(req, timeout=90, context=CTX) as r:
        return r.read()


def locate_central_directory(base_url, token, size):
    """取尾部 128KB 找 EOCD；中央目录比尾部还大时再单独取一次 CD 区间。"""
    tail_start = size - TAIL
    tail = get(base_url, token, tail_start, size - 1)
    eocd = tail.rfind(b'PK\x05\x06')
    if eocd < 0:
        raise RuntimeError('EOCD not found in tail')
    cd_size, cd_offset = struct.unpack('<II', tail[eocd + 12:eocd + 20])
    if cd_offset >= tail_start and len(tail) == TAIL:
        return tail[cd_offset - tail_start:], cd_size, cd_offset
    # 中央目录超出尾部窗口（条目多、名字长），单独拉
    cd = get(base_url, token, cd_offset, cd_offset + cd_size - 1)
    if len(cd) != cd_size:
        raise RuntimeError('short read cd: %d != %d' % (len(cd), cd_size))
    return cd, cd_size, cd_offset


def parse_central_directory(cd):
    """解析中央目录，返回 {文件名: (local_offset, comp_size, method)}。"""
    entries = {}
    pos = 0
    while pos + 46 <= len(cd) and cd[pos:pos + 4] == b'PK\x01\x02':
        (method,) = struct.unpack('<H', cd[pos + 10:pos + 12])
        (comp_size,) = struct.unpack('<I', cd[pos + 20:pos + 24])
        (name_len,) = struct.unpack('<H', cd[pos + 28:pos + 30])
        (extra_len,) = struct.unpack('<H', cd[pos + 30:pos + 32])
        (cmt_len,) = struct.unpack('<H', cd[pos + 32:pos + 34])
        (local_off,) = struct.unpack('<I', cd[pos + 42:pos + 46])
        name = cd[pos + 46:pos + 46 + name_len].decode('utf-8', 'ignore')
        entries[name] = (local_off, comp_size, method)
        pos += 46 + name_len + extra_len + cmt_len
    return entries


def extract_entry(base_url, token, size, name, local_off, comp_size, method):
    """取本地文件头（30 字节 + 文件名/扩展区）后再取数据区。"""
    head = get(base_url, token, local_off, min(local_off + 1024, size - 1))
    if head[:4] != b'PK\x03\x04':
        raise RuntimeError('bad local header for ' + name)
    name_len, extra_len = struct.unpack('<HH', head[26:30])
    data_start = local_off + 30 + name_len + extra_len
    raw = get(base_url, token, data_start, data_start + comp_size - 1)
    if len(raw) != comp_size:
        raise RuntimeError('short read %s: %d != %d' % (name, len(raw), comp_size))
    if method == 0:
        return raw
    return zlib.decompress(raw, -15)


def list_releases(token):
    url = 'https://api.github.com/repos/45944831/perfara/releases?per_page=30'
    req = urllib.request.Request(url)
    req.add_header('Authorization', 'token ' + token)
    req.add_header('Accept', 'application/vnd.github+json')
    with urllib.request.urlopen(req, timeout=60, context=CTX) as r:
        return json.loads(r.read())


def main():
    if len(sys.argv) < 2:
        print('usage: scan_remote_asset.py <github_token> [--patterns FILE]')
        return 2
    token = sys.argv[1]
    explicit = None
    if '--patterns' in sys.argv:
        explicit = sys.argv[sys.argv.index('--patterns') + 1]
    patterns = sensitive_patterns.load(explicit)
    print('使用 %d 条模式\n' % len(patterns))

    for r in list_releases(token):
        for a in r['assets']:
            tag, aid, name, size = r['tag_name'], a['id'], a['name'], a['size']
            print('=== %s / %s (%d B) ===' % (tag, name, size))
            base = 'https://api.github.com/repos/45944831/perfara/releases/assets/%d' % aid
            try:
                cd, cd_size, cd_offset = locate_central_directory(base, token, size)
                entries = parse_central_directory(cd)
                print('  条目总数: %d (中央目录 %d B)' % (len(entries), cd_size))
                any_hit = False
                for t in TARGETS:
                    if t not in entries:
                        print('  MISS 条目缺失: %s' % t)
                        continue
                    off, csz, method = entries[t]
                    blob = extract_entry(base, token, size, t, off, csz, method)
                    txt = blob.decode('utf-8', 'ignore')
                    hits = [lab for lab, pat in patterns if pat.search(txt)]
                    if hits:
                        any_hit = True
                        print('  HIT %s -> %s' % (t, ', '.join(hits)))
                    else:
                        print('  OK  %s (%.1f KB, 0 命中)' % (t, len(blob) / 1024.0))
                if not any_hit:
                    print('  结论: 目标条目干净（仅代表这两个文件）')
            except Exception as e:
                print('  ERROR: %r' % (e,))
            print()


if __name__ == '__main__':
    sys.exit(main())
