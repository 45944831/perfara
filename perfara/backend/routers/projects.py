"""项目列表与派生信息路由。

导出两个 APIRouter 是为了让 ``app.py`` 的 include 顺序与原单体逐字一致：
``list_projects`` 原注册在 /api/tests 之前，而 ``with-info`` / ``infos``
原注册在 admin/reparse 之后。合并成一个 router 会改变注册顺序。
"""
from fastapi import APIRouter
from ._common import (
    HTTPException, Depends, Query, Path, Optional, List, logging, Session,
    get_db, Project, TestRun, ParsedInfo, PerfaraDemoSnapshot,
    ProjectOut, ProjectWithInfoOut, ParsedInfoOut,
    require_uid, is_super_uid, is_demo_perfara_uid,
    _MAX_SQLITE_INT, _demo_snapshot_id_list, _match_uid_to_testrun_sql,
)

router = APIRouter()       # 对应原 /api/projects（第 3 个注册的 API 路由）
router_info = APIRouter()  # 对应原 with-info / infos（倒数两个 API 路由）


@router.get("/api/projects", response_model=List[ProjectOut])
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
        # q 里的 % / _ 是 LIKE 通配符，不转义的话 q="%" 会命中全部项目。
        escaped = str(q).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        like = f"%{escaped}%"
        query = query.filter(
            (Project.display_name.ilike(like, escape="\\"))
            | (Project.package_name.ilike(like, escape="\\"))
            | (Project.app_name.ilike(like, escape="\\"))
        )
    projects = query.order_by(Project.updated_at.desc()).all()
    items = [ProjectOut.from_model(p) for p in projects]
    logging.getLogger("api").info("list_projects count=%s", len(items))
    return items


@router_info.get("/api/projects/with-info", response_model=List[ProjectWithInfoOut])
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
    # for each project, find latest parsed_info（同样按 uid 过滤，避免拿到他人的最新记录）
    out = []
    for p in projects:
        latest_q = (
            db.query(ParsedInfo)
            .join(TestRun, ParsedInfo.test_run_id == TestRun.id)
            .filter(ParsedInfo.project_id == p.id)
        )
        if not is_super_uid(uid):
            if is_demo_perfara_uid(uid):
                latest_q = latest_q.filter(
                    TestRun.id.in_(db.query(PerfaraDemoSnapshot.test_run_id))
                )
            else:
                latest_q = latest_q.filter(_match_uid_to_testrun_sql(uid))
        latest = latest_q.order_by(
            ParsedInfo.created_at.desc(), ParsedInfo.id.desc()
        ).first()
        out.append(
            ProjectWithInfoOut(
                project=ProjectOut.from_model(p),
                latest_info=ParsedInfoOut.from_row(latest) if latest else None,
            )
        )
    return out


@router_info.get("/api/projects/{project_id}/infos", response_model=List[ParsedInfoOut])
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
