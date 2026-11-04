"""Perfara 版本号规范（发版侧）。

必须与 _client_src/app/src/version-scheme.js 保持完全一致：

    1.0 → 1.1 → … → 1.9 → 1.10 → 2.0 → … → 2.10 → 3.0 → …

次版本 0~10（MINOR_MAX=10），用满后主版本进位。历史日期式版本
（v2026.11.02 / 20261102）是旧编号，只识别不比较。

独立成模块是为了让「发版脚本」和「深度回归测试」共用同一套规则，
避免脚本里手写一份、测试里再手写一份，改规则时两边漂移。
"""
import re

MINOR_MAX = 10
MAX_SEQUENCE = 200
VERSION_RE = re.compile(r'^[vV]?(\d{1,4})\.(\d{1,2})$')
# 历史日期式标识：v2026.11.02 / v2026.10.20.1 / v2026.10.21_r3 / 20261102
LEGACY_RE = re.compile(r'^[vV]?(?:(?:19|20)\d{2}[.\-_]|\d{8}(?:[.\-_]|$))')


def parse_version(v):
    """返回 (major, minor) 或 None；拒绝主版本 0 / 次版本 >10 / 前导零 / 三段式 / 日期式。"""
    m = VERSION_RE.match(str(v if v is not None else '').strip())
    if not m:
        return None
    major, minor = int(m.group(1)), int(m.group(2))
    if major < 1 or minor > MINOR_MAX:
        return None
    if str(major) != m.group(1) or str(minor) != m.group(2):
        return None
    return major, minor


def is_valid_version(v):
    return parse_version(v) is not None


def is_legacy_version(v):
    return bool(LEGACY_RE.match(str(v if v is not None else '').strip()))


def normalize_version(v):
    p = parse_version(v)
    return '%d.%d' % p if p else ''


def to_version_tag(v):
    p = parse_version(v)
    return 'v%d.%d' % p if p else None


def compare_versions(a, b):
    A, B = parse_version(a), parse_version(b)
    if not A and not B:
        return 0
    if not A:
        return -1
    if not B:
        return 1
    return (A > B) - (A < B)


def is_newer_version(latest, current):
    if not is_valid_version(latest) or not is_valid_version(current):
        return False
    return compare_versions(latest, current) > 0


def next_version(v):
    p = parse_version(v)
    if not p:
        return None
    major, minor = p
    return '%d.%d' % (major, minor + 1) if minor < MINOR_MAX else '%d.0' % (major + 1)


def version_sequence(start, count):
    out = []
    cur = normalize_version(start)
    for _ in range(min(max(int(count or 0), 0), MAX_SEQUENCE)):
        if not cur:
            break
        out.append(cur)
        cur = next_version(cur)
    return out
