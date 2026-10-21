#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""加载段识别算法：三处实现一致性 + 边界行为测试。

背景：`detect_loading_segments` / `detectLoadingSegments` 在三处各有一份实现，
注释明确要求「保持完全一致」：
  1. `_client_src/app/src/fps-loading.js`      （采集端）
  2. `perfara/backend/utils.py`                （服务端汇总）
  3. `perfara/collector/resources/reports/perf.html` （报告页底纹）
任何一处漂移都会导致「服务端算的均值 ≠ 报告页画的底纹 ≠ 客户端剔除的段」。

本测试：
  C01-C08  参数默认值三处一致
  C09-C16  同一批随机/构造序列，三处输出逐字段相等
  B01-B14  边界行为（空/全 null/全 0/单点/超 40% 作废/warm-up/null 桥接等）
"""
from __future__ import annotations

import json
import random
import re
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT / "perfara"))

from backend.utils import (  # noqa: E402
    LOADING_OPTIONS,
    build_loading_mask,
    detect_loading_segments,
    fps_target_of,
    snap_fps_target,
)

NODE = r"C:\Users\user\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
PASS = 0
FAIL = 0
FAILED: list[str] = []


def check(name: str, cond, detail="") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        FAILED.append(name)
        print(f"  FAIL  {name}  {detail}")


# ────────────────────────── 取 perf.html 里的 JS 实现 ──────────────────────────

def load_html_impl() -> str:
    """从 perf.html 抽出 detectLoadingSegments / buildLoadingMask / analyseLoading
    及其依赖（LOADING_OPTIONS / isNumVal / fpsTargetOfSeries）。"""
    html = (ROOT / "perfara" / "collector" / "resources" / "reports" / "perf.html").read_text(
        encoding="utf-8"
    )
    # 这些函数都在同一段脚本里，按大括号配对整体抠出来
    names = ["LOADING_OPTIONS", "isNumVal", "detectLoadingSegments", "buildLoadingMask",
             "analyseLoading", "fpsTargetOfSeries", "snapFpsTarget"]
    chunks = []
    for nm in names:
        # 变量声明（const X = {...}）或函数声明
        for pat in (f"const {nm} =", f"function {nm}("):
            i = html.find(pat)
            if i >= 0:
                # 回溯到行首
                ls = html.rfind("\n", 0, i) + 1
                # 找到匹配的大括号结束
                depth = 0
                started = False
                j = i
                while j < len(html):
                    c = html[j]
                    if c == "{":
                        depth += 1
                        started = True
                    elif c == "}":
                        depth -= 1
                        if started and depth == 0:
                            # 多吃一个分号/换行
                            k = j + 1
                            while k < len(html) and html[k] in "; \t":
                                k += 1
                            chunks.append(html[ls:k])
                            break
                    j += 1
                break
    if len(chunks) < len(names):
        missing = set(names) - set(re.findall(r"(?:const|function)\s+(\w+)", "\n".join(chunks)))
        raise RuntimeError(f"perf.html 中未找齐实现，缺少: {missing}")
    return "\n".join(chunks)


HTML_IMPL = load_html_impl()

# ────────────────────────── 构造测试用例 ──────────────────────────

def build_cases():
    """返回 [(名称, fps 序列), ...]"""
    cases: list[tuple[str, list]] = []
    cases.append(("空数组", []))
    cases.append(("单点 60", [60]))
    cases.append(("单点 0", [0]))
    cases.append(("单点 null", [None]))
    cases.append(("全 null", [None] * 20))
    cases.append(("全 0", [0] * 20))
    cases.append(("全 60", [60] * 20))
    cases.append(("前 3 点 0 后恢复(warmup)", [0, 0, 0] + [60] * 17))
    cases.append(("前 3 点 null 后恢复", [None, None, None] + [60] * 17))
    cases.append(("中段 3 点低帧后恢复", [60] * 5 + [5, 5, 5] + [60] * 12))
    cases.append(("中段 2 点低帧(不足 minRun)", [60] * 5 + [5, 5] + [60] * 13))
    cases.append(("低帧后不恢复(不能剔)", [60] * 5 + [5] * 15))
    cases.append(("低帧带 2 个 null 桥接", [60] * 4 + [5, None, 5, None, 5] + [60] * 10))
    cases.append(("低帧带 3 个 null 桥接(超限)", [60] * 4 + [5, None, None, None, 5] + [60] * 10))
    cases.append(("低帧段结尾是 null", [60] * 4 + [5, 5, 5, None, None] + [60] * 9))
    cases.append(("超过 40% 低帧(整体作废)", [60] * 6 + [5] * 14))
    cases.append(("恰好 40% 边界", [60] * 6 + [5] * 4))
    cases.append(("两段加载", [0, 0, 0] + [60] * 5 + [5, 5, 5] + [60] * 9))
    cases.append(("负值", [-5] * 3 + [60] * 17))
    cases.append(("超大值", [1e9] * 3 + [60] * 17))
    cases.append(("字符串混入", ["x", "y"] + [60] * 18))
    cases.append(("布尔值混入", [True, False] + [60] * 18))

    # 随机序列（固定种子保证可复现）
    rng = random.Random(20261021)
    for k in range(6):
        seq = []
        for _ in range(40):
            r = rng.random()
            if r < 0.1:
                seq.append(None)
            elif r < 0.3:
                seq.append(round(rng.uniform(0, 25), 1))
            else:
                seq.append(round(rng.uniform(50, 62), 1))
        cases.append((f"随机序列 #{k + 1}", seq))
    return cases


def main() -> int:
    print("== 加载段算法：三处一致性 + 边界测试 ==")

    # ─────────── 参数默认值一致性 ───────────
    print("[参数默认值]")
    opts = LOADING_OPTIONS
    check("C01 后端 low_ratio=0.5", opts["low_ratio"] == 0.5)
    check("C02 后端 min_run=3 / warmup_samples=3", opts["min_run"] == 3 and opts["warmup_samples"] == 3)
    check("C03 后端 max_null_bridge=2", opts["max_null_bridge"] == 2)
    check("C04 后端 recover_window=5 / recover_ratio=0.8",
          opts["recover_window"] == 5 and opts["recover_ratio"] == 0.8)
    check("C05 后端 max_excluded_ratio=0.4", opts["max_excluded_ratio"] == 0.4)

    # 用 node 取前端的默认值做比对
    tmp = Path(tempfile.mkdtemp(prefix="perfara-loading-"))
    js_file = tmp / "impl.js"
    js_file.write_text(
        "const M = require('" + str(ROOT / "_client_src" / "app" / "src" / "fps-loading.js")
        .replace("\\", "/") + "');\n"
        "console.log(JSON.stringify({client: M.DEFAULT_OPTIONS}));\n",
        encoding="utf-8",
    )
    try:
        out = subprocess.run([NODE, str(js_file)], capture_output=True, text=True, timeout=60)
        if out.returncode != 0:
            check("C06 读取客户端默认值", False, out.stderr[:300])
        else:
            client_opts = json.loads(out.stdout.strip().splitlines()[-1])["client"]
            # 客户端是 camelCase，后端是 snake_case，需映射后比对
            conv = {
                "low_ratio": "lowRatio", "recover_ratio": "recoverRatio", "min_run": "minRun",
                "recover_window": "recoverWindow", "max_null_bridge": "maxNullBridge",
                "warmup_samples": "warmupSamples", "max_excluded_ratio": "maxExcludedRatio",
            }
            diff = [k for k, v in conv.items()
                    if abs(client_opts.get(v, -1e9) - opts[k]) > 1e-12]
            check("C06 客户端与后端默认值完全一致", not diff,
                  f"diff={diff} client={client_opts}")
    except Exception as e:  # noqa: BLE001
        check("C06 读取客户端默认值", False, str(e))

    # HTML 里的 LOADING_OPTIONS
    m = re.search(r"const LOADING_OPTIONS = \{([^}]*)\}", HTML_IMPL)
    if m:
        html_pairs = dict(re.findall(r"(\w+):\s*([\d.]+)", m.group(1)))
        conv = {
            "low_ratio": "lowRatio", "recover_ratio": "recoverRatio", "min_run": "minRun",
            "recover_window": "recoverWindow", "max_null_bridge": "maxNullBridge",
            "warmup_samples": "warmupSamples", "max_excluded_ratio": "maxExcludedRatio",
        }
        mismatch = [k for k, v in conv.items() if float(html_pairs.get(v, -1)) != opts[k]]
        check("C07 perf.html 与后端默认值完全一致", not mismatch,
              f"mismatch={mismatch} html={html_pairs}")
    else:
        check("C07 perf.html 与后端默认值完全一致", False, "未解析到 LOADING_OPTIONS")

    # ─────────── 三处输出一致性 ───────────
    print("[三处输出一致性]")

    # 生成一个 Node 脚本：读客户端 + HTML 两处实现，对同一批用例输出 JSON
    cases = build_cases()
    runner = tmp / "run.js"
    runner.write_text(
        "const M = require('" + str(ROOT / "_client_src" / "app" / "src" / "fps-loading.js")
        .replace("\\", "/") + "');\n"
        + HTML_IMPL
        + "\nconst cases = " + json.dumps([c[1] for c in cases], ensure_ascii=False) + ";\n"
        + "const out = [];\n"
        + "for (const fps of cases) {\n"
        + "  const target = M.fpsTargetOf(fps);\n"
        + "  const segC = M.detectLoadingSegments(fps, target);\n"
        + "  const segH = detectLoadingSegments(fps, target);\n"
        + "  out.push({ target, segC, segH });\n"
        + "}\n"
        + "console.log(JSON.stringify(out));\n",
        encoding="utf-8",
    )
    try:
        out = subprocess.run([NODE, str(runner)], capture_output=True, text=True, timeout=120)
        if out.returncode != 0:
            check("C08 运行 Node 一致性脚本", False, out.stderr[:400])
        else:
            js_res = json.loads(out.stdout.strip().splitlines()[-1])
            bad = []
            for (name, fps), r in zip(cases, js_res):
                py_target = fps_target_of(fps)
                py_segs = detect_loading_segments(fps, py_target)
                # target 一致
                if (py_target is None) != (r["target"] is None) or (
                    py_target is not None and abs(py_target - r["target"]) > 1e-9
                ):
                    bad.append(f"{name}: target py={py_target} js={r['target']}")
                    continue
                norm = lambda segs: [  # noqa: E731
                    [int(s["start"]), int(s["end"]), int(s["samples"])] for s in segs
                ]
                if norm(py_segs) != norm(r["segC"]):
                    bad.append(f"{name}: 客户端 segs py={norm(py_segs)} js={norm(r['segC'])}")
                if norm(r["segC"]) != norm(r["segH"]):
                    bad.append(f"{name}: 客户端 vs HTML js={norm(r['segC'])} html={norm(r['segH'])}")
            check("C08 三处实现对 25 个用例输出完全一致", not bad, "; ".join(bad[:4]))
    except Exception as e:  # noqa: BLE001
        check("C08 运行 Node 一致性脚本", False, str(e))

    # ─────────── 边界行为 ───────────
    print("[边界行为]")
    # 注意：序列长度要设计得让剔除占比 < 40%，否则会触发「整体作废」保护，
    # 那是另一条独立规则（B13 专门测），不要混在一起。
    check("B01 空数组返回空段", detect_loading_segments([], 60) == [])
    # B02 target<=0
    check("B02 target=0 返回空段", detect_loading_segments([0] * 10, 0) == [])
    check("B03 target=None 返回空段", detect_loading_segments([0] * 10, None) == [])
    # B04 全 null
    check("B04 全 null 返回空段", detect_loading_segments([None] * 10, 60) == [])
    # B05 warmup：起始 3 点内 1 个低帧即算
    segs = detect_loading_segments([0] + [60] * 9, 60)
    check("B05 warmup 单点低帧即识别", len(segs) == 1 and segs[0]["start"] == 0 and segs[0]["end"] == 0,
          str(segs))
    # B06 非 warmup 单点低帧不算
    segs = detect_loading_segments([60] * 5 + [0] + [60] * 4, 60)
    check("B06 非 warmup 单点低帧不识别", segs == [], str(segs))
    # B07 minRun 边界：正好 3 点
    segs = detect_loading_segments([60] * 4 + [5, 5, 5] + [60] * 3, 60)
    check("B07 恰好 3 个连续低帧被识别", len(segs) == 1 and segs[0]["samples"] == 3, str(segs))
    # B08 只有 2 点
    segs = detect_loading_segments([60] * 4 + [5, 5] + [60] * 4, 60)
    check("B08 只有 2 个连续低帧不识别", segs == [], str(segs))
    # B09 不恢复不识别
    segs = detect_loading_segments([60] * 4 + [5, 5, 5] + [5] * 8, 60)
    check("B09 低帧后不恢复则不作废（不能洗数据）", segs == [], str(segs))
    # B10 null 桥接：夹 2 个 null 仍算连续低帧（序列加长以避免触发 40% 作废）
    segs = detect_loading_segments([60] * 4 + [5, None, 5, None, 5] + [60] * 12, 60)
    check("B10 段内夹 2 个 null 仍算连续", len(segs) == 1 and segs[0]["samples"] == 5, str(segs))
    # B11 null 桥接上限：夹 3 个连续 null 会断开，两半各自不足 minRun
    segs = detect_loading_segments([60] * 4 + [5, 5, None, None, None, 5, 5] + [60] * 12, 60)
    check("B11 段内夹 3 个 null 会断开", segs == [], str(segs))
    # 对照：若把 null 减到 2 个，则应识别为一段
    segs = detect_loading_segments([60] * 4 + [5, 5, None, None, 5, 5] + [60] * 12, 60)
    check("B11b 对照：夹 2 个 null 时可跨接", len(segs) == 1 and segs[0]["samples"] == 6, str(segs))
    # B12 段结尾是 null 时应收缩到最后一个有效低帧
    segs = detect_loading_segments([60] * 4 + [5, 5, 5, None] + [60] * 5, 60)
    check("B12 段结尾 null 收缩到有效低帧",
          len(segs) == 1 and segs[0]["end"] == 6, str(segs))
    # B13 超过 40% 整体作废
    segs = detect_loading_segments([60] * 4 + [5] * 16, 60)
    check("B13 剔除量超 40% 时整体作废", segs == [], str(segs))
    # B14 mask 与 segments 对应
    mask = build_loading_mask(20, [{"start": 2, "end": 4, "samples": 3}])
    check("B14 build_loading_mask 闭区间置位",
          list(mask) == [0, 0, 1, 1, 1] + [0] * 15, str(list(mask)))
    # B15 mask 越界保护
    mask = build_loading_mask(5, [{"start": 3, "end": 99, "samples": 97}])
    check("B15 mask 越界 end 被截断", list(mask) == [0, 0, 0, 1, 1], str(list(mask)))
    # B16 fps_target_of 对空序列
    check("B16 fps_target_of 空序列返回 None", fps_target_of([]) is None)
    # B17 snapFpsTarget 边界
    check("B17 snap_fps_target(0) 返回 None", snap_fps_target(0) is None)
    check("B18 snap_fps_target(58.2)→60", snap_fps_target(58.2) == 60, str(snap_fps_target(58.2)))
    check("B19 snap_fps_target(29)→30", snap_fps_target(29) == 30, str(snap_fps_target(29)))
    check("B20 snap_fps_target(200)→向上取 30 倍数", snap_fps_target(200) == 210,
          str(snap_fps_target(200)))

    print(f"\n==== 加载段算法测试结果: {PASS} PASS / {FAIL} FAIL ====")
    if FAILED:
        print("FAILED: " + ", ".join(FAILED))
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
