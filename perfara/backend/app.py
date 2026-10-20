import os
import hashlib
from fastapi import FastAPI, HTTPException, Depends, Request, Query, Path
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse, Response
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session, joinedload
import json
from typing import List, Optional
from datetime import datetime, timedelta
from .database import Base, engine, get_db
from .models import Project, TestRun, MetricBlob, ProjectAlias, ParsedInfo, PerfaraDemoSnapshot
from .schemas import (
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
from .auth_deps import require_uid, resolve_uid, is_super_uid, is_demo_perfara_uid
from .paths import APP_ROOT, resource
from .parsers import parse_uploaded_json
from .utils import ensure_project_for_payload
from .version import __version__
from .trend_metrics import peaks_from_blob_content, parse_summary_dict
from .logging_setup import setup_logging
import logging
from sqlalchemy import delete as sa_delete
from sqlalchemy import delete, func, and_, or_, not_


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


# Initialize logging to <可写目录>/logs/app.log（打包后即 exe 同级的 logs/）
_log_file = setup_logging(str(APP_ROOT))
logging.getLogger(__name__).info("Logging initialized at %s", _log_file)

Base.metadata.create_all(bind=engine)

app = FastAPI(title="Web Performance Dashboard API", version=__version__)

# SQLite INTEGER 为有符号 64 位；超过 2**63-1 的 Python int 传给 SQLite 会抛
# OverflowError（此前未加约束时会以 500 泄漏给客户端）。路径/查询里的整型 id
# 一律用 le=_MAX_SQLITE_INT 约束；此全局处理器作为兜底，任何漏网的超大整数
# 也返回 400 而不是 500。
_MAX_SQLITE_INT = 2**63 - 1


@app.exception_handler(OverflowError)
async def _overflow_error_handler(request: Request, exc: OverflowError):
    return JSONResponse(
        status_code=400,
        content={"detail": "integer parameter out of range"},
    )


app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_allow_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# NOTE: Frontend static mounting is moved to the bottom of this file,
# after all API routes are registered, to avoid 404/405 on /api/*.

@app.get("/api/health")
def health():
    logging.getLogger("api").info("health check")
    return {"status": "ok", "version": __version__}


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


@app.post("/api/upload", response_model=TestRunOut)
async def upload_json(
    request: Request,
    db: Session = Depends(get_db),
):
    """无需鉴权。multipart：须含 file、uid；para2 可选；para1 仅备用存储。JSON body：查询参数 uid；para1/para2 同上。"""
    content_type = request.headers.get("content-type") or ""
    payload = None
    p_uid: Optional[str] = None
    p_para1: Optional[str] = None
    p2: Optional[str] = None
    if "multipart/form-data" in content_type:
        form = await request.form()
        b = form.get("para2")
        if isinstance(b, str):
            p2 = b.strip() or None
        u_raw = form.get("uid")
        p_uid = _first_nonempty_str(u_raw if isinstance(u_raw, str) else None)
        p_raw = form.get("para1")
        p_para1 = _first_nonempty_str(p_raw if isinstance(p_raw, str) else None)
        up = form.get("file")
        if up is None:
            raise HTTPException(status_code=400, detail="file field required for multipart upload")
        fn = getattr(up, "filename", "") or ""
        if not str(fn).lower().endswith(".json"):
            raise HTTPException(status_code=400, detail="Only .json files are supported")
        try:
            raw = await up.read()
            text = raw.decode("utf-8")
            payload = json.loads(text)
        except UnicodeDecodeError as e:
            raise HTTPException(
                status_code=400,
                detail={"code": "decode_error", "message": f"UTF-8 decode failed: {e}"},
            )
        except json.JSONDecodeError as e:
            raise HTTPException(
                status_code=400,
                detail={"code": "invalid_json", "message": f"JSON parse failed: {e}"},
            )
        except Exception as e:
            raise HTTPException(
                status_code=400,
                detail={"code": "upload_error", "message": f"File read failed: {e}"},
            )
    else:
        qp = request.query_params
        p_uid = _first_nonempty_str(qp.get("uid"))
        p_para1 = _first_nonempty_str(qp.get("para1"))
        p2 = (qp.get("para2") or "").strip() or None
        try:
            body = await request.body()
            text = body.decode("utf-8")
            payload = json.loads(text)
        except UnicodeDecodeError as e:
            raise HTTPException(
                status_code=400,
                detail={"code": "decode_error", "message": f"UTF-8 decode failed: {e}"},
            )
        except json.JSONDecodeError as e:
            raise HTTPException(
                status_code=400,
                detail={"code": "invalid_json", "message": f"JSON parse failed: {e}"},
            )
        except Exception as e:
            raise HTTPException(
                status_code=400,
                detail={"code": "upload_error", "message": f"Request read failed: {e}"},
            )

    if not p_uid:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "missing_params",
                "message": "uid is required (multipart: form field uid; JSON body: query uid). para2 optional; para1 optional spare only (no access logic)",
            },
        )

    if is_demo_perfara_uid(p_uid):
        raise HTTPException(
            status_code=403,
            detail={
                "code": "demo_readonly",
                "message": "演示账号 perfara123 不可上传，请使用自有 UID",
            },
        )

    project = ensure_project_for_payload(db, payload)
    # de-dup check by content hash
    # compute hash via parser (to keep single point of truth)
    from .utils import compute_content_hash
    content_hash = compute_content_hash(payload)
    existing = (
        db.query(TestRun)
        .filter(
            TestRun.project_id == project.id,
            TestRun.content_hash == content_hash,
            _match_uid_to_testrun_sql(p_uid),
            TestRun.para2 == p2,
        )
        .first()
    )
    if existing:
        logging.getLogger("api").info("upload dedup hit project_id=%s test_id=%s", project.id, existing.id)
        return TestRunOut.from_model(existing)

    try:
        test_run, metrics = parse_uploaded_json(
            db, project, payload, owner_uid=p_uid, para1=p_para1, para2=p2
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail={"code": "parse_error", "message": f"{type(e).__name__}: {e}"},
        )
    db.add(test_run)
    for m in metrics:
        db.add(m)
    try:
        db.commit()
    except Exception as e:
        db.rollback()
        logging.getLogger("api").exception("db commit failed: %s", e)
        raise HTTPException(
            status_code=500,
            detail={"code": "db_error", "message": f"{type(e).__name__}: {e}"},
        )
    # snapshot parsed info
    try:
        pi = ParsedInfo(
            project_id=project.id,
            test_run_id=test_run.id,
            category=test_run.category,
            device=test_run.device,
            package_name=project.package_name,
            app_name=project.app_name,
            summary_json=test_run.summary,
        )
        db.add(pi)
        db.commit()
    except Exception as e:
        db.rollback()
        logging.getLogger("api").exception("insert parsed_info failed: %s", e)
        # do not break upload success; continue
    db.refresh(test_run)
    logging.getLogger("api").info("upload ok test_id=%s category=%s", test_run.id, test_run.category)
    return TestRunOut.from_model(test_run)


