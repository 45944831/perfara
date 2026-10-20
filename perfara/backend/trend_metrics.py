"""从 metric_blobs 首段时序计算峰值，供趋势接口使用。"""
from __future__ import annotations

import json
from typing import Any, Dict, Optional


def _max_numeric_series(arr: Any) -> Optional[float]:
    if not isinstance(arr, list) or not arr:
        return None
    nums = []
    for x in arr:
        if isinstance(x, (int, float)) and x == x:  # filter NaN
            nums.append(float(x))
    return max(nums) if nums else None


def peaks_from_blob_content(content: Dict[str, Any], category: str) -> Dict[str, Optional[float]]:
    """与 parsers 写入的 series 键一致。"""
    if not isinstance(content, dict):
        return {}
    series = content.get("series")
    if not isinstance(series, dict):
        return {}

    cat = (category or "").lower()

    def m(key: str) -> Optional[float]:
        return _max_numeric_series(series.get(key))

    if cat == "android":
        return {
            "fpsPeak": m("fps"),
            "cpuProcPeak": m("cpu.procCpu"),
            "memPssPeak": m("mem.totalPss"),
            "tempPeak": m("temperature"),
        }
    if cat == "ios":
        return {
            "fpsPeak": m("fps"),
            "cpuProcPeak": m("cpuUsage"),
            "memFootprintPeak": m("physFootprint"),
        }
    if cat == "ios_gpu":
        return {
            "vertexOccPeak": m("Vertex Occupancy"),
            "fragOccPeak": m("Fragment Occupancy"),
            "aluUtilPeak": m("ALU Utilization"),
        }
    if cat == "pc":
        return {
            "fpsPeak": m("fps"),
            "cpuProcPeak": m("cpu.procCpu"),
            "memPssPeak": m("mem.totalPss"),
            "tempPeak": m("temperature"),
        }
    return {}


def parse_summary_dict(raw: Any) -> Dict[str, Any]:
    if raw is None:
        return {}
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            return json.loads(raw)
        except Exception:
            return {}
    return {}
