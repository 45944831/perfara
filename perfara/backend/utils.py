from sqlalchemy import or_
from sqlalchemy.orm import Session
from datetime import datetime
from typing import Dict, Any, Optional, List
from .models import Project, ProjectAlias
import hashlib
import json
import math


def guess_platform(category: str) -> Optional[str]:
    cat = (category or "").lower().strip()
    if cat == "pc":
        return "pc"
    if "android" in cat:
        return "android"
    if "ios" in cat and "gpu" in cat:
        return "ios_gpu"
    if "ios" in cat:
        return "ios"
    return None


def as_text(value: Any) -> Optional[str]:
    """把 payload 里取出的字段规范化为**字符串**；容器 / 布尔等非标量一律返回 None。

    背景：`/api/upload` 是开放入口，`app` / `bundleId` / `appName` 这些字段
    没有任何 schema 约束。若调用方把 `app` 传成 dict（而不是字符串），
    原实现会把它整个塞进 SQL 条件 —— `Project.app_name == {...}`，
    SQLite 直接抛 `ProgrammingError: type 'dict' is not supported`，
    上传以 **500** 收场，而不是优雅降级。

    规则：
      - str            → 原样返回
      - int / float    → str()（数字型 bundleId 有现实可能，如 `12345`）
      - bool           → None（`isinstance(True, int)` 为真，必须先排掉；
                         布尔包名没有意义，不猜）
      - dict / list / 其他 → None（不是合法的应用名 / 包名，忽略而非猜测）
    """
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return str(value)
    return None


def ensure_project_for_payload(db: Session, payload: Dict[str, Any]) -> Project:
    # payload 可能是任意 JSON（顶层数组 / 字符串 / 数字都出现过），
    # 不是 dict 时不能 .get —— 否则 AttributeError 直接崩成 500。
    if not isinstance(payload, dict):
        payload = {}
    # device 同理：不是 dict 时不能 .get
    device = payload.get("device")
    if not isinstance(device, dict):
        device = {}
    pkg = (as_text(device.get("bundleId"))
           or as_text(payload.get("package"))
           or as_text(payload.get("packageName")))
    app_name = (as_text(device.get("appName"))
                or as_text(payload.get("app"))
                or as_text(payload.get("appName")))
    category = (as_text(device.get("category")) or as_text(payload.get("category")) or "")
    platform = guess_platform(category) or as_text(payload.get("platform"))

    # Try alias
    display_name = None
    # ⚠️ 不能写 `(ProjectAlias.package_name == pkg) | (...)`：
    # pkg 为 None 时 SQLAlchemy 会生成 `package_name IS NULL`，从而匹配到
    # **任意一个** package_name 为 NULL 的行 —— 不同应用会被并进同一个项目。
    # 真机上传实测：第二次上传的游戏被挂到了第一次的浏览器项目下。
    # 正确做法是「值为空就不参与匹配」。
    alias_conds = []
    if pkg:
        alias_conds.append(ProjectAlias.package_name == pkg)
    if app_name:
        alias_conds.append(ProjectAlias.app_name == app_name)
    if alias_conds:
        alias = db.query(ProjectAlias).filter(or_(*alias_conds)).first()
        if alias and alias.display_name:
            display_name = alias.display_name

    project = None
    proj_conds = []
    if pkg:
        proj_conds.append(Project.package_name == pkg)
    if app_name:
        proj_conds.append(Project.app_name == app_name)
    if proj_conds:
        project = db.query(Project).filter(or_(*proj_conds)).first()
    # 无包名/应用名时，尽量复用同名展示项目，避免无限创建
    if not project:
        fallback_name = (display_name or app_name or pkg
                         or as_text(device.get("name"))
                         or as_text(payload.get("label"))
                         or as_text(payload.get("file"))
                         or "未命名项目")
        project = (
            db.query(Project)
            .filter(Project.display_name == fallback_name)
            .first()
        )

    if not project:
        project = Project(
            package_name=pkg,
            app_name=app_name,
            display_name=display_name
            or app_name
            or pkg
            or as_text(payload.get("label"))
            or as_text(payload.get("file"))
            or "未命名项目",
            platform=platform,
        )
        db.add(project)
        db.flush()
    else:
        # Update display name/platform opportunistically
        if display_name and project.display_name != display_name:
            project.display_name = display_name
        if platform and project.platform != platform:
            project.platform = platform
    project.updated_at = datetime.utcnow()
    return project


