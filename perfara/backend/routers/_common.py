"""app.py 按 domain 拆分后的共享层。

职责：
  1. 集中 re-export 原先 ``app.py`` 顶层的后端依赖（models / schemas / database /
     auth_deps / parsers / utils / version / trend_metrics 等），让各 ``routers/*.py``
     的路由函数体可以逐字迁移 —— 路径、HTTP 方法、响应模型、状态码、鉴权依赖不变。
  2. 存放被多个路由共用的无状态纯函数与常量，避免在每个 router 里复制一份。

本模块**不做任何 I/O 副作用**：logging 初始化、建表、app 创建、静态挂载、
SPA fallback 全部留在 ``app.py``。这里只 import 模块，不调用有副作用的入口。
"""
import os
import json
import logging
from urllib.parse import urlsplit
from typing import List, Optional
from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException, Depends, Request, Query, Path
from fastapi.responses import JSONResponse, FileResponse, Response
from sqlalchemy.orm import Session, joinedload, load_only
from sqlalchemy.exc import IntegrityError
from sqlalchemy import delete as sa_delete
from sqlalchemy import delete, func, and_, or_, not_

from ..database import Base, engine, get_db, new_share_token
from ..models import (
    Project, TestRun, MetricBlob, ProjectAlias, ParsedInfo, PerfaraDemoSnapshot,
)
from ..schemas import (
    ProjectOut,
    TestRunOut,
    TestRunDetailOut,
    ProjectAliasIn,
    ProjectAliasOut,
    PagedTestRuns,
    ProjectWithInfoOut,
    ParsedInfoOut,
    TestLabelPatch,
    TrendSeriesOut,
    TrendPointOut,
)
from ..auth_deps import require_uid, resolve_uid, is_super_uid, is_demo_perfara_uid
from ..paths import APP_ROOT, resource
from ..parsers import parse_uploaded_json, canonical_content_hash
from ..utils import ensure_project_for_payload, sanitize_non_finite
from ..version import __version__
from ..trend_metrics import peaks_from_blob_content, parse_summary_dict
from ..logging_setup import setup_logging


# ── 常量（原 app.py 模块级常量，逐字迁移）────────────────────────────────────
def _cors_allow_origins():
    raw = os.environ.get("WEBPERF_CORS_ORIGINS", "").strip()
    if raw:
        return [o.strip() for o in raw.split(",") if o.strip()]
    return [
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:8000",
        "http://localhost:8000",
    ]


_UPLOAD_CONTENT_TYPES = ("application/json", "text/json", "multipart/form-data")

# SQLite INTEGER 为有符号 64 位；超过 2**63-1 的 Python int 传给 SQLite 会抛
# OverflowError（此前未加约束时会以 500 泄漏给客户端）。路径/查询里的整型 id
# 一律用 le=_MAX_SQLITE_INT 约束；app.py 的全局处理器作为兜底，任何漏网的超大整数
# 也返回 400 而不是 500。
_MAX_SQLITE_INT = 2**63 - 1

# 上传体上限：默认 16 MiB，可用 PERFARA_MAX_UPLOAD_BYTES 覆盖。
# 6.8 MB / 2 万点的真实样本仍可通过；再大的请求在入口直接 413。
MAX_UPLOAD_BYTES = max(1024, int(os.environ.get("PERFARA_MAX_UPLOAD_BYTES", str(16 * 1024 * 1024))))
MAX_UID_LEN = 128


# ── 共享纯函数（原 app.py，逐字迁移）────────────────────────────────────────
def _guard_upload_request(request: Request, content_type: str) -> None:
    """挡跨站写入与不合规 content-type。

    /api/upload 无需登录，任何网页都能向 127.0.0.1 发「简单请求」往库里写垃圾数据。
    带 Origin 的请求必须与 Host 同源，或在 WEBPERF_CORS_ORIGINS 白名单内；不带
    Origin 的是脚本/采集端，放行。content-type 只收 JSON 与 multipart ——
    text/plain 不触发预检，正是这类投毒的入口。
    """
    origin = (request.headers.get("origin") or "").strip()
    if origin and origin not in _cors_allow_origins():
        host = (request.headers.get("host") or "").strip().lower()
        if not host or urlsplit(origin).netloc.lower() != host:
            raise HTTPException(
                status_code=403,
                detail={"code": "cross_site_denied",
                        "message": "cross-site upload is not allowed"},
            )
    ctype = content_type.split(";", 1)[0].strip().lower()
    if ctype not in _UPLOAD_CONTENT_TYPES:
        raise HTTPException(
            status_code=415,
            detail={"code": "unsupported_content_type",
                    "message": "content-type must be application/json or multipart/form-data"},
        )