@app.get("/api/projects", response_model=List[ProjectOut])
def list_projects(
    q: Optional[str] = None,
    db: Session = Depends(get_db),
    uid: str = Depends(require_uid),
):
    if is_super_uid(uid):
        query = db.query(Project)
    elif is_demo_perfara_uid(uid):
        ids = _demo_snapshot_id_list(db)
        if not ids:
            return []
        pids = [
            row[0]
            for row in db.query(TestRun.project_id).filter(TestRun.id.in_(ids)).distinct().all()
        ]
        if not pids:
            return []
        query = db.query(Project).filter(Project.id.in_(pids))
    else:
        mine = (
            db.query(TestRun.project_id)
            .filter(_match_uid_to_testrun_sql(uid))
            .distinct()
            .all()
        )
        pids = [row[0] for row in mine]
        if not pids:
            return []
        query = db.query(Project).filter(Project.id.in_(pids))
    if q:
        like = f"%{q}%"
        query = query.filter(
            (Project.display_name.ilike(like))
            | (Project.package_name.ilike(like))
            | (Project.app_name.ilike(like))
        )
    projects = query.order_by(Project.updated_at.desc()).all()
    items = [ProjectOut.from_model(p) for p in projects]
    logging.getLogger("api").info("list_projects count=%s", len(items))
    return items


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


