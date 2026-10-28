#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从开发库生成**可随包分发**的种子数据库。

背景（2026-10-27）：
    `perfara_server.spec` / `perfara.spec` 原先把 `data/webperf.db` 直接编进 exe，
    首次启动由 `backend.paths.seed_database()` 复制给用户。而那份库是开发机的
    真实数据 —— 含真实设备序列号、真机机型、真实应用包名、真实用户 uid。
    zip 层审计（剔 data/ + 扫文本条目）看不见它，因为它被压进了 PyInstaller 归档。

本工具把它拆成两条路径：
    输入  perfara/data/webperf.db      开发库（gitignore，绝不外发）
    输出  perfara/_seed/webperf.db     脱敏后的种子库（唯一打包输入）

**本文件不含任何真实值** —— 敏感词全部在运行时从库自身采集（`harvest_tokens`）：
    projects 的包名/应用名/展示名、test_runs 与 parsed_info 的 device、
    web_users 与 owner_uid 的 uid，以及由这些值切出的词元（如包名末段、机型与品牌）。
这样即使换了设备、换了被测应用，也无需改代码；也不会把真实值写进公开仓库。

用法：
    python tools/make_seed_db.py                # 生成并自检
    python tools/make_seed_db.py --check-only   # 只自检现有种子库

自检 = release/_audit/sensitive_patterns.txt（项目审计同款）+ 通用兜底规则
     + 「原库采出的词元一个都不能残留」这一条硬断言。
任一不过即退出码 1，此时不要打包。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "perfara", "data", "webperf.db")
OUT = os.path.join(ROOT, "perfara", "_seed", "webperf.db")

sys.path.insert(0, os.path.join(ROOT, "tools"))
import sensitive_patterns as sp  # noqa: E402

# ── 结构化替换值（通用占位，不含真实信息）──────────────────────────────────
APP_BY_PLATFORM = {
    "ios": "示例应用-iOS",
    "ios_gpu": "示例应用-iOS",
    "pc": "示例应用-PC",
    "android": "示例应用-Android",
}
DEVICE_BY_CATEGORY = {
    "ios": "iOS 设备",
    "ios_gpu": "iOS 设备",
    "pc": "PC 应用",
    "android": "Android 设备",
}

# ── 通用正则：与具体值无关的兜底 ────────────────────────────────────────────
REGEX_RULES = [
    # 设备序列号形态（14 位以上大写字母数字）。
    # ⚠️ 必须要求「同时含字母与数字」：只写 \b[A-Z0-9]{14,}\b 会把 JSON 里的浮点尾数
    # 当成序列号 —— `24.218338859221145` 的 `.218338859221145` 正好满足「. 后是 \b +
    # 15 位数字」，替换成 `24.DEMO-SERIAL` 后整段不再是合法 JSON。
    # 后果实测过：种子库里 44 处 JSON 损坏，便携包首启即「详情 500 + 列表无均值」。
    (re.compile(r"\b(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*[0-9])[A-Z0-9]{14,}\b"), "DEMO-SERIAL"),
    # iOS UDID：8-16-8 十六进制
    (re.compile(r"\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}\b"), "DEMO-UDID"),
    # 非示例包名（保留 com.example.* / com.android.*）
    (re.compile(r"\bcom\.(?!example\.|android\.)[A-Za-z0-9_]+\.[A-Za-z0-9_.]+"), "com.example.demo"),
    # PC 侧进程名
    (re.compile(r"\b[A-Za-z][A-Za-z0-9_.-]*\.exe\b"), "demo.exe"),
]
SAFE_PKG = ("com.example.", "com.android.")

# 采集词元时忽略的常见词：避免把 "iPhone" / "com" 这类通用片段也当成敏感词，
# 否则会把正常文案一起抹掉（而且替换成占位符后反而看不出问题）。
TOKEN_STOPWORDS = {
    "com", "org", "net", "cn", "www", "app", "apps", "exe", "demo", "test",
    "iphone", "ipad", "android", "ios", "pc", "generic", "unknown", "none",
    "null", "true", "false", "device", "devices", "user", "admin", "root",
    "package", "process", "name", "label", "main", "index", "data",
}
MIN_TOKEN_LEN = 5


