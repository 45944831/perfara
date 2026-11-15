"""测试记录路由：列表 / 维度 / 趋势 / 详情 / 公开分享 / 改名 / 删除。

路由定义顺序与原单体一致，尤其 /api/tests/distinct-* 与 /api/tests/trend
必须先于 /api/tests/{test_id} 注册，否则会被参数路由吞掉。
"""
from fastapi import APIRouter
from ._common import (
    HTTPException, Depends, Query, Path, Optional, List, Response,
    json, logging, datetime, timedelta,
    Session, joinedload, load_only, delete, func,
    get_db, TestRun, MetricBlob, Project, ParsedInfo, PerfaraDemoSnapshot,
    TestRunOut, TestRunDetailOut, PagedTestRuns,
    TrendSeriesOut, TrendPointOut, TestLabelPatch,
    require_uid, resolve_uid, is_super_uid, is_demo_perfara_uid,
    peaks_from_blob_content, parse_summary_dict,
    _MAX_SQLITE_INT, _filter_test_runs_by_uid, _uid_owns_test_row,
    _parse_query_date_day, _effective_project_display_name,
    _project_effective_display_eq_col, _resolve_trend_project_name,
)

router = APIRouter()


@router.get("/api/tests", response_model=PagedTestRuns)
def list_tests(
    project_id: Optional[int] = Query(None, le=_MAX_SQLITE_INT),
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    page: int = Query(1, ge=1, le=1_000_000),
    # 校验上限留宽（le=1000），实际生效值在函数内 clamp 到 200：
    # 直接 le=200 会让老前端传 500 时拿到 422 而不是被夹住，属于无谓的行为破坏。
    page_size: int = Query(50, ge=1, le=1000),
    db: Session = Depends(get_db),
    uid: str = Depends(require_uid),
):
    query = _filter_test_runs_by_uid(db.query(TestRun), db, uid)
    if project_id is not None:
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
    page_size = max(1, min(page_size, 200))
    offset = (page - 1) * page_size
    items = (
        query.options(
            joinedload(TestRun.project),
            # 列表只渲染 summary（紧凑指标），raw_json 是完整上传载荷（单条可达数十 KB），
            # 读了即丢。按需列裁剪，避免每页白读 50 份 raw_json。
            load_only(
                TestRun.id,
                TestRun.project_id,
                TestRun.category,
                TestRun.started_at,
                TestRun.ended_at,
                TestRun.device,
                TestRun.label,
                TestRun.owner_uid,
                TestRun.para1,
                TestRun.para2,
                TestRun.summary,
                TestRun.share_md5,
            ),
        )
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


@router.get("/api/tests/distinct-labels", response_model=List[str])
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


@router.get("/api/tests/distinct-app-names", response_model=List[str])
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


@router.get("/api/tests/distinct-labels-for-app", response_model=List[str])
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


@router.get("/api/tests/trend", response_model=TrendSeriesOut)
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
    limit: int = Query(100, ge=1, le=5000),
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
    # 实际生效点数上限 300（校验放宽到 5000，避免老前端传 500 时 422）
    limit = max(1, min(limit, 300))
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


@router.get("/api/tests/{test_id}", response_model=TestRunDetailOut)
def get_test_detail(
    test_id: int = Path(..., le=_MAX_SQLITE_INT),
    db: Session = Depends(get_db),
    testid: Optional[str] = Query(None),
    uid: Optional[str] = Depends(resolve_uid),
):
    test = db.query(TestRun).filter(TestRun.id == test_id).first()
    if not test:
        raise HTTPException(status_code=404, detail="Test not found")

    expected_token = getattr(test, "share_md5", None)
    token_ok = bool(testid) and bool(expected_token) and str(testid) == expected_token

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


@router.get("/api/public/test", response_model=TestRunDetailOut)
def get_test_detail_public(
    testid: str,
    db: Session = Depends(get_db),
):
    """Public read-only access by share token (random). No auth."""
    token = (testid or "").strip()
    if not token:
        raise HTTPException(status_code=404, detail="Test not found")
    test = db.query(TestRun).filter(TestRun.share_md5 == token).first()
    if not test:
        raise HTTPException(status_code=404, detail="Test not found")
    blobs = (
        db.query(MetricBlob)
        .filter(MetricBlob.test_run_id == test.id)
        .order_by(MetricBlob.id.asc())
        .all()
    )
    out = TestRunDetailOut.from_orm_and_blobs(test, blobs)
    # 公开链接不该带出身份信息；历史字段一律置空（test_raw 是分享报告所需的数据本体）。
    out.test.owner_uid = None
    out.test.para1 = None
    out.test.para2 = None
    return out


@router.patch("/api/tests/{test_id}/label", response_model=TestRunOut)
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


@router.delete("/api/tests/{test_id}", status_code=204)
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
