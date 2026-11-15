"""健康检查路由。"""
import logging
from fastapi import APIRouter
from ._common import __version__

router = APIRouter()


@router.get("/api/health")
def health():
    logging.getLogger("api").info("health check")
    return {"status": "ok", "version": __version__}
