from pydantic import BaseModel
try:
    # pydantic v2
    from pydantic import ConfigDict
    HAS_V2 = True
except Exception:
    HAS_V2 = False
from typing import Optional, List, Dict, Any
from datetime import datetime
from .models import TestRun, Project, ProjectAlias, MetricBlob
import json
from typing import Tuple
import hashlib


class ProjectOut(BaseModel):
    id: int
    display_name: Optional[str]
    package_name: Optional[str]
    app_name: Optional[str]
    platform: Optional[str]
    created_at: datetime
    updated_at: datetime

    if HAS_V2:
        model_config = ConfigDict(from_attributes=True)
    else:
        class Config:
            orm_mode = True
    @classmethod
    def from_model(cls, m: Project):
        # Fallback display: prefer display_name, else app_name, else package_name
        name = getattr(m, "display_name", None) or getattr(m, "app_name", None) or getattr(m, "package_name", None) or "未命名项目"
        base = dict(
            id=m.id,
            display_name=name,
            package_name=getattr(m, "package_name", None),
            app_name=getattr(m, "app_name", None),
            platform=getattr(m, "platform", None),
            created_at=getattr(m, "created_at"),
            updated_at=getattr(m, "updated_at"),
        )
        if HAS_V2:
            return cls.model_validate(base)
        return cls(**base)


class TestRunOut(BaseModel):
    id: int
    project_id: int
    category: str
    started_at: datetime
    ended_at: Optional[datetime]
    device: Optional[str]
    label: Optional[str]
    owner_uid: Optional[str] = None
    para1: Optional[str] = None
    para2: Optional[str] = None
    summary: Optional[Dict[str, Any]] = None
    # 来自 projects，列表展示用（需 joinedload(TestRun.project)）
    app_name: Optional[str] = None
    package_name: Optional[str] = None
    project_display_name: Optional[str] = None
    md5: Optional[str] = None

    if HAS_V2:
        model_config = ConfigDict(from_attributes=True)
    else:
        class Config:
            orm_mode = True

    @classmethod
    def from_model(cls, t: TestRun):
        raw_summary = None
        try:
            if isinstance(t.summary, str) and t.summary.strip():
                raw_summary = json.loads(t.summary)
            elif isinstance(t.summary, dict):
                raw_summary = t.summary
        except Exception:
            raw_summary = None
        proj = getattr(t, "project", None)
        test_md5 = getattr(t, "share_md5", None)
        base = {
            "id": t.id,
            "project_id": t.project_id,
            "category": t.category,
            "started_at": t.started_at,
            "ended_at": t.ended_at,
            "device": t.device,
            "label": t.label,
            "owner_uid": getattr(t, "owner_uid", None),
            "para1": getattr(t, "para1", None),
            "para2": getattr(t, "para2", None),
            "summary": raw_summary,
            "app_name": getattr(proj, "app_name", None) if proj else None,
            "package_name": getattr(proj, "package_name", None) if proj else None,
            "project_display_name": getattr(proj, "display_name", None) if proj else None,
            "md5": test_md5,
        }
        if HAS_V2:
            return cls.model_validate(base)
        return cls(**base)


def _loads_dict_or_none(raw: Any) -> Optional[dict]:
    """容错解析：脏数据 / 被截断的 JSON 只降级为空，不把整个请求打成 500。"""
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        val = json.loads(raw)
    except Exception:
        return None
    return val if isinstance(val, dict) else None


class MetricBlobOut(BaseModel):
    id: int
    content: Dict[str, Any]

    @classmethod
    def from_orm_with_json(cls, blob: MetricBlob):
        # content 是自由文本列，历史脏数据或打包脱敏改坏的 JSON 都可能落在这里；
        # 此前直接 json.loads，一条坏 blob 就让详情页整页 500。
        return cls(id=blob.id, content=_loads_dict_or_none(blob.content) or {})


class TestRunDetailOut(BaseModel):
    id: int
    project: ProjectOut
    test: TestRunOut
    blobs: List[MetricBlobOut]
    test_raw: Optional[dict] = None

    @classmethod
    def from_orm_and_blobs(cls, test: TestRun, blobs: List[MetricBlob]):
        base = {
            "id": test.id,
            "project": ProjectOut.from_model(test.project),
            "test": TestRunOut.from_model(test),
            "blobs": [MetricBlobOut.from_orm_with_json(b) for b in blobs],
            "test_raw": _loads_dict_or_none(test.raw_json),
        }
        if HAS_V2:
            return cls.model_validate(base)
        return cls(**base)


class ProjectAliasIn(BaseModel):
    package_name: Optional[str] = None
    app_name: Optional[str] = None
    display_name: str


class ProjectAliasOut(BaseModel):
    id: int
    package_name: Optional[str]
    app_name: Optional[str]
    display_name: Optional[str]

    if HAS_V2:
        model_config = ConfigDict(from_attributes=True)
    else:
        class Config:
            orm_mode = True

    @classmethod
    def from_model(cls, m: ProjectAlias):
        base = dict(
            id=m.id,
            package_name=getattr(m, "package_name", None),
            app_name=getattr(m, "app_name", None),
            display_name=getattr(m, "display_name", None),
        )
        if HAS_V2:
            return cls.model_validate(base)
        return cls(**base)


class ParsedInfoOut(BaseModel):
    id: int
    project_id: int
    test_run_id: int
    category: Optional[str]
    device: Optional[str]
    package_name: Optional[str]
    app_name: Optional[str]
    summary: Optional[Dict[str, Any]] = None
    created_at: datetime

    @classmethod
    def from_row(cls, row: Any):
        # row is ORM object with attributes matching columns
        summary = None
        try:
            if getattr(row, "summary_json", None):
                summary = json.loads(getattr(row, "summary_json"))
        except Exception:
            summary = None
        base = dict(
            id=row.id,
            project_id=row.project_id,
            test_run_id=row.test_run_id,
            category=row.category,
            device=row.device,
            package_name=row.package_name,
            app_name=row.app_name,
            summary=summary,
            created_at=row.created_at,
        )
        if HAS_V2:
            return cls.model_validate(base)
        return cls(**base)


class ProjectWithInfoOut(BaseModel):
    project: ProjectOut
    latest_info: Optional[ParsedInfoOut]


class PagedTestRuns(BaseModel):
    items: List[TestRunOut]
    total: int
    page: int
    page_size: int


class TestLabelPatch(BaseModel):
    """更新单条测试的场景标记（label）。"""

    label: Optional[str] = None


class TrendPointOut(BaseModel):
    id: int
    started_at: datetime
    means: Dict[str, Any]
    peaks: Dict[str, Any]


class TrendSeriesOut(BaseModel):
    """同一标签 + 平台下按上传时间排序的趋势点。"""

    label: str
    category: str
    points: List[TrendPointOut]

