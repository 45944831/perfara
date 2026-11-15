"""空 catch 预算棘轮（S-05）。

背景：全项目 203 处空 catch（`catch (_) {}`），其中 183 处没有说明。抽样看绝大多数
是 `try { child.kill() } catch (_) {}` 这类 best-effort 清理，模式本身没问题——问题
是**没有说明**，读代码的人分不清「这里失败无所谓」和「这里失败被静默了」。

不逐条补注释的理由：给 183 处各写一句「忽略」只会制造噪音。真正的解法是两件事：
  1. 每个高频文件写一句**约定**（说明这个文件的空 catch 属于哪一类、由谁兜底）；
  2. 用本测试**锁住数量**——只许减，不许增。新增的空 catch 必须显式提高预算，
     而改预算这个动作本身会出现在 review 里。

预算就是当前实测值，见 tools/scan_empty_catch.py（同一份扫描实现，不重复写）。

用法：python perfara/tests/deep/empty_catch_budget_test.py
"""
import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent.parent
sys.path.insert(0, str(REPO / "tools"))

spec = importlib.util.spec_from_file_location(
    "scan_empty_catch", REPO / "tools" / "scan_empty_catch.py")
scan_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scan_mod)

# 2026-11-14 实测基线。只许往下调，不许往上加。
BUDGET = {
    "_client_src/app/main.js": 44,
    "_client_src/app/renderer/apply-app-brand.js": 2,
    "_client_src/app/renderer/charts.js": 5,
    "_client_src/app/renderer/iphone.js": 5,
    "_client_src/app/renderer/iphone_gpu.js": 5,
    "_client_src/app/renderer/log-panel.js": 2,
    "_client_src/app/renderer/metric-settings.js": 7,
    "_client_src/app/renderer/pc.js": 3,
    "_client_src/app/renderer/renderer.js": 9,
    "_client_src/app/renderer/trough-shots.js": 1,
    "_client_src/app/renderer/weaknet-page.js": 13,
    "_client_src/app/src/adb.js": 32,
    "_client_src/app/src/app-labels.js": 2,
    "_client_src/app/src/collector.js": 4,
    "_client_src/app/src/ios-collector.js": 5,
    "_client_src/app/src/ios-gpu-collector.js": 5,
    "_client_src/app/src/ios-logger.js": 4,
    "_client_src/app/src/ios-screen.js": 3,
    "_client_src/app/src/pc-collector.js": 6,
    "_client_src/app/src/phone-proxy.js": 11,
    "_client_src/app/src/reports-config.js": 1,
    "_client_src/app/src/reports-data-js.js": 3,
    "_client_src/app/src/segmented-history.js": 2,
    "_client_src/app/src/sysproxy.js": 3,
    "_client_src/app/src/trace-capture.js": 2,
    "_client_src/app/src/trough-shots.js": 1,
    "_client_src/app/src/update-check.js": 3,
    "_client_src/app/src/weaknet-host.js": 18,
    "_client_src/app/src/weaknet-tracker.js": 2,
}

TOTAL_BUDGET = sum(BUDGET.values())

results = []


def check(name, ok, detail=""):
    detail = "" if detail == "" else str(detail)
    results.append((name, bool(ok), detail))
    print(("  PASS  " if ok else "  FAIL  ") + name + (("  | " + detail) if detail else ""))


def main():
    actual = {}
    documented = 0
    total = 0
    for p in scan_mod.iter_files():
        hits = scan_mod.scan(p)
        if not hits:
            continue
        rel = str(Path(p).resolve().relative_to(REPO)).replace("\\", "/")
        actual[rel] = len(hits)
        total += len(hits)
        documented += sum(1 for h in hits if h["commented"])

    check("扫描到 %d 个文件有空 catch" % len(actual), len(actual) > 0, len(actual))

    over = []
    for rel, n in sorted(actual.items()):
        budget = BUDGET.get(rel)
        if budget is None:
            over.append("%s 新增 %d 处（预算里没有这个文件）" % (rel, n))
            continue
        if n > budget:
            over.append("%s 实测 %d > 预算 %d（多了 %d）" % (rel, n, budget, n - budget))
    check("没有文件超出空 catch 预算", not over, "；".join(over))

    check("空 catch 总数 %d 不超过总预算 %d" % (total, TOTAL_BUDGET),
          total <= TOTAL_BUDGET, "超出 %d" % (total - TOTAL_BUDGET) if total > TOTAL_BUDGET else "")

    # 数量下降是好事，提示可以收紧预算（不作为失败项，免得每次减一处就红一次）
    shrunk = ["%s %d→%d" % (rel, BUDGET[rel], n)
              for rel, n in sorted(actual.items()) if rel in BUDGET and n < BUDGET[rel]]
    if shrunk:
        print("  HINT  以下文件已低于预算，可以把 BUDGET 收紧：" + "；".join(shrunk))

    # 约定注释的存在性：这 6 个高频文件必须写明「空 catch 属于哪一类」
    conventions = {
        "_client_src/app/main.js": "空 catch 约定",
        "_client_src/app/src/adb.js": "空 catch 约定",
        "_client_src/app/src/phone-proxy.js": "空 catch 约定",
        "_client_src/app/src/weaknet-host.js": "空 catch 约定",
        "_client_src/app/renderer/renderer.js": "空 catch 约定",
        "_client_src/app/renderer/weaknet-page.js": "空 catch 约定",
    }
    missing = []
    for rel, marker in conventions.items():
        try:
            text = (REPO / rel).read_text(encoding="utf-8", errors="replace")
        except OSError:
            missing.append(rel + "（读不到）")
            continue
        if marker not in text:
            missing.append(rel)
    check("高频文件的空 catch 约定注释都在", not missing, "；".join(missing))

    check("带说明的空 catch 至少 20 处", documented >= 20, documented)

    passed = sum(1 for _, ok, _ in results if ok)
    failed = len(results) - passed
    print("-" * 60)
    print("结果：%d PASS / %d FAIL" % (passed, failed))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