def sanitize_non_finite(value: Any) -> Any:
    """把 JSON 扩展字面量 Infinity / -Infinity / NaN 归一为 None。

    Python 的 json.loads 默认接受这些字面量，json.dumps 也会原样写出，
    但 ECMAScript 的 JSON.parse 会直接抛错。上传入口统一在入哈希/落库前清洗。
    """
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {k: sanitize_non_finite(v) for k, v in value.items()}
    if isinstance(value, list):
        return [sanitize_non_finite(v) for v in value]
    return value


def compute_content_hash(payload: Dict[str, Any]) -> str:
    # Stable canonical JSON for hashing
    data = json.dumps(payload, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


def try_get(d: Dict[str, Any], path: str):
    cur = d
    for key in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
        if cur is None:
            return None
    return cur


def avg(values):
    if not isinstance(values, list) or not values:
        return None
    nums = [v for v in values if isinstance(v, (int, float))]
    return (sum(nums) / len(nums)) if nums else None


# ─── 加载阶段（loading）识别 ─────────────────────────────────────────────────
# 冷启动 / 换场景 / 读关卡时 FPS 会连续掉到个位数。这段数据真实存在（曲线照常画），
# 但不代表游戏内表现，混进 fpsAvg / 1%Low 会把整份报告拉垮。
# 判定规则（4 条同时满足才剔除）：
#   1. 连续 ≥ min_run 个采样点 FPS < 目标帧率 × low_ratio（默认 3 点 / 50%）
#   2. 段结束后 recover_window 个点内出现 FPS ≥ 目标帧率 × recover_ratio（默认 5 点 / 80%）
#      ——「能恢复」才是加载；一直低说明真的跑不动，不能剔
#   3. 段内允许夹少量 None（未取到帧数据），最多 max_null_bridge 个
#   4. 剔除总量不超过 max_excluded_ratio（默认 40%），超过则整体作废，
#      避免把「整段都差」的数据洗成好数据
# 另：起始 warmup_samples 个点内的低帧，1 个点即视为启动预热
#     （首个采样点常无帧数增量，会被记成 0，那 1 个 0 就能把 1%Low 打到 0）。
#
# ⚠️ 与 `_client_src/app/src/fps-loading.js`、
#    `perfara/collector/resources/reports/perf.html` 内的同名实现保持完全一致。

LOADING_OPTIONS = {
    "low_ratio": 0.5,
    "recover_ratio": 0.8,
    "min_run": 3,
    "recover_window": 5,
    "max_null_bridge": 2,
    "warmup_samples": 3,
    "max_excluded_ratio": 0.4,
}

FPS_TARGET_CANDIDATES = (30, 45, 60, 90, 120, 144, 165)


def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def p95(values: List[Any]) -> Optional[float]:
    """P95（线性插值），与报告页 fpsTargetOfSeries 同口径。"""
    a = sorted(v for v in (values or []) if _is_num(v))
    if not a:
        return None
    i = (len(a) - 1) * 0.95
    lo, hi = math.floor(i), math.ceil(i)
    return a[lo] if lo == hi else a[lo] + (a[hi] - a[lo]) * (i - lo)


def snap_fps_target(p95_value: Optional[float]) -> Optional[int]:
    """P95 吸附到常见刷新率档位。"""
    if p95_value is None or not (p95_value > 0):
        return None
    for c in FPS_TARGET_CANDIDATES:
        if c >= p95_value * 0.97:
            return c
    return int(math.ceil(p95_value / 30.0) * 30)


def fps_target_of(values: List[Any]) -> Optional[int]:
    return snap_fps_target(p95(values))


def detect_loading_segments(fps: List[Any], target: Optional[int],
                            options: Optional[Dict[str, Any]] = None) -> List[Dict[str, int]]:
    """返回加载段列表 [{start, end, samples}]（闭区间下标，升序）。"""
    o = dict(LOADING_OPTIONS)
    if options:
        o.update(options)
    arr = list(fps or [])
    n = len(arr)
    if not n or not target or not (target > 0):
        return []

    low_thr = target * o["low_ratio"]
    rec_thr = target * o["recover_ratio"]
    segs: List[Dict[str, int]] = []

    i = 0
    while i < n:
        v = arr[i]
        if not _is_num(v) or v >= low_thr:
            i += 1
            continue

        j = i
        low = 0
        null_run = 0
        while j < n:
            w = arr[j]
            if not _is_num(w):
                null_run += 1
                if null_run > o["max_null_bridge"]:
                    break
                j += 1
                continue
            if w >= low_thr:
                break
            null_run = 0
            low += 1
            j += 1

        e = j - 1
        while e > i and not _is_num(arr[e]):
            e -= 1

        is_warmup = i < o["warmup_samples"]
        if low >= o["min_run"] or (is_warmup and low >= 1):
            recovered = False
            for k in range(j, min(n, j + o["recover_window"])):
                if _is_num(arr[k]) and arr[k] >= rec_thr:
                    recovered = True
                    break
            if recovered:
                segs.append({"start": i, "end": e, "samples": e - i + 1})
                i = j
                continue
        i = j if j > i else i + 1

    covered = sum(g["samples"] for g in segs)
    if covered / n > o["max_excluded_ratio"]:
        return []
    return segs


def build_loading_mask(length: int, segments: List[Dict[str, int]]) -> List[bool]:
    mask = [False] * max(0, int(length))
    for g in segments or []:
        s = max(0, int(g.get("start", 0)))
        e = min(len(mask) - 1, int(g.get("end", -1)))
        for k in range(s, e + 1):
            mask[k] = True
    return mask


def fps_stats_excluding_loading(values: List[Any]) -> Dict[str, Any]:
    """算 FPS 均值时剔除加载段。

    返回 {avg, avgRaw, target, segments, excludedSamples, excludedRatio, effectiveRatio}。
    `avg` 为剔除后均值（入库 fpsAvg 用），`avgRaw` 为全程均值（对照用）。
    """
    arr = list(values or [])
    target = fps_target_of(arr)
    segs = detect_loading_segments(arr, target)
    mask = build_loading_mask(len(arr), segs)
    kept = [v for k, v in enumerate(arr) if not mask[k] and _is_num(v)]
    excluded = sum(1 for m in mask if m)
    return {
        "avg": (sum(kept) / len(kept)) if kept else None,
        "avgRaw": avg(arr),
        "target": target,
        "segments": segs,
        "excludedSamples": excluded,
        "excludedRatio": (excluded / len(arr)) if arr else 0.0,
        "effectiveRatio": ((len(arr) - excluded) / len(arr)) if arr else 1.0,
    }


def build_summary(category: str, root_series: Dict[str, Any]) -> Dict[str, Any]:
    # Expect structure: {"timestamp": [...], "series": {...}}
    series = root_series.get("series") if isinstance(root_series, dict) else None
    if not isinstance(series, dict):
        return {}
    cat = (category or "").lower()

    def a(path):  # avg helper
        node = try_get(series, path)
        return avg(node) if isinstance(node, list) else None

    def fps_pair():
        """FPS 均值：剔除加载段（fpsAvg）+ 全程对照（fpsAvgRaw）。"""
        node = try_get(series, "fps")
        if not isinstance(node, list):
            return None, None
        st = fps_stats_excluding_loading(node)
        return st["avg"], st["avgRaw"]

    summary = {}
    if "android" in cat:
        summary["fpsAvg"], summary["fpsAvgRaw"] = fps_pair()
        summary["cpuProcAvg"] = a("cpu.procCpu")
        summary["memPssAvg"] = a("mem.totalPss")
    elif "gpu" in cat and "ios" in cat:
        summary["vertexOccAvg"] = a("Vertex Occupancy")
        summary["fragOccAvg"] = a("Fragment Occupancy")
        summary["aluUtilAvg"] = a("ALU Utilization")
    elif "ios" in cat:
        summary["fpsAvg"], summary["fpsAvgRaw"] = fps_pair()
        summary["cpuProcAvg"] = a("cpuUsage")
        summary["memFootprintAvg"] = a("physFootprint")
    elif cat == "pc":
        summary["fpsAvg"], summary["fpsAvgRaw"] = fps_pair()
        summary["cpuProcAvg"] = a("cpu.procCpu")
        summary["memPssAvg"] = a("mem.totalPss")
        summary["tempAvg"] = a("temperature")
    return {k: v for k, v in summary.items() if v is not None}