@app.get("/api/tests", response_model=PagedTestRuns)
def list_tests(
    project_id: Optional[int] = Query(None, le=_MAX_SQLITE_INT),
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    page: int = Query(1, ge=1, le=1_000_000),
    page_size: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
    uid: str = Depends(require_uid),
):
    query = _filter_test_runs_by_uid(db.query(TestRun), db, uid)
    if project_id:
        query = query.filter(TestRun.project_id == project_id)
    # 仅在前端传入日期时才筛选；不传则列出该 UID 下全部记录（避免默认「近一年」把更早数据筛没）
    df = _parse_query_date_day(date_from)
    if df is not None:
        query = query.filter(TestRun.started_at >= df)
    dt_end = _parse_query_date_day(date_to)
    if dt_end is not None:
        query = query.filter(TestRun.started_at < dt_end + timedelta(days=1))
    elif date_to and str(date_to).strip():
        query = query.filter(TestRun.started_at <= date_to)
    total = query.count()
    page = max(page, 1)
    page_size = max(1, min(page_size, 500))
    offset = (page - 1) * page_size
    items = (
        query.options(joinedload(TestRun.project))
        .order_by(TestRun.started_at.desc(), TestRun.id.desc())
        .offset(offset)
        .limit(page_size)
        .all()
    )
    result = {
        "items": [TestRunOut.from_model(t) for t in items],
        "total": total,
        "page": page,
        "page_size": page_size,
    }
    logging.getLogger("api").info("list_tests total=%s page=%s size=%s items=%s", total, page, page_size, len(result["items"]))
    return result


@app.get("/api/tests/distinct-labels", response_model=List[str])
def distinct_test_labels(
    db: Session = Depends(get_db),
    uid: str = Depends(require_uid),
):
    """当前用户曾使用过的非空场景标记（去重排序）。"""
    q = db.query(TestRun.label).filter(TestRun.label.isnot(None)).filter(TestRun.label != "")
    q = _filter_test_runs_by_uid(q, db, uid)
    rows = q.distinct().all()
    seen = set()
    for (lab,) in rows:
        if lab and str(lab).strip():
            seen.add(str(lab).strip())
    return sorted(seen)


@app.get("/api/tests/distinct-app-names", response_model=List[str])
def distinct_test_app_names(
    db: Session = Depends(get_db),
    uid: str = Depends(require_uid),
):
    """当前用户测试关联项目的展示名（与列表「项目名称」一致：display_name 优先，否则应用名，否则包名）；去重排序。"""
    q = db.query(Project.display_name, Project.app_name, Project.package_name).join(
        TestRun, TestRun.project_id == Project.id
    )
    q = _filter_test_runs_by_uid(q, db, uid)
    seen = set()
    for dn, an, pn in q.all():
        lab = _effective_project_display_name(dn, an, pn)
        if lab:
            seen.add(lab)
    return sorted(seen)


