"""管理端路由：重解析已存 raw_json，回填 category/summary/blobs。"""
from fastapi import APIRouter
from ._common import (
    HTTPException, Depends, Query, Optional, json, logging,
    Session, sa_delete,
    get_db, TestRun, MetricBlob, ParsedInfo,
    require_uid, is_super_uid, is_demo_perfara_uid,
    parse_uploaded_json,
    _MAX_SQLITE_INT, _match_uid_to_testrun_sql,
)

router = APIRouter()


class _Skip(Exception):
    """reparse 中跳过某一条（非错误，如 raw_json 为空 / 无 owner_uid）。"""


@router.post("/api/admin/reparse")
def admin_reparse(
    test_id: Optional[int] = Query(None, le=_MAX_SQLITE_INT),
    limit: int = Query(1000, ge=1, le=100000),
    db: Session = Depends(get_db),
    uid: str = Depends(require_uid),
):
    if is_demo_perfara_uid(uid):
        raise HTTPException(status_code=403, detail="演示账号不可使用管理重解析")
    targets = []
    if test_id is not None:
        # 用 `is not None`：`if test_id:` 会把 0 当成「未传」，
        # 于是 reparse?test_id=0 悄悄变成一次全量重解析。
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
        targets = q.order_by(TestRun.id.asc()).limit(min(limit, 1000)).all()
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