def tables(cur):
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    return [r[0] for r in cur.fetchall()]


def text_columns(cur, table):
    cur.execute("PRAGMA table_info(%s)" % table)
    return [r[1] for r in cur.fetchall()]


def harvest_tokens(cur) -> dict:
    """从源库采集需要抹掉的值。返回 {token: 占位符}，按长度降序。

    不写死任何真实值 —— 换设备/换被测应用后无需改代码。
    """
    raw = set()

    def add(v):
        if isinstance(v, str) and v.strip():
            raw.add(v.strip())

    for sql in (
        "SELECT package_name, app_name, display_name FROM projects",
        "SELECT device FROM test_runs",
        "SELECT device, package_name, app_name FROM parsed_info",
        "SELECT uid FROM web_users",
        "SELECT owner_uid, para1, para2 FROM test_runs",
    ):
        try:
            for row in cur.execute(sql).fetchall():
                for v in row:
                    add(v)
        except sqlite3.Error:
            continue

    tokens = {}
    for v in raw:
        tokens[v] = "DEMO"
        # 包名末段（com.vendor.app -> vendor / app）与空格分隔的机型品牌
        for seg in re.split(r"[.\s/\\:_-]+", v):
            seg = seg.strip()
            if len(seg) < MIN_TOKEN_LEN:
                continue
            if seg.lower() in TOKEN_STOPWORDS:
                continue
            if seg.lower().startswith("com"):
                continue
            tokens.setdefault(seg, "DEMO")
    # 长的先替换，避免短词先吃掉长词的一部分
    return dict(sorted(tokens.items(), key=lambda kv: -len(kv[0])))


def scrub_text(s, tokens):
    if not isinstance(s, str) or not s:
        return s
    for old, new in tokens.items():
        if old in s:
            s = s.replace(old, new)
    for rx, new in REGEX_RULES:
        def _sub(m):
            hit = m.group(0)
            if any(hit.startswith(p) for p in SAFE_PKG):
                return hit
            if hit.startswith(("DEMO-", "demo.", "com.example.")):
                return hit
            return new
        s = rx.sub(_sub, s)
    return s


def _scrub_json_node(node, tokens):
    """只碰 JSON 里的字符串叶子；数字、布尔、null 与结构一律原样保留。"""
    if isinstance(node, dict):
        return {scrub_text(k, tokens) if isinstance(k, str) else k:
                _scrub_json_node(v, tokens) for k, v in node.items()}
    if isinstance(node, list):
        return [_scrub_json_node(v, tokens) for v in node]
    if isinstance(node, str):
        return scrub_text(node, tokens)
    return node


def scrub_value(val, tokens):
    """脱敏一个列值。

    JSON 文本（metric_blobs.content / test_runs.summary / raw_json / summary_json 等）
    先解析、只改字符串叶子、再回写 —— 对整段 JSON 文本做正则是危险的：
    任何「数字形态」的兜底规则都会撞上浮点尾数或时间戳，把数据改成非法 JSON。
    """
    if isinstance(val, str) and val[:1] in ("{", "["):
        try:
            obj = json.loads(val)
        except Exception:
            obj = None
        if obj is not None:
            return json.dumps(_scrub_json_node(obj, tokens), ensure_ascii=False)
    return scrub_text(val, tokens)


def build_uid_map(cur) -> dict:
    """把库里出现的所有 uid 顺序映射成唯一演示 id。

    不能一律映射成同一个值：`web_users.uid` 有 UNIQUE 约束，会撞车。
    也不能用 hash 前缀（短 uid 可字典反推），顺序编号最干净。
    """
    seen = []
    for sql in ("SELECT uid FROM web_users ORDER BY id",
                "SELECT owner_uid FROM test_runs ORDER BY id",
                "SELECT para1 FROM test_runs ORDER BY id"):
        try:
            for (v,) in cur.execute(sql).fetchall():
                if isinstance(v, str) and v.strip() and v not in seen:
                    seen.append(v.strip())
        except sqlite3.Error:
            continue
    return {u: "demo-user-%d" % (i + 1) for i, u in enumerate(seen)}


def map_uid(u, uid_map):
    if not u:
        return u
    s = str(u)
    if s in uid_map:
        return uid_map[s]
    if re.fullmatch(r"[0-9a-f]{32,}", s):
        return "demo-user-x"
    return "demo-user"