def _payload_too_large():
    return HTTPException(
        status_code=413,
        detail={
            "code": "payload_too_large",
            "message": f"payload exceeds {MAX_UPLOAD_BYTES} bytes",
        },
    )


async def _read_body_limited(request: Request) -> bytes:
    """流式读取 JSON body，超过上限立即中断，避免无 Content-Length 的 chunked 请求撑爆内存。"""
    total = 0
    chunks = []
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_UPLOAD_BYTES:
            raise _payload_too_large()
        chunks.append(chunk)
    return b"".join(chunks)


def _demo_snapshot_id_list(db: Session) -> List[int]:
    return [r[0] for r in db.query(PerfaraDemoSnapshot.test_run_id).all()]


def _uid_owns_test_row(test: TestRun, uid: str) -> bool:
    """是否视为该用户的测试：owner_uid 优先；为空时匹配 para1（旧数据仅 para1 时与列表一致）。"""
    u = (uid or "").strip().lower()
    if not u:
        return False
    ou = (test.owner_uid or "").strip()
    if ou:
        return ou.lower() == u
    p1 = (test.para1 or "").strip()
    return bool(p1) and p1.lower() == u


def _match_uid_to_testrun_sql(uid: str):
    """与 _uid_owns_test_row 一致的 SQL 条件（用于 query.filter）。"""
    u = (uid or "").strip().lower()
    if not u:
        return TestRun.id == -1
    return or_(
        func.lower(TestRun.owner_uid) == u,
        and_(
            or_(TestRun.owner_uid.is_(None), func.trim(TestRun.owner_uid) == ""),
            func.lower(TestRun.para1) == u,
        ),
    )


def _filter_test_runs_by_uid(query, db: Session, uid: str):
    """wonderxu 全量；perfara123 仅 perfara_demo_snapshot 内 test_run（演示只读，非万能）；其余 owner_uid 或 para1 兜底。"""
    if is_super_uid(uid):
        return query
    if is_demo_perfara_uid(uid):
        ids = _demo_snapshot_id_list(db)
        if not ids:
            return query.filter(TestRun.id == -1)
        return query.filter(TestRun.id.in_(ids))
    return query.filter(_match_uid_to_testrun_sql(uid))


def _first_nonempty_str(*vals) -> Optional[str]:
    for v in vals:
        if v is None:
            continue
        if isinstance(v, str):
            s = v.strip()
            if s:
                return s
    return None


def _parse_query_date_day(s: Optional[str]) -> Optional[datetime]:
    """前端传 YYYY-MM-DD；返回该日 0 点（naive，与入库的 started_at 一致）。"""
    if not s or not str(s).strip():
        return None
    s = str(s).strip()[:10]
    try:
        return datetime.strptime(s, "%Y-%m-%d")
    except ValueError:
        return None


def _effective_project_label(app_name: Optional[str], package_name: Optional[str]) -> Optional[str]:
    """展示/筛选用名称：非空应用名优先，否则用包名。"""
    a = (app_name or "").strip()
    if a:
        return a
    p = (package_name or "").strip()
    return p or None


def _effective_project_display_name(
    display_name: Optional[str], app_name: Optional[str], package_name: Optional[str]
) -> Optional[str]:
    """与主页列表「项目名称」一致：非空 display_name 优先，否则同 _effective_project_label。"""
    d = _first_nonempty_str(display_name)
    if d:
        return d
    return _effective_project_label(app_name, package_name)


def _project_effective_display_eq_col(project_name: str):
    """WHERE coalesce(nullif(trim(display_name),''), …) = project_name（与列表展示名一致）。"""
    pn = project_name.strip()
    dn = func.nullif(func.trim(Project.display_name), "")
    an = func.nullif(func.trim(Project.app_name), "")
    pkg = func.nullif(func.trim(Project.package_name), "")
    eff = func.coalesce(dn, an, pkg)
    return eff == pn


def _resolve_trend_project_name(
    project_name: Optional[str], app_name: Optional[str]
) -> str:
    s = (project_name or app_name or "").strip()
    if not s:
        raise HTTPException(status_code=400, detail="project_name is required")
    return s


def _norm_alias_field(s: Optional[str]) -> Optional[str]:
    """别名表：空串与数据库 NULL 对齐。"""
    if s is None:
        return None
    t = str(s).strip()
    return t if t else None


def _column_eq_optional(col, val: Optional[str]):
    """WHERE 列等于 val；val 为 None 时匹配 SQL NULL。"""
    if val is None:
        return col.is_(None)
    return col == val
