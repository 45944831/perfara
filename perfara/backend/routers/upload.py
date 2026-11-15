"""上传路由：无鉴权，含跨站写入 / 体积上限 / content-type 防护。"""
from fastapi import APIRouter
from ._common import (
    HTTPException, Depends, Request, Optional, json, logging,
    Session, IntegrityError,
    get_db, TestRun, ParsedInfo, TestRunOut, new_share_token,
    is_demo_perfara_uid,
    sanitize_non_finite, canonical_content_hash, ensure_project_for_payload,
    parse_uploaded_json,
    MAX_UPLOAD_BYTES, MAX_UID_LEN,
    _guard_upload_request, _read_body_limited, _payload_too_large,
    _first_nonempty_str, _match_uid_to_testrun_sql,
)

router = APIRouter()


@router.post("/api/upload", response_model=TestRunOut)
async def upload_json(
    request: Request,
    db: Session = Depends(get_db),
):
    """无需鉴权。multipart：须含 file、uid；para2 可选；para1 仅备用存储。JSON body：查询参数 uid；para1/para2 同上。"""
    declared = request.headers.get("content-length")
    if declared:
        try:
            if int(declared) > MAX_UPLOAD_BYTES:
                raise _payload_too_large()
        except ValueError:
            pass
    content_type = request.headers.get("content-type") or ""
    _guard_upload_request(request, content_type)
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
            if len(raw) > MAX_UPLOAD_BYTES:
                raise _payload_too_large()
            text = raw.decode("utf-8")
            payload = json.loads(text)
        except HTTPException:
            raise
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
            body = await _read_body_limited(request)
            text = body.decode("utf-8")
            payload = json.loads(text)
        except HTTPException:
            raise
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
    if len(p_uid) > MAX_UID_LEN:
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_params", "message": f"uid too long (max {MAX_UID_LEN} chars)"},
        )

    if is_demo_perfara_uid(p_uid):
        raise HTTPException(
            status_code=403,
            detail={
                "code": "demo_readonly",
                "message": "演示账号 perfara123 不可上传，请使用自有 UID",
            },
        )

    payload = sanitize_non_finite(payload)
    # 校验 + 规范化只做一次：查重与落库必须使用同一份 content_hash。
    content_hash = canonical_content_hash(payload)
    project = ensure_project_for_payload(db, payload)
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
            db, project, payload, owner_uid=p_uid, para1=p_para1, para2=p2,
            content_hash=content_hash,
        )
    except HTTPException:
        raise
    except Exception as e:
        # /api/upload 无鉴权，响应体会落到任意调用方手里：只回字段级结论，
        # 异常类型与信息进日志（此前会把 "AttributeError: 'int' object has no attribute 'get'"
        # 这类内部细节原样返回）。
        logging.getLogger("api").warning("upload parse failed: %s: %s", type(e).__name__, e)
        raise HTTPException(
            status_code=400,
            detail={"code": "parse_error", "message": "payload 结构不符合约定，请检查 device / perf 字段"},
        )
    db.add(test_run)
    for m in metrics:
        db.add(m)
    if not getattr(test_run, "share_md5", None):
        test_run.share_md5 = new_share_token()
    try:
        db.commit()
    except IntegrityError:
        # 并发下另一请求已插入同一 (project, owner, hash, para2)，回滚后返回既有记录。
        db.rollback()
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
            return TestRunOut.from_model(existing)
        raise HTTPException(
            status_code=409,
            detail={"code": "duplicate", "message": "同一份数据已存在"},
        )
    except Exception as e:
        db.rollback()
        logging.getLogger("api").exception("db commit failed: %s", e)
        # 异常里带着 INSERT 语句、列序与绑定值（含他人 owner_uid），只进日志。
        raise HTTPException(
            status_code=500,
            detail={"code": "db_error", "message": "服务写入失败，请稍后重试"},
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