def build():
    if not os.path.isfile(SRC):
        print("[error] 找不到开发库：%s" % SRC)
        return 1
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    shutil.copyfile(SRC, OUT)
    con = sqlite3.connect(OUT)
    cur = con.cursor()

    tokens = harvest_tokens(cur)
    uid_map = build_uid_map(cur)
    print("从源库采集敏感词元 %d 个（长度 %d~%d，值不打印）"
          % (len(tokens), min(map(len, tokens)) if tokens else 0, max(map(len, tokens)) if tokens else 0))
    print("uid 映射 %d 条" % len(uid_map))

    # 1) projects：应用标识整体换掉（泄漏面最大的一处）
    for pid, plat in cur.execute("SELECT id, platform FROM projects").fetchall():
        name = APP_BY_PLATFORM.get((plat or "").lower(), "示例应用")
        cur.execute(
            "UPDATE projects SET package_name=?, app_name=?, display_name=? WHERE id=?",
            (name, name, name, pid),
        )

    # 2) test_runs：device / owner_uid / para1 / para2
    for tid, dev, uid, p1, p2, cat in cur.execute(
        "SELECT id, device, owner_uid, para1, para2, category FROM test_runs"
    ).fetchall():
        cur.execute(
            "UPDATE test_runs SET device=?, owner_uid=?, para1=?, para2=? WHERE id=?",
            (
                DEVICE_BY_CATEGORY.get((cat or "").lower(), "设备"),
                map_uid(uid, uid_map),
                map_uid(p1, uid_map),
                "perefara" if (p2 or "") else p2,
                tid,
            ),
        )

    # 3) parsed_info：device / package_name / app_name
    for rid, dev, pkg, app, proj in cur.execute(
        "SELECT id, device, package_name, app_name, project_id FROM parsed_info"
    ).fetchall():
        row = cur.execute("SELECT platform FROM projects WHERE id=?", (proj,)).fetchone()
        plat = ((row[0] if row else "") or "").lower()
        name = APP_BY_PLATFORM.get(plat, "示例应用")
        cur.execute(
            "UPDATE parsed_info SET device=?, package_name=?, app_name=? WHERE id=?",
            (DEVICE_BY_CATEGORY.get(plat, "设备"), name, name, rid),
        )

    # 4) web_users：uid
    for wid, uid in cur.execute("SELECT id, uid FROM web_users").fetchall():
        cur.execute("UPDATE web_users SET uid=? WHERE id=?", (map_uid(uid, uid_map), wid))

    # 5) 演示快照：剔除指向已不存在 test_runs 的行（否则演示账号会 404）
    cur.execute("SELECT id FROM test_runs")
    alive = {r[0] for r in cur.fetchall()}
    cur.execute("SELECT test_run_id FROM perfara_demo_snapshot")
    stale = [r[0] for r in cur.fetchall() if r[0] not in alive]
    for sid in stale:
        cur.execute("DELETE FROM perfara_demo_snapshot WHERE test_run_id=?", (sid,))

    # 6) 兜底：所有表的文本列统一过一遍（词元替换 + 通用正则）
    touched = 0
    for t in tables(cur):
        for col in text_columns(cur, t):
            try:
                rows = cur.execute("SELECT rowid, %s FROM %s" % (col, t)).fetchall()
            except sqlite3.Error:
                continue
            for rid, val in rows:
                new = scrub_value(val, tokens)
                if new != val:
                    cur.execute("UPDATE %s SET %s=? WHERE rowid=?" % (t, col), (new, rid))
                    touched += 1

    con.commit()
    # 删过/改过的页不会归还内容，只是被标成 free page：SQL 查不到，但直接 grep 二进制
    # 能把旧值捞出来。种子库是要进 git 的，所以必须 VACUUM 重建成一个干净文件。
    con.isolation_level = None
    con.execute("VACUUM")
    con.close()
    print("种子库已生成: %s" % OUT)
    print("  来源: %s" % SRC)
    print("  文本列改写: %d 处" % touched)
    if stale:
        print("  演示快照清理: %d 条（指向已不存在的记录）" % len(stale))
    return 0


