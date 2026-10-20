#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Perfara 后端 API 全面测试（stdlib only，无第三方依赖）。

目标服务默认指向「临时库副本」服务（8019），读+写全部隔离，不污染真实演示库。
真实库只读回归已在 8018 单独验证（含超大整数溢出修复）。
"""
import json
import os
import sys
import urllib.request
import urllib.error

# 沙箱代理绕过：127.0.0.1 必须直连
os.environ["no_proxy"] = "127.0.0.1,localhost"
os.environ["NO_PROXY"] = "127.0.0.1,localhost"

BASE = os.environ.get("PERFARA_BASE", "http://127.0.0.1:8019")
HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLE = os.path.join(HERE, "fixtures", "sample_payload.json")

DEMO = "perfara123"
SUPER = "wonderxu"

PASS = 0
FAIL = 0
FAILED = []


def _record(ok, name, code, expect, extra=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  PASS  {name}  [{code}]")
    else:
        FAIL += 1
        FAILED.append(name)
        print(f"  FAIL  {name}  got={code} expect={expect}  {extra}")


def call(method, path, name, expect, headers=None, body=None, want_json=True):
    url = BASE + path
    h = dict(headers or {})
    data = None
    if body is not None:
        if isinstance(body, (dict, list)):
            data = json.dumps(body).encode("utf-8")
            h.setdefault("Content-Type", "application/json")
        elif isinstance(body, bytes):
            data = body
        else:
            data = body.encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    code = -1
    raw = b""
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            code = resp.getcode()
            raw = resp.read()
    except urllib.error.HTTPError as e:
        code = e.code
        raw = e.read()
    except Exception as e:  # noqa
        code = -1
        raw = repr(e).encode("utf-8", "replace")
    j = None
    if want_json:
        try:
            j = json.loads(raw.decode("utf-8")) if raw else None
        except Exception:
            j = None
    ok = (code == expect)
    detail = ""
    if not ok and j is not None:
        d = j.get("detail") if isinstance(j, dict) else None
        if d is not None:
            detail = str(d)[:120]
    _record(ok, name, code, expect, detail)
    return code, j, raw


def uidh(u):
    return {"X-WebPerf-Uid": u}


def main():
    print(f"== Perfara API full test  BASE={BASE} ==")

    # ---------- 公共 / 无鉴权 ----------
    print("[公共]")
    c, j, _ = call("GET", "/api/health", "T01 health", 200)
    if not (isinstance(j, dict) and j.get("status") == "ok"):
        _record(False, "T01b health.body", c, 200, str(j)[:120])
    else:
        _record(True, "T01b health.body", c, 200)

    c, j, _ = call("GET", "/api/chart-configs", "T02 chart-configs", 200)
    n = len(j) if isinstance(j, (list, dict)) else 0
    _record(n >= 4, "T02b chart-configs>=4", c, 200, f"len={n}")

    call("GET", "/api/public/test?testid=deadbeef", "T03 public bad token", 404)
    call("GET", "/api/public/test", "T04 public missing testid", 422)

    # ---------- projects（require_uid） ----------
    print("[projects]")
    call("GET", "/api/projects", "T05 projects no-uid", 400)
    c, j, _ = call("GET", f"/api/projects?uid={DEMO}", "T06 projects demo", 200)
    n = len(j) if isinstance(j, list) else 0
    _record(n >= 1, "T06b projects>=1", c, 200, f"len={n}")
    proj_ids = [p.get("id") for p in (j or []) if isinstance(p, dict)]
    proj_id = proj_ids[0] if proj_ids else None

    # ---------- tests 列表（require_uid + 分页 + 溢出） ----------
    print("[tests list]")
    call("GET", "/api/tests", "T07 tests no-uid", 400)
    c, j, _ = call("GET", f"/api/tests?uid={DEMO}&page=1&page_size=5", "T08 tests demo p1", 200)
    items = (j or {}).get("items") if isinstance(j, dict) else None
    total = (j or {}).get("total") if isinstance(j, dict) else None
    _record(isinstance(items, list) and len(items) <= 5 and (total or 0) >= 1,
            "T08b tests page<=5 & total>=1", c, 200, f"items={len(items or [])} total={total}")
    first_id = items[0].get("id") if items else None

    c, j, _ = call("GET", f"/api/tests?uid={DEMO}&page=99999&page_size=5", "T09 tests beyond page", 200)
    _record(isinstance((j or {}).get("items"), list) and len((j or {}).get("items")) == 0,
            "T09b beyond->empty", c, 200)

    # 溢出回归（修复项）
    call("GET", "/api/tests?uid=%s&page=1000000000000000000000" % DEMO, "T10 list page overflow->422", 422)
    call("GET", "/api/tests?uid=%s&project_id=1000000000000000000000" % DEMO, "T11 list project_id overflow->422", 422)
    call("GET", "/api/tests?uid=%s&page_size=0" % DEMO, "T12a page_size=0->422", 422)
    call("GET", "/api/tests?uid=%s&page_size=99999" % DEMO, "T12b page_size>500->422", 422)
    call("GET", "/api/tests?uid=%s&page=0" % DEMO, "T12c page=0->422", 422)

    # ---------- distinct ----------
    print("[distinct]")
    c, j, _ = call("GET", f"/api/tests/distinct-labels?uid={DEMO}", "T13 distinct-labels", 200)
    _record(isinstance(j, list) and len(j) >= 1, "T13b labels>=1", c, 200, str(j)[:80])
    call("GET", f"/api/tests/distinct-app-names?uid={DEMO}", "T14 distinct-app-names", 200)
    call("GET", f"/api/tests/distinct-labels-for-app?uid={DEMO}", "T15 labels-for-app missing params->422", 422)
    call("GET", f"/api/tests/distinct-labels-for-app?uid={DEMO}&category=ios&project_name=%E7%8B%BC%E4%BA%BA%E6%9D%80",
         "T16 labels-for-app valid", 200)

    # ---------- trend（require_uid + label/category） ----------
    print("[trend]")
    call("GET", f"/api/tests/trend?uid={DEMO}", "T17 trend missing label->422", 422)
    call("GET", f"/api/tests/trend?uid={DEMO}&label=%E5%90%AF%E5%8A%A8&category=ios&project_name=%E7%8B%BC%E4%BA%BA%E6%9D%80", "T18 trend valid", 200)

    # ---------- detail（resolve_uid 权限矩阵） ----------
    print("[detail]")
    demo_id = first_id or 17
    call("GET", f"/api/tests/{demo_id}", "T19 detail anon no-token->404", 404)
    c, j, _ = call("GET", f"/api/tests/{demo_id}?uid={DEMO}", "T20 detail demo->200", 200)
    _record(isinstance(j, dict) and (j.get("test") or j.get("id")), "T20b detail has body", c, 200)
    # 取 share token
    token = None
    if isinstance(j, dict):
        t = j.get("test") if isinstance(j.get("test"), dict) else j
        token = t.get("md5") or t.get("share_md5") or t.get("shareMd5")
    call("GET", f"/api/tests/{demo_id}?uid=random_stranger", "T21 detail stranger->404", 404)
    call("GET", f"/api/tests/1000000000000000000000?uid={DEMO}", "T22 detail overflow->422", 422)
    call("GET", f"/api/tests/999999?uid={DEMO}", "T23 detail valid-missing->404", 404)
    # public by real token
    if token:
        call("GET", f"/api/public/test?testid={token}", "T24 public by real token->200", 200)
    else:
        _record(False, "T24 public by real token", -1, 200, "no token extracted")

    # ---------- patch label（require_uid + demo 403 + 溢出） ----------
    print("[patch label]")
    call("PATCH", f"/api/tests/{demo_id}/label", "T25 patch demo->403", 403,
         headers={**uidh(DEMO), "Content-Type": "application/json"}, body={"label": "x"})
    call("PATCH", "/api/tests/1000000000000000000000/label", "T26 patch overflow->422", 422,
         headers={**uidh(SUPER), "Content-Type": "application/json"}, body={"label": "x"})
    call("PATCH", f"/api/tests/{demo_id}/label", "T27 patch no-uid->400", 400,
         headers={"Content-Type": "application/json"}, body={"label": "x"})

    # ---------- delete（require_uid + demo 403 + 溢出） ----------
    print("[delete]")
    call("DELETE", f"/api/tests/{demo_id}", "T28 delete demo->403", 403, headers=uidh(DEMO))
    call("DELETE", "/api/tests/1000000000000000000000", "T29 delete overflow->422", 422, headers=uidh(SUPER))
    call("DELETE", f"/api/tests/{demo_id}", "T30 delete no-uid->400", 400)

    # ---------- project-aliases（require_uid） ----------
    print("[aliases]")
    call("GET", "/api/project-aliases", "T31 aliases no-uid->400", 400)
    call("GET", f"/api/project-aliases?uid={DEMO}", "T32 aliases demo->200", 200)

    # ---------- with-info / infos ----------
    print("[with-info / infos]")
    call("GET", f"/api/projects/with-info?uid={DEMO}", "T33 with-info->200", 200)
    if proj_id:
        call("GET", f"/api/projects/{proj_id}/infos?uid={DEMO}", "T34 infos valid->200", 200)
    call("GET", "/api/projects/1000000000000000000000/infos?uid=%s" % DEMO, "T35 infos overflow->422", 422)
    call("GET", f"/api/projects/{proj_id}/infos" if proj_id else "/api/projects/1/infos", "T36 infos no-uid->400", 400)

    # ---------- admin/reparse（require_uid + 溢出） ----------
    print("[admin reparse]")
    call("POST", "/api/admin/reparse", "T37 reparse no-uid->400", 400)
    call("POST", f"/api/admin/reparse?uid={DEMO}&test_id=1000000000000000000000", "T38 reparse overflow test_id->422", 422)
    call("POST", f"/api/admin/reparse?uid={DEMO}&limit=1000000000000000000000", "T39 reparse overflow limit->422", 422)

    # ---------- SPA fallback ----------
    print("[spa]")
    c, _, raw = call("GET", "/some/unknown/route", "T40 spa fallback->200", 200, want_json=False)
    _record(b"<" in raw[:200] and b"html" in raw[:400].lower(), "T40b spa serves html", c, 200)
    call("GET", "/api/does-not-exist", "T41 unknown /api->404", 404)

    # ================= 写路径（临时库） =================
    print("[WRITE upload/patch/reparse/delete on temp DB]")
    throwaway = "e2e_throwaway_%d" % os.getpid()
    with open(SAMPLE, "r", encoding="utf-8") as f:
        payload = json.load(f)

    call("POST", "/api/upload?uid=%s" % DEMO, "W01 upload demo->403", 403, body=payload)
    call("POST", "/api/upload", "W02 upload no-uid->400", 400, body=payload)
    # 无效 JSON
    call("POST", "/api/upload?uid=%s" % throwaway, "W03 upload bad-json->400", 400, body=b"{not json")
    # 缺 perf
    bad = dict(payload)
    bad.pop("perf", None)
    call("POST", "/api/upload?uid=%s" % throwaway, "W04 upload missing perf->400", 400, body=bad)

    # 有效上传
    c, j, _ = call("POST", "/api/upload?uid=%s" % throwaway, "W05 upload valid->200", 200, body=payload)
    new_id = None
    if isinstance(j, dict):
        new_id = j.get("id")
    _record(bool(new_id), "W05b upload returns id", c, 200, str(j)[:120])

    if new_id:
        # 新 uid 能列出自己的数据
        c, j, _ = call("GET", f"/api/tests?uid={throwaway}&page=1&page_size=50", "W06 list own data->200", 200)
        own = [it.get("id") for it in (j or {}).get("items", [])] if isinstance(j, dict) else []
        _record(new_id in own, "W06b own id present", c, 200, f"new_id={new_id} own={own[:5]}")

        # owner patch label
        c, j, _ = call("PATCH", f"/api/tests/{new_id}/label", "W07 owner patch label->200", 200,
                       headers={**uidh(throwaway), "Content-Type": "application/json"},
                       body={"label": "E2E标记"})
        lab = None
        if isinstance(j, dict):
            lab = j.get("label")
        _record(lab == "E2E标记", "W07b label updated", c, 200, f"label={lab}")

        # super reparse
        call("POST", f"/api/admin/reparse?uid={SUPER}&test_id={new_id}", "W08 super reparse->200", 200)

        # super delete
        call("DELETE", f"/api/tests/{new_id}", "W09 super delete->204", 204, headers=uidh(SUPER))
        # 删除后 detail -> 404
        call("GET", f"/api/tests/{new_id}?uid={SUPER}", "W10 deleted->404", 404)

    print()
    print(f"==== RESULT: {PASS} PASS / {FAIL} FAIL ====")
    if FAILED:
        print("FAILED:", ", ".join(FAILED))
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