@app.get("/api/tests/distinct-labels-for-app", response_model=List[str])
def distinct_labels_for_app(
    category: str = Query(..., description="android | ios | ios_gpu | pc"),
    project_name: Optional[str] = Query(None, min_length=1, description="项目名称，与列表展示一致"),
    app_name: Optional[str] = Query(
        None,
        min_length=1,
        description="兼容旧参数，含义同 project_name",
    ),
    db: Session = Depends(get_db),
    uid: str = Depends(require_uid),
):
    """当前用户下，指定项目名称与平台类型曾出现过的非空场景标记（去重排序）。"""
    cat = category.strip().lower()
    pname = _resolve_trend_project_name(project_name, app_name)
    if cat not in ("android", "ios", "ios_gpu", "pc"):
        raise HTTPException(status_code=400, detail="category must be android, ios, ios_gpu, or pc")
    query = _filter_test_runs_by_uid(
        db.query(TestRun.label).filter(TestRun.category == cat),
        db,
        uid,
    )
    query = query.join(Project, TestRun.project_id == Project.id).filter(
        _project_effective_display_eq_col(pname)
    )
    query = query.filter(TestRun.label.isnot(None)).filter(func.trim(TestRun.label) != "")
    rows = query.distinct().all()
    seen = set()
    for (lab,) in rows:
        if lab and str(lab).strip():
            seen.add(str(lab).strip())
    return sorted(seen)


@app.get("/api/tests/trend", response_model=TrendSeriesOut)
def tests_trend(
    label: str = Query(..., min_length=1, description="场景标记，与列表「场景标记」一致"),
    category: str = Query(..., description="android | ios | ios_gpu | pc"),
    project_name: Optional[str] = Query(
        None,
        min_length=1,
        description="项目名称，与列表「项目名称」及 GET /api/tests/distinct-app-names 一致",
    ),
    app_name: Optional[str] = Query(
        None,
        min_length=1,
        description="兼容旧参数，含义同 project_name",
    ),
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    limit: int = Query(200, ge=1, le=500),
    db: Session = Depends(get_db),
    uid: str = Depends(require_uid),
):
    """同一标签 + 同一测试类型 + 指定项目名称（display_name 优先），按上传时间升序。"""
    lab = label.strip()
    cat = category.strip().lower()
    pname = _resolve_trend_project_name(project_name, app_name)
    if cat not in ("android", "ios", "ios_gpu", "pc"):
        raise HTTPException(status_code=400, detail="category must be android, ios, ios_gpu, or pc")
    query = _filter_test_runs_by_uid(
        db.query(TestRun).filter(TestRun.label == lab).filter(TestRun.category == cat),
        db,
        uid,
    )
    query = query.join(Project, TestRun.project_id == Project.id).filter(
        _project_effective_display_eq_col(pname)
    )
    if not date_from:
        query = query.filter(TestRun.started_at >= datetime.utcnow() - timedelta(days=365 * 3))
    else:
        df = _parse_query_date_day(date_from)
        if df:
            query = query.filter(TestRun.started_at >= df)
    if date_to:
        dt_end = _parse_query_date_day(date_to)
        if dt_end:
            query = query.filter(TestRun.started_at < dt_end + timedelta(days=1))
    tests = (
        query.options(joinedload(TestRun.metric_blobs))
        .order_by(TestRun.started_at.asc(), TestRun.id.asc())
        .limit(limit)
        .all()
    )
    points: List[TrendPointOut] = []
    for t in tests:
        means = parse_summary_dict(t.summary)
        peaks: dict = {}
        blobs = sorted(t.metric_blobs or [], key=lambda b: b.id)
        if blobs:
            try:
                content = json.loads(blobs[0].content)
                if isinstance(content, dict):
                    peaks = peaks_from_blob_content(content, t.category or cat)
            except Exception:
                peaks = {}
        points.append(
            TrendPointOut(
                id=t.id,
                started_at=t.started_at,
                means=means,
                peaks=peaks,
            )
        )
    return TrendSeriesOut(label=lab, category=cat, points=points)