def check():
    if not os.path.isfile(OUT):
        print("[error] 种子库不存在，请先运行 make_seed_db.py")
        return 1
    con = sqlite3.connect(OUT)
    cur = con.cursor()

    # 自检一：项目审计规则
    pats = sp.load()
    hits, scanned = [], 0
    for t in tables(cur):
        for col in text_columns(cur, t):
            try:
                rows = cur.execute("SELECT %s FROM %s" % (col, t)).fetchall()
            except sqlite3.Error:
                continue
            for (val,) in rows:
                if not isinstance(val, str) or not val:
                    continue
                scanned += 1
                for label, rx in pats:
                    for m in rx.finditer(val):
                        hits.append((t, col, label, m.group(0)))

    # 自检二：从**源库**采出的词元，在产物里一个都不能剩
    src_tokens = {}
    if os.path.isfile(SRC):
        scon = sqlite3.connect(SRC)
        src_tokens = harvest_tokens(scon.cursor())
        scon.close()
    residue = []
    if src_tokens:
        for t in tables(cur):
            for col in text_columns(cur, t):
                try:
                    rows = cur.execute("SELECT %s FROM %s" % (col, t)).fetchall()
                except sqlite3.Error:
                    continue
                for (val,) in rows:
                    if not isinstance(val, str) or not val:
                        continue
                    for tok in src_tokens:
                        if tok in val:
                            residue.append((t, col, tok))

    # 自检三：演示快照一致性
    cur.execute("SELECT id FROM test_runs")
    alive = {r[0] for r in cur.fetchall()}
    cur.execute("SELECT test_run_id FROM perfara_demo_snapshot")
    stale = [r[0] for r in cur.fetchall() if r[0] not in alive]
    schema_sql = " ".join(r[0] for r in cur.execute(
        "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL").fetchall())
    con.close()

    # 自检四：整文件字节扫描。前三条都只走 SQL，看不到 free page / 旧版本页里
    # 残留的字节 —— 2026-10-28 就是这样在干净种子库里捞出真机机型与真实包名的。
    # 建表语句本身会带上 `test_runs` 这类词，源库恰好也有 `test` 这种取值，
    # 那是表名不是残留，所以跳过出现在 DDL 里的词元。
    raw = open(OUT, "rb").read().decode("utf-8", errors="replace")
    byte_hits = []
    for label, rx in pats:
        for m in rx.finditer(raw):
            byte_hits.append(("(bytes)", "<rule>", label, m.group(0)))
    for tok in src_tokens:
        if tok in raw and tok not in schema_sql:
            byte_hits.append(("(bytes)", "<token>", "源库词元", tok))

    ok = True
    print("自检 %s" % OUT)
    print("  [1] 审计规则 %d 条，扫描文本值 %d 个" % (len(pats), scanned))
    if hits:
        ok = False
        print("      [FAIL] 命中 %d 处：" % len(hits))
        for t, c, label, val in hits[:20]:
            print("         [%s.%s] <%s> %r" % (t, c, label, val[:50]))
    else:
        print("      [OK] 0 命中")
    print("  [2] 源库词元残留检查（%d 个词元）" % len(src_tokens))
    if residue:
        ok = False
        print("      [FAIL] 残留 %d 处：" % len(residue))
        for t, c, tok in residue[:20]:
            print("         [%s.%s] %r" % (t, c, tok))
    else:
        print("      [OK] 0 残留")
    print("  [3] 演示快照一致性")
    if stale:
        ok = False
        print("      [FAIL] 仍指向不存在的记录：%s" % stale)
    else:
        print("      [OK] 一致")
    print("  [4] 整文件字节扫描（%d B，含 free page 残留）" % len(raw))
    if byte_hits:
        ok = False
        print("      [FAIL] 命中 %d 处（SQL 查不到但二进制里还在，跑 make_seed_db.py 重建）："
              % len(byte_hits))
        for t, c, label, val in byte_hits[:20]:
            print("         <%s> %r" % (label, val[:50]))
    else:
        print("      [OK] 0 命中")
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check-only", action="store_true")
    args = ap.parse_args()
    if not args.check_only:
        rc = build()
        if rc:
            return rc
    return check()


if __name__ == "__main__":
    sys.exit(main())
