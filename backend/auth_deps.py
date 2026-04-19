from __future__ import annotations

from typing import Optional

from fastapi import HTTPException, Request

# 万能查看（仅此 UID，大小写不敏感）：可列出/查看/管理任意用户的数据；上传仍以请求中的 uid 为 owner。
_SUPER_UID_CANONICAL = "wonderxu"


def is_super_uid(uid: Optional[str]) -> bool:
    return bool(uid and str(uid).strip().lower() == _SUPER_UID_CANONICAL)


# 演示账号（非万能、非全库）：仅可读 perfara_demo_snapshot 中登记的 test_run；禁止上传/改删；快照表不随业务自动追加新行。
_DEMO_PERFARA_CANONICAL = "perfara123"


def is_demo_perfara_uid(uid: Optional[str]) -> bool:
    return bool(uid and str(uid).strip().lower() == _DEMO_PERFARA_CANONICAL)


def resolve_uid(request: Request) -> Optional[str]:
    """解析 UID：查询参数 `uid` → 请求头 `X-WebPerf-Uid` / `X-Uid`（无 Session / 无登录接口）。"""
    uq = (request.query_params.get("uid") or "").strip()
    if uq:
        return uq
    uid = request.headers.get("X-WebPerf-Uid") or request.headers.get("X-Uid")
    if uid:
        u = uid.strip()
        if u:
            return u
    return None


def require_uid(request: Request) -> str:
    uid = resolve_uid(request)
    if uid:
        return uid
    raise HTTPException(
        status_code=400,
        detail="uid is required (query param ?uid=... or header X-WebPerf-Uid)",
    )