@app.get("/api/tests/{test_id}", response_model=TestRunDetailOut)
def get_test_detail(
    test_id: int = Path(..., le=_MAX_SQLITE_INT),
    db: Session = Depends(get_db),
    testid: Optional[str] = Query(None),
    uid: Optional[str] = Depends(resolve_uid),
):
    test = db.query(TestRun).filter(TestRun.id == test_id).first()
    if not test:
        raise HTTPException(status_code=404, detail="Test not found")

    expected_md5 = getattr(test, "share_md5", None) or hashlib.md5(str(test.id).encode("utf-8")).hexdigest()
    token_ok = bool(testid) and str(testid) == expected_md5

    if uid is None:
        if not token_ok:
            raise HTTPException(status_code=404, detail="Test not found")
    else:
        if is_super_uid(uid):
            pass
        elif is_demo_perfara_uid(uid):
            in_demo = (
                db.query(PerfaraDemoSnapshot.test_run_id)
                .filter(PerfaraDemoSnapshot.test_run_id == test.id)
                .first()
            )
            if not in_demo and not token_ok:
                raise HTTPException(status_code=404, detail="Test not found")
        elif not _uid_owns_test_row(test, uid) and not token_ok:
            raise HTTPException(status_code=404, detail="Test not found")
    blobs = (
        db.query(MetricBlob)
        .filter(MetricBlob.test_run_id == test_id)
        .order_by(MetricBlob.id.asc())
        .all()
    )
    return TestRunDetailOut.from_orm_and_blobs(test, blobs)


@app.get("/api/public/test", response_model=TestRunDetailOut)
def get_test_detail_public(
    testid: str,
    db: Session = Depends(get_db),
):
    """Public read-only access by share token (md5). No auth."""
    token = (testid or "").strip()
    if not token:
        raise HTTPException(status_code=404, detail="Test not found")
    test = db.query(TestRun).filter(TestRun.share_md5 == token).first()
    if not test:
        # legacy fallback: token might be md5(str(id)) but share_md5 not backfilled yet
        # (should be rare; best-effort scan recent ids)
        recent = db.query(TestRun).order_by(TestRun.id.desc()).limit(5000).all()
        for t in recent:
            if hashlib.md5(str(t.id).encode("utf-8")).hexdigest() == token:
                test = t
                break
    if not test:
        raise HTTPException(status_code=404, detail="Test not found")
    blobs = (
        db.query(MetricBlob)
        .filter(MetricBlob.test_run_id == test.id)
        .order_by(MetricBlob.id.asc())
        .all()
    )
    return TestRunDetailOut.from_orm_and_blobs(test, blobs)


@app.patch("/api/tests/{test_id}/label", response_model=TestRunOut)
def patch_test_label(
    body: TestLabelPatch,
    test_id: int = Path(..., le=_MAX_SQLITE_INT),
    db: Session = Depends(get_db),
    uid: str = Depends(require_uid),
):
    if is_demo_perfara_uid(uid):
        raise HTTPException(
            status_code=403,
            detail="演示账号仅可查看，不可修改",
        )
    test = db.query(TestRun).filter(TestRun.id == test_id).first()
    if not test or (not is_super_uid(uid) and not _uid_owns_test_row(test, uid)):
        raise HTTPException(status_code=404, detail="Test not found")
    if body.label is not None:
        s = (body.label or "").strip()
        test.label = (s[:512] if s else None)
    db.commit()
    db.refresh(test)
    return TestRunOut.from_model(test)


@app.delete("/api/tests/{test_id}", status_code=204)
def delete_test(
    test_id: int = Path(..., le=_MAX_SQLITE_INT),
    db: Session = Depends(get_db),
    uid: str = Depends(require_uid),
):
    if is_demo_perfara_uid(uid):
        raise HTTPException(
            status_code=403,
            detail="演示账号仅可查看，不可删除",
        )
    test = db.query(TestRun).filter(TestRun.id == test_id).first()
    if not test or (not is_super_uid(uid) and not _uid_owns_test_row(test, uid)):
        raise HTTPException(status_code=404, detail="Test not found")
    db.execute(delete(MetricBlob).where(MetricBlob.test_run_id == test_id))
    db.execute(delete(ParsedInfo).where(ParsedInfo.test_run_id == test_id))
    db.execute(delete(TestRun).where(TestRun.id == test_id))
    db.commit()
    return Response(status_code=204)


