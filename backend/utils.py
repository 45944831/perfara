from sqlalchemy.orm import Session
from datetime import datetime
from typing import Dict, Any, Optional
from .models import Project, ProjectAlias
import hashlib
import json


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


def ensure_project_for_payload(db: Session, payload: Dict[str, Any]) -> Project:
    device = payload.get("device") or {}
    pkg = device.get("bundleId") or payload.get("package") or payload.get("packageName")
    app_name = device.get("appName") or payload.get("app") or payload.get("appName")
    category = (device.get("category") or payload.get("category") or "")
    platform = guess_platform(category) or payload.get("platform")

    # Try alias
    display_name = None
    if pkg or app_name:
        alias = (
            db.query(ProjectAlias)
            .filter(
                (ProjectAlias.package_name == pkg) | (ProjectAlias.app_name == app_name)
            )
            .first()
        )
        if alias and alias.display_name:
            display_name = alias.display_name

    project = None
    if pkg or app_name:
        project = (
            db.query(Project)
            .filter(
                (Project.package_name == pkg) | (Project.app_name == app_name),
            )
            .first()
        )
    # 无包名/应用名时，尽量复用同名展示项目，避免无限创建
    if not project:
        fallback_name = display_name or app_name or pkg or device.get("name") or payload.get("label") or payload.get("file") or "未命名项目"
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
            or payload.get("label")
            or payload.get("file")
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


def compute_content_hash(payload: Dict[str, Any]) -> str:
    # Stable canonical JSON for hashing
    data = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
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


def build_summary(category: str, root_series: Dict[str, Any]) -> Dict[str, Any]:
    # Expect structure: {"timestamp": [...], "series": {...}}
    series = root_series.get("series") if isinstance(root_series, dict) else None
    if not isinstance(series, dict):
        return {}
    cat = (category or "").lower()

    def a(path):  # avg helper
        node = try_get(series, path)
        return avg(node) if isinstance(node, list) else None

    summary = {}
    if "android" in cat:
        summary["fpsAvg"] = a("fps")
        summary["cpuProcAvg"] = a("cpu.procCpu")
        summary["memPssAvg"] = a("mem.totalPss")
    elif "gpu" in cat and "ios" in cat:
        summary["vertexOccAvg"] = a("Vertex Occupancy")
        summary["fragOccAvg"] = a("Fragment Occupancy")
        summary["aluUtilAvg"] = a("ALU Utilization")
    elif "ios" in cat:
        summary["fpsAvg"] = a("fps")
        summary["cpuProcAvg"] = a("cpuUsage")
        summary["memFootprintAvg"] = a("physFootprint")
    elif cat == "pc":
        summary["fpsAvg"] = a("fps")
        summary["cpuProcAvg"] = a("cpu.procCpu")
        summary["memPssAvg"] = a("mem.totalPss")
        summary["tempAvg"] = a("temperature")
    return {k: v for k, v in summary.items() if v is not None}

