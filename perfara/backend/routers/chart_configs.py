"""图表分组配置路由：把 chart-configs/*.json 作为静态 JSON 供前端分组。"""
import json
from fastapi import APIRouter

router = APIRouter()


@router.get("/api/chart-configs")
def get_chart_configs():
    # Served as static JSON for frontend to group metrics
    from ..settings import CONFIGS_DIR
    import os

    def read_json(path: str):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    return {
        "android": read_json(os.path.join(CONFIGS_DIR, "android_chart_groups.json")),
        "ios": read_json(os.path.join(CONFIGS_DIR, "ios_chart_groups.json")),
        "ios_gpu": {
            "groups": read_json(os.path.join(CONFIGS_DIR, "ios_gpu_chart_groups.json")),
            "low_gpu_groups": read_json(
                os.path.join(CONFIGS_DIR, "ios_low_gpu_groups.json")
            ),
        },
        "pc": read_json(os.path.join(CONFIGS_DIR, "pc_chart_groups.json")),
    }