@app.get(
    "/api/project-aliases",
    response_model=List[ProjectAliasOut],
    dependencies=[Depends(require_uid)],
)
def list_aliases(db: Session = Depends(get_db)):
    aliases = db.query(ProjectAlias).order_by(ProjectAlias.id.asc()).all()
    return [ProjectAliasOut.from_model(a) for a in aliases]


@app.put(
    "/api/project-aliases",
    response_model=List[ProjectAliasOut],
)
def upsert_aliases(
    items: List[ProjectAliasIn],
    db: Session = Depends(get_db),
    uid: str = Depends(require_uid),
):
    if is_demo_perfara_uid(uid):
        raise HTTPException(status_code=403, detail="演示账号不可修改别名")
    updated: List[ProjectAliasOut] = []
    for item in items:
        pkg = _norm_alias_field(item.package_name)
        appn = _norm_alias_field(item.app_name)
        disp = (item.display_name or "").strip()
        alias = (
            db.query(ProjectAlias)
            .filter(
                _column_eq_optional(ProjectAlias.package_name, pkg),
                _column_eq_optional(ProjectAlias.app_name, appn),
            )
            .first()
        )
        if alias:
            alias.display_name = disp if disp else None
        else:
            alias = ProjectAlias(
                package_name=pkg,
                app_name=appn,
                display_name=disp if disp else None,
            )
            db.add(alias)
            db.flush()
        updated.append(ProjectAliasOut.from_model(alias))
    db.commit()
    return updated


@app.get("/api/chart-configs")
def get_chart_configs():
    # Served as static JSON for frontend to group metrics
    from .settings import CONFIGS_DIR
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


# Admin: reparse stored raw_json to backfill category/summary/blobs
class _Skip(Exception):
    """reparse 中跳过某一条（非错误，如 raw_json 为空 / 无 owner_uid）。"""


@app.post("/api/admin/reparse")
def admin_reparse(
    test_id: Optional[int] = Query(None, le=_MAX_SQLITE_INT),
    limit: int = Query(1000, ge=1, le=100000),
    db: Session = Depends(get_db),
    uid: str = Depends(require_uid),
):
    if is_demo_perfara_uid(uid):
        raise HTTPException(status_code=403, detail="演示账号不可使用管理重解析")
    targets = []
    if test_id:
        q = db.query(TestRun).filter(TestRun.id == test_id)
        if not is_super_uid(uid):
            q = q.filter(_match_uid_to_testrun_sql(uid))
        t = q.first()
        if not t:
            raise HTTPException(status_code=404, detail="Test not found")
        targets = [t]
    else:
        q = db.query(TestRun)
        if not is_super_uid(uid):
            q = q.filter(_match_uid_to_testrun_sql(uid))
        targets = q.order_by(TestRun.id.asc()).limit(min(limit, 5000)).all()
    changed = 0
    failed = 0
    for t in targets:
        try:
            # 每条独立 savepoint：任一条失败只回滚它自己，不会带着「已删未重建」的
            # 中间状态继续跑（旧逻辑先删 blob 再解析，解析一抛错就永久丢掉该测试时序数据）。
            with db.begin_nested():
                payload = json.loads(t.raw_json) if t.raw_json else None
                if not payload:
                    raise _Skip("empty raw_json")
                project = t.project
                ouid = (getattr(t, "owner_uid", None) or t.para1 or "").strip()
                if not ouid:
                    raise _Skip("no owner_uid/para1")
                new_run, blobs = parse_uploaded_json(
                    db,
                    project,
                    payload,
                    owner_uid=ouid,
                    para1=getattr(t, "para1", None),
                    para2=getattr(t, "para2", None),
                )
                # Clear old blobs / parsed_info（旧逻辑只增不删，reparse 几次就重复几行）
                db.execute(sa_delete(MetricBlob).where(MetricBlob.test_run_id == t.id))
                db.execute(sa_delete(ParsedInfo).where(ParsedInfo.test_run_id == t.id))
                # 先 flush 让本轮改动进入事务，冲突检测才看得到
                db.flush()
                # content_hash 若与同项目其他记录冲突（如同一 JSON 被不同 UID 各传过一次），
                # 保留旧 hash，避免唯一约束 (project_id, content_hash) 使整个 reparse 500。
                _hash_conflict = (
                    db.query(TestRun.id)
                    .filter(
                        TestRun.project_id == t.project_id,
                        TestRun.content_hash == new_run.content_hash,
                        TestRun.id != t.id,
                    )
                    .first()
                )
                if not _hash_conflict:
                    t.content_hash = new_run.content_hash
                # Copy back fields
                t.category = new_run.category
                t.started_at = new_run.started_at
                t.ended_at = new_run.ended_at
                t.device = new_run.device
                # 保留手工编辑的场景标记：仅当为空时才采用推导值，避免 reparse 清空用户设置
                if not (t.label or "").strip():
                    t.label = new_run.label
                t.summary = new_run.summary
                for b in blobs:
                    # 重新挂到已有 TestRun 上（设关系，而非仅设 FK）；否则 blob 级联把
                    # parser 构造的临时 TestRun 一并 INSERT，触发 (project_id, content_hash)
                    # 唯一约束使整个 reparse 以 500 失败。
                    b.test_run = t
                    b.test_run_id = t.id
                    db.add(b)
                # also snapshot parsed_info
                db.add(
                    ParsedInfo(
                        project_id=t.project_id,
                        test_run_id=t.id,
                        category=t.category,
                        device=t.device,
                        package_name=t.project.package_name,
                        app_name=t.project.app_name,
                        summary_json=t.summary,
                    )
                )
            changed += 1
        except _Skip as sk:
            logging.getLogger("api").warning("reparse skipped test_id=%s: %s", t.id, sk)
        except Exception as e:
            failed += 1
            logging.getLogger("api").exception("reparse failed test_id=%s: %s", t.id, e)
    try:
        db.commit()
    except Exception as e:
        db.rollback()
        logging.getLogger("api").exception("reparse commit failed: %s", e)
        raise HTTPException(status_code=500, detail="reparse failed and rolled back: %s" % e)
    return {"reparsed": changed, "failed": failed, "total": len(targets)}


@app.get("/api/projects/with-info", response_model=List[ProjectWithInfoOut])
def projects_with_latest_info(
    db: Session = Depends(get_db),
    uid: str = Depends(require_uid),
):
    if is_super_uid(uid):
        projects = db.query(Project).all()
    elif is_demo_perfara_uid(uid):
        ids = _demo_snapshot_id_list(db)
        if not ids:
            return []
        pids = [
            row[0]
            for row in db.query(TestRun.project_id).filter(TestRun.id.in_(ids)).distinct().all()
        ]
        if not pids:
            return []
        projects = db.query(Project).filter(Project.id.in_(pids)).all()
    else:
        mine = (
            db.query(TestRun.project_id)
            .filter(_match_uid_to_testrun_sql(uid))
            .distinct()
            .all()
        )
        pids = [row[0] for row in mine]
        if not pids:
            return []
        projects = db.query(Project).filter(Project.id.in_(pids)).all()
    # for each project, find latest parsed_info
    out = []
    for p in projects:
        latest = (
            db.query(ParsedInfo)
            .filter(ParsedInfo.project_id == p.id)
            .order_by(ParsedInfo.created_at.desc(), ParsedInfo.id.desc())
            .first()
        )
        out.append(
            ProjectWithInfoOut(
                project=ProjectOut.from_model(p),
                latest_info=ParsedInfoOut.from_row(latest) if latest else None,
            )
        )
    return out


@app.get("/api/projects/{project_id}/infos", response_model=List[ParsedInfoOut])
def list_project_infos(
    project_id: int = Path(..., le=_MAX_SQLITE_INT),
    limit: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_db),
    uid: str = Depends(require_uid),
):
    if not is_super_uid(uid):
        if is_demo_perfara_uid(uid):
            allowed = (
                db.query(TestRun.id)
                .filter(
                    TestRun.project_id == project_id,
                    TestRun.id.in_(db.query(PerfaraDemoSnapshot.test_run_id)),
                )
                .first()
            )
        else:
            allowed = (
                db.query(TestRun.project_id)
                .filter(
                    TestRun.project_id == project_id,
                )
                .filter(_match_uid_to_testrun_sql(uid))
                .first()
            )
        if not allowed:
            raise HTTPException(status_code=404, detail="Project not found")
    q = (
        db.query(ParsedInfo)
        .filter(ParsedInfo.project_id == project_id)
        .join(TestRun, ParsedInfo.test_run_id == TestRun.id)
    )
    if not is_super_uid(uid):
        if is_demo_perfara_uid(uid):
            q = q.filter(TestRun.id.in_(db.query(PerfaraDemoSnapshot.test_run_id)))
        else:
            q = q.filter(_match_uid_to_testrun_sql(uid))
    rows = q.order_by(ParsedInfo.created_at.desc(), ParsedInfo.id.desc()).limit(min(limit, 500)).all()
    return [ParsedInfoOut.from_row(r) for r in rows]


# Frontend static + SPA fallback (so /tests?testid=... works when pasted).
# 打包后前端产物位于只读资源目录，源码运行时为项目根的 frontend/dist。
FRONTEND_DIST = str(resource("frontend", "dist"))
FRONTEND_INDEX = os.path.join(FRONTEND_DIST, "index.html")
PERFARA_AD_DIR = str(resource("perfara-ad"))

try:
    if os.path.isdir(PERFARA_AD_DIR):
        app.mount("/ads", StaticFiles(directory=PERFARA_AD_DIR, html=True), name="perfara_ad")
except Exception as _mount_err:
    logging.getLogger(__name__).exception("Mount perfara-ad /ads failed: %s", _mount_err)

# Windows 注册表可能把 .js 映射为 text/plain（部分机器 HKCU\SOFTWARE\Classes\.js 被改写），
# 导致浏览器拒绝执行 <script type="module">，SPA 白屏。挂载前显式修正关键 MIME。
try:
    import mimetypes as _mimetypes
    _mimetypes.add_type("text/javascript", ".js")
    _mimetypes.add_type("text/javascript", ".mjs")
    _mimetypes.add_type("application/wasm", ".wasm")
    _mimetypes.add_type("image/svg+xml", ".svg")
except Exception as _mime_err:
    logging.getLogger(__name__).exception("Fix MIME types failed: %s", _mime_err)

try:
    if os.path.exists(os.path.join(FRONTEND_DIST, "assets")):
        app.mount("/assets", StaticFiles(directory=os.path.join(FRONTEND_DIST, "assets")), name="assets")
except Exception as _mount_err:
    logging.getLogger(__name__).exception("Mount assets failed: %s", _mount_err)


@app.get("/{full_path:path}", include_in_schema=False)
def spa_fallback(full_path: str):
    # Never hijack API routes or /ads (served by StaticFiles mount)
    if full_path.startswith("api"):
        raise HTTPException(status_code=404, detail="Not Found")
    if full_path == "ads" or full_path.startswith("ads/"):
        raise HTTPException(status_code=404, detail="Not Found")
    # Serve real file if exists (e.g. favicon.ico)
    try:
        cand = os.path.abspath(os.path.join(FRONTEND_DIST, full_path))
        if cand.startswith(FRONTEND_DIST) and os.path.isfile(cand):
            return FileResponse(cand)
    except Exception:
        pass
    # SPA fallback to index.html
    if os.path.exists(FRONTEND_INDEX):
        return FileResponse(FRONTEND_INDEX)
    raise HTTPException(status_code=404, detail="Not Found")
